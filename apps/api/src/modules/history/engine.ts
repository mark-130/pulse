import { and, eq, gte, lte, max, ne } from "drizzle-orm";
import { HISTORY_KINDS, type HistoryKindId, type HistoryState } from "@pulse/shared";
import { addDays, daysBetween, londonDate } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { backfillProgress, settings } from "../../db/schema.js";
import type { Logger } from "../../logger.js";
import type { GarminConnector, GarminSession } from "../garmin/client.js";
import { classify, DAY_SPECS, HistoryError, isFatal, RANGE_SPECS, SHAPE_MESSAGE, storedDays, type DaySpec, type Helpers, type RangeSpec } from "./kinds.js";

/**
 * The history import engine (D51, D60). One-off, read only, resumable. Gentle on purpose: windows one at a time, a pause
 * between them, per-day tools two calls at a time, backoff when Garmin says slow down. One failing kind never blocks the
 * others: after three failed windows in a row inside a kind, that kind is marked "needs attention" and the import moves on.
 * The whole import stops only for a failed login, an unreachable Garmin, or a rate limit pause. It yields to the routine
 * sync and the nightly backup. Progress lives in backfill_progress, so a restart resumes without repeating finished
 * windows and a rerun never duplicates anything.
 */
export const WINDOW_PAUSE_MS = 2_000;
export const PER_DAY_CONCURRENCY = 2;
/** Backoff after Garmin says slow down: 30 s, then 60 s, then the third in a row pauses for an hour. */
export const RATE_BASE_MS = 30_000;
export const RATE_PAUSE_MS = 3_600_000;
export const RATE_LIMITED_IN_A_ROW = 3;
/** Failed windows in a row, inside one kind, after which that kind needs attention and the import moves to the next kind. */
export const FAILED_WINDOWS_PER_KIND = 3;
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
  /** Kept for old states. The failure count is now per kind and per run, so nothing reads this. */
  consecutiveFailures: number;
  rateLimitStreak: number;
  /** Kinds that need attention, with the reason, from this run. Skipped until the next Start (D60). */
  attention: Record<string, string>;
  /** The window size that worked for a kind after Garmin said the range was too big, so it is not asked for again (D60). */
  windowSizes: Record<string, number>;
  /**
   * The dates this import covers, fixed when it is created and never recomputed from today (D70). The days after rangeTo
   * belong to the routine sync. Null on a state from before D70, or one that has not started: see importRange.
   */
  rangeFrom: string | null;
  rangeTo: string | null;
}

export const freshState = (days: number): ImportState => ({ state: "idle", days, startedAt: null, activeMs: 0, reason: null, pausedUntil: null, consecutiveFailures: 0, rateLimitStreak: 0, attention: {}, windowSizes: {}, rangeFrom: null, rangeTo: null });

/** A range for a new import: the last `days` days ending today (London). */
export const newRange = (now: Date, days: number): { rangeFrom: string; rangeTo: string } => {
  const rangeTo = londonDate(now);
  return { rangeFrom: addDays(rangeTo, -(days - 1)), rangeTo };
};

export function loadState(db: Db, days: number): ImportState {
  const row = db.select().from(settings).where(eq(settings.key, STATE_KEY)).get();
  return row ? { ...freshState(days), ...(row.value as Partial<ImportState>) } : freshState(days);
}

export function saveState(db: Db, patch: Partial<ImportState>, days: number): ImportState {
  const next = { ...loadState(db, days), ...patch };
  db.insert(settings).values({ key: STATE_KEY, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } }).run();
  return next;
}

/**
 * The covered range of the import. Fixed once stored. A state from before D70 has none, because the old code recomputed the range
 * from today on every run. It is rebuilt from what was recorded, never from the newest finished window alone, because the newest
 * windows may have failed or not been tried (D71):
 * - Complete: every kind had finished a window ending on the last day of the range, so that is the newest finished window.
 * - Anything else: the day of the first Start (startedAt, as a London date, never reset), or a later window if one was recorded,
 *   done or failed. A resume on a later day may have gone further than that, so this is the earliest the end can be.
 * - No startedAt (nothing reliable to go on): today, which is what the old code would have used on the next run. The range is
 *   then never shorter than the original, so the card cannot call a partly imported range complete.
 * Before the first Start there is nothing to fix: the range is the last `days` days ending today. Only `persist` stores the result,
 * and only Start and the run pass it, so looking at the card never writes (D71).
 */
