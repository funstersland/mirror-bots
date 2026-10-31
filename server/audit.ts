import type { Side, Timeframe } from '../shared/types.ts';
import { db } from './db.ts';
import { payoff, round4 } from './engine/core.ts';
import type { BotRow, TradeRow } from './engine/runner.ts';
import { cachedMarket, getJson, slugFor, takerFee } from './polymarket.ts';

/**
 * Re-checks every settled trade against Polymarket itself: the market's resolution (fetched fresh from gamma),
 * the token's traded price in the minutes the bot entered (CLOB price history), the taker fee, the PnL and
 * the running balance. Read-only: it reports, it does not change trades.
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

/** How far the bot's fill may sit from Polymarket's traded prices around entry before it is flagged. */
const PRICE_TOLERANCE = 0.05;

export interface AuditIssue {
  tradeId: number;
  botId: number;
  bot: string;
  slug: string | null;
  kind: 'outcome' | 'price' | 'fee' | 'pnl' | 'balance' | 'unresolved' | 'no-market';
  detail: string;
}

export interface AuditReport {
  ranAt: number;
  trades: number;
  windows: number;
  priceChecked: number;
  issues: AuditIssue[];
}

interface GammaMarket {
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  closed: boolean;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number };
}

interface Resolution {
  outcome: Side | null;
  feeRate: number;
  upToken: string;
  downToken: string;
}

async function resolution(slug: string): Promise<Resolution | null> {
  const events = await getJson<{ markets?: GammaMarket[] }[]>(`${GAMMA}/events?slug=${slug}`);
  const m = events[0]?.markets?.[0];
  if (!m) return null;
  const outcomes = (JSON.parse(m.outcomes) as string[]).map((o) => o.toLowerCase());
  const tokens = JSON.parse(m.clobTokenIds) as string[];
  const prices = (JSON.parse(m.outcomePrices) as string[]).map(Number);
  const up = outcomes.indexOf('up');
  const down = outcomes.indexOf('down');
  let outcome: Side | null = null;
  if (m.closed && prices[up] === 1 && prices[down] === 0) outcome = 'UP';
  if (m.closed && prices[down] === 1 && prices[up] === 0) outcome = 'DOWN';
  return {
    outcome,
    feeRate: m.feesEnabled === false ? 0 : (m.feeSchedule?.rate ?? 0),
    upToken: tokens[up],
    downToken: tokens[down],
  };
}

/**
 * Polymarket's traded prices for a token in the first minute of the window, when bots enter. Prints are
 * sparse right after a window opens, so fewer than two of them is too little to judge a fill by.
 */
async function pricesAround(token: string, startTs: number): Promise<number[]> {
  const s = Math.floor(startTs / 1000);
  const res = await getJson<{ history?: { t: number; p: number }[] }>(
    `${CLOB}/prices-history?market=${token}&startTs=${s}&endTs=${s + 60}&fidelity=1`,
  );
  const pts = (res.history ?? []).filter((h) => h.t >= s && h.t <= s + 60).map((h) => h.p).filter((p) => p > 0 && p < 1);
  return pts.length >= 2 ? pts : [];
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const todo = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (todo.length) await fn(todo.shift()!);
  }));
}

