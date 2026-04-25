import { Bot, Context, InlineKeyboard, session, SessionFlavor } from "grammy";
import * as dotenv from "dotenv";
import { DBManager } from "./db";
import { CryptoManager } from "./crypto";
import { PolyMarketAPI } from "./polymarket";
import { privateKeyToAccount } from "viem/accounts";
import { acquireProcessLock } from "./singleton";

dotenv.config();

function getDefaultPolymarketAccountConfig() {
  const rawFunder = (process.env.POLY_FUNDER_ADDRESS || "").trim();
  const rawSignatureType = (process.env.POLY_SIGNATURE_TYPE || "").trim();
  const signatureType = rawSignatureType === "" ? null : Number.parseInt(rawSignatureType, 10);
  const funderAddress = rawFunder && !rawFunder.includes("your_polymarket") ? rawFunder : null;

  return {
    funderAddress,
    signatureType: Number.isInteger(signatureType) ? signatureType : null,
  };
}

function resolveUserPolymarketAccountConfig(user: any) {
  const defaults = getDefaultPolymarketAccountConfig();
  return {
    funderAddress: user?.funder_address || defaults.funderAddress,
    signatureType: Number.isInteger(user?.signature_type) ? user.signature_type : defaults.signatureType,
  };
}

function extractAllowance(balanceData: any): number {
  const directAllowance = parseFloat(balanceData?.allowance ?? "");
  if (!Number.isNaN(directAllowance)) {
    return directAllowance;
  }

  const standardEx = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
  const legacyAllowance = parseFloat(balanceData?.allowances?.[standardEx] ?? "");
  return Number.isNaN(legacyAllowance) ? 0 : legacyAllowance;
}

interface SessionData {
  step: string;
  pending_private_key?: string;
  pending_funder_address?: string;
}

type MyContext = Context & SessionFlavor<SessionData>;

const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
if (!botToken) {
  console.error("CRITICAL ERROR: TELEGRAM_BOT_TOKEN is missing in .env");
}

const bot = new Bot<MyContext>(botToken);
const db = new DBManager();
const crypto = new CryptoManager();
const DASHBOARD_POSITIONS_LIMIT = 6;
const DASHBOARD_ORDERS_LIMIT = 6;
const CLAIMABLE_BUTTON_LIMIT = 5;

