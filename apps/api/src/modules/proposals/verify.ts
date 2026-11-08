import { and, eq } from "drizzle-orm";
import type { Verification } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { proposal as proposalTable, workout } from "../../db/schema.js";
import { appendAudit } from "./audit.js";
import { getProposal, listHistory } from "./engine.js";

export const VERIFY_SYNCS = 2;

/**
 * Sync conflict probe. After a live change is applied, each of the next two successful workout syncs compares
 * what Garmin now lists with what the change should have produced. Reads our own database only.
 */
export function verifyApplied(db: Db, now: Date): number {
  const nowIso = now.toISOString();
  let checked = 0;
  for (const p of listHistory(db, 200)) {
    const v = p.result?.verification;
    if (p.status !== "applied" || p.result?.mode !== "live" || !v || v.state !== "waiting" || !p.decidedAt || nowIso <= p.decidedAt) continue;
    const row = db.select().from(workout).where(eq(workout.garminScheduledId, p.before.scheduledId)).get();
    const seen = row ? row.date : "missing";
    const expected = p.kind === "garmin.reschedule" ? (p.after?.date ?? "") : "missing";
    const original = p.kind === "garmin.reschedule" ? p.before.date : null;
    let state: Verification["state"] = "waiting";
    let matches = v.matches;
    if (seen === expected) matches++;
    else state = "reverted";
    if (state === "waiting" && matches >= VERIFY_SYNCS) state = "verified";
    const next: Verification = { state, matches, checks: [...v.checks, { at: nowIso, seen: seen === original ? `${seen} (original date)` : seen }] };
    db.transaction(() => {
      db.update(proposalTable)
        .set({ result: { ...p.result, verification: next } })
        .where(and(eq(proposalTable.id, p.id), eq(proposalTable.status, "applied")))
        .run();
      appendAudit(db, {
        ts: nowIso,
        actor: "system",
        action: state === "waiting" ? "verification.checked" : `verification.${state}`,
        target: `${p.kind}:${p.before.scheduledId}`,
        payload: { id: p.id, expected, seen },
        result: state,
      });
    });
    checked++;
  }
  return checked;
}

export function verificationOf(db: Db, id: string): Verification | null {
  return getProposal(db, id)?.result?.verification ?? null;
}
