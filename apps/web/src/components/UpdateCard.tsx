import { UPDATE_OFF_TEXT, UPDATE_RECONNECTING_TEXT, UPDATE_TIMEOUT_TEXT, shortSha, type BuildInfo, type Proposal, type UpdateCheck } from "@pulse/shared";
import { useState } from "react";
import { formatTime } from "@/lib/format";
import { buildLine } from "@/lib/proposals";
import { useCheckUpdate, useCreateProposal, useProposals, useUpdateStatus } from "@/lib/queries";
import { useUpdateWatch } from "@/lib/updateWatch";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button, Card } from "./ui";

function Details({ text }: { text: string }) {
  return (
    <details className="min-w-0">
      <summary className="t-secondary flex min-h-11 cursor-pointer items-center">Details</summary>
      <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap rounded-2xl bg-surface-2 p-3 font-mono text-[12px] [overflow-wrap:anywhere]">{text}</pre>
    </details>
  );
}

/** What the check found, in words. Exported for tests. */
export function checkSummary(c: UpdateCheck): { headline: string; detail: string | null } {
  if (c.state === "up_to_date") return { headline: "Up to date", detail: null };
  if (c.state === "available") return { headline: `Update available: ${c.latest ? buildLine({ sha: c.latest.sha, shortSha: c.latest.shortSha, builtAt: c.latest.builtAt }).replace(/^Build /, "build ") : "a newer build"}`, detail: null };
  return { headline: "Could not check", detail: c.reason };
}

/** Settings card: the running build, a read only check against GHCR, and Update now through a proposal and the confirm dialog. */
export function UpdateCard() {
  const status = useUpdateStatus();
  const check = useCheckUpdate();
  const create = useCreateProposal();
  const proposals = useProposals();
  const watch = useUpdateWatch();
  const [openId, setOpenId] = useState<string | null>(null);

  const s = status.data;
  const result = check.data?.check ?? s?.check ?? null;
  // After a successful update the old build line would be wrong until a reload, so show the build the app now reports.
  const build: BuildInfo | undefined = watch.state.phase === "updated" ? watch.state.build : s?.build;
  const open: Proposal | null = openId && proposals.data ? ([...proposals.data.pending, ...proposals.data.history].find((p) => p.id === openId) ?? null) : null;
  const watching = watch.state.phase === "watching";
  const summary = result ? checkSummary(result) : null;

  return (
    <Card title="App update">
      <div className="space-y-3 text-[15px]">
        {status.isPending && <p className="t-secondary">Loading</p>}
        {status.isError && <p role="alert" className="text-danger">{status.error.message}</p>}
        {build && <p className="font-semibold [overflow-wrap:anywhere]">{buildLine(build)}</p>}

        {summary && !watching && watch.state.phase === "idle" && (
          <div role="status">
            <p className="font-semibold">{summary.headline}</p>
            {result && <p className="t-secondary">Checked {formatTime(result.checkedAt)}. A check is reused for 10 minutes.</p>}
            {summary.detail && <Details text={summary.detail} />}
          </div>
        )}

        {watching && <p role="status" className="font-semibold">{UPDATE_RECONNECTING_TEXT}</p>}
        {watch.state.phase === "updated" && (
          <div role="status" className="space-y-2">
            <p className="font-semibold">Updated to {shortSha(watch.state.build.sha)}</p>
            <p className="t-secondary">Reload to load the new screens.</p>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        )}
        {watch.state.phase === "timeout" && (
          <div role="alert" className="space-y-1">
            <p className="font-semibold">{UPDATE_TIMEOUT_TEXT}</p>
            <Details text={watch.state.detail} />
            <Button variant="secondary" onClick={watch.reset}>Dismiss</Button>
          </div>
        )}

        {watch.state.phase === "idle" && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? "Checking" : "Check for update"}</Button>
            <Button
              variant={result?.state === "available" ? "primary" : "secondary"}
              disabled={!s?.updatesEnabled || create.isPending}
              onClick={() => create.mutate({ kind: "app.update" }, { onSuccess: (r) => setOpenId(r.proposal.id) })}
            >
              {create.isPending ? "Preparing" : "Update now"}
            </Button>
          </div>
        )}
        {s && !s.updatesEnabled && <p className="t-secondary">{UPDATE_OFF_TEXT}</p>}
        {create.isError && <p role="alert" className="text-[13px] font-medium text-danger [overflow-wrap:anywhere]">{create.error.message}</p>}
        {check.isError && <p role="alert" className="text-[13px] font-medium text-danger [overflow-wrap:anywhere]">{check.error.message}</p>}
      </div>
      <ConfirmDialog
        proposal={open}
        writesEnabled
        probeRecorded
        onClose={() => setOpenId(null)}
        onConfirmed={(p) => {
          setOpenId(null);
          if (p.kind === "app.update") watch.start(p.before.sha ?? "");
        }}
      />
    </Card>
  );
}
