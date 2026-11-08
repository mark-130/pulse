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
  /**
   * Reference window from the docs/TRAINING.md defaults (D30). It only feeds the clash flags. It is never shown as, or
   * used to produce, a recommendation: training content belongs to Mark's coach (D42).
   */
  taper: z.object({
    days: z.number(),
    /** ISO date, null for C races and races with no known distance. */
    start: z.string().nullable(),
  }),
  /** Reference window for the clash flags only, see above. */
  recovery: z.object({
    days: z.number(),
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

/**
 * Race lead-up (D42, D43). What Garmin holds for the weeks before a race: facts only, read from the cache.
 * It never suggests, designs or critiques training, and it works with AI off.
 */
export const leadUpWeekSchema = z.object({
  weekStart: z.string(),
  weekEnd: z.string(),
  /** 0 is the race week, 1 the week before it, and so on. */
  weeksBefore: z.number(),
  /** Set when the week runs past what the app sees in Garmin (about 14 days ahead): the last day that is shown. */
  shownUntil: z.string().nullable(),
  scheduledCount: z.number(),
  scheduledMinutes: z.number(),
  /** The longest scheduled session in the week, or null if none. */
  longest: z.object({ date: z.string(), name: z.string(), minutes: z.number().nullable() }).nullable(),
  /** Days with nothing scheduled and nothing recorded, among the days Garmin shows. */
  restDays: z.number(),
  /** Scheduled sessions dated up to today, and how many of those Garmin marks completed. Null for a week that has not started. */
  scheduledSoFar: z.number().nullable(),
  completedSoFar: z.number().nullable(),
  sessions: z.array(z.object({ date: z.string(), name: z.string(), minutes: z.number().nullable(), completed: z.boolean() })),
});
export type LeadUpWeek = z.infer<typeof leadUpWeekSchema>;

import { leadUpPredictionSchema } from "./fitness.js";

export const leadUpSchema = z.object({
  raceKey: z.string(),
  title: z.string(),
  date: z.string(),
  past: z.boolean(),
  daysToGo: z.number(),
  priority: prioritySchema,
  prioritySet: z.boolean(),
  /** Up to 4 weeks ending with the race week, oldest first. Empty for a past race. */
  weeks: z.array(leadUpWeekSchema),
  /** Sessions scheduled in Garmin on race day itself. */
  raceDayWorkouts: z.array(z.object({ name: z.string(), minutes: z.number().nullable() })),
  /** Other races within the cluster window of this one (D30). */
  nearbyRaces: z.array(z.object({ title: z.string(), date: z.string(), daysApart: z.number() })),
  /** Factual flags: priority not set, start time unverified, a workout on race day, a race nearby, data quality. */
  flags: z.array(z.object({ kind: z.string(), text: z.string() })),
  /** Garmin's current prediction for this race's distance when it matches 5K, 10K, half marathon or marathon within 2 percent. A fact, not a target. */
  prediction: leadUpPredictionSchema.nullable().default(null),
  /** The clash warnings from the cluster, recovery, taper and long run rules that involve this race. */
  clashes: z.array(z.object({ id: z.string(), kind: z.string(), severity: z.enum(["action", "info"]), message: z.string() })),
});
export type LeadUp = z.infer<typeof leadUpSchema>;

export const leadUpResponseSchema = z.object({ leadUp: leadUpSchema, syncedAt: z.string().nullable() });
export type LeadUpResponse = z.infer<typeof leadUpResponseSchema>;
