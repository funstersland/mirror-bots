import { useMemo, useState } from 'react';
import type { Bot, Timeframe } from '../../../shared/types.ts';
import { TF_LABEL, TIMEFRAMES } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { BotCard } from '../components/BotCard.tsx';
import { BotDialog, ResetDialog } from '../components/BotDialog.tsx';
import { BotDrawer } from '../components/BotDrawer.tsx';
import { money, moneyShort, pct, signed, tone } from '../format.ts';
import { useFleet } from '../store.tsx';

const SORTS = {
  profit: { label: 'Top profit', fn: (a: Bot, b: Bot) => b.balance - b.startBalance - (a.balance - a.startBalance) },
  loss: { label: 'Top loss', fn: (a: Bot, b: Bot) => a.balance - a.startBalance - (b.balance - b.startBalance) },
  winStreak: { label: 'Top win streak', fn: (a: Bot, b: Bot) => b.stats.bestWin - a.stats.bestWin || b.stats.winRate - a.stats.winRate },
  lossStreak: { label: 'Top loss streak', fn: (a: Bot, b: Bot) => b.stats.worstLoss - a.stats.worstLoss || a.stats.winRate - b.stats.winRate },
  winRate: { label: 'Win rate', fn: (a: Bot, b: Bot) => b.stats.winRate - a.stats.winRate },
  drawdown: { label: 'Drawdown', fn: (a: Bot, b: Bot) => b.stats.maxDrawdown - a.stats.maxDrawdown },
  newest: { label: 'Newest', fn: (a: Bot, b: Bot) => b.createdAt - a.createdAt },
} as const;
type SortKey = keyof typeof SORTS;

const STATUSES = ['all', 'running', 'paused', 'busted'] as const;
const KINDS = { all: 'Both', original: 'Original', inverse: 'Inverse' } as const;
type Kind = keyof typeof KINDS;
const kindOf = (b: Bot): Kind => (b.mirrorOf ? 'inverse' : 'original');

function Summary({ bots }: { bots: Bot[] }) {
  const start = bots.reduce((a, b) => a + b.startBalance, 0);
  const bal = bots.reduce((a, b) => a + b.balance, 0);
  const wins = bots.reduce((a, b) => a + b.stats.wins, 0);
  const trades = bots.reduce((a, b) => a + b.stats.trades, 0);
  const running = bots.filter((b) => b.status === 'running').length;
  const open = bots.filter((b) => b.openTrade);
  const openStake = open.reduce((a, b) => a + (b.openTrade?.stake ?? 0), 0);
  const best = [...bots].sort(SORTS.profit.fn)[0];
  const profitable = bots.filter((b) => b.balance > b.startBalance).length;
  return (
    <div className="summary">
      <div>
        <div className="label">Fleet balance</div>
        <div className="v">{moneyShort(bal)}</div>
        <div className="s">from {moneyShort(start)}</div>
      </div>
      <div>
        <div className="label">Net PnL</div>
        <div className={`v ${tone(bal - start)}`}>{signed(bal - start)}</div>
        <div className="s">{start ? pct((bal - start) / start, 1) : '—'} on capital</div>
      </div>
      <div>
        <div className="label">Bots</div>
        <div className="v">
          {running}
          <span className="muted"> / {bots.length}</span>
        </div>
        <div className="s">running · {profitable} in profit</div>
      </div>
      <div>
        <div className="label">Win rate</div>
        <div className="v">{trades ? pct(wins / trades, 1) : '—'}</div>
        <div className="s">{trades.toLocaleString()} settled trades</div>
      </div>
      <div>
        <div className="label">Open now</div>
        <div className="v">{open.length}</div>
        <div className="s">open · {money(openStake)} staked</div>
      </div>
      <div>
        <div className="label">Leader</div>
        <div className="v" style={{ fontFamily: 'var(--sans)', fontSize: 16, marginTop: 10 }} title={best?.name}>
          {best?.name ?? '—'}
        </div>
        <div className={`s ${best ? tone(best.balance - best.startBalance) : ''}`}>{best ? signed(best.balance - best.startBalance) : ''}</div>
      </div>
    </div>
  );
}

function EmptyFleet({ onNew }: { onNew: () => void }) {
  const { refresh, toast } = useFleet();
  const [busy, setBusy] = useState(false);
  return (
    <div className="empty">
      <h2>No bots yet</h2>
      <p>
        Start one bot per strategy on each market to see which rules hold up. The starter fleet gives all 15 strategies a bot on the
        BTC 1H, 15M and 5M markets (45 bots), plus an inverse twin of each that takes the opposite side (90 in total), each with $100 and a $5 lot. Bots trade live from now on at Polymarket's real order-book
        prices, so stats build up as windows open and resolve.
      </p>
      <div className="actions">
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.starterFleet({ backfillDays: 0, startBalance: 100, baseLot: 5 });
              await refresh();
              toast(`${r.created} bots started`);
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Failed', true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Starting…' : 'Start the starter fleet'}
        </button>
        <button className="btn" onClick={onNew}>
          Build one bot
        </button>
      </div>
    </div>
  );
}

