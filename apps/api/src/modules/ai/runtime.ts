import type { Db } from "../../db/index.js";
import type { Logger } from "../../logger.js";
import { sanitiseError } from "../../notify.js";
import { AiFailure, type LlmClient, type LlmRequest, type LlmResponse } from "./llm.js";
import { aiGate, estimateCostGbp, release, reserve, settle, type AiConfig } from "./usage.js";

export interface AiRuntime {
  db: Db;
  config: AiConfig;
  /** Null when no key is set. AI is off. */
  llm: LlmClient | null;
  log: Logger;
  now: () => Date;
}

/** Thrown when AI may not be used right now. The message is the plain text shown to the user. */
export class AiUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: "off" | "budget",
  ) {
    super(message);
  }
}

export type AiFeature = "briefing" | "ask" | "review" | "debrief";

/**
 * Every model call goes through here. The gate (key present, monthly cap not reached) is checked first, then the worst
 * case cost is reserved atomically (D57), so calls running at the same time cannot overspend the cap. The reservation is
 * swapped for the real cost when the call returns, or released if it fails.
 */
export async function callModel(rt: AiRuntime, feature: AiFeature, req: LlmRequest): Promise<LlmResponse> {
  const gate = aiGate(rt.db, rt.config, rt.now());
  if (!gate.ok) throw new AiUnavailable(gate.message, gate.reason);
  if (!rt.llm) throw new AiUnavailable("AI is off", "off");
  const hold = reserve(rt.db, rt.config, rt.now(), { feature, model: req.model, estimateGbp: estimateCostGbp(req.model, req, rt.config.AI_USD_TO_GBP) });
  if (!hold.ok) throw new AiUnavailable(hold.message, hold.reason);
  let res: LlmResponse;
  try {
    res = await rt.llm.create(req);
  } catch (err) {
    // The hold is released and no cost is recorded. If Anthropic billed a call that then failed, that cost is not counted (D57).
    release(rt.db, hold.id);
    const failure = err instanceof AiFailure ? err : new AiFailure("unknown", sanitiseError(err).slice(0, 150));
    rt.log.warn({ feature, reason: failure.reason, detail: failure.detail }, "ai call failed");
    throw failure;
  }
  settle(rt.db, rt.config, hold.id, { feature, model: req.model, usage: res.usage, now: rt.now() });
  return res;
}
