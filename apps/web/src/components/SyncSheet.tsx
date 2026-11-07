import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { Button } from "./ui";

export function SyncSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
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
        <div className="flex justify-between"><dt className="t-secondary">Garmin</dt><dd>Not synced yet</dd></div>
        <div className="flex justify-between"><dt className="t-secondary">Last successful sync</dt><dd>None</dd></div>
      </dl>
      <p className="t-secondary mt-3">Garmin sync arrives in Phase 1.</p>
      <div className="mt-4 flex gap-2">
        <Button asChild><Link to="/settings" onClick={onClose}>Settings</Link></Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </dialog>
  );
}
