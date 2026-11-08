import { SportIcon } from "@/components/SportIcon";
import { KindNote } from "@/components/KindNote";
import { Activity, Battery, Check, Heart, Minus, Moon, Sparkles, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { RaceItem, TodayResponse } from "@pulse/shared";
import { AiChip, Chip } from "@/components/Chip";
import { Orb } from "@/components/Orb";
import { Button } from "@/components/ui";
import { formatClock, formatDate, formatDayDate, formatDurationMin, formatKm, formatRaceKm, formatRaceTime, formatTime, humanise, plural } from "@/lib/format";
import { useToday } from "@/lib/queries";
import { dateLine, greetingFor } from "@/lib/today";
import { widgets } from "@/modules/registry";

const prompts = ["How did I sleep?", "What is my next race?", "Should I run today?"];

function Gauge({ value }: { value: number | null }) {
  return (
    <div className="relative h-[10px] rounded-full" style={{ background: "linear-gradient(90deg, var(--verdict-rest), var(--verdict-swap), var(--verdict-easy), var(--verdict-go))" }}>
      {value !== null && (
        <span className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--bg)] bg-foreground" style={{ left: `${Math.max(0, Math.min(100, value))}%` }} />
      )}
    </div>
  );
}

function Synced({ at }: { at: string | null }) {
  return <p className="t-label mt-2">{at ? `Garmin synced ${formatTime(at)}` : "Not synced yet"}</p>;
}

function Bar({ pct }: { pct: number | null }) {
  return (
    <div className="h-1 rounded-full bg-surface-2">
      <div className="h-1 rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, background: "var(--ai-gradient)" }} />
    </div>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`rounded-3xl bg-surface-2 ${className}`} />;
}

function Readiness({ data }: { data: TodayResponse }) {
  const r = data.readiness;
  const Icon = !r || r.level === null ? Minus : ["PRIME", "HIGH"].includes(r.level) ? Check : r.level === "MODERATE" ? Minus : TriangleAlert;
  return (
    <section className="card md:col-span-2" aria-labelledby="verdict-title">
      <h2 id="verdict-title" className="t-overline mb-2">Readiness</h2>
      <Chip>
        <Icon aria-hidden className="size-3" />
        {r?.level ? `Garmin: ${humanise(r.level)}` : "No readiness yet"}
      </Chip>
      <p className="mt-3 flex items-baseline gap-1">
        <span className="t-hero">{r?.score ?? "--"}</span>
        <span className="t-secondary">/ 100</span>
      </p>
      <div className="my-3"><Gauge value={r?.score ?? null} /></div>
      <p className="text-[15px]">
        {r
          ? [humanise(r.feedback), r.sleepScore !== null && `sleep score ${r.sleepScore}`, r.recoveryTimeHours !== null && `recovery time ${r.recoveryTimeHours} h`, r.acuteLoad !== null && `acute load ${r.acuteLoad}`].filter(Boolean).join(", ") + "."
          : "Needs Garmin data. Nothing is guessed."}
      </p>
      <p className="t-label mt-1">{r ? `Garmin's own score for ${formatDate(r.date)}. The go or rest verdict arrives with AI in Phase 4.` : ""}</p>
      <Synced at={data.syncedAt} />
    </section>
  );
}

function Session({ data }: { data: TodayResponse }) {
  const { today, next, activitiesToday } = data.session;
  const first = today[0];
  const done = activitiesToday[0];
  return (
    <section className="card md:col-span-3" aria-labelledby="session-title">
      <div className="flex items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2 text-accent"><SportIcon sport={first ? first.sport : "running"} /></span>
        <div className="min-w-0 flex-1">
          <p className="t-overline">Today's session</p>
          <h2 id="session-title" className="t-card-title">{first ? first.name : "Nothing scheduled"}</h2>
          <p className="t-secondary">{first ? `${formatDurationMin(first.durationS)} estimated, source: Garmin${first.completed ? ", completed" : ""}` : "Source: Garmin"}</p>
        </div>
        <Button asChild variant="secondary"><Link to="/week">View</Link></Button>
      </div>
      {done && (
        <p className="mt-3 text-[15px]">
          Done today: {done.name}, {formatKm(done.distanceM, 2)} in {formatDurationMin(done.durationS)}.
        </p>
      )}
      {!first && next && <p className="mt-3 text-[15px]">Next: {next.name}, {formatDayDate(next.date)}, {formatDurationMin(next.durationS)}.</p>}
      <Synced at={data.syncedAt} />
      <KindNote group="activities" />
    </section>
  );
}