function truncateMiddle(value: string, start = 8, end = 6): string {
  if (!value || value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function formatPositionSummary(position: any): string {
  const asset = position.displayLabel || position.title || position.asset || "Unknown asset";
  const size = position.size ?? position.balance ?? "?";
  const avgPrice = position.avgPrice ?? position.averagePrice ?? "?";
  return `• ${asset}: ${size} @ ${avgPrice}`;
}

function formatOrderSummary(order: any): string {
  const label = order.outcome || order.asset_id || order.market || "Order";
  const size = order.original_size || order.size || "?";
  const price = order.price ?? "?";
  const status = order.status || "open";
  return `• ${label}: ${order.side} ${size} @ ${price} (${status})`;
}

function buildPositionsKeyboard(autoClaim: boolean, hasClaimables: boolean) {
  const keyboard = new InlineKeyboard()
    .text("🏠 Home", "positions:main")
    .text("🔄 Refresh", "positions:refresh")
    .row()
    .text("📋 Claimable", "positions:claimable")
    .text("🛠 Setup", "positions:setup")
    .row()
    .text("💰 Balance", "positions:balance")
    .text("📊 Status", "positions:status")
    .row()
    .text("📈 Stats", "positions:stats")
    .text("🗓 Daily", "positions:daily")
    .row()
    .text("⚙️ Controls", "positions:controls")
    .text("❓ Help", "positions:help");

  keyboard.row();

  keyboard
    .text("💸 Claim All", hasClaimables ? "positions:claim_all" : "positions:claimable")
    .text(autoClaim ? "🛑 Auto-Claim Off" : "✅ Auto-Claim On", autoClaim ? "positions:auto_claim_off" : "positions:auto_claim_on");

  return keyboard;
}

function buildOnboardingKeyboard() {
  return new InlineKeyboard()
    .text("🔐 Import Wallet", "positions:import_start")
    .text("🛠 Setup", "positions:setup")
    .row()
    .text("❓ Help", "positions:help")
    .text("🏠 Home", "positions:main")
    .row();
}

function buildSetupMessage(user?: any) {
  if (!user) {
    return [
      "*Setup Center*",
      "",
      "Import your wallet first to unlock approvals, wallet checks, funding, and risk controls.",
      "",
      "*Available After Import*",
      "Approve trading allowance",
      "Check signer, funder, and proxy linkage",
      "Move USDC.e into the trading wallet",
      "Tune risk, max size, and max open positions",
    ].join("\n");
  }

  const accountConfig = resolveUserPolymarketAccountConfig(user);
  return [
    "*Setup Center*",
    "",
    "*Wallet*",
    `Funder: \`${accountConfig.funderAddress || "wallet address"}\``,
    `Signature Type: ${accountConfig.signatureType ?? "default(EOA)"}`,
    "",
    "*Ready Actions*",
    "Import: replace wallet credentials",
    "Approve: refresh Polymarket trading allowance",
    "Wallet Check: verify signer and proxy linkage",
    "Fund Wallet: move USDC.e into the trading wallet",
    "Risk Settings: update trade limits and exposure",
  ].join("\n");
}

function buildControlsMessage(user: any) {
  return [
    "*Controls Center*",
    "",
    "*Trading*",
    `Status: ${user.trading_active ? "Active" : "Stopped"}`,
    `Auto-Claim: ${user.auto_claim ? "ON" : "OFF"}`,
    "",
    "*Exposure*",
    `Risk: ${user.risk_percent}%`,
    `Max Trade: $${user.max_trade_amount}`,
    `Max Open: ${user.max_open_positions}`,
    "",
    "Use the buttons below to start or stop trading, toggle auto-claim, or open risk settings.",
  ].join("\n");
}

function buildRiskSettingsMessage(user: any) {
  return [
    "*Risk Settings*",
    "",
    `Risk Per Trade: ${user.risk_percent}%`,
    `Max Trade Amount: $${user.max_trade_amount}`,
    `Max Open Positions: ${user.max_open_positions}`,
    "",
    "Choose a setting below and then send the new value in chat.",
  ].join("\n");
}

async function buildWalletCheckMessage(user: any) {
  const accountConfig = resolveUserPolymarketAccountConfig(user);
  const poly = new PolyMarketAPI({
    key: user.api_key,
    secret: user.api_secret,
    passphrase: user.api_passphrase
  }, user.private_key, accountConfig);

  const signerAddress = poly.getSignerAddress();
  const funderAddress = poly.getConfiguredFunderAddress();
  const profile = await poly.getPublicProfileByWallet(funderAddress);
  const proxyWallet = profile?.proxyWallet || null;

  return [
    "*Wallet Check*",
    "",
    `Signer: \`${signerAddress}\``,
    `Configured Funder: \`${funderAddress}\``,
    `Profile Proxy Wallet: \`${proxyWallet || "not found"}\``,
    `Signature Type: ${accountConfig.signatureType ?? "default(EOA)"}`,
    "",
    proxyWallet && proxyWallet.toLowerCase() === funderAddress.toLowerCase()
      ? "_Funder matches Polymarket profile proxy wallet._"
      : "_Funder does not match the Polymarket profile proxy wallet, or no profile was found._",
  ].join("\n");
}

function buildWelcomeDashboard() {
  return [
    "*Blocky Home*",
    "",
    "This is your control dashboard for setup, positions, claims, balances, and reports.",
    "",
    "*First Step*",
    "Import a wallet to unlock trading actions.",
    "",
    "Then use Setup Center to approve, verify wallets, fund the trading wallet, and tune risk.",
  ].join("\n");
}

function buildDetailKeyboard(autoClaim: boolean, hasClaimables: boolean, page: string) {
  const keyboard = new InlineKeyboard()
    .text("🏠 Home", "positions:main")
    .text("⬅️ Dashboard", "positions:refresh")
    .text("🔄 Refresh", `positions:${page}`)
    .row()
    .text("📋 Claimable", "positions:claimable")
    .text("🛠 Setup", "positions:setup")
    .row()
    .text("💰 Balance", "positions:balance")
    .text("📊 Status", "positions:status")
    .row()
    .text("📈 Stats", "positions:stats")
    .text("🗓 Daily", "positions:daily")
    .row()
    .text("⚙️ Controls", "positions:controls")
    .text("❓ Help", "positions:help")
    .row();

  keyboard.text("💸 Claim All", hasClaimables ? "positions:claim_all" : "positions:claimable");
  keyboard.text(
    autoClaim ? "🛑 Auto-Claim Off" : "✅ Auto-Claim On",
    autoClaim ? "positions:auto_claim_off" : "positions:auto_claim_on"
  );

  return keyboard;
}

function buildSetupKeyboard(hasUser: boolean) {
  const keyboard = new InlineKeyboard()
    .text("🏠 Home", "positions:main")
    .text("🔄 Refresh", "positions:setup")
    .row()
    .text("🔐 Import Wallet", "positions:import_start")
    .text("✅ Approve", hasUser ? "positions:approve" : "positions:import_start")
    .row()
    .text("🔎 Wallet Check", hasUser ? "positions:wallet_check" : "positions:import_start")
    .text("💸 Fund Wallet", hasUser ? "positions:fund_prompt" : "positions:import_start")
    .row()
    .text("🎯 Risk Settings", hasUser ? "positions:risk_settings" : "positions:import_start")
    .text("⚙️ Controls", hasUser ? "positions:controls" : "positions:help")
    .row()
    .text("❓ Help", "positions:help");

  return keyboard;
}

function buildRiskKeyboard() {
  return new InlineKeyboard()
    .text("⬅️ Setup", "positions:setup")
    .text("🔄 Refresh", "positions:risk_settings")
    .row()
    .text("🎯 Set Risk %", "positions:risk_prompt")
    .text("💵 Set Max $", "positions:max_prompt")
    .row()
    .text("📦 Set Max Open", "positions:max_open_prompt")
    .text("⚙️ Controls", "positions:controls");
}

function buildControlsKeyboard(user: any) {
  return new InlineKeyboard()
    .text("🏠 Home", "positions:main")
    .text("🔄 Refresh", "positions:controls")
    .row()
    .text(user?.trading_active ? "⏸ Stop Trading" : "▶️ Start Trading", user?.trading_active ? "positions:stop_trading" : "positions:start_trading")
    .text(user?.auto_claim ? "🛑 Auto-Claim Off" : "✅ Auto-Claim On", user?.auto_claim ? "positions:auto_claim_off" : "positions:auto_claim_on")
    .row()
    .text("🎯 Risk Settings", "positions:risk_settings")
    .text("🛠 Setup", "positions:setup")
    .row()
    .text("📊 Status", "positions:status")
    .text("❓ Help", "positions:help");
}

function buildClaimableKeyboard(claimableTrades: any[], autoClaim: boolean) {
  const keyboard = new InlineKeyboard();
  claimableTrades.slice(0, CLAIMABLE_BUTTON_LIMIT).forEach((trade, index) => {
    const marketId = String(trade.market_id || "");
    const tradeId = String(trade.id || "");
    const label = `${index + 1}. ${trade.side === "NO" ? "🔴" : "🟢"} ${truncateMiddle(marketId, 8, 4)}`;
    keyboard.text(label, `positions:claim:${tradeId}`).row();
  });

  if (claimableTrades.length > 0) {
    keyboard.text("💸 Claim All", "positions:claim_all").row();
  }

  keyboard
    .text(autoClaim ? "🛑 Auto-Claim Off" : "✅ Auto-Claim On", autoClaim ? "positions:auto_claim_off" : "positions:auto_claim_on")
    .row()
    .text("⬅️ Back", "positions:refresh")
    .text("🔄 Refresh", "positions:claimable");

  return keyboard;
}

async function buildBalanceMessage(user: any) {
  const accountConfig = resolveUserPolymarketAccountConfig(user);
  const poly = new PolyMarketAPI({
    key: user.api_key,
    secret: user.api_secret,
    passphrase: user.api_passphrase
  }, user.private_key, accountConfig);
  const balanceData: any = await poly.getBalance();

  if (!balanceData || balanceData.balance === undefined) {
    throw new Error("Invalid balance data received from Polymarket.");
  }

  const balanceNum = parseFloat(balanceData.balance);
  const allowanceNum = extractAllowance(balanceData);
  const signerAddress = poly.getSignerAddress();
  const funderAddress = poly.getConfiguredFunderAddress();
  const signerWalletUsdc = await poly.getWalletUsdcBalance(signerAddress);
  const funderWalletUsdc = signerAddress.toLowerCase() === funderAddress.toLowerCase()
    ? signerWalletUsdc
    : await poly.getWalletUsdcBalance(funderAddress);

  const formattedBalance = isNaN(balanceNum) ? "0.00" : (balanceNum / 1000000).toFixed(2);
  const formattedAllowance = isNaN(allowanceNum) ? "0.00" : (allowanceNum / 1000000).toFixed(2);
  const signerWalletUsdcText = (Number(signerWalletUsdc) / 1_000_000).toFixed(2);
  const funderWalletUsdcText = (Number(funderWalletUsdc) / 1_000_000).toFixed(2);

  return [
    "*USDC Status*",
    "",
    `Trading Balance: ${formattedBalance} USDC`,
    `Trading Allowance: ${formattedAllowance} USDC`,
    `Signature Type: ${accountConfig.signatureType ?? "default(EOA)"}`,
    `Signer: \`${signerAddress}\``,
    `Signer Wallet USDC.e: ${signerWalletUsdcText} USDC`,
    `Funder: \`${funderAddress}\``,
    `Funder Wallet USDC.e: ${funderWalletUsdcText} USDC`,
    "",
    "_Note: If balance is wrong, ensure you have USDC.e (Bridged USDC)._",
  ].join("\n");
}

function buildStatusMessage(user: any) {
  return [
    "*Bot Status*",
    "",
    "*Controls*",
    `Trading: ${user.trading_active ? "Active" : "Stopped"}`,
    `Auto-Claim: ${user.auto_claim ? "ON" : "OFF"}`,
    "",
    "*Risk Profile*",
    `Risk: ${user.risk_percent}%`,
    `Max Trade: $${user.max_trade_amount}`,
    `Max Open Positions: ${user.max_open_positions}`,
    "",
    "*Account*",
    `Signature Type: ${resolveUserPolymarketAccountConfig(user).signatureType ?? "default(EOA)"}`,
    `Funder: \`${resolveUserPolymarketAccountConfig(user).funderAddress || "wallet address"}\``,
  ].join("\n");
}

function buildStatsMessage(overall: any) {
  return [
    "*Overall Performance*",
    `Total Trades: ${overall.total}`,
    `Settled: ${overall.settled}`,
    `Win Rate: ${overall.winRate}%`,
    `Total PnL: *${overall.pnl.toFixed(2)} USDC*`,
  ].join("\n");
}

function buildDailyMessage(daily: any, overall: any) {
  const today = new Date().toISOString().split("T")[0];
  const dailyWinRate = daily.settled > 0 ? ((daily.wins / daily.settled) * 100).toFixed(1) : "N/A";

  return [
    `*Daily Report - ${today}*`,
    "",
    "*Today:*",
    `Trades: ${daily.total}`,
    `Settled: ${daily.settled}`,
    `Wins: ${daily.wins} (${dailyWinRate}%)`,
    `PnL: *${daily.pnl.toFixed(2)} USDC*`,
    "",
    "*All Time:*",
    `Total Trades: ${overall.total}`,
    `Win Rate: ${overall.winRate}%`,
    `Cumulative PnL: *${overall.pnl.toFixed(2)} USDC*`,
  ].join("\n");
}

async function buildPositionsDashboard(userId: string, user: any) {
  const accountConfig = resolveUserPolymarketAccountConfig(user);
  const poly = new PolyMarketAPI({
    key: user.api_key,
    secret: user.api_secret,
    passphrase: user.api_passphrase
  }, user.private_key, accountConfig);

  const positionsAddress = accountConfig.funderAddress
    || privateKeyToAccount(user.private_key.startsWith("0x") ? user.private_key : `0x${user.private_key}`).address;

  const [positions, openOrders] = await Promise.all([
    poly.getPositions(positionsAddress),
    poly.getOpenOrders(),
  ]);
  const visiblePositions = (positions || []).filter((position: any) => {
    const size = Number(position.size ?? position.balance ?? 0);
    const currentValue = Number(position.currentValue ?? 0);
    const curPrice = Number(position.curPrice ?? 0);
    const redeemable = Boolean(position.redeemable);
    return size > 0 && (currentValue > 0 || curPrice > 0 || redeemable);
  });
  const enrichedPositions = await Promise.all(visiblePositions.map(async (position: any) => {
    const title = String(position.title || "").trim();
    const outcome = String(position.outcome || "").trim().toUpperCase();
    const displayLabel = title
      ? `${title}${outcome ? ` [${outcome}]` : ""}`
      : await poly.getPositionLabel(String(position.asset || ""));

    return {
      ...position,
      displayLabel,
    };
  }));
  const claimableTrades = db.getClaimableTrades(userId);
  const preferredOpen = enrichedPositions.filter((position: any) => {
    const price = Number(position.avgPrice ?? position.averagePrice ?? 0);
    return Number.isFinite(price) && price >= 0.20 && price <= 0.70;
  }).length;

  const lines = [
    "*Position Center*",
    "",
    "*Overview*",
    `Open Positions: ${enrichedPositions.length || 0}`,
    `Working Orders: ${openOrders?.length || 0}`,
    `Claimable Markets: ${claimableTrades.length}`,
    `Auto-Claim: ${user.auto_claim ? "ON" : "OFF"}`,
    "",
    "*Focus*",
    `Preferred-Band Positions: ${preferredOpen}`,
    `Dashboard Wallet: \`${truncateMiddle(positionsAddress, 10, 6)}\``,
  ];

  if (enrichedPositions.length > 0) {
    lines.push("", "*Open Positions*");
    enrichedPositions.slice(0, DASHBOARD_POSITIONS_LIMIT).forEach((position: any) => {
      lines.push(formatPositionSummary(position));
    });
    if (enrichedPositions.length > DASHBOARD_POSITIONS_LIMIT) {
      lines.push(`_Showing ${DASHBOARD_POSITIONS_LIMIT} of ${enrichedPositions.length} positions._`);
    }
  }

  if (openOrders && openOrders.length > 0) {
    lines.push("", "*Working Orders*");
    openOrders.slice(0, DASHBOARD_ORDERS_LIMIT).forEach((order: any) => {
      lines.push(formatOrderSummary(order));
    });
    if (openOrders.length > DASHBOARD_ORDERS_LIMIT) {
      lines.push(`_Showing ${DASHBOARD_ORDERS_LIMIT} of ${openOrders.length} orders._`);
    }
  }

  if (enrichedPositions.length === 0 && (!openOrders || openOrders.length === 0)) {
    lines.push("", "*Activity*", "_No open positions or working orders right now._");
  }

  return {
    text: lines.join("\n"),
    keyboard: buildPositionsKeyboard(!!user.auto_claim, claimableTrades.length > 0),
  };
}

function withDashboardNotice(baseText: string, notice?: string) {
  if (!notice) return baseText;
  return [`*Dashboard Update*`, notice, "", baseText].join("\n");
}

async function renderDashboardPage(userId: string, user: any, page: string, notice?: string) {
  const claimableTrades = user ? db.getClaimableTrades(userId) : [];
  const autoClaim = !!user?.auto_claim;
  const hasClaimables = claimableTrades.length > 0;

  if (!user) {
    if (page === "help") {
      return {
        text: withDashboardNotice([
          "*Dashboard Help*",
          "",
          "Use /start to open this dashboard anytime.",
          "Use Setup Center to begin wallet import and onboarding.",
          "",
          "*Commands Still Useful*",
          "/import",
          "/approve",
          "/check_wallets",
          "/fund_funder <amt>",
          "/set_risk <%>",
          "/set_max <amt>",
          "/set_max_open <count>",
        ].join("\n"), notice),
        keyboard: buildOnboardingKeyboard(),
      };
    }

    return {
      text: withDashboardNotice(page === "setup" ? buildSetupMessage() : buildWelcomeDashboard(), notice),
      keyboard: buildOnboardingKeyboard(),
    };
  }

  if (page === "refresh" || page === "main") {
    const dashboard = await buildPositionsDashboard(userId, user);
    return {
      text: withDashboardNotice(dashboard.text, notice),
      keyboard: dashboard.keyboard,
    };
  }

  if (page === "setup") {
    return {
      text: withDashboardNotice(buildSetupMessage(user), notice),
      keyboard: buildSetupKeyboard(true),
    };
  }

  if (page === "claimable") {
    return {
      text: withDashboardNotice(buildClaimableMessage(claimableTrades), notice),
      keyboard: buildClaimableKeyboard(claimableTrades, autoClaim),
    };
  }

  if (page === "balance") {
    return {
      text: withDashboardNotice(await buildBalanceMessage(user), notice),
      keyboard: buildDetailKeyboard(autoClaim, hasClaimables, "balance"),
    };
  }

  if (page === "status") {
    return {
      text: withDashboardNotice(buildStatusMessage(user), notice),
      keyboard: buildDetailKeyboard(autoClaim, hasClaimables, "status"),
    };
  }

  if (page === "controls") {
    return {
      text: withDashboardNotice(buildControlsMessage(user), notice),
      keyboard: buildControlsKeyboard(user),
    };
  }

  if (page === "risk_settings") {
    return {
      text: withDashboardNotice(buildRiskSettingsMessage(user), notice),
      keyboard: buildRiskKeyboard(),
    };
  }

  if (page === "wallet_check") {
    return {
      text: withDashboardNotice(await buildWalletCheckMessage(user), notice),
      keyboard: buildSetupKeyboard(true),
    };
  }

  if (page === "stats") {
    const overall = db.getOverallStats(userId);
    return {
      text: withDashboardNotice(
        overall.total === 0 ? "*Overall Performance*\n\n_No trades recorded yet._" : buildStatsMessage(overall),
        notice
      ),
      keyboard: buildDetailKeyboard(autoClaim, hasClaimables, "stats"),
    };
  }

  if (page === "daily") {
    const daily = db.getDailyStats(userId);
    const overall = db.getOverallStats(userId);
    return {
      text: withDashboardNotice(buildDailyMessage(daily, overall), notice),
      keyboard: buildDetailKeyboard(autoClaim, hasClaimables, "daily"),
    };
  }

  if (page === "help") {
    return {
      text: withDashboardNotice([
        "*Dashboard Help*",
        "",
        "Use this dashboard as the main control center for positions, claims, balances, and reports.",
        "",
        "*Grouped Actions*",
        "Portfolio: Refresh, Balance, Status",
        "Claims: Claimable, Claim All, Auto-Claim toggle",
        "Reports: Stats, Daily",
        "",
        "*Use Commands For*",
        "Setup, approvals, funding, wallet checks, and risk-setting flows that need manual input.",
      ].join("\n"), notice),
      keyboard: buildDetailKeyboard(autoClaim, hasClaimables, "help"),
    };
  }

  return renderDashboardPage(userId, user, "main", notice);
}

async function safeEditDashboardMessage(ctx: any, text: string, keyboard: InlineKeyboard) {
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    return true;
  } catch (e: any) {
    const message = String(e?.message || "");
    if (message.includes("message is not modified")) {
      return false;
    }
    throw e;
  }
}

function buildClaimableMessage(claimableTrades: any[]) {
  if (claimableTrades.length === 0) {
    return "*Claim Center*\n\n_No settled winning trades are waiting to be claimed._";
  }

  const totalSize = claimableTrades.reduce((sum, trade) => sum + Number(trade.size || 0), 0);
  const lines = [
    "*Claim Center*",
    "",
    "*Overview*",
    `Claimable Markets: ${claimableTrades.length}`,
    `Claimable Size: ${totalSize.toFixed(2)}`,
    "",
    "*Ready To Claim*",
  ];
  claimableTrades.slice(0, CLAIMABLE_BUTTON_LIMIT).forEach((trade, index) => {
    lines.push(
      `${index + 1}. \`${trade.market_id}\``,
      `Side: ${trade.side}`,
      `Size: ${trade.size}`,
      `Entry: ${trade.buy_price.toFixed(4)}`,
      ""
    );
  });

  if (claimableTrades.length > CLAIMABLE_BUTTON_LIMIT) {
    lines.push(`_Showing ${CLAIMABLE_BUTTON_LIMIT} of ${claimableTrades.length} claimable markets._`);
  }

  return lines.join("\n").trim();
}

async function claimMarketForUser(userId: string, user: any, marketId: string) {
  const trades = db.getClaimableTradesForMarket(userId, marketId);
  if (trades.length === 0) {
    throw new Error("No settled winning trade is waiting to be claimed for that market.");
  }

  const trade = trades[0];
  if (!trade.condition_id) {
    throw new Error("This trade is missing a condition id, so the bot cannot redeem it automatically.");
  }

  const accountConfig = resolveUserPolymarketAccountConfig(user);
  const poly = new PolyMarketAPI({
    key: user.api_key,
    secret: user.api_secret,
    passphrase: user.api_passphrase
  }, user.private_key, accountConfig);

  const txHash = await poly.redeemWinnings(trade.condition_id);
  db.markClaimedByCondition(userId, trade.condition_id, txHash);
  return txHash;
}

async function claimTradeByIdForUser(userId: string, user: any, tradeId: number) {
  const claimableTrades = db.getClaimableTrades(userId);
  const trade = claimableTrades.find((item: any) => Number(item.id) === tradeId);
  if (!trade) {
    throw new Error("No settled winning trade is waiting to be claimed for that selection.");
  }
  if (!trade.condition_id) {
    throw new Error("This trade is missing a condition id, so the bot cannot redeem it automatically.");
  }

  const accountConfig = resolveUserPolymarketAccountConfig(user);
  const poly = new PolyMarketAPI({
    key: user.api_key,
    secret: user.api_secret,
    passphrase: user.api_passphrase
  }, user.private_key, accountConfig);

  const txHash = await poly.redeemWinnings(trade.condition_id);
  db.markClaimedByCondition(userId, trade.condition_id, txHash);
  return txHash;
}

async function claimAllForUser(userId: string, user: any) {
  const claimableTrades = db.getClaimableTrades(userId);
  if (claimableTrades.length === 0) {
    return "No settled winning trades are waiting to be claimed.";
  }

  const uniqueConditions = Array.from(
    new Map(
      claimableTrades
        .filter((trade) => !!trade.condition_id)
        .map((trade) => [trade.condition_id, trade])
    ).values()
  );

  if (uniqueConditions.length === 0) {
    return "Claimable trades were found, but none have a usable condition id.";
  }

  const poly = new PolyMarketAPI({
    key: user.api_key,
    secret: user.api_secret,
    passphrase: user.api_passphrase
  }, user.private_key, resolveUserPolymarketAccountConfig(user));

  const receipts: string[] = [];
  const failures: string[] = [];

  for (const trade of uniqueConditions) {
    try {
      const txHash = await poly.redeemWinnings(trade.condition_id);
      db.markClaimedByCondition(userId, trade.condition_id, txHash);
      receipts.push(`${trade.market_id}: https://polygonscan.com/tx/${txHash}`);
    } catch (e: any) {
      failures.push(`${trade.market_id}: ${e.message}`);
    }
  }

  const lines = [];
  if (receipts.length > 0) {
    lines.push(`Claims submitted: ${receipts.length}`);
    lines.push(...receipts);
  }
  if (failures.length > 0) {
    lines.push(`Failures: ${failures.length}`);
    lines.push(...failures);
  }

  return lines.join("\n");
}

bot.catch((err) => {
  console.error(`[BOT ERROR] update ${err.ctx.update.update_id}:`, err.error);
});

bot.use(session({ initial: () => ({ step: "" }) }));

bot.command("start", async (ctx) => {
  console.log(`[BOT] User ${ctx.from?.id} ran /start`);
  if (!ctx.from) return;
  const user: any = db.getUser(ctx.from.id.toString());
  const view = await renderDashboardPage(ctx.from.id.toString(), user, "main");
  ctx.reply(view.text, {
    parse_mode: "Markdown",
    reply_markup: view.keyboard,
  });
});

bot.command("help", (ctx) => {
  console.log(`[BOT] User ${ctx.from?.id} ran /help`);
  ctx.reply([
    "*Blocky Help*",
    "",
    "Use /start as the main dashboard for portfolio, claims, balances, reports, and setup.",
    "",
    "*Setup*",
    "/import",
    "/approve",
    "/check_wallets",
    "/fund_funder <amt>",
    "",
    "*Trading Controls*",
    "/start_trading",
    "/stop_trading",
    "/set_risk <%>",
    "/set_max <amt>",
    "/set_max_open <count>",
    "",
    "*Account*",
    "/remove_wallet",
  ].join("\n"), { parse_mode: "Markdown" });
});

bot.command("stats", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /stats`);
  const overall = db.getOverallStats(ctx.from.id.toString());

  if (overall.total === 0) return ctx.reply("No trades recorded yet.");

  ctx.reply(buildStatsMessage(overall), { parse_mode: "Markdown" });
});

bot.command("daily", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /daily`);
  const daily = db.getDailyStats(ctx.from.id.toString());
  const overall = db.getOverallStats(ctx.from.id.toString());

  ctx.reply(buildDailyMessage(daily, overall), { parse_mode: "Markdown" });
});

