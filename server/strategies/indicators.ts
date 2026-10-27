import type { Candle } from '../../shared/types.ts';

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function stdev(values: number[], period: number): number {
  const slice = values.slice(-period);
  const m = slice.reduce((a, b) => a + b, 0) / slice.length;
  return Math.sqrt(slice.reduce((a, b) => a + (b - m) ** 2, 0) / slice.length);
}

/** Wilder's RSI of the last value. */
export function rsi(closes: number[], period: number): number {
  if (closes.length <= period) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function atr(candles: Candle[], period: number): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
  }
  return sma(trs, period);
}

/** Swing highs/lows: a bar whose high (low) is the extreme of `strength` bars on each side. */
export function pivots(candles: Candle[], strength: number): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) highs.push(candles[i].h);
    if (isLow) lows.push(candles[i].l);
  }
  return { highs, lows };
}

export const body = (c: Candle) => Math.abs(c.c - c.o);
export const range = (c: Candle) => c.h - c.l;
export const upperWick = (c: Candle) => c.h - Math.max(c.o, c.c);
export const lowerWick = (c: Candle) => Math.min(c.o, c.c) - c.l;
export const isGreen = (c: Candle) => c.c >= c.o;
