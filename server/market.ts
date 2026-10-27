import type { Candle, FeedStatus } from '../shared/types.ts';
import { HOUR_MS } from '../shared/types.ts';
import { config } from './config.ts';
import { db, getMeta, setMeta } from './db.ts';

/**
 * Hourly BTCUSDT candles. Polymarket's hourly "Bitcoin Up or Down" markets settle on the
 * Binance BTC/USDT 1h candle: UP wins when close >= open. Only closed candles are stored.
 */

const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];

let candles: Candle[] = [];
const index = new Map<number, number>();
let live: Candle | null = null;
let lastError: string | null = null;
let lastOk = 0;

export const floorHour = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;

function rebuildIndex() {
  index.clear();
  candles.forEach((c, i) => index.set(c.ts, i));
}

export function loadCandles() {
  const source = getMeta('candle_source');
  if (source && source !== config.dataSource) {
    // Never mix synthetic and real candles.
    db.prepare('DELETE FROM candles').run();
  }
  setMeta('candle_source', config.dataSource);
  candles = db.prepare('SELECT ts, o, h, l, c, v FROM candles ORDER BY ts').all() as Candle[];
  rebuildIndex();
}

const insert = db.prepare('INSERT OR REPLACE INTO candles(ts, o, h, l, c, v) VALUES (@ts, @o, @h, @l, @c, @v)');
const insertMany = db.transaction((rows: Candle[]) => rows.forEach((r) => insert.run(r)));

function append(rows: Candle[]) {
  const fresh = rows.filter((r) => !index.has(r.ts));
  if (!fresh.length) return;
  insertMany(fresh);
  candles.push(...fresh);
  candles.sort((a, b) => a.ts - b.ts);
  rebuildIndex();
}

async function fetchKlines(startTime: number): Promise<{ closed: Candle[]; live: Candle | null }> {
  let lastErr: unknown;
  for (const host of BINANCE_HOSTS) {
    try {
      const url = `${host}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1000&startTime=${startTime}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`${host} HTTP ${res.status}`);
      const raw = (await res.json()) as [number, string, string, string, string, string, number][];
      const now = Date.now();
      const all = raw.map((k) => ({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closeTime: k[6] }));
      const closed = all.filter((k) => k.closeTime < now).map(({ closeTime: _, ...c }) => c);
      const open = all.find((k) => k.closeTime >= now);
      return { closed, live: open ? { ts: open.ts, o: open.o, h: open.h, l: open.l, c: open.c, v: open.v } : null };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function syncBinance() {
  const earliest = floorHour(Date.now()) - config.historyDays * 24 * HOUR_MS;
  let start = candles.length ? candles[candles.length - 1].ts + HOUR_MS : earliest;
  for (let guard = 0; guard < 20; guard++) {
    const { closed, live: l } = await fetchKlines(start);
    append(closed);
    live = l;
    if (closed.length < 999) break;
    start = closed[closed.length - 1].ts + HOUR_MS;
  }
}

// ---------- synthetic feed (offline development) ----------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function simCandle(ts: number, prevClose: number): Candle {
  const r = rng(ts / HOUR_MS);
  const vol = 0.0055 * (0.6 + r() * 0.9);
  // Gentle pull toward ~68k keeps the synthetic price in a realistic band.
  const ret = gauss(r) * vol - 0.002 * Math.log(prevClose / 68_000);
  const o = prevClose;
  const c = o * (1 + ret);
  const h = Math.max(o, c) * (1 + Math.abs(gauss(r)) * vol * 0.6);
  const l = Math.min(o, c) * (1 - Math.abs(gauss(r)) * vol * 0.6);
  const v = 900 * Math.exp(gauss(r) * 0.35) * (1 + Math.abs(ret) / vol);
  return { ts, o, h, l, c, v };
}

function syncSim() {
  const nowHour = floorHour(Date.now());
  let ts = candles.length ? candles[candles.length - 1].ts + HOUR_MS : nowHour - config.historyDays * 24 * HOUR_MS;
  let prev = candles.length ? candles[candles.length - 1].c : 68_000;
  const rows: Candle[] = [];
  for (; ts < nowHour; ts += HOUR_MS) {
    const c = simCandle(ts, prev);
    rows.push(c);
    prev = c.c;
  }
  append(rows);
  const partial = simCandle(nowHour, prev);
  const frac = (Date.now() - nowHour) / HOUR_MS;
  live = { ...partial, c: prev + (partial.c - prev) * frac, v: partial.v * frac };
}

export async function syncCandles() {
  try {
    if (config.dataSource === 'sim') syncSim();
    else await syncBinance();
    lastError = null;
    lastOk = Date.now();
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
}

export function getCandle(ts: number): Candle | undefined {
  const i = index.get(ts);
  return i === undefined ? undefined : candles[i];
}

/** Up to `count` closed candles that opened strictly before `hourTs`, oldest first. */
export function candlesBefore(hourTs: number, count: number): Candle[] {
  let i = index.get(hourTs - HOUR_MS);
  if (i === undefined) {
    // Fall back to a search when the previous hour is missing (gap in the feed).
    i = candles.findLastIndex((c) => c.ts < hourTs);
    if (i < 0) return [];
  }
  return candles.slice(Math.max(0, i - count + 1), i + 1);
}

export function firstCandleTs() {
  return candles[0]?.ts ?? null;
}

export function lastClosedTs() {
  return candles.length ? candles[candles.length - 1].ts : null;
}

export function feedStatus(): FeedStatus {
  const lastTs = lastClosedTs();
  const stale = lastTs !== null && floorHour(Date.now()) - lastTs > 2 * HOUR_MS;
  return {
    source: config.dataSource,
    ok: !lastError && !stale && lastOk > 0,
    error: lastError ?? (stale ? 'Feed is behind by more than 2 hours' : null),
    lastCandleTs: lastTs,
    lastPrice: live?.c ?? (lastTs !== null ? candles[candles.length - 1].c : null),
    candles: candles.length,
    serverTime: Date.now(),
  };
}

export function recentCandles(n: number): Candle[] {
  const out = candles.slice(-n);
  return live ? [...out, live] : out;
}
