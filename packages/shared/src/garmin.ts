import { z } from "zod";

/** Response shapes for the read-only Garmin views. Validated on the API and in the browser. */

export const workoutItemSchema = z.object({
  scheduledId: z.string(),
  date: z.string(),
  name: z.string(),
  sport: z.string().nullable(),
  durationS: z.number().nullable(),
  completed: z.boolean(),
});
export type WorkoutItem = z.infer<typeof workoutItemSchema>;

export const activityItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  startLocal: z.string(),
  date: z.string(),
  distanceM: z.number().nullable(),
  durationS: z.number().nullable(),
  avgHr: z.number().nullable(),
  maxHr: z.number().nullable(),
  calories: z.number().nullable(),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const raceItemSchema = z.object({
  eventKey: z.string(),
  eventUuid: z.string().nullable(),
  title: z.string(),
  date: z.string(),
  startTimeLocal: z.string().nullable(),
  timeZone: z.string().nullable(),
  distanceM: z.number().nullable(),
  goalTimeSeconds: z.number().nullable(),
  isRace: z.boolean(),
  primaryEvent: z.boolean(),
  subscribed: z.boolean(),
  location: z.string().nullable(),
  url: z.string().nullable(),
  daysUntil: z.number(),
});
export type RaceItem = z.infer<typeof raceItemSchema>;

export const jobStatusSchema = z.object({
  lastOk: z.string().nullable(),
  lastAttempt: z.string().nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number(),
  detail: z.string().nullable(),
  ageMinutes: z.number().nullable(),
  stale: z.boolean(),
});
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Garmin data is synced per kind. Kinds are grouped by the screens that need them. */
export const GARMIN_GROUPS = [
  { id: "plan", label: "the plan", plural: false, critical: true, tasks: ["scheduled_workouts", "calendar_events"] },
  { id: "readiness", label: "readiness", plural: false, critical: true, tasks: ["stats", "training_readiness", "sleep", "hrv", "rhr", "body_battery"] },
  { id: "activities", label: "activities", plural: true, critical: false, tasks: ["activities"] },
  { id: "trends", label: "trends", plural: true, critical: false, tasks: ["training_status", "training_load_balance", "training_load_trend", "vo2max_trend", "endurance_score", "race_predictions"] },
] as const;
export type GarminGroupId = (typeof GARMIN_GROUPS)[number]["id"];

export const groupStatusSchema = z.object({
  id: z.enum(["plan", "readiness", "activities", "trends"]),
  label: z.string(),
  plural: z.boolean(),
  /** Readiness and plan groups. Stale ones show the full banner. */
  critical: z.boolean(),
  /** Oldest successful fetch among the kinds in the group, null if any kind has never succeeded. */
  lastOk: z.string().nullable(),
  ageMinutes: z.number().nullable(),
  stale: z.boolean(),
  lastError: z.string().nullable(),
});
export type GroupStatus = z.infer<typeof groupStatusSchema>;

export const syncStatusSchema = z.object({
  now: z.string(),
  staleAfterMinutes: z.number(),
  /** lastOk, ageMinutes and stale describe the oldest critical group (plan, readiness). */
  garmin: jobStatusSchema,
  groups: z.array(groupStatusSchema),
  /** False when ntfy is not configured, so failures show only in the app. */
  alertsEnabled: z.boolean(),
  backup: jobStatusSchema,
});
export type SyncStatus = z.infer<typeof syncStatusSchema>;

export const readinessSchema = z.object({
  date: z.string(),
  score: z.number().nullable(),
  level: z.string().nullable(),
  feedback: z.string().nullable(),
  sleepScore: z.number().nullable(),
  recoveryTimeHours: z.number().nullable(),
  acuteLoad: z.number().nullable(),
});
export type Readiness = z.infer<typeof readinessSchema>;

export const todayMetricsSchema = z.object({
  sleep: z.object({ date: z.string(), score: z.number().nullable(), hours: z.number().nullable(), qualifier: z.string().nullable() }).nullable(),
  hrv: z
    .object({
      date: z.string(),
      lastNightAvg: z.number().nullable(),
      weeklyAvg: z.number().nullable(),
      baselineLow: z.number().nullable(),
      baselineUpper: z.number().nullable(),
      status: z.string().nullable(),
    })
    .nullable(),
  restingHr: z.object({ date: z.string(), bpm: z.number().nullable(), sevenDayAvg: z.number().nullable() }).nullable(),
  bodyBattery: z
    .object({
      date: z.string(),
      current: z.number().nullable(),
      highest: z.number().nullable(),
      lowest: z.number().nullable(),
      charged: z.number().nullable(),
      drained: z.number().nullable(),
    })
    .nullable(),
});
export type TodayMetrics = z.infer<typeof todayMetricsSchema>;

export const todayResponseSchema = z.object({
  date: z.string(),
  syncedAt: z.string().nullable(),
  readiness: readinessSchema.nullable(),
  session: z.object({
    today: z.array(workoutItemSchema),
    next: workoutItemSchema.nullable(),
    activitiesToday: z.array(activityItemSchema),
  }),
  metrics: todayMetricsSchema,
  nextRace: raceItemSchema.nullable(),
  followingRace: raceItemSchema.nullable(),
});
export type TodayResponse = z.infer<typeof todayResponseSchema>;

export const weekResponseSchema = z.object({
  start: z.string(),
  end: z.string(),
  today: z.string(),
  syncedAt: z.string().nullable(),
  days: z.array(z.object({ date: z.string(), workouts: z.array(workoutItemSchema), activities: z.array(activityItemSchema) })),
  totals: z.object({ distanceM: z.number(), durationS: z.number(), runs: z.number() }),
});
export type WeekResponse = z.infer<typeof weekResponseSchema>;

export const trendsResponseSchema = z.object({
  syncedAt: z.string().nullable(),
  trainingLoad: z.array(z.object({ date: z.string(), atl: z.number().nullable(), ctl: z.number().nullable(), acwr: z.number().nullable() })),
  vo2max: z.array(z.object({ date: z.string(), value: z.number() })),
  endurance: z
    .object({
      current: z.number().nullable(),
      classification: z.string().nullable(),
      weekly: z.array(z.object({ weekStart: z.string(), avg: z.number() })),
    })
    .nullable(),
  weeklyDistance: z.array(z.object({ weekStart: z.string(), distanceM: z.number(), runs: z.number() })),
  racePredictions: z.object({ date: z.string(), items: z.array(z.object({ label: z.string(), seconds: z.number() })) }).nullable(),
});
export type TrendsResponse = z.infer<typeof trendsResponseSchema>;

export const racesResponseSchema = z.object({ syncedAt: z.string().nullable(), races: z.array(raceItemSchema) });
export type RacesResponse = z.infer<typeof racesResponseSchema>;