bot.command("import", async (ctx) => {
  console.log(`[BOT] User ${ctx.from?.id} ran /import`);
  ctx.reply(
    "Send your private key in this private chat.\n" +
    "Warning: use a dedicated hot wallet only. Your message will be deleted after processing."
  );
  ctx.session.step = "awaiting_pk";
  ctx.session.pending_private_key = "";
  ctx.session.pending_funder_address = "";
});

bot.command("status", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /status`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("User data not found. Use /import first.");

  ctx.reply(buildStatusMessage(user), { parse_mode: "Markdown" });
});

bot.command("balance", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /balance`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("Use /import first.");

  try {
    ctx.reply(await buildBalanceMessage(user), { parse_mode: "Markdown" });
  } catch (e: any) {
    console.error(`[BOT] Balance Error: ${e.message}`);
    ctx.reply(`Balance Error: ${e.message}`);
  }
});

bot.command("fund_funder", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /fund_funder ${ctx.match}`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("Use /import first.");

  const amount = parseFloat((ctx.match || "").trim());
  if (!Number.isFinite(amount) || amount <= 0) {
    return ctx.reply("Provide an amount in USDC.e. Example: /fund_funder 25");
  }

  try {
    const accountConfig = resolveUserPolymarketAccountConfig(user);
    const poly = new PolyMarketAPI({
      key: user.api_key,
      secret: user.api_secret,
      passphrase: user.api_passphrase
    }, user.private_key, accountConfig);

    const txHash = await poly.transferUsdcToFunder(amount);
    ctx.reply(
      `Signer-to-funder transfer submitted for ${amount.toFixed(2)} USDC.e.\n` +
      `Only use this if you intentionally want to move Polygon USDC.e into your Polymarket trading wallet.\n` +
      `https://polygonscan.com/tx/${txHash}`
    );
  } catch (e: any) {
    console.error(`[BOT] fund_funder Error: ${e.message}`);
    ctx.reply(`Funding transfer failed: ${e.message}`);
  }
});

