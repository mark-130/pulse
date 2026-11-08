import { z } from "zod";
import type { Db } from "../../db/index.js";
// The only proposal code the AI module may touch: the engine's two creators, which only insert a pending proposal.
// Nothing here can confirm, execute or reach Garmin. A test scans this module's imports.
import { ProposalError, proposeReschedule, proposeUnschedule } from "../proposals/engine.js";
import type { LlmTool } from "./llm.js";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_PROPOSALS } from "./prompts.js";
import type { AiConfig } from "./usage.js";
import { cleanText, wrapData } from "./tools.js";

/** The write-shaped tools. Offered to the model only while AI_PROPOSALS is on. They create a proposal and nothing else. */
export const PROPOSAL_TOOLS: LlmTool[] = [
  {
    name: "propose_reschedule",
    description: "Propose moving one scheduled workout to another date. Only the date changes, never the workout itself. Only a request: it waits on the Proposals screen until Mark confirms, and nothing changes before that. scheduled_id comes from get_week. The date must be today or up to 14 days ahead.",
    input_schema: { type: "object", properties: { scheduled_id: { type: "string" }, date: { type: "string", description: "New date, YYYY-MM-DD." }, reason: { type: "string", description: "One short sentence for Mark." } }, required: ["scheduled_id", "date"] },
  },
  {
    name: "propose_unschedule",
    description: "Propose removing one scheduled workout from the Garmin schedule (the workout stays in the library). Only a request that waits for Mark's confirmation. scheduled_id comes from get_week.",
    input_schema: { type: "object", properties: { scheduled_id: { type: "string" }, reason: { type: "string", description: "One short sentence for Mark." } }, required: ["scheduled_id"] },
  },
];

export const PROPOSAL_TOOL_NAMES = PROPOSAL_TOOLS.map((t) => t.name);
export const isProposalTool = (name: string): boolean => PROPOSAL_TOOL_NAMES.includes(name);
/** Both flags must be on. With either off, no proposal is created (D43). */
export const proposalsOn = (c: Pick<AiConfig, "AI_PROPOSALS" | "PULSE_GARMIN_WRITES">): boolean => c.AI_PROPOSALS === "on" && c.PULSE_GARMIN_WRITES === "on";

const reschedArgs = z.object({ scheduled_id: z.string().min(1).max(40), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().max(300).optional() });
const unschedArgs = z.object({ scheduled_id: z.string().min(1).max(40), reason: z.string().max(300).optional() });

const NOTE = "Nothing has changed. Mark must confirm this on the Proposals screen first.";

/** Creates a pending proposal through the engine. With AI_PROPOSALS off it creates nothing, whatever the model asks. */
export function runProposalTool(name: string, input: unknown, ctx: { db: Db; now: Date; config: Pick<AiConfig, "AI_PROPOSALS" | "PULSE_GARMIN_WRITES"> }): string {
  if (!proposalsOn(ctx.config)) return wrapData(name, { created: false, error: "Proposals are switched off. Nothing was created." });
  try {
    if (name === "propose_reschedule") {
      const a = reschedArgs.parse(input);
      const p = proposeReschedule(ctx.db, a.scheduled_id, a.date, ctx.now, { createdBy: "ai", rationale: a.reason ? cleanText(a.reason) : null });
      return wrapData(name, { created: true, proposalId: p.id, status: p.status, note: NOTE });
    }
    if (name === "propose_unschedule") {
      const a = unschedArgs.parse(input);
      const p = proposeUnschedule(ctx.db, a.scheduled_id, ctx.now, { createdBy: "ai", rationale: a.reason ? cleanText(a.reason) : null });
      return wrapData(name, { created: true, proposalId: p.id, status: p.status, note: NOTE });
    }
    return wrapData(name, { created: false, error: "Unknown proposal tool." });
  } catch (err) {
    if (err instanceof ProposalError) return wrapData(name, { created: false, error: err.message });
    return wrapData(name, { created: false, error: err instanceof z.ZodError ? "Invalid tool input." : "The proposal could not be created." });
  }
}

/** The one system prompt for this deployment: the proposals variant only while both flags are on. */
export const systemFor = (c: Pick<AiConfig, "AI_PROPOSALS" | "PULSE_GARMIN_WRITES">): string => (proposalsOn(c) ? SYSTEM_PROMPT_PROPOSALS : SYSTEM_PROMPT);
