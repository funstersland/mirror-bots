import type { Side, Timeframe } from '../shared/types.ts';
import { TF_MS } from '../shared/types.ts';
import { db } from './db.ts';

/**
 * Read-only access to Polymarket's "Bitcoin Up or Down" markets (1 hour, 15 minute and 5 minute).
 * 1h markets resolve on the Binance BTCUSDT 1h candle; 15m and 5m resolve on Chainlink's BTC/USD stream.
 * Gamma gives the market (tokens, fees, result), the CLOB gives the live order book,
 * and the data API gives minute-level price history for replays.
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA = 'https://data-api.polymarket.com';

export interface PmMarket {
  tf: Timeframe;
  hourTs: number; // window start
  slug: string;
  upToken: string;
  downToken: string;
  feeRate: number;
  minSize: number;
  accepting: boolean;
  /** Polymarket's own result once the market has resolved. */
  outcome: Side | null;
  /** Token prices at the hour's open, from price history (replays only). */
  openUp: number | null;
  openDown: number | null;
}

export interface Fill {
  shares: number;
  cost: number; // pUSD spent on shares
  avgPrice: number;
  fee: number;
  bestAsk: number;
}

db.exec(`
DROP TABLE IF EXISTS pm_markets;
CREATE TABLE IF NOT EXISTS pm_windows (
  tf TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,
  slug TEXT NOT NULL,
  up_token TEXT NOT NULL,
  down_token TEXT NOT NULL,
  fee_rate REAL NOT NULL,
  min_size REAL NOT NULL,
  outcome TEXT,
  open_up REAL,
  open_down REAL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (tf, hour_ts)
);
`);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  hour12: false,
});

/** Market slug for a window: btc-updown-15m-<start> for 5m/15m, bitcoin-up-or-down-october-27-2026-3pm-et for 1h. */
export function slugFor(tf: Timeframe, startTs: number): string {
  if (tf !== '1h') return `btc-updown-${tf}-${startTs / 1000}`;
  return slugForHour(startTs);
}

export function slugForHour(hourTs: number): string {
  const p = Object.fromEntries(etParts.formatToParts(new Date(hourTs)).map((x) => [x.type, x.value]));
  const h24 = Number(p.hour) % 24;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `bitcoin-up-or-down-${MONTHS[Number(p.month) - 1]}-${Number(p.day)}-${p.year}-${h12}${h24 < 12 ? 'am' : 'pm'}-et`;
}

export const eventUrl = (slug: string) => `https://polymarket.com/event/${slug}`;

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} ${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

interface GammaMarket {
  slug: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  closed: boolean;
  acceptingOrders?: boolean;
  orderMinSize?: number;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number };
  eventStartTime?: string;
}

interface Row {
  tf: Timeframe;
  hour_ts: number;
  slug: string;
  up_token: string;
  down_token: string;
  fee_rate: number;
  min_size: number;
  outcome: string | null;
  open_up: number | null;
  open_down: number | null;
}

const toMarket = (r: Row, accepting = true): PmMarket => ({
  tf: r.tf,
  hourTs: r.hour_ts,
  slug: r.slug,
  upToken: r.up_token,
  downToken: r.down_token,
  feeRate: r.fee_rate,
  minSize: r.min_size,
  accepting,
  outcome: (r.outcome as Side | null) ?? null,
  openUp: r.open_up,
  openDown: r.open_down,
});

const q = {
  get: db.prepare('SELECT * FROM pm_windows WHERE tf = ? AND hour_ts = ?'),
  upsert: db.prepare(`INSERT INTO pm_windows (tf, hour_ts, slug, up_token, down_token, fee_rate, min_size, outcome, fetched_at)
    VALUES (@tf, @hour_ts, @slug, @up_token, @down_token, @fee_rate, @min_size, @outcome, @fetched_at)
    ON CONFLICT(tf, hour_ts) DO UPDATE SET outcome = excluded.outcome, fee_rate = excluded.fee_rate,
      min_size = excluded.min_size, fetched_at = excluded.fetched_at`),
  setOpen: db.prepare('UPDATE pm_windows SET open_up = ?, open_down = ? WHERE tf = ? AND hour_ts = ?'),
};

/** Loads the market for a window. Cached; refetched while the result is still unknown. */
export async function getMarket(tf: Timeframe, hourTs: number, refresh = false): Promise<PmMarket | null> {
  const cached = q.get.get(tf, hourTs) as Row | undefined;
  if (cached && (cached.outcome || !refresh)) return toMarket(cached);
  const slug = slugFor(tf, hourTs);
  // The events endpoint returns closed markets too; /markets?slug= hides them.
  const events = await getJson<{ markets?: GammaMarket[] }[]>(`${GAMMA}/events?slug=${slug}`);
  const m = events[0]?.markets?.[0];
  if (!m) return null;
  const outcomes = JSON.parse(m.outcomes) as string[];
  const tokens = JSON.parse(m.clobTokenIds) as string[];
  const prices = (JSON.parse(m.outcomePrices) as string[]).map(Number);
  const upIdx = outcomes.findIndex((o) => o.toLowerCase() === 'up');
  const downIdx = outcomes.findIndex((o) => o.toLowerCase() === 'down');
  if (upIdx < 0 || downIdx < 0) return null;
  let outcome: Side | null = null;
  if (m.closed && prices[upIdx] === 1 && prices[downIdx] === 0) outcome = 'UP';
  if (m.closed && prices[downIdx] === 1 && prices[upIdx] === 0) outcome = 'DOWN';
  const row = {
    tf,
    hour_ts: hourTs,
    slug,
    up_token: tokens[upIdx],
    down_token: tokens[downIdx],
    fee_rate: m.feesEnabled === false ? 0 : (m.feeSchedule?.rate ?? 0),
    min_size: m.orderMinSize ?? 5,
    outcome,
    fetched_at: Date.now(),
  };
  q.upsert.run(row);
  return toMarket(q.get.get(tf, hourTs) as Row, m.acceptingOrders !== false && !m.closed);
}

