import * as fs from "fs";
import * as path from "path";
import { PolyMarketAPI } from "./polymarket";
import { DBManager, User } from "./db";

export class TradeExecutor {
  private db: DBManager;
  private signalPath: string;

  constructor() {
    this.db = new DBManager();
    this.signalPath = path.join(__dirname, "../data/signals.json");
  }

  async runLoop() {
    console.log("-----------------------------------------");
    console.log("Blocky Execution Loop Started (24/7 Mode)");
    console.log("-----------------------------------------");
    
    // Check every 2 minutes for new signals
    setInterval(async () => {
      try {
        await this.processSignals();
      } catch (e: any) {
        console.error(`[EXEC ERROR] Loop Error: ${e.message}`);
      }
    }, 120000); 
  }

  private async processSignals() {
    if (!fs.existsSync(this.signalPath)) {
      console.log("[EXEC] No signals file found. Waiting...");
      return;
    }
    
    const data = JSON.parse(fs.readFileSync(this.signalPath, "utf-8"));
    const signals = data.signals || [];

    if (signals.length === 0) {
      console.log("[EXEC] No active signals in file.");
      return;
    }

    const activeUsers: User[] = this.db.getActiveUsers();
    console.log(`[EXEC] Found ${activeUsers.length} active traders.`);

    for (const user of activeUsers) {
      const poly = new PolyMarketAPI({
        key: user.api_key,
        secret: user.api_secret,
        passphrase: user.api_passphrase
      }, user.private_key);

      for (const signal of signals) {
        // 1. Check if user already traded this market
        if (this.db.hasTraded(user.tg_id, signal.market_id)) {
          continue;
        }

        console.log(`[EXEC] New Signal for ${user.tg_id}: ${signal.question}`);

        try {
          // 2. Size Calculation
          const balanceData: any = await poly.getBalance();
          const balance = parseFloat(balanceData.balance);
          
          // Size = min(Balance * Risk%, MaxTradeAmount) / Price
          let targetUSD = balance * (user.risk_percent / 100);
          if (targetUSD > user.max_trade_amount) targetUSD = user.max_trade_amount;
          
          const size = Math.floor(targetUSD / signal.market_price);
          
          if (size < 1) {
            console.log(`[EXEC] Balance too low to place trade for ${user.tg_id}`);
            continue;
          }

          // 3. Get Token ID from Gamma API
          const marketData = await poly.getMarket(signal.market_id);
          const clobTokenIds = JSON.parse(marketData.clobTokenIds);
          // 0 = Yes, 1 = No
          const tokenId = signal.action === "BUY_YES" ? clobTokenIds[0] : clobTokenIds[1];

          // 4. Place Order
          await poly.placeLimitOrder(tokenId, "BUY", signal.market_price, size);

          // 5. Save trade to tracking DB
          this.db.saveTrade({
            market_id: signal.market_id,
            tg_id: user.tg_id,
            side: signal.action.split("_")[1], // YES or NO
            buy_price: signal.market_price,
            size: size
          });

          console.log(`[EXEC] Trade successfully executed and saved for ${user.tg_id}`);

        } catch (e: any) {
          console.error(`[EXEC ERROR] User ${user.tg_id} failed trade: ${e.message}`);
        }
      }
    }
  }
}

if (require.main === module) {
  const executor = new TradeExecutor();
  executor.runLoop();
}