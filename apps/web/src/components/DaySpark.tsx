/**
 * A thin line over seven day slots (Monday to Sunday). Null days, those that have not happened yet, are left empty so the
 * line stops at today. It draws the values and nothing else: no target, no bar, no judgement.
 */
export function DaySpark({ values, label, className = "" }: { values: (number | null)[]; label: string; className?: string }) {
  const W = 280;
  const H = 40;
  const pad = 6;
  const known = values.flatMap((v, i) => (v === null ? [] : [{ v, i }]));
  if (known.length === 0) return null;
  const hi = Math.max(1, ...known.map((k) => k.v));
  const x = (i: number) => pad + (i / Math.max(1, values.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - (v / hi) * (H - 2 * pad);
  const pts = known.map((k) => ({ x: x(k.i), y: y(k.v) }));
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`h-10 w-full ${className}`} role="img" aria-label={label} data-points={pts.length}>
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--border)" strokeWidth="1" />
      {pts.length > 1 && <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--accent)" strokeOpacity="0.6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {last && <circle cx={last.x} cy={last.y} r="3" fill="var(--accent)" />}
    </svg>
  );
}
