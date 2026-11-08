import { shortSha, type AppUpdateProposal, type BuildInfo, type BuildState, type GarminProposal, type Proposal, type ProposalKind, type Verification } from "@pulse/shared";
import { formatClockDay, formatDateTime, formatDayDate, formatDurationMin } from "./format";

export const kindTitle = (kind: ProposalKind): string => (kind === "garmin.reschedule" ? "Move workout" : kind === "app.update" ? "Update this app" : "Remove from schedule");

/** The system a proposal changes, as the chip and the dialog overline say it. */
export const targetName = (kind: ProposalKind): string => (kind === "app.update" ? "This app" : "Garmin");

/** "Build cc3b793, built 07/11/2026 12:30". */
export function buildLine(b: Pick<BuildInfo, "sha" | "shortSha" | "builtAt">): string {
  if (b.sha === "dev") return "Build dev, not a CI build";
  return b.builtAt ? `Build ${b.shortSha}, built ${formatDateTime(b.builtAt)}` : `Build ${b.shortSha}`;
}

/** "cc3b793, built 07/11/2026 12:30", or a plain note when the build is not known. */
export function buildText(b: BuildState | null): string {
  if (!b || !b.sha) return "The latest image (build not known)";
  const short = shortSha(b.sha);
  return b.builtAt ? `${short}, built ${formatDateTime(b.builtAt)}` : short;
}

export const isDestructive = (kind: ProposalKind): boolean => kind === "garmin.unschedule";

export interface DiffRow {
  label: string;
  before: string;
  after: string;
}

/** The exact before and after, in words. Dates and removal only: workout content is never edited. */
type DiffInput = Pick<GarminProposal, "kind" | "before" | "after"> | Pick<AppUpdateProposal, "kind" | "before" | "after">;
export function diffRows(p: DiffInput): DiffRow[] {
  if (p.kind === "app.update") {
    return [
      { label: "Target", before: "This app, via Watchtower", after: "This app, via Watchtower" },
      { label: "Build", before: buildText(p.before), after: buildText(p.after) },
    ];
  }
  const rows: DiffRow[] = [{ label: "Workout", before: p.before.name, after: p.before.name }];
  if (p.kind === "garmin.reschedule" && p.after) {
    rows.push({ label: "Date", before: formatDayDate(p.before.date), after: formatDayDate(p.after.date) });
    rows.push({ label: "Length", before: formatDurationMin(p.before.durationS), after: formatDurationMin(p.before.durationS) });
  } else {
    rows.push({ label: "On the Garmin calendar", before: formatDayDate(p.before.date), after: "Removed. The workout stays in your Garmin library." });
  }
  return rows;
}

export function updateLabel(r: Proposal["result"]): string | null {
  const u = r?.update;
  if (!u) return null;
  if (u.state === "updated") return `Updated to ${u.runningSha ? shortSha(u.runningSha) : "the new build"}`;
  if (u.state === "not_completed") return "Not completed, still on the previous build";
  return "Waiting for the restart";
}

export function statusLabel(p: Pick<Proposal, "status" | "result">): string {
  switch (p.status) {
    case "pending":
      return "Waiting for you";
    case "applied":
      return p.result?.mode === "dry_run" ? "Applied as a dry run" : p.result?.update ? (updateLabel(p.result) ?? "Applied") : "Applied";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    case "stale":
      return "Out of date";
    case "failed":
      return "Failed";
  }
}

export function verificationLabel(v: Verification | undefined): string | null {
  if (!v) return null;
  if (v.state === "verified") return "Verified";
  if (v.state === "reverted") return "Reverted by the plan app";
  return v.lastConfirmedAt ? `Checking, last confirmed ${formatClockDay(v.lastConfirmedAt)}` : "Checking, not confirmed by a sync yet";
}
