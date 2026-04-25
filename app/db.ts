import Database from "better-sqlite3";
import * as path from "path";
import { decryptSecret, encryptSecret, hasMasterKey, isEncryptedSecret } from "./secrets";

export interface User {
  id: number;
  tg_id: string;
  private_key: string;
  api_key: string;
  api_secret: string;
  api_passphrase: string;
  funder_address: string | null;
  signature_type: number | null;
  trading_active: number;
  risk_percent: number;
  max_trade_amount: number;
  auto_claim: number;
  max_open_positions: number;
}

export interface Trade {
  id: number;
  market_id: string;
  condition_id: string;
  tg_id: string;
  side: "YES" | "NO";
  buy_price: number;
  size: number;
  remaining_size: number;
  entry_model_prob: number | null;
  entry_market_prob: number | null;
  entry_confidence: number | null;
  entry_spread: number | null;
  entry_regime: string | null;
  execution_status: "placing" | "submitted";
  order_id: string | null;
  position_closed: number;
  exit_price: number | null;
  exit_reason: string | null;
  exited_at: string | null;
  settled: number;
  outcome: number | null;
  pnl: number | null;
  claimed: number;
  claim_tx: string | null;
  claimed_at: string | null;
  timestamp: string;
}

export class DBManager {
  private db: Database.Database;

  constructor() {
    const dbPath = path.join(__dirname, "../data/users.db");
    this.db = new Database(dbPath);
    this.init();
    this.cleanupLegacyUnsignedSubmissions();
    this.maybeMigratePlaintextSecrets();
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
        funder_address TEXT,
        signature_type INTEGER,
        trading_active INTEGER DEFAULT 0,
        risk_percent REAL DEFAULT 1.0,
        max_trade_amount REAL DEFAULT 10.0,
        auto_claim INTEGER DEFAULT 1,
        max_open_positions INTEGER DEFAULT 10
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY,
        market_id TEXT,
        condition_id TEXT,
        tg_id TEXT,
        side TEXT,
        buy_price REAL,
        size REAL,
        remaining_size REAL,
        entry_model_prob REAL,
        entry_market_prob REAL,
        entry_confidence REAL,
        entry_spread REAL,
        entry_regime TEXT,
        execution_status TEXT DEFAULT 'submitted',
        order_id TEXT,
        position_closed INTEGER DEFAULT 0,
        exit_price REAL,
        exit_reason TEXT,
        exited_at DATETIME,
        settled INTEGER DEFAULT 0,
        outcome INTEGER,
        pnl REAL,
        claimed INTEGER DEFAULT 0,
        claim_tx TEXT,
        claimed_at DATETIME,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    this.ensureTradeColumn("condition_id", "TEXT");
    this.ensureTradeColumn("remaining_size", "REAL");
    this.ensureTradeColumn("entry_model_prob", "REAL");
    this.ensureTradeColumn("entry_market_prob", "REAL");
    this.ensureTradeColumn("entry_confidence", "REAL");
    this.ensureTradeColumn("entry_spread", "REAL");
    this.ensureTradeColumn("entry_regime", "TEXT");
    this.ensureTradeColumn("execution_status", "TEXT DEFAULT 'submitted'");
    this.ensureTradeColumn("order_id", "TEXT");
    this.ensureTradeColumn("position_closed", "INTEGER DEFAULT 0");
    this.ensureTradeColumn("exit_price", "REAL");
    this.ensureTradeColumn("exit_reason", "TEXT");
    this.ensureTradeColumn("exited_at", "DATETIME");
    this.ensureTradeColumn("claimed", "INTEGER DEFAULT 0");
    this.ensureTradeColumn("claim_tx", "TEXT");
    this.ensureTradeColumn("claimed_at", "DATETIME");
    this.ensureUserColumn("funder_address", "TEXT");
    this.ensureUserColumn("signature_type", "INTEGER");
    this.ensureUserColumn("auto_claim", "INTEGER DEFAULT 1");
    this.ensureUserColumn("max_open_positions", "INTEGER DEFAULT 10");
    this.ensureUniqueTradePerMarket();
  }

