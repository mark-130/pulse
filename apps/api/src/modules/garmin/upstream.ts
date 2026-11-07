import { z } from "zod";

/** Shapes of the Garmin MCP payloads we read. Fields we do not use are ignored. Checked in Phase 1 against live output. */
const num = z.number().nullish();
const str = z.string().nullish();

export const calendarEventSchema = z.object({
  title: z.string(),
  date: z.string(),
  is_race: z.boolean().nullish(),
  primary_event: z.boolean().nullish(),
  subscribed: z.boolean().nullish(),
  distance_meters: num,
  goal_time_seconds: num,
  start_time_local: str,
  time_zone: str,
  location: str,
  url: str,
  event_uuid: str,
});
export const calendarSchema = z.object({ events: z.array(calendarEventSchema) });

export const scheduledSchema = z.object({
  scheduled_workouts: z.array(
    z.object({
      date: z.string(),
      scheduled_workout_id: z.union([z.number(), z.string()]),
      workout_id: z.union([z.number(), z.string()]).nullish(),
      name: z.string(),
      sport: str,
      completed: z.boolean().nullish(),
      estimated_duration_seconds: num,
    }),
  ),
});

const readinessEntry = z.object({
  date: z.string(),
  timestamp: str,
  level: str,
  score: num,
  feedback: str,
  sleep_score: num,
  recovery_time_hours: num,
  acute_load: num,
});
export const readinessSchema = z.union([z.array(readinessEntry), readinessEntry]);

export const sleepSchema = z.object({ sleep_score: num, sleep_hours: num, sleep_score_qualifier: str });
export const hrvSchema = z.object({
  last_night_avg_hrv_ms: num,
  weekly_avg_hrv_ms: num,
  baseline_balanced_low_ms: num,
  baseline_balanced_upper_ms: num,
  status: str,
});
export const rhrSchema = z.object({
  allMetrics: z.object({ metricsMap: z.object({ WELLNESS_RESTING_HEART_RATE: z.array(z.object({ value: z.number().nullish() })).optional() }) }),
});
export const bodyBatterySchema = z.array(z.object({ date: z.string(), charged: num, drained: num }));
export const statsSchema = z.object({
  resting_heart_rate_bpm: num,
  last_7_days_avg_resting_hr: num,
  body_battery_current: num,
  body_battery_highest: num,
  body_battery_lowest: num,
  body_battery_charged: num,
  body_battery_drained: num,
});

export const trainingLoadTrendSchema = z.object({
  trend: z.array(z.object({ date: z.string(), atl: num, ctl: num, acwr: num })),
});
export const vo2Schema = z.object({ trend: z.array(z.object({ date: z.string(), vo2_max: z.number() })) });
export const enduranceSchema = z.object({
  current_score: num,
  classification: str,
  weekly_breakdown: z.array(z.object({ week_start: z.string(), avg_score: z.number() })),
});
export const racePredictionsSchema = z.object({
  prediction_date: z.string(),
  predictions: z.record(z.string(), z.object({ time_seconds: z.number() })),
});

export const activitiesSchema = z.object({
  has_more: z.boolean().nullish(),
  activities: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      name: z.string(),
      type: z.string(),
      start_time: z.string(),
      distance_meters: num,
      duration_seconds: num,
      avg_hr_bpm: num,
      max_hr_bpm: num,
      calories: num,
      elevation_gain_meters: num,
    }),
  ),
});

/** Training status and load balance are stored raw and read loosely. */
export const trainingStatusLoose = z.record(z.string(), z.unknown());
