import { and, eq, gte } from "drizzle-orm";
import type { RacesResponse } from "@pulse/shared";
import { londonDate } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { race, raceMeta, workout } from "../../db/schema.js";
import { lastGarminOk } from "../garmin/freshness.js";
import { buildRaces, type MetaInput } from "./logic.js";

export function loadMetas(db: Db): Map<string, MetaInput> {
  return new Map(db.select().from(raceMeta).all().map((m) => [m.metaKey, { priority: m.priority, type: m.type, goalOverrideS: m.goalOverrideS }]));
}

/** Reads the database only. Active races from the Garmin calendar with local metadata applied. */
export function getRaceView(db: Db, now: Date): RacesResponse {
  const today = londonDate(now);
  const rows = db.select().from(race).where(eq(race.active, true)).all();
  const workouts = db.select({ date: workout.date, durationS: workout.durationS }).from(workout).where(and(gte(workout.date, today))).all();
  const { races, warnings } = buildRaces(rows, loadMetas(db), workouts, today);
  return { syncedAt: lastGarminOk(db, ["plan"]), today, races, warnings };
}
