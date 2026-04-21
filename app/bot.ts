import { Bot, Context, session, SessionFlavor } from "grammy";
import * as dotenv from "dotenv";
import { DBManager } from "./db";
import { CryptoManager } from "./crypto";
import { PolyMarketAPI } from "./polymarket";
import { privateKeyToAccount } from "viem/accounts";

dotenv.config();

interface SessionData {
  step: string;
}

type MyContext = Context & SessionFlavor<SessionData>;

const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
if (!botToken) {
  console.error("CRITICAL ERROR: TELEGRAM_BOT_TOKEN is missing in .env");
}

const bot = new Bot<MyContext>(botToken);
const db = new DBManager();
const crypto = new CryptoManager();

bot.use(session({ initial: () => ({ step: "" }) }));

bot.command("start", (ctx) => {
  console.log(`[BOT] User ${ctx.from?.id} ran /start`);
  ctx.reply("Welcome to Blocky Polymarket Bot.\nUse /import to set up your wallet.\nUse /help for all commands.");
});

bot.command("help", (ctx) => {
  console.log(`[BOT] User ${ctx.from?.id} ran /help`);
  ctx.reply(`
Available Commands:
/start - Start the bot
/import - Import Private Key
/approve - Set trading allowance (one-time)
/start_trading - Enable auto-trading
/stop_trading - Disable auto-trading
/status - Check bot status
/balance - Check USDC balance
/positions - View open positions
/claimable - List settled winning trades waiting to be claimed
/claim <market_id> - Manually claim a settled winning market
/claim_all - Claim all settled winning markets
/auto_claim_on - Enable automatic claiming after settlement
/auto_claim_off - Disable automatic claiming after settlement
/stats - View overall trading performance
/daily - View today's PnL summary
/set_risk <%> - Set risk per trade (example: /set_risk 5)
/set_max <amt> - Set max trade amount (example: /set_max 50)
/set_max_open <count> - Set maximum concurrent open positions
/remove_wallet - Securely delete your wallet
/help - Show this message
  `);
});

bot.command("stats", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /stats`);
  const overall = db.getOverallStats(ctx.from.id.toString());

  if (overall.total === 0) return ctx.reply("No trades recorded yet.");

  ctx.reply(`
*Overall Performance*
Total Trades: ${overall.total}
Settled: ${overall.settled}
Win Rate: ${overall.winRate}%
Total PnL: *${overall.pnl.toFixed(2)} USDC*
  `, { parse_mode: "Markdown" });
});

bot.command("daily", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /daily`);
  const daily = db.getDailyStats(ctx.from.id.toString());
  const overall = db.getOverallStats(ctx.from.id.toString());

  const today = new Date().toISOString().split("T")[0];
  const dailyWinRate = daily.settled > 0 ? ((daily.wins / daily.settled) * 100).toFixed(1) : "N/A";

  ctx.reply(`
*Daily Report - ${today}*

*Today:*
Trades: ${daily.total}
Settled: ${daily.settled}
Wins: ${daily.wins} (${dailyWinRate}%)
PnL: *${daily.pnl.toFixed(2)} USDC*

*All Time:*
Total Trades: ${overall.total}
Win Rate: ${overall.winRate}%
Cumulative PnL: *${overall.pnl.toFixed(2)} USDC*
  `, { parse_mode: "Markdown" });
});

bot.command("import", async (ctx) => {
  console.log(`[BOT] User ${ctx.from?.id} ran /import`);
  ctx.reply("Please send your Private Key in this private chat.\nWarning: use a dedicated hot wallet only. Your message will be deleted after processing.");
  ctx.session.step = "awaiting_pk";
});

bot.command("status", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /status`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("User data not found. Use /import first.");

  ctx.reply(`
Status: ${user.trading_active ? "Trading Active" : "Trading Stopped"}
Risk: ${user.risk_percent}%
Max Trade: $${user.max_trade_amount}
Max Open Positions: ${user.max_open_positions}
Auto-Claim: ${user.auto_claim ? "ON" : "OFF"}
  `);
});

bot.command("balance", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /balance`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("Use /import first.");

  try {
    const poly = new PolyMarketAPI({
      key: user.api_key,
      secret: user.api_secret,
      passphrase: user.api_passphrase
    }, user.private_key);
    const balanceData: any = await poly.getBalance();

    if (!balanceData || balanceData.balance === undefined) {
      throw new Error("Invalid balance data received from Polymarket.");
    }

    const balanceNum = parseFloat(balanceData.balance);
    const standardEx = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
    const allowanceVal = balanceData.allowances ? (balanceData as any).allowances[standardEx] : "0";
    const allowanceNum = parseFloat(allowanceVal || "0");

    const formattedBalance = isNaN(balanceNum) ? "0.00" : (balanceNum / 1000000).toFixed(2);
    const formattedAllowance = isNaN(allowanceNum) ? "0.00" : (allowanceNum / 1000000).toFixed(2);

    ctx.reply(`
*USDC Status*
Balance: ${formattedBalance} USDC
Allowance: ${formattedAllowance} USDC

_Note: If balance is wrong, ensure you have USDC.e (Bridged USDC)._
    `, { parse_mode: "Markdown" });
  } catch (e: any) {
    console.error(`[BOT] Balance Error: ${e.message}`);
    ctx.reply(`Balance Error: ${e.message}`);
  }
});

