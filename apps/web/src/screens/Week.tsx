import { ChevronLeft, ChevronRight } from "lucide-react";
import { SportIcon } from "@/components/SportIcon";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { PLAN_APP_NOTE, PROBE_RESULT_RECORDED, type WeekResponse, type WorkoutItem } from "@pulse/shared";
import { Modal } from "@/components/Modal";
import { Chip } from "@/components/Chip";
import { KindNote } from "@/components/KindNote";
import { Button } from "@/components/ui";
import { formatDate, formatDayDate, formatDurationMin, formatKm, formatTime, plural } from "@/lib/format";
import { useCreateProposal, useWeek } from "@/lib/queries";

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function MoveDialog({ workout, onClose, onCreated }: { workout: WorkoutItem | null; onClose: () => void; onCreated: (text: string) => void }) {
  const create = useCreateProposal();
  const [date, setDate] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const max = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  return (
    <Modal open={workout !== null} onClose={() => { setDate(""); create.reset(); onClose(); }} labelledBy="move-title">
      {workout && (
        <>
          <p className="t-overline">Proposal for Garmin</p>
          <h2 id="move-title" className="t-card-title mb-1">Move workout</h2>
          <p className="[overflow-wrap:anywhere]">{workout.name}</p>
          <p className="t-secondary mb-3">Now on {formatDayDate(workout.date)}. Only the date changes.</p>
          <label className="t-label block" htmlFor="move-date">New date</label>
          <input
            id="move-date"
            type="date"
            min={today}
            max={max}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 min-h-11 w-full rounded-2xl border border-border-strong bg-surface-2 px-4 text-[15px] text-foreground"
          />
          {!PROBE_RESULT_RECORDED && <p className="t-secondary mt-3">{PLAN_APP_NOTE}</p>}
          <p className="t-secondary mt-3">This only creates a proposal. Nothing changes in Garmin until you confirm it on the Proposals screen.</p>
          {create.isError && <p role="alert" className="mt-3 text-[13px] font-medium text-danger">{create.error.message}</p>}
          <div className="mt-4 flex flex-col gap-2">
            <Button
              disabled={!date || create.isPending}
              onClick={() => create.mutate({ kind: "garmin.reschedule", scheduledId: workout.scheduledId, date }, { onSuccess: () => { onCreated(`Proposal created: move ${workout.name} to ${formatDayDate(date)}.`); setDate(""); onClose(); } })}
            >
              Create proposal
            </Button>
            <Button variant="secondary" onClick={() => { setDate(""); onClose(); }}>Cancel</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Day({ day, today, onMove, onRemove, busy }: { day: WeekResponse["days"][number]; today: string; onMove: (w: WorkoutItem) => void; onRemove: (w: WorkoutItem) => void; busy: boolean }) {
  const empty = day.workouts.length === 0 && day.activities.length === 0;
  return (
    <section className={`card ${day.date === today ? "!border-accent" : ""}`} aria-label={formatDayDate(day.date)}>
      <h2 className="t-card-title mb-2">{formatDayDate(day.date)}{day.date === today && <span className="t-secondary ml-2 font-sans text-[13px] font-normal">Today</span>}</h2>
      {empty && <p className="t-secondary">Nothing scheduled or recorded.</p>}
      <ul className="space-y-3">
        {day.workouts.map((w) => (
          <li key={w.scheduledId} className="flex flex-wrap items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2 text-accent"><SportIcon sport={w.sport} /></span>
            <div className="min-w-0 flex-1">
              <p className="t-overline">Scheduled</p>
              <p className="font-medium">{w.name}</p>
              <p className="t-secondary">{formatDurationMin(w.durationS)} estimated, source: Garmin</p>
            </div>
            <Chip>{w.completed ? "Completed" : "Planned"}</Chip>
            {!w.completed && w.date >= today && (
              <div className="flex basis-full flex-wrap gap-2 pl-14">
                <Button variant="secondary" className="px-4" disabled={busy} onClick={() => onMove(w)}>Move</Button>
                <Button variant="secondary" className="px-4" disabled={busy} onClick={() => onRemove(w)}>Remove from schedule</Button>
              </div>
            )}
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
  const [moving, setMoving] = useState<WorkoutItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const remove = useCreateProposal();
  const askRemove = (wk: WorkoutItem) =>
    remove.mutate(
      { kind: "garmin.unschedule", scheduledId: wk.scheduledId },
      { onSuccess: () => setNotice(`Proposal created: remove ${wk.name} from the schedule.`), onError: (e) => setNotice(e.message) },
    );
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
            {w.days.map((d) => <Day key={d.date} day={d} today={w.today} busy={remove.isPending} onMove={setMoving} onRemove={askRemove} />)}
          </div>
        </>
      )}
      <MoveDialog workout={moving} onClose={() => setMoving(null)} onCreated={setNotice} />
      {notice && (
        <div role="status" className="fixed inset-x-5 bottom-28 z-20 mx-auto flex max-w-md items-center gap-3 rounded-3xl border border-border-strong bg-surface px-4 py-2 shadow-lg md:bottom-6">
          <p className="min-w-0 flex-1 text-[15px] [overflow-wrap:anywhere]">{notice}</p>
          <Button asChild variant="secondary" className="shrink-0"><Link to="/proposals" onClick={() => setNotice(null)}>Review</Link></Button>
          <Button variant="secondary" className="shrink-0 px-4" onClick={() => setNotice(null)}>Close</Button>
        </div>
      )}
    </div>
  );
}
