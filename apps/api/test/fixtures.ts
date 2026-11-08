import type { GarminConnector, GarminResult } from "../src/modules/garmin/client.js";

/** Synthetic payloads in the shape the live Garmin MCP server returned on 07/11/2026. */
export const TODAY = "2026-11-07";

export const calendarEvents = [
  { title: "Rhino Run West Bridgford", date: "2026-11-14", is_race: true, primary_event: false, subscribed: false, distance_meters: 10000, goal_time_seconds: 3000, start_time_local: "09:00", time_zone: "Europe/London", location: null, url: null, event_uuid: null },
  { title: "Pierrepont Plod Spring 27", date: "2027-03-14", is_race: false, primary_event: false, subscribed: false, distance_meters: 21100, goal_time_seconds: null, start_time_local: "09:00", time_zone: "Europe/London", location: null, url: null, event_uuid: null },
  { title: "Brighton Marathon (Running-Marathon)", date: "2027-04-04", is_race: true, primary_event: false, subscribed: true, distance_meters: 42195, goal_time_seconds: null, start_time_local: "09:45", time_zone: "Europe/London", location: null, url: null, event_uuid: "549c1bbe-991c-492a-9511-e59aa0733386" },
  { title: "TCS Sydney Marathon", date: "2027-08-29", is_race: true, primary_event: false, subscribed: true, distance_meters: 42195, goal_time_seconds: null, start_time_local: "06:30", time_zone: "Australia/Sydney", location: null, url: null, event_uuid: "1b8fb0c9-89cd-4cc2-b849-d1efd804d499" },
  { title: "The Trek Antwerp Marathon (Half Marathon)", date: "2027-10-24", is_race: true, primary_event: false, subscribed: true, distance_meters: 21100, goal_time_seconds: null, start_time_local: "01:30", time_zone: "Europe/Paris", location: null, url: null, event_uuid: "b0c242ba-8350-4eeb-8185-e9b02f156cb4" },
];

export const scheduled = {
  count: 1,
  scheduled_workouts: [{ date: "2026-11-08", scheduled_workout_id: 1833019748, workout_id: 1754065869, name: "1h50 Long Run", sport: "running", completed: false, estimated_duration_seconds: 6600 }],
};

export const activities = {
  count: 3,
  has_more: false,
  activities: [
    { id: 24996772536, name: "Broxtowe - 50' Easy Run", type: "running", start_time: "2026-11-07 11:28:16", distance_meters: 7864.2, duration_seconds: 3004.7, calories: 580, avg_hr_bpm: 133, max_hr_bpm: 143, elevation_gain_meters: 16.7 },
    { id: 24990000001, name: "Broxtowe - 9x1'45 Intervals Run", type: "running", start_time: "2026-11-05 18:26:36", distance_meters: 9000, duration_seconds: 3600, calories: 700, avg_hr_bpm: 150, max_hr_bpm: 175, elevation_gain_meters: 30 },
    { id: 24980000002, name: "Strength", type: "strength_training", start_time: "2026-11-03 07:00:00", distance_meters: null, duration_seconds: 2400, calories: 200, avg_hr_bpm: 110, max_hr_bpm: 140, elevation_gain_meters: null },
  ],
};

const readinessEntry = (timestamp: string, score: number, level: string) => ({
  date: TODAY, timestamp, context: "X", level, score, feedback: "RECOVERY_IN_PROGRESS", sleep_score: 89, recovery_time_hours: 25.4, acute_load: 699,
});

