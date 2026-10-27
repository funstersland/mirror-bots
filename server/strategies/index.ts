import type { Candle, ParamSpec, Side, StrategyInfo } from '../../shared/types.ts';
import { atr, body, ema, isGreen, lowerWick, pivots, range, rsi, sma, stdev, upperWick } from './indicators.ts';

export type Params = Record<string, number | boolean | string>;
export interface Signal {
  side: Side;
  reason: string;
}

interface Strategy extends StrategyInfo {
  /** `candles` are closed hourly candles, oldest first; the last one closed right before the market hour opens. */
  decide(candles: Candle[], p: Params): Signal | null;
}

const flip: ParamSpec = {
  key: 'invert',
  label: 'Flip signal',
  type: 'bool',
  default: false,
  hint: 'Trade the opposite side of what the rule says',
};

const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const num = (p: Params, k: string) => Number(p[k]);

const strategies: Strategy[] = [
  {
    id: 'follow_last',
    name: 'Candle follow',
    family: 'Baseline',
    summary: 'Bets the next hour closes the same colour as the last one, if its body is big enough.',
    params: [{ key: 'minBodyPct', label: 'Min body %', type: 'float', default: 0.05, min: 0, max: 2, step: 0.01, hint: 'Body as % of price' }, flip],
    decide(cs, p) {
      const c = cs[cs.length - 1];
      if ((body(c) / c.o) * 100 < num(p, 'minBodyPct')) return null;
      return { side: isGreen(c) ? 'UP' : 'DOWN', reason: `last candle ${isGreen(c) ? 'green' : 'red'}` };
    },
  },
  {
    id: 'ema_trend',
    name: 'EMA trend',
    family: 'Trend',
    summary: 'Trades with the trend when the fast EMA is above (UP) or below (DOWN) the slow EMA by a margin.',
    params: [
      { key: 'fast', label: 'Fast EMA', type: 'int', default: 9, min: 2, max: 100 },
      { key: 'slow', label: 'Slow EMA', type: 'int', default: 21, min: 3, max: 300 },
      { key: 'minGapPct', label: 'Min gap %', type: 'float', default: 0.05, min: 0, max: 3, step: 0.01 },
      flip,
    ],
    decide(cs, p) {
      const closes = cs.map((c) => c.c);
      const f = ema(closes, num(p, 'fast')).at(-1)!;
      const s = ema(closes, num(p, 'slow')).at(-1)!;
      const gap = ((f - s) / s) * 100;
      if (Math.abs(gap) < num(p, 'minGapPct')) return null;
      return { side: gap > 0 ? 'UP' : 'DOWN', reason: `EMA gap ${gap.toFixed(2)}%` };
    },
  },
  {
    id: 'trend_pullback',
    name: 'Trend pullback',
    family: 'Trend',
    summary: 'In an uptrend (price above slow EMA) buys UP after a red candle; in a downtrend buys DOWN after a green one.',
    params: [{ key: 'slow', label: 'Trend EMA', type: 'int', default: 50, min: 5, max: 300 }, flip],
    decide(cs, p) {
      const closes = cs.map((c) => c.c);
      const s = ema(closes, num(p, 'slow')).at(-1)!;
      const c = cs[cs.length - 1];
      if (c.c > s && !isGreen(c)) return { side: 'UP', reason: 'pullback in uptrend' };
      if (c.c < s && isGreen(c)) return { side: 'DOWN', reason: 'bounce in downtrend' };
      return null;
    },
  },
  {
    id: 'range_breakout',
    name: 'Range breakout',
    family: 'Range',
    summary: 'When the last close breaks the high or low of the previous N hours, follows the breakout.',
    params: [{ key: 'lookback', label: 'Range hours', type: 'int', default: 12, min: 3, max: 168 }, flip],
    decide(cs, p) {
      const n = num(p, 'lookback');
      const prior = cs.slice(-n - 1, -1);
      const c = cs[cs.length - 1];
      const hi = Math.max(...prior.map((x) => x.h));
      const lo = Math.min(...prior.map((x) => x.l));
      if (c.c > hi) return { side: 'UP', reason: `broke ${n}h high ${fmt(hi)}` };
      if (c.c < lo) return { side: 'DOWN', reason: `broke ${n}h low ${fmt(lo)}` };
      return null;
    },
  },
  {
    id: 'range_reversion',
    name: 'Range fade',
    family: 'Range',
    summary: 'Inside an N-hour range, bets DOWN near the top and UP near the bottom.',
    params: [
      { key: 'lookback', label: 'Range hours', type: 'int', default: 24, min: 3, max: 168 },
      { key: 'zonePct', label: 'Edge zone %', type: 'float', default: 20, min: 5, max: 45, step: 1, hint: 'How close to the edge, as % of range' },
      flip,
    ],
    decide(cs, p) {
      const win = cs.slice(-num(p, 'lookback'));
      const hi = Math.max(...win.map((x) => x.h));
      const lo = Math.min(...win.map((x) => x.l));
      const pos = (cs[cs.length - 1].c - lo) / (hi - lo || 1);
      const z = num(p, 'zonePct') / 100;
      if (pos >= 1 - z) return { side: 'DOWN', reason: `at ${(pos * 100).toFixed(0)}% of range` };
      if (pos <= z) return { side: 'UP', reason: `at ${(pos * 100).toFixed(0)}% of range` };
      return null;
    },
  },
  {
    id: 'volume_spike',
    name: 'Volume spike',
    family: 'Volume',
    summary: 'When last hour volume is K times the average, follows (or fades) that candle.',
    params: [
      { key: 'lookback', label: 'Avg hours', type: 'int', default: 24, min: 5, max: 168 },
      { key: 'mult', label: 'Volume ×', type: 'float', default: 2, min: 1.1, max: 10, step: 0.1 },
      { key: 'mode', label: 'Mode', type: 'select', default: 'follow', options: [{ value: 'follow', label: 'Follow' }, { value: 'fade', label: 'Fade' }] },
      flip,
    ],
    decide(cs, p) {
      const c = cs[cs.length - 1];
      const avg = sma(cs.slice(0, -1).map((x) => x.v), num(p, 'lookback'));
      const ratio = c.v / (avg || 1);
      if (ratio < num(p, 'mult')) return null;
      const follow = p.mode !== 'fade';
      const up = isGreen(c) === follow;
      return { side: up ? 'UP' : 'DOWN', reason: `volume ${ratio.toFixed(1)}× avg` };
    },
  },
  {
    id: 'volume_climax',
    name: 'Volume climax',
    family: 'Volume',
    summary: 'Big volume with a small body (absorption) after a move: bets the move reverses.',
    params: [
      { key: 'lookback', label: 'Avg hours', type: 'int', default: 24, min: 5, max: 168 },
      { key: 'mult', label: 'Volume ×', type: 'float', default: 1.8, min: 1.1, max: 10, step: 0.1 },
      { key: 'maxBody', label: 'Max body / range', type: 'float', default: 0.35, min: 0.05, max: 0.9, step: 0.05 },
      flip,
    ],
    decide(cs, p) {
      const c = cs[cs.length - 1];
      const avg = sma(cs.slice(0, -1).map((x) => x.v), num(p, 'lookback'));
      if (c.v / (avg || 1) < num(p, 'mult')) return null;
      if (body(c) / (range(c) || 1) > num(p, 'maxBody')) return null;
      const prior = cs[cs.length - 4];
      const moveUp = c.c > prior.c;
      return { side: moveUp ? 'DOWN' : 'UP', reason: 'high-volume absorption' };
    },
  },
  {
    id: 'sr_bounce',
    name: 'S/R bounce',
    family: 'Support/Resistance',
    summary: 'Finds swing-high resistance and swing-low support; near support bets UP, near resistance bets DOWN.',
    params: [
      { key: 'lookback', label: 'Lookback hours', type: 'int', default: 72, min: 12, max: 500 },
      { key: 'strength', label: 'Pivot strength', type: 'int', default: 3, min: 1, max: 10 },
      { key: 'tolPct', label: 'Touch distance %', type: 'float', default: 0.25, min: 0.02, max: 2, step: 0.01 },
      flip,
    ],
    decide(cs, p) {
      const { highs, lows } = pivots(cs.slice(-num(p, 'lookback')), num(p, 'strength'));
      const c = cs[cs.length - 1].c;
      const tol = (c * num(p, 'tolPct')) / 100;
      const sup = lows.filter((l) => l <= c).sort((a, b) => b - a)[0];
      const res = highs.filter((h) => h >= c).sort((a, b) => a - b)[0];
      const dSup = sup !== undefined ? c - sup : Infinity;
      const dRes = res !== undefined ? res - c : Infinity;
      if (dSup <= tol && dSup <= dRes) return { side: 'UP', reason: `near support ${fmt(sup!)}` };
      if (dRes <= tol) return { side: 'DOWN', reason: `near resistance ${fmt(res!)}` };
      return null;
    },
  },
  {
    id: 'sr_breakout',
    name: 'S/R breakout',
    family: 'Support/Resistance',
    summary: 'When the last candle closes through the nearest swing resistance or support, follows the break.',
    params: [
      { key: 'lookback', label: 'Lookback hours', type: 'int', default: 72, min: 12, max: 500 },
      { key: 'strength', label: 'Pivot strength', type: 'int', default: 3, min: 1, max: 10 },
      flip,
    ],
    decide(cs, p) {
      const { highs, lows } = pivots(cs.slice(-num(p, 'lookback'), -1), num(p, 'strength'));
      const last = cs[cs.length - 1];
      const prev = cs[cs.length - 2].c;
      const brokeUp = highs.find((h) => prev <= h && last.c > h);
      if (brokeUp !== undefined) return { side: 'UP', reason: `closed above ${fmt(brokeUp)}` };
      const brokeDown = lows.find((l) => prev >= l && last.c < l);
      if (brokeDown !== undefined) return { side: 'DOWN', reason: `closed below ${fmt(brokeDown)}` };
      return null;
    },
  },
  {
    id: 'wick_rejection',
    name: 'Wick rejection',
    family: 'Candles',
    summary: 'A long lower wick (price rejected lower) bets UP; a long upper wick bets DOWN.',
    params: [
      { key: 'wickBody', label: 'Wick ÷ body', type: 'float', default: 2, min: 0.5, max: 10, step: 0.1 },
      { key: 'wickRange', label: 'Wick ÷ range', type: 'float', default: 0.5, min: 0.2, max: 0.95, step: 0.05 },
      flip,
    ],
    decide(cs, p) {
      const c = cs[cs.length - 1];
      const r = range(c) || 1;
      const b = Math.max(body(c), r * 0.02);
      const lw = lowerWick(c);
      const uw = upperWick(c);
      if (lw / b >= num(p, 'wickBody') && lw / r >= num(p, 'wickRange')) return { side: 'UP', reason: 'lower-wick rejection' };
      if (uw / b >= num(p, 'wickBody') && uw / r >= num(p, 'wickRange')) return { side: 'DOWN', reason: 'upper-wick rejection' };
      return null;
    },
  },
  {
    id: 'engulfing',
    name: 'Engulfing',
    family: 'Candles',
    summary: 'A candle whose body swallows the previous opposite-colour body: bullish bets UP, bearish bets DOWN.',
    params: [{ key: 'minRatio', label: 'Min body ratio', type: 'float', default: 1.2, min: 1, max: 5, step: 0.1 }, flip],
    decide(cs, p) {
      const a = cs[cs.length - 2];
      const b = cs[cs.length - 1];
      if (isGreen(a) === isGreen(b)) return null;
      if (body(b) < body(a) * num(p, 'minRatio')) return null;
      const engulfs = Math.max(b.o, b.c) >= Math.max(a.o, a.c) && Math.min(b.o, b.c) <= Math.min(a.o, a.c);
      if (!engulfs) return null;
      return { side: isGreen(b) ? 'UP' : 'DOWN', reason: `${isGreen(b) ? 'bullish' : 'bearish'} engulfing` };
    },
  },
  {
    id: 'streak_reaction',
    name: 'Streak reaction',
    family: 'Candles',
    summary: 'After N candles of the same colour, either continues the run or bets on the reversal.',
    params: [
      { key: 'n', label: 'Same-colour candles', type: 'int', default: 3, min: 2, max: 10 },
      { key: 'mode', label: 'Mode', type: 'select', default: 'reverse', options: [{ value: 'reverse', label: 'Reverse' }, { value: 'continue', label: 'Continue' }] },
      flip,
    ],
    decide(cs, p) {
      const n = num(p, 'n');
      const last = cs.slice(-n);
      const g = isGreen(last[0]);
      if (!last.every((c) => isGreen(c) === g)) return null;
      const cont = p.mode === 'continue';
      const up = cont ? g : !g;
      return { side: up ? 'UP' : 'DOWN', reason: `${n} ${g ? 'green' : 'red'} in a row` };
    },
  },
  {
    id: 'rsi_reversal',
    name: 'RSI reversal',
    family: 'Oscillator',
    summary: 'Oversold RSI bets UP, overbought bets DOWN.',
    params: [
      { key: 'period', label: 'RSI period', type: 'int', default: 14, min: 2, max: 50 },
      { key: 'low', label: 'Oversold', type: 'int', default: 30, min: 5, max: 50 },
      { key: 'high', label: 'Overbought', type: 'int', default: 70, min: 50, max: 95 },
      flip,
    ],
    decide(cs, p) {
      const v = rsi(cs.map((c) => c.c), num(p, 'period'));
      if (v <= num(p, 'low')) return { side: 'UP', reason: `RSI ${v.toFixed(0)}` };
      if (v >= num(p, 'high')) return { side: 'DOWN', reason: `RSI ${v.toFixed(0)}` };
      return null;
    },
  },
  {
    id: 'bollinger',
    name: 'Bollinger snap-back',
    family: 'Oscillator',
    summary: 'Close outside the Bollinger band bets on a move back inside.',
    params: [
      { key: 'period', label: 'Period', type: 'int', default: 20, min: 5, max: 100 },
      { key: 'k', label: 'Std devs', type: 'float', default: 2, min: 1, max: 4, step: 0.1 },
      flip,
    ],
    decide(cs, p) {
      const closes = cs.map((c) => c.c);
      const n = num(p, 'period');
      const m = sma(closes, n);
      const sd = stdev(closes, n);
      const c = closes[closes.length - 1];
      if (c > m + num(p, 'k') * sd) return { side: 'DOWN', reason: 'above upper band' };
      if (c < m - num(p, 'k') * sd) return { side: 'UP', reason: 'below lower band' };
      return null;
    },
  },
  {
    id: 'atr_expansion',
    name: 'Range expansion',
    family: 'Range',
    summary: 'When the last candle range is K times the ATR, follows its direction (momentum ignition).',
    params: [
      { key: 'period', label: 'ATR period', type: 'int', default: 14, min: 3, max: 100 },
      { key: 'mult', label: 'Range × ATR', type: 'float', default: 1.8, min: 1, max: 6, step: 0.1 },
      flip,
    ],
    decide(cs, p) {
      const c = cs[cs.length - 1];
      const a = atr(cs.slice(0, -1), num(p, 'period'));
      if (range(c) < a * num(p, 'mult')) return null;
      return { side: isGreen(c) ? 'UP' : 'DOWN', reason: `range ${(range(c) / a).toFixed(1)}× ATR` };
    },
  },
];

