import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { GARMIN_READ_TOOLS, assertReadTool, isReadTool } from "../src/modules/garmin/client.js";
import { GARMIN_WRITE_TOOLS, assertWriteTool } from "../src/modules/proposals/executors/garmin.js";

const WRITE_TOOLS = [
  "schedule_workout", "reschedule_workout", "unschedule_workout", "schedule_workouts", "unschedule_workouts", "schedule_week",
  "upload_workout", "upload_workouts", "upload_course", "delete_workout", "delete_workouts", "delete_activity", "delete_course",
  "create_run_workout", "create_strength_workout", "push_workout_to_device", "set_heart_rate_zones", "add_weigh_in", "log_food", "set_activity_name", "request_reload",
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("Garmin access is read only except in the executor", () => {
  it("allowlist contains only get_ tools and none of the write tools", () => {
    for (const t of GARMIN_READ_TOOLS) expect(t.startsWith("get_")).toBe(true);
    for (const t of WRITE_TOOLS) expect(isReadTool(t)).toBe(false);
  });

  it("write tool names appear only in the Garmin executor file", () => {
    const files = sources(join(import.meta.dirname, "../src"));
    expect(files.length).toBeGreaterThan(10);
    const executor = files.filter((f) => f.endsWith(join("proposals", "executors", "garmin.ts")));
    expect(executor).toHaveLength(1);
    for (const f of files) {
      if (executor.includes(f)) continue;
      const text = readFileSync(f, "utf8");
      for (const t of WRITE_TOOLS) expect(text, `${t} in ${f}`).not.toContain(t);
    }
  });

  it("the executor names exactly two write tools and refuses every other tool", () => {
    expect([...GARMIN_WRITE_TOOLS]).toEqual(["reschedule_workout", "unschedule_workout"]);
    for (const t of WRITE_TOOLS.filter((x) => !GARMIN_WRITE_TOOLS.includes(x as never))) expect(() => assertWriteTool(t)).toThrow(/not on the write allowlist/);
    for (const t of GARMIN_READ_TOOLS) expect(() => assertWriteTool(t)).toThrow();
    expect(() => assertWriteTool("reschedule_workout")).not.toThrow();
  });

  it("schedule_workout is not built: it is on neither allowlist", () => {
    expect(isReadTool("schedule_workout")).toBe(false);
    expect(() => assertWriteTool("schedule_workout")).toThrow();
    const exec = readFileSync(join(import.meta.dirname, "../src/modules/proposals/executors/garmin.ts"), "utf8");
    expect(exec.match(/[^_a-z]schedule_workout/g)).toBeNull();
  });

  it("executors are imported only by the confirm route", () => {
    const root = join(import.meta.dirname, "../src");
    const offenders = sources(root).filter((f) => !f.endsWith(join("proposals", "confirm.ts")) && !f.includes(`${join("proposals", "executors")}`) && /from\s+["'][^"']*executors\//.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    const confirm = readFileSync(join(root, "modules/proposals/confirm.ts"), "utf8");
    expect(confirm).toMatch(/from "\.\/executors\/garmin\.js"/);
  });

  it("eslint rejects an executor import from anywhere else", async () => {
    const eslint = new ESLint({ cwd: join(import.meta.dirname, "../../..") });
    const code = 'import { executeGarminProposal } from "./modules/proposals/executors/garmin.js";\nexport const x = executeGarminProposal;\n';
    const bad = await eslint.lintText(code, { filePath: join(import.meta.dirname, "../src/rogue.ts") });
    expect(bad[0]?.messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);
    const ok = await eslint.lintText(code, { filePath: join(import.meta.dirname, "../src/modules/proposals/confirm.ts") });
    expect(ok[0]?.messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(false);
  });

  it("assertReadTool throws for write tools and passes for read tools", () => {
    for (const t of WRITE_TOOLS) expect(() => assertReadTool(t)).toThrow(/not on the read-only allowlist/);
    expect(() => assertReadTool("get_calendar_events")).not.toThrow();
  });
});
