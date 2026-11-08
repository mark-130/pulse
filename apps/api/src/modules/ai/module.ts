import type { Hono } from "hono";
import { z } from "zod";
import { AI_BUDGET_TEXT, AI_OFF_TEXT, chatRequestSchema, type BriefingResponse, type ChatThread, type DebriefOneResponse, type DebriefsResponse, type Module, type ReviewResponse } from "@pulse/shared";
import { weekStart } from "../../dates.js";
import { debriefNewRuns, generateDebrief, getDebrief } from "./debrief.js";
import { generateReview, getReview, thisWeek } from "./review.js";
import { generateBriefing, getBriefing } from "./briefing.js";
import { ask, getThread } from "./chat.js";
import { lastFailure, noteFailure, toInfo } from "./failure.js";
import type { AiFailure } from "./llm.js";
import { AiUnavailable, type AiRuntime } from "./runtime.js";
import { aiGate, aiStatus } from "./usage.js";
import { mentionsHealthConcern } from "./verdict.js";

const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

/** AI routes: briefing, Ask, weekly review and debriefs. The model never writes anything itself. Its only write-shaped tools create pending proposals, and only while AI_PROPOSALS is on. */
export function createAiModule(rt: AiRuntime): { module: Module<Hono>; generateIfMissing: () => Promise<void>; afterSync: () => Promise<void> } {
  let lastBriefingFailure = 0;
  let inflight: Promise<unknown> | null = null;
  const busyThreads = new Set<string>();

  const briefingState = (failed = false): BriefingResponse => {
    const gate = aiGate(rt.db, rt.config, rt.now());
    const b = getBriefing(rt);
    const isFailed = failed || (!b && rt.now().getTime() - lastBriefingFailure < RETRY_AFTER_FAILURE_MS);
    return { state: gate.ok ? "ok" : gate.reason, message: gate.ok ? null : gate.message, briefing: b, failed: isFailed, failure: !b && isFailed ? lastFailure(rt, "briefing") : null };
  };

  /** One generation at a time, and not again within ten minutes of a failure. */
  async function generate(): Promise<BriefingResponse> {
    if (getBriefing(rt)) return briefingState();
    const gate = aiGate(rt.db, rt.config, rt.now());
    if (!gate.ok) return briefingState();
    if (rt.now().getTime() - lastBriefingFailure < RETRY_AFTER_FAILURE_MS) return briefingState();
    if (!inflight) {
      inflight = generateBriefing(rt)
        .catch((err: unknown) => {
          if (noteFailure(rt, "briefing", err)) lastBriefingFailure = rt.now().getTime();
        })
        .finally(() => void (inflight = null));
    }
    await inflight;
    return briefingState();
  }

  /** One generation per key at a time. Returns the failure, with its reason logged to the audit record, or null. The cap and AI off are not failures. */
  const flights = new Map<string, Promise<AiFailure | null>>();
  function guarded(key: string, feature: "review" | "debrief", fn: () => Promise<unknown>): Promise<AiFailure | null> {
    let p = flights.get(key);
    if (!p) {
      p = fn()
        .then(() => null)
        .catch((err: unknown) => noteFailure(rt, feature, err))
        .finally(() => void flights.delete(key));
      flights.set(key, p);
    }
    return p;
  }
  const gateState = () => {
    const g = aiGate(rt.db, rt.config, rt.now());
    return { state: g.ok ? ("ok" as const) : g.reason, message: g.ok ? null : g.message, ok: g.ok };
  };

  const reviewBody = (ws: string, failure: AiFailure | null = null): ReviewResponse => {
    const g = gateState();
    const review = getReview(rt, ws);
    return { state: g.state, message: g.message, review, canWrite: ws <= thisWeek(rt), failed: failure !== null, failure: failure ? toInfo(failure, rt.now()) : review ? null : lastFailure(rt, "review") };
  };
  const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  let afterSyncRunning: Promise<void> | null = null;
  const afterSync = (): Promise<void> => {
    // New runs get a debrief automatically, a few at a time. Quiet when AI is off or the cap is reached.
    afterSyncRunning ??= debriefNewRuns(rt, (err) => void noteFailure(rt, "debrief", err))
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => void (afterSyncRunning = null));
    return afterSyncRunning;
  };

  const module: Module<Hono> = {
    name: "ai",
    routes: (app) => {
      // Weekly review, cached per week.
      app.get("/api/review", (c) => {
        const w = dateParam.safeParse(c.req.query("week") ?? thisWeek(rt));
        if (!w.success) return c.json({ error: "week must be YYYY-MM-DD" }, 400);
        return c.json(reviewBody(weekStart(w.data)));
      });
      app.post("/api/review", async (c) => {
        const b = z.object({ week: dateParam.optional(), refresh: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
        if (!b.success) return c.json({ error: "Expected a week (YYYY-MM-DD) and optionally refresh." }, 400);
        const ws = weekStart(b.data.week ?? thisWeek(rt));
        if (ws > thisWeek(rt)) return c.json({ error: "A week that has not started has no review." }, 400);
        if (!gateState().ok || (getReview(rt, ws) && !b.data.refresh)) return c.json(reviewBody(ws));
        const failure = await guarded(`review:${ws}`, "review", () => generateReview(rt, ws, b.data.refresh ?? false));
        return c.json(reviewBody(ws, failure));
      });

      // Post-run debriefs, cached by activity id.
      app.get("/api/debriefs", (c) => {
        const ids = (c.req.query("ids") ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 40);
        const g = gateState();
        const debriefs: DebriefsResponse["debriefs"] = {};
        for (const id of ids) {
          const d = getDebrief(rt, id);
          if (d) debriefs[id] = d;
        }
        const body: DebriefsResponse = { state: g.state, message: g.message, debriefs };
        return c.json(body);
      });
      app.post("/api/debrief", async (c) => {
        const b = z.object({ id: z.string().min(1).max(40), refresh: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
        if (!b.success) return c.json({ error: "Expected an activity id." }, 400);
        const g = gateState();
        const done = (failure: AiFailure | null = null): DebriefOneResponse => {
          const debrief = getDebrief(rt, b.data.id);
          return { state: gateState().state, message: gateState().message, debrief, failed: failure !== null, failure: failure ? toInfo(failure, rt.now()) : debrief ? null : lastFailure(rt, "debrief") };
        };
        if (!g.ok || (getDebrief(rt, b.data.id) && !b.data.refresh)) return c.json(done());
        const failure = await guarded(`debrief:${b.data.id}`, "debrief", () => generateDebrief(rt, b.data.id, b.data.refresh ?? false));
        return c.json(done(failure));
      });

      app.get("/api/ai/status", (c) => c.json(aiStatus(rt.db, rt.config, rt.now())));
      app.get("/api/briefing", (c) => c.json(briefingState()));
      // Generates today's briefing only if it is missing. One call, once a day.
      app.post("/api/briefing/generate", async (c) => c.json(await generate()));

      app.get("/api/chat", (c) => {
        const thread = (c.req.query("thread") ?? "main").slice(0, 64);
        const gate = aiGate(rt.db, rt.config, rt.now());
        const body: ChatThread = { thread, state: gate.ok ? "ok" : gate.reason, message: gate.ok ? null : gate.message, messages: getThread(rt, thread) };
        return c.json(body);
      });
      app.post("/api/chat", async (c) => {
        const body = chatRequestSchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "Send a message of up to 2000 characters." }, 400);
        const { thread, message } = body.data;
        const gate = aiGate(rt.db, rt.config, rt.now());
        // Illness, pain and injury questions are answered in code and need no AI, so only block the rest.
        if (!gate.ok && !mentionsHealthConcern(message)) {
          const out: ChatThread = { thread, state: gate.reason, message: gate.message, messages: getThread(rt, thread) };
          return c.json(out, 200);
        }
        if (busyThreads.has(thread)) return c.json({ error: "Still answering the last question." }, 409);
        busyThreads.add(thread);
        try {
          const { thread: messages } = await ask(rt, thread, message);
          const out: ChatThread = { thread, state: "ok", message: null, messages };
          return c.json(out);
        } catch (err) {
          const reason = typeof err === "object" && err !== null && "aiReason" in err ? (err as { aiReason: "off" | "budget" }).aiReason : err instanceof AiUnavailable ? err.reason : null;
          if (reason) {
            const out: ChatThread = { thread, state: reason, message: reason === "off" ? AI_OFF_TEXT : AI_BUDGET_TEXT, messages: getThread(rt, thread) };
            return c.json(out);
          }
          // The plain line is shown first and the reason goes under Details. Neither holds a key or a request body.
          const failure = noteFailure(rt, "ask", err);
          return c.json({ error: "Ask could not answer.", failure: failure ? toInfo(failure, rt.now()) : null }, 502);
        } finally {
          busyThreads.delete(thread);
        }
      });
    },
    jobs: [
      { name: "briefing", schedule: "30 6 * * *", run: async () => void (await generate()) },
      // Sunday evening: this week's review, if there is not one yet. Quiet when AI is off or the cap is reached.
      { name: "weekly-review", schedule: "0 19 * * 0", run: async () => void (await guarded(`review:${thisWeek(rt)}`, "review", () => generateReview(rt, thisWeek(rt)))) },
    ],
  };
  return { module, generateIfMissing: async () => void (await generate()), afterSync };
}
