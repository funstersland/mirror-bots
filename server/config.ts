import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  dbPath: resolve(env.DB_PATH ?? './data/polybots.db'),
  jwtSecret: env.JWT_SECRET ?? '',
  dataSource: (env.DATA_SOURCE ?? 'binance') as 'binance' | 'sim',
  takerFeeRate: Number(env.TAKER_FEE_RATE ?? 0),
  allowSignup: (env.ALLOW_SIGNUP ?? 'true') !== 'false',
  production: env.NODE_ENV === 'production',
  /** How long after the hour opens a bot may still enter (ms). Later than this the hour is skipped. */
  entryWindowMs: Number(env.ENTRY_WINDOW_SEC ?? 120) * 1000,
  /** Days of candle history kept for backtests (plus indicator warm-up). */
  historyDays: Number(env.HISTORY_DAYS ?? 400),
  tickMs: Number(env.TICK_SEC ?? 15) * 1000,
};

mkdirSync(dirname(config.dbPath), { recursive: true });
