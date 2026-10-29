import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillFromAsks, slugForHour, takerFee } from './polymarket.ts';

test('slug uses New York time, 12-hour clock and the year', () => {
  assert.equal(slugForHour(Date.parse('2026-10-27T19:00:00Z')), 'bitcoin-up-or-down-october-27-2026-3pm-et');
  assert.equal(slugForHour(Date.parse('2026-10-27T04:00:00Z')), 'bitcoin-up-or-down-october-27-2026-12am-et');
  assert.equal(slugForHour(Date.parse('2026-10-27T16:00:00Z')), 'bitcoin-up-or-down-october-27-2026-12pm-et');
  // After DST ends (Nov 1 2026) New York is UTC-5.
  assert.equal(slugForHour(Date.parse('2026-11-03T20:00:00Z')), 'bitcoin-up-or-down-november-3-2026-3pm-et');
});

test('taker fee = shares × rate × p × (1 − p)', () => {
  assert.equal(takerFee(100, 0.5, 0.07), 1.75);
});

test('market buy walks the asks from the cheapest level', () => {
  const asks = [
    { price: '0.99', size: '1000' },
    { price: '0.52', size: '5' },
    { price: '0.51', size: '4' },
  ];
  const f = fillFromAsks(asks, 5, 0.07)!;
  // 4 shares @0.51 = 2.04, then 2.96/0.52 = 5.692 shares, capped at 5 → 2.60, then rest at 0.99
  assert.equal(f.bestAsk, 0.51);
  assert.ok(f.avgPrice > 0.51 && f.avgPrice < 0.6);
  // 9.3636 shares are booked as 9.36, so the cost is those 9.36 shares at the average price, just under $5.
  assert.equal(f.shares, 9.36);
  assert.ok(f.cost <= 5 && f.cost > 4.99);
  assert.ok(Math.abs(f.cost - f.shares * f.avgPrice) < 1e-4);
  assert.ok(f.fee > 0);
});

test('5m and 15m slugs use the window start in unix seconds', async () => {
  const { slugFor } = await import('./polymarket.ts');
  assert.equal(slugFor('15m', Date.parse('2026-10-27T19:00:00Z')), 'btc-updown-15m-1793127600');
  assert.equal(slugFor('5m', Date.parse('2026-10-27T19:00:00Z')), 'btc-updown-5m-1793127600');
});