/** Polymarket taker fee in pUSD: shares × rate × p × (1 − p), rounded to 5 decimals. */
export function takerFee(shares: number, price: number, rate: number) {
  return Math.round(shares * rate * price * (1 - price) * 1e5) / 1e5;
}

/** Walks the asks to spend `stake` pUSD like a market buy would. Asks may come in any order. */
export function fillFromAsks(asks: { price: string; size: string }[], stake: number, feeRate: number): Fill | null {
  const levels = asks.map((a) => ({ price: Number(a.price), size: Number(a.size) })).filter((l) => l.price > 0 && l.size > 0);
  levels.sort((a, b) => a.price - b.price);
  if (!levels.length) return null;
  let left = stake;
  let shares = 0;
  let fee = 0;
  for (const l of levels) {
    if (left <= 1e-9) break;
    const take = Math.min(l.size, left / l.price);
    shares += take;
    left -= take * l.price;
    fee += takerFee(take, l.price, feeRate);
  }
  if (shares <= 0) return null;
  // Shares are booked to the cent; the cost is what those whole cents of shares cost at the average fill.
  const avgPrice = (stake - left) / shares;
  const booked = Math.floor(shares * 100) / 100;
  return {
    shares: booked,
    cost: Math.round(booked * avgPrice * 1e5) / 1e5,
    avgPrice,
    fee: Math.round(fee * 1e5) / 1e5,
    bestAsk: levels[0].price,
  };
}

export async function getAsks(token: string) {
  const book = await getJson<{ asks: { price: string; size: string }[] }>(`${CLOB}/book?token_id=${token}`);
  return book.asks ?? [];
}

/** Token price at the start of the hour from Polymarket's minute price history. */
async function priceAtOpen(token: string, hourTs: number): Promise<number | null> {
  const start = hourTs / 1000;
  const res = await getJson<{ data: { timestamp: number; price: number; resolution_seconds: number }[] }>(
    `${DATA}/v2/prices-history?token_id=${token}&start=${start}&end=${start + 300}&bucket_seconds=60`,
  );
  const pt = res.data?.find((d) => d.timestamp >= start && d.resolution_seconds > 0 && d.price > 0 && d.price < 1);
  return pt ? pt.price : null;
}

/** Fills in the opening Up/Down prices of a resolved market, for replays. */
export async function ensureOpenPrices(m: PmMarket): Promise<PmMarket> {
  if (m.openUp !== null && m.openDown !== null) return m;
  const [up, down] = await Promise.all([priceAtOpen(m.upToken, m.hourTs), priceAtOpen(m.downToken, m.hourTs)]);
  q.setOpen.run(up, down, m.tf, m.hourTs);
  return { ...m, openUp: up, openDown: down };
}

const syncing = new Set<Timeframe>();
const syncedAt = new Map<Timeframe, number>();
export const historyStatus = () => ({
  syncing: [...syncing],
  synced: Object.fromEntries(syncedAt),
});
export const historyReady = (tf: Timeframe) => !syncing.has(tf) && syncedAt.has(tf);

/**
 * Downloads market, result and opening prices for every resolved window in the last `days`.
 * Shared by all bots of that timeframe, so later replays are instant.
 */
export async function syncHistory(tf: Timeframe, days: number, log = console.log) {
  if (syncing.has(tf)) return;
  syncing.add(tf);
  try {
    const step = TF_MS[tf];
    // Skip the newest windows: they may not be resolved yet.
    const last = Math.floor(Date.now() / step) * step - 2 * Math.max(step, 15 * 60_000);
    const first = last - days * 86400_000;
    const todo: number[] = [];
    for (let h = last; h >= first; h -= step) {
      const r = q.get.get(tf, h) as Row | undefined;
      if (!r || !r.outcome || r.open_up === null || r.open_down === null) todo.push(h);
    }
    let done = 0;
    let failed = 0;
    const worker = async () => {
      while (todo.length) {
        const h = todo.shift()!;
        try {
          const m = await getMarket(tf, h, true);
          if (m?.outcome) await ensureOpenPrices(m);
        } catch (e) {
          if (++failed <= 5) log(`[polymarket] ${tf} history ${new Date(h).toISOString()}: ${(e as Error).message}`);
        }
        if (++done % 200 === 0) log(`[polymarket] ${tf} history: ${done} windows`);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    syncedAt.set(tf, Date.now());
    log(`[polymarket] ${tf} history ready (${done} fetched, ${failed} failed)`);
  } finally {
    syncing.delete(tf);
  }
}

export function cachedMarket(tf: Timeframe, hourTs: number): PmMarket | null {
  const r = q.get.get(tf, hourTs) as Row | undefined;
  return r ? toMarket(r) : null;
}

/** Polymarket's traded price for a token closest to `ts` (CLOB minute-fidelity price history), or null. */
export async function tradedPriceNear(token: string, ts: number): Promise<number | null> {
  const s = Math.floor(ts / 1000);
  const res = await getJson<{ history?: { t: number; p: number }[] }>(
    `${CLOB}/prices-history?market=${token}&startTs=${s - 60}&endTs=${s + 120}&fidelity=1`,
  );
  const pts = (res.history ?? []).filter((h) => h.p > 0 && h.p < 1);
  if (!pts.length) return null;
  return pts.reduce((a, b) => (Math.abs(b.t - s) < Math.abs(a.t - s) ? b : a)).p;
}
