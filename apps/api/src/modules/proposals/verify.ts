import { and, eq } from "drizzle-orm";
import { VERIFY_WINDOW_HOURS, isGarminProposal, type Verification } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { proposal as proposalTable, workout } from "../../db/schema.js";
import { appendAudit } from "./audit.js";
import { getProposal, listHistory } from "./engine.js";

export const VERIFY_KEEP_CHECKS = 5;

/**
 * Sync conflict probe (D34). After a live change is applied, every sync that refreshes the scheduled workouts compares
 * what Garmin lists with what the change should have produced, for 72 hours. A mismatch ends the watch at once as
 * Reverted. If the window closes with the expected state still in place, the change is Verified. Reads our own database only.
 */
export function verifyApplied(db: Db, now: Date): number {
  const nowIso = now.toISOString();
  let checked = 0;
  for (const p of listHistory(db, 200)) {
    if (!isGarminProposal(p)) continue;
    const v = p.result?.verification;
    if (p.status !== "applied" || p.result?.mode !== "live" || !v || v.state !== "waiting" || !p.decidedAt || nowIso <= p.decidedAt) continue;
    const windowEnd = v.windowEndsAt ?? new Date(Date.parse(p.decidedAt) + VERIFY_WINDOW_HOURS * 3_600_000).toISOString();
    const row = db.select().from(workout).where(eq(workout.garminScheduledId, p.before.scheduledId)).get();
    const seen = row ? row.date : "missing";
    const expected = p.kind === "garmin.reschedule" ? (p.after?.date ?? "") : "missing";
    const original = p.kind === "garmin.reschedule" ? p.before.date : null;

    const matched = seen === expected;
    const state: Verification["state"] = !matched ? "reverted" : nowIso >= windowEnd ? "verified" : "waiting";
    const next: Verification = {
      state,
      matches: v.matches + (matched ? 1 : 0),
      checks: [...v.checks, { at: nowIso, seen: seen === original ? `${seen} (original date)` : seen }].slice(-VERIFY_KEEP_CHECKS),
      lastConfirmedAt: matched ? nowIso : (v.lastConfirmedAt ?? null),
      windowEndsAt: windowEnd,
    };
    db.transaction(() => {
      db.update(proposalTable)
        .set({ result: { ...p.result, verification: next } })
        .where(and(eq(proposalTable.id, p.id), eq(proposalTable.status, "applied")))
        .run();
      // Every check is audited, and the final outcome gets its own entry.
      appendAudit(db, { ts: nowIso, actor: "system", action: "verification.checked", target: `${p.kind}:${p.before.scheduledId}`, payload: { id: p.id, expected, seen }, result: matched ? "matched" : "mismatch" });
      if (state !== "waiting") {
        appendAudit(db, { ts: nowIso, actor: "system", action: `verification.${state}`, target: `${p.kind}:${p.before.scheduledId}`, payload: { id: p.id, expected, seen }, result: state });
      }
    });
    checked++;
  }
  return checked;
}

export function verificationOf(db: Db, id: string): Verification | null {
  return getProposal(db, id)?.result?.verification ?? null;
}
