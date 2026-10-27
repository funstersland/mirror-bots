import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStats, nextMg, outcomeOf, payoff, stakeFor, type MgState } from './core.ts';

const base: MgState = { baseLot: 5, nextStake: 5, lossRun: 0, enabled: true, multiplier: 2, resetAfter: 3 };

test('martingale doubles after losses and resets after N in a row', () => {
  let mg = base;
  mg = nextMg(mg, 5, false);
  assert.equal(mg.nextStake, 10);
  mg = nextMg(mg, 10, false);
  assert.equal(mg.nextStake, 20);
  mg = nextMg(mg, 20, false); // third loss in a row hits resetAfter=3
  assert.deepEqual([mg.nextStake, mg.lossRun], [5, 0]);
});

test('martingale resets on a win and stays flat when disabled', () => {
  assert.equal(nextMg({ ...base, nextStake: 20, lossRun: 2 }, 20, true).nextStake, 5);
  assert.equal(nextMg({ ...base, enabled: false }, 5, false).nextStake, 5);
});

test('resetAfter 0 never resets on losses', () => {
  let mg = { ...base, resetAfter: 0 };
  for (let i = 0; i < 5; i++) mg = nextMg(mg, mg.nextStake, false);
  assert.equal(mg.nextStake, 160);
});

test('stake is capped by balance', () => {
  assert.equal(stakeFor({ ...base, nextStake: 40 }, 25.5), 25.5);
});

test('payoff: shares pay 1 on a win, fee paid either way', () => {
  assert.equal(payoff(9.8, 5, 0.17, true), 4.63);
  assert.equal(payoff(9.8, 5, 0.17, false), -5.17);
});

test('outcome uses close >= open', () => {
  assert.equal(outcomeOf({ ts: 0, o: 1, h: 1, l: 1, c: 1, v: 0 }), 'UP');
  assert.equal(outcomeOf({ ts: 0, o: 2, h: 2, l: 1, c: 1, v: 0 }), 'DOWN');
});

test('stats: streaks, hit counts and drawdown', () => {
  const seq = ['won', 'lost', 'lost', 'won', 'won', 'won', 'lost', 'lost', 'lost', 'won'];
  let bal = 100;
  const trades = seq.map((s, i) => {
    const pnl = s === 'won' ? 5 : -5;
    bal += pnl;
    return { status: s, pnl, balance_after: bal, stake: 5, hour_ts: i };
  });
  trades.push({ status: 'open', pnl: 0, balance_after: null as unknown as number, stake: 5, hour_ts: 99 });
  const st = computeStats(trades, 100);
  assert.equal(st.wins, 5);
  assert.equal(st.losses, 5);
  assert.equal(st.open, 1);
  assert.equal(st.bestWin, 3);
  assert.equal(st.worstLoss, 3);
  assert.deepEqual(st.lossHits, [{ len: 2, count: 1 }, { len: 3, count: 1 }]);
  assert.deepEqual(st.winHits, [{ len: 1, count: 2 }, { len: 3, count: 1 }]);
  assert.deepEqual(st.current, { kind: 'W', len: 1 });
  assert.equal(st.maxDrawdown, 15); // peak 110 -> 95
});