bot.command("check_wallets", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /check_wallets`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("Use /import first.");

  try {
    const accountConfig = resolveUserPolymarketAccountConfig(user);
    const poly = new PolyMarketAPI({
      key: user.api_key,
      secret: user.api_secret,
      passphrase: user.api_passphrase
    }, user.private_key, accountConfig);

    const signerAddress = poly.getSignerAddress();
    const funderAddress = poly.getConfiguredFunderAddress();
    const profile = await poly.getPublicProfileByWallet(funderAddress);
    const proxyWallet = profile?.proxyWallet || null;

    ctx.reply(
      [
        "*Wallet Check*",
        "",
        `Signer: \`${signerAddress}\``,
        `Configured Funder: \`${funderAddress}\``,
        `Profile Proxy Wallet: \`${proxyWallet || "not found"}\``,
        `Signature Type: ${accountConfig.signatureType ?? "default(EOA)"}`,
        "",
        proxyWallet && proxyWallet.toLowerCase() === funderAddress.toLowerCase()
          ? "_Funder matches Polymarket profile proxy wallet._"
          : "_Funder does not match the Polymarket profile proxy wallet, or no profile was found._",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (e: any) {
    console.error(`[BOT] check_wallets Error: ${e.message}`);
    ctx.reply(`Wallet check failed: ${e.message}`);
  }
});

