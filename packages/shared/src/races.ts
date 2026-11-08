import { z } from "zod";

export const prioritySchema = z.enum(["A", "B", "C"]);
export type Priority = z.infer<typeof prioritySchema>;
export const raceTypeSchema = z.enum(["road", "trail"]);
export type RaceType = z.infer<typeof raceTypeSchema>;
/** Distance class used by the taper and cluster rules: 10K and under, half marathon up to 35 km, marathon and longer. */
export const raceClassSchema = z.enum(["10k", "half", "marathon"]);
export type RaceClass = z.infer<typeof raceClassSchema>;

export const raceFlagSchema = z.object({
  kind: z.enum(["unverified_time", "no_goal", "not_a_race", "start_unknown", "distance_inferred", "distance_unknown"]),
  text: z.string(),
});
export type RaceFlag = z.infer<typeof raceFlagSchema>;

export const raceViewSchema = z.object({
  eventKey: z.string(),
  title: z.string(),
  date: z.string(),
  startTimeLocal: z.string().nullable(),
  timeZone: z.string().nullable(),
  /** Garmin distance, or inferred from the title when Garmin has none (see distanceInferred). */
  distanceM: z.number().nullable(),
  distanceInferred: z.boolean(),
  /** Local override if set, otherwise the Garmin goal. */
  goalTimeSeconds: z.number().nullable(),
  isRace: z.boolean(),
  primaryEvent: z.boolean(),
  location: z.string().nullable(),
  url: z.string().nullable(),
  /** Negative once the race has happened. */
  daysUntil: z.number(),
  past: z.boolean(),
  priority: prioritySchema,
  type: raceTypeSchema,
  priorityInferred: z.boolean(),
  typeInferred: z.boolean(),
  /** True once both priority and type are set by Mark. */
  classified: z.boolean(),
  raceClass: raceClassSchema.nullable(),
  taper: z.object({
    days: z.number(),
    /** ISO date, null for C races and races with no known distance. */
    start: z.string().nullable(),
    /** One plain line on where the taper stands today. */
    status: z.string(),
    /** Advice only, not medical guidance. Null for C races. */
    advice: z.string().nullable(),
  }),
  recovery: z.object({
    days: z.number(),
    /** Last day of easy running only, null when there is no recovery window. */
    until: z.string().nullable(),
  }),
  flags: z.array(raceFlagSchema),
});
export type RaceView = z.infer<typeof raceViewSchema>;

export const raceWarningSchema = z.object({
  id: z.string(),
  kind: z.enum(["cluster", "recovery_clash", "taper_clash", "long_run"]),
  /** action asks Mark to decide something, info is for awareness. */
  severity: z.enum(["action", "info"]),
  raceKeys: z.array(z.string()),
  message: z.string(),
  /** True while more than one A race, or an unset priority, leaves the cluster undecided. */
  needsChoice: z.boolean(),
  /** Suggested taper start for each race involved, as if it were at least B. */
  taperStarts: z.array(z.object({ raceKey: z.string(), date: z.string().nullable() })),
});
export type RaceWarning = z.infer<typeof raceWarningSchema>;

export const racesResponseSchema = z.object({
  syncedAt: z.string().nullable(),
  today: z.string(),
  races: z.array(raceViewSchema),
  warnings: z.array(raceWarningSchema),
});
export type RacesResponse = z.infer<typeof racesResponseSchema>;

/** PUT body for local race metadata. null clears a field. Both null removes the row. */
export const raceMetaInputSchema = z.object({
  priority: prioritySchema.nullable(),
  type: raceTypeSchema.nullable(),
});
export type RaceMetaInput = z.infer<typeof raceMetaInputSchema>;

export const raceMetaResponseSchema = z.object({
  /** What was stored before this change, so the screen can offer an undo. */
  previous: raceMetaInputSchema,
  current: raceMetaInputSchema,
});
export type RaceMetaResponse = z.infer<typeof raceMetaResponseSchema>;
