import { eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { HISTORY_KINDS, type HistoryKindId } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { dailyReading } from "../../db/schema.js";
import { sanitiseError } from "../../notify.js";
import type { GarminReadTool, GarminSession } from "../garmin/client.js";
import { applyActivities, applyVo2, isTimeoutError, type Ctx } from "../garmin/sync.js";
import * as up from "../garmin/upstream.js";

/**
 * What the history import fetches and keeps (D51). Summaries only: daily readings, trends and activity summaries
 * (name, date, type, distance, duration, average and maximum heart rate). Never splits, FIT files or per-second data.
 * Race predictions, personal records and heart rate zones have no history option in Garmin, so they are not imported.
 */

/** A window that failed in a way the engine reacts to. */
export class HistoryError extends Error {
  constructor(
    /**
     * range_too_big is a window size bug, not a data failure (D60). auth and unreachable stop the whole import.
     * rate_limited backs off and pauses. shape means the answer could not be read.
     */
    readonly kind: "timeout" | "rate_limited" | "shape" | "range_too_big" | "auth" | "unreachable" | "failed",
    message: string,
    /** Technical detail for the server log only (D61), never shown on the card. Short, with no secrets. */
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

/** What the card says when an answer cannot be read. The engine adds the kind and the dates. The detail goes to the log only. */
export const SHAPE_MESSAGE = "Garmin sent an answer in a shape Pulse did not expect";

/** Which fields failed and why, in a few words, for the log. Holds no values, so no data and no secrets. */
export function zodDetail(err: ZodError): string {
  return err.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(answer)"}: ${i.message}`).join("; ").slice(0, 300);
}

const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|throttl/i;
const MAX_REASON = 150;

const UNREACHABLE = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|network/i;
/** Garmin's "HTTP 400 - requested date range is too big". The window was too long for the tool, which says nothing about the data. */
const RANGE_TOO_BIG = /(date )?range (is |was )?too (big|large|long)|too (big|large|long) (a )?(date )?range|range.{0,30}exceed/i;
const AUTH = /\b(401|403)\b|unauthori[sz]ed|forbidden|authentication (failed|required|error)|not logged in|login (failed|required)|invalid (token|credentials)|session expired/i;

/** An error message that is really a serialised validation error. It must never reach the card as it is. */
const LOOKS_LIKE_VALIDATION_JSON = /^\s*[[{][\s\S]*"(code|path|expected)"\s*:/;

export function classifyText(text: string): HistoryError {
  if (LOOKS_LIKE_VALIDATION_JSON.test(text)) return new HistoryError("shape", SHAPE_MESSAGE, "the error text was a serialised validation error");
  if (RATE_LIMITED.test(text)) return new HistoryError("rate_limited", "Garmin asked us to slow down (rate limited).");
  if (isTimeoutError(text)) return new HistoryError("timeout", "Garmin did not answer in time.");
  if (RANGE_TOO_BIG.test(text)) return new HistoryError("range_too_big", "Garmin rejected the date range as too long.");
  if (AUTH.test(text)) return new HistoryError("auth", "Garmin refused the login. Check the Garmin connection.");
  if (UNREACHABLE.test(text)) return new HistoryError("unreachable", "Could not reach the Garmin server.");
  return new HistoryError("failed", sanitiseError(text).slice(0, MAX_REASON));
}

/** Errors that end the whole import, whatever kind was being fetched: the login failed, or Garmin cannot be reached. */
export const isFatal = (e: HistoryError): boolean => e.kind === "auth" || e.kind === "unreachable";

export function classify(err: unknown): HistoryError {
  if (err instanceof HistoryError) return err;
  if (err instanceof ZodError) return new HistoryError("shape", SHAPE_MESSAGE, zodDetail(err));
  const text = err instanceof Error ? err.message : String(err);
  const status = typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number" ? (err as { status: number }).status : null;
  if (status === 429) return new HistoryError("rate_limited", "Garmin asked us to slow down (rate limited).");
  if (status === 401 || status === 403) return new HistoryError("auth", "Garmin refused the login. Check the Garmin connection.");
  return classifyText(text);
}

export interface Helpers {
  db: Db;
  ctx: Ctx;
}

/** One call. "No data" means an empty answer, null. Anything else that is plain text is a failure. */
async function call(session: GarminSession, tool: GarminReadTool, args: Record<string, unknown>): Promise<unknown | null> {
  let res;
  try {
    res = await session.call(tool, args);
  } catch (err) {
    throw classify(err);
  }
  if (res.kind === "message") {
    if (/^no\b/i.test(res.text.trim())) return null;
    throw classifyText(res.text);
  }
  // An empty list or an empty object is an empty answer, the same as "No data": a complete window with zero rows.
  const d = res.data;
  if ((Array.isArray(d) && d.length === 0) || (typeof d === "object" && d !== null && !Array.isArray(d) && Object.keys(d).length === 0)) return null;
  return d;
}

// ---------------------------------------------------------------- tolerant reading of range answers
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The list of per-day objects in a range answer: the answer itself, or its first property that is a list of objects. */
export function listFrom(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return data.filter(isObj);
  if (!isObj(data)) return null;
  for (const v of Object.values(data)) if (Array.isArray(v) && v.length > 0 && v.every(isObj)) return v as Record<string, unknown>[];
  for (const v of Object.values(data)) if (Array.isArray(v) && v.length === 0) return [];
  return null;
}

/** Keys Garmin repeats back or counts with. An answer with only these has no data in it: an empty window (D62). */
const ECHO_KEYS = new Set(["start_date", "end_date", "startDate", "endDate", "count", "total", "data_points", "message"]);
export const isEchoOnly = (data: unknown): boolean => isObj(data) && Object.keys(data).every((k) => ECHO_KEYS.has(k));

const DATE_KEYS = ["date", "calendar_date", "calendarDate", "sleep_date", "day", "start_date"];
export function dateOf(o: Record<string, unknown>): string | null {
  for (const k of DATE_KEYS) {
    const v = o[k];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return null;
}

export function numberFrom(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export function putReading(db: Db, kind: string, date: string, value: number, value2: number | null = null, value3: number | null = null): void {
  const v = { value, value2, value3 };
  db.insert(dailyReading).values({ kind, date, ...v }).onConflictDoUpdate({ target: [dailyReading.kind, dailyReading.date], set: v }).run();
}

/** Days of a kind already stored in the range, so a retried window does not ask for them again. */
export function storedDays(db: Db, kind: string, from: string, to: string): Set<string> {
  return new Set(db.select({ date: dailyReading.date }).from(dailyReading).where(eq(dailyReading.kind, kind)).all().map((r) => r.date).filter((d) => d >= from && d <= to));
}

// ---------------------------------------------------------------- window sizes
/**
 * Window sizes for every range tool, in one place (D60). start is the first window in days, max the most it ever grows to.
 * documented says whether the limit comes from the tool's own description in the Garmin MCP server. Where the description
 * gives no limit, the window is fixed at a size that is known to work and never grows: body battery was rejected at 60
 * days ("requested date range is too big") and verified at 14, and endurance score, hill score and lactate threshold
 * have no stated limit, so they use the same 14. Activities are fetched in pages and worked at up to 90 days in the first run.
 * A tool that still answers "range too big" is halved and the size that worked is remembered (see the engine).
 */
export const RANGE_LIMITS: Record<string, { start: number; max: number; documented: boolean; note: string }> = {
  activities: { start: 30, max: 90, documented: false, note: "paged, worked at 90 days" },
  sleep: { start: 30, max: 90, documented: true, note: "Maximum: 90 nights per call" },
  hrv: { start: 30, max: 30, documented: true, note: "Maximum: 30 days" },
  body_battery: { start: 14, max: 14, documented: false, note: "no limit stated, 60 days rejected, 14 verified" },
  vo2max: { start: 30, max: 90, documented: true, note: "Maximum: 90 days" },
  endurance: { start: 14, max: 14, documented: false, note: "no limit stated" },
  hill: { start: 14, max: 14, documented: false, note: "no limit stated" },
  lactate: { start: 14, max: 14, documented: false, note: "no limit stated" },
};
const L = (id: keyof typeof RANGE_LIMITS) => RANGE_LIMITS[id] as { start: number; max: number };

// ---------------------------------------------------------------- kind specs
export interface RangeSpec {
  id: HistoryKindId;
  tool: GarminReadTool;
  /** First window size in days. */
  start: number;
  /** The most the tool takes in one call. The window never grows past it. */
  limit: number;
  fetch(session: GarminSession, from: string, to: string, h: Helpers): Promise<number>;
}

export interface DaySpec {
  id: HistoryKindId;
  tool: GarminReadTool;
  /** Window size in days for per-day tools. */
  window: number;
  /** Fetches and stores one day. Returns how many rows were stored (0 for an empty day). */
  fetchDay(session: GarminSession, date: string, h: Helpers): Promise<number>;
}

const shape = (what: string, err?: ZodError) => new HistoryError("shape", SHAPE_MESSAGE, `${what}${err ? `: ${zodDetail(err)}` : ""}`);

const sleepRange: RangeSpec = {
  id: "sleep",
  tool: "get_sleep_summary_range",
  start: L("sleep").start,
  limit: L("sleep").max,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    if (isEchoOnly(data)) return 0;
    const list = listFrom(data);
    if (!list) throw shape("sleep range");
    let rows = 0;
    for (const el of list) {
      const date = dateOf(el);
      const score = numberFrom(el, ["sleep_score", "sleepScore", "score"]);
      if (!date || score === null) continue;
      putReading(h.db, "sleep", date, score, numberFrom(el, ["sleep_hours", "sleepHours", "hours"]));
      rows++;
    }
    if (list.length > 0 && rows === 0) throw shape("sleep range");
    return rows;
  },
};

const HRV_KEYS = ["last_night_avg_hrv_ms", "last_night_avg", "lastNightAvg", "hrv", "avg_hrv", "daily_avg", "value"];
const hrvRange: RangeSpec = {
  id: "hrv",
  tool: "get_hrv_trend",
  start: L("hrv").start,
  limit: L("hrv").max,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    if (isEchoOnly(data)) return 0;
    const list = listFrom(data);
    if (!list) throw shape("HRV trend");
    let rows = 0;
    for (const el of list) {
      const date = dateOf(el);
      const v = numberFrom(el, HRV_KEYS);
      if (!date || v === null) continue;
      putReading(h.db, "hrv", date, v);
      rows++;
    }
    if (list.length > 0 && rows === 0) throw shape("HRV trend");
    return rows;
  },
};

const bodyBatteryRange: RangeSpec = {
  id: "body_battery",
  tool: "get_body_battery",
  start: L("body_battery").start,
  limit: L("body_battery").max,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    // Normally a list of days. Fields the app does not need are optional, and a wrapper object is read too.
    const list = Array.isArray(data) ? data.filter(isObj) : listFrom(data);
    if (!list) {
      // Garmin repeats the dates and nothing else when a range has no data.
      if (isEchoOnly(data)) return 0;
      throw shape("body battery");
    }
    let rows = 0;
    for (const e of list) {
      const date = dateOf(e);
      const charged = numberFrom(e, ["charged", "body_battery_charged"]);
      if (!date || charged === null) continue;
      putReading(h.db, "body_battery", date, charged, numberFrom(e, ["drained", "body_battery_drained"]));
      rows++;
    }
    return rows;
  },
};

/** Every field is optional except what a point needs: a date and a value. A day without one is skipped, not a failure. */
const vo2History = z.object({
  trend: z.array(z.object({ date: z.string().nullish(), vo2_max: z.number().nullish(), carried_forward: z.boolean().nullish() })).nullish(),
});

const vo2Range: RangeSpec = {
  id: "vo2max",
  tool: "get_vo2max_trend",
  start: L("vo2max").start,
  limit: L("vo2max").max,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    const p = vo2History.safeParse(data);
    if (!p.success) throw shape("VO2 max trend", p.error);
    const trend = (p.data.trend ?? []).flatMap((t) => (t.date && t.vo2_max != null ? [{ date: t.date.slice(0, 10), vo2_max: t.vo2_max, carried_forward: t.carried_forward ?? false }] : []));
    h.db.transaction(() => applyVo2({ trend }, h.ctx));
    return trend.length;
  },
};

/** Garmin's answer has more than this (contributors, classification ids). Only the score and the weekly averages are used, and none is required. */
const enduranceHistory = z.object({
  current_score: z.number().nullish(),
  current_date: z.string().nullish(),
  weekly_breakdown: z.array(z.object({ week_start: z.string().nullish(), avg_score: z.number().nullish() })).nullish(),
});

const enduranceRange: RangeSpec = {
  id: "endurance",
  tool: "get_endurance_score",
  start: L("endurance").start,
  limit: L("endurance").max,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    const p = enduranceHistory.safeParse(data);
    if (!p.success) throw shape("endurance score", p.error);
    let rows = 0;
    // Garmin's weekly averages, dated by the week's first day, and the current score when it has a date.
    for (const w of p.data.weekly_breakdown ?? []) {
      if (!w.week_start || w.avg_score == null) continue;
      putReading(h.db, "endurance", w.week_start.slice(0, 10), w.avg_score);
      rows++;
    }
    if (p.data.current_score != null && p.data.current_date) {
      putReading(h.db, "endurance", p.data.current_date.slice(0, 10), p.data.current_score);
      rows++;
    }
    return rows;
  },
};

const hillHistory = z.object({
  daily_scores: z.array(z.object({ date: z.string().nullish(), overall: z.number().nullish(), strength: z.number().nullish(), endurance: z.number().nullish() })).nullish(),
});

const hillRange: RangeSpec = {
  id: "hill",
  tool: "get_hill_score",
  start: L("hill").start,
  limit: L("hill").max,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    const p = hillHistory.safeParse(data);
    if (!p.success) throw shape("hill score", p.error);
    let rows = 0;
    for (const d of p.data.daily_scores ?? []) {
      if (!d.date || d.overall == null) continue;
      putReading(h.db, "hill", d.date.slice(0, 10), d.overall, d.strength ?? null, d.endurance ?? null);
      rows++;
    }
    return rows;
  },
};

/** Garmin's lactate threshold history: a heart rate list and a speed list, by day, and a power list the app does not use. */
const lactateHistory = z.object({
  heart_rate_history: z.array(z.object({ date: z.string().nullish(), heart_rate_bpm: z.number().nullish() })).nullish(),
  speed_history: z.array(z.object({ date: z.string().nullish(), speed_mps: z.number().nullish() })).nullish(),
});

const lactateRange: RangeSpec = {
  id: "lactate",
  tool: "get_lactate_threshold",
  start: L("lactate").start,
  limit: L("lactate").max,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    if (Array.isArray(data)) return lactateEntries(h, data.filter(isObj));
    if (!isObj(data)) throw shape("lactate threshold");
    // The latest-only shape, in case the server answers that way.
    const single = up.lactateSchema.safeParse(data);
    if (single.success && single.data.lactate_threshold_heart_rate_bpm != null && single.data.speed_hr_date) {
      putReading(h.db, "lactate", single.data.speed_hr_date.slice(0, 10), single.data.lactate_threshold_heart_rate_bpm, single.data.lactate_threshold_speed_mps ?? null);
      return 1;
    }
    // The history shape. Every list is optional and unknown keys are ignored (D62): with no lactate data in the range Garmin
    // sends only start_date and end_date, and with only power data it sends just power_history. Both are complete windows.
    const p = lactateHistory.safeParse(data);
    if (!p.success) throw shape("lactate threshold", p.error);
    const speeds = new Map((p.data.speed_history ?? []).flatMap((x) => (x.date && x.speed_mps != null ? [[x.date.slice(0, 10), x.speed_mps] as const] : [])));
    let rows = 0;
    for (const x of p.data.heart_rate_history ?? []) {
      if (!x.date || x.heart_rate_bpm == null) continue;
      const date = x.date.slice(0, 10);
      putReading(h.db, "lactate", date, x.heart_rate_bpm, speeds.get(date) ?? null);
      rows++;
    }
    // A list of dated entries under any other name, as older answers had.
    if (rows === 0 && !("heart_rate_history" in data) && !("speed_history" in data) && !("power_history" in data)) {
      const list = listFrom(data);
      if (list) rows += lactateEntries(h, list);
    }
    return rows;
  },
};