bot.command("approve", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /approve`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("Use /import first.");

  try {
    const accountConfig = resolveUserPolymarketAccountConfig(user);
    const poly = new PolyMarketAPI({
      key: user.api_key,
      secret: user.api_secret,
      passphrase: user.api_passphrase
    }, user.private_key, accountConfig);

    ctx.reply("Sending master approvals. This may take a few seconds.");
    const hashes = await poly.approveUSDC();
    const links = hashes.map((hash, index) => `Tx ${index + 1}: https://polygonscan.com/tx/${hash}`);
    ctx.reply(`Master approval successful.\n\n${links.join("\n")}\n\nYou can now check your status with /balance in a minute.`);
  } catch (e: any) {
    console.error(`[BOT] Approval Error: ${e.message}`);
    ctx.reply(`Approval failed: ${e.message}`);
  }
});

bot.command("positions", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /positions`);
  const user: any = db.getUser(ctx.from.id.toString());

  try {
    const view = await renderDashboardPage(ctx.from.id.toString(), user, "main");
    ctx.reply(view.text, {
      parse_mode: "Markdown",
      reply_markup: view.keyboard,
    });
  } catch (e: any) {
    console.error(`[BOT] Positions Error: ${e.message}`);
    ctx.reply(`Positions error: ${e.message}`);
  }
});

bot.command("claimable", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /claimable`);

  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("Use /import first.");

  const claimableTrades = db.getClaimableTrades(ctx.from.id.toString());
  if (claimableTrades.length === 0) {
    return ctx.reply("No settled winning trades are waiting to be claimed.");
  }

  ctx.reply(buildClaimableMessage(claimableTrades), {
    parse_mode: "Markdown",
    reply_markup: buildClaimableKeyboard(claimableTrades, !!user.auto_claim),
  });
});

