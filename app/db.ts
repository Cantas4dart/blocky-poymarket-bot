import Database from "better-sqlite3";
import * as path from "path";

export interface User {
  id: number;
  tg_id: string;
  private_key: string;
  api_key: string;
  api_secret: string;
  api_passphrase: string;
  trading_active: number;
  risk_percent: number;
  max_trade_amount: number;
}

export interface Trade {
  id: number;
  market_id: string;
  tg_id: string;
  side: "YES" | "NO";
  buy_price: number;
  size: number;
  settled: number;
  outcome: number | null;
  pnl: number | null;
  timestamp: string;
}

export class DBManager {
  private db: Database.Database;

  constructor() {
    const dbPath = path.join(__dirname, "../data/users.db");
    this.db = new Database(dbPath);
    this.init();
  }

  private init() {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        tg_id TEXT UNIQUE,
        private_key TEXT,
        api_key TEXT,
        api_secret TEXT,
        api_passphrase TEXT,
        trading_active INTEGER DEFAULT 0,
        risk_percent REAL DEFAULT 1.0,
        max_trade_amount REAL DEFAULT 10.0
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY,
        market_id TEXT,
        tg_id TEXT,
        side TEXT,
        buy_price REAL,
        size REAL,
        settled INTEGER DEFAULT 0,
        outcome INTEGER,
        pnl REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  }

  saveUser(user: any) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO users (tg_id, private_key, api_key, api_secret, api_passphrase)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(user.tg_id, user.private_key, user.api_key, user.api_secret, user.api_passphrase);
  }

  getUser(tgId: string): User | undefined {
    return this.db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgId) as User | undefined;
  }

  getActiveUsers(): User[] {
    return this.db.prepare("SELECT * FROM users WHERE trading_active = 1").all() as User[];
  }

  updateTradingStatus(tgId: string, active: boolean) {
    this.db.prepare("UPDATE users SET trading_active = ? WHERE tg_id = ?").run(active ? 1 : 0, tgId);
  }

  updateRisk(tgId: string, risk: number) {
    this.db.prepare("UPDATE users SET risk_percent = ? WHERE tg_id = ?").run(risk, tgId);
  }

  updateMaxTrade(tgId: string, max: number) {
    this.db.prepare("UPDATE users SET max_trade_amount = ? WHERE tg_id = ?").run(max, tgId);
  }

  removeUser(tgId: string) {
    this.db.prepare("DELETE FROM users WHERE tg_id = ?").run(tgId);
  }

  saveTrade(trade: { market_id: string, tg_id: string, side: string, buy_price: number, size: number }) {
    const stmt = this.db.prepare(`
      INSERT INTO trades (market_id, tg_id, side, buy_price, size)
      VALUES (?, ?, ?, ?, ?)
    `);
    return stmt.run(trade.market_id, trade.tg_id, trade.side, trade.buy_price, trade.size);
  }

  hasTraded(tgId: string, marketId: string) {
    const result = this.db.prepare("SELECT id FROM trades WHERE tg_id = ? AND market_id = ?").get(tgId, marketId);
    return !!result;
  }

  getUnsettledTrades(): Trade[] {
    return this.db.prepare("SELECT * FROM trades WHERE settled = 0").all() as Trade[];
  }

  getTradesForUser(tgId: string): Trade[] {
    return this.db.prepare("SELECT * FROM trades WHERE tg_id = ? ORDER BY timestamp DESC").all(tgId) as Trade[];
  }

  markSettled(tradeId: number, outcome: number, pnl: number) {
    this.db.prepare("UPDATE trades SET settled = 1, outcome = ?, pnl = ? WHERE id = ?")
      .run(outcome, pnl, tradeId);
  }
}