function lactateEntries(h: Helpers, list: Record<string, unknown>[]): number {
  let rows = 0;
  for (const el of list) {
    const date = dateOf(el) ?? (typeof el.speed_hr_date === "string" ? el.speed_hr_date.slice(0, 10) : null);
    const hr = numberFrom(el, ["lactate_threshold_heart_rate_bpm", "heart_rate_bpm", "heart_rate", "hr"]);
    if (!date || hr === null) continue;
    putReading(h.db, "lactate", date, hr, numberFrom(el, ["lactate_threshold_speed_mps", "speed_mps", "speed"]));
    rows++;
  }
  return rows;
}

const activitiesRange: RangeSpec = {
  id: "activities",
  tool: "get_activities_by_date",
  start: L("activities").start,
  limit: L("activities").max,
  async fetch(session, from, to, h) {
    let rows = 0;
    // Newest first, in pages. Summaries only: name, date, type, distance, duration, average and maximum heart rate.
    for (let page = 0; page < 8; page++) {
      const data = await call(session, this.tool, { start_date: from, end_date: to, page, page_size: 100 });
      if (data === null || isEchoOnly(data)) break;
      const p = up.activitiesSchema.safeParse(data);
      if (!p.success) throw shape("activities");
      h.db.transaction(() => applyActivities(p.data, h.ctx));
      rows += p.data.activities.length;
      if (p.data.has_more !== true) break;
    }
    return rows;
  },
};