function SevenDays({ race }: { race: RaceItem | null }) {
  return (
    <div className="my-3 flex gap-2" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => {
        const isRaceDay = race !== null && race.daysUntil === i;
        return <span key={i} className={`size-7 rounded-full border ${isRaceDay ? "border-accent bg-accent" : i === 0 ? "border-accent" : "border-border-strong"}`} />;
      })}
    </div>
  );
}

function Race({ data }: { data: TodayResponse }) {
  const r = data.nextRace;
  const f = data.followingRace;
  return (
    <section className="card md:col-span-3" aria-labelledby="race-title">
      <p className="t-overline">Next race</p>
      {r ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="race-title" className="t-card-title">{r.title}</h2>
              <p className="t-secondary">{formatDayDate(r.date)}, {formatRaceTime(r.startTimeLocal, r.timeZone)}</p>
            </div>
            <p className="text-right"><span className="t-countdown">{r.daysUntil}</span><span className="t-secondary block">{r.daysUntil === 1 ? "day" : "days"}</span></p>
          </div>
          <SevenDays race={r} />
          <div className="flex flex-wrap gap-2">
            {r.distanceM !== null && <Chip>{formatRaceKm(r.distanceM)}</Chip>}
            <Chip>{r.goalTimeSeconds !== null ? `Goal ${formatClock(r.goalTimeSeconds)}` : "No goal time"}</Chip>
            {!r.isRace && <Chip>Not flagged as a race</Chip>}
          </div>
        </>
      ) : (
        <>
          <h2 id="race-title" className="t-card-title">No race in Garmin</h2>
          <p className="t-secondary">Add races in Garmin Connect. They appear after the next sync.</p>
          <SevenDays race={null} />
        </>
      )}
      <p className="t-secondary mt-3">{f ? `Then: ${f.title}, ${formatDate(f.date)} (${plural(f.daysUntil, "day")})` : "Following race: none"}</p>
      <Synced at={data.syncedAt} />
    </section>
  );
}

function Tile({ label, icon: Icon, value, unit, status, pct, from }: { label: string; icon: typeof Moon; value: ReactNode; unit?: string; status: string; pct: number | null; from: string | null }) {
  return (
    <section className="card" aria-label={label}>
      <p className="t-label flex items-center gap-1"><Icon aria-hidden className="size-3.5" />{label}</p>
      <p className="font-display my-1 text-[22px] font-semibold">{value}{unit && <span className="t-secondary ml-1 font-sans text-[13px] font-normal">{unit}</span>}</p>
      <Bar pct={pct} />
      <p className="t-label mt-1">{status}{from ? `, from ${formatDate(from)}` : ""}</p>
    </section>
  );
}

