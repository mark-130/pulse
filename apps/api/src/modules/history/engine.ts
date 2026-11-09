import { eq } from "drizzle-orm";
import { HISTORY_KINDS, type HistoryKindId, type HistoryState } from "@pulse/shared";
import { addDays, daysBetween, londonDate } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { backfillProgress, settings } from "../../db/schema.js";
import type { Logger } from "../../logger.js";
import type { GarminConnector, GarminSession } from "../garmin/client.js";
import { classify, DAY_SPECS, HistoryError, RANGE_SPECS, storedDays, type DaySpec, type Helpers, type RangeSpec } from "./kinds.js";

/**
 * The history import engine (D51). One-off, read only, resumable. Gentle on purpose: windows one at a time, a pause
 * between them, per-day tools two calls at a time, backoff when Garmin says slow down, and a stop after three failed
 * windows in a row. It yields to the routine sync and the nightly backup. Progress lives in backfill_progress, so a
 * restart resumes without repeating finished windows and a rerun never duplicates anything.
 */
export const WINDOW_PAUSE_MS = 2_000;
export const PER_DAY_CONCURRENCY = 2;
/** Backoff after Garmin says slow down: 30 s, then 60 s, then the third in a row pauses for an hour. */
export const RATE_BASE_MS = 30_000;
export const RATE_PAUSE_MS = 3_600_000;
export const RATE_LIMITED_IN_A_ROW = 3;
export const FAILED_WINDOWS_TO_STOP = 3;
export const BUSY_POLL_MS = 5_000;
/** A range window grows towards its tool's limit after this many successful full windows in a row. */
export const GROW_AFTER = 3;

const STATE_KEY = "history_import";

export interface ImportState {
  state: HistoryState;
  days: number;
  startedAt: string | null;
  /** Milliseconds spent fetching, not counting pauses and waits. Used for the estimated finish. */
  activeMs: number;
  reason: string | null;
  pausedUntil: string | null;
  consecutiveFailures: number;
  rateLimitStreak: number;
}

export const freshState = (days: number): ImportState => ({ state: "idle", days, startedAt: null, activeMs: 0, reason: null, pausedUntil: null, consecutiveFailures: 0, rateLimitStreak: 0 });

export function loadState(db: Db, days: number): ImportState {
  const row = db.select().from(settings).where(eq(settings.key, STATE_KEY)).get();
  return row ? { ...freshState(days), ...(row.value as Partial<ImportState>) } : freshState(days);
}

export function saveState(db: Db, patch: Partial<ImportState>, days: number): ImportState {
  const next = { ...loadState(db, days), ...patch };
  db.insert(settings).values({ key: STATE_KEY, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } }).run();
  return next;
}

export interface Live {
  waiting: boolean;
  current: string | null;
}

export interface EngineDeps {
  db: Db;
  connect: GarminConnector;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  days: number;
  /** True while the routine sync or the nightly backup is running or about to. The import waits. */
  busy: () => boolean;
  live: Live;
  /** Test hooks. */
  rateBaseMs?: number;
  ratePauseMs?: number;
}

// ---------------------------------------------------------------- coverage
const dayRange = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Days of a kind covered by finished windows. */
export function doneDays(db: Db, kind: string, from: string, to: string): Set<string> {
  const out = new Set<string>();
  for (const r of db.select().from(backfillProgress).where(eq(backfillProgress.kind, kind)).all()) {
    if (r.status !== "done") continue;
    for (const d of dayRange(r.windowStart < from ? from : r.windowStart, r.windowEnd > to ? to : r.windowEnd)) out.add(d);
  }
  return out;
}

/** Windows to do, newest first, of at most `size` days, skipping finished days and days already tried in this run. */
export function nextWindow(from: string, to: string, done: Set<string>, tried: Set<string>, size: number): { from: string; to: string } | null {
  let end: string | null = null;
  for (let d = to; d >= from; d = addDays(d, -1)) {
    if (!done.has(d) && !tried.has(d)) {
      end = d;
      break;
    }
  }
  if (!end) return null;
  let start = end;
  while (start > from && daysBetween(start, end) < size - 1 && !done.has(addDays(start, -1)) && !tried.has(addDays(start, -1))) start = addDays(start, -1);
  return { from: start, to: end };
}

function record(deps: EngineDeps, kind: string, from: string, to: string, status: "done" | "failed", rows: number, reason: string | null): void {
  const v = { windowEnd: to, status, rows, reason, updatedAt: deps.now().toISOString() };
  deps.db.insert(backfillProgress).values({ kind, windowStart: from, ...v }).onConflictDoUpdate({ target: [backfillProgress.kind, backfillProgress.windowStart], set: v }).run();
}

