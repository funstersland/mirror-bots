import type { Candle, FeedStatus, Timeframe } from '../shared/types.ts';
import { TF_MS, TIMEFRAMES } from '../shared/types.ts';
import { db, getMeta, setMeta } from './db.ts';

/**
 * BTCUSDT candles from Binance, one series per timeframe. Bots read them for their technical rules.
 * Only closed candles are stored.
 */

const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];
/** Days of candles kept per timeframe: the replay window plus indicator warm-up. */
const KEEP_DAYS: Record<Timeframe, number> = { '1h': 60, '15m': 14, '5m': 6 };

interface Series {
  candles: Candle[];
  index: Map<number, number>;
  live: Candle | null;
}

const series = new Map<Timeframe, Series>(TIMEFRAMES.map((tf) => [tf, { candles: [], index: new Map(), live: null }]));
let lastError: string | null = null;
let lastOk = 0;

export const floorTo = (t: number, tf: Timeframe) => Math.floor(t / TF_MS[tf]) * TF_MS[tf];

db.exec(`CREATE TABLE IF NOT EXISTS candles_tf (
  tf TEXT NOT NULL, ts INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
  PRIMARY KEY (tf, ts)
)`);

function rebuild(s: Series) {
  s.candles.sort((a, b) => a.ts - b.ts);
  s.index.clear();
  s.candles.forEach((c, i) => s.index.set(c.ts, i));
}

export function loadCandles() {
  if (getMeta('candle_source') !== 'binance-tf') {
    db.prepare('DELETE FROM candles').run();
    db.prepare('DELETE FROM candles_tf').run();
    setMeta('candle_source', 'binance-tf');
  }
  for (const tf of TIMEFRAMES) {
    const s = series.get(tf)!;
    s.candles = db.prepare('SELECT ts, o, h, l, c, v FROM candles_tf WHERE tf = ? ORDER BY ts').all(tf) as Candle[];
    rebuild(s);
  }
}

const insert = db.prepare('INSERT OR REPLACE INTO candles_tf(tf, ts, o, h, l, c, v) VALUES (@tf, @ts, @o, @h, @l, @c, @v)');
const insertMany = db.transaction((tf: Timeframe, rows: Candle[]) => rows.forEach((r) => insert.run({ tf, ...r })));

function append(tf: Timeframe, rows: Candle[]) {
  const s = series.get(tf)!;
  const fresh = rows.filter((r) => !s.index.has(r.ts));
  if (!fresh.length) return;
  insertMany(tf, fresh);
  s.candles.push(...fresh);
  const cutoff = Date.now() - KEEP_DAYS[tf] * 86400_000;
  if (s.candles[0]?.ts < cutoff) s.candles = s.candles.filter((c) => c.ts >= cutoff);
  rebuild(s);
}

async function fetchKlines(tf: Timeframe, startTime: number): Promise<{ closed: Candle[]; live: Candle | null }> {
  let lastErr: unknown;
  for (const host of BINANCE_HOSTS) {
    try {
      const url = `${host}/api/v3/klines?symbol=BTCUSDT&interval=${tf}&limit=1000&startTime=${startTime}`;
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

async function syncTf(tf: Timeframe) {
  const s = series.get(tf)!;
  const step = TF_MS[tf];
  const earliest = floorTo(Date.now(), tf) - KEEP_DAYS[tf] * 86400_000;
  let start = s.candles.length ? s.candles[s.candles.length - 1].ts + step : earliest;
  for (let guard = 0; guard < 30; guard++) {
    const { closed, live } = await fetchKlines(tf, start);
    append(tf, closed);
    s.live = live;
    if (closed.length < 999) break;
    start = closed[closed.length - 1].ts + step;
  }
}

export async function syncCandles() {
  try {
    for (const tf of TIMEFRAMES) await syncTf(tf);
    lastError = null;
    lastOk = Date.now();
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
}

export function getCandle(tf: Timeframe, ts: number): Candle | undefined {
  const s = series.get(tf)!;
  const i = s.index.get(ts);
  return i === undefined ? undefined : s.candles[i];
}

/** Up to `count` closed candles that opened before `ts`, oldest first. */
export function candlesBefore(tf: Timeframe, ts: number, count: number): Candle[] {
  const s = series.get(tf)!;
  let i = s.index.get(ts - TF_MS[tf]);
  if (i === undefined) {
    i = s.candles.findLastIndex((c) => c.ts < ts);
    if (i < 0) return [];
  }
  return s.candles.slice(Math.max(0, i - count + 1), i + 1);
}

export function firstCandleTs(tf: Timeframe) {
  return series.get(tf)!.candles[0]?.ts ?? null;
}

export function feedStatus(): FeedStatus {
  const h = series.get('1h')!;
  const m5 = series.get('5m')!;
  const lastTs = m5.candles.at(-1)?.ts ?? null;
  const stale = lastTs !== null && Date.now() - lastTs > 20 * 60_000;
  return {
    source: 'binance',
    ok: !lastError && !stale && lastOk > 0,
    error: lastError ?? (stale ? 'Price feed is more than 20 minutes behind' : null),
    lastCandleTs: h.candles.at(-1)?.ts ?? null,
    lastPrice: m5.live?.c ?? h.live?.c ?? m5.candles.at(-1)?.c ?? null,
    candles: h.candles.length,
    serverTime: Date.now(),
  };
}
