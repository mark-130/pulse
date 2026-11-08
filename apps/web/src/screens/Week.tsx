import { ChevronLeft, ChevronRight } from "lucide-react";
import { SportIcon } from "@/components/SportIcon";
import { useSearchParams } from "react-router";
import type { WeekResponse } from "@pulse/shared";
import { Chip } from "@/components/Chip";
import { KindNote } from "@/components/KindNote";
import { Button } from "@/components/ui";
import { formatDate, formatDayDate, formatDurationMin, formatKm, formatTime, plural } from "@/lib/format";
import { useWeek } from "@/lib/queries";

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function Day({ day, today }: { day: WeekResponse["days"][number]; today: string }) {
  const empty = day.workouts.length === 0 && day.activities.length === 0;
  return (
    <section className={`card ${day.date === today ? "!border-accent" : ""}`} aria-label={formatDayDate(day.date)}>
      <h2 className="t-card-title mb-2">{formatDayDate(day.date)}{day.date === today && <span className="t-secondary ml-2 font-sans text-[13px] font-normal">Today</span>}</h2>
      {empty && <p className="t-secondary">Nothing scheduled or recorded.</p>}
      <ul className="space-y-3">
        {day.workouts.map((w) => (
          <li key={w.scheduledId} className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2 text-accent"><SportIcon sport={w.sport} /></span>
            <div className="min-w-0 flex-1">
              <p className="t-overline">Scheduled</p>
              <p className="font-medium">{w.name}</p>
              <p className="t-secondary">{formatDurationMin(w.durationS)} estimated, source: Garmin</p>
            </div>
            <Chip>{w.completed ? "Completed" : "Planned"}</Chip>
          </li>
        ))}
        {day.activities.map((a) => (
          <li key={a.id} className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2 text-accent"><SportIcon sport={a.type} /></span>
            <div className="min-w-0 flex-1">
              <p className="t-overline">Recorded, {a.startLocal.slice(11, 16)}</p>
              <p className="font-medium">{a.name}</p>
              <p className="t-secondary">
                {[a.distanceM !== null && formatKm(a.distanceM, 2), formatDurationMin(a.durationS), a.avgHr !== null && `average ${a.avgHr} bpm`].filter(Boolean).join(", ")}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Week() {
  const [params, setParams] = useSearchParams();
  const start = params.get("start");
  const q = useWeek(start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : null);
  const w = q.data;
  const go = (date: string | null) => setParams(date ? { start: date } : {});
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="t-greeting">Week</h1>
        {w && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" aria-label="Previous week" onClick={() => go(shift(w.start, -7))}><ChevronLeft aria-hidden className="size-5" /></Button>
            <Button variant="secondary" onClick={() => go(null)}>This week</Button>
            <Button variant="secondary" aria-label="Next week" onClick={() => go(shift(w.start, 7))}><ChevronRight aria-hidden className="size-5" /></Button>
          </div>
        )}
      </div>
      {w && <p className="t-secondary">{formatDate(w.start)} to {formatDate(w.end)}</p>}
      {q.isPending && <div aria-hidden="true" className="h-64 rounded-3xl bg-surface-2" />}
      {q.isError && !w && (
        <div role="alert" className="card">
          <p>{q.error.message}</p>
          <Button className="mt-3" onClick={() => void q.refetch()}>Retry</Button>
        </div>
      )}
      {w && (
        <>
          <section className="card" aria-label="Week totals">
            <p className="t-overline mb-1">Running this week</p>
            <p className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span><span className="font-display text-[28px] font-bold">{(w.totals.distanceM / 1000).toFixed(1)}</span> <span className="t-secondary">km</span></span>
              <span><span className="font-display text-[28px] font-bold">{Math.round(w.totals.durationS / 60)}</span> <span className="t-secondary">min</span></span>
              <span className="t-secondary">{plural(w.totals.runs, "run")}</span>
            </p>
            <p className="t-label mt-2">{w.syncedAt ? `Garmin synced ${formatTime(w.syncedAt)}` : "Not synced yet"}</p>
            <KindNote group="activities" />
          </section>
          <div className="grid gap-3 md:grid-cols-2">
            {w.days.map((d) => <Day key={d.date} day={d} today={w.today} />)}
          </div>
        </>
      )}
    </div>
  );
}
