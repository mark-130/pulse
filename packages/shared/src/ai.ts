import { z } from "zod";

export const AI_OFF_TEXT = "AI is off";
export const AI_BUDGET_TEXT = "Monthly AI budget reached";
export const HEALTH_NOTE = "If you are ill, in pain or injured, rest and see a doctor or physio. This is not medical advice.";

export const verdictStateSchema = z.enum(["go", "easier", "swap", "rest", "unknown"]);
export type VerdictState = z.infer<typeof verdictStateSchema>;

export const VERDICT_LABELS: Record<VerdictState, string> = {
  go: "Go as planned",
  easier: "Go but easier",
  swap: "Swap for recovery",
  rest: "Rest",
  unknown: "No verdict",
};

export const signalSchema = z.object({
  name: z.enum(["readiness", "sleep", "hrv", "restingHr", "bodyBattery", "load"]),
  status: z.enum(["ok", "caution", "poor", "unknown"]),
  /** One plain line citing the number and its date. */
  text: z.string(),
});
export type Signal = z.infer<typeof signalSchema>;

/** Computed in code from docs/TRAINING.md. The AI never decides it. */
export const verdictSchema = z.object({
  state: verdictStateSchema,
  label: z.string(),
  /** Reasons that cite numbers and dates, most important first. */
  reasons: z.array(z.string()),
  signals: z.array(signalSchema),
  points: z.number(),
  plannedWorkout: z.string().nullable(),
  healthNote: z.string(),
});
export type Verdict = z.infer<typeof verdictSchema>;

export const aiStateSchema = z.enum(["ok", "off", "budget"]);
export const aiStatusSchema = z.object({
  state: aiStateSchema,
  /** Plain text for off and budget states, else null. */
  message: z.string().nullable(),
  /** Set once spend reaches 80 percent of the cap. */
  notice: z.string().nullable(),
  month: z.object({
    label: z.string(),
    spentGbp: z.number(),
    capGbp: z.number(),
    percent: z.number(),
    calls: z.number(),
    byFeature: z.array(z.object({ feature: z.string(), calls: z.number(), costGbp: z.number() })),
  }),
  pricing: z.object({ checkedOn: z.string(), usdToGbp: z.number(), models: z.array(z.string()) }),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;

export const briefingSchema = z.object({
  date: z.string(),
  text: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  /** Data groups that were stale when it was written. */
  staleGroups: z.array(z.string()),
});
export type Briefing = z.infer<typeof briefingSchema>;

export const briefingResponseSchema = z.object({
  state: aiStateSchema,
  message: z.string().nullable(),
  briefing: briefingSchema.nullable(),
  /** True when a generation failed recently and will be retried later. */
  failed: z.boolean(),
});
export type BriefingResponse = z.infer<typeof briefingResponseSchema>;

export const chatMessageSchema = z.object({
  id: z.number(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  /** Tool names used for an assistant message, for transparency. */
  tools: z.array(z.string()),
  /** ai: written by the model. app: a fixed reply written in code, for example the illness and injury advice. */
  source: z.enum(["ai", "app"]),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatThreadSchema = z.object({
  thread: z.string(),
  state: aiStateSchema,
  message: z.string().nullable(),
  messages: z.array(chatMessageSchema),
});
export type ChatThread = z.infer<typeof chatThreadSchema>;

export const chatRequestSchema = z.object({
  thread: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).default("main"),
  message: z.string().min(1).max(2000),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const MAX_TOOL_CALLS = 8;
