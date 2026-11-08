import { KindNote } from "@/components/KindNote";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { TrendsResponse } from "@pulse/shared";
import { Button, Card } from "@/components/ui";
import { formatClock, formatDate, formatTime } from "@/lib/format";
import { useTrends } from "@/lib/queries";

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

function Trends({ t }: { t: TrendsResponse }) {
  const load = t.trainingLoad.filter((p) => p.atl !== null || p.ctl !== null);
  const synced = (
    <>
      <p className="t-label mt-2">{t.syncedAt ? `Garmin synced ${formatTime(t.syncedAt)}` : "Not synced yet"}</p>
      <KindNote group="trends" />
      <KindNote group="activities" />
    </>
  );
  const lastLoad = load[load.length - 1];
  const lastVo2 = t.vo2max[t.vo2max.length - 1];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card title="Training load" className="md:col-span-2">
        {load.length === 0 ? <Empty /> : (
          <>
            <p className="t-secondary mb-2">Acute load (7 day, dashed) and chronic load (long term, solid), Garmin units.{lastLoad ? ` Latest ${formatDate(lastLoad.date)}: acute ${lastLoad.atl ?? "--"}, chronic ${lastLoad.ctl ?? "--"}.` : ""}</p>
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
        <p className="t-secondary mb-2">Kilometres per week, last 12 weeks, from recorded runs.</p>
        <div role="img" aria-label="Bar chart of weekly running distance. A table follows." className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={t.weeklyDistance.map((w) => ({ ...w, km: Number((w.distanceM / 1000).toFixed(1)) }))} margin={{ left: 0, right: 8, top: 8, bottom: 16 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="weekStart" tickFormatter={shortDate} {...axis} label={{ value: "Week starting (dd/mm)", position: "insideBottom", offset: -4, fill: "var(--muted)", fontSize: 12 }} height={52} />
              <YAxis {...axis} width={44} label={{ value: "km", angle: -90, position: "insideLeft", fill: "var(--muted)", fontSize: 12 }} />
              <Bar dataKey="km" fill="var(--accent)" radius={[6, 6, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <Table head={["Week starting", "km", "Runs"]} rows={[...t.weeklyDistance].reverse().map((w) => [formatDate(w.weekStart), (w.distanceM / 1000).toFixed(1), w.runs])} />
        {synced}
      </Card>

      <Card title="VO2 max">
        {t.vo2max.length === 0 ? <Empty /> : (
          <>
            <p className="t-secondary mb-2">ml/kg/min, Garmin estimate.{lastVo2 ? ` Latest ${formatDate(lastVo2.date)}: ${lastVo2.value}.` : ""}</p>
            <div role="img" aria-label="Line chart of VO2 max. A table follows." className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={t.vo2max} margin={{ left: 0, right: 8, top: 8, bottom: 16 }}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} {...axis} label={{ value: "Date (dd/mm)", position: "insideBottom", offset: -4, fill: "var(--muted)", fontSize: 12 }} height={52} />
                  <YAxis domain={["dataMin - 1", "dataMax + 1"]} {...axis} width={44} label={{ value: "VO2 max", angle: -90, position: "insideLeft", fill: "var(--muted)", fontSize: 12 }} />
                  <Line dataKey="value" stroke="var(--accent)" dot={false} strokeWidth={2} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <Table head={["Date", "VO2 max"]} rows={[...t.vo2max].reverse().map((p) => [formatDate(p.date), p.value])} />
          </>
        )}
        {synced}
      </Card>

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
            <Table head={["Week starting", "Average score"]} rows={[...t.endurance.weekly].reverse().map((w) => [formatDate(w.weekStart), w.avg])} />
          </>
        )}
        {synced}
      </Card>

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

export function TrendsScreen() {
  const q = useTrends();
  return (
    <div className="space-y-3">
      <h1 className="t-greeting">Trends</h1>
      {q.isPending && <div aria-hidden="true" className="h-64 rounded-3xl bg-surface-2" />}
      {q.isError && !q.data && (
        <div role="alert" className="card">
          <p>{q.error.message}</p>
          <Button className="mt-3" onClick={() => void q.refetch()}>Retry</Button>
        </div>
      )}
      {q.data && <Trends t={q.data} />}
    </div>
  );
}
