import { eq } from "drizzle-orm";
import { GARMIN_GROUPS, type Briefing } from "@pulse/shared";
import { londonDate } from "../../dates.js";
import { briefing as briefingTable } from "../../db/schema.js";
import { getToday } from "../garmin/queries.js";
import { groupStatuses } from "../garmin/freshness.js";
import { getRaceView } from "../races/data.js";
import { BRIEFING_TASK } from "./prompts.js";
import { systemFor } from "./proposal-tools.js";
import { callModel, type AiRuntime } from "./runtime.js";
import { wrapData } from "./tools.js";

const STALE_AFTER_MIN = 90;
const MAX_TOKENS = 400;

export function getBriefing(rt: AiRuntime, date = londonDate(rt.now())): Briefing | null {
  const row = rt.db.select().from(briefingTable).where(eq(briefingTable.date, date)).get();
  if (!row) return null;
  const d = (row.data ?? {}) as { generatedAt?: string; staleGroups?: string[] };
  return { date: row.date, text: row.text, generatedAt: d.generatedAt ?? row.date, model: row.model ?? "", staleGroups: d.staleGroups ?? [] };
}

/** The pre-assembled context for the single briefing call. Only summaries and metrics from our own database. */
export function briefingContext(rt: AiRuntime) {
  const now = rt.now();
  const t = getToday(rt.db, now);
  const races = getRaceView(rt.db, now);
  const groups = groupStatuses(rt.db, now, STALE_AFTER_MIN) ?? [];
  const staleGroups = groups.filter((g) => g.stale).map((g) => g.label);
  const race = (r: typeof t.nextRace) =>
    r && { title: r.title, date: r.date, daysUntil: r.daysUntil, start: r.startTimeLocal, timeZone: r.timeZone, distanceKm: r.distanceM === null ? null : Math.round(r.distanceM) / 1000, goalTimeSeconds: r.goalTimeSeconds, priority: r.priorityInferred ? "Priority not set" : r.priority, prioritySetByMark: !r.priorityInferred, flags: r.flags.map((f) => f.text) };
  return {
    context: {
      today: t.date,
      staleGroups,
      readings: t.verdict.signals.map((x) => x.text),
      garminReadiness: t.readiness,
      todaySessions: t.session.today.map((w) => ({ name: w.name, durationMin: w.durationS === null ? null : Math.round(w.durationS / 60), completed: w.completed })),
      nextSession: t.session.next && { name: t.session.next.name, date: t.session.next.date, durationMin: t.session.next.durationS === null ? null : Math.round(t.session.next.durationS / 60) },
      activitiesToday: t.session.activitiesToday.map((a) => ({ name: a.name, distanceKm: a.distanceM === null ? null : Math.round(a.distanceM) / 1000, durationMin: a.durationS === null ? null : Math.round(a.durationS / 60) })),
      metrics: t.metrics,
      nextRace: race(t.nextRace),
      followingRace: race(t.followingRace),
      raceWarnings: races.warnings.filter((w) => w.severity === "action").slice(0, 3).map((w) => w.message),
      pendingProposals: t.proposals.pending,
    },
    staleGroups,
  };
}

/** Generates today's briefing unless one exists. One call, no tools. Throws AiUnavailable when AI is off or the budget is reached. */
export async function generateBriefing(rt: AiRuntime): Promise<Briefing> {
  const existing = getBriefing(rt);
  if (existing) return existing;
  const { context, staleGroups } = briefingContext(rt);
  const model = rt.config.ANTHROPIC_MODEL_FAST;
  const res = await callModel(rt, "briefing", {
    model,
    system: systemFor(rt.config),
    maxTokens: MAX_TOKENS,
    messages: [{ role: "user", content: `${BRIEFING_TASK}\n\nContext:\n${wrapData("briefing_context", context)}` }],
  });
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error("The model returned no text.");
  const now = rt.now();
  const date = londonDate(now);
  const generatedAt = now.toISOString();
  rt.db
    .insert(briefingTable)
    .values({ date, text, data: { generatedAt, staleGroups, context }, model, tokens: res.usage.inputTokens + res.usage.outputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens })
    .onConflictDoNothing()
    .run();
  return getBriefing(rt, date) as Briefing;
}

export const GROUP_LABELS: string[] = GARMIN_GROUPS.map((g) => g.label);