bot.command("claim", async (ctx) => {
  if (!ctx.from) return;
  const marketId = (ctx.match || "").trim();
  console.log(`[BOT] User ${ctx.from.id} ran /claim ${marketId}`);

  if (!marketId) {
    return ctx.reply("Provide a market id from your settled trade. Example: /claim 12345");
  }

  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("Use /import first.");

  try {
    const txHash = await claimMarketForUser(ctx.from.id.toString(), user, marketId);
    ctx.reply(`Claim submitted: https://polygonscan.com/tx/${txHash}`);
  } catch (e: any) {
    console.error(`[BOT] Claim Error: ${e.message}`);
    ctx.reply(`Claim failed: ${e.message}`);
  }
});

bot.command("claim_all", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /claim_all`);

  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("Use /import first.");

  ctx.reply(await claimAllForUser(ctx.from.id.toString(), user));
});

bot.command("auto_claim_on", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /auto_claim_on`);
  db.updateAutoClaim(ctx.from.id.toString(), true);
  ctx.reply("Auto-claim enabled. Winning settled trades will be redeemed automatically when possible.");
});

bot.command("auto_claim_off", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /auto_claim_off`);
  db.updateAutoClaim(ctx.from.id.toString(), false);
  ctx.reply("Auto-claim disabled. Use /claimable, /claim, or /claim_all to redeem winners manually.");
});

bot.command("set_risk", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /set_risk ${ctx.match}`);
  const reqRisk = ctx.match || "";
  const risk = parseFloat(reqRisk);
  if (isNaN(risk) || risk <= 0 || risk > 100) {
    return ctx.reply("Please provide a percentage from 1-100. Example: /set_risk 5");
  }
  db.updateRisk(ctx.from.id.toString(), risk);
  ctx.reply(`Risk set to ${risk}% per trade.`);
});

bot.command("set_max", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /set_max ${ctx.match}`);
  const reqMax = ctx.match || "";
  const max = parseFloat(reqMax);
  if (isNaN(max) || max <= 0) {
    return ctx.reply("Please provide a valid amount. Example: /set_max 50");
  }
  db.updateMaxTrade(ctx.from.id.toString(), max);
  ctx.reply(`Max trade amount set to $${max}.`);
});

bot.command("set_max_open", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /set_max_open ${ctx.match}`);
  const reqMaxOpen = ctx.match || "";
  const maxOpen = parseInt(reqMaxOpen, 10);
  if (isNaN(maxOpen) || maxOpen <= 0) {
    return ctx.reply("Please provide a whole number greater than 0. Example: /set_max_open 10");
  }
  db.updateMaxOpenPositions(ctx.from.id.toString(), maxOpen);
  ctx.reply(`Maximum concurrent open positions set to ${maxOpen}.`);
});

