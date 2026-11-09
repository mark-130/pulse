import type { Priority, RaceMetaInput, RaceView, RaceWarning } from "@pulse/shared";
import { Flag, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Chip, PriorityChip } from "@/components/Chip";
import { Button, Card, EmptyState } from "@/components/ui";
import { formatClock, formatDate, formatDayDate, formatRaceKm, formatRaceTime, formatTime, plural } from "@/lib/format";
import { useRaces, useSetRaceMeta } from "@/lib/queries";
import { changeText, PRIORITIES } from "@/lib/races";

interface Undo {
  text: string;
  key: string;
  previous: RaceMetaInput;
}

function Segmented<T extends string>({ label, options, value, onPick, disabled }: { label: string; options: { value: T; text: string }[]; value: T | null; onPick: (v: T) => void; disabled: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="t-label w-full sm:w-auto">{label}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={disabled}
          onClick={() => onPick(o.value)}
          className={`min-h-11 min-w-11 rounded-full border px-4 text-[15px] font-semibold disabled:opacity-50 ${value === o.value ? "border-accent bg-accent text-accent-foreground" : "border-border-strong bg-surface-2 text-foreground"}`}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

export function Controls({ race, save, busy }: { race: RaceView; save: (r: RaceView, m: RaceMetaInput) => void; busy: boolean }) {
  const explicitPriority = race.priorityInferred ? null : race.priority;
  const explicitType = race.typeInferred ? null : race.type;
  return (
    <div className="mt-3 space-y-3">
      <Segmented<Priority> label="Priority" disabled={busy} value={explicitPriority} options={PRIORITIES.map((p) => ({ value: p, text: p }))} onPick={(p) => save(race, { priority: p, type: explicitType })} />
      <Segmented<"road" | "trail"> label="Type" disabled={busy} value={explicitType} options={[{ value: "road", text: "Road" }, { value: "trail", text: "Trail" }]} onPick={(t) => save(race, { priority: explicitPriority, type: t })} />
    </div>
  );
}

function Flags({ race }: { race: RaceView }) {
  if (race.flags.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1">
      {race.flags.map((f) => (
        <li key={f.kind} className="flex items-start gap-2 text-[13px] [overflow-wrap:anywhere]">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-[color:var(--state-warn)]" />
          <span>{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

function RaceCard({ race, save, busy }: { race: RaceView; save: (r: RaceView, m: RaceMetaInput) => void; busy: boolean }) {
  return (
    <section className={`card min-w-0 ${race.past ? "opacity-80" : ""}`} aria-labelledby={`r-${race.eventKey}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`r-${race.eventKey}`} className="t-card-title [overflow-wrap:anywhere]">{race.title}</h2>
          <p className="t-secondary">{formatDayDate(race.date)}, {formatRaceTime(race.startTimeLocal, race.timeZone)}</p>
          {race.location && <p className="t-secondary [overflow-wrap:anywhere]">{race.location}</p>}
        </div>
        <p className="shrink-0 text-right">
          {race.past ? <span className="t-secondary">Done</span> : <><span className="font-display text-[28px] font-bold">{race.daysUntil}</span><span className="t-secondary block">{race.daysUntil === 1 ? "day" : "days"}</span></>}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <PriorityChip priority={race.priority} suggested={race.priorityInferred} />
        <Chip>{race.typeInferred ? `${race.type === "trail" ? "Trail" : "Road"}, suggested` : race.type === "trail" ? "Trail" : "Road"}</Chip>
        {race.distanceM !== null && <Chip>{formatRaceKm(race.distanceM)}{race.distanceInferred ? ", guessed" : ""}</Chip>}
        <Chip>{race.goalTimeSeconds !== null ? `Goal ${formatClock(race.goalTimeSeconds)}` : "No goal time"}</Chip>
      </div>
      <Flags race={race} />
      {!race.past && <Controls race={race} save={save} busy={busy} />}
      {!race.past && <Button asChild variant="secondary" className="mt-3 w-full sm:w-auto"><Link to={`/races/${encodeURIComponent(race.eventKey)}`}>Lead-up</Link></Button>}
    </section>
  );
}

function Warning({ w, races, save, busy }: { w: RaceWarning; races: Map<string, RaceView>; save: (r: RaceView, m: RaceMetaInput) => void; busy: boolean }) {
  const involved = w.raceKeys.map((k) => races.get(k)).filter((r): r is RaceView => r !== undefined);
  return (
    <section className={`card min-w-0 ${w.severity === "action" ? "!border-[color:var(--state-warn)]" : ""}`} aria-label="Warning">
      <p className="flex items-start gap-2 text-[15px] [overflow-wrap:anywhere]">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-[color:var(--state-warn)]" />
        <span>{w.message}</span>
      </p>
      {w.needsChoice && w.kind === "cluster" && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {involved.map((r) => (
            <Button key={r.eventKey} variant="secondary" className="h-auto w-full whitespace-normal py-2 text-left sm:w-auto" disabled={busy} onClick={() => save(r, { priority: "A", type: r.typeInferred ? null : r.type })}>
              <span className="min-w-0 [overflow-wrap:anywhere]">Make {r.title} the A race</span>
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

function Unclassified({ races, save, busy }: { races: RaceView[]; save: (r: RaceView, m: RaceMetaInput) => void; busy: boolean }) {
  if (races.length === 0) return null;
  return (
    <Card title="Unclassified">
      <p className="t-secondary mb-3">{plural(races.length, "race")} with a suggested priority or type. Accept the suggestion or set them on the race below.</p>
      <ul className="space-y-3">
        {races.map((r) => (
          <li key={r.eventKey} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium [overflow-wrap:anywhere]">{r.title}</p>
              <p className="t-secondary">{formatDate(r.date)}. Suggested: priority {r.priority}, {r.type}.</p>
            </div>
            <Button variant="secondary" className="w-full shrink-0 sm:w-auto" disabled={busy} onClick={() => save(r, { priority: r.priority, type: r.type })}>
              Use {r.priority}, {r.type}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Races() {
  const q = useRaces();
  const set = useSetRaceMeta();
  const [undo, setUndo] = useState<Undo | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 12_000);
    return () => clearTimeout(t);
  }, [undo]);

  const data = q.data;
  const byKey = new Map((data?.races ?? []).map((r) => [r.eventKey, r]));
  const save = (r: RaceView, m: RaceMetaInput) =>
    set.mutate(
      { key: r.eventKey, ...m },
      { onSuccess: (res) => setUndo({ text: changeText(r.title, res.current), key: r.eventKey, previous: res.previous }) },
    );
  const upcoming = (data?.races ?? []).filter((r) => !r.past);
  const recent = (data?.races ?? []).filter((r) => r.past).reverse();
  const warnings = [...(data?.warnings ?? [])].sort((a, b) => Number(b.severity === "action") - Number(a.severity === "action"));
  const busy = set.isPending;

  return (
    <div className="space-y-3">
      <h1 className="t-greeting">Races</h1>
      <p className="t-secondary">From your Garmin calendar. Priority and type are saved here only and never change Garmin.</p>
      {q.isPending && <EmptyState>Loading</EmptyState>}
      {q.isError && !data && (
        <div role="alert" className="card">
          <p>{q.error.message}</p>
          <Button className="mt-3" onClick={() => void q.refetch()}>Retry</Button>
        </div>
      )}
      {data && data.races.length === 0 && (
        <section className="card">
          <h2 className="t-card-title">No races in Garmin</h2>
          <p className="t-secondary">Add races in Garmin Connect. They appear after the next sync.</p>
        </section>
      )}
      {set.isError && <p role="alert" className="text-[13px] font-medium text-danger">{set.error.message}</p>}
      {warnings.map((w) => <Warning key={w.id} w={w} races={byKey} save={save} busy={busy} />)}
      <Unclassified races={upcoming.filter((r) => !r.classified)} save={save} busy={busy} />
      {upcoming.length > 0 && (
        <div className="space-y-3">
          <h2 className="t-overline flex items-center gap-2 pt-2"><Flag aria-hidden className="size-3.5" />Upcoming, next first</h2>
          {upcoming.map((r) => <RaceCard key={r.eventKey} race={r} save={save} busy={busy} />)}
        </div>
      )}
      {recent.length > 0 && (
        <div className="space-y-3">
          <h2 className="t-overline pt-2">Recent</h2>
          {recent.map((r) => <RaceCard key={r.eventKey} race={r} save={save} busy={busy} />)}
        </div>
      )}
      {data && <p className="t-label">{data.syncedAt ? `Garmin synced ${formatTime(data.syncedAt)}` : "Not synced yet"}</p>}
      {undo && (
        <div role="status" className="fixed inset-x-5 bottom-28 z-20 mx-auto flex max-w-md items-center gap-3 rounded-3xl border border-border-strong bg-surface px-4 py-2 shadow-lg md:bottom-6">
          <p className="min-w-0 flex-1 text-[15px] [overflow-wrap:anywhere]">{undo.text}</p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => set.mutate({ key: undo.key, ...undo.previous }, { onSuccess: () => setUndo(null) })}
          >
            Undo
          </Button>
        </div>
      )}
    </div>
  );
}
