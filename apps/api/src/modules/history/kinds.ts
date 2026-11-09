import { eq } from "drizzle-orm";
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
    readonly kind: "timeout" | "rate_limited" | "shape" | "failed",
    message: string,
  ) {
    super(message);
  }
}

const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|throttl/i;
const MAX_REASON = 150;

const UNREACHABLE = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|network/i;

export function classifyText(text: string): HistoryError {
  if (RATE_LIMITED.test(text)) return new HistoryError("rate_limited", "Garmin asked us to slow down (rate limited).");
  if (isTimeoutError(text)) return new HistoryError("timeout", "Garmin did not answer in time.");
  if (UNREACHABLE.test(text)) return new HistoryError("failed", "Could not reach the Garmin server.");
  return new HistoryError("failed", sanitiseError(text).slice(0, MAX_REASON));
}

export function classify(err: unknown): HistoryError {
  if (err instanceof HistoryError) return err;
  const text = err instanceof Error ? err.message : String(err);
  const status = typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number" ? (err as { status: number }).status : null;
  if (status === 429) return new HistoryError("rate_limited", "Garmin asked us to slow down (rate limited).");
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
  return res.data;
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

const shape = (what: string) => new HistoryError("shape", `Unexpected answer shape: ${what}.`);

const sleepRange: RangeSpec = {
  id: "sleep",
  tool: "get_sleep_summary_range",
  start: 30,
  limit: 90,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
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
  start: 30,
  limit: 30,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
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
  start: 30,
  limit: 90,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    const p = up.bodyBatterySchema.safeParse(data);
    if (!p.success) throw shape("body battery");
    let rows = 0;
    for (const e of p.data) {
      if (e.charged == null) continue;
      putReading(h.db, "body_battery", e.date, e.charged, e.drained ?? null);
      rows++;
    }
    return rows;
  },
};

const vo2Range: RangeSpec = {
  id: "vo2max",
  tool: "get_vo2max_trend",
  start: 30,
  limit: 90,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    const p = up.vo2Schema.safeParse(data);
    if (!p.success) throw shape("VO2 max trend");
    h.db.transaction(() => applyVo2(p.data, h.ctx));
    return p.data.trend.length;
  },
};

const enduranceRange: RangeSpec = {
  id: "endurance",
  tool: "get_endurance_score",
  start: 30,
  limit: 90,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    const p = up.enduranceSchema.safeParse(data);
    if (!p.success) throw shape("endurance score");
    let rows = 0;
    // Garmin's weekly averages, dated by the week's first day, and the current score when it has a date.
    for (const w of p.data.weekly_breakdown) {
      putReading(h.db, "endurance", w.week_start, w.avg_score);
      rows++;
    }
    if (p.data.current_score != null && p.data.current_date) {
      putReading(h.db, "endurance", p.data.current_date.slice(0, 10), p.data.current_score);
      rows++;
    }
    return rows;
  },
};

const hillRange: RangeSpec = {
  id: "hill",
  tool: "get_hill_score",
  start: 30,
  limit: 90,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    const p = up.hillSchema.safeParse(data);
    if (!p.success) throw shape("hill score");
    let rows = 0;
    for (const d of p.data.daily_scores ?? []) {
      if (d.overall == null) continue;
      putReading(h.db, "hill", d.date.slice(0, 10), d.overall, d.strength ?? null, d.endurance ?? null);
      rows++;
    }
    return rows;
  },
};

const lactateRange: RangeSpec = {
  id: "lactate",
  tool: "get_lactate_threshold",
  start: 30,
  limit: 90,
  async fetch(session, from, to, h) {
    const data = await call(session, this.tool, { start_date: from, end_date: to });
    if (data === null) return 0;
    let rows = 0;
    const single = up.lactateSchema.safeParse(data);
    if (single.success && single.data.lactate_threshold_heart_rate_bpm != null && single.data.speed_hr_date) {
      putReading(h.db, "lactate", single.data.speed_hr_date.slice(0, 10), single.data.lactate_threshold_heart_rate_bpm, single.data.lactate_threshold_speed_mps ?? null);
      return 1;
    }
    const list = listFrom(data);
    if (!list) {
      if (isObj(data) && Object.keys(data).length === 0) return 0;
      throw shape("lactate threshold");
    }
    for (const el of list) {
      const date = dateOf(el) ?? (typeof el.speed_hr_date === "string" ? el.speed_hr_date.slice(0, 10) : null);
      const hr = numberFrom(el, ["lactate_threshold_heart_rate_bpm", "heart_rate_bpm", "heart_rate", "hr"]);
      if (!date || hr === null) continue;
      putReading(h.db, "lactate", date, hr, numberFrom(el, ["lactate_threshold_speed_mps", "speed_mps", "speed"]));
      rows++;
    }
    return rows;
  },
};

const activitiesRange: RangeSpec = {
  id: "activities",
  tool: "get_activities_by_date",
  start: 30,
  limit: 90,
  async fetch(session, from, to, h) {
    let rows = 0;
    // Newest first, in pages. Summaries only: name, date, type, distance, duration, average and maximum heart rate.
    for (let page = 0; page < 8; page++) {
      const data = await call(session, this.tool, { start_date: from, end_date: to, page, page_size: 100 });
      if (data === null) break;
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
