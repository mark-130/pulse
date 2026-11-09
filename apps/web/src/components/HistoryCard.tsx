import type { HistoryStatus } from "@pulse/shared";
import { formatDate } from "@/lib/format";
import { TriangleAlert } from "lucide-react";
import { finishText, issuesLine, kindStateText, periodText, primaryAction, progressText, stateLine } from "@/lib/history";
import { useHistory, useHistoryAction } from "@/lib/queries";
import { Button, Card } from "./ui";

function Details({ s }: { s: HistoryStatus }) {
  const attention = s.kinds.filter((k) => k.state === "attention");
  if (s.failedWindows.length === 0 && attention.length === 0 && !(s.reason && (s.state === "stopped" || s.state === "paused"))) return null;
  return (
    <details className="min-w-0">
      <summary className="t-secondary flex min-h-11 cursor-pointer items-center">Details</summary>
      <div className="space-y-2 rounded-2xl bg-surface-2 p-3 text-[13px] [overflow-wrap:anywhere]">
        {s.reason && (s.state === "stopped" || s.state === "paused") && <p className="font-semibold">{s.reason}</p>}
        {attention.length > 0 && (
          <ul className="space-y-1">
            {attention.map((k) => <li key={k.id}><span className="font-semibold">{k.label}:</span> {k.reason}</li>)}
          </ul>
        )}
        {s.failedWindows.length > 0 && (
          <ul className="space-y-1">
            {s.failedWindows.map((w) => (
              // A reason that already names the kind and the dates (an answer in an unexpected shape) is shown as it is.
              <li key={`${w.kind}-${w.from}`}>{w.reason.includes(`(${w.label}, `) ? w.reason : `${w.label}, ${formatDate(w.from)} to ${formatDate(w.to)}: ${w.reason}`}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

export interface HistoryViewProps {
  s: HistoryStatus;
  pending: boolean;
  onAction: (a: "start" | "pause" | "resume") => void;
}

/** The history import card (D51). The view is separate from the data so it can be tested in every state. */
export function HistoryView({ s, pending, onAction }: HistoryViewProps) {
  const action = primaryAction(s);
  const finish = finishText(s);
  return (
    <>
      <div className="space-y-3 text-[15px]">
        <p>Reads your Garmin history once, gently, so Trends can compare this year with last year. It reads from Garmin and never changes anything there.</p>
        <p className="t-secondary">Covers {s.days} days, {periodText(s.from, s.to)}. Race predictions, personal records and heart rate zones are not imported: Garmin keeps no history for them.</p>
        <p role="status" className="font-semibold">{stateLine(s)}</p>
        {issuesLine(s) && <p className="t-secondary flex items-start gap-1"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-[color:var(--state-warn)]" />{issuesLine(s)}</p>}
        {finish && <p className="t-secondary">{finish}</p>}
        {action && (
          <Button className="w-full sm:w-auto" disabled={pending} onClick={() => onAction(action.action)}>
            {pending ? "Working" : action.label}
          </Button>
        )}
        <ul className="space-y-3" aria-label="Progress by kind">
          {s.kinds.map((k) => (
            <li key={k.id} className="min-w-0">
              <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span>{progressText(k)}</span>
                <span className="t-label">{k.state === "attention" && <TriangleAlert aria-hidden className="mr-1 inline size-3.5 align-[-2px] text-[color:var(--state-warn)]" />}{kindStateText(k)}{k.failed > 0 ? `, ${k.failed} failed` : ""}</span>
              </p>
              <div className="mt-1 h-1.5 rounded-full bg-surface-2" role="img" aria-label={`${k.label}: ${k.done} of ${k.total} days imported`}>
                <div className="h-1.5 rounded-full" style={{ width: `${k.total ? Math.min(100, Math.round((k.done / k.total) * 100)) : 0}%`, background: "var(--ai-gradient)" }} />
              </div>
            </li>
          ))}
        </ul>
        <Details s={s} />
      </div>
      <p className="t-label mt-3">The history sits in the same database as everything else, so the nightly backup covers it. The routine sync and the nightly backup always go first: the import waits for them.</p>
    </>
  );
}

export function HistoryCard() {
  const q = useHistory();
  const act = useHistoryAction();
  return (
    <Card title="History import">
      {q.isPending && <p className="t-secondary">Loading</p>}
      {q.isError && !q.data && <p role="alert" className="text-danger">{q.error.message}</p>}
      {q.data && <HistoryView s={q.data} pending={act.isPending} onAction={(a) => act.mutate(a)} />}
      {act.isError && <p role="alert" className="mt-2 text-[13px] font-medium text-danger [overflow-wrap:anywhere]">{act.error.message}</p>}
    </Card>
  );
}
