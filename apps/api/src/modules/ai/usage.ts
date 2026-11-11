import { and, eq, gte, lt, sql } from "drizzle-orm";
import { AI_BUDGET_TEXT, AI_OFF_TEXT, type AiStatus } from "@pulse/shared";
import type { Config } from "../../config.js";
import { addDays, londonDate } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { aiReservation, aiUsage } from "../../db/schema.js";
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
  // Fetch a wide window cheaply, then filter on the London date. In British Summer Time London midnight is 23:00Z on the
  // day before, so the window starts a day early (D66). The London date filter below is what decides membership.
  const rows = db.select().from(aiUsage).where(and(gte(aiUsage.ts, `${addDays(b.start, -1)}T00:00:00`), lt(aiUsage.ts, `${b.next}T23:59:59`))).all().filter((r) => inMonth(r.ts, b));
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

/** A reservation older than this is a call that never finished (a crash). The SDK gives up after AI_TIMEOUT_S, so nothing live is this old. */
export const RESERVATION_STALE_MS = 15 * 60_000;

/** Money held by calls in flight, in GBP, ignoring stale ones. */
export function reservedGbp(db: Db, now: Date): number {
  const cutoff = new Date(now.getTime() - RESERVATION_STALE_MS).toISOString();
  return db.select({ n: sql<number>`coalesce(sum(${aiReservation.estimateGbp}), 0)` }).from(aiReservation).where(gte(aiReservation.ts, cutoff)).get()?.n ?? 0;
}

/** Drops reservations left behind by a crash. Safe to call at any time. */
export function clearStaleReservations(db: Db, now: Date): void {
  const cutoff = new Date(now.getTime() - RESERVATION_STALE_MS).toISOString();
  db.delete(aiReservation).where(lt(aiReservation.ts, cutoff)).run();
}

/**
 * Worst case cost of a call, in GBP, worked out before it is made: the whole prompt at the dearest input rate (a cache
 * write costs more than plain input), counted at 3 characters a token so it errs high, plus max_tokens of output.
 * Thinking counts as output and max_tokens bounds both, so the real cost cannot be higher.
 */
export function estimateCostGbp(model: string, req: { system: string; messages: unknown; tools?: unknown; maxTokens: number }, usdToGbp: number): number {
  const chars = req.system.length + JSON.stringify(req.messages).length + (req.tools ? JSON.stringify(req.tools).length : 0);
  const inputTokens = Math.ceil(chars / 3);
  const p = PRICES_USD_PER_MTOK[model] ?? PRICES_USD_PER_MTOK["claude-sonnet-5-5"];
  const rate = Math.max(p?.input ?? 0, p?.cacheWrite ?? 0);
  return ((inputTokens * rate + req.maxTokens * (p?.output ?? 0)) / 1_000_000) * usdToGbp;
}

export type Reservation = { ok: true; id: number } | { ok: false; reason: "off" | "budget"; message: string };

/**
 * Holds the worst case cost of a call before it is made (D57). One immediate transaction reads what is spent, what is
 * held by calls in flight, and inserts this call's hold, so two calls cannot both pass the check on the same money,
 * even from two processes. Refused when spent + held + this estimate would go over the cap.
 */
export function reserve(db: Db, config: AiConfig, now: Date, entry: { feature: string; model: string; estimateGbp: number }): Reservation {
  if (!aiConfigured(config)) return { ok: false, reason: "off", message: AI_OFF_TEXT };
  return db.transaction(
    (tx) => {
      const cutoff = new Date(now.getTime() - RESERVATION_STALE_MS).toISOString();
      tx.delete(aiReservation).where(lt(aiReservation.ts, cutoff)).run();
      const held = tx.select({ n: sql<number>`coalesce(sum(${aiReservation.estimateGbp}), 0)` }).from(aiReservation).get()?.n ?? 0;
      if (monthSpend(tx as unknown as Db, now).spent + held + entry.estimateGbp > config.AI_MONTHLY_CAP_GBP) {
        return { ok: false as const, reason: "budget" as const, message: AI_BUDGET_TEXT };
      }
      const row = tx.insert(aiReservation).values({ ts: now.toISOString(), feature: entry.feature, model: entry.model, estimateGbp: entry.estimateGbp }).returning({ id: aiReservation.id }).get();
      return { ok: true as const, id: row.id };
    },
    { behavior: "immediate" },
  );
}

/** Gives the money back without recording a cost: the call failed. */
export function release(db: Db, id: number): void {
  db.delete(aiReservation).where(eq(aiReservation.id, id)).run();
}

/** Swaps the hold for the real cost in one transaction, so the money is never counted twice and never missing. */
export function settle(db: Db, config: AiConfig, id: number, entry: { feature: string; model: string; usage: TokenUsage; now: Date }): number {
  return db.transaction((tx) => {
    tx.delete(aiReservation).where(eq(aiReservation.id, id)).run();
    return recordUsage(tx as unknown as Db, config, entry);
  });
}

export type AiGate = { ok: true } | { ok: false; reason: "off" | "budget"; message: string };

/** The single place that decides whether an AI call may be made. Checked before every call, including each step of a tool loop. */
export function aiGate(db: Db, config: AiConfig, now: Date): AiGate {
  if (!aiConfigured(config)) return { ok: false, reason: "off", message: AI_OFF_TEXT };
  if (monthSpend(db, now).spent + reservedGbp(db, now) >= config.AI_MONTHLY_CAP_GBP) return { ok: false, reason: "budget", message: AI_BUDGET_TEXT };
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