function Metrics({ data }: { data: TodayResponse }) {
  const { sleep, hrv, restingHr, bodyBattery } = data.metrics;
  const from = (d: string | undefined) => (d && d !== data.date ? d : null);
  // Bars compare each value with a reference Garmin gives us. They carry no figures of their own.
  return (
    <div className="md:col-span-4">
      <div className="grid grid-cols-2 gap-3">
        <Tile label="Sleep" icon={Moon} value={sleep?.score ?? "--"} unit="score" pct={sleep?.score ?? null} from={from(sleep?.date)} status={sleep ? `${humanise(sleep.qualifier)}${sleep.hours !== null ? `, ${sleep.hours.toFixed(1)} h` : ""}` : "No data yet"} />
        <Tile label="HRV" icon={Activity} value={hrv?.lastNightAvg ?? "--"} unit="ms" pct={hrv?.lastNightAvg != null && hrv.baselineUpper ? (hrv.lastNightAvg / hrv.baselineUpper) * 100 : null} from={from(hrv?.date)} status={hrv ? `${humanise(hrv.status)}${hrv.baselineLow !== null && hrv.baselineUpper !== null ? `, baseline ${hrv.baselineLow} to ${hrv.baselineUpper} ms` : ""}` : "No data yet"} />
        <Tile label="Resting HR" icon={Heart} value={restingHr?.bpm ?? "--"} unit="bpm" pct={restingHr?.bpm && restingHr.sevenDayAvg ? (restingHr.sevenDayAvg / restingHr.bpm) * 100 : null} from={from(restingHr?.date)} status={restingHr ? (restingHr.sevenDayAvg !== null ? `7 day average ${restingHr.sevenDayAvg} bpm` : "No average yet") : "No data yet"} />
        <Tile label="Body battery" icon={Battery} value={bodyBattery?.current ?? "--"} pct={bodyBattery?.current ?? null} from={from(bodyBattery?.date)} status={bodyBattery ? `Highest ${bodyBattery.highest ?? "--"}, lowest ${bodyBattery.lowest ?? "--"}` : "No data yet"} />
      </div>
      <Synced at={data.syncedAt} />
    </div>
  );
}

export function Today() {
  const now = new Date();
  const q = useToday();
  const data = q.data;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
      <section className="flex items-center gap-4 py-2 md:col-span-6">
        <Orb size={96} />
        <div>
          <h1 className="t-greeting">{greetingFor(now)}</h1>
          <p className="t-secondary">{dateLine(now)}</p>
        </div>
      </section>

      <div className="space-y-3 md:col-span-4">
        <section className="card-briefing" aria-labelledby="briefing-title">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles aria-hidden className="size-4 text-accent" />
            <h2 id="briefing-title" className="t-card-title !text-[15px]">Morning briefing</h2>
            <AiChip />
          </div>
          <p className="leading-[1.6]">No briefing yet. It arrives once AI is switched on in Phase 4.</p>
        </section>
        <div className="flex flex-wrap gap-2" aria-label="Suggested questions">
          {prompts.map((p) => (
            <Link key={p} to="/ask" className="inline-flex min-h-11 items-center rounded-full border border-border-strong bg-surface-2 px-4 text-[13px]">{p}</Link>
          ))}
        </div>
      </div>

      {q.isPending && (
        <>
          <Skeleton className="h-64 md:col-span-2" />
          <Skeleton className="h-32 md:col-span-3" />
          <Skeleton className="h-48 md:col-span-3" />
          <Skeleton className="h-40 md:col-span-4" />
        </>
      )}
      {q.isError && !data && (
        <div role="alert" className="card md:col-span-6">
          <p>{q.error.message}</p>
          <Button className="mt-3" onClick={() => void q.refetch()}>Retry</Button>
        </div>
      )}
      {data && (
        <>
          <Readiness data={data} />
          <Session data={data} />
          <Race data={data} />
          <Metrics data={data} />
        </>
      )}

      <section className="card-proposals md:col-span-2" aria-labelledby="proposals-title">
        <h2 id="proposals-title" className="t-card-title">Proposals</h2>
        <p className="font-display my-1 text-[28px] font-bold">0</p>
        <p className="t-secondary mb-3">Nothing is applied until you confirm.</p>
        <Button asChild variant="secondary"><Link to="/proposals">Review</Link></Button>
      </section>

      {widgets.map((w) => (
        <div key={w.id} className={w.size === "2x1" ? "md:col-span-4" : "md:col-span-2"}>
          <w.component />
        </div>
      ))}
    </div>
  );
}
