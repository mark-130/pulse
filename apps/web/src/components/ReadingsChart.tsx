import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { SERIES_KINDS, type HistorySeries } from "@pulse/shared";
import { formatDate } from "@/lib/format";
import { useHistorySeries } from "@/lib/queries";
import { notImportedNote } from "@/lib/zones";
import { Card } from "./ui";

const axis = { stroke: "var(--border-strong)", tick: { fill: "var(--muted)", fontSize: 12 } } as const;
const shortDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const monthYear = (d: string) => `${d.slice(5, 7)}/${d.slice(2, 4)}`;

/** Sleep, HRV, resting heart rate, readiness and body battery: the daily values thin, the 7 day average bold. */
export function ReadingsChartView({ data, days, kind, onKind, today }: { data: HistorySeries; days: number; kind: string; onKind: (k: string) => void; today: string }) {
  const s = data.series.find((x) => x.id === kind) ?? data.series[0];
  const unit = SERIES_KINDS.find((k) => k.id === s?.id)?.unit ?? "";
  const note = s ? notImportedNote(days, s.stored?.from ?? null, today) : null;
  const long = days > 120;
  return (
    <Card title="Daily readings" className="md:col-span-2">
      <div className="mb-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" role="group" aria-label="Reading">
        {SERIES_KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            aria-pressed={s?.id === k.id}
            onClick={() => onKind(k.id)}
            className={`min-h-11 rounded-full border px-4 text-[15px] font-semibold ${s?.id === k.id ? "border-accent bg-accent text-accent-foreground" : "border-border-strong bg-surface-2 text-foreground"}`}
          >
            {k.label}
          </button>
        ))}
      </div>
      {!s || s.points.length === 0 ? (
        <>
          <p className="t-secondary">{s?.stored ? "Nothing stored in this range." : "Nothing stored yet. Start the history import in Settings to fill it."}</p>
          {note && <p className="t-secondary mt-2">{note}</p>}
        </>
      ) : (
        <>
          <p className="t-secondary mb-2">{s.label}{unit ? ` (${unit})` : ""}. The thin line is each day, the bold line is the 7 day average. Latest {formatDate(s.points[s.points.length - 1]?.date ?? "")}: {s.points[s.points.length - 1]?.value}.</p>
          <div role="img" aria-label={`Line chart of ${s.label}, daily values and a 7 day average. A table follows.`} className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={s.points} margin={{ left: 0, right: 8, top: 8, bottom: 16 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={long ? monthYear : shortDate} {...axis} minTickGap={36} label={{ value: long ? "Month (mm/yy)" : "Date (dd/mm)", position: "insideBottom", offset: -4, fill: "var(--muted)", fontSize: 12 }} height={52} />
                <YAxis domain={["dataMin - 2", "dataMax + 2"]} {...axis} width={40} tickFormatter={(v: number) => String(Math.round(v))} />
                <Line dataKey="value" name="Daily" stroke="var(--muted)" strokeOpacity={0.55} strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
                <Line dataKey="avg7" name="7 day average" stroke="var(--accent)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {note && <p className="t-secondary mt-2">{note}</p>}
          <details className="mt-3">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-[13px] text-accent">Show as table</summary>
            <div className="max-h-64 overflow-auto">
              <table className="w-full text-left text-[13px]">
                <thead><tr><th className="t-label py-1 pr-3 font-medium">Date</th><th className="t-label py-1 pr-3 font-medium">Value</th><th className="t-label py-1 pr-3 font-medium">7 day average</th></tr></thead>
                <tbody>{[...s.points].reverse().slice(0, 120).map((p) => <tr key={p.date} className="border-t border-border"><td className="py-1 pr-3">{formatDate(p.date)}</td><td className="py-1 pr-3">{p.value}</td><td className="py-1 pr-3">{p.avg7}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Card>
  );
}

export function ReadingsChart({ days }: { days: number }) {
  const [kind, setKind] = useState("sleep");
  const q = useHistorySeries(days);
  const today = new Date().toISOString().slice(0, 10);
  if (q.isPending) return <Card title="Daily readings" className="md:col-span-2"><p className="t-secondary">Loading</p></Card>;
  if (q.isError && !q.data) return <Card title="Daily readings" className="md:col-span-2"><p role="alert" className="text-danger">{q.error.message}</p></Card>;
  return q.data ? <ReadingsChartView data={q.data} days={days} kind={kind} onKind={setKind} today={today} /> : null;
}
