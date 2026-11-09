import type { Vo2Response } from "@pulse/shared";
import { formatDate } from "@/lib/format";
import { ageText } from "@/lib/stale";
import { sparkPoints } from "@/lib/zones";

const W = 280;
const H = 56;

/** A 30 day sparkline. Days Garmin carried forward are drawn lighter. */
export function Sparkline({ points, className = "mt-2 h-14 w-full" }: { points: Vo2Response["points"]; className?: string }) {
  const pts = sparkPoints(points, W, H);
  if (pts.length < 2) return null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} role="img" aria-label={`VO2 max over the last 30 days, ${points[0]?.value} to ${points[points.length - 1]?.value}. Lighter points are days Garmin carried forward.`}>
      <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--accent)" strokeOpacity="0.45" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.carried ? 2.5 : 3} fill="var(--accent)" fillOpacity={p.carried ? 0.3 : 1} data-carried={p.carried ? "true" : "false"} />)}
    </svg>
  );
}

export function Vo2Body({ v }: { v: Vo2Response }) {
  const c = v.current;
  return (
    <>
      {c ? (
        <>
          <p className="flex items-baseline gap-2">
            <span className="t-hero">{c.value.toFixed(1)}</span>
            <span className="t-secondary">ml/kg/min on {formatDate(c.date)}{c.carriedForward ? ", carried forward" : ""}</span>
          </p>
          {v.change30 && <p className="mt-1 text-[15px] font-semibold">{v.change30.text}</p>}
          <Sparkline points={v.points} />
          {(v.stale || v.lastError) && v.ageMinutes !== null && <p className="t-label mt-2">Showing the last value Garmin gave, {ageText(v.ageMinutes)} old{v.lastError ? ", the latest update failed" : ""}.</p>}
        </>
      ) : (
        <p className="t-secondary">No VO2 max yet. It appears after the next sync.</p>
      )}
    </>
  );
}
