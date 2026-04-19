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

// --- COMMANDS (Registered FIRST to ensure they aren't intercepted by text handler) ---

bot.command("start", (ctx) => {
  console.log(`[BOT] User ${ctx.from?.id} ran /start`);
  ctx.reply("Welcome to Blocky Polymarket Bot! 🌡️\nUse /import to set up your wallet.\nUse /help for all commands.");
});

bot.command("help", (ctx) => {
  console.log(`[BOT] User ${ctx.from?.id} ran /help`);
  ctx.reply(`
Available Commands:
/start - Start the bot
/import - Import Private Key
/approve - Set trading allowance (One-time)
/start_trading - Enable auto-trading
/stop_trading - Disable auto-trading
/status - Check bot status
/balance - Check USDC balance
/positions - View open positions
/stats - View trading performance (PnL)
/set_risk <%> - Set risk per trade (e.g. /set_risk 5)
/set_max <amt> - Set max trade amount (e.g. /set_max 50)
/remove_wallet - Securely delete your wallet
/help - Show this message
  `);
});

bot.command("stats", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /stats`);
  const trades = db.getTradesForUser(ctx.from.id.toString());
  
  if (trades.length === 0) return ctx.reply("No trades recorded yet.");
  
  const totalPnL = trades.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);
  const wins = trades.filter((t: any) => t.outcome === 1).length;
  const settled = trades.filter((t: any) => t.settled === 1).length;
  const winRate = settled > 0 ? ((wins / settled) * 100).toFixed(1) : "0";

  ctx.reply(`
📊 *Trade Performance* (Cumulative)
Total Trades: ${trades.length}
Settled: ${settled}
Win Rate: ${winRate}%
Total PnL: *${totalPnL.toFixed(2)} USDC*
  `, { parse_mode: "Markdown" });
});

bot.command("import", async (ctx) => {
  console.log(`[BOT] User ${ctx.from?.id} ran /import`);
  ctx.reply("Please send your Private Key (Ensure you are in a private chat!).\nWarning: This is sensitive data.");
  ctx.session.step = "awaiting_pk";
});

bot.command("status", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /status`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("❌ User data not found. Use /import first.");
  ctx.reply(`
🤖 Status: ${user.trading_active ? "Trading Active ✅" : "Trading Stopped 🛑"}
📈 Risk: ${user.risk_percent}%
💰 Max Trade: $${user.max_trade_amount}
  `);
});

bot.command("balance", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /balance`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("❌ Use /import first.");
  
  try {
    const poly = new PolyMarketAPI({
      key: user.api_key,
      secret: user.api_secret,
      passphrase: user.api_passphrase
    }, user.private_key);
    const balanceData: any = await poly.getBalance();
    console.log(`[BOT] Raw Balance Data for ${ctx.from.id}:`, balanceData);
    
    if (!balanceData || balanceData.balance === undefined) {
      throw new Error("Invalid balance data received from Polymarket.");
    }

    // USDC has 6 decimals
    const balanceNum = parseFloat(balanceData.balance);
    
    // allowances is an object, we check the standard exchange contract
    // we use (balanceData as any) to bypass the incorrect SDK type definition
    const standardEx = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
    const allowanceVal = balanceData.allowances ? (balanceData as any).allowances[standardEx] : "0";
    const allowanceNum = parseFloat(allowanceVal || "0");

    const formattedBalance = isNaN(balanceNum) ? "0.00" : (balanceNum / 1000000).toFixed(2);
    const formattedAllowance = isNaN(allowanceNum) ? "0.00" : (allowanceNum / 1000000).toFixed(2);

    ctx.reply(`
💰 *USDC Status*
Balance: ${formattedBalance} USDC
Allowance: ${formattedAllowance} USDC

_Note: If balance is wrong, ensure you have USDC.e (Bridged USDC)._
    `, { parse_mode: "Markdown" });
  } catch (e: any) {
    console.error(`[BOT] Balance Error: ${e.message}`);
    ctx.reply(`❌ Balance Error: ${e.message}`);
  }
});

bot.command("approve", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /approve`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("❌ Use /import first.");

  try {
    const poly = new PolyMarketAPI({
      key: user.api_key,
      secret: user.api_secret,
      passphrase: user.api_passphrase
    }, user.private_key);

    ctx.reply("⏳ Sending Master Approvals (Standard + Neg Risk)... This may take a few seconds.");
    const hashes = await poly.approveUSDC();
    ctx.reply(`✅ Master Approval successful!\n\nTx 1: https://polygonscan.com/tx/${hashes[0]}\nTx 2: https://polygonscan.com/tx/${hashes[1]}\n\nYou can now check your status with /balance in a minute.`);
  } catch (e: any) {
    console.error(`[BOT] Approval Error: ${e.message}`);
    ctx.reply(`❌ Approval Failed: ${e.message}`);
  }
});