/** Range tools, with the window sizes they take. */
export const RANGE_SPECS: Partial<Record<HistoryKindId, RangeSpec>> = {
  activities: activitiesRange,
  sleep: sleepRange,
  hrv: hrvRange,
  body_battery: bodyBatteryRange,
  vo2max: vo2Range,
  endurance: enduranceRange,
  hill: hillRange,
  lactate: lactateRange,
};

const rhrDay: DaySpec = {
  id: "rhr",
  tool: "get_rhr_day",
  window: 14,
  async fetchDay(session, date, h) {
    const data = await call(session, this.tool, { date });
    if (data === null) return 0;
    const p = up.rhrSchema.safeParse(data);
    if (!p.success) throw shape("resting heart rate");
    const v = p.data.allMetrics.metricsMap.WELLNESS_RESTING_HEART_RATE?.[0]?.value;
    if (v == null) return 0;
    putReading(h.db, "rhr", date, v);
    return 1;
  },
};

const readinessDay: DaySpec = {
  id: "readiness",
  tool: "get_training_readiness",
  window: 14,
  async fetchDay(session, date, h) {
    const data = await call(session, this.tool, { date });
    if (data === null) return 0;
    const p = up.readinessSchema.safeParse(data);
    if (!p.success) throw shape("training readiness");
    const entries = Array.isArray(p.data) ? p.data : [p.data];
    const latest = [...entries].sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))[0];
    if (latest?.score == null) return 0;
    putReading(h.db, "readiness", date, latest.score);
    return 1;
  },
};

