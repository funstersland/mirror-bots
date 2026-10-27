import { useEffect, useRef, useState } from 'react';
import type { HourBucket } from '../../../shared/types.ts';
import { signed } from '../format.ts';

const H = 300;
const PAD = { top: 16, right: 8, bottom: 26, left: 52 };

function niceStep(max: number) {
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const short = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : a.toFixed(0);
  return `${v < 0 ? '−' : ''}$${s}`;
};

export function HourlyChart({ hours, currentHour, mode = 'split' }: { hours: HourBucket[]; currentHour?: number; mode?: 'split' | 'net' }) {
  const net = mode === 'net';
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = Math.max(1, ...hours.map((h) => (net ? Math.abs(h.net) : Math.max(h.gain, -h.loss, Math.abs(h.net)))));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const plotW = w - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH * (1 - (v + top) / (2 * top));
  const col = plotW / 24;
  const bw = Math.max(4, Math.min(26, col * 0.62));
  const cx = (i: number) => PAD.left + col * i + col / 2;
  const ticks: number[] = [];
  for (let v = -top; v <= top + 1e-9; v += step) ticks.push(v);
  const narrow = w < 560;

  const linePath = hours.map((h, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(h.net).toFixed(1)}`).join('');
  const hb = hover !== null ? hours[hover] : null;
  const best = hours.reduce((a, b) => (b.net > a.net ? b : a), hours[0]);
  const worst = hours.reduce((a, b) => (b.net < a.net ? b : a), hours[0]);

  return (
    <div className="hchart" ref={wrap} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${w} ${H}`} height={H} role="img" aria-label="Net PnL by hour of day, Pakistan time">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={w - PAD.right} y1={y(v)} y2={y(v)} stroke={v === 0 ? '#3a4352' : '#1c212a'} strokeDasharray={v === 0 ? undefined : '2 4'} />
            <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fill="#6b7482" fontSize="10.5" fontFamily="IBM Plex Mono">
              {short(v)}
            </text>
          </g>
        ))}
        {hours.map((h, i) => {
          const x = cx(i) - bw / 2;
          const gH = y(0) - y(net ? Math.max(h.net, 0) : h.gain);
          const lH = y(net ? Math.min(h.net, 0) : h.loss) - y(0);
          const dim = hover !== null && hover !== i;
          return (
            <g key={h.hour} opacity={dim ? 0.45 : 1}>
              {hover === i && <rect x={PAD.left + col * i} y={PAD.top} width={col} height={plotH} fill="#ffffff" opacity="0.03" />}
              {currentHour === i && <rect x={PAD.left + col * i} y={PAD.top} width={col} height={plotH} fill="none" stroke="#d9f99d" strokeOpacity="0.35" strokeDasharray="2 3" />}
              {gH > 0.5 && <rect x={x} y={y(0) - gH} width={bw} height={gH - 1} rx={Math.min(3, bw / 4)} fill="var(--up)" />}
              {lH > 0.5 && <rect x={x} y={y(0) + 1} width={bw} height={lH - 1} rx={Math.min(3, bw / 4)} fill="var(--down)" />}
              {(!narrow || i % 3 === 0) && (
                <text x={cx(i)} y={H - 8} textAnchor="middle" fill={currentHour === i ? '#d9f99d' : '#6b7482'} fontSize="10.5" fontFamily="IBM Plex Mono">
                  {String(h.hour).padStart(2, '0')}
                </text>
              )}
            </g>
          );
        })}
        {!net && <path d={linePath} fill="none" stroke="#e7e9ee" strokeWidth="2" strokeLinejoin="round" opacity="0.9" />}
        {!net && hours.map((h, i) => (
          <circle key={h.hour} cx={cx(i)} cy={y(h.net)} r={hover === i ? 5 : 3} fill="#e7e9ee" stroke="var(--panel)" strokeWidth="2" />
        ))}
        {!narrow && best && best.net > 0 && hover === null && (
          <text x={cx(best.hour)} y={Math.min(y(best.net), y(net ? best.net : best.gain)) - 8} textAnchor="middle" fill="#a3abb8" fontSize="10.5" fontFamily="IBM Plex Mono">
            {signed(best.net)}
          </text>
        )}
        {!narrow && worst && worst.net < 0 && hover === null && (
          <text x={cx(worst.hour)} y={Math.max(y(worst.net), y(net ? worst.net : worst.loss)) + 16} textAnchor="middle" fill="#a3abb8" fontSize="10.5" fontFamily="IBM Plex Mono">
            {signed(worst.net)}
          </text>
        )}
        {hours.map((h, i) => (
          <rect key={h.hour} x={PAD.left + col * i} y={0} width={col} height={H} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
        ))}
      </svg>
      {hb && (
        <div className="tip" style={{ left: Math.min(Math.max(cx(hover!), 90), w - 90), top: Math.min(y(Math.max(hb.gain, hb.net)), y(0)) }}>
          <div className="t">
            {String(hb.hour).padStart(2, '0')}:00–{String((hb.hour + 1) % 24).padStart(2, '0')}:00 PKT
          </div>
          <div className="row">
            <span>Net</span>
            <span className={hb.net > 0 ? 'up' : hb.net < 0 ? 'down' : ''}>{signed(hb.net)}</span>
          </div>
          <div className="row">
            <span>Won</span>
            <span className="up">{signed(hb.gain)}</span>
          </div>
          <div className="row">
            <span>Lost</span>
            <span className="down">{signed(hb.loss)}</span>
          </div>
          <div className="row">
            <span>W / L</span>
            <span>
              {hb.wins} / {hb.losses}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
