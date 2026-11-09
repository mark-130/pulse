import { z } from "zod";

export const AI_OFF_TEXT = "AI is off";
export const AI_BUDGET_TEXT = "AI cap reached for this month";
export const HEALTH_NOTE = "If you are ill, in pain or injured, rest and see a doctor or physio. This is not medical advice.";

export const readingsStateSchema = z.enum(["strong", "mixed", "low", "unknown"]);
export type ReadingsState = z.infer<typeof readingsStateSchema>;

/** Neutral labels for the day's readings. They describe the readings, never what to do (D48). */
export const READINGS_LABELS: Record<ReadingsState, string> = {
  strong: "Readings: strong",
  mixed: "Readings: mixed",
  low: "Readings: low",
  unknown: "Readings: not enough data",
};

export const signalSchema = z.object({
  name: z.enum(["readiness", "sleep", "hrv", "restingHr", "bodyBattery", "load"]),
  status: z.enum(["ok", "caution", "poor", "unknown"]),
  /** One plain line citing the number and its date. */
  text: z.string(),
});
export type Signal = z.infer<typeof signalSchema>;

/** Computed in code from docs/TRAINING.md. The AI never receives the label, only the readings. */
export const readingsSummarySchema = z.object({
  state: readingsStateSchema,
  label: z.string(),
  /** One factual line per reading: the figure, its date and the direction against its baseline or recent average. */
  lines: z.array(z.string()),
  signals: z.array(signalSchema),
  points: z.number(),
  /** The workout Garmin has scheduled today, if any. */
  scheduledToday: z.string().nullable(),
  healthNote: z.string(),
});
export type ReadingsSummary = z.infer<typeof readingsSummarySchema>;

/** Why an AI card could not be written. A plain reason, no secrets, at most a short sanitised line of provider text. */
export const aiFailureSchema = z.object({ reason: z.string(), label: z.string(), detail: z.string().nullable(), at: z.string() });
export type AiFailureInfo = z.infer<typeof aiFailureSchema>;

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
  /** AI_PROPOSALS. While off, Ask has no propose tools and no AI proposal can be created. */
  proposals: z.boolean(),
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
  failure: aiFailureSchema.nullable().default(null),
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

/** Weekly review, cached per week (Monday date) in ai_text. */
/** Lines worked out in code, never by the model: how many days of readings were used, what the schedule recording covers, and how runs were matched. */
export const reviewCoverageSchema = z.object({
  readingsLine: z.string(),
  scheduleNote: z.string().nullable(),
  runsLine: z.string().nullable(),
  matchingNote: z.string().nullable(),
});
export type ReviewCoverage = z.infer<typeof reviewCoverageSchema>;
export const reviewSchema = z.object({ week: z.string(), text: z.string(), generatedAt: z.string(), model: z.string(), coversUntil: z.string(), coverage: reviewCoverageSchema.nullable().default(null) });
export type Review = z.infer<typeof reviewSchema>;
export const reviewResponseSchema = z.object({
  state: aiStateSchema,
  message: z.string().nullable(),
  review: reviewSchema.nullable(),
  /** False for a week that has not started yet. */
  canWrite: z.boolean(),
  failed: z.boolean(),
  failure: aiFailureSchema.nullable().default(null),
});
export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

/** Post-run debrief, cached per activity id in ai_text. */
export const debriefSchema = z.object({ activityId: z.string(), text: z.string(), generatedAt: z.string(), model: z.string() });
export type Debrief = z.infer<typeof debriefSchema>;
export const debriefsResponseSchema = z.object({ state: aiStateSchema, message: z.string().nullable(), debriefs: z.record(z.string(), debriefSchema) });
export type DebriefsResponse = z.infer<typeof debriefsResponseSchema>;
export const debriefOneResponseSchema = z.object({ state: aiStateSchema, message: z.string().nullable(), debrief: debriefSchema.nullable(), failed: z.boolean(), failure: aiFailureSchema.nullable().default(null) });
export type DebriefOneResponse = z.infer<typeof debriefOneResponseSchema>;
