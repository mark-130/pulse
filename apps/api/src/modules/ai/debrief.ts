import { and, asc, desc, eq, gte } from "drizzle-orm";
import { type Debrief } from "@pulse/shared";
import { addDays, londonDate } from "../../dates.js";
import { activity, workout } from "../../db/schema.js";
import { DEBRIEF_TASK } from "./prompts.js";
import { systemFor } from "./proposal-tools.js";
import { aiGate } from "./usage.js";
import { textFrom } from "./failure.js";
import { callModel, type AiRuntime } from "./runtime.js";
import { getStored, putStored } from "./store.js";
import { wrapData } from "./tools.js";

/** Room for thinking as well as the text: the models count thinking against this limit (D44). */
const MAX_TOKENS = 2000;
/** Runs this new, or newer, get a debrief automatically after a sync. Older ones only on a tap. */
export const AUTO_DEBRIEF_DAYS = 2;
/** At most this many automatic debriefs per sync, so a busy catch-up cannot spend the cap. */
export const AUTO_DEBRIEF_PER_SYNC = 3;
const mins = (s: number | null) => (s === null ? null : Math.round(s / 60));
const km = (m: number | null) => (m === null ? null : Math.round(m / 10) / 100);

export function getDebrief(rt: AiRuntime, id: string): Debrief | null {
  const r = getStored(rt.db, "debrief", id);
  return r ? { activityId: id, text: r.text, generatedAt: r.createdAt, model: r.model } : null;
}

/**
 * Summaries only: the activity row and the workout Garmin has scheduled for that day. No splits, no per-second data,
 * and no other runs to compare with. Targets are only what Garmin holds: the workout's name and scheduled minutes.
 */
export function debriefContext(rt: AiRuntime, id: string) {
  const a = rt.db.select().from(activity).where(eq(activity.garminActivityId, id)).get();
  if (!a || a.type !== "running") return null;
  const scheduled = rt.db.select().from(workout).where(eq(workout.date, a.date)).orderBy(asc(workout.name)).all().map((w) => ({ name: w.name, scheduledMinutes: mins(w.durationS), completedInGarmin: w.completed }));
  return {
    run: { id, date: a.date, start: a.startLocal, name: a.name, km: km(a.distanceM), minutes: mins(a.durationS), avgHr: a.avgHr, maxHr: a.maxHr, elevationGainM: a.elevationGainM, calories: a.calories },
    scheduledInGarminThatDay: scheduled,
  };
}

/** One short debrief per activity, cached by activity id. It is never rewritten unless refresh is true. */
export async function generateDebrief(rt: AiRuntime, id: string, refresh = false): Promise<Debrief | null> {
  const existing = getDebrief(rt, id);
  if (existing && !refresh) return existing;
  const ctx = debriefContext(rt, id);
  if (!ctx) return null;
  const model = rt.config.ANTHROPIC_MODEL_FAST;
  const res = await callModel(rt, "debrief", {
    model,
    system: systemFor(rt.config),
    effort: "low",
    maxTokens: MAX_TOKENS,
    messages: [{ role: "user", content: `${DEBRIEF_TASK}\n\nContext:\n${wrapData("run_debrief_context", ctx)}` }],
  });
  const text = textFrom(res);
  putStored(rt.db, "debrief", id, { text, model, tokens: res.usage.inputTokens + res.usage.outputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens, now: rt.now() });
  return getDebrief(rt, id);
}

/** Running activities from the last two days that have no debrief yet. */
export function undebriefedRuns(rt: AiRuntime): string[] {
  const since = addDays(londonDate(rt.now()), -AUTO_DEBRIEF_DAYS);
  return rt.db
    .select()
    .from(activity)
    .where(and(eq(activity.type, "running"), gte(activity.date, since)))
    .orderBy(desc(activity.startLocal))
    .all()
    .filter((a) => !getDebrief(rt, a.garminActivityId))
    .map((a) => a.garminActivityId)
    .slice(0, AUTO_DEBRIEF_PER_SYNC);
}

/** After a sync: write the missing debriefs for new runs, one at a time. Stops quietly when AI is off or the cap is reached. */
export async function debriefNewRuns(rt: AiRuntime, onError: (err: unknown) => void): Promise<number> {
  let n = 0;
  for (const id of undebriefedRuns(rt)) {
    if (!aiGate(rt.db, rt.config, rt.now()).ok) break;
    try {
      if (await generateDebrief(rt, id)) n++;
    } catch (err) {
      onError(err);
      break;
    }
  }
  return n;
}
