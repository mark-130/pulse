import { and, eq, gte, lt, sql } from "drizzle-orm";
import { AI_BUDGET_TEXT, AI_OFF_TEXT, type AiStatus } from "@pulse/shared";
import type { Config } from "../../config.js";
import { londonDate } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { aiUsage } from "../../db/schema.js";
import { costGbp, PRICES_CHECKED_ON, PRICES_USD_PER_MTOK, type TokenUsage } from "./pricing.js";

export type AiConfig = Pick<Config, "ANTHROPIC_API_KEY" | "ANTHROPIC_MODEL_SMART" | "ANTHROPIC_MODEL_FAST" | "AI_MONTHLY_CAP_GBP" | "AI_USD_TO_GBP" | "AI_PROPOSALS" | "PULSE_GARMIN_WRITES">;

export const aiConfigured = (c: Pick<Config, "ANTHROPIC_API_KEY">): boolean => c.ANTHROPIC_API_KEY.trim() !== "";

/** Calendar month in Europe/London, as [first day, first day of next month) in YYYY-MM-DD. */
export function monthBounds(now: Date): { start: string; next: string; label: string } {
  const today = londonDate(now);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start: `${y}-${String(m).padStart(2, "0")}-01`, next, label: `${String(m).padStart(2, "0")}/${y}` };
}

/** Rows are stored with an ISO instant. London midnight is within an hour of UTC, so compare on the London date of the instant. */
function inMonth(ts: string, b: { start: string; next: string }): boolean {
  const d = londonDate(new Date(ts));
  return d >= b.start && d < b.next;
}

export function monthSpend(db: Db, now: Date) {
  const b = monthBounds(now);
  // Fetch a wide window cheaply, then filter on the London date.
  const rows = db.select().from(aiUsage).where(and(gte(aiUsage.ts, `${b.start}T00:00:00`), lt(aiUsage.ts, `${b.next}T23:59:59`))).all().filter((r) => inMonth(r.ts, b));
  const byFeature = new Map<string, { calls: number; costGbp: number }>();
  let spent = 0;
  for (const r of rows) {
    spent += r.costGbp;
    const f = byFeature.get(r.feature) ?? { calls: 0, costGbp: 0 };
    f.calls++;
    f.costGbp += r.costGbp;
    byFeature.set(r.feature, f);
  }
  return { spent, calls: rows.length, byFeature: [...byFeature.entries()].map(([feature, v]) => ({ feature, ...v })), label: b.label };
}

export function recordUsage(db: Db, config: AiConfig, entry: { feature: string; model: string; usage: TokenUsage; now: Date }): number {
  const cost = costGbp(entry.model, entry.usage, config.AI_USD_TO_GBP);
  db.insert(aiUsage)
    .values({
      ts: entry.now.toISOString(),
      feature: entry.feature,
      model: entry.model,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadTokens: entry.usage.cacheReadTokens,
      cacheWriteTokens: entry.usage.cacheWriteTokens,
      costGbp: cost,
    })
    .run();
  return cost;
}

export type AiGate = { ok: true } | { ok: false; reason: "off" | "budget"; message: string };

/** The single place that decides whether an AI call may be made. Checked before every call, including each step of a tool loop. */
export function aiGate(db: Db, config: AiConfig, now: Date): AiGate {
  if (!aiConfigured(config)) return { ok: false, reason: "off", message: AI_OFF_TEXT };
  if (monthSpend(db, now).spent >= config.AI_MONTHLY_CAP_GBP) return { ok: false, reason: "budget", message: AI_BUDGET_TEXT };
  return { ok: true };
}

export function aiStatus(db: Db, config: AiConfig, now: Date): AiStatus {
  const gate = aiGate(db, config, now);
  const m = monthSpend(db, now);
  const percent = Math.min(999, Math.round((m.spent / config.AI_MONTHLY_CAP_GBP) * 100));
  const notice = gate.ok && percent >= 80 ? `AI spend is at ${percent} percent of this month's cap. AI stops at 100 percent.` : null;
  return {
    state: gate.ok ? "ok" : gate.reason,
    message: gate.ok ? null : gate.message,
    notice,
    month: { label: m.label, spentGbp: m.spent, capGbp: config.AI_MONTHLY_CAP_GBP, percent, calls: m.calls, byFeature: m.byFeature },
    proposals: config.AI_PROPOSALS === "on" && config.PULSE_GARMIN_WRITES === "on",
    pricing: { checkedOn: PRICES_CHECKED_ON, usdToGbp: config.AI_USD_TO_GBP, models: Object.keys(PRICES_USD_PER_MTOK) },
  };
}

// Kept for tests that want to count rows without the month filter.
export const usageRowCount = (db: Db, feature?: string): number =>
  (db.select({ n: sql<number>`count(*)` }).from(aiUsage).where(feature ? eq(aiUsage.feature, feature) : undefined).get()?.n ?? 0);