bot.command("start_trading", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /start_trading`);
  db.updateTradingStatus(ctx.from.id.toString(), true);
  ctx.reply("Auto-trading enabled.");
});

bot.command("stop_trading", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /stop_trading`);
  db.updateTradingStatus(ctx.from.id.toString(), false);
  ctx.reply("Auto-trading disabled.");
});

bot.command("remove_wallet", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /remove_wallet`);
  db.removeUser(ctx.from.id.toString());
  ctx.reply("Your wallet and credentials have been deleted from the bot.");
});

bot.callbackQuery(/^positions:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const action = ctx.match[1];
  const userId = ctx.from.id.toString();
  const user: any = db.getUser(userId);

  try {
    if (["main", "refresh", "setup", "help"].includes(action)) {
      const view = await renderDashboardPage(userId, user, action);
      const changed = await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery({
        text: changed
          ? (action === "refresh" ? "Dashboard refreshed." : "Dashboard updated.")
          : "Already up to date.",
      });
      return;
    }

    if (action === "import_start") {
      ctx.session.step = "awaiting_pk";
      ctx.session.pending_private_key = "";
      ctx.session.pending_funder_address = "";
      const view = await renderDashboardPage(userId, user, "setup", "Wallet import started. Send your private key in this chat.");
      await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.reply(
        "Send your private key in this private chat.\n" +
        "Warning: use a dedicated hot wallet only. Your message will be deleted after processing."
      );
      await ctx.answerCallbackQuery({ text: "Import flow started." });
      return;
    }

    if (!user) {
      await ctx.answerCallbackQuery({ text: "Import a wallet first.", show_alert: true });
      return;
    }

    if (["claimable", "balance", "status", "stats", "daily", "controls", "risk_settings", "wallet_check"].includes(action)) {
      const view = await renderDashboardPage(userId, user, action);
      const changed = await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery({ text: changed ? "Dashboard updated." : "Already up to date." });
      return;
    }

    if (action === "approve") {
      const accountConfig = resolveUserPolymarketAccountConfig(user);
      const poly = new PolyMarketAPI({
        key: user.api_key,
        secret: user.api_secret,
        passphrase: user.api_passphrase
      }, user.private_key, accountConfig);

      const hashes = await poly.approveUSDC();
      const links = hashes.map((hash, index) => `Tx ${index + 1}: https://polygonscan.com/tx/${hash}`).join("\n");
      const view = await renderDashboardPage(userId, user, "setup", `Approvals submitted.\n${links}`);
      await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery({ text: "Approvals submitted." });
      return;
    }

    if (action === "fund_prompt") {
      ctx.session.step = "awaiting_fund_amount";
      const view = await renderDashboardPage(userId, user, "setup", "Funding prompt opened. Send the USDC.e amount to move.");
      await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.reply("Send the amount of USDC.e to move into the trading wallet. Example: `25`", { parse_mode: "Markdown" });
      await ctx.answerCallbackQuery({ text: "Send funding amount." });
      return;
    }

    if (action === "risk_prompt") {
      ctx.session.step = "awaiting_set_risk";
      const view = await renderDashboardPage(userId, user, "risk_settings", "Risk update opened. Send the new percentage.");
      await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.reply("Send the new risk percentage from 1-100. Example: `5`", { parse_mode: "Markdown" });
      await ctx.answerCallbackQuery({ text: "Send risk %." });
      return;
    }

    if (action === "max_prompt") {
      ctx.session.step = "awaiting_set_max";
      const view = await renderDashboardPage(userId, user, "risk_settings", "Max trade update opened. Send the new amount.");
      await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.reply("Send the new max trade amount. Example: `50`", { parse_mode: "Markdown" });
      await ctx.answerCallbackQuery({ text: "Send max trade." });
      return;
    }

    if (action === "max_open_prompt") {
      ctx.session.step = "awaiting_set_max_open";
      const view = await renderDashboardPage(userId, user, "risk_settings", "Max open update opened. Send the new count.");
      await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.reply("Send the new maximum open positions count. Example: `10`", { parse_mode: "Markdown" });
      await ctx.answerCallbackQuery({ text: "Send max open." });
      return;
    }

    if (action === "start_trading" || action === "stop_trading") {
      const enabled = action === "start_trading";
      db.updateTradingStatus(userId, enabled);
      const updatedUser: any = db.getUser(userId);
      const view = await renderDashboardPage(
        userId,
        updatedUser,
        "controls",
        enabled ? "Auto-trading enabled." : "Auto-trading disabled."
      );
      await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery({ text: enabled ? "Trading enabled." : "Trading disabled." });
      return;
    }

    if (action === "claim_all") {
      const result = await claimAllForUser(userId, user);
      const updatedUser: any = db.getUser(userId);
      const view = await renderDashboardPage(userId, updatedUser, "claimable", result);
      await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery({ text: "Claim all processed." });
      return;
    }

    if (action === "auto_claim_on" || action === "auto_claim_off") {
      const enabled = action === "auto_claim_on";
      db.updateAutoClaim(userId, enabled);
      const updatedUser: any = db.getUser(userId);
      const view = await renderDashboardPage(
        userId,
        updatedUser,
        "refresh",
        enabled ? "Auto-claim enabled." : "Auto-claim disabled."
      );
      await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery({ text: enabled ? "Auto-claim enabled." : "Auto-claim disabled." });
      return;
    }

    if (action.startsWith("claim:")) {
      const tradeId = Number.parseInt(action.slice("claim:".length), 10);
      if (!Number.isInteger(tradeId)) {
        throw new Error("Invalid claim selection.");
      }
      const txHash = await claimTradeByIdForUser(userId, user, tradeId);
      const updatedUser: any = db.getUser(userId);
      const view = await renderDashboardPage(
        userId,
        updatedUser,
        "claimable",
        `Claim submitted: https://polygonscan.com/tx/${txHash}`
      );
      await safeEditDashboardMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery({ text: "Claim submitted." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown action." });
  } catch (e: any) {
    console.error(`[BOT] Callback Error (${action}): ${e.message}`);
    await ctx.answerCallbackQuery({ text: "Action failed.", show_alert: true });
  }
});

