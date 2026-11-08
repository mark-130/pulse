/** A small line for a series of numbers. Lower and higher are not judged: it only draws the values. */
export function Spark({ values, label, className = "" }: { values: number[]; label: string; className?: string }) {
  if (values.length < 2) return null;
  const W = 280;
  const H = 40;
  const pad = 5;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map((v, i) => ({ x: pad + (i / (values.length - 1)) * (W - 2 * pad), y: hi === lo ? H / 2 : pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad) }));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`h-10 w-full ${className}`} role="img" aria-label={label}>
      <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--accent)" strokeOpacity="0.6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1]?.x} cy={pts[pts.length - 1]?.y} r="3" fill="var(--accent)" />
    </svg>
  );
}
