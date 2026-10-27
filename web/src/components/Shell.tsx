import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { HOUR_MS } from '../../../shared/types.ts';
import type { User } from '../api.ts';
import { pktClock, pktHour } from '../format.ts';
import { useFleet } from '../store.tsx';

export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 22 22" aria-hidden>
      <rect x="0.5" y="0.5" width="21" height="21" rx="5" fill="none" stroke="#2e3542" />
      <path d="M5 14h3v-4H5zM9.5 17h3V5h-3zM14 12h3V8h-3z" fill="#d9f99d" />
    </svg>
  );
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function FeedPill() {
  const { feed } = useFleet();
  const now = useNow();
  const toNext = HOUR_MS - (now % HOUR_MS);
  const mm = String(Math.floor(toNext / 60000)).padStart(2, '0');
  const ss = String(Math.floor((toNext % 60000) / 1000)).padStart(2, '0');
  const bad = feed && !feed.ok;
  return (
    <div className={`feed ${bad ? 'bad' : ''}`} title={feed?.error ?? 'Market data feed'}>
      <span className="dot" />
      <span className="hide-sm">
        {feed?.source === 'sim' ? 'SIM' : 'BTCUSDT'} <b>{feed?.lastPrice ? feed.lastPrice.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}</b>
      </span>
      <span className="sep hide-sm" />
      <span className="hide-md">
        next <b>{pktHour(now + toNext)}</b> in {mm}:{ss}
      </span>
      <span className="sep hide-md" />
      <span>
        <b>{pktClock(now)}</b> PKT
      </span>
    </div>
  );
}

function UserMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const initials = user.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="menu" ref={ref}>
      <button className="user-btn" onClick={() => setOpen((o) => !o)} aria-label="Account">
        {initials}
      </button>
      {open && (
        <div className="menu-pop">
          <div className="who">
            <div>{user.name}</div>
            <div>{user.email}</div>
          </div>
          <button className="danger" onClick={onLogout}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

const FleetIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
    <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
    <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
    <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
  </svg>
);
const HourIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M2.5 10h15" />
    <path d="M5 10V5M8.5 10V3.5M12 10V7M15.5 10V6" />
    <path d="M6.5 10v3.5M10 10v5M13.5 10v2.5" strokeOpacity=".55" />
  </svg>
);

export function Shell({ user, onLogout, children }: { user: User; onLogout: () => void; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand">
          <Logo />
          Polybots <small>PAPER</small>
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>
            Fleet
          </NavLink>
          <NavLink to="/hourly">Hourly PnL</NavLink>
        </nav>
        <div className="topbar-right">
          <FeedPill />
          <UserMenu user={user} onLogout={onLogout} />
        </div>
      </header>
      <main className="page">{children}</main>
      <nav className="tabbar">
        <NavLink to="/" end>
          <FleetIcon />
          Fleet
        </NavLink>
        <NavLink to="/hourly">
          <HourIcon />
          Hourly PnL
        </NavLink>
      </nav>
    </div>
  );
}