bot.on("message:text", async (ctx) => {
  if (ctx.session.step === "awaiting_pk") {
    if (!ctx.from) return;
    const pk = ctx.message.text.trim();
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch (e: any) {
      console.warn(`[BOT] Could not delete sensitive import message for ${ctx.from.id}: ${e.message}`);
    }

    console.log(`[BOT] Processing wallet import for user ${ctx.from.id}...`);
    ctx.session.pending_private_key = pk;
    ctx.session.step = "awaiting_funder";
    ctx.reply(
      "Now send your Polymarket displayed wallet address.\n" +
      "If your Polymarket account uses the same wallet as the signer, reply `skip`.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (ctx.session.step === "awaiting_funder") {
    if (!ctx.from) return;
    const rawValue = ctx.message.text.trim();
    const funderAddress = rawValue.toLowerCase() === "skip" ? null : rawValue;

    if (funderAddress && !/^0x[a-fA-F0-9]{40}$/.test(funderAddress)) {
      ctx.reply("That funder address does not look valid. Send a `0x...` wallet address or reply `skip`.");
      return;
    }

    ctx.session.pending_funder_address = funderAddress || "";
    ctx.session.step = "awaiting_signature_type";
    ctx.reply(
      "Reply with signature type:\n" +
      "`0` = same wallet / EOA\n" +
      "`1` = Polymarket email-Google proxy\n" +
      "`2` = Polymarket browser-wallet proxy (most common)",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (ctx.session.step === "awaiting_signature_type") {
    if (!ctx.from) return;
    const rawValue = ctx.message.text.trim();
    const signatureType = Number.parseInt(rawValue, 10);

    if (![0, 1, 2].includes(signatureType)) {
      ctx.reply("Reply with `0`, `1`, or `2`.", { parse_mode: "Markdown" });
      return;
    }

    const pk = ctx.session.pending_private_key || "";
    const funderAddress = ctx.session.pending_funder_address || null;

    try {
      const accountConfig = {
        funderAddress,
        signatureType,
      };
      const creds = await crypto.deriveApiKeys(pk, accountConfig);
      db.saveUser({
        tg_id: ctx.from.id.toString(),
        private_key: pk,
        api_key: creds.key,
        api_secret: creds.secret,
        api_passphrase: creds.passphrase,
        funder_address: accountConfig.funderAddress,
        signature_type: accountConfig.signatureType,
      });
      console.log(`[BOT] Successfully saved encrypted credentials for user ${ctx.from.id}`);
      ctx.reply("Wallet imported successfully. Sensitive credentials were encrypted at rest.");
      const savedUser: any = db.getUser(ctx.from.id.toString());
      const view = await renderDashboardPage(ctx.from.id.toString(), savedUser, "setup", "Wallet import completed.");
      ctx.reply(view.text, {
        parse_mode: "Markdown",
        reply_markup: view.keyboard,
      });
      ctx.session.step = "";
      ctx.session.pending_private_key = "";
      ctx.session.pending_funder_address = "";
    } catch (e: any) {
      console.error(`[BOT] Import Error for ${ctx.from.id}.`);
      if (String(e?.message || "").includes("MASTER_ENCRYPTION_KEY")) {
        ctx.reply("Wallet import is temporarily unavailable because MASTER_ENCRYPTION_KEY is not configured on the server.");
      } else {
        ctx.reply("Wallet import failed. Please verify the private key and try again.");
      }
      ctx.session.step = "";
      ctx.session.pending_private_key = "";
      ctx.session.pending_funder_address = "";
    }
  }

  if (ctx.session.step === "awaiting_fund_amount") {
    if (!ctx.from) return;
    const user: any = db.getUser(ctx.from.id.toString());
    if (!user) {
      ctx.session.step = "";
      ctx.reply("Use /import first.");
      return;
    }

    const amount = parseFloat(ctx.message.text.trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      ctx.reply("Send a valid USDC.e amount. Example: `25`", { parse_mode: "Markdown" });
      return;
    }

    try {
      const accountConfig = resolveUserPolymarketAccountConfig(user);
      const poly = new PolyMarketAPI({
        key: user.api_key,
        secret: user.api_secret,
        passphrase: user.api_passphrase
      }, user.private_key, accountConfig);
      const txHash = await poly.transferUsdcToFunder(amount);
      ctx.reply(
        `Signer-to-funder transfer submitted for ${amount.toFixed(2)} USDC.e.\nhttps://polygonscan.com/tx/${txHash}`
      );
      ctx.session.step = "";
    } catch (e: any) {
      console.error(`[BOT] fund_funder Error: ${e.message}`);
      ctx.reply(`Funding transfer failed: ${e.message}`);
      ctx.session.step = "";
    }
    return;
  }

  if (ctx.session.step === "awaiting_set_risk") {
    if (!ctx.from) return;
    const risk = parseFloat(ctx.message.text.trim());
    if (isNaN(risk) || risk <= 0 || risk > 100) {
      ctx.reply("Send a percentage from 1-100. Example: `5`", { parse_mode: "Markdown" });
      return;
    }
    db.updateRisk(ctx.from.id.toString(), risk);
    ctx.session.step = "";
    ctx.reply(`Risk set to ${risk}% per trade.`);
    return;
  }

  if (ctx.session.step === "awaiting_set_max") {
    if (!ctx.from) return;
    const max = parseFloat(ctx.message.text.trim());
    if (isNaN(max) || max <= 0) {
      ctx.reply("Send a valid max trade amount. Example: `50`", { parse_mode: "Markdown" });
      return;
    }
    db.updateMaxTrade(ctx.from.id.toString(), max);
    ctx.session.step = "";
    ctx.reply(`Max trade amount set to $${max}.`);
    return;
  }

  if (ctx.session.step === "awaiting_set_max_open") {
    if (!ctx.from) return;
    const maxOpen = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(maxOpen) || maxOpen <= 0) {
      ctx.reply("Send a whole number greater than 0. Example: `10`", { parse_mode: "Markdown" });
      return;
    }
    db.updateMaxOpenPositions(ctx.from.id.toString(), maxOpen);
    ctx.session.step = "";
    ctx.reply(`Maximum concurrent open positions set to ${maxOpen}.`);
    return;
  }
});

console.log("--------------------------");
console.log("Blocky Polymarket Bot Starting (Signer Support)...");
console.log("--------------------------");

const releaseLock = acquireProcessLock("telegram-bot");
if (!releaseLock) {
  process.exit(0);
}

bot.start().catch((err) => {
  releaseLock();
  console.error(err);
});
