import { and, eq, gte } from "drizzle-orm";
import type { LeadUp } from "@pulse/shared";
import type { RacesResponse } from "@pulse/shared";
import { addDays, londonDate, weekStart } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { activity, race, raceMeta, workout } from "../../db/schema.js";
import { lastGarminOk } from "../garmin/freshness.js";
import { buildRaces, type MetaInput } from "./logic.js";
import { buildLeadUp } from "./leadup.js";

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

/** The lead-up for one race, from the database only. Null if there is no such race. */
export function getLeadUp(db: Db, now: Date, raceKey: string): { leadUp: LeadUp; syncedAt: string | null } | null {
  const view = getRaceView(db, now);
  const r = view.races.find((x) => x.eventKey === raceKey);
  if (!r) return null;
  const since = addDays(weekStart(r.date), -28);
  const works = db.select({ date: workout.date, name: workout.name, durationS: workout.durationS, completed: workout.completed }).from(workout).where(gte(workout.date, since)).all();
  const acts = db.select({ date: activity.date }).from(activity).where(gte(activity.date, since)).all();
  return { leadUp: buildLeadUp(r, view.races, view.warnings, works, acts, view.today), syncedAt: view.syncedAt };
}