bot.command("positions", async (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /positions`);
  const user: any = db.getUser(ctx.from.id.toString());
  if (!user) return ctx.reply("❌ Use /import first.");
  
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
    
    let msg = "📊 Open Positions:\n";
    positions.forEach((p: any) => {
      msg += `- ${p.asset}: ${p.size} units @ ${p.avgPrice}\n`;
    });
    ctx.reply(msg);
  } catch (e: any) {
    console.error(`[BOT] Positions Error: ${e.message}`);
    ctx.reply(`❌ Positions Error: ${e.message}`);
  }
});

bot.command("set_risk", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /set_risk ${ctx.match}`);
  const reqRisk = ctx.match || "";
  const risk = parseFloat(reqRisk);
  if (isNaN(risk) || risk <= 0 || risk > 100) {
    return ctx.reply("❌ Please provide a percentage (1-100). Example: /set_risk 5");
  }
  db.updateRisk(ctx.from.id.toString(), risk);
  ctx.reply(`✅ Risk set to ${risk}% per trade.`);
});

bot.command("set_max", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /set_max ${ctx.match}`);
  const reqMax = ctx.match || "";
  const max = parseFloat(reqMax);
  if (isNaN(max) || max <= 0) {
    return ctx.reply("❌ Please provide a valid amount. Example: /set_max 50");
  }
  db.updateMaxTrade(ctx.from.id.toString(), max);
  ctx.reply(`✅ Max trade amount set to $${max}.`);
});

bot.command("start_trading", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /start_trading`);
  db.updateTradingStatus(ctx.from.id.toString(), true);
  ctx.reply("🚀 Auto-trading enabled!");
});

bot.command("stop_trading", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /stop_trading`);
  db.updateTradingStatus(ctx.from.id.toString(), false);
  ctx.reply("🛑 Auto-trading disabled.");
});

bot.command("remove_wallet", (ctx) => {
  if (!ctx.from) return;
  console.log(`[BOT] User ${ctx.from.id} ran /remove_wallet`);
  db.removeUser(ctx.from.id.toString());
  ctx.reply("🗑️ Your wallet and credentials have been securely deleted from the bot.");
});

// --- GENERAL TEXT HANDLER (Registered LAST to catch step responses only) ---

bot.on("message:text", async (ctx) => {
  if (ctx.session.step === "awaiting_pk") {
    if (!ctx.from) return;
    const pk = ctx.message.text.trim();
    console.log(`[BOT] Processing PK import for user ${ctx.from.id}...`);
    try {
      const creds = await crypto.deriveApiKeys(pk);
      db.saveUser({
        tg_id: ctx.from.id.toString(),
        private_key: pk,
        api_key: creds.key,
        api_secret: creds.secret,
        api_passphrase: creds.passphrase
      });
      console.log(`[BOT] Successfully saved credentials for user ${ctx.from.id}`);
      ctx.reply("✅ Private Key imported and API keys derived successfully!");
      ctx.session.step = "";
    } catch (e: any) {
      console.error(`[BOT] Import Error: ${e.message}`);
      ctx.reply(`❌ Error: ${e.message}`);
    }
  }
});

console.log("--------------------------");
console.log("Blocky Polymarket Bot Starting (Signer Support)...");
console.log("--------------------------");

bot.start().catch(console.error);