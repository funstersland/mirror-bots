import { useEffect, useState, type FormEvent } from 'react';
import { api, type User } from '../api.ts';
import { Logo } from '../components/Shell.tsx';

// Decorative: a static 24-hour PnL profile drawn the same way as the real chart.
const ART = [12, 19, -6, -14, 16, 7, 11, -4, -3, 6, 9, -16, -9, -12, -22, 4, -7, 13, 3, 5, -11, 15, -5, 2];

function HourArt() {
  const w = 560;
  const h = 260;
  const mid = h / 2;
  const step = w / ART.length;
  return (
    <svg viewBox={`0 0 ${w} ${h + 24}`} aria-hidden>
      {[0.25, 0.75].map((f) => (
        <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke="#1c212a" strokeDasharray="2 4" />
      ))}
      <line x1="0" x2={w} y1={mid} y2={mid} stroke="#2e3542" />
      {ART.map((v, i) => {
        const bh = Math.abs(v) * 5;
        const x = i * step + step * 0.2;
        return (
          <g key={i}>
            <rect x={x} y={v > 0 ? mid - bh : mid} width={step * 0.6} height={bh} rx="2" fill={v > 0 ? '#26a69a' : '#ef5350'} opacity={0.85} />
            {i % 3 === 0 && (
              <text x={x + step * 0.3} y={h + 18} textAnchor="middle" fill="#6b7482" fontSize="10" fontFamily="IBM Plex Mono">
                {String(i).padStart(2, '0')}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function AuthPage({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [allowSignup, setAllowSignup] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.authConfig().then((c) => setAllowSignup(c.allowSignup)).catch(() => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = mode === 'login' ? await api.login(email, password) : await api.signup(name, email, password);
      onAuthed(r.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <section className="auth-art">
        <div className="brand">
          <Logo /> Polybots
        </div>
        <div className="art">
          <div style={{ width: '100%' }}>
            <h1>Run a fleet of rule-based bots on Bitcoin's hourly markets.</h1>
            <p>Every bot trades Polymarket's BTC Up/Down hour on its own rule. Compare them hour by hour, in Pakistan time.</p>
            <div style={{ marginTop: 36 }}>
              <HourArt />
            </div>
          </div>
        </div>
        <div className="specs">
          <div>
            <div className="label">Market</div>
            <div className="v">BTC · 1H</div>
          </div>
          <div>
            <div className="label">Strategies</div>
            <div className="v">15</div>
          </div>
          <div>
            <div className="label">Mode</div>
            <div className="v">Paper</div>
          </div>
        </div>
      </section>
      <section className="auth-form">
        <form className="auth-card" onSubmit={submit}>
          <div className="brand" style={{ marginBottom: 8 }}>
            <Logo /> Polybots
          </div>
          <div>
            <h2>{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
            {allowSignup && (
              <div className="sw" style={{ marginTop: 6 }}>
                {mode === 'login' ? 'New here? ' : 'Have an account? '}
                <button type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}>
                  {mode === 'login' ? 'Create an account' : 'Sign in'}
                </button>
              </div>
            )}
          </div>
          {mode === 'signup' && (
            <label className="field">
              <span className="label">Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </label>
          )}
          <label className="field">
            <span className="label">Email</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
          <label className="field">
            <span className="label">Password</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'signup' ? 8 : undefined}
              required
            />
            {mode === 'signup' && <span className="hint">At least 8 characters.</span>}
          </label>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </section>
    </div>
  );
}