// ---------------------------------------------------------------- one window
type Outcome = { status: "done"; rows: number } | { status: "failed"; reason: string } | { status: "rate_limited" };

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Range tool, one call. A timeout retries the window once at half size. Each half is recorded on its own. */
async function rangeWindow(deps: EngineDeps, spec: RangeSpec, session: GarminSession, h: Helpers, from: string, to: string, depth: number): Promise<Outcome> {
  try {
    const rows = await spec.fetch(session, from, to, h);
    record(deps, spec.id, from, to, "done", rows, null);
    return { status: "done", rows };
  } catch (err) {
    const e = classify(err);
    if (e.kind === "rate_limited") return { status: "rate_limited" };
    if (e.kind === "timeout" && depth === 0 && from < to) {
      const half = Math.ceil((daysBetween(from, to) + 1) / 2);
      const mid = addDays(from, half - 1);
      // Newest half first, like every other window. Neither half retries again.
      const b = await rangeWindow(deps, spec, session, h, addDays(mid, 1), to, 1);
      if (b.status === "rate_limited") return b;
      const a = await rangeWindow(deps, spec, session, h, from, mid, 1);
      if (a.status === "rate_limited") return a;
      if (a.status === "done" && b.status === "done") return { status: "done", rows: a.rows + b.rows };
      return { status: "failed", reason: a.status === "failed" ? a.reason : b.status === "failed" ? b.reason : "failed" };
    }
    if (e.kind === "shape") throw e;
    record(deps, spec.id, from, to, "failed", 0, e.message);
    return { status: "failed", reason: e.message };
  }
}

/** Per-day tool: 14 days, two calls at a time. Days already stored are skipped. A timeout retries the window once at half size. */
async function dayWindow(deps: EngineDeps, spec: DaySpec, session: GarminSession, h: Helpers, from: string, to: string, depth: number): Promise<Outcome> {
  const have = storedDays(deps.db, spec.id, from, to);
  const days = dayRange(from, to).filter((d) => !have.has(d));
  let rows = 0;
  let rate = false;
  const timeouts: string[] = [];
  const failures: HistoryError[] = [];
  await pool(days, PER_DAY_CONCURRENCY, async (d) => {
    if (rate) return;
    try {
      rows += await spec.fetchDay(session, d, h);
    } catch (err) {
      const e = classify(err);
      if (e.kind === "rate_limited") rate = true;
      else if (e.kind === "timeout") timeouts.push(d);
      else failures.push(e);
    }
  });
  if (rate) return { status: "rate_limited" };
  if (failures.some((f) => f.kind === "shape")) throw failures.find((f) => f.kind === "shape");
  if (timeouts.length > 0 && depth === 0 && from < to) {
    const half = Math.ceil((daysBetween(from, to) + 1) / 2);
    const mid = addDays(from, half - 1);
    const b = await dayWindow(deps, spec, session, h, addDays(mid, 1), to, 1);
    if (b.status === "rate_limited") return b;
    const a = await dayWindow(deps, spec, session, h, from, mid, 1);
    if (a.status === "rate_limited") return a;
    if (a.status === "done" && b.status === "done") return { status: "done", rows: rows + a.rows + b.rows };
    return { status: "failed", reason: a.status === "failed" ? a.reason : b.status === "failed" ? b.reason : "failed" };
  }
  if (timeouts.length > 0 || failures.length > 0) {
    const reason = failures[0]?.message ?? "Garmin did not answer in time.";
    record(deps, spec.id, from, to, "failed", rows, reason);
    return { status: "failed", reason };
  }
  record(deps, spec.id, from, to, "done", rows, null);
  return { status: "done", rows };
}

// ---------------------------------------------------------------- the run
/** True while the state in the database says running. Checked before every window, so Pause takes effect within one. */
const isRunning = (deps: EngineDeps) => loadState(deps.db, deps.days).state === "running";

async function waitWhileBusy(deps: EngineDeps): Promise<boolean> {
  while (deps.busy()) {
    deps.live.waiting = true;
    await deps.sleep(BUSY_POLL_MS);
    if (!isRunning(deps)) {
      deps.live.waiting = false;
      return false;
    }
  }
  deps.live.waiting = false;
  return true;
}

