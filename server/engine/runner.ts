import type { Side, Timeframe } from '../../shared/types.ts';
import { TF_MS, TIMEFRAMES } from '../../shared/types.ts';
import { config } from '../config.ts';
import { db, getMeta, setMeta } from '../db.ts';
import { candlesBefore, firstCandleTs, floorTo, getCandle, syncCandles } from '../market.ts';
import { type PmMarket, cachedMarket, fillFromAsks, getAsks, getMarket, historyReady, syncHistory, takerFee } from '../polymarket.ts';
import { WARMUP, decide } from '../strategies/index.ts';
import { MIN_STAKE, type MgState, computeStats, nextMg, outcomeOf, payoff, round4, stakeFor } from './core.ts';

export interface BotRow {
  id: number;
  user_id: number;
  name: string;
  strategy: string;
  timeframe: Timeframe;
  params: string;
  start_balance: number;
  balance: number;
  base_lot: number;
  entry_price: number; // highest price per share the bot will pay
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
  backfill_pending: number;
  stats: string | null;
  created_at: number;
}

export interface TradeRow {
  id: number;
  bot_id: number;
  hour_ts: number;
  side: Side;
  stake: number;
  price: number;
  shares: number | null;
  fee: number;
  mg_step: number;
  status: 'open' | 'won' | 'lost';
  pnl: number | null;
  balance_after: number | null;
  backtest: number;
  confirmed: number;
  slug: string | null;
  reason: string | null;
}

const log = (...a: unknown[]) => console.log('[engine]', ...a);

