import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GARMIN_READ_TOOLS, assertReadTool, isReadTool } from "../src/modules/garmin/client.js";

const WRITE_TOOLS = [
  "schedule_workout", "reschedule_workout", "unschedule_workout", "schedule_workouts", "unschedule_workouts", "schedule_week",
  "upload_workout", "upload_workouts", "upload_course", "delete_workout", "delete_workouts", "delete_activity", "delete_course",
  "create_run_workout", "create_strength_workout", "push_workout_to_device", "add_weigh_in", "log_food", "set_activity_name", "request_reload",
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("Phase 1 is read only", () => {
  it("allowlist contains only get_ tools and none of the write tools", () => {
    for (const t of GARMIN_READ_TOOLS) expect(t.startsWith("get_")).toBe(true);
    for (const t of WRITE_TOOLS) expect(isReadTool(t)).toBe(false);
  });

  it("no write tool name appears anywhere in the API source", () => {
    const files = sources(join(import.meta.dirname, "../src"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const t of WRITE_TOOLS) expect(text, `${t} in ${f}`).not.toContain(t);
    }
  });

  it("assertReadTool throws for write tools and passes for read tools", () => {
    for (const t of WRITE_TOOLS) expect(() => assertReadTool(t)).toThrow(/not on the read-only allowlist/);
    expect(() => assertReadTool("get_calendar_events")).not.toThrow();
  });
});