  private ensureTradeColumn(columnName: string, definition: string) {
    const columns = this.db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>;
    const exists = columns.some((column) => column.name === columnName);
    if (!exists) {
      this.runAddColumn("trades", columnName, definition);
    }
  }

  private ensureUserColumn(columnName: string, definition: string) {
    const columns = this.db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const exists = columns.some((column) => column.name === columnName);
    if (!exists) {
      this.runAddColumn("users", columnName, definition);
    }
  }

  private runAddColumn(tableName: "users" | "trades", columnName: string, definition: string) {
    try {
      this.db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
    } catch (e: any) {
      const message = String(e?.message || "").toLowerCase();
      if (!message.includes(`duplicate column name: ${columnName}`.toLowerCase())) {
        throw e;
      }
    }
  }

  private ensureUniqueTradePerMarket() {
    this.db.prepare(`
      DELETE FROM trades
      WHERE id NOT IN (
        SELECT MIN(id)
        FROM trades
        GROUP BY tg_id, market_id
      )
    `).run();

    this.db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_unique_user_market
      ON trades (tg_id, market_id)
    `).run();
  }

  private cleanupLegacyUnsignedSubmissions() {
    const result = this.db.prepare(`
      DELETE FROM trades
      WHERE execution_status = 'submitted'
        AND order_id IS NULL
    `).run();

    if (result.changes > 0) {
      console.warn(`[DB] Removed ${result.changes} legacy trade record(s) with no posted order ID.`);
    }
  }

  saveUser(user: any) {
    if (!hasMasterKey()) {
      throw new Error("MASTER_ENCRYPTION_KEY is not configured.");
    }
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO users (
        tg_id,
        private_key,
        api_key,
        api_secret,
        api_passphrase,
        funder_address,
        signature_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      user.tg_id,
      encryptSecret(user.private_key),
      encryptSecret(user.api_key),
      encryptSecret(user.api_secret),
      encryptSecret(user.api_passphrase),
      user.funder_address || null,
      user.signature_type ?? null
    );
  }

  updatePolymarketAccountConfig(tgId: string, funderAddress: string | null, signatureType: number | null) {
    this.db.prepare(`
      UPDATE users
      SET funder_address = ?, signature_type = ?
      WHERE tg_id = ?
    `).run(funderAddress, signatureType, tgId);
  }

  getUser(tgId: string): User | undefined {
    const user = this.db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgId) as User | undefined;
    if (!user) return undefined;

    if (
      (!hasMasterKey()) &&
      (
        isEncryptedSecret(user.private_key) ||
        isEncryptedSecret(user.api_key) ||
        isEncryptedSecret(user.api_secret) ||
        isEncryptedSecret(user.api_passphrase)
      )
    ) {
      throw new Error("MASTER_ENCRYPTION_KEY is required to unlock stored wallet credentials.");
    }

    user.private_key = decryptSecret(user.private_key);
    user.api_key = decryptSecret(user.api_key);
    user.api_secret = decryptSecret(user.api_secret);
    user.api_passphrase = decryptSecret(user.api_passphrase);
    return user;
  }

  getActiveUsers(): User[] {
    const users = this.db.prepare("SELECT * FROM users WHERE trading_active = 1").all() as User[];
    if (
      !hasMasterKey() &&
      users.some((user) =>
        isEncryptedSecret(user.private_key) ||
        isEncryptedSecret(user.api_key) ||
        isEncryptedSecret(user.api_secret) ||
        isEncryptedSecret(user.api_passphrase)
      )
    ) {
      throw new Error("MASTER_ENCRYPTION_KEY is required to unlock stored wallet credentials.");
    }

    return users.map((user) => ({
      ...user,
      private_key: decryptSecret(user.private_key),
      api_key: decryptSecret(user.api_key),
      api_secret: decryptSecret(user.api_secret),
      api_passphrase: decryptSecret(user.api_passphrase),
    }));
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

  updateAutoClaim(tgId: string, autoClaim: boolean) {
    this.db.prepare("UPDATE users SET auto_claim = ? WHERE tg_id = ?").run(autoClaim ? 1 : 0, tgId);
  }

  updateMaxOpenPositions(tgId: string, maxOpenPositions: number) {
    this.db.prepare("UPDATE users SET max_open_positions = ? WHERE tg_id = ?").run(maxOpenPositions, tgId);
  }

  removeUser(tgId: string) {
    this.db.prepare("DELETE FROM users WHERE tg_id = ?").run(tgId);
  }

  maybeMigratePlaintextSecrets() {
    if (!hasMasterKey()) {
      const row = this.db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
      if ((row?.count || 0) > 0) {
        console.warn("[DB] MASTER_ENCRYPTION_KEY is not set. Existing wallet records will not be migrated or unlocked yet.");
      }
      return;
    }

    const users = this.db.prepare(
      "SELECT id, private_key, api_key, api_secret, api_passphrase FROM users"
    ).all() as Array<{
      id: number;
      private_key: string;
      api_key: string;
      api_secret: string;
      api_passphrase: string;
    }>;

    const stmt = this.db.prepare(`
      UPDATE users
      SET private_key = ?, api_key = ?, api_secret = ?, api_passphrase = ?
      WHERE id = ?
    `);

    for (const user of users) {
      if (
        isEncryptedSecret(user.private_key) &&
        isEncryptedSecret(user.api_key) &&
        isEncryptedSecret(user.api_secret) &&
        isEncryptedSecret(user.api_passphrase)
      ) {
        continue;
      }

      stmt.run(
        encryptSecret(decryptSecret(user.private_key || "")),
        encryptSecret(decryptSecret(user.api_key || "")),
        encryptSecret(decryptSecret(user.api_secret || "")),
        encryptSecret(decryptSecret(user.api_passphrase || "")),
        user.id
      );
    }
  }

  reserveTrade(trade: {
    market_id: string,
    condition_id: string,
    tg_id: string,
    side: string,
    buy_price: number,
    size: number,
    entry_model_prob?: number | null,
    entry_market_prob?: number | null,
    entry_confidence?: number | null,
    entry_spread?: number | null,
    entry_regime?: string | null,
  }) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO trades (
        market_id,
        condition_id,
        tg_id,
        side,
        buy_price,
        size,
        remaining_size,
        entry_model_prob,
        entry_market_prob,
        entry_confidence,
        entry_spread,
        entry_regime,
        execution_status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'placing')
    `);
    return stmt.run(
      trade.market_id,
      trade.condition_id,
      trade.tg_id,
      trade.side,
      trade.buy_price,
      trade.size,
      trade.size,
      trade.entry_model_prob ?? null,
      trade.entry_market_prob ?? null,
      trade.entry_confidence ?? null,
      trade.entry_spread ?? null,
      trade.entry_regime ?? null
    );
  }

  markTradeSubmitted(tgId: string, marketId: string, orderId: string | null) {
    this.db.prepare(`
      UPDATE trades
      SET execution_status = 'submitted',
          order_id = ?
      WHERE tg_id = ?
        AND market_id = ?
    `).run(orderId, tgId, marketId);
  }

  releaseTradeReservation(tgId: string, marketId: string) {
    this.db.prepare(`
      DELETE FROM trades
      WHERE tg_id = ?
        AND market_id = ?
        AND execution_status = 'placing'
    `).run(tgId, marketId);
  }

  hasTraded(tgId: string, marketId: string) {
    const result = this.db.prepare(
      "SELECT id FROM trades WHERE tg_id = ? AND market_id = ? LIMIT 1"
    ).get(tgId, marketId);
    return !!result;
  }

  getUnsettledTrades(): Trade[] {
    return this.db.prepare(`
      SELECT * FROM trades
      WHERE settled = 0
        AND position_closed = 0
        AND COALESCE(remaining_size, size) > 0
    `).all() as Trade[];
  }

  getTradesForUser(tgId: string): Trade[] {
    return this.db.prepare("SELECT * FROM trades WHERE tg_id = ? ORDER BY timestamp DESC").all(tgId) as Trade[];
  }

  getUnsettledTradeCount(tgId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count
       FROM trades
       WHERE tg_id = ?
         AND settled = 0
         AND position_closed = 0
         AND COALESCE(remaining_size, size) > 0`
    ).get(tgId) as { count: number };
    return row?.count || 0;
  }

  getActiveTradesForMonitoring(): Trade[] {
    return this.db.prepare(`
      SELECT * FROM trades
      WHERE settled = 0
        AND position_closed = 0
        AND COALESCE(remaining_size, size) > 0
      ORDER BY timestamp ASC
    `).all() as Trade[];
  }

  recordTradeExit(tradeId: number, remainingSize: number, exitPrice: number | null, exitReason: string, fullyClosed: boolean) {
    this.db.prepare(`
      UPDATE trades
      SET remaining_size = ?,
          position_closed = ?,
          exit_price = ?,
          exit_reason = ?,
          exited_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(remainingSize, fullyClosed ? 1 : 0, exitPrice, exitReason, tradeId);
  }

  markSettled(tradeId: number, outcome: number, pnl: number) {
    this.db.prepare("UPDATE trades SET settled = 1, outcome = ?, pnl = ? WHERE id = ?")
      .run(outcome, pnl, tradeId);
  }

  getClaimableTrades(tgId: string): Trade[] {
    return this.db.prepare(
      "SELECT * FROM trades WHERE tg_id = ? AND settled = 1 AND outcome = 1 AND claimed = 0 ORDER BY timestamp ASC"
    ).all(tgId) as Trade[];
  }

  getClaimableTradesForMarket(tgId: string, marketId: string): Trade[] {
    return this.db.prepare(
      "SELECT * FROM trades WHERE tg_id = ? AND market_id = ? AND settled = 1 AND outcome = 1 AND claimed = 0 ORDER BY timestamp ASC"
    ).all(tgId, marketId) as Trade[];
  }

  markClaimedByCondition(tgId: string, conditionId: string, txHash: string | null) {
    this.db.prepare(`
      UPDATE trades
      SET claimed = 1,
          claim_tx = ?,
          claimed_at = CURRENT_TIMESTAMP
      WHERE tg_id = ?
        AND condition_id = ?
        AND settled = 1
        AND outcome = 1
        AND claimed = 0
    `).run(txHash, tgId, conditionId);
  }

  getDailyStats(tgId: string): { total: number; settled: number; wins: number; pnl: number } {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const trades = this.db.prepare(
      "SELECT * FROM trades WHERE tg_id = ? AND date(timestamp) = ?"
    ).all(tgId, today) as Trade[];

    const settled = trades.filter(t => t.settled === 1);
    const wins = settled.filter(t => t.outcome === 1);
    const pnl = settled.reduce((sum, t) => sum + (t.pnl || 0), 0);

    return {
      total: trades.length,
      settled: settled.length,
      wins: wins.length,
      pnl: pnl
    };
  }

  getOverallStats(tgId: string): { total: number; settled: number; wins: number; pnl: number; winRate: string } {
    const trades = this.db.prepare(
      "SELECT * FROM trades WHERE tg_id = ?"
    ).all(tgId) as Trade[];

    const settled = trades.filter(t => t.settled === 1);
    const wins = settled.filter(t => t.outcome === 1);
    const pnl = settled.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winRate = settled.length > 0 ? ((wins.length / settled.length) * 100).toFixed(1) : "0.0";

    return {
      total: trades.length,
      settled: settled.length,
      wins: wins.length,
      pnl: pnl,
      winRate: winRate
    };
  }

  getAllActiveUserIds(): string[] {
    const rows = this.db.prepare("SELECT tg_id FROM users WHERE trading_active = 1").all() as { tg_id: string }[];
    return rows.map(r => r.tg_id);
  }
}
