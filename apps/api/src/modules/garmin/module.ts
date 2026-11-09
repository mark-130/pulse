import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { Module, SyncStatus, JobStatus } from "@pulse/shared";
import type Database from "better-sqlite3";
import type { Config } from "../../config.js";
import type { Db } from "../../db/index.js";
import { syncState } from "../../db/schema.js";
import type { Logger } from "../../logger.js";
import { ntfyEnabled, type Notifier } from "../../notify.js";
import type { GarminConnector } from "./client.js";
import { getToday, getTrends, getWeek } from "./queries.js";
import { groupStatuses, oldestOk } from "./freshness.js";
import { runGarminSync } from "./sync.js";
import { runBackup } from "../system/backup.js";
import { createTrackedJob, type TrackedJob } from "../system/jobs.js";

export const GARMIN_STALE_AFTER_MIN = 90;
const BACKUP_STALE_AFTER_MIN = 26 * 60;
const MANUAL_SYNC_MIN_GAP_MS = 60_000;

function jobStatus(db: Db, job: string, now: Date, staleAfterMin: number): JobStatus {
  const s = db.select().from(syncState).where(eq(syncState.job, job)).get();
  const ageMinutes = s?.lastOk ? Math.max(0, Math.round((now.getTime() - Date.parse(s.lastOk)) / 60_000)) : null;
  return {
    lastOk: s?.lastOk ?? null,
    lastAttempt: s?.lastAttempt ?? null,
    lastError: s?.lastError ?? null,
    consecutiveFailures: s?.consecutiveFailures ?? 0,
    detail: s?.detail ?? null,
    ageMinutes,
    stale: ageMinutes === null || ageMinutes > staleAfterMin,
  };
}

export interface GarminModuleDeps {
  db: Db;
  sqlite: Database.Database;
  config: Pick<Config, "DATA_DIR" | "NTFY_TOKEN">;
  connect: GarminConnector;
  notify: Notifier;
  log: Logger;
  now?: () => Date;
  /** Called after a sync that refreshed the scheduled workouts. Used by the proposal verification probe. */
  onWorkoutsSynced?: (now: Date) => void;
  /** Called after every sync that fetched something. Used for post-run debriefs. Must not throw. */
  onSynced?: (now: Date) => void;
  /** Test hook for the retry waits. */
  sleep?: (ms: number) => Promise<void>;
}

export function createGarminModule(deps: GarminModuleDeps): { module: Module<Hono>; garmin: TrackedJob; backup: TrackedJob } {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());

  const garmin = createTrackedJob({
    db,
    name: "garmin",
    log: deps.log,
    notify: deps.notify,
    now: clock,
    run: async () => {
      const result = await runGarminSync({ db, connect: deps.connect, now: clock, sleep: deps.sleep });
      if (result.tasks.find((t) => t.name === "scheduled_workouts")?.status === "ok") deps.onWorkoutsSynced?.(clock());
      if (result.ok) {
        try {
          deps.onSynced?.(clock());
        } catch {
          /* a follow-up must never fail a sync */
        }
      }
      const failed = result.tasks.filter((t) => t.status === "failed");
      // Only a run where nothing could be fetched counts as failed and backs off. Anything less is partial.
      if (!result.ok) throw new Error(`Garmin sync failed: ${failed.slice(0, 3).map((t) => `${t.name} (${t.error})`).join("; ")}`);
      return { detail: failed.length ? `Partial sync. Behind: ${failed.map((t) => t.name).join(", ")}` : null };
    },
  });

  const backup = createTrackedJob({
    db,
    name: "backup",
    log: deps.log,
    notify: deps.notify,
    now: clock,
    run: async () => {
      runBackup(deps.sqlite, deps.config.DATA_DIR, clock());
    },
  });

  const weekQuery = z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

  const module: Module<Hono> = {
    name: "garmin",
    routes: (app) => {
      app.get("/api/today", (c) => c.json(getToday(db, clock())));
      app.get("/api/week", (c) => {
        const q = weekQuery.safeParse({ start: c.req.query("start") });
        if (!q.success) return c.json({ error: "start must be YYYY-MM-DD" }, 400);
        return c.json(getWeek(db, clock(), q.data.start));
      });
      app.get("/api/trends", (c) => {
        const q = z.object({ days: z.coerce.number().int().min(28).max(1100).default(84) }).safeParse({ days: c.req.query("days") ?? undefined });
        if (!q.success) return c.json({ error: "days must be 28 to 1100" }, 400);
        return c.json(getTrends(db, clock(), q.data.days));
      });
      app.get("/api/sync/status", (c) => {
        const now = clock();
        const job = jobStatus(db, "garmin", now, GARMIN_STALE_AFTER_MIN);
        const groups = groupStatuses(db, now, GARMIN_STALE_AFTER_MIN);
        // The pill and banner age come from the oldest kind that Today and the plan need.
        const lastOk = oldestOk(groups, ["plan", "readiness"], job.lastOk);
        const ageMinutes = lastOk ? Math.max(0, Math.round((now.getTime() - Date.parse(lastOk)) / 60_000)) : null;
        const body: SyncStatus = {
          now: now.toISOString(),
          staleAfterMinutes: GARMIN_STALE_AFTER_MIN,
          garmin: { ...job, lastOk, ageMinutes, stale: ageMinutes === null || ageMinutes > GARMIN_STALE_AFTER_MIN },
          groups: groups ?? [],
          alertsEnabled: ntfyEnabled(deps.config),
          backup: jobStatus(db, "backup", now, BACKUP_STALE_AFTER_MIN),
        };
        return c.json(body);
      });
      // Reads from Garmin and writes to our own database only. One manual run per minute.
      app.post("/api/sync/garmin", async (c) => {
        const last = db.select().from(syncState).where(eq(syncState.job, "garmin")).get()?.lastAttempt;
        if (last && clock().getTime() - Date.parse(last) < MANUAL_SYNC_MIN_GAP_MS) return c.json({ error: "Synced a moment ago. Try again in a minute." }, 429);
        const { ran } = await garmin.runNow();
        if (!ran) return c.json({ error: "A sync is already running." }, 409);
        return c.json({ ok: true });
      });
    },
    jobs: [
      { name: "garmin", schedule: "*/30 * * * *", run: () => garmin.tick() },
      { name: "backup", schedule: "10 3 * * *", run: () => backup.runNow().then(() => undefined) },
    ],
  };
  return { module, garmin, backup };
}
