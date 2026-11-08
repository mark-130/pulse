import { isAppUpdate, type Proposal } from "@pulse/shared";
import { useState } from "react";
import { Chip } from "@/components/Chip";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button, Card, EmptyState } from "@/components/ui";
import { formatDateTime, formatDayDate, plural } from "@/lib/format";
import { buildText, isDestructive, kindTitle, statusLabel, targetName, verificationLabel } from "@/lib/proposals";
import { useProposals } from "@/lib/queries";

function summary(p: Proposal): string {
  if (isAppUpdate(p)) return `Update this app, from ${buildText(p.before)} to ${buildText(p.after)}`;
  return p.kind === "garmin.reschedule" && p.after ? `${p.before.name}: ${formatDayDate(p.before.date)} to ${formatDayDate(p.after.date)}` : `${p.before.name}, ${formatDayDate(p.before.date)}, removed from the schedule`;
}

function Row({ p, action }: { p: Proposal; action?: React.ReactNode }) {
  const verification = verificationLabel(p.result?.verification);
  return (
    <li className="flex min-w-0 flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <p className="font-medium">{kindTitle(p.kind)}</p>
        <Chip>{targetName(p.kind)}</Chip>
        {p.status !== "pending" && <Chip tone={p.status === "applied" ? "taper" : "neutral"}>{statusLabel(p)}</Chip>}
        {verification && <Chip tone={p.result?.verification?.state === "verified" ? "taper" : "neutral"}>{verification}</Chip>}
      </div>
      <p className={`text-[15px] [overflow-wrap:anywhere] ${isDestructive(p.kind) ? "text-danger" : ""}`}>{summary(p)}</p>
      <p className="t-secondary">
        {p.status === "pending" ? `Expires ${formatDateTime(p.expiresAt)}` : `Proposed ${formatDateTime(p.createdAt)}${p.decidedAt ? `, decided ${formatDateTime(p.decidedAt)}` : ""}`}
      </p>
      {action}
    </li>
  );
}

export function Proposals() {
  const q = useProposals();
  const [openId, setOpenId] = useState<string | null>(null);
  const data = q.data;
  const open = data ? ([...data.pending, ...data.history].find((p) => p.id === openId) ?? null) : null;
  return (
    <div className="space-y-3">
      <h1 className="t-greeting">Proposals</h1>
      <p className="t-secondary">Nothing is applied until you confirm. Changes move workouts to another date, remove them from the Garmin schedule, or update this app.</p>
      {data && <p className="t-secondary font-semibold">{data.writesEnabled ? "Garmin writes are on." : "Garmin writes are off. Confirmed changes are recorded as dry runs and nothing is sent to Garmin."}</p>}
      {q.isPending && <EmptyState>Loading</EmptyState>}
      {q.isError && !data && (
        <div role="alert" className="card">
          <p>{q.error.message}</p>
          <Button className="mt-3" onClick={() => void q.refetch()}>Retry</Button>
        </div>
      )}
      {data && (
        <>
          <Card title={`Waiting for you (${data.pending.length})`}>
            {data.pending.length === 0 ? (
              <EmptyState>Nothing waiting. Use Move or Remove from schedule on a planned workout in Week.</EmptyState>
            ) : (
              <ul className="space-y-3">
                {data.pending.map((p) => (
                  <Row key={p.id} p={p} action={<Button variant="secondary" className="w-full sm:w-auto" onClick={() => setOpenId(p.id)}>Review</Button>} />
                ))}
              </ul>
            )}
          </Card>
          <Card title="History">
            {data.history.length === 0 ? <EmptyState>No decisions yet.</EmptyState> : (
              <ul className="space-y-3">
                {data.history.map((p) => (
                  <Row key={p.id} p={p} action={<Button variant="secondary" className="w-full sm:w-auto" onClick={() => setOpenId(p.id)}>Details</Button>} />
                ))}
              </ul>
            )}
            <p className="t-label mt-3">{plural(data.history.length, "decision")} shown.</p>
          </Card>
        </>
      )}
      <ConfirmDialog proposal={open} writesEnabled={data?.writesEnabled ?? false} probeRecorded={data?.probeRecorded ?? false} onClose={() => setOpenId(null)} />
    </div>
  );
}
