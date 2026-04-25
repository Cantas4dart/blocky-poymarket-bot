import { DBManager, Trade } from "./db";
import { PolyMarketAPI } from "./polymarket";
import { Bot } from "grammy";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { acquireProcessLock } from "./singleton";

dotenv.config();

export class SettlementMonitor {
  private db: DBManager;
  private bot: Bot;
  private lastDailyReport: string = "";
  private stateFile: string;

  constructor() {
    this.db = new DBManager();
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    this.bot = new Bot(token);
    this.stateFile = path.join(__dirname, "../data/settlement_state.json");
    this.loadState();
  }

  private loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, "utf-8"));
        this.lastDailyReport = data.lastDailyReport || "";
        console.log(`[SETTLE] Loaded state: lastDailyReport = ${this.lastDailyReport}`);
      }
    } catch (e: any) {
      console.warn(`[SETTLE] Could not load state: ${e.message}`);
    }
  }

  private saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({
        lastDailyReport: this.lastDailyReport,
        updatedAt: new Date().toISOString()
      }, null, 2));
    } catch (e: any) {
      console.warn(`[SETTLE] Could not save state: ${e.message}`);
    }
  }

  async runLoop() {
    console.log("-----------------------------------------");
    console.log("Blocky Settlement Monitor Started (24/7)");
    console.log("-----------------------------------------");

    setTimeout(async () => {
      try {
        console.log("[SETTLE] Running startup settlement check...");
        await this.checkSettlements();
      } catch (e: any) {
        console.error(`[SETTLE ERROR] Startup check failed: ${e.message}`);
      }
    }, 5000);

    setInterval(async () => {
      try {
        await this.checkSettlements();
      } catch (e: any) {
        console.error(`[SETTLE ERROR] Loop Error: ${e.message}`);
      }
    }, 30 * 60 * 1000);

    setInterval(async () => {
      try {
        await this.checkDailyReport();
      } catch (e: any) {
        console.error(`[DAILY ERROR] Report Error: ${e.message}`);
      }
    }, 10 * 60 * 1000);
  }

  private async checkSettlements() {
    const unsettled: Trade[] = this.db.getUnsettledTrades();
    if (unsettled.length === 0) return;

    console.log(`[SETTLE] Checking ${unsettled.length} unsettled trades...`);

    for (const trade of unsettled) {
      try {
        const poly = new PolyMarketAPI({ key: "", secret: "", passphrase: "" });
        const market = trade.condition_id
          ? await poly.getMarketByConditionId(trade.condition_id)
          : await poly.getMarketById(trade.market_id);

        if (!market || !market.closed) {
          continue;
        }

        const prices = JSON.parse(market.outcomePrices || "[]");
        if (prices.length < 2) {
          continue;
        }

        const winner = prices[0] === "1" ? "YES" : "NO";
        const win = trade.side === winner;
        const pnl = win ? (trade.size * (1 - trade.buy_price)) : -(trade.size * trade.buy_price);
        this.db.markSettled(trade.id, win ? 1 : 0, pnl);

        let claimMessage = "Manual claim available with /claim or /claim_all.";
        if (win) {
          const claimResult = await this.tryAutoClaim(trade);
          if (claimResult.claimed && claimResult.txHash) {
            claimMessage = `Auto-claimed: https://polygonscan.com/tx/${claimResult.txHash}`;
          } else if (claimResult.reason) {
            claimMessage = `Auto-claim skipped: ${claimResult.reason}`;
          }
        }

        const status = win ? "WIN" : "LOSS";
        const roi = win
          ? `+${((1 - trade.buy_price) / trade.buy_price * 100).toFixed(1)}%`
          : "-100%";
        const alert = `
*Settlement Alert!*

Market: ${market.question}
Side: *${trade.side}*
Entry Price: ${trade.buy_price.toFixed(4)}
Size: ${trade.size} shares
Result: *${status}*
PnL: *${pnl.toFixed(2)} USDC*
ROI: *${roi}*

${claimMessage}

Use /stats to see overall performance.
Use /daily for today's summary.
        `;

        await this.bot.api.sendMessage(trade.tg_id, alert, { parse_mode: "Markdown" });
        console.log(`[SETTLE] Alerted user ${trade.tg_id} for market ${trade.market_id} (${status})`);
      } catch (e: any) {
        console.error(`[SETTLE ERROR] Market ${trade.market_id}: ${e.message}`);
      }
    }
  }

  private async tryAutoClaim(trade: Trade): Promise<{ claimed: boolean; txHash?: string; reason?: string }> {
    if (!trade.condition_id) {
      return { claimed: false, reason: "missing condition id" };
    }

    const user = this.db.getUser(trade.tg_id);
    if (!user) {
      return { claimed: false, reason: "user not found" };
    }
    if (!user.auto_claim) {
      return { claimed: false, reason: "auto-claim disabled for this user" };
    }

    try {
      const poly = new PolyMarketAPI({
        key: user.api_key,
        secret: user.api_secret,
        passphrase: user.api_passphrase
      }, user.private_key, {
        funderAddress: user.funder_address || (process.env.POLY_FUNDER_ADDRESS || "").trim() || null,
        signatureType: Number.isInteger(user.signature_type)
          ? user.signature_type
          : ((process.env.POLY_SIGNATURE_TYPE || "").trim() ? Number.parseInt(process.env.POLY_SIGNATURE_TYPE || "", 10) : null),
      });

      const txHash = await poly.redeemWinnings(trade.condition_id);
      this.db.markClaimedByCondition(trade.tg_id, trade.condition_id, txHash);
      console.log(`[SETTLE] Auto-claimed condition ${trade.condition_id} for ${trade.tg_id}: ${txHash}`);
      return { claimed: true, txHash };
    } catch (e: any) {
      console.warn(`[SETTLE] Auto-claim failed for ${trade.tg_id} / ${trade.condition_id}: ${e.message}`);
      return { claimed: false, reason: e.message };
    }
  }

  private async checkDailyReport() {
    const now = new Date();
    const hour = now.getUTCHours();
    const todayKey = now.toISOString().split("T")[0];

    if (hour !== 21 || this.lastDailyReport === todayKey) return;

    this.lastDailyReport = todayKey;
    this.saveState();
    console.log(`[DAILY] Sending daily performance reports for ${todayKey}...`);

    const activeUserIds = this.db.getAllActiveUserIds();

    for (const tgId of activeUserIds) {
      try {
        const daily = this.db.getDailyStats(tgId);
        const overall = this.db.getOverallStats(tgId);

        const dailyWinRate = daily.settled > 0
          ? ((daily.wins / daily.settled) * 100).toFixed(1)
          : "N/A";

        const overallROI = overall.settled > 0 && overall.total > 0
          ? `${(overall.pnl / (overall.total * 10) * 100).toFixed(1)}%`
          : "N/A";

        const report = `
*Evening Report - ${todayKey}*

*Today:*
Trades Placed: ${daily.total}
Settled: ${daily.settled}
Wins: ${daily.wins} (${dailyWinRate}%)
Day PnL: *${daily.pnl.toFixed(2)} USDC*

*All Time:*
Total Trades: ${overall.total}
Settled: ${overall.settled}
Win Rate: ${overall.winRate}%
Cumulative PnL: *${overall.pnl.toFixed(2)} USDC*
Estimated ROI: *${overallROI}*

_Automated daily report from Blocky_
        `;

        await this.bot.api.sendMessage(tgId, report, { parse_mode: "Markdown" });
        console.log(`[DAILY] Sent report to ${tgId}`);
      } catch (e: any) {
        console.error(`[DAILY ERROR] User ${tgId}: ${e.message}`);
      }
    }
  }
}

if (require.main === module) {
  const releaseLock = acquireProcessLock("settlement-monitor");
  if (!releaseLock) {
    process.exit(0);
  }
  const monitor = new SettlementMonitor();
  monitor.runLoop();
}
