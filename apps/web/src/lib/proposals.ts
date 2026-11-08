import type { Proposal, ProposalKind, Verification } from "@pulse/shared";
import { formatClockDay, formatDayDate, formatDurationMin } from "./format";

export const kindTitle = (kind: ProposalKind): string => (kind === "garmin.reschedule" ? "Move workout" : "Remove from schedule");

export const isDestructive = (kind: ProposalKind): boolean => kind === "garmin.unschedule";

export interface DiffRow {
  label: string;
  before: string;
  after: string;
}

/** The exact before and after, in words. Dates and removal only: workout content is never edited. */
export function diffRows(p: Pick<Proposal, "kind" | "before" | "after">): DiffRow[] {
  const rows: DiffRow[] = [{ label: "Workout", before: p.before.name, after: p.before.name }];
  if (p.kind === "garmin.reschedule" && p.after) {
    rows.push({ label: "Date", before: formatDayDate(p.before.date), after: formatDayDate(p.after.date) });
    rows.push({ label: "Length", before: formatDurationMin(p.before.durationS), after: formatDurationMin(p.before.durationS) });
  } else {
    rows.push({ label: "On the Garmin calendar", before: formatDayDate(p.before.date), after: "Removed. The workout stays in your Garmin library." });
  }
  return rows;
}

export function statusLabel(p: Pick<Proposal, "status" | "result">): string {
  switch (p.status) {
    case "pending":
      return "Waiting for you";
    case "applied":
      return p.result?.mode === "dry_run" ? "Applied as a dry run" : "Applied";
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
