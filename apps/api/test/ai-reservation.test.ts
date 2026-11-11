import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { aiReservation, aiUsage } from "../src/db/schema.js";
import { createLogger } from "../src/logger.js";
import { AiFailure, type LlmRequest } from "../src/modules/ai/llm.js";
import { costGbp } from "../src/modules/ai/pricing.js";
import { AiUnavailable, callModel, type AiRuntime } from "../src/modules/ai/runtime.js";
import { aiGate, estimateCostGbp, monthSpend, RESERVATION_STALE_MS, reservedGbp, reserve, type AiConfig } from "../src/modules/ai/usage.js";
import { text, usage } from "./ai-helpers.js";

const NOW = new Date("2026-11-09T10:00:00.000Z");
const req: LlmRequest = { model: "claude-sonnet-5-5", system: "You report facts.", messages: [{ role: "user", content: "How did I sleep?" }], maxTokens: 4000 };

function config(cap: number, key = "k"): AiConfig {
  return { ANTHROPIC_API_KEY: key, ANTHROPIC_MODEL_SMART: "claude-sonnet-5-5", ANTHROPIC_MODEL_FAST: "claude-haiku-5-5", AI_MONTHLY_CAP_GBP: cap, AI_USD_TO_GBP: 0.78, AI_PROPOSALS: "off", PULSE_GARMIN_WRITES: "off" };
}

function setup(cap: number, create: AiRuntime["llm"]) {
  const { db } = openDb(mkdtempSync(join(tmpdir(), "pulse-res-")));
  const rt: AiRuntime = { db, config: config(cap), llm: create, log: createLogger("silent"), now: () => NOW };
  return { db, rt };
}
const held = (db: ReturnType<typeof setup>["db"]) => db.select().from(aiReservation).all();
const estimate = estimateCostGbp(req.model, req, 0.78);

describe("atomic AI cost reservation (D57)", () => {
  it("concurrent calls cannot overspend the cap: only as many start as fit, the rest are refused", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = {
      async create() {
        started++;
        await gate; // every call is in flight before any finishes
        return text("ok", usage({ inputTokens: 100, outputTokens: 100 }));
      },
    };
    const fits = 3;
    const { db, rt } = setup(estimate * fits + estimate / 2, llm);
    const results = Promise.allSettled(Array.from({ length: 10 }, () => callModel(rt, "ask", req)));
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(fits);
    expect(held(db)).toHaveLength(fits);
    release();
    const settled = await results;
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(fits);
    const refused = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(refused).toHaveLength(10 - fits);
    for (const r of refused) expect(r.reason).toBeInstanceOf(AiUnavailable);
    expect(monthSpend(db, NOW).spent).toBeLessThanOrEqual(rt.config.AI_MONTHLY_CAP_GBP);
    expect(held(db)).toHaveLength(0);
  });

  it("the check and the hold are one step: two reserves for the last bit of money cannot both succeed", () => {
    const { db, rt } = setup(estimate * 1.5, null);
    const a = reserve(db, rt.config, NOW, { feature: "ask", model: req.model, estimateGbp: estimate });
    const b = reserve(db, rt.config, NOW, { feature: "ask", model: req.model, estimateGbp: estimate });
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, reason: "budget", message: "AI cap reached for this month" });
    // The gate sees money held by calls in flight too.
    expect(reservedGbp(db, NOW)).toBeCloseTo(estimate, 10);
  });

  it("a failed call releases its reservation and records no cost, so the money is free again", async () => {
    let n = 0;
    const llm = {
      async create() {
        n++;
        if (n === 1) throw new AiFailure("timeout", "Timed out after 60 seconds");
        return text("ok", usage({ inputTokens: 10, outputTokens: 10 }));
      },
    };
    const { db, rt } = setup(estimate * 1.5, llm);
    await expect(callModel(rt, "ask", req)).rejects.toBeInstanceOf(AiFailure);
    expect(held(db)).toHaveLength(0);
    expect(db.select().from(aiUsage).all()).toHaveLength(0);
    await expect(callModel(rt, "ask", req)).resolves.toBeDefined();
    expect(db.select().from(aiUsage).all()).toHaveLength(1);
  });

  it("a non AiFailure error also releases the reservation", async () => {
    const { db, rt } = setup(1, { create: async () => { throw new Error("socket hang up"); } });
    await expect(callModel(rt, "ask", req)).rejects.toBeInstanceOf(AiFailure);
    expect(held(db)).toHaveLength(0);
  });

  it("success swaps the hold for the actual cost, not the estimate, in one step", async () => {
    const u = usage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 100 });
    const { db, rt } = setup(5, { create: async () => text("ok", u) });
    await callModel(rt, "ask", req);
    const rows = db.select().from(aiUsage).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costGbp).toBeCloseTo(costGbp(req.model, u, 0.78), 12);
    expect(rows[0]?.costGbp).toBeLessThan(estimate);
    expect(held(db)).toHaveLength(0);
    expect(monthSpend(db, NOW).spent).toBeCloseTo(rows[0]?.costGbp ?? -1, 12);
  });

  it("the estimate is a ceiling: a response using all of max_tokens never costs more than it", () => {
    // Every prompt token as a cache write (the dearest input rate) and every allowed output token used.
    const promptChars = req.system.length + JSON.stringify(req.messages).length;
    const worst = costGbp(req.model, { inputTokens: 0, outputTokens: req.maxTokens, cacheReadTokens: 0, cacheWriteTokens: Math.ceil(promptChars / 3) }, 0.78);
    expect(estimate).toBeGreaterThanOrEqual(worst);
  });

  it("a reservation left by a crash goes stale and stops blocking", () => {
    const { db, rt } = setup(estimate * 1.5, null);
    db.insert(aiReservation).values({ ts: new Date(NOW.getTime() - RESERVATION_STALE_MS - 1000).toISOString(), feature: "ask", model: req.model, estimateGbp: 100 }).run();
    expect(reservedGbp(db, NOW)).toBe(0);
    expect(aiGate(db, rt.config, NOW).ok).toBe(true);
    expect(reserve(db, rt.config, NOW, { feature: "ask", model: req.model, estimateGbp: estimate }).ok).toBe(true);
    expect(held(db)).toHaveLength(1);
  });

  it("with no key it is off and nothing is reserved", async () => {
    const { db, rt } = setup(5, null);
    rt.config = config(5, "");
    await expect(callModel(rt, "ask", req)).rejects.toMatchObject({ reason: "off" });
    expect(held(db)).toHaveLength(0);
  });

  it("a call refused for the cap makes no model call and holds nothing", async () => {
    let calls = 0;
    const { db, rt } = setup(estimate / 2, { create: async () => (calls++, text("never")) });
    await expect(callModel(rt, "ask", req)).rejects.toMatchObject({ reason: "budget" });
    expect(calls).toBe(0);
    expect(held(db)).toHaveLength(0);
  });
});

