import { asc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { briefingResponseSchema, debriefOneResponseSchema, reviewResponseSchema } from "@pulse/shared";
import { aiText, auditLog } from "../src/db/schema.js";
import { classify } from "../src/modules/ai/anthropic.js";
import { textFrom } from "../src/modules/ai/failure.js";
import { AiFailure, FAILURE_LABELS, type LlmResponse } from "../src/modules/ai/llm.js";
import { FAKE_KEY, mockLlm, text, usage } from "./ai-helpers.js";
import { TODAY } from "./fixtures.js";
import { makeGarminApp, req } from "./helpers.js";

const clock = () => new Date(`${TODAY}T12:30:00Z`);
async function setup(o: Parameters<typeof makeGarminApp>[0] = {}) {
  const t = await makeGarminApp({ clock, ...o, env: { ANTHROPIC_API_KEY: FAKE_KEY, ...o.env } });
  await t.post("/api/sync/garmin");
  const json = (path: string, body?: unknown) =>
    req(t.app, path, { method: "POST", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const failures = () => t.handle.db.select().from(auditLog).orderBy(asc(auditLog.id)).all().filter((a) => a.action === "ai.failed");
  return { t, json, failures };
}
const err = (status: number | null, message = "x", name = "Error") => {
  const e = new Error(message) as Error & { status?: number };
  Object.defineProperty(e, "constructor", { value: { name } });
  if (status !== null) e.status = status;
  return e;
};
const empty = (stop: LlmResponse["stopReason"], out = 600): LlmResponse => ({ content: [], stopReason: stop, usage: usage({ outputTokens: out }) });

describe("the cause of the review failure: thinking used the whole output budget", () => {
  it("review, briefing and debrief ask for low effort and an output limit with room for thinking", async () => {
    const llm = mockLlm(() => text("ok"));
    const s = await setup({ llm });
    await s.json("/api/review", { week: "2026-11-02" });
    await s.json("/api/briefing/generate");
    await s.json("/api/debrief", { id: "24996772536" });
    expect(llm.requests.length).toBe(3);
    for (const r of llm.requests) {
      expect(r.effort).toBe("low");
      expect(r.maxTokens).toBeGreaterThanOrEqual(2000);
    }
  });

  it("a reply that hit the output limit with no text is a failure that says so, and nothing is stored", async () => {
    const s = await setup({ llm: mockLlm(() => empty("max_tokens")) });
    const r = reviewResponseSchema.parse(await (await s.json("/api/review", { week: "2026-11-02" })).json());
    expect(r).toMatchObject({ review: null, failed: true, failure: { reason: "limit", label: FAILURE_LABELS.limit } });
    expect(r.failure?.detail).toBe("Stopped at 600 output tokens.");
    expect(s.t.handle.db.select().from(aiText).all()).toHaveLength(0);
  });

  it("text that was cut off at the limit is not stored either", () => {
    expect(() => textFrom({ ...text("A half sentence that"), stopReason: "max_tokens" })).toThrow(/Output limit reached/);
    expect(() => textFrom(empty("end_turn"))).toThrow(/Response could not be read/);
    expect(textFrom(text("Fine."))).toBe("Fine.");
  });
});

describe("plain reasons on every AI card, logged in the audit record", () => {
  it("classifies provider errors into plain reasons with no key and a short detail", () => {
    const key = "sk-ant-api03-SECRET-abcdefghijklmnopqrstuvwxyz";
    const cases: [unknown, string][] = [
      [err(404, `model: claude-x not found ${key}`), "model_not_found"],
      [err(429), "rate_limited"],
      [err(401, `bad key ${key}`), "auth"],
      [err(403), "auth"],
      [err(529), "overloaded"],
      [err(500, "boom"), "service"],
      [err(400, `max_tokens too large for model ${key}`), "rejected"],
      [err(null, "x", "APIConnectionTimeoutError"), "timeout"],
      [err(408), "timeout"],
      [err(null, "socket hang up"), "unknown"],
    ];
    for (const [e, reason] of cases) {
      const f = classify(e, key);
      expect(f.reason).toBe(reason);
      expect(f.label).toBe(FAILURE_LABELS[f.reason]);
      expect(f.message).not.toContain(key);
      expect(f.message).not.toContain("SECRET");
      expect((f.detail ?? "").length).toBeLessThanOrEqual(150);
    }
    expect(FAILURE_LABELS.timeout).toBe("Timed out after 60 seconds");
    expect(FAILURE_LABELS.model_not_found).toBe("Model not found");
    expect(FAILURE_LABELS.rate_limited).toBe("Rate limited");
    expect(FAILURE_LABELS.cap).toBe("Cap reached");
    expect(FAILURE_LABELS.unreadable).toBe("Response could not be read");
  });

  it("review: the reason is returned, logged in the audit record, shown again after a reload, and cleared by a good result", async () => {
    let fail = true;
    const llm = mockLlm(() => {
      if (fail) throw new AiFailure("model_not_found", "model: claude-x not found");
      return text("This week: fine.");
    });
    const s = await setup({ llm });
    const r = reviewResponseSchema.parse(await (await s.json("/api/review", { week: "2026-11-02" })).json());
    expect(r).toMatchObject({ failed: true, failure: { reason: "model_not_found", label: "Model not found", detail: "model: claude-x not found" } });
    const rows = s.failures();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "system", target: "review" });
    expect(JSON.parse(rows[0]?.result ?? "{}")).toMatchObject({ reason: "model_not_found", label: "Model not found" });
    const again = reviewResponseSchema.parse(await (await s.t.get("/api/review?week=2026-11-02")).json());
    expect(again.failure?.label).toBe("Model not found");
    fail = false;
    const ok = reviewResponseSchema.parse(await (await s.json("/api/review", { week: "2026-11-02" })).json());
    expect(ok).toMatchObject({ failed: false, failure: null, review: { text: "This week: fine." } });
    expect(reviewResponseSchema.parse(await (await s.t.get("/api/review?week=2026-11-02")).json()).failure).toBeNull();
  });

  it("debrief: a timeout says so and is recorded", async () => {
    const s = await setup({ llm: mockLlm(() => { throw new AiFailure("timeout"); }) });
    const r = debriefOneResponseSchema.parse(await (await s.json("/api/debrief", { id: "24996772536" })).json());
    expect(r).toMatchObject({ debrief: null, failed: true, failure: { reason: "timeout", label: "Timed out after 60 seconds" } });
    expect(s.failures().map((f) => f.target)).toEqual(["debrief"]);
  });

  it("briefing: the reason is in the response", async () => {
    const s = await setup({ llm: mockLlm(() => { throw new AiFailure("rate_limited"); }) });
    const r = briefingResponseSchema.parse(await (await s.json("/api/briefing/generate")).json());
    expect(r).toMatchObject({ briefing: null, failed: true, failure: { label: "Rate limited" } });
    expect(s.failures().map((f) => f.target)).toEqual(["briefing"]);
  });

  it("Ask: a plain error and the reason, with a 502", async () => {
    const s = await setup({ llm: mockLlm(() => { throw new AiFailure("model_not_found", "no such model"); }) });
    const res = await s.json("/api/chat", { thread: "main", message: "how did I sleep?" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; failure: { label: string; detail: string } };
    expect(body.error).toBe("Ask could not answer.");
    expect(body.failure).toMatchObject({ label: "Model not found", detail: "no such model" });
    expect(s.failures().map((f) => f.target)).toEqual(["ask"]);
  });

  it("the cap and AI off are not failures and are not recorded", async () => {
    const s = await setup({ llm: mockLlm(() => text("never")), env: { AI_MONTHLY_CAP_GBP: "0.0000001" } });
    s.t.handle.db.insert((await import("../src/db/schema.js")).aiUsage).values({ ts: `${TODAY}T08:00:00.000Z`, feature: "ask", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costGbp: 1 }).run();
    const r = reviewResponseSchema.parse(await (await s.json("/api/review", { week: "2026-11-02" })).json());
    expect(r).toMatchObject({ state: "budget", failed: false, failure: null });
    expect(s.failures()).toHaveLength(0);
  });

  it("an unknown error never leaks the key into the response, the audit record or the logs", async () => {
    const lines: string[] = [];
    const s = await setup({ llm: mockLlm(() => { throw new Error(`weird failure with ${FAKE_KEY} in it`); }), logDestination: { write: (l: string) => void lines.push(l) } });
    const res = await s.json("/api/review", { week: "2026-11-02" });
    const all = [await res.text(), JSON.stringify(s.failures()), ...lines].join("\n");
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain("TESTKEY");
    expect(s.failures()).toHaveLength(1);
  });
});
