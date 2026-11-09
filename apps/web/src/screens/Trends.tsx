import { KindNote } from "@/components/KindNote";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { TrendsResponse } from "@pulse/shared";
import { Button, Card } from "@/components/ui";
import { formatClock, formatDate, formatTime } from "@/lib/format";
import { ageText } from "@/lib/stale";
import { useTrends, useVo2 } from "@/lib/queries";
import { movingAverage7 } from "@/lib/history";
import { notImportedNote } from "@/lib/zones";
import { useEffect, useState } from "react";
import { RangePicker } from "@/components/RangePicker";
import { ReadingsChart } from "@/components/ReadingsChart";
import { YearOnYearCard } from "@/components/YearOnYearCard";
import { useSearchParams } from "react-router";
import { FitnessTab } from "@/components/FitnessTab";

const axis = { stroke: "var(--border-strong)", tick: { fill: "var(--muted)", fontSize: 12 } } as const;
const shortDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <details className="mt-3">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-[13px] text-accent">Show as table</summary>
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-left text-[13px]">
          <thead><tr>{head.map((h) => <th key={h} className="t-label py-1 pr-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border">{r.map((c, j) => <td key={j} className="py-1 pr-3">{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

function Empty() {
  return <p className="t-secondary">No data yet. It appears after the first Garmin sync.</p>;
}

/** VO2 max over the chosen range. Days Garmin carried forward are drawn lighter, and the bold line is the 7 day average. Beyond the stored range it says "Not imported yet". */
export function Vo2Chart({ days }: { days: number }) {
  const q = useVo2(730);
  const v = q.data;
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const points = movingAverage7(v?.points ?? []).filter((p) => p.date >= start);
  const note = notImportedNote(days, v?.stored?.from ?? null, today);
  useEffect(() => {
    if (window.location.hash === "#vo2max") document.getElementById("vo2max")?.scrollIntoView({ block: "start" });
  }, [v]);
  return (
    <section id="vo2max" className="card md:col-span-2 scroll-mt-4" aria-labelledby="vo2-chart-title">
      <h2 id="vo2-chart-title" className="t-card-title mb-2">VO2 max</h2>
      {q.isPending && <p className="t-secondary">Loading</p>}
      {q.isError && !v && <p role="alert" className="text-danger">{q.error.message}</p>}
      {v && points.length === 0 && <Empty />}
      {v && points.length > 0 && (
        <>
          <p className="t-secondary mb-2">VO2 max in ml/kg/min, Garmin estimate. Lighter points are days Garmin carried forward. The bold line is the 7 day average.{v.current ? ` Latest ${formatDate(v.current.date)}: ${v.current.value}.` : ""}</p>
          <div role="img" aria-label="Line chart of VO2 max. A table follows." className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 16 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDate} {...axis} label={{ value: "Date (dd/mm)", position: "insideBottom", offset: -4, fill: "var(--muted)", fontSize: 12 }} height={52} />
                <YAxis domain={["dataMin - 0.5", "dataMax + 0.5"]} {...axis} width={40} tickFormatter={(v: number) => v.toFixed(1)} />
                <Line dataKey="avg7" name="7 day average" stroke="var(--accent)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                <Line
                  dataKey="value"
                  stroke="var(--accent)"
                  strokeOpacity={0.35}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  dot={(p: { cx?: number; cy?: number; payload?: { carriedForward?: boolean }; index?: number }) => (
                    <circle key={p.index} cx={p.cx} cy={p.cy} r={points.length > 40 ? 1.8 : 3} fill="var(--accent)" fillOpacity={p.payload?.carriedForward ? 0.25 : 1} />
                  )}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {note && <p className="t-secondary mt-2">{note}</p>}
          <Table head={["Date", "VO2 max"]} rows={[...points].reverse().map((p) => [formatDate(p.date), `${p.value}${p.carriedForward ? " (carried forward)" : ""}`])} />
          {(v.stale || v.lastError) && v.ageMinutes !== null && <p className="t-label mt-2">Showing the last values Garmin gave, {ageText(v.ageMinutes)} old{v.lastError ? ", the latest update failed" : ""}.</p>}
        </>
      )}
    </section>
  );
}

function Trends({ t, days }: { t: TrendsResponse; days: number }) {
  const today = new Date().toISOString().slice(0, 10);
  const load = t.trainingLoad.filter((p) => p.atl !== null || p.ctl !== null);
  const synced = (
    <>
      <p className="t-label mt-2">{t.syncedAt ? `Garmin synced ${formatTime(t.syncedAt)}` : "Not synced yet"}</p>
      <KindNote group="trends" />
      <KindNote group="activities" />
    </>
  );
  const lastLoad = load[load.length - 1];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card title="Training load" className="md:col-span-2">
        {load.length === 0 ? <Empty /> : (
          <>
            <p className="t-secondary mb-2">Acute load (7 day, dashed) and chronic load (long term, solid), Garmin units. Garmin keeps this for about 6 weeks, so there is nothing earlier.{lastLoad ? ` Latest ${formatDate(lastLoad.date)}: acute ${lastLoad.atl ?? "--"}, chronic ${lastLoad.ctl ?? "--"}.` : ""}</p>
            <div role="img" aria-label="Line chart of acute and chronic training load. A table follows." className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={load} margin={{ left: 0, right: 8, top: 8, bottom: 16 }}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} {...axis} label={{ value: "Date (dd/mm)", position: "insideBottom", offset: -4, fill: "var(--muted)", fontSize: 12 }} height={52} />
                  <YAxis {...axis} width={44} label={{ value: "Load", angle: -90, position: "insideLeft", fill: "var(--muted)", fontSize: 12 }} />
                  <Line dataKey="atl" name="Acute" stroke="var(--muted)" strokeDasharray="5 4" dot={false} strokeWidth={2} isAnimationActive={false} />
                  <Line dataKey="ctl" name="Chronic" stroke="var(--accent)" dot={false} strokeWidth={2} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <Table head={["Date", "Acute", "Chronic", "Ratio"]} rows={[...load].reverse().map((p) => [formatDate(p.date), p.atl ?? "--", p.ctl ?? "--", p.acwr ?? "--"])} />
          </>
        )}
        {synced}
      </Card>

      <Card title="Weekly running distance">
        <p className="t-secondary mb-2">Kilometres per week, last {t.weeklyDistance.length} weeks, from recorded runs.</p>
        <div role="img" aria-label="Bar chart of weekly running distance. A table follows." className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={t.weeklyDistance.map((w) => ({ ...w, km: Number((w.distanceM / 1000).toFixed(1)) }))} margin={{ left: 0, right: 8, top: 8, bottom: 16 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="weekStart" tickFormatter={shortDate} {...axis} label={{ value: "Week starting (dd/mm)", position: "insideBottom", offset: -4, fill: "var(--muted)", fontSize: 12 }} height={52} />
              <YAxis {...axis} width={44} label={{ value: "km", angle: -90, position: "insideLeft", fill: "var(--muted)", fontSize: 12 }} />
              <Bar dataKey="km" fill="var(--accent)" radius={t.weeklyDistance.length > 30 ? [2, 2, 0, 0] : [6, 6, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {notImportedNote(days, t.stored.activities, today) && <p className="t-secondary mt-2">{notImportedNote(days, t.stored.activities, today)}</p>}
        <Table head={["Week starting", "km", "Runs"]} rows={[...t.weeklyDistance].reverse().map((w) => [formatDate(w.weekStart), (w.distanceM / 1000).toFixed(1), w.runs])} />
        {synced}
      </Card>

      <ReadingsChart days={days} />

      <Vo2Chart days={days} />

      <Card title="Endurance score">
        {!t.endurance ? <Empty /> : (
          <>
            <p className="mb-2 flex items-baseline gap-2"><span className="t-countdown">{t.endurance.current ?? "--"}</span><span className="t-secondary">{t.endurance.classification ?? ""}</span></p>
            <div role="img" aria-label="Line chart of weekly endurance score. A table follows." className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={t.endurance.weekly} margin={{ left: 0, right: 8, top: 8, bottom: 16 }}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="weekStart" tickFormatter={shortDate} {...axis} label={{ value: "Week starting (dd/mm)", position: "insideBottom", offset: -4, fill: "var(--muted)", fontSize: 12 }} height={52} />
                  <YAxis domain={["dataMin - 100", "dataMax + 100"]} {...axis} width={48} label={{ value: "Score", angle: -90, position: "insideLeft", fill: "var(--muted)", fontSize: 12 }} />
                  <Line dataKey="avg" stroke="var(--accent)" dot={false} strokeWidth={2} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {notImportedNote(days, t.stored.endurance, today) && <p className="t-secondary mt-2">{notImportedNote(days, t.stored.endurance, today)}</p>}
            <Table head={["Week starting", "Average score"]} rows={[...t.endurance.weekly].reverse().map((w) => [formatDate(w.weekStart), w.avg])} />
          </>
        )}
        {synced}
      </Card>

      <YearOnYearCard />

      <Card title="Race predictions" className="md:col-span-2">
        {!t.racePredictions ? <Empty /> : (
          <>
            <p className="t-secondary mb-2">Garmin's prediction on {formatDate(t.racePredictions.date)}.</p>
            <table className="w-full text-left text-[15px]">
              <thead><tr><th className="t-label py-1 font-medium">Distance</th><th className="t-label py-1 text-right font-medium">Predicted time</th></tr></thead>
              <tbody>{t.racePredictions.items.map((i) => <tr key={i.label} className="border-t border-border"><td className="py-2">{i.label}</td><td className="py-2 text-right font-display font-semibold">{formatClock(i.seconds)}</td></tr>)}</tbody>
            </table>
          </>
        )}
        {synced}
      </Card>
    </div>
  );
}

const TABS = [{ id: "readings", label: "Readings" }, { id: "fitness", label: "Fitness" }] as const;

export function TrendsScreen() {
  const [days, setDays] = useState(91);
  const q = useTrends(days);
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "fitness" ? "fitness" : "readings";
  return (
    <div className="space-y-3">
      <h1 className="t-greeting">Trends</h1>
      <div role="tablist" aria-label="Trends" className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === "readings" ? {} : { tab: t.id }, { replace: true })}
            className={`min-h-11 flex-1 rounded-full border px-4 text-[15px] font-semibold ${tab === t.id ? "border-accent bg-accent text-accent-foreground" : "border-border-strong bg-surface-2 text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "readings" && <RangePicker days={days} onPick={setDays} />}
      {tab === "fitness" && <FitnessTab />}
      {tab === "readings" && q.isPending && <div aria-hidden="true" className="h-64 rounded-3xl bg-surface-2" />}
      {tab === "readings" && q.isError && !q.data && (
        <div role="alert" className="card">
          <p>{q.error.message}</p>
          <Button className="mt-3" onClick={() => void q.refetch()}>Retry</Button>
        </div>
      )}
      {tab === "readings" && q.data && <Trends t={q.data} days={days} />}
    </div>
  );
}
