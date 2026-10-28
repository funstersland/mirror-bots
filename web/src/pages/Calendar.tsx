import { useEffect, useMemo, useState } from 'react';
import type { DayBucket, HourBucket, Timeframe } from '../../../shared/types.ts';
import { PKT_OFFSET_MS, TF_LABEL, TIMEFRAMES } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { HourlyChart } from '../components/HourlyChart.tsx';
import { addDays, datesBetween, prettyDate, signed, todayPkt, tone } from '../format.ts';
import { useFleet } from '../store.tsx';

const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthCells(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

function describe(dates: string[]) {
  if (!dates.length) return 'No dates selected';
  if (dates.length === 1) return prettyDate(dates[0]);
  const sorted = [...dates].sort();
  const contiguous = datesBetween(sorted[0], sorted[sorted.length - 1]).length === sorted.length;
  return contiguous
    ? `${prettyDate(sorted[0])} → ${prettyDate(sorted[sorted.length - 1])} · ${sorted.length} days`
    : `${sorted.length} dates selected`;
}

export function CalendarPage({ botId }: { botId?: number } = {}) {
  const { bots: allBots } = useFleet();
  const [tf, setTf] = useState<Timeframe | ''>('');
  const bots = useMemo(() => allBots?.filter((b) => (botId ? b.id === botId : !tf || b.timeframe === tf)) ?? null, [allBots, tf, botId]);
  const today = todayPkt();
  const [cursor, setCursor] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const [selected, setSelected] = useState<Set<string>>(() => new Set([today]));
  const [anchor, setAnchor] = useState<string | null>(today);
  const [pickedIds, setBotIds] = useState<number[]>([]);
  const botIds = useMemo(() => (botId ? [botId] : pickedIds.filter((id) => bots?.some((b) => b.id === id))), [botId, pickedIds, bots]);
  const liveOnly = true;
  const [view, setView] = useState<'split' | 'net'>('split');
  const [days, setDays] = useState<Map<string, DayBucket>>(new Map());
  const [hours, setHours] = useState<HourBucket[] | null>(null);

  const cells = useMemo(() => monthCells(cursor.y, cursor.m), [cursor]);
  const dates = useMemo(() => [...selected].sort(), [selected]);

  // Day totals for the visible month (tints the calendar cells).
  useEffect(() => {
    const from = cells.find(Boolean)!;
    const to = [...cells].reverse().find(Boolean)!;
    api
      .days(from, to, botIds, liveOnly, tf)
      .then((rows) => setDays(new Map(rows.map((r) => [r.date, r]))))
      .catch(() => {});
  }, [cells, botIds, liveOnly, bots, tf]);

  useEffect(() => {
    if (!dates.length) return setHours(null);
    api
      .hourly(dates, botIds, liveOnly, tf)
      .then((r) => setHours(r.hours))
      .catch(() => setHours(null));
  }, [dates, botIds, liveOnly, bots, tf]);

  function clickDay(d: string, shift: boolean) {
    if (d > today) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchor) {
        for (const x of datesBetween(anchor, d)) if (x <= today) next.add(x);
      } else if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
    setAnchor(d);
  }

  function preset(n: number | 'all' | 'yesterday') {
    if (n === 'yesterday') return setSelected(new Set([addDays(today, -1)]));
    if (n === 'all') {
      const first = Math.min(...(bots ?? []).map((b) => b.stats.firstHour ?? Infinity));
      const start = Number.isFinite(first) ? new Date(first + PKT_OFFSET_MS).toISOString().slice(0, 10) : today;
      return setSelected(new Set(datesBetween(start, today)));
    }
    setSelected(new Set(datesBetween(addDays(today, -(n - 1)), today)));
  }

  const totals = hours?.reduce(
    (a, h) => ({ net: a.net + h.net, gain: a.gain + h.gain, loss: a.loss + h.loss, wins: a.wins + h.wins, losses: a.losses + h.losses }),
    { net: 0, gain: 0, loss: 0, wins: 0, losses: 0 },
  );
  const greenHours = hours?.filter((h) => h.net > 0).length ?? 0;
  const redHours = hours?.filter((h) => h.net < 0).length ?? 0;
  const nowHourPkt = new Date(Date.now() + PKT_OFFSET_MS).getUTCHours();
  const monthNet = [...days.values()].reduce((a, d) => a + d.net, 0);

  function shiftMonth(delta: number) {
    setCursor(({ y, m }) => {
      const t = new Date(Date.UTC(y, m + delta, 1));
      return { y: t.getUTCFullYear(), m: t.getUTCMonth() };
    });
  }

  return (
    <>
      {!botId && (
        <>
          <div className="page-head">
            <div>
              <h1>Hourly PnL</h1>
              <p>Net result per hour of the day in Pakistan time, added up across the dates you pick.</p>
            </div>
          </div>
          <div className="tf-bar">
            <div className="seg" aria-label="Market">
              <button className={tf === '' ? 'on' : ''} onClick={() => setTf('')}>All markets</button>
              {TIMEFRAMES.map((t) => (
                <button key={t} className={tf === t ? 'on' : ''} onClick={() => setTf(t)}>
                  {TF_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="cal-layout">
        <div className="panel cal">
          <div className="cal-head">
            <button className="btn sm icon ghost" onClick={() => shiftMonth(-1)} aria-label="Previous month">
              ‹
            </button>
            <div style={{ textAlign: 'center' }}>
              <div className="m">
                {MONTHS[cursor.m]} {cursor.y}
              </div>
              <div className={`mono ${tone(monthNet)}`} style={{ fontSize: 11.5 }}>
                {days.size ? `${signed(monthNet)} month` : 'no trades'}
              </div>
            </div>
            <button className="btn sm icon ghost" onClick={() => shiftMonth(1)} aria-label="Next month">
              ›
            </button>
          </div>
          <div className="cal-grid">
            {DOW.map((d) => (
              <div key={d} className="dow">
                {d}
              </div>
            ))}
            {cells.map((d, i) =>
              d ? (
                <button
                  key={d}
                  className={[
                    'day',
                    selected.has(d) && 'sel',
                    d > today && 'future',
                    d === today && 'today',
                    (days.get(d)?.net ?? 0) > 0 && 'pos',
                    (days.get(d)?.net ?? 0) < 0 && 'neg',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={(e) => clickDay(d, e.shiftKey)}
                  title={days.get(d) ? `${prettyDate(d)}: ${signed(days.get(d)!.net)} over ${days.get(d)!.trades} trades` : prettyDate(d)}
                  aria-pressed={selected.has(d)}
                >
                  {Number(d.slice(8))}
                  <span className="bar" />
                </button>
              ) : (
                <div key={`x${i}`} className="day out" />
              ),
            )}
          </div>
          <div className="presets">
            <button className="btn sm" onClick={() => preset(1)}>Today</button>
            <button className="btn sm" onClick={() => preset('yesterday')}>Yesterday</button>
            <button className="btn sm" onClick={() => preset(7)}>7 days</button>
            <button className="btn sm" onClick={() => preset(30)}>30 days</button>
            <button className="btn sm" onClick={() => preset(90)}>90 days</button>
            <button className="btn sm" onClick={() => preset(365)}>1 year</button>
            <button className="btn sm" onClick={() => preset('all')}>All</button>
          </div>
          <div className="cal-foot">
            <span>{describe(dates)}</span>
            {selected.size > 0 && (
              <button className="btn sm ghost" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Click days to add or remove them. Shift-click selects a range.
          </div>
        </div>

        <div className="panel chart-panel">
          <div className="chart-head">
            <div>
              <h2>{describe(dates)}</h2>
              <div className="sub">
                {botId ? 'This bot' : botIds.length ? `${botIds.length} bot${botIds.length > 1 ? 's' : ''}` : `All ${tf ? TF_LABEL[tf] + ' ' : ''}bots`} · live trades
              </div>
            </div>
            {totals && (
              <div className="totals">
                <div>
                  <div className="label">Net</div>
                  <div className={`v ${tone(totals.net)}`}>{signed(totals.net)}</div>
                </div>
                <div>
                  <div className="label">Green hours</div>
                  <div className="v up">{greenHours}</div>
                </div>
                <div>
                  <div className="label">Red hours</div>
                  <div className="v down">{redHours}</div>
                </div>
                <div>
                  <div className="label">W / L</div>
                  <div className="v">
                    {totals.wins} / {totals.losses}
                  </div>
                </div>
              </div>
            )}
          </div>

          {!botId && <div className="toolbar" style={{ marginBottom: 6 }}>
            <div className="bot-filter">
              <button className={!botIds.length ? 'on' : ''} onClick={() => setBotIds([])}>
                All bots
              </button>
              {bots?.map((b) => (
                <button
                  key={b.id}
                  className={botIds.includes(b.id) ? 'on' : ''}
                  onClick={() => setBotIds((ids) => (ids.includes(b.id) ? ids.filter((x) => x !== b.id) : [...ids, b.id]))}
                >
                  {b.name} <span className="muted">{TF_LABEL[b.timeframe]}{b.mirrorOf ? " inv" : ""}</span>
                </button>
              ))}
            </div>
          </div>}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '6px 0' }}>
            <div className="legend" style={{ margin: 0 }}>
              {view === 'split' ? (
                <>
                  <span><i style={{ background: 'var(--up)' }} /> Won in hour</span>
                  <span><i style={{ background: 'var(--down)' }} /> Lost in hour</span>
                  <span><i className="line" /> Net</span>
                </>
              ) : (
                <>
                  <span><i style={{ background: 'var(--up)' }} /> Net up</span>
                  <span><i style={{ background: 'var(--down)' }} /> Net down</span>
                </>
              )}
            </div>
            <div className="seg">
              <button className={view === 'split' ? 'on' : ''} onClick={() => setView('split')}>Won + lost</button>
              <button className={view === 'net' ? 'on' : ''} onClick={() => setView('net')}>Net only</button>
            </div>
          </div>
          {hours ? (
            <HourlyChart hours={hours} mode={view} currentHour={dates.includes(today) ? nowHourPkt : undefined} />
          ) : (
            <div className="muted" style={{ padding: '80px 0', textAlign: 'center' }}>
              Pick one or more dates on the calendar.
            </div>
          )}

          {hours && (
            <details style={{ marginTop: 12 }}>
              <summary className="label" style={{ cursor: 'pointer', padding: '6px 0' }}>Show as table</summary>
              <div className="table-scroll" style={{ marginTop: 8 }}>
                <table className="trades">
                  <thead>
                    <tr>
                      <th>Hour PKT</th>
                      <th className="r">Trades</th>
                      <th className="r">W / L</th>
                      <th className="r">Won</th>
                      <th className="r">Lost</th>
                      <th className="r">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hours.map((h) => (
                      <tr key={h.hour}>
                        <td>{String(h.hour).padStart(2, '0')}:00</td>
                        <td className="r">{h.trades}</td>
                        <td className="r">
                          {h.wins} / {h.losses}
                        </td>
                        <td className="r up">{signed(h.gain)}</td>
                        <td className="r down">{signed(h.loss)}</td>
                        <td className={`r ${tone(h.net)}`}>{signed(h.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      </div>
    </>
  );
}
