import { DRY_RUN_TEXT, PLAN_APP_NOTE, type Proposal } from "@pulse/shared";
import { TriangleAlert } from "lucide-react";
import { useConfirmProposal, useRejectProposal } from "@/lib/queries";
import { formatDateTime, formatDayDate } from "@/lib/format";
import { diffRows, isDestructive, kindTitle, statusLabel, verificationLabel } from "@/lib/proposals";
import { Modal } from "./Modal";
import { Button } from "./ui";

/**
 * The confirm dialog (docs/DESIGN.md, Behaviour rules). Names the target system, shows the exact before and after,
 * one primary Confirm, a Reject, nothing pre-selected, destructive changes in red. No orb, no humour.
 */
export function ConfirmDialog({ proposal, writesEnabled, probeRecorded, onClose }: { proposal: Proposal | null; writesEnabled: boolean; probeRecorded: boolean; onClose: () => void }) {
  const confirm = useConfirmProposal();
  const reject = useRejectProposal();
  const busy = confirm.isPending || reject.isPending;
  const p = proposal;
  const destructive = p ? isDestructive(p.kind) : false;
  const pending = p?.status === "pending";
  return (
    <Modal open={p !== null} onClose={onClose} labelledBy="confirm-title">
      {p && (
        <>
          <p className="t-overline">Change to Garmin</p>
          <h2 id="confirm-title" className="t-card-title mb-3">{kindTitle(p.kind)}</h2>

          {pending && !writesEnabled && (
            <p className="mb-3 flex items-start gap-2 rounded-2xl border border-border-strong bg-surface-2 p-3 text-[15px] font-semibold">
              <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-[color:var(--verdict-easy)]" />
              <span>{DRY_RUN_TEXT}</span>
            </p>
          )}

          <dl className="space-y-3 text-[15px]">
            {diffRows(p).map((r) => (
              <div key={r.label} className="min-w-0">
                <dt className="t-label">{r.label}</dt>
                {r.before === r.after ? (
                  <dd className="[overflow-wrap:anywhere]">{r.before}</dd>
                ) : (
                  <dd className="space-y-1 [overflow-wrap:anywhere]">
                    <p><span className="t-secondary">Before: </span>{r.before}</p>
                    <p className={destructive ? "font-semibold text-danger" : "font-semibold"}><span className="t-secondary font-normal">After: </span>{r.after}</p>
                  </dd>
                )}
              </div>
            ))}
          </dl>
          {p.kind === "garmin.reschedule" && !probeRecorded && <p className="t-secondary mt-3">{PLAN_APP_NOTE}</p>}
          <p className="t-secondary mt-3">Proposed by you, {formatDateTime(p.createdAt)}. Expires {formatDateTime(p.expiresAt)}.</p>

          {p.status === "stale" && (
            <div role="alert" className="mt-3 rounded-2xl border border-[color:var(--verdict-easy)] p-3 text-[15px]">
              <p className="font-semibold">The workout changed in Garmin since this was proposed. Nothing was sent.</p>
              <p className="t-secondary mt-1 [overflow-wrap:anywhere]">
                {p.result?.live ? `Garmin now has ${p.result.live.name} on ${formatDayDate(p.result.live.date)}.` : "It is no longer on the Garmin schedule."} Make the change again from Week.
              </p>
            </div>
          )}
          {p.status !== "pending" && p.status !== "stale" && (
            <p role="status" className="mt-3 text-[15px] font-semibold">{statusLabel(p)}.{p.status === "applied" && p.result?.mode === "dry_run" ? " Nothing was sent to Garmin." : ""}</p>
          )}
          {p.status === "applied" && verificationLabel(p.result?.verification) && (
            <p className="t-secondary mt-1">Plan app check: {verificationLabel(p.result?.verification)}.</p>
          )}
          {(confirm.isError || reject.isError) && <p role="alert" className="mt-3 text-[13px] font-medium text-danger [overflow-wrap:anywhere]">{confirm.error?.message ?? reject.error?.message}</p>}

          <div className="mt-5 flex flex-col gap-2">
            {pending ? (
              <>
                <Button variant={destructive ? "danger" : "primary"} disabled={busy} onClick={() => confirm.mutate(p.id)}>
                  {confirm.isPending ? "Sending" : "Confirm"}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => reject.mutate(p.id, { onSuccess: onClose })}>Reject</Button>
                <Button variant="secondary" disabled={busy} onClick={onClose}>Not now</Button>
              </>
            ) : (
              <Button variant="secondary" onClick={onClose}>Close</Button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
