import type { Candle } from '../../shared/types.ts';
import { HOUR_MS } from '../../shared/types.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { candlesBefore, firstCandleTs, floorHour, getCandle, lastClosedTs, syncCandles } from '../market.ts';
import { WARMUP, decide } from '../strategies/index.ts';
import { MIN_STAKE, type MgState, computeStats, nextMg, outcomeOf, payoff, round2, stakeFor, takerFee } from './core.ts';

export interface BotRow {
  id: number;
  user_id: number;
  name: string;
  strategy: string;
  params: string;
  start_balance: number;
  balance: number;
  base_lot: number;
  entry_price: number;
  mg_enabled: number;
  mg_multiplier: number;
  mg_reset_after: number;
  next_stake: number;
  mg_loss_run: number;
  status: 'running' | 'paused' | 'busted';
  run_ms: number;
  running_since: number | null;
  last_hour: number;
  backfill_days: number;
  stats: string | null;
  created_at: number;
}

export interface TradeRow {
  id: number;
  bot_id: number;
  hour_ts: number;
  side: 'UP' | 'DOWN';
  stake: number;
  price: number;
  fee: number;
  mg_step: number;
  status: 'open' | 'won' | 'lost';
  pnl: number | null;
  balance_after: number | null;
  backtest: number;
  reason: string | null;
}

const q = {
  bot: db.prepare('SELECT * FROM bots WHERE id = ?'),
  runningBots: db.prepare("SELECT * FROM bots WHERE status = 'running'"),
  openTrades: db.prepare("SELECT * FROM trades WHERE status = 'open' ORDER BY hour_ts"),
  insertTrade: db.prepare(`INSERT OR IGNORE INTO trades (bot_id, hour_ts, side, stake, price, fee, mg_step, status, pnl, balance_after, backtest, reason)
    VALUES (@bot_id, @hour_ts, @side, @stake, @price, @fee, @mg_step, @status, @pnl, @balance_after, @backtest, @reason)`),
  settleTrade: db.prepare('UPDATE trades SET status = ?, pnl = ?, balance_after = ? WHERE id = ?'),
  saveBot: db.prepare(`UPDATE bots SET balance = @balance, next_stake = @next_stake, mg_loss_run = @mg_loss_run, status = @status,
    run_ms = @run_ms, running_since = @running_since, last_hour = @last_hour WHERE id = @id`),
  tradesForStats: db.prepare('SELECT status, pnl, balance_after, stake, hour_ts FROM trades WHERE bot_id = ? ORDER BY hour_ts'),
  saveStats: db.prepare('UPDATE bots SET stats = ? WHERE id = ?'),
};

const mgOf = (b: BotRow): MgState => ({
  baseLot: b.base_lot,
  nextStake: b.next_stake,
  lossRun: b.mg_loss_run,
  enabled: !!b.mg_enabled,
  multiplier: b.mg_multiplier,
  resetAfter: b.mg_reset_after,
});

function stopRunning(b: BotRow, status: BotRow['status'], now: number) {
  if (b.status === 'running' && b.running_since) b.run_ms += Math.max(0, now - b.running_since);
  b.running_since = null;
  b.status = status;
}

/** Decide and place a trade for `hourTs`. Returns the inserted trade or null if the bot skipped. */
function placeTrade(b: BotRow, hourTs: number, backtest: boolean): TradeRow | null {
  const history = candlesBefore(hourTs, WARMUP);
  if (history.length < WARMUP / 2) return null;
  const sig = decide(b.strategy, history, JSON.parse(b.params));
  if (!sig) return null;
  const mg = mgOf(b);
  if (b.balance < MIN_STAKE) return null;
  const stake = Math.max(MIN_STAKE, stakeFor(mg, b.balance));
  const fee = takerFee(stake, b.entry_price, config.takerFeeRate);
  const trade = {
    bot_id: b.id,
    hour_ts: hourTs,
    side: sig.side,
    stake,
    price: b.entry_price,
    fee,
    mg_step: mg.enabled ? mg.lossRun : 0,
    status: 'open' as const,
    pnl: null,
    balance_after: null,
    backtest: backtest ? 1 : 0,
    reason: sig.reason,
  };
  const res = q.insertTrade.run(trade);
  if (!res.changes) return null;
  return { id: Number(res.lastInsertRowid), ...trade };
}

function settle(b: BotRow, t: TradeRow, candle: Candle, now: number) {
  const won = outcomeOf(candle) === t.side;
  const pnl = payoff(t.stake, t.price, t.fee, won);
  b.balance = round2(b.balance + pnl);
  const mg = nextMg(mgOf(b), t.stake, won);
  b.next_stake = mg.nextStake;
  b.mg_loss_run = mg.lossRun;
  q.settleTrade.run(won ? 'won' : 'lost', pnl, b.balance, t.id);
  if (b.balance < MIN_STAKE && b.status !== 'busted') stopRunning(b, 'busted', now);
}

export function refreshStats(botId: number) {
  const b = q.bot.get(botId) as BotRow | undefined;
  if (!b) return;
  const rows = q.tradesForStats.all(botId) as Parameters<typeof computeStats>[0];
  q.saveStats.run(JSON.stringify(computeStats(rows, b.start_balance)), botId);
}

/** Replays `days` of closed hours for a freshly created or reset bot. */
export const backfill = db.transaction((botId: number, days: number) => {
  const b = q.bot.get(botId) as BotRow;
  const last = lastClosedTs();
  const first = firstCandleTs();
  const now = Date.now();
  if (days > 0 && last !== null && first !== null) {
    const earliest = first + WARMUP * HOUR_MS;
    let h = Math.max(earliest, floorHour(now) - days * 24 * HOUR_MS);
    for (; h <= last; h += HOUR_MS) {
      if (b.balance < MIN_STAKE) break;
      const candle = getCandle(h);
      if (!candle) continue;
      const t = placeTrade(b, h, true);
      if (t) settle(b, t, candle, now);
      b.last_hour = h;
    }
  }
  q.saveBot.run(b);
  refreshStats(botId);
});

let ticking = false;

/** One engine pass: refresh candles, settle finished hours, enter the current hour. */
export async function tick(now = Date.now()) {
  if (ticking) return;
  ticking = true;
  try {
    await syncCandles();
    const touched = new Set<number>();

    // Settle every open trade whose hour has closed.
    for (const t of q.openTrades.all() as TradeRow[]) {
      const candle = getCandle(t.hour_ts);
      if (!candle) continue;
      db.transaction(() => {
        const b = q.bot.get(t.bot_id) as BotRow;
        settle(b, t, candle, now);
        q.saveBot.run(b);
      })();
      touched.add(t.bot_id);
    }

    // Enter the current hour, only in its first minutes so the bot can't peek at the candle.
    const hour = floorHour(now);
    const feedReady = lastClosedTs() === hour - HOUR_MS;
    const inWindow = now - hour <= config.entryWindowMs;
    for (const b of q.runningBots.all() as BotRow[]) {
      if (b.last_hour >= hour) continue;
      if (inWindow && !feedReady) continue; // wait for the previous candle to land
      db.transaction(() => {
        if (inWindow) placeTrade(b, hour, false);
        b.last_hour = hour;
        q.saveBot.run(b);
      })();
      touched.add(b.id);
    }

    for (const id of touched) refreshStats(id);
  } finally {
    ticking = false;
  }
}

export function startEngine() {
  const run = () => tick().catch((e) => console.error('[engine]', e));
  run();
  return setInterval(run, config.tickMs);
}

export { stopRunning };
