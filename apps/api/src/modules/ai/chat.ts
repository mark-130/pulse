import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { MAX_TOOL_CALLS, type ChatMessage, type ChatThread } from "@pulse/shared";
import { londonDate } from "../../dates.js";
import { chatMessage } from "../../db/schema.js";
import type { LlmBlock, LlmMessage, LlmUserBlock } from "./llm.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { callModel, type AiRuntime } from "./runtime.js";
import { ASK_TOOLS, runTool } from "./tools.js";
import { HEALTH_ADVICE, mentionsHealthConcern } from "./verdict.js";
import { aiGate } from "./usage.js";

const HISTORY_MESSAGES = 20;
const MAX_TOKENS = 1024;
const LIMIT_NOTE = "You have used all the tool calls allowed for this question. Answer now with what you have, and say plainly what is still missing.";

interface StoredMeta {
  tools?: string[];
  source?: "ai" | "app";
}

export function getThread(rt: AiRuntime, thread: string): ChatMessage[] {
  return rt.db
    .select()
    .from(chatMessage)
    .where(and(eq(chatMessage.thread, thread), inArray(chatMessage.role, ["user", "assistant"])))
    .orderBy(asc(chatMessage.id))
    .all()
    .map((r) => {
      const meta = (r.toolCalls ?? {}) as StoredMeta;
      return { id: r.id, role: r.role as "user" | "assistant", content: r.content, tools: meta.tools ?? [], source: r.role === "assistant" ? (meta.source ?? "ai") : "app" };
    });
}

function history(rt: AiRuntime, thread: string): LlmMessage[] {
  const rows = rt.db.select().from(chatMessage).where(and(eq(chatMessage.thread, thread), inArray(chatMessage.role, ["user", "assistant"]))).orderBy(desc(chatMessage.id)).limit(HISTORY_MESSAGES).all().reverse();
  return rows.map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

function store(rt: AiRuntime, thread: string, role: "user" | "assistant", content: string, meta?: StoredMeta) {
  rt.db.insert(chatMessage).values({ thread, role, content, toolCalls: meta ?? null }).run();
}

export interface AskOutcome {
  /** Tool calls actually executed, for tests and transparency. */
  toolCalls: string[];
  modelCalls: number;
}

/**
 * One question. The model may call the app's read tools, at most 8 times in total. The budget gate is checked
 * before every model call, so the cap holds in the middle of a tool loop too.
 */
export async function ask(rt: AiRuntime, threadId: string, userText: string): Promise<{ thread: ChatThread["messages"]; outcome: AskOutcome }> {
  const outcome: AskOutcome = { toolCalls: [], modelCalls: 0 };
  // Illness, pain and injury always get the same advice, in code. The verdict and the model are not consulted.
  if (mentionsHealthConcern(userText)) {
    store(rt, threadId, "user", userText);
    store(rt, threadId, "assistant", HEALTH_ADVICE, { tools: [], source: "app" });
    return { thread: getThread(rt, threadId), outcome };
  }
  const gate = aiGate(rt.db, rt.config, rt.now());
  if (!gate.ok) throw Object.assign(new Error(gate.message), { aiReason: gate.reason });

  const today = londonDate(rt.now());
  const messages: LlmMessage[] = [...history(rt, threadId), { role: "user", content: `[Today is ${today}, Europe/London.]\n${userText}` }];
  const model = rt.config.ANTHROPIC_MODEL_SMART;
  let finalText: string;

  for (;;) {
    const toolsAllowed = outcome.toolCalls.length < MAX_TOOL_CALLS;
    const res = await callModel(rt, "ask", { model, system: SYSTEM_PROMPT, messages, maxTokens: MAX_TOKENS, ...(toolsAllowed ? { tools: ASK_TOOLS } : {}) });
    outcome.modelCalls++;
    const uses = res.content.filter((b): b is Extract<LlmBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (uses.length === 0 || !toolsAllowed) {
      finalText = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      break;
    }
    messages.push({ role: "assistant", content: res.content });
    const results: LlmUserBlock[] = uses.map((u) => {
      if (outcome.toolCalls.length >= MAX_TOOL_CALLS) return { type: "tool_result", tool_use_id: u.id, content: "Tool limit reached. This call was not run." };
      outcome.toolCalls.push(u.name);
      return { type: "tool_result", tool_use_id: u.id, content: runTool(u.name, u.input, { db: rt.db, now: rt.now() }) };
    });
    if (outcome.toolCalls.length >= MAX_TOOL_CALLS) results.push({ type: "text", text: LIMIT_NOTE });
    messages.push({ role: "user", content: results });
  }

  if (!finalText) finalText = "I could not put an answer together from the data. Please try asking in a different way.";
  store(rt, threadId, "user", userText);
  store(rt, threadId, "assistant", finalText, { tools: outcome.toolCalls, source: "ai" });
  return { thread: getThread(rt, threadId), outcome };
}
