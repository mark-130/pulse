import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const json = <T = unknown>(name: string) => text(name, { mode: "json" }).$type<T>();

export const garminSnapshot = sqliteTable(
  "garmin_snapshot",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    date: text("date").notNull(),
    payload: json("payload").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [uniqueIndex("garmin_snapshot_kind_date").on(t.kind, t.date)],
);

export const workout = sqliteTable("workout", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  garminScheduledId: text("garmin_scheduled_id").notNull().unique(),
  garminWorkoutId: text("garmin_workout_id"),
  date: text("date").notNull(),
  name: text("name").notNull(),
  sport: text("sport"),
  durationS: integer("duration_s"),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
});

/** Races from the Garmin calendar (get_calendar_events). See D22. Pulse-owned edits go in race_meta (Phase 2). */
export const race = sqliteTable("race", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** event_uuid when Garmin gives one, otherwise date plus normalised title. */
  eventKey: text("event_key").notNull().unique(),
  eventUuid: text("event_uuid"),
  title: text("title").notNull(),
  date: text("date").notNull(),
  startTimeLocal: text("start_time_local"),
  timeZone: text("time_zone"),
  distanceM: real("distance_m"),
  goalTimeSeconds: real("goal_time_seconds"),
  isRace: integer("is_race", { mode: "boolean" }).notNull(),
  primaryEvent: integer("primary_event", { mode: "boolean" }).notNull(),
  subscribed: integer("subscribed", { mode: "boolean" }).notNull(),
  location: text("location"),
  url: text("url"),
  /** False once Garmin stops returning an event inside the synced window. */
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
});

export const activity = sqliteTable("activity", {
  garminActivityId: text("garmin_activity_id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  /** Local start time as Garmin returns it, "YYYY-MM-DD HH:mm:ss". */
  startLocal: text("start_local").notNull(),
  date: text("date").notNull(),
  distanceM: real("distance_m"),
  durationS: real("duration_s"),
  avgHr: integer("avg_hr"),
  maxHr: integer("max_hr"),
  calories: integer("calories"),
  elevationGainM: real("elevation_gain_m"),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
});

export const proposal = sqliteTable("proposal", {
  id: text("id").primaryKey(),
  kind: text("kind", {
    enum: [
      "garmin.schedule",
      "garmin.reschedule",
      "garmin.unschedule",
      "calendar.create",
      "calendar.update",
      "calendar.tag_race",
      "ha.call_service",
      "app.update",
    ],
  }).notNull(),
  targetSystem: text("target_system", { enum: ["garmin", "google_calendar", "home_assistant", "app"] }).notNull(),
  payload: json("payload").notNull(),
  before: json("before"),
  after: json("after"),
  rationale: text("rationale"),
  createdBy: text("created_by", { enum: ["user", "ai"] }).notNull(),
  stateHash: text("state_hash").notNull(),
  status: text("status", { enum: ["pending", "applied", "rejected", "expired", "stale", "failed"] })
    .notNull()
    .default("pending"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"),
  result: json("result"),
});

/** Pulse-owned race metadata. Never overwritten by sync. meta_key matches race.event_key. See D29. */
export const raceMeta = sqliteTable("race_meta", {
  metaKey: text("meta_key").primaryKey(),
  priority: text("priority", { enum: ["A", "B", "C"] }),
  type: text("type", { enum: ["road", "trail"] }),
  goalOverrideS: real("goal_override_s"),
  notes: text("notes"),
  updatedAt: text("updated_at").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: text("ts").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  payloadHash: text("payload_hash").notNull(),
  result: text("result").notNull(),
});

export const syncState = sqliteTable("sync_state", {
  job: text("job").primaryKey(),
  lastOk: text("last_ok"),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastAttempt: text("last_attempt"),
  lastAlertAt: text("last_alert_at"),
  /** Non-fatal problems from the last run, for example optional data that failed to load. */
  detail: text("detail"),
});

export const briefing = sqliteTable("briefing", {
  date: text("date").primaryKey(),
  text: text("text").notNull(),
  data: json("data"),
  model: text("model"),
  tokens: integer("tokens"),
});

export const chatMessage = sqliteTable("chat_message", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  thread: text("thread").notNull(),
  role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
  content: text("content").notNull(),
  toolCalls: json("tool_calls"),
});

export const aiUsage = sqliteTable("ai_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: text("ts").notNull(),
  feature: text("feature").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  /** Tokens read from the prompt cache, and tokens written to it. Both are billed at their own rates. */
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costGbp: real("cost_gbp").notNull(),
});

/** Kotcha owns Mark's heart rate zones. This is only his manual copy: the TOP of each zone in bpm (D46). Covered by the nightly backup. */
export const kotchaZone = sqliteTable("kotcha_zone", {
  zone: integer("zone").primaryKey(),
  name: text("name").notNull(),
  topBpm: integer("top_bpm").notNull(),
  /** seed: starting values. manual: saved by Mark. */
  source: text("source", { enum: ["seed", "manual"] }).notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Each distinct set of Garmin heart rate zones, with the date the app first saw it, so a change date can be shown. */
export const hrZonesHistory = sqliteTable("hr_zones_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  firstSeen: text("first_seen").notNull(),
  profile: text("profile", { enum: ["RUNNING", "DEFAULT"] }).notNull(),
  method: text("method").notNull(),
  floors: json<number[]>("floors").notNull(),
  maxHr: integer("max_hr").notNull(),
  restingHr: integer("resting_hr"),
  lactateThresholdHr: integer("lactate_threshold_hr"),
});

/** Daily VO2 max points from Garmin. carried_forward marks a day Garmin filled with the last known value. */
export const vo2maxPoint = sqliteTable("vo2max_point", {
  date: text("date").primaryKey(),
  value: real("value").notNull(),
  carriedForward: integer("carried_forward", { mode: "boolean" }).notNull().default(false),
  fetchedAt: text("fetched_at").notNull(),
});

/** One row per day of Garmin's race predictions, written by the first successful sync of the day. Garmin cannot give past ones. */
export const racePrediction = sqliteTable("race_prediction", {
  date: text("date").primaryKey(),
  /** Seconds by distance key: 5K, 10K, half_marathon, marathon. */
  seconds: json<Record<string, number>>("seconds").notNull(),
  /** The date Garmin put on the prediction. */
  garminDate: text("garmin_date"),
  fetchedAt: text("fetched_at").notNull(),
});

/** Garmin's running personal records, with the day the app first saw each value so a new one can be tagged. */
export const personalRecord = sqliteTable("personal_record", {
  typeId: integer("type_id").primaryKey(),
  key: text("key").notNull(),
  recordType: text("record_type").notNull(),
  value: text("value").notNull(),
  rawValue: real("raw_value"),
  /** The date of the activity that set the record. */
  date: text("date").notNull(),
  /** The day the app first saw this record value. At the very first import it is the record's own date, so old records are not "new". */
  firstSeen: text("first_seen").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Generated AI text, cached so it is never rewritten unless Mark taps Refresh. kind: weekly_review (key week start) or debrief (key activity id). */
export const aiText = sqliteTable(
  "ai_text",
  {
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    text: text("text").notNull(),
    data: json("data"),
    model: text("model").notNull(),
    tokens: integer("tokens").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json("value").notNull(),
});

export const secret = sqliteTable("secret", {
  name: text("name").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
});
