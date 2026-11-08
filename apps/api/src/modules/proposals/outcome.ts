import { and, eq } from "drizzle-orm";
import { UPDATE_WATCH_TIMEOUT_MS, isAppUpdate, type BuildInfo } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { proposal as proposalTable } from "../../db/schema.js";
import { appendAudit } from "./audit.js";
import { listHistory } from "./engine.js";

/**
 * Settles app.update proposals that were handed to Watchtower. The old process is stopped mid-request, so it cannot
 * record the result. The next process (or any request after the timeout) compares the running build with the one
 * the update started from: different means updated, the same after the watch window means not completed.
 * Reads and writes our own database only.
 */
export function reconcileUpdates(db: Db, running: Pick<BuildInfo, "sha">, now: Date): number {
  const nowIso = now.toISOString();
  let settled = 0;
  for (const p of listHistory(db, 50)) {
    if (!isAppUpdate(p) || p.status !== "applied") continue;
    const u = p.result?.update;
    if (!u || u.state !== "requested") continue;
    const changed = running.sha !== (p.before.sha ?? "");
    const timedOut = now.getTime() - Date.parse(u.calledAt) >= UPDATE_WATCH_TIMEOUT_MS;
    if (!changed && !timedOut) continue;
    const state = changed ? "updated" : "not_completed";
    db.transaction(() => {
      db.update(proposalTable)
        .set({ result: { ...p.result, update: { ...u, state, resolvedAt: nowIso, runningSha: running.sha } } })
        .where(and(eq(proposalTable.id, p.id), eq(proposalTable.status, "applied")))
        .run();
      appendAudit(db, {
        ts: nowIso,
        actor: "system",
        action: changed ? "update.completed" : "update.not_completed",
        target: "app.update:app",
        payload: { id: p.id, from: p.before.sha, running: running.sha },
        result: state,
      });
    });
    settled++;
  }
  return settled;
}