export const payloads: Record<string, unknown> = {
  get_calendar_events: { count: calendarEvents.length, events: calendarEvents },
  get_scheduled_workouts: scheduled,
  get_activities_by_date: activities,
  get_training_readiness: [readinessEntry("2026-11-07T09:09:44.0", 75, "HIGH"), readinessEntry("2026-11-07T12:18:29.0", 63, "MODERATE")],
  get_morning_training_readiness: readinessEntry("2026-11-07T09:09:44.0", 75, "HIGH"),
  get_sleep_summary: { sleep_score: 89, sleep_hours: 10.98, sleep_score_qualifier: "GOOD" },
  get_hrv_data: { last_night_avg_hrv_ms: 45, weekly_avg_hrv_ms: 38, baseline_balanced_low_ms: 36, baseline_balanced_upper_ms: 41, status: "BALANCED" },
  get_rhr_day: { allMetrics: { metricsMap: { WELLNESS_RESTING_HEART_RATE: [{ value: 45, calendarDate: TODAY }] } } },
  get_body_battery: [{ date: TODAY, charged: 52, drained: 43 }],
  get_stats: { resting_heart_rate_bpm: 45, last_7_days_avg_resting_hr: 47, body_battery_current: 61, body_battery_highest: 100, body_battery_lowest: 52, body_battery_charged: 52, body_battery_drained: 43 },
  get_training_status: { training_status_feedback: "PRODUCTIVE_6" },
  get_training_load_balance: { feedback: "ANAEROBIC_SHORTAGE" },
  get_training_load_trend: { trend: [{ date: "2026-11-06", atl: 640, ctl: 430, acwr: 1.5 }, { date: "2026-11-07", atl: 699, ctl: 436, acwr: 1.6 }] },
  get_vo2max_trend: { trend: [{ date: "2026-09-01", vo2_max: 46.8 }, { date: "2026-10-09", vo2_max: 46.5, carried_forward: true }, { date: "2026-10-10", vo2_max: 46.5 }, { date: "2026-11-07", vo2_max: 45.7 }] },
  // The live DEFAULT profile on 08/11/2026: lactate threshold method, resting 47, lactate threshold 162, max 180.
  get_heart_rate_zones: [{ trainingMethod: "LACTATE_THRESHOLD", restingHeartRateUsed: 47, lactateThresholdHeartRateUsed: 162, zone1Floor: 103, zone2Floor: 130, zone3Floor: 144, zone4Floor: 151, zone5Floor: 158, maxHeartRateUsed: 180, restingHrAutoUpdateUsed: true, sport: "DEFAULT", changeState: "UNCHANGED" }],
  get_endurance_score: { current_score: 5730, current_date: "2026-11-08", classification: "trained", thresholds: { intermediate: 4900, trained: 5500, well_trained: 6100, expert: 6800, superior: 7400, elite: 8000 }, weekly_breakdown: [{ week_start: "2026-10-05", avg_score: 5770 }, { week_start: "2026-10-12", avg_score: 5755 }, { week_start: "2026-10-19", avg_score: 5740 }, { week_start: "2026-10-26", avg_score: 5735 }, { week_start: "2026-11-02", avg_score: 5731 }] },
  // Garmin on 08/11/2026: current predictions only, no date option.
  get_race_predictions: { prediction_date: TODAY, predictions: { "5K": { time: "24:50", time_seconds: 1490 }, "10K": { time: "52:17", time_seconds: 3137 }, half_marathon: { time: "1:57:40", time_seconds: 7060 }, marathon: { time: "4:22:21", time_seconds: 15741 } } },
  get_personal_record: [
    { record_type: "Fastest 1K", type_id: 1, value: "4:33", raw_value: 273.33099365234375, date: "2025-09-13", activity_id: 20369673274 },
    { record_type: "Fastest Mile", type_id: 2, value: "7:20", raw_value: 440.0369873046875, date: "2025-09-13", activity_id: 20369673274 },
    { record_type: "Fastest 5K", type_id: 3, value: "23:40", raw_value: 1420.5379638671875, date: "2025-09-13", activity_id: 20369673274 },
    { record_type: "Fastest 10K", type_id: 4, value: "54:12", raw_value: 3252.56298828125, date: "2025-09-12", activity_id: 20359731950 },
    { record_type: "Fastest Half Marathon", type_id: 5, value: "1:57:36", raw_value: 7056.4609375, date: "2025-09-28", activity_id: 20525102533 },
    { record_type: "Longest Run", type_id: 7, value: "22.48 km", raw_value: 22484.720703125, date: "2025-08-17", activity_id: 20085367585 },
    { record_type: "Longest Ride", type_id: 8, value: "8.48 km", raw_value: 8481.8095703125, date: "2026-05-10", activity_id: 22829176892 },
    { record_type: "Fastest 100K Cycling", type_id: 10, value: "1:58", raw_value: 118.76833333333333, date: "2026-05-17", activity_id: 22910682527 },
    { record_type: "Most Steps Day", type_id: 12, value: "59,271", raw_value: 59271.0, date: "2025-06-20" },
  ],
  get_hill_score: { latest_date: "2026-11-08", latest_overall_score: 36, latest_strength_score: 19, latest_endurance_score: 15, daily_scores: [{ date: "2026-11-08", overall: 36, strength: 19, endurance: 15 }, { date: "2026-10-10", overall: 37, strength: 21, endurance: 15 }] },
  get_lactate_threshold: { lactate_threshold_speed_mps: 3.1388801000000006, lactate_threshold_heart_rate_bpm: 162, speed_hr_date: "2026-11-04T19:58:05.191", is_stale: false },
};

export interface FakeOptions {
  overrides?: Record<string, unknown>;
  /** Tools that should throw, with the message. */
  fail?: Record<string, string>;
  /** Tools that answer with a plain message such as "No data found". */
  empty?: string[];
  /** Tools that answer with this plain text, as the live server does for upstream errors. */
  messages?: Record<string, string>;
}

export interface FakeGarmin {
  connect: GarminConnector;
  calls: { tool: string; args: Record<string, unknown> }[];
  connects: () => number;
}

export function fakeGarmin(opts: FakeOptions = {}): FakeGarmin {
  const calls: FakeGarmin["calls"] = [];
  let connects = 0;
  return {
    calls,
    connects: () => connects,
    connect: async () => {
      connects++;
      return {
        async call(tool, args): Promise<GarminResult> {
          calls.push({ tool, args });
          const failure = opts.fail?.[tool];
          if (failure) throw new Error(failure);
          const message = opts.messages?.[tool];
          if (message) return { kind: "message", text: message };
          if (opts.empty?.includes(tool)) return { kind: "message", text: "No data found" };
          return { kind: "json", data: opts.overrides?.[tool] ?? payloads[tool] };
        },
        async close() {},
      };
    },
  };
}
