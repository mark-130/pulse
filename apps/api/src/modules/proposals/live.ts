import type { WorkoutState } from "@pulse/shared";
import { addDays } from "../../dates.js";
import type { GarminConnector } from "../garmin/client.js";
import { scheduledSchema } from "../garmin/upstream.js";

/** Reads the workout as Garmin has it right now. Read only. Null means Garmin no longer lists it near that date. */
export async function fetchLiveWorkout(connect: GarminConnector, before: WorkoutState): Promise<WorkoutState | null> {
  const session = await connect();
  try {
    const res = await session.call("get_scheduled_workouts", { start_date: addDays(before.date, -14), end_date: addDays(before.date, 30) });
    if (res.kind === "message") {
      if (/^no\b/i.test(res.text.trim())) return null;
      throw new Error("Garmin did not return the schedule.");
    }
    const parsed = scheduledSchema.safeParse(res.data);
    if (!parsed.success) throw new Error("Garmin returned an unexpected schedule.");
    const w = parsed.data.scheduled_workouts.find((x) => String(x.scheduled_workout_id) === before.scheduledId);
    if (!w) return null;
    return {
      scheduledId: String(w.scheduled_workout_id),
      name: w.name,
      date: w.date,
      durationS: w.estimated_duration_seconds == null ? null : Math.round(w.estimated_duration_seconds),
      completed: w.completed ?? false,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}
