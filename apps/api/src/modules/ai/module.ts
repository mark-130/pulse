import type { Hono } from "hono";
import { AI_BUDGET_TEXT, AI_OFF_TEXT, chatRequestSchema, type BriefingResponse, type ChatThread, type Module } from "@pulse/shared";
import { generateBriefing, getBriefing } from "./briefing.js";
import { ask, getThread } from "./chat.js";
import { AiUnavailable, type AiRuntime } from "./runtime.js";
import { aiGate, aiStatus } from "./usage.js";
import { mentionsHealthConcern } from "./verdict.js";

const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

/** AI routes. Reads and the AI features only. No write-shaped tool exists in Phase 4a. */
export function createAiModule(rt: AiRuntime): { module: Module<Hono>; generateIfMissing: () => Promise<void> } {
  let lastFailure = 0;
  let inflight: Promise<unknown> | null = null;
  const busyThreads = new Set<string>();

  const briefingState = (failed = false): BriefingResponse => {
    const gate = aiGate(rt.db, rt.config, rt.now());
    const b = getBriefing(rt);
    return { state: gate.ok ? "ok" : gate.reason, message: gate.ok ? null : gate.message, briefing: b, failed: failed || (!b && rt.now().getTime() - lastFailure < RETRY_AFTER_FAILURE_MS) };
  };

  /** One generation at a time, and not again within ten minutes of a failure. */
  async function generate(): Promise<BriefingResponse> {
    if (getBriefing(rt)) return briefingState();
    const gate = aiGate(rt.db, rt.config, rt.now());
    if (!gate.ok) return briefingState();
    if (rt.now().getTime() - lastFailure < RETRY_AFTER_FAILURE_MS) return briefingState();
    if (!inflight) {
      inflight = generateBriefing(rt)
        .catch((err: unknown) => {
          if (!(err instanceof AiUnavailable)) lastFailure = rt.now().getTime();
        })
        .finally(() => void (inflight = null));
    }
    await inflight;
    return briefingState();
  }

  const module: Module<Hono> = {
    name: "ai",
    routes: (app) => {
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
          return c.json({ error: err instanceof Error ? err.message : "The AI service failed." }, 502);
        } finally {
          busyThreads.delete(thread);
        }
      });
    },
    jobs: [{ name: "briefing", schedule: "30 6 * * *", run: async () => void (await generate()) }],
  };
  return { module, generateIfMissing: async () => void (await generate()) };
}
