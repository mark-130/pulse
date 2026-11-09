import { z } from "zod";
import type { Hono } from "hono";
import { TREND_RANGES, type Module } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import type { Logger } from "../../logger.js";
import type { GarminConnector } from "../garmin/client.js";
import { loadState, runImport, saveState, type EngineDeps, type Live } from "./engine.js";
import { getHistoryStatus, getHistorySummary, getSeries, getYearOnYear } from "./queries.js";

const TZ = "Europe/London";

function londonClock(now: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: get("hour"), minute: get("minute") };
}

/**
 * The routine sync always goes first (D51). The import waits while the routine sync or the nightly backup runs, and for the
 * minute before and after the routine sync starts (it runs at :00 and :30) and the backup window (03:05 to 03:20).
 */
export function shouldYield(now: Date, routineRunning: boolean, backupRunning: boolean): boolean {
  if (routineRunning || backupRunning) return true;
  const { hour, minute } = londonClock(now);
  if (minute % 30 === 29 || minute % 30 === 0) return true;
  return hour === 3 && minute >= 5 && minute < 20;
}

export interface HistoryDeps {
  db: Db;
  connect: GarminConnector;
  days: number;
  log: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** True while the routine sync or the backup is running or about to. */
  busy: () => boolean;
  /** Test hooks for the backoff. */
  rateBaseMs?: number;
  ratePauseMs?: number;
}

/**
 * The history import and what it fills (D51). Nothing runs until Mark taps Start in Settings. After a restart it resumes
 * only if it was running, and a rate limit pause ends by itself after an hour. Reads Garmin only.
 */
export function createHistoryModule(deps: HistoryDeps): { module: Module<Hono>; tick: () => Promise<void>; idle: () => Promise<void>; live: Live } {
  const clock = deps.now ?? (() => new Date());
  const live: Live = { waiting: false, current: null };
  let loop: Promise<unknown> | null = null;

  const engine = (): EngineDeps => ({ db: deps.db, connect: deps.connect, now: clock, sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), log: deps.log, days: deps.days, busy: deps.busy, live, rateBaseMs: deps.rateBaseMs, ratePauseMs: deps.ratePauseMs });

  const kick = () => {
    if (loop) return;
    loop = runImport(engine())
      .catch(() => undefined)
      .finally(() => void (loop = null));
  };

  const start = () => {
    const st = loadState(deps.db, deps.days);
    if (st.state === "running" && loop) return;
    saveState(deps.db, { state: "running", days: deps.days, reason: null, pausedUntil: null, consecutiveFailures: 0, rateLimitStreak: 0, startedAt: st.startedAt ?? clock().toISOString() }, deps.days);
    kick();
  };

  const tick = async () => {
    const st = loadState(deps.db, deps.days);
    if (st.state === "paused" && st.pausedUntil && clock().toISOString() >= st.pausedUntil) {
      deps.log.info({}, "history import resuming after the rate limit pause");
      saveState(deps.db, { state: "running", reason: null, pausedUntil: null, rateLimitStreak: 0 }, deps.days);
      kick();
    } else if (st.state === "running" && !loop) kick(); // after a restart
  };

  const status = () => getHistoryStatus(deps.db, clock(), deps.days, live);

  const module: Module<Hono> = {
    name: "history",
    routes: (app) => {
      app.get("/api/history", (c) => c.json(status()));
      app.post("/api/history/start", (c) => {
        start();
        return c.json(status());
      });
      app.post("/api/history/resume", (c) => {
        start();
        return c.json(status());
      });
      app.post("/api/history/pause", (c) => {
        const st = loadState(deps.db, deps.days);
        if (st.state === "running") saveState(deps.db, { state: "paused", reason: "Paused by you.", pausedUntil: null }, deps.days);
        return c.json(status());
      });
      app.get("/api/history/series", (c) => {
        const q = z.object({ days: z.coerce.number().int().min(7).max(1100).default(91), kinds: z.string().optional() }).safeParse({ days: c.req.query("days") ?? undefined, kinds: c.req.query("kinds") ?? undefined });
        if (!q.success) return c.json({ error: `days must be ${TREND_RANGES.map((r) => r.days).join(", ")} or similar (7 to 1100)` }, 400);
        return c.json(getSeries(deps.db, clock(), q.data.days, q.data.kinds?.split(",")));
      });
      app.get("/api/history/yoy", (c) => c.json(getYearOnYear(deps.db, clock())));
    },
    jobs: [{ name: "history-import", schedule: "* * * * *", run: tick }],
  };
  return { module, tick, idle: async () => void (await loop), live };
}

export { getHistorySummary };
