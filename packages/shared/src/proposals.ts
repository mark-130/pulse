import { z } from "zod";

/**
 * Set to true only once the sync conflict probe result is written into docs/DECISIONS.md.
 * While false, the Move action says the plan app may revert the change.
 */
export const PROBE_RESULT_RECORDED = false;
export const PLAN_APP_NOTE = "The plan app may revert this.";

export const PROPOSAL_EXPIRY_HOURS = 24;
export const DRY_RUN_TEXT = "Dry run: nothing will be sent to Garmin";

export const proposalKindSchema = z.enum(["garmin.reschedule", "garmin.unschedule"]);
export type ProposalKind = z.infer<typeof proposalKindSchema>;
export const proposalStatusSchema = z.enum(["pending", "applied", "rejected", "expired", "stale", "failed"]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

/** The workout as Garmin shows it. Dates only: workout content is never edited. */
export const workoutStateSchema = z.object({
  scheduledId: z.string(),
  name: z.string(),
  date: z.string(),
  durationS: z.number().nullable(),
  completed: z.boolean(),
});
export type WorkoutState = z.infer<typeof workoutStateSchema>;

/** How long a live change is watched after it is applied. The plan app pushes in batches, so two syncs are not enough (D34). */
export const VERIFY_WINDOW_HOURS = 72;

export const verificationSchema = z.object({
  /** waiting: the window is open and every check so far matched. verified: the window closed with the expected state still in place. reverted: the date went back, checking stopped. */
  state: z.enum(["waiting", "verified", "reverted"]),
  /** Checks that matched. */
  matches: z.number(),
  /** The most recent checks only. Every check is in the audit log. */
  checks: z.array(z.object({ at: z.string(), seen: z.string() })),
  /** When a sync last saw the expected state. */
  lastConfirmedAt: z.string().nullable().optional(),
  /** When the watching window closes. */
  windowEndsAt: z.string().optional(),
});
export type Verification = z.infer<typeof verificationSchema>;

export const proposalResultSchema = z
  .object({
    mode: z.enum(["live", "dry_run"]).optional(),
    message: z.string().optional(),
    error: z.string().optional(),
    /** Present when stale: the workout as Garmin has it now, or null if it is gone. */
    live: workoutStateSchema.nullable().optional(),
    verification: verificationSchema.optional(),
  })
  .nullable();

export const proposalSchema = z.object({
  id: z.string(),
  kind: proposalKindSchema,
  targetSystem: z.literal("garmin"),
  status: proposalStatusSchema,
  createdBy: z.enum(["user", "ai"]),
  rationale: z.string().nullable(),
  before: workoutStateSchema,
  /** The workout after the change. Null when the change removes it from the schedule. */
  after: workoutStateSchema.nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  result: proposalResultSchema,
});
export type Proposal = z.infer<typeof proposalSchema>;

export const proposalsResponseSchema = z.object({
  writesEnabled: z.boolean(),
  probeRecorded: z.boolean(),
  pending: z.array(proposalSchema),
  history: z.array(proposalSchema),
});
export type ProposalsResponse = z.infer<typeof proposalsResponseSchema>;

/** Manual creators. They only create a proposal, they never write to Garmin. */
export const createProposalRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("garmin.reschedule"), scheduledId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ kind: z.literal("garmin.unschedule"), scheduledId: z.string().min(1) }),
]);
export type CreateProposalRequest = z.infer<typeof createProposalRequestSchema>;

export const confirmResponseSchema = z.object({ proposal: proposalSchema });
export type ConfirmResponse = z.infer<typeof confirmResponseSchema>;
