import { DBManager, Trade } from "./db";
import { PolyMarketAPI } from "./polymarket";
import { Bot } from "grammy";
import * as dotenv from "dotenv";

dotenv.config();

export class SettlementMonitor {
  private db: DBManager;
  private bot: Bot;

  constructor() {
    this.db = new DBManager();
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    this.bot = new Bot(token);
  }

  async runLoop() {
    console.log("-----------------------------------------");
    console.log("Blocky Settlement Monitor Started (24/7)");
    console.log("-----------------------------------------");

    // Check every 30 minutes for settlement
    setInterval(async () => {
      try {
        await this.checkSettlements();
      } catch (e: any) {
        console.error(`[SETTLE ERROR] Loop Error: ${e.message}`);
      }
    }, 30 * 60 * 1000); 
  }

  private async checkSettlements() {
    const unsettled: Trade[] = this.db.getUnsettledTrades();
    if (unsettled.length === 0) return;

    console.log(`[SETTLE] Checking ${unsettled.length} unsettled trades...`);

    for (const trade of unsettled) {
      try {
        // Read-only client for market data
        const poly = new PolyMarketAPI({ key: "", secret: "", passphrase: "" }); 
        const market = await poly.getMarket(trade.market_id);

        if (market && market.closed) {
          // In Gamma API, closed: true typically means it's settled or about to be.
          // We check the outcome prices.
          const prices = JSON.parse(market.outcomePrices || "[]");
          if (prices.length < 2) continue;

          const winner = prices[0] === "1" ? "YES" : "NO";
          const win = trade.side === winner;
          
          // Calculate PnL (Simplified estimate)
          const pnl = win ? (trade.size * (1 - trade.buy_price)) : -(trade.size * trade.buy_price);

          // Mark settled in DB
          this.db.markSettled(trade.id, win ? 1 : 0, pnl);

          // Alert user via Telegram
          const status = win ? "WIN ✅" : "LOSS ❌";
          const alert = `
🔔 *Settlement Alert!*

Market: ${market.question}
Result: *${status}*
PnL: *${pnl.toFixed(2)} USDC*

📊 Use /stats to see overall performance.
          `;

          await this.bot.api.sendMessage(trade.tg_id, alert, { parse_mode: "Markdown" });
          console.log(`[SETTLE] Alerted user ${trade.tg_id} for market ${trade.market_id}`);
        }
      } catch (e: any) {
        console.error(`[SETTLE ERROR] Market ${trade.market_id}: ${e.message}`);
      }
    }
  }
}

if (require.main === module) {
  const monitor = new SettlementMonitor();
  monitor.runLoop();
}