/** Per-day tools. Sleep and HRV also have one, used when the range answer cannot be read. */
export const DAY_SPECS: Partial<Record<HistoryKindId, DaySpec>> = {
  rhr: rhrDay,
  readiness: readinessDay,
  sleep: {
    id: "sleep",
    tool: "get_sleep_summary",
    window: 14,
    async fetchDay(session, date, h) {
      const data = await call(session, this.tool, { date });
      if (data === null) return 0;
      const p = up.sleepSchema.safeParse(data);
      if (!p.success) throw shape("sleep");
      if (p.data.sleep_score == null) return 0;
      putReading(h.db, "sleep", date, p.data.sleep_score, p.data.sleep_hours ?? null);
      return 1;
    },
  },
  hrv: {
    id: "hrv",
    tool: "get_hrv_data",
    window: 14,
    async fetchDay(session, date, h) {
      const data = await call(session, this.tool, { date });
      if (data === null) return 0;
      const p = up.hrvSchema.safeParse(data);
      if (!p.success) throw shape("HRV");
      if (p.data.last_night_avg_hrv_ms == null) return 0;
      putReading(h.db, "hrv", date, p.data.last_night_avg_hrv_ms);
      return 1;
    },
  },
};

/** Per-day kinds. Only these two have no range tool: resting heart rate and training readiness. */
export const PER_DAY_ONLY: HistoryKindId[] = ["rhr", "readiness"];

export const KIND_ORDER: HistoryKindId[] = HISTORY_KINDS.map((k) => k.id);
