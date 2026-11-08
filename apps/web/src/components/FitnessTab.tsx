import { FITNESS_FOOTER, PREDICTIONS_FOOTNOTE, type FitnessResponse } from "@pulse/shared";
import { formatDate } from "@/lib/format";
import { useFitness } from "@/lib/queries";
import { ageText } from "@/lib/stale";
import { Spark } from "./Spark";
import { Tag } from "./Tag";
import { Vo2Body } from "./Vo2Card";
import { Card } from "./ui";

type Status = { stale: boolean; ageMinutes: number | null; lastError: string | null };

/** A stale or failed kind keeps its last value. This says how old it is, and that the latest update failed. */
export function StaleNote({ s, what }: { s: Status; what: string }) {
  if ((!s.stale && !s.lastError) || s.ageMinutes === null) return null;
  return <p className="t-label mt-2">Showing the last {what} Garmin gave, {ageText(s.ageMinutes)} old{s.lastError ? ", the latest update failed" : ""}.</p>;
}

export function PredictionsCard({ p, records }: { p: FitnessResponse["predictions"]; records?: never }) {
  void records;
  return (
    <Card title="Race predictions">
      {p.rows.every((r) => r.time === null) ? (
        <p className="t-secondary">No predictions yet. They appear after the next sync.</p>
      ) : (
        <ul className="space-y-4">
          {p.rows.map((r) => (
            <li key={r.key} className="min-w-0 border-t border-border pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium">{r.label}</p>
                <p className="font-display text-[24px] font-semibold">{r.time ?? "--"}</p>
              </div>
              <p className="t-secondary">{r.pace ? `${r.pace}, Garmin's prediction` : "No prediction"}</p>
              {r.record && <p className="mt-1 text-[15px]">Personal record {r.record.time}, {formatDate(r.record.date)}</p>}
              {r.difference && <p className="t-secondary [overflow-wrap:anywhere]">{r.label}: {r.difference.text}</p>}
              {r.spark.length >= 2 && <Spark values={r.spark.map((x) => x.seconds)} label={`${r.label} prediction over ${r.spark.length} days, from ${r.spark[0]?.seconds} to ${r.spark[r.spark.length - 1]?.seconds} seconds`} className="mt-1" />}
            </li>
          ))}
        </ul>
      )}
      <p className="t-label mt-3">{p.trackingSince ? `Tracking since ${formatDate(p.trackingSince)}${p.snapshots < 7 ? `, ${p.snapshots} ${p.snapshots === 1 ? "day" : "days"} so far. A trend line appears after 7 days.` : "."}` : "Not tracking yet."} Garmin cannot give past predictions.</p>
      <p className="t-label mt-1">{PREDICTIONS_FOOTNOTE}</p>
      <StaleNote s={p} what="predictions" />
    </Card>
  );
}

