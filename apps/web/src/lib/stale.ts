import type { SyncStatus } from "@pulse/shared";
import { formatDateTime, plural } from "./format";

export interface Banner {
  tone: "stale" | "offline";
  text: string;
  /** Plain last error, safe to show. */
  detail: string | null;
}

function ageText(minutes: number): string {
  if (minutes < 120) return plural(minutes, "minute");
  if (minutes < 48 * 60) return plural(Math.round(minutes / 60), "hour");
  return plural(Math.round(minutes / 1440), "day");
}

/** What the stale banner should say, or null when everything is fresh. */
export function bannerFor(status: SyncStatus | undefined, online: boolean): Banner | null {
  if (!online) {
    const when = status?.garmin.lastOk ? ` Last synced ${formatDateTime(status.garmin.lastOk)}.` : "";
    return { tone: "offline", text: `You are offline. Showing the last saved data.${when}`, detail: null };
  }
  if (!status) return null;
  const g = status.garmin;
  if (g.lastOk === null) return { tone: "stale", text: "Garmin has not synced yet.", detail: g.lastError };
  if (!g.stale) return null;
  return {
    tone: "stale",
    text: `Garmin data is ${ageText(g.ageMinutes ?? 0)} old. Last synced ${formatDateTime(g.lastOk)}.`,
    detail: g.lastError,
  };
}