const byId = new Map(strategies.map((s) => [s.id, s]));

/** Candles needed before the market hour for any strategy to have enough history. */
export const WARMUP = 320;

export function listStrategies(): StrategyInfo[] {
  return strategies.map(({ decide: _d, ...info }) => info);
}

export function getStrategy(id: string) {
  return byId.get(id);
}

/** Fills missing params with defaults and clamps numbers into range. */
export function normalizeParams(id: string, input: Params = {}): Params {
  const s = byId.get(id);
  if (!s) throw new Error(`Unknown strategy ${id}`);
  const out: Params = {};
  for (const spec of s.params) {
    let v = input[spec.key] ?? spec.default;
    if (spec.type === 'int' || spec.type === 'float') {
      let n = Number(v);
      if (!Number.isFinite(n)) n = Number(spec.default);
      if (spec.min !== undefined) n = Math.max(spec.min, n);
      if (spec.max !== undefined) n = Math.min(spec.max, n);
      v = spec.type === 'int' ? Math.round(n) : n;
    } else if (spec.type === 'bool') {
      v = v === true || v === 'true';
    } else if (spec.type === 'select') {
      if (!spec.options?.some((o) => o.value === v)) v = spec.default;
    }
    out[spec.key] = v;
  }
  return out;
}

export function decide(id: string, candles: Candle[], params: Params): Signal | null {
  const s = byId.get(id);
  if (!s || candles.length < 30) return null;
  const sig = s.decide(candles, params);
  if (!sig) return null;
  if (params.invert) return { side: sig.side === 'UP' ? 'DOWN' : 'UP', reason: `flipped: ${sig.reason}` };
  return sig;
}
