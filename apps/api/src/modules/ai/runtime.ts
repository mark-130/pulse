import type { Db } from "../../db/index.js";
import type { Logger } from "../../logger.js";
import { sanitiseError } from "../../notify.js";
import { AiCallError, type LlmClient, type LlmRequest, type LlmResponse } from "./llm.js";
import { aiGate, recordUsage, type AiConfig } from "./usage.js";

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

export type AiFeature = "briefing" | "ask";

/**
 * Every model call goes through here: the gate (key present, monthly cap not reached) is checked first,
 * and the usage row is written straight after, whatever the call returns.
 */
export async function callModel(rt: AiRuntime, feature: AiFeature, req: LlmRequest): Promise<LlmResponse> {
  const gate = aiGate(rt.db, rt.config, rt.now());
  if (!gate.ok) throw new AiUnavailable(gate.message, gate.reason);
  if (!rt.llm) throw new AiUnavailable("AI is off", "off");
  let res: LlmResponse;
  try {
    res = await rt.llm.create(req);
  } catch (err) {
    const message = err instanceof AiCallError ? err.message : sanitiseError(err);
    rt.log.warn({ feature, err: message }, "ai call failed");
    throw new AiCallError(message);
  }
  recordUsage(rt.db, rt.config, { feature, model: req.model, usage: res.usage, now: rt.now() });
  return res;
}
