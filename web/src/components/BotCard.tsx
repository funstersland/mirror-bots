import { useEffect, useRef, useState } from 'react';
import type { Bot, StrategyInfo, StreakHit } from '../../../shared/types.ts';
import { TF_LABEL } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { cents, duration, money, pct, pktHour, signed, tone } from '../format.ts';
import { useFleet } from '../store.tsx';
import { Sparkline } from './Sparkline.tsx';

export function HitChips({ hits, kind, min = 2, max = 6 }: { hits: StreakHit[]; kind: 'W' | 'L'; min?: number; max?: number }) {
  const shown = hits.filter((h) => h.len >= min);
  if (!shown.length) return <span className="muted mono" style={{ fontSize: 12 }}>none yet</span>;
  const extra = shown.length - max;
  return (
    <>
      {shown.slice(0, max).map((h) => (
        <span key={h.len} className={`chip ${kind === 'W' ? 'up' : 'down'}`} title={`${h.count} time${h.count > 1 ? 's' : ''} a ${h.len}-${kind === 'W' ? 'win' : 'loss'} streak`}>
          {kind}{h.len}×{h.count}
        </span>
      ))}
      {extra > 0 && <span className="chip">+{extra}</span>}
    </>
  );
}

function MoreMenu({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const { refresh, remove, toast } = useFleet();
  const ref = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);
  return (
    <div className="menu-pop" ref={ref} style={{ bottom: 'calc(100% + 6px)', top: 'auto' }}>
      <button
        onClick={async () => {
          const b = await api.botAction(bot.id, 'clone');
          await refresh();
          toast(`Cloned as “${b.name}”`);
          onClose();
        }}
      >
        Clone bot
      </button>
      {!confirmDelete ? (
        <button className="danger" onClick={() => setConfirmDelete(true)}>
          Delete bot…
        </button>
      ) : (
        <button
          className="danger"
          onClick={async () => {
            await api.deleteBot(bot.id);
            remove(bot.id);
            if (!bot.mirrorOf) await refresh(); // its inverse twin goes too
            toast(`Deleted “${bot.name}”`);
          }}
        >
          Confirm delete
        </button>
      )}
    </div>
  );
}

interface Props {
  bot: Bot;
  strategy?: StrategyInfo;
  onSettings: () => void;
  onReset: () => void;
  onTrades: () => void;
}

export function BotCard({ bot, strategy, onSettings, onReset, onTrades }: Props) {
  const { upsert, toast } = useFleet();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const s = bot.stats;
  const pnl = bot.balance - bot.startBalance;
  const mg = bot.martingale;

  async function toggle() {
    setBusy(true);
    try {
      upsert(await api.botAction(bot.id, bot.status === 'running' ? 'pause' : 'resume'));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', true);
    } finally {
      setBusy(false);
    }
  }

  const streak = s.current.kind ? `${s.current.kind}${s.current.len}` : '—';

  return (
    <article
      className={`card clickable ${bot.status}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a, .menu-pop')) return;
        onTrades();
      }}
    >
      <div className="card-head">
        <div className="titles">
          <h3 title={bot.name}>{bot.name}</h3>
          <div className="sub">
            {strategy && strategy.name !== bot.name ? strategy.name : (strategy?.family ?? bot.strategy)} · BTC {TF_LABEL[bot.timeframe]}{bot.params.invert ? ' · flipped' : ''}
          </div>
        </div>
        {bot.mirrorOf && <span className="chip inv" title="Takes the opposite side of the original bot's signal">INVERSE</span>}
        <span className="chip tf">{TF_LABEL[bot.timeframe]}</span>
        <span className={`status ${bot.status}`}>
          <i />
          {bot.status}
        </span>
      </div>

      <div className="card-pnl">
        <div>
          <div className="label">Realized PnL</div>
          <div className={`big ${tone(pnl)}`} style={{ marginTop: 8 }}>{signed(pnl)}</div>
          <div className="bal">
            Balance <span style={{ color: 'var(--text)' }}>{money(bot.balance)}</span> / {money(bot.startBalance)}
          </div>
        </div>
        <Sparkline values={s.equity} base={bot.startBalance} />
      </div>

      <div className="stats">
        <div>
          <div className="label">Lot</div>
          <div className="v">
            {money(bot.baseLot)}
            {mg.enabled && bot.nextStake !== bot.baseLot && <span className="dim"> → {money(bot.nextStake)}</span>}
          </div>
        </div>
        <div>
          <div className="label">Record</div>
          <div className="v">
            {s.wins}W {s.losses}L · {pct(s.winRate)}
          </div>
        </div>
        <div>
          <div className="label">Streak</div>
          <div className={`v ${s.current.kind === 'W' ? 'up' : s.current.kind === 'L' ? 'down' : ''}`}>
            {streak} <span className="dim">· W{s.bestWin}/L{s.worstLoss}</span>
          </div>
        </div>
        <div>
          <div className="label">Max DD</div>
          <div className="v">
            {money(s.maxDrawdown)} <span className="dim">{pct(s.maxDrawdownPct)}</span>
          </div>
        </div>
        <div>
          <div className="label">Runtime</div>
          <div className="v">{duration(bot.runMs)}</div>
        </div>
        <div>
          <div className="label">Martingale</div>
          <div className="v">
            {mg.enabled ? (
              <>
                ×{mg.multiplier} <span className="dim">· {mg.resetAfter ? `reset L${mg.resetAfter}` : 'no reset'}</span>
              </>
            ) : (
              <span className="dim">off</span>
            )}
          </div>
        </div>
      </div>

      <div className="hits">
        <div className="hits-row">
          <span className="label">Loss hits</span>
          <HitChips hits={s.lossHits} kind="L" />
        </div>
        <div className="hits-row">
          <span className="label">Win hits</span>
          <HitChips hits={s.winHits} kind="W" />
        </div>
      </div>


      {bot.openTrade && (
        <div className="open-pos">
          <span className="chip warn">OPEN</span>
          <b className={bot.openTrade.side === 'UP' ? 'up' : 'down'}>{bot.openTrade.side}</b>
          <span>
            {bot.openTrade.shares} sh @ {cents(bot.openTrade.price)} · {money(bot.openTrade.stake)}
          </span>
          <span className="muted">{pktHour(bot.openTrade.hourTs)} PKT</span>
        </div>
      )}

      <div className="card-foot">
        <button className={`btn sm ${bot.status === 'running' ? '' : 'primary'}`} onClick={toggle} disabled={busy}>
          {bot.status === 'running' ? 'Pause' : 'Resume'}
        </button>
        <button className="btn sm" onClick={onSettings}>
          Settings
        </button>
        <button className="btn sm danger" onClick={onReset}>
          Reset
        </button>
        <span className="spacer" />
        <button className="btn sm icon ghost" onClick={onTrades} title="Trade log" aria-label="Trade log">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 4h10M3 8h10M3 12h6" />
          </svg>
        </button>
        <div className="menu">
          <button className="btn sm icon ghost" onClick={() => setMenu((m) => !m)} aria-label="More">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="3" cy="8" r="1.4" />
              <circle cx="8" cy="8" r="1.4" />
              <circle cx="13" cy="8" r="1.4" />
            </svg>
          </button>
          {menu && <MoreMenu bot={bot} onClose={() => setMenu(false)} />}
        </div>
      </div>
    </article>
  );
}