/** Runs the import until it is complete, paused, rate limited for an hour, or stopped after three failed windows. */
export async function runImport(deps: EngineDeps): Promise<ImportState["state"]> {
  const today = londonDate(deps.now());
  const from = addDays(today, -(deps.days - 1));
  const rateBase = deps.rateBaseMs ?? RATE_BASE_MS;
  const ratePause = deps.ratePauseMs ?? RATE_PAUSE_MS;
  let lastTick = deps.now().getTime();
  const account = () => {
    const t = deps.now().getTime();
    saveState(deps.db, { activeMs: loadState(deps.db, deps.days).activeMs + Math.max(0, t - lastTick) }, deps.days);
    lastTick = t;
  };

  try {
    for (const meta of HISTORY_KINDS) {
      const kind: HistoryKindId = meta.id;
      const range = RANGE_SPECS[kind];
      let dayMode = range === undefined;
      let size = range?.start ?? 14;
      let successes = 0;
      const tried = new Set<string>();
      deps.live.current = meta.label;

      for (;;) {
        if (!isRunning(deps)) return loadState(deps.db, deps.days).state;
        const done = doneDays(deps.db, kind, from, today);
        const win = nextWindow(from, today, done, tried, dayMode ? (DAY_SPECS[kind]?.window ?? 14) : size);
        if (!win) break;
        if (!(await waitWhileBusy(deps))) return loadState(deps.db, deps.days).state;
        lastTick = deps.now().getTime();

        const session = await deps.connect().catch((err: unknown) => {
          throw new HistoryError("failed", classify(err).message);
        });
        let outcome: Outcome;
        try {
          const h: Helpers = { db: deps.db, ctx: { db: deps.db, today, nowIso: deps.now().toISOString() } };
          try {
            outcome = dayMode ? await dayWindow(deps, DAY_SPECS[kind] as DaySpec, session, h, win.from, win.to, 0) : await rangeWindow(deps, range as RangeSpec, session, h, win.from, win.to, 0);
          } catch (err) {
            // The range answer could not be read. Sleep and HRV fall back to their per-day tools for the rest of the run.
            if (err instanceof HistoryError && err.kind === "shape" && !dayMode && DAY_SPECS[kind]) {
              deps.log.warn({ kind, reason: err.message }, "history range answer unreadable, using the per-day tool");
              dayMode = true;
              continue;
            }
            outcome = { status: "failed", reason: classify(err).message };
            record(deps, kind, win.from, win.to, "failed", 0, (outcome as { reason: string }).reason);
          }
        } finally {
          await session.close().catch(() => undefined);
        }
        account();

        if (outcome.status === "rate_limited") {
          const streak = loadState(deps.db, deps.days).rateLimitStreak + 1;
          if (streak >= RATE_LIMITED_IN_A_ROW) {
            const until = new Date(deps.now().getTime() + ratePause).toISOString();
            deps.log.warn({ kind, streak }, "history import paused for an hour: rate limited");
            saveState(deps.db, { state: "paused", rateLimitStreak: 0, pausedUntil: until, reason: "Garmin asked us to slow down three times in a row. The import resumes by itself after an hour." }, deps.days);
            return "paused";
          }
          saveState(deps.db, { rateLimitStreak: streak }, deps.days);
          await deps.sleep(rateBase * 2 ** (streak - 1));
          lastTick = deps.now().getTime();
          continue; // the same window again
        }
        saveState(deps.db, { rateLimitStreak: 0 }, deps.days);
        for (const d of dayRange(win.from, win.to)) tried.add(d);

        if (outcome.status === "failed") {
          const failures = loadState(deps.db, deps.days).consecutiveFailures + 1;
          deps.log.warn({ kind, from: win.from, to: win.to, reason: outcome.reason }, "history window failed");
          if (failures >= FAILED_WINDOWS_TO_STOP) {
            saveState(deps.db, { state: "stopped", consecutiveFailures: failures, reason: `Three windows in a row failed. Last: ${meta.label}, ${win.from} to ${win.to}. ${outcome.reason}` }, deps.days);
            return "stopped";
          }
          saveState(deps.db, { consecutiveFailures: failures }, deps.days);
          successes = 0;
        } else {
          saveState(deps.db, { consecutiveFailures: 0 }, deps.days);
          if (!dayMode && range && daysBetween(win.from, win.to) + 1 >= size) {
            successes++;
            if (successes >= GROW_AFTER && size < range.limit) {
              size = Math.min(range.limit, size * 2);
              successes = 0;
            }
          }
        }
        await deps.sleep(WINDOW_PAUSE_MS);
        lastTick = deps.now().getTime();
      }
    }
    saveState(deps.db, { state: "complete", reason: null, pausedUntil: null }, deps.days);
    return "complete";
  } catch (err) {
    const e = classify(err);
    deps.log.error({ reason: e.message }, "history import stopped");
    saveState(deps.db, { state: "stopped", reason: e.message }, deps.days);
    return "stopped";
  } finally {
    deps.live.current = null;
    deps.live.waiting = false;
  }
}
