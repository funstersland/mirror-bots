import { HOUR_MS, PKT_OFFSET_MS } from '../../shared/types.ts';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const money = (n: number) => usd.format(n);
export const moneyShort = (n: number) => (Math.abs(n) >= 10_000 ? usd0.format(n) : usd.format(n));
export const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + usd.format(Math.abs(n));
export const pct = (n: number, d = 0) => `${(n * 100).toFixed(d)}%`;
export const cents = (p: number) => `${(p * 100).toFixed(Math.abs(p * 100 - Math.round(p * 100)) < 0.05 ? 0 : 1)}¢`;
export const tone = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

/** Shift a UTC ms timestamp so its UTC fields read as Pakistan time (UTC+5, no DST). */
const pk = (ts: number) => new Date(ts + PKT_OFFSET_MS);
const p2 = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const pktDate = (ts: number) => {
  const d = pk(ts);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
};
export const pktHour = (ts: number) => `${p2(pk(ts).getUTCHours())}:00`;
export const pktClock = (ts: number) => {
  const d = pk(ts);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
};
export const pktStamp = (ts: number) => {
  const d = pk(ts);
  return `${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCHours())}:00`;
};
export const prettyDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

export function duration(ms: number) {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return `${d}d ${h}h ${mm}m`;
  if (h) return `${h}h ${mm}m`;
  return `${mm}m`;
}

export const hourSpan = (first: number | null, last: number | null) =>
  first !== null && last !== null ? duration(last - first + HOUR_MS) : '—';

export function addDays(iso: string, n: number) {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function datesBetween(a: string, b: string) {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const todayPkt = () => pktDate(Date.now());
