import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { formatDateTime } from "@/lib/format";
import { useSyncNow, useSyncStatus } from "@/lib/queries";
import { Button } from "./ui";

export function SyncSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const status = useSyncStatus();
  const sync = useSyncNow();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const g = status.data?.garmin;
  const b = status.data?.backup;
  const state = !g ? "Loading" : g.lastOk === null ? "Not synced yet" : g.consecutiveFailures > 0 ? "Failing, showing older data" : g.stale ? "Stale" : "Up to date";
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="sync-title"
      className="m-auto w-[min(26rem,calc(100%-2.5rem))] rounded-3xl border border-border-strong bg-surface p-5 text-foreground backdrop:bg-black/60 max-md:mb-0 max-md:rounded-b-none"
    >
      <h2 id="sync-title" className="t-card-title mb-3">Sync status</h2>
      <dl className="space-y-2 text-[15px]">
        <div className="flex justify-between gap-4"><dt className="t-secondary">Garmin</dt><dd className="text-right">{state}</dd></div>
        <div className="flex justify-between gap-4"><dt className="t-secondary">Last synced</dt><dd>{g?.lastOk ? formatDateTime(g.lastOk) : "Never"}</dd></div>
        {g?.lastError && <div className="flex justify-between gap-4"><dt className="t-secondary">Last error</dt><dd className="text-right">{g.lastError}</dd></div>}
        {g?.detail && <div className="flex justify-between gap-4"><dt className="t-secondary">Note</dt><dd className="text-right">{g.detail}</dd></div>}
        <div className="flex justify-between gap-4"><dt className="t-secondary">Nightly backup</dt><dd>{b?.lastOk ? formatDateTime(b.lastOk) : "Not yet"}</dd></div>
      </dl>
      <p className="t-secondary mt-3">Sync reads from Garmin. It never changes anything in Garmin.</p>
      {sync.isError && <p role="alert" className="mt-2 text-[13px] font-medium text-danger">{sync.error.message}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? "Syncing" : "Sync now"}</Button>
        <Button asChild variant="secondary"><Link to="/settings" onClick={onClose}>Settings</Link></Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </dialog>
  );
}