const q = {
  bot: db.prepare('SELECT * FROM bots WHERE id = ?'),
  runningBots: db.prepare("SELECT * FROM bots WHERE status = 'running' AND backfill_pending = 0"),
  pendingBackfills: db.prepare('SELECT id, backfill_days, timeframe FROM bots WHERE backfill_pending = 1'),
  openFor: db.prepare("SELECT 1 FROM trades WHERE bot_id = ? AND status = 'open' LIMIT 1"),
  openTrades: db.prepare(`SELECT t.*, b.timeframe AS tf FROM trades t JOIN bots b ON b.id = t.bot_id
    WHERE t.status = 'open' ORDER BY t.hour_ts`),
  unconfirmed: db.prepare(`SELECT t.*, b.timeframe AS tf FROM trades t JOIN bots b ON b.id = t.bot_id
    WHERE t.status != 'open' AND t.confirmed = 0 ORDER BY t.hour_ts`),
  insertTrade: db.prepare(`INSERT OR IGNORE INTO trades (bot_id, hour_ts, side, stake, price, shares, fee, mg_step, status, pnl,
      balance_after, backtest, confirmed, slug, reason)
    VALUES (@bot_id, @hour_ts, @side, @stake, @price, @shares, @fee, @mg_step, @status, @pnl, @balance_after, @backtest,
      @confirmed, @slug, @reason)`),
  settleTrade: db.prepare('UPDATE trades SET status = ?, pnl = ?, balance_after = ?, confirmed = ? WHERE id = ?'),
  confirm: db.prepare('UPDATE trades SET confirmed = 1 WHERE id = ?'),
  saveBot: db.prepare(`UPDATE bots SET balance = @balance, next_stake = @next_stake, mg_loss_run = @mg_loss_run, status = @status,
    run_ms = @run_ms, running_since = @running_since, last_hour = @last_hour, backfill_pending = @backfill_pending WHERE id = @id`),
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

export function stopRunning(b: BotRow, status: BotRow['status'], now: number) {
  if (b.status === 'running' && b.running_since) b.run_ms += Math.max(0, now - b.running_since);
  b.running_since = null;
  b.status = status;
}

/** How long after a window opens a bot may still enter. */
const ENTRY_WINDOW: Record<Timeframe, number> = { '1h': 120_000, '15m': 90_000, '5m': 60_000 };

function signalFor(b: BotRow, hourTs: number) {
  const history = candlesBefore(b.timeframe, hourTs, WARMUP);
  if (history.length < WARMUP / 2) return null;
  return decide(b.strategy, history, JSON.parse(b.params));
}

function settle(b: BotRow, t: TradeRow, outcome: Side, confirmed: boolean, now: number) {
  const won = outcome === t.side;
  const pnl = payoff(t.shares ?? 0, t.stake, t.fee, won);
  b.balance = round4(b.balance + pnl);
  const mg = nextMg(mgOf(b), t.stake, won);
  b.next_stake = mg.nextStake;
  b.mg_loss_run = mg.lossRun;
  q.settleTrade.run(won ? 'won' : 'lost', pnl, b.balance, confirmed ? 1 : 0, t.id);
  if (b.balance < MIN_STAKE && b.status !== 'busted') stopRunning(b, 'busted', now);
}

export function refreshStats(botId: number) {
  const b = q.bot.get(botId) as BotRow | undefined;
  if (!b) return;
  const rows = q.tradesForStats.all(botId) as Parameters<typeof computeStats>[0];
  q.saveStats.run(JSON.stringify(computeStats(rows, b.start_balance)), botId);
}

/**
 * Replays past hours with Polymarket's real data: the token's traded price at the hour's open
 * (minute price history) and the market's actual result. Hours without that data are skipped.
 */
const runBackfill = db.transaction((botId: number, days: number) => {
  const b = q.bot.get(botId) as BotRow;
  const now = Date.now();
  const tf = b.timeframe;
  const step = TF_MS[tf];
  const first = firstCandleTs(tf);
  const until = Math.min(floorTo(b.created_at, tf), floorTo(now, tf));
  if (days > 0 && first !== null) {
    let h = Math.max(first + WARMUP * step, until - days * 86400_000);
    for (; h < until; h += step) {
      if (b.balance < MIN_STAKE) break;
      const m = cachedMarket(tf, h);
      if (!m?.outcome) continue;
      const sig = signalFor(b, h);
      if (!sig) continue;
      const price = sig.side === 'UP' ? m.openUp : m.openDown;
      if (price === null || price <= 0 || price >= 1 || price > b.entry_price) continue;
      const stake = stakeFor(mgOf(b), b.balance);
      const shares = Math.floor((stake / price) * 100) / 100;
      if (shares < m.minSize || stake < MIN_STAKE) continue;
      const cost = round4(shares * price);
      const fee = takerFee(shares, price, m.feeRate);
      const t = {
        bot_id: b.id, hour_ts: h, side: sig.side, stake: cost, price, shares, fee, mg_step: b.mg_enabled ? b.mg_loss_run : 0,
        status: 'open' as const, pnl: null, balance_after: null, backtest: 1, confirmed: 1, slug: m.slug, reason: sig.reason,
      };
      const res = q.insertTrade.run(t);
      if (res.changes) settle(b, { id: Number(res.lastInsertRowid), ...t }, m.outcome, true, now);
    }
  }
  b.backfill_pending = 0;
  b.last_hour = Math.max(b.last_hour, floorTo(now, b.timeframe));
  q.saveBot.run(b);
  refreshStats(botId);
});

/** Queues a replay; it runs once the shared Polymarket history is downloaded. */
export function backfill(botId: number, days: number) {
  const b = q.bot.get(botId) as BotRow;
  days = Math.min(days, config.replayDays[b.timeframe]);
  db.prepare('UPDATE bots SET backfill_pending = ?, backfill_days = ? WHERE id = ?').run(days > 0 ? 1 : 0, days, botId);
  if (days <= 0) {
    db.prepare('UPDATE bots SET last_hour = ? WHERE id = ?').run(floorTo(Date.now(), b.timeframe), botId);
    refreshStats(botId);
  }
}

/** Live entry: buys the chosen side at the current Polymarket order book, like a market order. */
async function enterLive(b: BotRow, hour: number, markets: Map<string, Promise<PmMarket | null>>) {
  const sig = signalFor(b, hour);
  if (!sig) return;
  const key = `${b.timeframe}:${hour}`;
  if (!markets.has(key)) markets.set(key, getMarket(b.timeframe, hour, true));
  const m = await markets.get(key)!;
  if (!m || !m.accepting) {
    log(`${b.name}: no open Polymarket market for ${new Date(hour).toISOString()}`);
    return;
  }
  const token = sig.side === 'UP' ? m.upToken : m.downToken;
  const asks = await getAsks(token);
  let stake = stakeFor(mgOf(b), b.balance);
  let fill = fillFromAsks(asks, stake, m.feeRate);
  if (fill && fill.cost + fill.fee > b.balance) {
    stake = Math.max(0, b.balance - fill.fee);
    fill = fillFromAsks(asks, stake, m.feeRate);
  }
  if (!fill || stake < MIN_STAKE) return log(`${b.name}: empty order book for ${sig.side}`);
  if (fill.avgPrice > b.entry_price) return log(`${b.name}: ${sig.side} costs ${fill.avgPrice.toFixed(3)}, above max ${b.entry_price}`);
  if (fill.shares < m.minSize) return log(`${b.name}: ${fill.shares} shares is below the ${m.minSize}-share minimum`);
  q.insertTrade.run({
    bot_id: b.id,
    hour_ts: hour,
    side: sig.side,
    stake: fill.cost,
    price: round4(fill.avgPrice),
    shares: fill.shares,
    fee: fill.fee,
    mg_step: b.mg_enabled ? b.mg_loss_run : 0,
    status: 'open',
    pnl: null,
    balance_after: null,
    backtest: 0,
    confirmed: 0,
    slug: m.slug,
    reason: sig.reason,
  });
  log(`${b.name}: ${sig.side} ${fill.shares} sh @ ${fill.avgPrice.toFixed(3)} (ask ${fill.bestAsk}) fee ${fill.fee} ${m.slug}`);
}

const lastCheck = new Map<number, number>();

/** Checks provisional results against Polymarket's resolution and corrects any mismatch. */
async function confirmResults(now: number, touched: Set<number>) {
  const rows = (q.unconfirmed.all() as (TradeRow & { tf: Timeframe })[]).filter((t) => t.tf === '1h');
  const hours = [...new Set(rows.map((t) => t.hour_ts))].filter((h) => now - (lastCheck.get(h) ?? 0) > 60_000).slice(0, 6);
  for (const h of hours) {
    lastCheck.set(h, now);
    const m = await getMarket('1h', h, true).catch(() => null);
    if (!m?.outcome) continue;
    for (const t of rows.filter((r) => r.hour_ts === h)) {
      db.transaction(() => {
        const wonByBinance = t.status === 'won';
        const wonByPolymarket = m.outcome === t.side;
        if (wonByBinance !== wonByPolymarket) {
          const b = q.bot.get(t.bot_id) as BotRow;
          const pnl = payoff(t.shares ?? 0, t.stake, t.fee, wonByPolymarket);
          b.balance = round4(b.balance + pnl - (t.pnl ?? 0));
          q.settleTrade.run(wonByPolymarket ? 'won' : 'lost', pnl, t.balance_after! + pnl - (t.pnl ?? 0), 1, t.id);
          q.saveBot.run(b);
          log(`corrected trade ${t.id} to Polymarket result ${m.outcome}`);
        } else q.confirm.run(t.id);
      })();
      touched.add(t.bot_id);
    }
  }
}

let ticking = false;
let lastHistorySync = 0;

export async function tick(now = Date.now()) {
  if (ticking) return;
  ticking = true;
  try {
    await syncCandles();
    const touched = new Set<number>();

    // 1. Settle finished windows. 1h markets resolve on the Binance 1h candle, so its close settles the
    //    trade right away (checked against Polymarket later). 5m/15m resolve on Chainlink: wait for Polymarket.
    const resolved = new Map<string, Promise<PmMarket | null>>();
    for (const t of q.openTrades.all() as (TradeRow & { tf: Timeframe })[]) {
      if (now < t.hour_ts + TF_MS[t.tf]) continue;
      let outcome: Side | null = null;
      let confirmed = false;
      if (t.tf === '1h') {
        const candle = getCandle('1h', t.hour_ts);
        if (candle) outcome = outcomeOf(candle);
      } else {
        const key = `${t.tf}:${t.hour_ts}`;
        if (!resolved.has(key)) resolved.set(key, getMarket(t.tf, t.hour_ts, true).catch(() => null));
        outcome = (await resolved.get(key))?.outcome ?? null;
        confirmed = true;
      }
      if (!outcome) continue;
      db.transaction(() => {
        const b = q.bot.get(t.bot_id) as BotRow;
        settle(b, t, outcome!, confirmed, now);
        q.saveBot.run(b);
      })();
      touched.add(t.bot_id);
    }

    // 2. Enter the current window in its first moments, once the previous candle has closed.
    //    Martingale bots wait for their last trade to settle so the next stake is right.
    const markets = new Map<string, Promise<PmMarket | null>>();
    for (const b of q.runningBots.all() as BotRow[]) {
      const tf = b.timeframe;
      const win = floorTo(now, tf);
      if (b.last_hour >= win) continue;
      const inWindow = now - win <= ENTRY_WINDOW[tf];
      const ready = !!getCandle(tf, win - TF_MS[tf]) && !(b.mg_enabled && q.openFor.get(b.id));
      if (inWindow && !ready) continue;
      if (inWindow) {
        try {
          await enterLive(q.bot.get(b.id) as BotRow, win, markets);
        } catch (e) {
          log(`${b.name}: entry failed: ${(e as Error).message}`);
        }
      }
      db.prepare('UPDATE bots SET last_hour = ? WHERE id = ?').run(win, b.id);
      touched.add(b.id);
    }

    // 3. Match 1h results with Polymarket once it resolves.
    await confirmResults(now, touched);

    // 4. Keep replay data current and run queued replays.
    const pending = q.pendingBackfills.all() as { id: number; backfill_days: number; timeframe: Timeframe }[];
    if (now - lastHistorySync > 30 * 60_000) {
      lastHistorySync = now;
      (async () => {
        for (const tf of TIMEFRAMES) await syncHistory(tf, config.replayDays[tf]);
      })().catch((e) => log('history sync failed', e));
    }
    for (const p of pending) {
      if (!historyReady(p.timeframe)) continue;
      runBackfill(p.id, Math.min(p.backfill_days, config.replayDays[p.timeframe]));
      log(`replayed bot ${p.id} (${p.timeframe}) over ${p.backfill_days} days`);
    }

    for (const id of touched) refreshStats(id);
  } finally {
    ticking = false;
  }
}

/** One-time reset of trades priced before real Polymarket prices were used. */
export function migratePricing() {
  if (getMeta('pricing') === 'polymarket-v1') return;
  const now = Date.now();
  db.transaction(() => {
    db.prepare('DELETE FROM trades').run();
    db.prepare(`UPDATE bots SET balance = start_balance, next_stake = base_lot, mg_loss_run = 0, status = 'running', run_ms = 0,
      running_since = ?, last_hour = 0, stats = NULL, entry_price = 0.6,
      backfill_days = MIN(backfill_days, ?), backfill_pending = CASE WHEN backfill_days > 0 THEN 1 ELSE 0 END`).run(now, config.replayDays['1h']);
  })();
  setMeta('pricing', 'polymarket-v1');
  log('reset all bots for real Polymarket pricing');
}

export function startEngine() {
  const run = () => tick().catch((e) => console.error('[engine]', e));
  run();
  return setInterval(run, config.tickMs);
}

/** One-time: gives every existing 1h bot a 15m and a 5m twin with the same settings. */
export function addTimeframeTwins() {
  if (getMeta('tf-twins') === 'v1') return;
  const now = Date.now();
  for (const tf of ['15m', '5m'] as const) {
    db.prepare(`INSERT INTO bots (user_id, name, strategy, timeframe, params, start_balance, balance, base_lot, entry_price,
        mg_enabled, mg_multiplier, mg_reset_after, next_stake, status, running_since, last_hour, backfill_days, backfill_pending, created_at)
      SELECT user_id, name, strategy, ?, params, start_balance, start_balance, base_lot, entry_price,
        mg_enabled, mg_multiplier, mg_reset_after, base_lot, 'running', ?, 0, ?, 1, ?
      FROM bots b WHERE timeframe = '1h'
        AND NOT EXISTS (SELECT 1 FROM bots o WHERE o.user_id = b.user_id AND o.timeframe = ?)`).run(tf, now, config.replayDays[tf], now, tf);
  }
  setMeta('tf-twins', 'v1');
  log('added 15m and 5m twins of existing bots');
}