export function importRange(db: Db, now: Date, days: number, persist = false): { from: string; to: string; days: number } {
  const st = loadState(db, days);
  if (st.rangeFrom && st.rangeTo) return { from: st.rangeFrom, to: st.rangeTo, days: daysBetween(st.rangeFrom, st.rangeTo) + 1 };
  const total = st.days > 0 ? st.days : days;
  const today = londonDate(now);
  const newest = (status: "done" | "failed") => db.select({ m: max(backfillProgress.windowEnd) }).from(backfillProgress).where(eq(backfillProgress.status, status)).get()?.m ?? null;
  const lastDone = newest("done");
  const lastFailed = newest("failed");
  const started = st.startedAt && !Number.isNaN(Date.parse(st.startedAt)) ? londonDate(new Date(st.startedAt)) : null;
  let to: string;
  if (st.state === "idle" && started === null && lastDone === null && lastFailed === null) return { from: addDays(today, -(total - 1)), to: today, days: total };
  if (st.state === "complete" && lastDone !== null) to = lastDone;
  else if (started !== null) to = [started, lastDone, lastFailed].reduce<string>((a, d) => (d !== null && d > a ? d : a), started);
  else to = today;
  if (to > today) to = today;
  const from = addDays(to, -(total - 1));
  if (persist && st.state !== "idle") saveState(db, { rangeFrom: from, rangeTo: to }, days);
  return { from, to, days: total };
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
/** learned: the size that worked after Garmin said a range was too big. Only set when that happened. */
type Outcome = { status: "done"; rows: number; learned: number | null } | { status: "failed"; reason: string } | { status: "rate_limited" };

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

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const halve = (from: string, to: string) => {
  const size = Math.ceil((daysBetween(from, to) + 1) / 2);
  return { size, mid: addDays(from, size - 1) };
};

/**
 * Range tool, one call. A timeout retries the window once at half size. "Range too big" is a window size bug, not a data
 * failure (D60): the window is halved and tried again, as far down as needed, and the size that worked is returned so it
 * is remembered. Each piece is recorded on its own. A login failure or an unreachable Garmin is thrown to stop the import.
 */
async function rangeWindow(deps: EngineDeps, spec: RangeSpec, session: GarminSession, h: Helpers, from: string, to: string, depth: number): Promise<Outcome> {
  try {
    const rows = await spec.fetch(session, from, to, h);
    record(deps, spec.id, from, to, "done", rows, null);
    // A failed record covered by this window is settled.
    deps.db.delete(backfillProgress).where(and(eq(backfillProgress.kind, spec.id), eq(backfillProgress.status, "failed"), gte(backfillProgress.windowStart, from), lte(backfillProgress.windowEnd, to), ne(backfillProgress.windowStart, from))).run();
    return { status: "done", rows, learned: null };
  } catch (err) {
    const e = classify(err);
    if (e.kind === "rate_limited") return { status: "rate_limited" };
    if (isFatal(e)) throw e;
    const tooBig = e.kind === "range_too_big";
    // A too big range is halved up to three times (14, 7, 4, 2 days): a size bug is worth a few more calls, a dead tool is not.
    if (((e.kind === "timeout" && depth === 0) || (tooBig && depth < 3)) && from < to) {
      const { size, mid } = halve(from, to);
      // Newest half first, like every other window.
      const b = await rangeWindow(deps, spec, session, h, addDays(mid, 1), to, depth + 1);
      if (b.status === "rate_limited") return b;
      const a = await rangeWindow(deps, spec, session, h, from, mid, depth + 1);
      if (a.status === "rate_limited") return a;
      if (a.status === "done" && b.status === "done") {
        const learned = tooBig ? Math.min(size, a.learned ?? size, b.learned ?? size) : null;
        return { status: "done", rows: a.rows + b.rows, learned };
      }
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
  const fatal = failures.find((f) => f.kind === "shape" || isFatal(f));
  if (fatal) throw fatal;
  if (timeouts.length > 0 && depth === 0 && from < to) {
    const half = Math.ceil((daysBetween(from, to) + 1) / 2);
    const mid = addDays(from, half - 1);
    const b = await dayWindow(deps, spec, session, h, addDays(mid, 1), to, 1);
    if (b.status === "rate_limited") return b;
    const a = await dayWindow(deps, spec, session, h, from, mid, 1);
    if (a.status === "rate_limited") return a;
    if (a.status === "done" && b.status === "done") return { status: "done", rows: rows + a.rows + b.rows, learned: null };
    return { status: "failed", reason: a.status === "failed" ? a.reason : b.status === "failed" ? b.reason : "failed" };
  }
  if (timeouts.length > 0 || failures.length > 0) {
    const reason = failures[0]?.message ?? "Garmin did not answer in time.";
    record(deps, spec.id, from, to, "failed", rows, reason);
    return { status: "failed", reason };
  }
  record(deps, spec.id, from, to, "done", rows, null);
  return { status: "done", rows, learned: null };
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

/**
 * The order the kinds run in (D60): kinds with nothing imported yet first, then kinds that are partly done, and body battery
 * last wherever it stands, because it is the kind that has failed. Within a group the order is the one on the card.
 */
export function runOrder(db: Db, from: string, to: string): HistoryKindId[] {
  const group = (id: HistoryKindId) => (id === "body_battery" ? 2 : doneDays(db, id, from, to).size === 0 ? 0 : 1);
  return HISTORY_KINDS.map((k, i) => ({ id: k.id, i, g: group(k.id) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.id);
}

/** Runs the import until every kind has been tried, or it is paused, rate limited for an hour, or stopped by a failed login or an unreachable Garmin. */
export async function runImport(deps: EngineDeps): Promise<ImportState["state"]> {
  // The range was fixed when the import was created (D70). It does not move with the clock.
  const { from, to: today, days: total } = importRange(deps.db, deps.now(), deps.days, true);
  const rateBase = deps.rateBaseMs ?? RATE_BASE_MS;
  const ratePause = deps.ratePauseMs ?? RATE_PAUSE_MS;
  let lastTick = deps.now().getTime();
  const account = () => {
    const t = deps.now().getTime();
    saveState(deps.db, { activeMs: loadState(deps.db, deps.days).activeMs + Math.max(0, t - lastTick) }, deps.days);
    lastTick = t;
  };
  const setAttention = (kind: string, reason: string) => {
    const attention = { ...loadState(deps.db, deps.days).attention, [kind]: reason };
    saveState(deps.db, { attention }, deps.days);
  };

  try {
    for (const kind of runOrder(deps.db, from, today)) {
      const meta = HISTORY_KINDS.find((k) => k.id === kind) as (typeof HISTORY_KINDS)[number];
      // A kind that needs attention waits for the next Start.
      if (loadState(deps.db, deps.days).attention[kind]) continue;
      const range = RANGE_SPECS[kind];
      let dayMode = range === undefined;
      // A size Garmin accepted after saying the range was too big is remembered, and is also the most the window grows to.
      const learned = loadState(deps.db, deps.days).windowSizes[kind];
      let maxSize = Math.min(range?.limit ?? 14, learned ?? Infinity);
      let size = Math.min(range?.start ?? 14, maxSize);
      let successes = 0;
      let failedInRow = 0;
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
          throw new HistoryError("unreachable", classify(err).message);
        });
        let outcome: Outcome;
        try {
          const h: Helpers = { db: deps.db, ctx: { db: deps.db, today, nowIso: deps.now().toISOString() } };
          try {
            outcome = dayMode ? await dayWindow(deps, DAY_SPECS[kind] as DaySpec, session, h, win.from, win.to, 0) : await rangeWindow(deps, range as RangeSpec, session, h, win.from, win.to, 0);
          } catch (err) {
            if (err instanceof HistoryError && isFatal(err)) throw err;
            // The range answer could not be read. Sleep and HRV fall back to their per-day tools for the rest of the run.
            if (err instanceof HistoryError && err.kind === "shape" && !dayMode && DAY_SPECS[kind]) {
              deps.log.warn({ kind, reason: err.message }, "history range answer unreadable, using the per-day tool");
              dayMode = true;
              continue;
            }
            const e = classify(err);
            let reason = e.message;
            if (e.kind === "shape") {
              // A plain sentence for the card, with the kind and the dates. The technical detail goes to the server log only.
              reason = `${SHAPE_MESSAGE} (${meta.label}, ${dmy(win.from)} to ${dmy(win.to)})`;
              deps.log.warn({ kind, from: win.from, to: win.to, detail: e.detail }, "history answer in an unexpected shape");
            }
            outcome = { status: "failed", reason };
            record(deps, kind, win.from, win.to, "failed", 0, reason);
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
          failedInRow++;
          deps.log.warn({ kind, from: win.from, to: win.to, reason: outcome.reason }, "history window failed");
          successes = 0;
          if (failedInRow >= FAILED_WINDOWS_PER_KIND) {
            // This kind needs attention. Carry on with the next one: a failing kind never blocks the others.
            setAttention(kind, outcome.reason);
            deps.log.warn({ kind }, "history kind needs attention, moving on");
            break;
          }
        } else {
          failedInRow = 0;
          if (outcome.learned !== null && outcome.learned < maxSize) {
            // Garmin said the range was too big, and a smaller one worked: use that from now on, and remember it.
            maxSize = outcome.learned;
            size = outcome.learned;
            saveState(deps.db, { windowSizes: { ...loadState(deps.db, deps.days).windowSizes, [kind]: outcome.learned } }, deps.days);
            deps.log.warn({ kind, size: outcome.learned }, "history window size reduced: Garmin said the range was too big");
          } else if (!dayMode && range && daysBetween(win.from, win.to) + 1 >= size) {
            successes++;
            if (successes >= GROW_AFTER && size < maxSize) {
              size = Math.min(maxSize, size * 2);
              successes = 0;
            }
          }
        }
        await deps.sleep(WINDOW_PAUSE_MS);
        lastTick = deps.now().getTime();
      }
    }
    // Every kind has had its turn. Any day still not covered belongs to a failed window: that is "complete with issues".
    const issues = HISTORY_KINDS.filter((k) => doneDays(deps.db, k.id, from, today).size < total).map((k) => k.label);
    if (issues.length > 0) {
      saveState(deps.db, { state: "complete_with_issues", reason: `Some windows failed: ${issues.join(", ")}. Start again retries only those.`, pausedUntil: null }, deps.days);
      return "complete_with_issues";
    }
    saveState(deps.db, { state: "complete", reason: null, pausedUntil: null, attention: {} }, deps.days);
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
