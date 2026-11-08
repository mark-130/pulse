import { eq } from "drizzle-orm";
import { GARMIN_GROUPS, type GroupStatus } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { syncState } from "../../db/schema.js";

/** Each Garmin kind keeps its own sync_state row, named garmin:<task>. */
export const kindJob = (task: string) => `garmin:${task}`;

export function recordKind(db: Db, task: string, nowIso: string, error: string | null): void {
  const job = kindJob(task);
  if (error === null) {
    db.insert(syncState)
      .values({ job, lastOk: nowIso, lastAttempt: nowIso, lastError: null, consecutiveFailures: 0 })
      .onConflictDoUpdate({ target: syncState.job, set: { lastOk: nowIso, lastAttempt: nowIso, lastError: null, consecutiveFailures: 0 } })
      .run();
    return;
  }
  const prev = db.select().from(syncState).where(eq(syncState.job, job)).get();
  const failures = (prev?.consecutiveFailures ?? 0) + 1;
  db.insert(syncState)
    .values({ job, lastAttempt: nowIso, lastError: error, consecutiveFailures: failures })
    .onConflictDoUpdate({ target: syncState.job, set: { lastAttempt: nowIso, lastError: error, consecutiveFailures: failures } })
    .run();
}

/** Group status from the per-kind rows. Returns null before any per-kind row exists (database from before this change). */
export function groupStatuses(db: Db, now: Date, staleAfterMin: number): GroupStatus[] | null {
  const rows = new Map(db.select().from(syncState).all().filter((r) => r.job.startsWith("garmin:")).map((r) => [r.job.slice(7), r]));
  if (rows.size === 0) return null;
  return GARMIN_GROUPS.map((g) => {
    const states = g.tasks.map((t) => rows.get(t));
    const oks = states.map((s) => s?.lastOk ?? null);
    const lastOk = oks.some((o) => o === null) ? null : oks.map((o) => o as string).sort()[0] ?? null;
    const ageMinutes = lastOk ? Math.max(0, Math.round((now.getTime() - Date.parse(lastOk)) / 60_000)) : null;
    const lastError = states.find((s) => s?.lastError)?.lastError ?? null;
    return { id: g.id, label: g.label, plural: g.plural, critical: g.critical, lastOk, ageMinutes, stale: ageMinutes === null || ageMinutes > staleAfterMin, lastError };
  });
}

/** Oldest last-ok of the given groups, or null if any never succeeded. */
export function oldestOk(groups: GroupStatus[] | null, ids: string[], fallback: string | null): string | null {
  if (!groups) return fallback;
  const picked = groups.filter((g) => ids.includes(g.id));
  if (picked.some((g) => g.lastOk === null)) return null;
  return picked.map((g) => g.lastOk as string).sort()[0] ?? null;
}

/** Oldest successful fetch among the given groups. Falls back to the job time for a database from before per-kind tracking. */
export function lastGarminOk(db: Db, groups: string[] = ["plan", "readiness"]): string | null {
  const job = db.select().from(syncState).where(eq(syncState.job, "garmin")).get()?.lastOk ?? null;
  return oldestOk(groupStatuses(db, new Date(), 90), groups, job);
}

