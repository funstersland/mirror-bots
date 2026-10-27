// Types shared by the API server and the web app.

export type Side = 'UP' | 'DOWN';
export type BotStatus = 'running' | 'paused' | 'busted';

export interface Candle {
  ts: number; // hour open, ms UTC
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ParamSpec {
  key: string;
  label: string;
  type: 'int' | 'float' | 'bool' | 'select';
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  hint?: string;
}

export interface StrategyInfo {
  id: string;
  name: string;
  family: 'Trend' | 'Range' | 'Volume' | 'Support/Resistance' | 'Candles' | 'Oscillator' | 'Baseline';
  summary: string;
  params: ParamSpec[];
}

export interface StreakHit {
  len: number;
  count: number;
}

export interface BotStats {
  trades: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number; // 0..1
  realized: number;
  grossWin: number;
  grossLoss: number;
  maxDrawdown: number; // $
  maxDrawdownPct: number; // 0..1 of peak
  peakBalance: number;
  current: { kind: 'W' | 'L' | null; len: number };
  bestWin: number;
  worstLoss: number;
  winHits: StreakHit[];
  lossHits: StreakHit[];
  largestStake: number;
  equity: number[]; // downsampled balance curve
  firstHour: number | null;
  lastHour: number | null;
}

export interface Bot {
  id: number;
  name: string;
  strategy: string;
  params: Record<string, number | boolean | string>;
  startBalance: number;
  balance: number;
  baseLot: number;
  entryPrice: number;
  martingale: { enabled: boolean; multiplier: number; resetAfter: number };
  nextStake: number;
  mgLossRun: number;
  status: BotStatus;
  runMs: number;
  createdAt: number;
  backfillDays: number;
  stats: BotStats;
  openTrade: Trade | null;
}

export interface Trade {
  id: number;
  botId: number;
  hourTs: number;
  side: Side;
  stake: number;
  price: number;
  fee: number;
  mgStep: number;
  status: 'open' | 'won' | 'lost';
  pnl: number | null;
  balanceAfter: number | null;
  backtest: boolean;
  reason: string | null;
}

export interface HourBucket {
  hour: number; // 0..23 PKT
  net: number;
  gain: number;
  loss: number; // negative or 0
  wins: number;
  losses: number;
  trades: number;
}

export interface DayBucket {
  date: string; // YYYY-MM-DD in PKT
  net: number;
  trades: number;
}

export interface FeedStatus {
  source: 'binance' | 'sim';
  ok: boolean;
  error: string | null;
  lastCandleTs: number | null;
  lastPrice: number | null;
  candles: number;
  serverTime: number;
}

export interface BotInput {
  name: string;
  strategy: string;
  params: Record<string, number | boolean | string>;
  startBalance: number;
  baseLot: number;
  entryPrice: number;
  martingale: { enabled: boolean; multiplier: number; resetAfter: number };
  backfillDays: number;
}

export const PKT_OFFSET_MS = 5 * 3600 * 1000;
export const HOUR_MS = 3600 * 1000;
