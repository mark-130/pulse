import { Battery, Footprints, Heart, Minus, Moon, Sparkles, Activity } from "lucide-react";
import { Link } from "react-router";
import { AiChip, Chip } from "@/components/Chip";
import { Orb } from "@/components/Orb";
import { Button } from "@/components/ui";
import { dateLine, greetingFor } from "@/lib/today";
import { widgets } from "@/modules/registry";

const prompts = ["How did I sleep?", "What is my next race?", "Should I run today?"];
const metrics = [
  { label: "Sleep", icon: Moon },
  { label: "HRV", icon: Activity },
  { label: "Resting HR", icon: Heart },
  { label: "Body battery", icon: Battery },
];

function Gauge({ value }: { value: number | null }) {
  return (
    <div className="relative h-[10px] rounded-full" style={{ background: "linear-gradient(90deg, var(--verdict-rest), var(--verdict-swap), var(--verdict-easy), var(--verdict-go))" }}>
      {value !== null && (
        <span className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--bg)] bg-foreground" style={{ left: `${value}%` }} />
      )}
    </div>
  );
}

function Skeleton() {
  return <span className="inline-block h-3 w-24 rounded-full bg-surface-2" aria-hidden="true" />;
}

export function Today() {
  const now = new Date();
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
            <Link key={p} to="/ask" className="inline-flex min-h-11 items-center rounded-full border border-border-strong bg-surface-2 px-4 text-[13px]">
              {p}
            </Link>
          ))}
        </div>
      </div>

      <section className="card md:col-span-2" aria-labelledby="verdict-title">
        <h2 id="verdict-title" className="t-overline mb-2">Readiness</h2>
        <Chip><Minus aria-hidden className="size-3" />No verdict yet</Chip>
        <p className="mt-3 flex items-baseline gap-1"><span className="t-hero">--</span><span className="t-secondary">/ 100</span></p>
        <div className="my-3"><Gauge value={null} /></div>
        <p className="t-secondary">Needs Garmin data from Phase 1. Nothing is guessed.</p>
      </section>

      <section className="card md:col-span-3" aria-labelledby="session-title">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-surface-2 text-accent"><Footprints aria-hidden className="size-5" /></span>
          <div className="min-w-0 flex-1">
            <p className="t-overline">Today's session</p>
            <h2 id="session-title" className="t-card-title">Nothing synced yet</h2>
            <p className="t-secondary">Source: Garmin</p>
          </div>
          <Button variant="secondary" disabled>View</Button>
        </div>
      </section>

      <section className="card md:col-span-3" aria-labelledby="race-title">
        <p className="t-overline">Next race</p>
        <h2 id="race-title" className="t-card-title">No race loaded</h2>
        <p className="t-secondary mb-3">Races sync from the Garmin calendar in Phase 1.</p>
        <div className="mb-3 flex gap-2" aria-hidden="true">
          {Array.from({ length: 7 }, (_, i) => (
            <span key={i} className={`size-7 rounded-full border ${i === 0 ? "border-accent" : "border-border-strong"}`} />
          ))}
        </div>
        <p className="t-secondary">Following race: none</p>
      </section>

      <div className="grid grid-cols-2 gap-3 md:col-span-4">
        {metrics.map(({ label, icon: Icon }) => (
          <section key={label} className="card" aria-label={label}>
            <p className="t-label flex items-center gap-1"><Icon aria-hidden className="size-3.5" />{label}</p>
            <p className="font-display my-1 text-[22px] font-semibold">--</p>
            <div className="h-1 rounded-full bg-surface-2"><div className="h-1 w-0 rounded-full" style={{ background: "var(--ai-gradient)" }} /></div>
            <p className="t-label mt-1"><Skeleton /></p>
          </section>
        ))}
      </div>

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
