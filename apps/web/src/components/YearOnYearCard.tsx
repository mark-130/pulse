import type { YearOnYear } from "@pulse/shared";
import { periodText } from "@/lib/history";
import { useYearOnYear } from "@/lib/queries";
import { Card } from "./ui";

/** "45.7 ml/kg/min on 07/11/2026" becomes the value large and the date small below it, so a date never breaks across lines. */
function Value({ v }: { v: string | null }) {
  if (v === null) return <>--</>;
  const [value, date] = v.split(" on ");
  return (
    <>
      {value}
      {date && <span className="t-secondary block font-sans text-[13px] font-normal">on {date}</span>}
    </>
  );
}

/** This year against last year for the same calendar period. The two values side by side, no difference and no judgement. */
export function YearOnYearView({ y }: { y: YearOnYear }) {
  return (
    <Card title="This year against last year" className="md:col-span-2">
      <p className="t-secondary mb-3">The same part of the calendar: {periodText(y.thisYear.from, y.thisYear.to)} against {periodText(y.lastYear.from, y.lastYear.to)}.</p>
      <ul className="space-y-3">
        {y.rows.map((r) => (
          <li key={r.key} className="min-w-0 border-t border-border pt-3 first:border-t-0 first:pt-0">
            <p className="font-medium">{r.label}</p>
            <dl className="mt-1 grid grid-cols-2 gap-x-4 text-[15px]">
              <div className="min-w-0"><dt className="t-label">This year</dt><dd className="font-display text-[20px] font-semibold [overflow-wrap:break-word]"><Value v={r.thisYear} /></dd></div>
              <div className="min-w-0"><dt className="t-label">Last year</dt><dd className="font-display text-[20px] font-semibold [overflow-wrap:break-word]"><Value v={r.lastYear} /></dd></div>
            </dl>
            {r.note && <p className="t-secondary mt-1">{r.note}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function YearOnYearCard() {
  const q = useYearOnYear();
  if (q.isPending) return <Card title="This year against last year" className="md:col-span-2"><p className="t-secondary">Loading</p></Card>;
  if (q.isError && !q.data) return <Card title="This year against last year" className="md:col-span-2"><p role="alert" className="text-danger">{q.error.message}</p></Card>;
  return q.data ? <YearOnYearView y={q.data} /> : null;
}