bot.command("approve", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /approve`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("Use /import first.");

  try {
    const poly = new PolyMarketAPI({
      key: user.api_key,
      secret: user.api_secret,
      passphrase: user.api_passphrase
    }, user.private_key);

    ctx.reply("Sending master approvals. This may take a few seconds.");
    const hashes = await poly.approveUSDC();
    ctx.reply(`Master approval successful.\n\nTx 1: https://polygonscan.com/tx/${hashes[0]}\nTx 2: https://polygonscan.com/tx/${hashes[1]}\n\nYou can now check your status with /balance in a minute.`);
  } catch (e: any) {
    console.error(`[BOT] Approval Error: ${e.message}`);
    ctx.reply(`Approval failed: ${e.message}`);
  }
});

bot.command("positions", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /positions`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("Use /import first.");

  try {
    const poly = new PolyMarketAPI({
      key: user.api_key,
      secret: user.api_secret,
      passphrase: user.api_passphrase
    }, user.private_key);

    const formattedPK = user.private_key.startsWith("0x") ? user.private_key : `0x${user.private_key}`;
    const account = privateKeyToAccount(formattedPK);

    const positions = await poly.getPositions(account.address);
    if (!positions || positions.length === 0) return ctx.reply("No open positions.");

    let msg = "Open Positions:\n";
    positions.forEach((p: any) => {
      msg += `- ${p.asset}: ${p.size} units @ ${p.avgPrice}\n`;
    });
    ctx.reply(msg);
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

  const lines = claimableTrades.slice(0, 20).map((trade) =>
    `Market ID: ${trade.market_id}\nSide: ${trade.side}\nSize: ${trade.size}\nEntry: ${trade.buy_price.toFixed(4)}`
  );
  const suffix = claimableTrades.length > 20
    ? `\nShowing 20 of ${claimableTrades.length} claimable trades.`
    : "";

  ctx.reply(`Claimable trades:\n\n${lines.join("\n\n")}${suffix}`);
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

  const trades = db.getClaimableTradesForMarket(ctx.from.id.toString(), marketId);
  if (trades.length === 0) {
    return ctx.reply("No settled winning trade is waiting to be claimed for that market.");
  }

  const trade = trades[0];
  if (!trade.condition_id) {
    return ctx.reply("This trade is missing a condition id, so the bot cannot redeem it automatically.");
  }

  try {
    const poly = new PolyMarketAPI({
      key: user.api_key,
      secret: user.api_secret,
      passphrase: user.api_passphrase
    }, user.private_key);

    const txHash = await poly.redeemWinnings(trade.condition_id);
    db.markClaimedByCondition(ctx.from.id.toString(), trade.condition_id, txHash);
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

  const claimableTrades = db.getClaimableTrades(ctx.from.id.toString());
  if (claimableTrades.length === 0) {
    return ctx.reply("No settled winning trades are waiting to be claimed.");
  }

  const uniqueConditions = Array.from(
    new Map(
      claimableTrades
        .filter((trade) => !!trade.condition_id)
        .map((trade) => [trade.condition_id, trade])
    ).values()
  );

  if (uniqueConditions.length === 0) {
    return ctx.reply("Claimable trades were found, but none have a usable condition id.");
  }

  const poly = new PolyMarketAPI({
    key: user.api_key,
    secret: user.api_secret,
    passphrase: user.api_passphrase
  }, user.private_key);

  const receipts: string[] = [];
  const failures: string[] = [];

  for (const trade of uniqueConditions) {
    try {
      const txHash = await poly.redeemWinnings(trade.condition_id);
      db.markClaimedByCondition(ctx.from.id.toString(), trade.condition_id, txHash);
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

  ctx.reply(lines.join("\n"));
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
    try {
      const creds = await crypto.deriveApiKeys(pk);
      db.saveUser({
        tg_id: ctx.from.id.toString(),
        private_key: pk,
        api_key: creds.key,
        api_secret: creds.secret,
        api_passphrase: creds.passphrase
      });
      console.log(`[BOT] Successfully saved encrypted credentials for user ${ctx.from.id}`);
      ctx.reply("Wallet imported successfully. Sensitive credentials were encrypted at rest.");
      ctx.session.step = "";
    } catch (e: any) {
      console.error(`[BOT] Import Error for ${ctx.from.id}.`);
      if (String(e?.message || "").includes("MASTER_ENCRYPTION_KEY")) {
        ctx.reply("Wallet import is temporarily unavailable because MASTER_ENCRYPTION_KEY is not configured on the server.");
      } else {
        ctx.reply("Wallet import failed. Please verify the private key and try again.");
      }
    }
  }
});

console.log("--------------------------");
console.log("Blocky Polymarket Bot Starting (Signer Support)...");
console.log("--------------------------");

bot.start().catch(console.error);