function EnduranceBlock({ e }: { e: NonNullable<FitnessResponse["endurance"]> }) {
  const pct = (v: number) => (e.scale ? Math.max(0, Math.min(100, ((v - e.scale.lo) / (e.scale.hi - e.scale.lo)) * 100)) : 0);
  return (
    <div>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-display text-[28px] font-bold">{e.score}</span>
        {e.date && <span className="t-secondary">on {formatDate(e.date)}</span>}
      </p>
      {e.classificationLabel && <p className="text-[15px] font-semibold">{e.classificationLabel} <span className="t-secondary font-normal">(Garmin's classification)</span></p>}
      {e.scale && (
        <div className="relative mt-3 h-2 rounded-full bg-surface-2" role="img" aria-label={`Score ${e.score} on Garmin's scale from ${e.scale.lo} to ${e.scale.hi}. Garmin's thresholds are ${e.thresholds.map((t) => `${t.label} ${t.value}`).join(", ")}.`}>
          {e.thresholds.map((t) => <span key={t.key} className="absolute -top-1 h-4 w-px bg-border-strong" style={{ left: `${pct(t.value)}%` }} />)}
          <span className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--bg)] bg-accent" style={{ left: `${pct(e.score)}%` }} />
        </div>
      )}
      {e.band && <p className="t-secondary mt-2">Garmin's band: {e.band.from} to {e.band.to === null ? "the top" : `under ${e.band.to}`}.</p>}
      {e.thresholds.length > 0 && (
        <details className="min-w-0">
          <summary className="t-secondary flex min-h-11 cursor-pointer items-center">Garmin's thresholds</summary>
          <ul className="space-y-1 pb-2 text-[15px]">{e.thresholds.map((t) => <li key={t.key} className="flex justify-between gap-3"><span>{t.label}</span><span className="font-semibold">{t.value}</span></li>)}</ul>
        </details>
      )}
      {e.weekly.length >= 2 && <Spark values={e.weekly.map((w) => w.avg)} label={`Weekly average endurance score over ${e.weekly.length} weeks, from ${e.weekly[0]?.avg} to ${e.weekly[e.weekly.length - 1]?.avg}`} className="mt-1" />}
      {e.weekly.length >= 2 && <p className="t-label">Weekly average, {e.weekly.length} weeks</p>}
      <StaleNote s={e} what="score" />
    </div>
  );
}

export function MetricsCards({ f }: { f: FitnessResponse }) {
  return (
    <>
      <Card title="VO2 max">
        <Vo2Body v={f.vo2max} />
      </Card>
      <Card title="Endurance score">{f.endurance ? <EnduranceBlock e={f.endurance} /> : <p className="t-secondary">No endurance score yet. It appears after the next sync.</p>}</Card>
      <Card title="Hill score">
        {f.hill && f.hill.overall !== null ? (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2"><span className="font-display text-[28px] font-bold">{f.hill.overall}</span><span className="t-secondary">overall{f.hill.date ? ` on ${formatDate(f.hill.date)}` : ""}</span></p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 text-[15px]">
              <div><dt className="t-label">Strength</dt><dd className="font-semibold">{f.hill.strength ?? "--"}</dd></div>
              <div><dt className="t-label">Endurance</dt><dd className="font-semibold">{f.hill.endurance ?? "--"}</dd></div>
            </dl>
            <StaleNote s={f.hill} what="score" />
          </>
        ) : (
          <p className="t-secondary">No hill score yet. It appears after the next sync.</p>
        )}
      </Card>
      <Card title="Lactate threshold">
        {f.lactate && f.lactate.heartRate !== null ? (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2"><span className="font-display text-[28px] font-bold">{f.lactate.heartRate}</span><span className="t-secondary">bpm</span></p>
            {f.lactate.pace && <p className="text-[15px] font-semibold">{f.lactate.pace}</p>}
            {f.lactate.measuredOn && <p className="t-secondary">Measured {formatDate(f.lactate.measuredOn)}</p>}
            <StaleNote s={f.lactate} what="measurement" />
          </>
        ) : (
          <p className="t-secondary">No lactate threshold yet. It appears after the next sync.</p>
        )}
      </Card>
    </>
  );
}

export function RecordsCard({ r }: { r: FitnessResponse["records"] }) {
  return (
    <Card title="Personal records">
      {r.items.length === 0 ? (
        <p className="t-secondary">No records yet. They appear after the next sync.</p>
      ) : (
        <ul className="space-y-3">
          {r.items.map((x) => (
            <li key={x.key} className="flex min-w-0 items-baseline justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
              <p className="min-w-0 font-medium">{x.label} {x.isNew && <Tag>New</Tag>}</p>
              <p className="shrink-0 text-right"><span className="font-semibold">{x.value}</span><span className="t-secondary block">{formatDate(x.date)}</span></p>
            </li>
          ))}
        </ul>
      )}
      <StaleNote s={r} what="records" />
    </Card>
  );
}

export function FitnessView({ f }: { f: FitnessResponse }) {
  return (
    <div className="space-y-3">
      <PredictionsCard p={f.predictions} />
      <MetricsCards f={f} />
      <RecordsCard r={f.records} />
      <p className="t-label">{FITNESS_FOOTER}</p>
    </div>
  );
}

/** The Fitness tab on Trends: Garmin's figures, stacked, reported and not interpreted. */
export function FitnessTab() {
  const q = useFitness();
  if (q.isPending) return <div aria-hidden="true" className="h-64 rounded-3xl bg-surface-2" />;
  if (q.isError && !q.data) return <div role="alert" className="card"><p>{q.error.message}</p></div>;
  return q.data ? <FitnessView f={q.data} /> : null;
}