export async function auditTrades(log = console.log): Promise<AuditReport> {
  const bots = new Map((db.prepare('SELECT * FROM bots').all() as BotRow[]).map((b) => [b.id, b]));
  const trades = db.prepare("SELECT * FROM trades WHERE status != 'open' ORDER BY bot_id, hour_ts, id").all() as TradeRow[];
  const issues: AuditIssue[] = [];
  const flag = (t: TradeRow, kind: AuditIssue['kind'], detail: string) =>
    issues.push({ tradeId: t.id, botId: t.bot_id, bot: bots.get(t.bot_id)?.name ?? '?', slug: t.slug, kind, detail });

  // One gamma lookup per market window, one price-history lookup per token bought.
  const tfOf = (t: TradeRow) => bots.get(t.bot_id)?.timeframe ?? '1h';
  const slugOf = (t: TradeRow) => t.slug ?? slugFor(tfOf(t) as Timeframe, t.hour_ts);
  const markets = new Map<string, Resolution | null>();
  await pool([...new Set(trades.map(slugOf))], 4, async (slug) => {
    markets.set(slug, await resolution(slug).catch(() => null));
  });
  const prices = new Map<string, number[]>();
  const tokenOf = (t: TradeRow) => {
    const m = markets.get(slugOf(t)) ?? null;
    const cached = cachedMarket(tfOf(t) as Timeframe, t.hour_ts);
    return (t.side === 'UP' ? (m?.upToken ?? cached?.upToken) : (m?.downToken ?? cached?.downToken)) ?? null;
  };
  const priceKeys = [...new Set(trades.map((t) => `${tokenOf(t)}:${t.hour_ts}`).filter((k) => !k.startsWith('null')))];
  await pool(priceKeys, 4, async (k) => {
    const [token, ts] = k.split(':');
    prices.set(k, await pricesAround(token, Number(ts)).catch(() => []));
  });

  let priceChecked = 0;
  let botId = -1;
  let running = 0;
  for (const t of trades) {
    const b = bots.get(t.bot_id);
    if (t.bot_id !== botId) {
      botId = t.bot_id;
      running = b?.start_balance ?? 0;
    }
    const m = markets.get(slugOf(t));
    if (!m) flag(t, 'no-market', 'Polymarket returned no market for this window');
    else if (!m.outcome) flag(t, 'unresolved', 'Polymarket has not resolved this market yet');
    else if ((m.outcome === t.side) !== (t.status === 'won'))
      flag(t, 'outcome', `app says ${t.status.toUpperCase()} on ${t.side}, Polymarket resolved ${m.outcome}`);

    const seen = prices.get(`${tokenOf(t)}:${t.hour_ts}`) ?? [];
    if (seen.length) {
      priceChecked++;
      const lo = Math.min(...seen);
      const hi = Math.max(...seen);
      if (t.price < lo - PRICE_TOLERANCE || t.price > hi + PRICE_TOLERANCE)
        flag(t, 'price', `filled at ${t.price}, Polymarket traded ${lo}–${hi} around entry`);
    }

    const shares = t.shares ?? 0;
    if (m) {
      const fee = takerFee(shares, t.price, m.feeRate);
      if (Math.abs(fee - t.fee) > 0.01) flag(t, 'fee', `fee ${t.fee}, expected ${fee} at rate ${m.feeRate}`);
    }
    const won = m?.outcome ? m.outcome === t.side : t.status === 'won';
    const pnl = payoff(shares, t.stake, t.fee, won);
    if (Math.abs(pnl - (t.pnl ?? 0)) > 0.005) flag(t, 'pnl', `PnL ${t.pnl}, expected ${pnl}`);
    running = round4(running + (t.pnl ?? 0));
    if (t.balance_after !== null && Math.abs(running - t.balance_after) > 0.005)
      flag(t, 'balance', `balance after ${t.balance_after}, sum of PnL gives ${running}`);
  }

  const report: AuditReport = { ranAt: Date.now(), trades: trades.length, windows: markets.size, priceChecked, issues };
  const byKind = issues.reduce<Record<string, number>>((a, i) => ({ ...a, [i.kind]: (a[i.kind] ?? 0) + 1 }), {});
  log(`[audit] ${trades.length} trades in ${markets.size} markets, ${priceChecked} price-checked; issues: ${JSON.stringify(byKind)}`);
  for (const i of issues.slice(0, 200)) log(`[audit] ${i.kind} trade ${i.tradeId} ${i.bot} ${i.slug}: ${i.detail}`);
  return report;
}

let last: AuditReport | null = null;
let running: Promise<AuditReport> | null = null;

export const lastAudit = () => last;

export function runAudit() {
  running ??= auditTrades()
    .then((r) => (last = r))
    .finally(() => (running = null));
  return running;
}
