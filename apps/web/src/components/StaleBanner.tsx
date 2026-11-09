import { Check, CloudOff, Copy, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { bannerFor } from "@/lib/stale";
import { useOnline, useSyncNow, useSyncStatus } from "@/lib/queries";
import { Button } from "./ui";

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  }
  return (
    <Button variant="secondary" className="mt-2 w-full sm:w-auto" onClick={() => void copy()}>
      {state === "copied" ? <Check aria-hidden className="mr-2 size-4" /> : <Copy aria-hidden className="mr-2 size-4" />}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </Button>
  );
}

/** Shown on every screen when plan or readiness data is stale, or the device is offline. Icon plus text, never colour alone. */
export function StaleBanner() {
  const status = useSyncStatus();
  const online = useOnline();
  const sync = useSyncNow();
  const banner = bannerFor(status.data, online);
  if (!banner) return null;
  const Icon = banner.tone === "offline" ? CloudOff : TriangleAlert;
  return (
    <div role="status" className="mb-4 min-w-0 max-w-full rounded-3xl border border-[color:var(--state-warn)] bg-surface px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-[color:var(--state-warn)]" />
        <div className="min-w-0 flex-1 text-[15px] [overflow-wrap:anywhere]">
          {banner.headline && <p className="font-semibold">{banner.headline}</p>}
          <p>{banner.text}</p>
          {banner.synced && <p className="t-secondary">{banner.synced}</p>}
          {sync.isError && <p className="t-secondary">{sync.error.message}</p>}
        </div>
      </div>
      {banner.detail && (
        <details className="mt-2 min-w-0">
          <summary className="t-secondary flex min-h-11 cursor-pointer items-center">Details</summary>
          <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap rounded-2xl bg-surface-2 p-3 font-mono text-[12px] [overflow-wrap:anywhere]">{banner.detail}</pre>
          <CopyButton text={banner.detail} />
        </details>
      )}
      {banner.tone === "stale" && online && (
        <Button variant="secondary" className="mt-3 w-full sm:w-auto" disabled={sync.isPending} onClick={() => sync.mutate()}>
          {sync.isPending ? "Syncing" : "Sync now"}
        </Button>
      )}
    </div>
  );
}
