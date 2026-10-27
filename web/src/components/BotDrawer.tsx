import { useEffect, useState } from 'react';
import type { Bot, Trade } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { cents, duration, hourSpan, money, pct, pktStamp, signed, tone } from '../format.ts';
import { HitChips } from './BotCard.tsx';
import { Sparkline } from './Sparkline.tsx';
import { CalendarPage } from '../pages/Calendar.tsx';
import { TF_LABEL } from '../../../shared/types.ts';

function candleColor(t: Trade) {
  if (t.status === 'open') return null;
  const up = (t.status === 'won') === (t.side === 'UP');
  return up ? 'green' : 'red';
}

export function BotDrawer({ bot, strategyName, onClose }: { bot: Bot; strategyName: string; onClose: () => void }) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [limit, setLimit] = useState(200);
  const [tab, setTab] = useState<'overview' | 'trades' | 'hourly'>('overview');
  const s = bot.stats;

  useEffect(() => {
    api.trades(bot.id, limit).then(setTrades).catch(() => setTrades([]));
  }, [bot.id, limit, s.trades, s.open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kv: [string, React.ReactNode][] = [
    ['Realized', <span className={tone(s.realized)}>{signed(s.realized)}</span>],
    ['Balance', money(bot.balance)],
    ['Win rate', `${pct(s.winRate, 1)} · ${s.wins}/${s.trades}`],
    ['Max drawdown', `${money(s.maxDrawdown)} · ${pct(s.maxDrawdownPct)}`],
    ['Gross won', <span className="up">{signed(s.grossWin)}</span>],
    ['Gross lost', <span className="down">{signed(s.grossLoss)}</span>],
    ['Peak balance', money(s.peakBalance)],
    ['Largest stake', money(s.largestStake)],
    ['Best win streak', `W${s.bestWin}`],
    ['Worst loss streak', `L${s.worstLoss}`],
    ['Runtime (live)', duration(bot.runMs)],
    ['Trading span', hourSpan(s.firstHour, s.lastHour)],
  ];

  return (
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label={`${bot.name} details`}>
        <div className="dialog-head">
          <div>
            <h2>{bot.name}</h2>
            <div className="mono muted" style={{ fontSize: 12, marginTop: 3 }}>
              {strategyName} · BTC {TF_LABEL[bot.timeframe]} · lot {money(bot.baseLot)} · max {cents(bot.maxEntryPrice)}
              {bot.martingale.enabled && ` · MG ×${bot.martingale.multiplier}${bot.martingale.resetAfter ? ` reset L${bot.martingale.resetAfter}` : ''}`}
            </div>
          </div>
          <button className="btn sm icon ghost" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.6">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </div>
        <div className="tabs" role="tablist">
          {(['overview', 'trades', 'hourly'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'overview' ? 'Stats' : t === 'trades' ? 'History' : 'Hourly PnL'}
            </button>
          ))}
        </div>
        <div className="drawer-body">
          {tab === 'overview' && (
            <>
          <div className="panel" style={{ padding: 14 }}>
            <div className="label" style={{ marginBottom: 10 }}>Balance curve</div>
            <Sparkline values={s.equity} base={bot.startBalance} className="spark-lg" />
          </div>
          <div className="kv">
            {kv.map(([k, v]) => (
              <div key={k}>
                <div className="label">{k}</div>
                <div className="v">{v}</div>
              </div>
            ))}
          </div>
          <div className="panel" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="label">Streak hits (how many times each streak length happened)</div>
            <div className="hits-row">
              <span className="label" style={{ width: 52 }}>Wins</span>
              <HitChips hits={s.winHits} kind="W" min={1} max={20} />
            </div>
            <div className="hits-row">
              <span className="label" style={{ width: 52 }}>Losses</span>
              <HitChips hits={s.lossHits} kind="L" min={1} max={20} />
            </div>
          </div>
            </>
          )}
          {tab === 'trades' && (
          <div>
            <div className="label" style={{ marginBottom: 10 }}>Trades · newest first</div>
            <div className="table-scroll">
              <table className="trades">
                <thead>
                  <tr>
                    <th>Hour (PKT)</th>
                    <th>Bet</th>
                    <th>Candle</th>
                    <th className="r">Cost</th>
                    <th className="r">Shares @ price</th>
                    <th className="r">Fee</th>
                    <th>Result</th>
                    <th className="r">PnL</th>
                    <th className="r">Balance</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {trades?.map((t) => {
                    const cc = candleColor(t);
                    return (
                      <tr key={t.id}>
                        <td>
                          {pktStamp(t.hourTs)} {t.backtest && <span className="chip" style={{ height: 18, marginLeft: 4 }}>BT</span>}
                        </td>
                        <td className={t.side === 'UP' ? 'up' : 'down'}>{t.side}</td>
                        <td className={cc === 'green' ? 'up' : cc === 'red' ? 'down' : 'muted'}>{cc ?? '—'}</td>
                        <td className="r">
                          {money(t.stake)}
                          {t.mgStep > 0 && <span className="muted"> L{t.mgStep}</span>}
                        </td>
                        <td className="r">
                          {t.shares ?? '—'} @ {cents(t.price)}
                        </td>
                        <td className="r muted">{money(t.fee)}</td>
                        <td>
                          {t.status === 'open' ? (
                            <span className="chip warn">OPEN</span>
                          ) : (
                            <span className={t.status === 'won' ? 'up' : 'down'} title={t.confirmed ? 'Confirmed by Polymarket resolution' : 'From the Binance candle; waiting for Polymarket to resolve'}>
                              {t.status.toUpperCase()}
                              {!t.confirmed && <span className="muted"> · pending</span>}
                            </span>
                          )}
                          {t.url && (
                            <a href={t.url} target="_blank" rel="noreferrer" className="muted" style={{ marginLeft: 8 }} title="Open on Polymarket">
                              ↗
                            </a>
                          )}
                        </td>
                        <td className={`r ${tone(t.pnl ?? 0)}`}>{t.pnl === null ? '—' : signed(t.pnl)}</td>
                        <td className="r">{t.balanceAfter === null ? '—' : money(t.balanceAfter)}</td>
                        <td className="muted">{t.reason}</td>
                      </tr>
                    );
                  })}
                  {trades && !trades.length && (
                    <tr>
                      <td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                        {bot.backfillPending ? 'Downloading Polymarket history for the replay. This takes a few minutes the first time.' : 'No trades yet. The bot enters at the start of the next hour when its rule fires.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {trades && trades.length === limit && (
              <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setLimit((l) => l + 300)}>
                Load more
              </button>
            )}
          </div>
          )}
          {tab === 'hourly' && <CalendarPage botId={bot.id} />}
        </div>
      </aside>
    </div>
  );
}
