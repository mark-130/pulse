import type { GroupStatus, SyncStatus } from "@pulse/shared";
import { formatDateTime, plural } from "./format";

export interface Banner {
  tone: "stale" | "offline";
  /** Plain reason in one line, or null when there is no known error. */
  headline: string | null;
  /** Which data is behind and which is current. */
  text: string;
  /** "Last synced dd/mm/yyyy hh:mm." */
  synced: string | null;
  /** Raw last error. Shown only behind the Details disclosure. */
  detail: string | null;
}

export function ageText(minutes: number): string {
  if (minutes < 120) return plural(minutes, "minute");
  if (minutes < 48 * 60) return plural(Math.round(minutes / 60), "hour");
  return plural(Math.round(minutes / 1440), "day");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One line a person can read, whatever the raw error says. */
export function friendlyReason(error: string | null): string | null {
  if (!error) return null;
  if (/timed?[ -]?out|ETIMEDOUT/i.test(error)) return "Garmin Connect timed out. Retrying automatically.";
  return "Garmin Connect did not answer properly. Retrying automatically.";
}

function verb(items: GroupStatus[]): string {
  return items.length > 1 || items[0]?.plural ? "are" : "is";
}

/** What the full stale banner should say, or null. Only a stale plan or readiness kind shows it. */
export function bannerFor(status: SyncStatus | undefined, online: boolean): Banner | null {
  if (!online) {
    const when = status?.garmin.lastOk ? `Last synced ${formatDateTime(status.garmin.lastOk)}.` : null;
    return { tone: "offline", headline: null, text: "You are offline. Showing the last saved data.", synced: when, detail: null };
  }
  if (!status) return null;
  const g = status.garmin;
  const detail = status.groups.find((x) => x.critical && x.stale && x.lastError)?.lastError ?? g.lastError;
  if (g.lastOk === null) return { tone: "stale", headline: friendlyReason(detail), text: "Garmin has not synced yet.", synced: null, detail };
  if (!g.stale) return null;
  const synced = `Last synced ${formatDateTime(g.lastOk)}.`;
  const behind = status.groups.filter((x) => x.critical && x.stale);
  if (behind.length === 0) {
    return { tone: "stale", headline: friendlyReason(detail), text: `Garmin data is ${ageText(g.ageMinutes ?? 0)} old.`, synced, detail };
  }
  const current = status.groups.filter((x) => !x.stale);
  const oldest = Math.max(...behind.map((x) => x.ageMinutes ?? g.ageMinutes ?? 0));
  const names = list(behind.map((x) => x.label));
  const behindText = behind.some((x) => x.lastOk === null) ? `${cap(names)} ${verb(behind) === "are" ? "have" : "has"} not synced yet.` : `${cap(names)} ${verb(behind)} ${ageText(oldest)} old.`;
  const currentText = current.length ? ` ${cap(list(current.map((x) => x.label)))} ${verb(current)} current.` : "";
  return { tone: "stale", headline: friendlyReason(detail), text: behindText + currentText, synced, detail };
}

/** Quiet inline note for a stale kind that does not need the full banner, or null. */
export function kindNote(status: SyncStatus | undefined, id: GroupStatus["id"]): string | null {
  const grp = status?.groups.find((x) => x.id === id);
  if (!grp || grp.critical || !grp.stale) return null;
  const age = grp.ageMinutes === null ? "not synced yet" : `${ageText(grp.ageMinutes)} old`;
  return `${cap(grp.label)} ${grp.plural ? "are" : "is"} ${age}. Retrying automatically.`;
}
