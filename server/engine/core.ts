import type { BotStats, Candle, Side, StreakHit } from '../../shared/types.ts';

/** Smallest stake a bot will place. Below this balance the bot is out of money. */
export const MIN_STAKE = 1;

export interface MgState {
  baseLot: number;
  nextStake: number;
  lossRun: number;
  enabled: boolean;
  multiplier: number;
  resetAfter: number; // 0 = never reset on a loss run
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Polymarket's rule for these markets: UP wins when the Binance 1h candle closes at or above its open. */
export const outcomeOf = (c: Candle): Side => (c.c >= c.o ? 'UP' : 'DOWN');

export function stakeFor(mg: MgState, balance: number): number {
  const want = mg.enabled ? mg.nextStake : mg.baseLot;
  return round2(Math.min(want, balance));
}

/** A winning share pays 1 pUSD; the fee is paid either way. */
export function payoff(shares: number, cost: number, fee: number, won: boolean) {
  return round4((won ? shares : 0) - cost - fee);
}

export const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Martingale bookkeeping after a settled trade. Returns the new state. */
export function nextMg(mg: MgState, stake: number, won: boolean): MgState {
  if (won || !mg.enabled) return { ...mg, nextStake: mg.baseLot, lossRun: 0 };
  const lossRun = mg.lossRun + 1;
  if (mg.resetAfter > 0 && lossRun >= mg.resetAfter) return { ...mg, nextStake: mg.baseLot, lossRun: 0 };
  return { ...mg, nextStake: round2(stake * mg.multiplier), lossRun };
}

interface SettledLike {
  status: string;
  pnl: number | null;
  balance_after: number | null;
  stake: number;
  hour_ts: number;
}

function hits(map: Map<number, number>): StreakHit[] {
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([len, count]) => ({ len, count }));
}

function downsample(values: number[], n: number) {
  if (values.length <= n) return values;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(values[Math.round((i * (values.length - 1)) / (n - 1))]);
  return out;
}

/** Stats from all of a bot's trades in hour order. Streak hit counts include the streak still running. */
export function computeStats(trades: SettledLike[], startBalance: number): BotStats {
  let wins = 0;
  let losses = 0;
  let open = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let peak = startBalance;
  let maxDd = 0;
  let maxDdPct = 0;
  let largestStake = 0;
  let kind: 'W' | 'L' | null = null;
  let len = 0;
  let bestWin = 0;
  let worstLoss = 0;
  const winHits = new Map<number, number>();
  const lossHits = new Map<number, number>();
  const equity = [startBalance];

  const closeRun = () => {
    if (!kind || !len) return;
    const m = kind === 'W' ? winHits : lossHits;
    m.set(len, (m.get(len) ?? 0) + 1);
  };

  for (const t of trades) {
    largestStake = Math.max(largestStake, t.stake);
    if (t.status === 'open') {
      open++;
      continue;
    }
    const won = t.status === 'won';
    const pnl = t.pnl ?? 0;
    if (won) {
      wins++;
      grossWin += pnl;
    } else {
      losses++;
      grossLoss += pnl;
    }
    const k = won ? 'W' : 'L';
    if (k === kind) len++;
    else {
      closeRun();
      kind = k;
      len = 1;
    }
    if (won) bestWin = Math.max(bestWin, len);
    else worstLoss = Math.max(worstLoss, len);

    const bal = t.balance_after ?? 0;
    equity.push(bal);
    peak = Math.max(peak, bal);
    const dd = peak - bal;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }
  closeRun();

  const settled = wins + losses;
  return {
    trades: settled,
    wins,
    losses,
    open,
    winRate: settled ? wins / settled : 0,
    realized: round2(grossWin + grossLoss),
    grossWin: round2(grossWin),
    grossLoss: round2(grossLoss),
    maxDrawdown: round2(maxDd),
    maxDrawdownPct: maxDdPct,
    peakBalance: round2(peak),
    current: { kind, len },
    bestWin,
    worstLoss,
    winHits: hits(winHits),
    lossHits: hits(lossHits),
    largestStake: round2(largestStake),
    equity: downsample(equity, 60).map(round2),
    firstHour: trades[0]?.hour_ts ?? null,
    lastHour: trades.at(-1)?.hour_ts ?? null,
  };
}
