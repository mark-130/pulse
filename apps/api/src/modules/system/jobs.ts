import { eq } from "drizzle-orm";
import { londonDate } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { syncState } from "../../db/schema.js";
import type { Logger } from "../../logger.js";
import { sanitiseError, type Notifier } from "../../notify.js";

export const ALERT_AFTER_FAILURES = 3;
const BASE_BACKOFF_MIN = 30;
const MAX_BACKOFF_MIN = 240;

export interface JobOutcome {
  /** Short non-fatal note stored with a successful run. */
  detail?: string | null;
}

export interface TrackedJob {
  name: string;
  /** Respects backoff. Used by the scheduler. */
  tick(): Promise<void>;
  /** Ignores backoff but not the single-flight lock. Used by the manual trigger and startup. */
  runNow(): Promise<{ ran: boolean }>;
}

export function getState(db: Db, job: string) {
  return db.select().from(syncState).where(eq(syncState.job, job)).get();
}

/** Minutes to wait after n consecutive failures: 30, 60, 120, 240, then 240. */
export function backoffMinutes(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BASE_BACKOFF_MIN * 2 ** (failures - 1), MAX_BACKOFF_MIN);
}

export function isDue(state: { lastAttempt: string | null; consecutiveFailures: number } | undefined, now: Date): boolean {
  if (!state || !state.lastAttempt || state.consecutiveFailures === 0) return true;
  return now.getTime() - Date.parse(state.lastAttempt) >= backoffMinutes(state.consecutiveFailures) * 60_000;
}

export function createTrackedJob(opts: {
  db: Db;
  name: string;
  log: Logger;
  notify: Notifier;
  now?: () => Date;
  run: () => Promise<JobOutcome | void>;
}): TrackedJob {
  const { db, name, log, notify } = opts;
  const clock = opts.now ?? (() => new Date());
  let running = false;

  async function execute(): Promise<void> {
    const now = clock();
    const nowIso = now.toISOString();
    db.insert(syncState).values({ job: name, lastAttempt: nowIso }).onConflictDoUpdate({ target: syncState.job, set: { lastAttempt: nowIso } }).run();
    try {
      const outcome = await opts.run();
      db.update(syncState)
        .set({ lastOk: nowIso, lastError: null, consecutiveFailures: 0, detail: outcome?.detail ?? null })
        .where(eq(syncState.job, name))
        .run();
    } catch (err) {
      const message = sanitiseError(err);
      const prev = getState(db, name);
      const failures = (prev?.consecutiveFailures ?? 0) + 1;
      db.update(syncState).set({ lastError: message, consecutiveFailures: failures }).where(eq(syncState.job, name)).run();
      log.error({ job: name, failures, error: message }, "job failed");
      const alertedToday = prev?.lastAlertAt ? londonDate(new Date(prev.lastAlertAt)) === londonDate(now) : false;
      if (failures >= ALERT_AFTER_FAILURES && !alertedToday) {
        await notify(`${name} has failed ${failures} times in a row. Last error: ${message}`);
        db.update(syncState).set({ lastAlertAt: nowIso }).where(eq(syncState.job, name)).run();
      }
    }
  }

  async function guarded(respectBackoff: boolean): Promise<{ ran: boolean }> {
    if (running) return { ran: false };
    if (respectBackoff && !isDue(getState(db, name), clock())) return { ran: false };
    running = true;
    try {
      await execute();
    } finally {
      running = false;
    }
    return { ran: true };
  }

  return { name, tick: async () => void (await guarded(true)), runNow: () => guarded(false) };
}
