import { CloudOff, TriangleAlert } from "lucide-react";
import { bannerFor } from "@/lib/stale";
import { useOnline, useSyncNow, useSyncStatus } from "@/lib/queries";
import { Button } from "./ui";

/** Shown on every screen when Garmin data is stale or the device is offline. Icon plus text, never colour alone. */
export function StaleBanner() {
  const status = useSyncStatus();
  const online = useOnline();
  const sync = useSyncNow();
  const banner = bannerFor(status.data, online);
  if (!banner) return null;
  const Icon = banner.tone === "offline" ? CloudOff : TriangleAlert;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-3xl border border-[color:var(--verdict-easy)] bg-surface px-4 py-3">
      <Icon aria-hidden className="size-5 shrink-0 text-[color:var(--verdict-easy)]" />
      <div className="min-w-0 flex-1 text-[15px]">
        <p>{banner.text}</p>
        {banner.detail && <p className="t-secondary">Last error: {banner.detail}</p>}
        {sync.isError && <p className="t-secondary">{sync.error.message}</p>}
      </div>
      {banner.tone === "stale" && online && (
        <Button variant="secondary" disabled={sync.isPending} onClick={() => sync.mutate()}>
          {sync.isPending ? "Syncing" : "Sync now"}
        </Button>
      )}
    </div>
  );
}
