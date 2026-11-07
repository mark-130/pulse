import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  (t) => [index("garmin_snapshot_kind_date").on(t.kind, t.date)],
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

export const race = sqliteTable("race", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  googleEventId: text("google_event_id").notNull().unique(),
  garminMatch: text("garmin_match"),
  title: text("title").notNull(),
  date: text("date").notNull(),
  startTime: text("start_time"),
  distanceKm: real("distance_km"),
  priority: text("priority", { enum: ["A", "B", "C"] }),
  goalS: integer("goal_s"),
  type: text("type", { enum: ["road", "trail"] }),
  inferredFields: json<string[]>("inferred_fields"),
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
    ],
  }).notNull(),
  targetSystem: text("target_system", { enum: ["garmin", "google_calendar", "home_assistant"] }).notNull(),
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
  costGbp: text("cost_gbp").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json("value").notNull(),
});

export const secret = sqliteTable("secret", {
  name: text("name").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
});
