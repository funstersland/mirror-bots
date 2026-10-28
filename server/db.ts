import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candles (
  ts INTEGER PRIMARY KEY,      -- hour open, ms UTC
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
  v REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL,
  params TEXT NOT NULL,
  start_balance REAL NOT NULL,
  balance REAL NOT NULL,
  base_lot REAL NOT NULL,
  entry_price REAL NOT NULL,
  mg_enabled INTEGER NOT NULL DEFAULT 0,
  mg_multiplier REAL NOT NULL DEFAULT 2,
  mg_reset_after INTEGER NOT NULL DEFAULT 0,
  next_stake REAL NOT NULL,
  mg_loss_run INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',   -- running | paused | busted
  run_ms INTEGER NOT NULL DEFAULT 0,
  running_since INTEGER,
  last_hour INTEGER NOT NULL DEFAULT 0,     -- last hour (ms) the bot made a decision for
  backfill_days INTEGER NOT NULL DEFAULT 0,
  stats TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bots_user ON bots(user_id);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  hour_ts INTEGER NOT NULL,     -- market hour open, ms UTC
  side TEXT NOT NULL,           -- UP | DOWN
  stake REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  mg_step INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,         -- open | won | lost
  pnl REAL,
  balance_after REAL,
  backtest INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  UNIQUE(bot_id, hour_ts)
);
CREATE INDEX IF NOT EXISTS trades_hour ON trades(hour_ts);
`);

export function getMeta(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(key: string, value: string) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Use JWT_SECRET from env, or generate one once and keep it in the database. */
export function jwtSecret(): string {
  if (config.jwtSecret) return config.jwtSecret;
  let s = getMeta('jwt_secret');
  if (!s) {
    s = randomBytes(48).toString('hex');
    setMeta('jwt_secret', s);
  }
  return s;
}

// Columns added after the first release.
for (const sql of [
  'ALTER TABLE trades ADD COLUMN shares REAL',
  'ALTER TABLE trades ADD COLUMN slug TEXT',
  'ALTER TABLE trades ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE bots ADD COLUMN backfill_pending INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE bots ADD COLUMN timeframe TEXT NOT NULL DEFAULT '1h'",
  'ALTER TABLE bots ADD COLUMN mirror_of INTEGER REFERENCES bots(id) ON DELETE CASCADE',
]) {
  try {
    db.exec(sql);
  } catch {
    // already there
  }
}