describe("London month boundary (PULSE-002, D66)", () => {
  const row = (db: ReturnType<typeof setup>["db"], ts: string, cost: number) =>
    db.insert(aiUsage).values({ ts, feature: "ask", model: "claude-sonnet-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costGbp: cost }).run();
  const spend = (db: ReturnType<typeof setup>["db"], iso: string) => monthSpend(db, new Date(iso)).spent;

  it("counts 00:30 BST on 1 April (23:30Z on 31 March) in April, not March", () => {
    const { db } = setup(5, null);
    row(db, "2026-03-31T23:30:00.000Z", 0.5);
    expect(spend(db, "2026-04-15T12:00:00Z")).toBeCloseTo(0.5);
    expect(spend(db, "2026-03-20T12:00:00Z")).toBe(0);
  });

  it("counts 00:30 GMT on 1 January (00:30Z) in January", () => {
    const { db } = setup(5, null);
    row(db, "2027-01-01T00:30:00.000Z", 0.25);
    expect(spend(db, "2027-01-10T12:00:00Z")).toBeCloseTo(0.25);
    expect(spend(db, "2026-12-20T12:00:00Z")).toBe(0);
  });

  it("puts the previous month's last records in that month and does not double count across the boundary", () => {
    const { db } = setup(5, null);
    row(db, "2026-03-31T22:59:59.000Z", 1); // 23:59:59 BST on 31 March
    row(db, "2026-03-31T23:00:00.000Z", 2); // 00:00 BST on 1 April
    row(db, "2026-04-30T22:59:59.000Z", 4); // 23:59:59 BST on 30 April
    row(db, "2026-04-30T23:00:00.000Z", 8); // 00:00 BST on 1 May
    expect(spend(db, "2026-03-15T12:00:00Z")).toBeCloseTo(1);
    expect(spend(db, "2026-04-15T12:00:00Z")).toBeCloseTo(6);
    expect(spend(db, "2026-05-15T12:00:00Z")).toBeCloseTo(8);
    const all = [1, 6, 8].reduce((a, b) => a + b, 0);
    expect(all).toBe(15);
  });

  it("the budget gate and reserve use the same London month total", () => {
    const { db, rt } = setup(1, null);
    row(db, "2026-03-31T23:30:00.000Z", 1); // April's, spent the whole £1 cap
    const april = new Date("2026-04-02T10:00:00Z");
    expect(aiGate(db, rt.config, april)).toMatchObject({ ok: false, reason: "budget" });
    expect(reserve(db, rt.config, april, { feature: "ask", model: req.model, estimateGbp: 0.001 })).toMatchObject({ ok: false, reason: "budget" });
    // The same row belongs to April, so March's gate is untouched by it.
    expect(aiGate(db, rt.config, new Date("2026-03-20T10:00:00Z"))).toEqual({ ok: true });
  });
});
