import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Bot, BotStats, DayBucket, HourBucket, Trade } from '../shared/types.ts';
import { PKT_OFFSET_MS } from '../shared/types.ts';
import { requireUser } from './auth.ts';
import { db } from './db.ts';
import { type BotRow, type TradeRow, backfill, refreshStats, stopRunning } from './engine/runner.ts';
import { feedStatus, floorTo } from './market.ts';
import { eventUrl, historyStatus } from './polymarket.ts';
import { getStrategy, listStrategies, normalizeParams } from './strategies/index.ts';

const mgSchema = z.object({
  enabled: z.boolean(),
  multiplier: z.number().min(1.1).max(5),
  resetAfter: z.number().int().min(0).max(20),
});

const tfSchema = z.enum(['1h', '15m', '5m']);

const botInput = z.object({
  name: z.string().trim().min(1).max(40),
  strategy: z.string(),
  timeframe: tfSchema.default('1h'),
  params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).default({}),
  startBalance: z.number().min(5).max(1_000_000),
  baseLot: z.number().min(1).max(100_000),
  maxEntryPrice: z.number().min(0.05).max(0.95),
  martingale: mgSchema,
  backfillDays: z.number().int().min(0).max(30),
});

const botPatch = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
  baseLot: z.number().min(1).max(100_000).optional(),
  maxEntryPrice: z.number().min(0.05).max(0.95).optional(),
  martingale: mgSchema.optional(),
});

const emptyStats: BotStats = {
  trades: 0, wins: 0, losses: 0, open: 0, winRate: 0, realized: 0, grossWin: 0, grossLoss: 0,
  maxDrawdown: 0, maxDrawdownPct: 0, peakBalance: 0, current: { kind: null, len: 0 }, bestWin: 0,
  worstLoss: 0, winHits: [], lossHits: [], largestStake: 0, equity: [], firstHour: null, lastHour: null,
};

export function tradeToApi(t: TradeRow): Trade {
  return {
    id: t.id, botId: t.bot_id, hourTs: t.hour_ts, side: t.side, stake: t.stake, price: t.price, fee: t.fee,
    mgStep: t.mg_step, status: t.status, pnl: t.pnl, balanceAfter: t.balance_after, backtest: !!t.backtest, reason: t.reason,
    shares: t.shares, confirmed: !!t.confirmed, url: t.slug ? eventUrl(t.slug) : null,
  };
}

function botToApi(b: BotRow, open: TradeRow | undefined): Bot {
  const now = Date.now();
  return {
    id: b.id,
    name: b.name,
    strategy: b.strategy,
    timeframe: b.timeframe,
    params: JSON.parse(b.params),
    startBalance: b.start_balance,
    balance: b.balance,
    baseLot: b.base_lot,
    maxEntryPrice: b.entry_price,
    backfillPending: !!b.backfill_pending,
    martingale: { enabled: !!b.mg_enabled, multiplier: b.mg_multiplier, resetAfter: b.mg_reset_after },
    nextStake: b.mg_enabled ? b.next_stake : b.base_lot,
    mgLossRun: b.mg_loss_run,
    status: b.status,
    runMs: b.run_ms + (b.status === 'running' && b.running_since ? now - b.running_since : 0),
    createdAt: b.created_at,
    backfillDays: b.backfill_days,
    stats: b.stats ? JSON.parse(b.stats) : { ...emptyStats, peakBalance: b.start_balance },
    openTrade: open ? tradeToApi(open) : null,
  };
}

function ownedBot(userId: number, id: number) {
  return db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(id, userId) as BotRow | undefined;
}

function createBot(userId: number, input: z.infer<typeof botInput>) {
  const params = normalizeParams(input.strategy, input.params);
  const now = Date.now();
  const res = db.prepare(`INSERT INTO bots (user_id, name, strategy, timeframe, params, start_balance, balance, base_lot, entry_price,
      mg_enabled, mg_multiplier, mg_reset_after, next_stake, status, running_since, last_hour, backfill_days, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 0, ?, ?)`).run(
    userId, input.name, input.strategy, input.timeframe, JSON.stringify(params), input.startBalance, input.startBalance, input.baseLot,
    input.maxEntryPrice, input.martingale.enabled ? 1 : 0, input.martingale.multiplier, input.martingale.resetAfter,
    input.baseLot, now, input.backfillDays, now,
  );
  const id = Number(res.lastInsertRowid);
  backfill(id, input.backfillDays);
  return id;
}

