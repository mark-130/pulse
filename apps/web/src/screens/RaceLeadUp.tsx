import { ChevronLeft, TriangleAlert } from "lucide-react";
import { Link, useParams } from "react-router";
import type { LeadUp, LeadUpWeek, RaceMetaInput, RaceView } from "@pulse/shared";
import { Chip, PriorityChip } from "@/components/Chip";
import { Button, Card, EmptyState } from "@/components/ui";
import { formatClock, formatClockDay, formatDate, formatDayDate, formatRaceKm, formatRaceTime, plural } from "@/lib/format";
import { longestLine, progressLine, scheduledLine, weekLabel, weekTitle } from "@/lib/leadup";
import { useLeadUp, useRaces, useSetRaceMeta } from "@/lib/queries";
import { Controls } from "./Races";

function WeekRow({ w }: { w: LeadUpWeek }) {
  const longest = longestLine(w);
  const progress = progressLine(w);
  return (
    <li className="min-w-0 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{weekTitle(w)}</p>
        <span className="t-label">{weekLabel(w)}</span>
      </div>
      <p className="mt-1 text-[15px]">{scheduledLine(w)}</p>
      {longest && <p className="t-secondary [overflow-wrap:anywhere]">{longest}</p>}
      <p className="t-secondary">{plural(w.restDays, "rest day")}{w.shownUntil ? `, counted up to ${formatDate(w.shownUntil).slice(0, 5)}` : ""}.</p>
      {progress && <p className="t-secondary">{progress}</p>}
      {w.shownUntil && <p className="t-label">Garmin shows this week only up to {formatDate(w.shownUntil).slice(0, 5)}.</p>}
      {w.sessions.length > 0 && (
        <details>
          <summary className="t-secondary flex min-h-11 cursor-pointer items-center">Scheduled sessions ({w.sessions.length})</summary>
          <ul className="space-y-1 pb-2 text-[15px]">
            {w.sessions.map((x, i) => (
              <li key={`${x.date}-${i}`} className="[overflow-wrap:anywhere]">
                {formatDayDate(x.date)}: {x.name}{x.minutes !== null ? `, ${x.minutes} min` : ""}{x.completed ? ", completed" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** Flags are facts: priority not set, start unverified, another race nearby, a workout on race day, data quality. */
export function FlagsView({ leadUp }: { leadUp: LeadUp }) {
  const items = [...leadUp.flags.map((f) => ({ key: f.kind + f.text, text: f.text })), ...leadUp.clashes.filter((c) => c.kind !== "cluster" || leadUp.nearbyRaces.length === 0).map((c) => ({ key: c.id, text: c.message }))];
  if (items.length === 0) return null;
  return (
    <Card title="Flags">
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.key} className="flex items-start gap-2 text-[15px] [overflow-wrap:anywhere]">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-[color:var(--verdict-easy)]" />
            <span>{i.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** What Garmin holds for the weeks before the race. Counts and flags only, no suggestions, and no AI. */
export function LeadUpView({ leadUp }: { leadUp: LeadUp }) {
  return (
    <>
      <Card title="Lead-up">
        <p className="font-display text-[28px] font-bold">{leadUp.past ? "Done" : leadUp.daysToGo}{!leadUp.past && <span className="t-secondary ml-2 font-sans text-[13px] font-normal">{leadUp.daysToGo === 1 ? "day to go" : "days to go"}</span>}</p>
        {leadUp.weeks.length === 0 ? (
          <p className="t-secondary mt-2">{leadUp.past ? "This race has happened." : "The weeks before this race are not in Garmin yet. The app sees about 14 days ahead."}</p>
        ) : (
          <ul className="mt-3 space-y-3">{leadUp.weeks.map((w) => <WeekRow key={w.weekStart} w={w} />)}</ul>
        )}
        <p className="t-label mt-3">Everything here is read from Garmin as last synced. Training content comes from your coach.</p>
      </Card>
      <FlagsView leadUp={leadUp} />
    </>
  );
}

export function RaceLeadUp() {
  const { key = "" } = useParams();
  const q = useLeadUp(key);
  const races = useRaces();
  const set = useSetRaceMeta();
  const race: RaceView | undefined = races.data?.races.find((r) => r.eventKey === key);
  const data = q.data;
  const save = (r: RaceView, m: RaceMetaInput) => set.mutate({ key: r.eventKey, ...m });
  return (
    <div className="space-y-3">
      <Button asChild variant="secondary" className="px-4"><Link to="/races"><ChevronLeft aria-hidden className="size-4" />Races</Link></Button>
      {q.isPending && <EmptyState>Loading</EmptyState>}
      {q.isError && !data && (
        <div role="alert" className="card">
          <p>{q.error.message}</p>
          <Button className="mt-3" onClick={() => void q.refetch()}>Retry</Button>
        </div>
      )}
      {data && (
        <>
          <section className="card min-w-0">
            <h1 className="t-greeting [overflow-wrap:anywhere]">{data.leadUp.title}</h1>
            <p className="t-secondary">{formatDayDate(data.leadUp.date)}{race ? `, ${formatRaceTime(race.startTimeLocal, race.timeZone)}` : ""}</p>
            {race && (
              <div className="mt-3 flex flex-wrap gap-2">
                <PriorityChip priority={race.priority} suggested={race.priorityInferred} />
                {race.distanceM !== null && <Chip>{formatRaceKm(race.distanceM)}</Chip>}
                {race.goalTimeSeconds !== null && <Chip>Goal {formatClock(race.goalTimeSeconds)}</Chip>}
              </div>
            )}
            {race && !race.past && <Controls race={race} save={save} busy={set.isPending} />}
            {set.isError && <p role="alert" className="mt-2 text-[13px] font-medium text-danger">{set.error.message}</p>}
          </section>
          <LeadUpView leadUp={data.leadUp} />
          {data.syncedAt && <p className="t-label">Garmin synced {formatClockDay(data.syncedAt)}</p>}
        </>
      )}
    </div>
  );
}
