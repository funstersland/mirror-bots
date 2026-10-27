export function Sparkline({ values, base, className = 'spark' }: { values: number[]; base: number; className?: string }) {
  const w = 132;
  const h = 40;
  if (values.length < 2) {
    return (
      <svg className={className} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <line x1="0" x2={w} y1={h / 2} y2={h / 2} stroke="#2e3542" strokeDasharray="2 3" />
      </svg>
    );
  }
  const min = Math.min(base, ...values);
  const max = Math.max(base, ...values);
  const span = max - min || 1;
  const y = (v: number) => 3 + (h - 6) * (1 - (v - min) / span);
  const x = (i: number) => (i / (values.length - 1)) * w;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const up = values[values.length - 1] >= base;
  const color = up ? 'var(--up)' : 'var(--down)';
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label={`Balance curve, ${up ? 'above' : 'below'} start`}>
      <line x1="0" x2={w} y1={y(base)} y2={y(base)} stroke="#2e3542" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      <path d={`${d}L${w},${h}L0,${h}Z`} fill={color} opacity="0.08" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