export function FleetPage() {
  const { bots, strategies } = useFleet();
  const [sort, setSort] = useState<SortKey>('profit');
  const [tf, setTf] = useState<Timeframe | 'all'>('all');
  const [kind, setKind] = useState<Kind>('all');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all');
  const [family, setFamily] = useState('all');
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'edit' | 'reset' | 'trades'; id: number } | null>(null);

  const stratById = useMemo(() => new Map(strategies.map((s) => [s.id, s])), [strategies]);
  const families = useMemo(() => [...new Set(strategies.map((s) => s.family))], [strategies]);

  const shown = useMemo(() => {
    if (!bots) return [];
    const needle = q.trim().toLowerCase();
    return bots
      .filter((b) => tf === 'all' || b.timeframe === tf)
      .filter((b) => kind === 'all' || kindOf(b) === kind)
      .filter((b) => status === 'all' || b.status === status)
      .filter((b) => family === 'all' || stratById.get(b.strategy)?.family === family)
      .filter((b) => !needle || b.name.toLowerCase().includes(needle) || (stratById.get(b.strategy)?.name ?? '').toLowerCase().includes(needle))
      .sort(SORTS[sort].fn);
  }, [bots, tf, kind, status, family, q, sort, stratById]);
  const inTf = useMemo(
    () => bots?.filter((b) => (tf === 'all' || b.timeframe === tf) && (kind === 'all' || kindOf(b) === kind)) ?? [],
    [bots, tf, kind],
  );

  const active = dialog && dialog.kind !== 'new' ? bots?.find((b) => b.id === dialog.id) : undefined;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Fleet</h1>
          <p>Paper trading Polymarket's Bitcoin Up or Down markets (1 hour, 15 minute, 5 minute) at real order-book prices. Each bot enters as its window opens.</p>
        </div>
        <button className="btn primary" onClick={() => setDialog({ kind: 'new' })} disabled={!strategies.length}>
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8">
            <path d="M7 2v10M2 7h10" />
          </svg>
          New bot
        </button>
      </div>

      {bots && bots.length > 0 && (
        <div className="tf-bar">
          <div className="seg" aria-label="Market timeframe">
            <button className={tf === 'all' ? 'on' : ''} onClick={() => setTf('all')}>
              All <span className="muted">{bots.length}</span>
            </button>
            {TIMEFRAMES.map((t) => (
              <button key={t} className={tf === t ? 'on' : ''} onClick={() => setTf(t)}>
                BTC {TF_LABEL[t]} <span className="muted">{bots.filter((b) => b.timeframe === t).length}</span>
              </button>
            ))}
          </div>
          <div className="seg" aria-label="Original or inverse bots">
            {(Object.keys(KINDS) as Kind[]).map((k) => (
              <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {KINDS[k]} {k !== 'all' && <span className="muted">{bots.filter((b) => kindOf(b) === k).length}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {bots && inTf.length > 0 && <Summary bots={inTf} />}

      {bots && bots.length > 0 && (
        <div className="toolbar">
          <div className="seg" role="tablist" aria-label="Sort bots">
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
                {SORTS[k].label}
              </button>
            ))}
          </div>
          <span className="grow" />
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'All statuses' : s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
          <select className="select" value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Strategy family">
            <option value="all">All methods</option>
            {families.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <input className="input search" placeholder="Search bots" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}

      {bots === null ? (
        <div className="muted">Loading…</div>
      ) : bots.length === 0 ? (
        <EmptyFleet onNew={() => setDialog({ kind: 'new' })} />
      ) : shown.length === 0 ? (
        <div className="empty">
          <p style={{ margin: 0 }}>No bots match these filters.</p>
        </div>
      ) : (
        <div className="grid">
          {shown.map((b) => (
            <BotCard
              key={b.id}
              bot={b}
              strategy={stratById.get(b.strategy)}
              onSettings={() => setDialog({ kind: 'edit', id: b.id })}
              onReset={() => setDialog({ kind: 'reset', id: b.id })}
              onTrades={() => setDialog({ kind: 'trades', id: b.id })}
            />
          ))}
        </div>
      )}

      {dialog?.kind === 'new' && <BotDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && active && <BotDialog bot={active} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'reset' && active && <ResetDialog bot={active} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'trades' && active && (
        <BotDrawer bot={active} strategyName={stratById.get(active.strategy)?.name ?? active.strategy} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