const parseIds = (s: unknown) =>
  String(s ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

const tfParam = (v: unknown) => (tfSchema.safeParse(v).success ? String(v) : '');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PKT_DATE = `date((t.hour_ts + ${PKT_OFFSET_MS}) / 1000, 'unixepoch')`;

export function apiRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true }));

  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/feed', async () => ({ ...feedStatus(), history: historyStatus() }));

    r.get('/api/strategies', async () => listStrategies());

    r.get('/api/bots', async (req) => {
      const bots = db.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(req.userId) as BotRow[];
      const open = db
        .prepare("SELECT t.* FROM trades t JOIN bots b ON b.id = t.bot_id WHERE b.user_id = ? AND t.status = 'open'")
        .all(req.userId) as TradeRow[];
      const byBot = new Map(open.map((t) => [t.bot_id, t]));
      return bots.map((b) => botToApi(b, byBot.get(b.id)));
    });

    r.post('/api/bots', async (req, reply) => {
      const parsed = botInput.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid bot' });
      if (!getStrategy(parsed.data.strategy)) return reply.code(400).send({ error: 'Unknown strategy' });
      const id = createBot(req.userId, parsed.data);
      return botToApi(ownedBot(req.userId, id)!, undefined);
    });

    /** One bot per strategy with default settings: a quick way to see which rules work. */
    r.post('/api/bots/starter-fleet', async (req) => {
      const body = (req.body ?? {}) as { backfillDays?: number; startBalance?: number; baseLot?: number; timeframes?: string[] };
      const tfs = (body.timeframes ?? ['1h', '15m', '5m']).filter((t) => tfSchema.safeParse(t).success) as ('1h' | '15m' | '5m')[];
      const days = Math.min(30, Math.max(0, Math.round(Number(body.backfillDays ?? 30))));
      const start = Number(body.startBalance ?? 100);
      const lot = Number(body.baseLot ?? 5);
      const ids: number[] = [];
      for (const tf of tfs) for (const s of listStrategies()) {
        ids.push(
          createBot(req.userId, {
            name: s.name,
            strategy: s.id,
            timeframe: tf,
            params: {},
            startBalance: start,
            baseLot: lot,
            maxEntryPrice: 0.6,
            martingale: { enabled: false, multiplier: 2, resetAfter: 4 },
            backfillDays: days,
          }),
        );
      }
      return { created: ids.length };
    });

    r.patch<{ Params: { id: string } }>('/api/bots/:id', async (req, reply) => {
      const b = ownedBot(req.userId, Number(req.params.id));
      if (!b) return reply.code(404).send({ error: 'Bot not found' });
      const parsed = botPatch.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' });
      const p = parsed.data;
      const mg = p.martingale ?? { enabled: !!b.mg_enabled, multiplier: b.mg_multiplier, resetAfter: b.mg_reset_after };
      const lot = p.baseLot ?? b.base_lot;
      // A new lot or switching martingale off restarts the progression from the base lot.
      const restart = lot !== b.base_lot || !mg.enabled || !b.mg_enabled;
      db.prepare(`UPDATE bots SET name = ?, params = ?, base_lot = ?, entry_price = ?, mg_enabled = ?, mg_multiplier = ?,
          mg_reset_after = ?, next_stake = ?, mg_loss_run = ? WHERE id = ?`).run(
        p.name ?? b.name,
        p.params ? JSON.stringify(normalizeParams(b.strategy, p.params)) : b.params,
        lot,
        p.maxEntryPrice ?? b.entry_price,
        mg.enabled ? 1 : 0,
        mg.multiplier,
        mg.resetAfter,
        restart ? lot : b.next_stake,
        restart ? 0 : b.mg_loss_run,
        b.id,
      );
      return botToApi(ownedBot(req.userId, b.id)!, undefined);
    });

    r.post<{ Params: { id: string; action: string } }>('/api/bots/:id/:action', async (req, reply) => {
      const b = ownedBot(req.userId, Number(req.params.id));
      if (!b) return reply.code(404).send({ error: 'Bot not found' });
      const now = Date.now();
      switch (req.params.action) {
        case 'pause':
          if (b.status === 'running') {
            stopRunning(b, 'paused', now);
            db.prepare('UPDATE bots SET status = ?, run_ms = ?, running_since = NULL WHERE id = ?').run(b.status, b.run_ms, b.id);
          }
          break;
        case 'resume':
          if (b.status === 'busted') return reply.code(409).send({ error: 'Balance is below the minimum stake. Reset the bot first.' });
          if (b.status === 'paused') {
            // Don't trade the hour that is already under way.
            db.prepare("UPDATE bots SET status = 'running', running_since = ?, last_hour = ? WHERE id = ?").run(now, floorTo(now, b.timeframe), b.id);
          }
          break;
        case 'reset': {
          const body = (req.body ?? {}) as { backfillDays?: number; startBalance?: number };
          const days = Math.min(30, Math.max(0, Math.round(Number(body.backfillDays ?? b.backfill_days))));
          const start = Number(body.startBalance ?? b.start_balance);
          if (!(start >= 5)) return reply.code(400).send({ error: 'Start balance must be at least $5' });
          db.transaction(() => {
            db.prepare('DELETE FROM trades WHERE bot_id = ?').run(b.id);
            db.prepare(`UPDATE bots SET balance = ?, start_balance = ?, next_stake = base_lot, mg_loss_run = 0, status = 'running',
                run_ms = 0, running_since = ?, last_hour = 0, backfill_days = ?, stats = NULL WHERE id = ?`).run(start, start, now, days, b.id);
          })();
          backfill(b.id, days);
          break;
        }
        case 'clone': {
          const id = createBot(req.userId, {
            name: `${b.name} copy`.slice(0, 40),
            strategy: b.strategy,
            timeframe: b.timeframe,
            params: JSON.parse(b.params),
            startBalance: b.start_balance,
            baseLot: b.base_lot,
            maxEntryPrice: b.entry_price,
            martingale: { enabled: !!b.mg_enabled, multiplier: b.mg_multiplier, resetAfter: b.mg_reset_after },
            backfillDays: b.backfill_days,
          });
          return botToApi(ownedBot(req.userId, id)!, undefined);
        }
        default:
          return reply.code(404).send({ error: 'Unknown action' });
      }
      refreshStats(b.id);
      return botToApi(ownedBot(req.userId, b.id)!, undefined);
    });

    r.delete<{ Params: { id: string } }>('/api/bots/:id', async (req, reply) => {
      const b = ownedBot(req.userId, Number(req.params.id));
      if (!b) return reply.code(404).send({ error: 'Bot not found' });
      db.prepare('DELETE FROM bots WHERE id = ?').run(b.id);
      return { ok: true };
    });

    r.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>('/api/bots/:id/trades', async (req, reply) => {
      const b = ownedBot(req.userId, Number(req.params.id));
      if (!b) return reply.code(404).send({ error: 'Bot not found' });
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
      const before = Number(req.query.before ?? Number.MAX_SAFE_INTEGER);
      const rows = db
        .prepare('SELECT * FROM trades WHERE bot_id = ? AND hour_ts < ? ORDER BY hour_ts DESC LIMIT ?')
        .all(b.id, before, limit) as TradeRow[];
      return rows.map(tradeToApi);
    });

    /** Net PnL per PKT hour of day, summed over the chosen PKT dates. */
    r.get<{ Querystring: { dates?: string; bots?: string; live?: string; tf?: string } }>('/api/calendar/hourly', async (req) => {
      const dates = String(req.query.dates ?? '').split(',').filter((d) => DATE_RE.test(d));
      const bots = parseIds(req.query.bots);
      const rows = db
        .prepare(`SELECT CAST(((t.hour_ts + ${PKT_OFFSET_MS}) / 3600000) % 24 AS INTEGER) AS hour,
            SUM(t.pnl) AS net,
            SUM(CASE WHEN t.pnl > 0 THEN t.pnl ELSE 0 END) AS gain,
            SUM(CASE WHEN t.pnl < 0 THEN t.pnl ELSE 0 END) AS loss,
            SUM(t.status = 'won') AS wins, SUM(t.status = 'lost') AS losses, COUNT(*) AS trades
          FROM trades t JOIN bots b ON b.id = t.bot_id
          WHERE b.user_id = ? AND t.status != 'open'
            AND ${PKT_DATE} IN (SELECT value FROM json_each(?))
            AND (? = 0 OR t.bot_id IN (SELECT value FROM json_each(?)))
            AND (? = 0 OR t.backtest = 0)
            AND (? = '' OR b.timeframe = ?)
          GROUP BY hour`)
        .all(req.userId, JSON.stringify(dates), bots.length, JSON.stringify(bots), req.query.live === '1' ? 1 : 0, tfParam(req.query.tf), tfParam(req.query.tf)) as HourBucket[];
      const byHour = new Map(rows.map((r) => [r.hour, r]));
      const hours: HourBucket[] = Array.from({ length: 24 }, (_, hour) => {
        const r = byHour.get(hour);
        return r
          ? { hour, net: +r.net.toFixed(2), gain: +r.gain.toFixed(2), loss: +r.loss.toFixed(2), wins: r.wins, losses: r.losses, trades: r.trades }
          : { hour, net: 0, gain: 0, loss: 0, wins: 0, losses: 0, trades: 0 };
      });
      return { dates, hours };
    });

    /** Net PnL per PKT date, for colouring the calendar. */
    r.get<{ Querystring: { from?: string; to?: string; bots?: string; live?: string; tf?: string } }>('/api/calendar/days', async (req) => {
      const from = DATE_RE.test(req.query.from ?? '') ? req.query.from : '1970-01-01';
      const to = DATE_RE.test(req.query.to ?? '') ? req.query.to : '2999-12-31';
      const bots = parseIds(req.query.bots);
      const rows = db
        .prepare(`SELECT ${PKT_DATE} AS date, SUM(t.pnl) AS net, COUNT(*) AS trades
          FROM trades t JOIN bots b ON b.id = t.bot_id
          WHERE b.user_id = ? AND t.status != 'open' AND ${PKT_DATE} BETWEEN ? AND ?
            AND (? = 0 OR t.bot_id IN (SELECT value FROM json_each(?)))
            AND (? = 0 OR t.backtest = 0)
            AND (? = '' OR b.timeframe = ?)
          GROUP BY date ORDER BY date`)
        .all(req.userId, from, to, bots.length, JSON.stringify(bots), req.query.live === '1' ? 1 : 0, tfParam(req.query.tf), tfParam(req.query.tf)) as DayBucket[];
      return rows.map((r) => ({ ...r, net: +r.net.toFixed(2) }));
    });
  });
}
