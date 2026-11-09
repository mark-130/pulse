import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { READINGS_LABELS } from "@pulse/shared";
import { BRIEFING_TASK, DEBRIEF_TASK, SYSTEM_PROMPT, SYSTEM_PROMPT_PROPOSALS, WEEKLY_REVIEW_TASK } from "../src/modules/ai/prompts.js";
import { ASK_TOOLS, runTool } from "../src/modules/ai/tools.js";
import { COACH_NOTE } from "../src/modules/ai/coaching.js";
import { FAKE_KEY, mockLlm, text } from "./ai-helpers.js";
import { TODAY } from "./fixtures.js";
import { makeGarminApp } from "./helpers.js";

/** The four old outputs (D48). None of them may appear anywhere a person or the model can read. */
const OLD_LABELS = ["Go as planned", "Go but easier", "Swap for recovery", "No verdict", "Today's verdict"];
const OLD_WORD = /\bverdict\b/i;
const OLD_BARE_REST = /["'>`]Rest["'<`]/; // the old bottom label on its own

const walk = (d: string, exts: RegExp): string[] => readdirSync(d).flatMap((f) => (f === "node_modules" || f === "dist" ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f), exts) : exts.test(f) && !/\.test\./.test(f) ? [join(d, f)] : []));
const root = join(import.meta.dirname, "../../..");

describe("the old verdict labels are gone (D48)", () => {
  it("the three labels are neutral readings labels, and the bottom two old outcomes share one", () => {
    expect(READINGS_LABELS).toEqual({ strong: "Readings: strong", mixed: "Readings: mixed", low: "Readings: low", unknown: "Readings: not enough data" });
  });

  it("no UI string, source file, or shared schema contains an old label, the word verdict, or a bare Rest label", () => {
    const files = [...walk(join(root, "apps/web/src"), /\.(tsx?|css)$/), ...walk(join(root, "apps/api/src"), /\.ts$/), ...walk(join(root, "packages/shared/src"), /\.ts$/)];
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const label of OLD_LABELS) expect(src, `${label} in ${f}`).not.toContain(label);
      expect(src, `verdict in ${f}`).not.toMatch(OLD_WORD);
      expect(src, `bare Rest in ${f}`).not.toMatch(OLD_BARE_REST);
    }
  });

  it("no prompt, tool description or note the model can see has an old label", () => {
    const all = [SYSTEM_PROMPT, SYSTEM_PROMPT_PROPOSALS, BRIEFING_TASK, WEEKLY_REVIEW_TASK, DEBRIEF_TASK, COACH_NOTE, ...ASK_TOOLS.map((t) => `${t.name} ${t.description}`)].join("\n");
    for (const label of OLD_LABELS) expect(all).not.toContain(label);
    expect(all).not.toMatch(OLD_WORD);
  });

  it("the model never receives the label: not in Ask tool results, not in the briefing context", async () => {
    const llm = mockLlm(() => text("Readiness 63 on 07/11."));
    const t = await makeGarminApp({ clock: () => new Date(`${TODAY}T12:30:00Z`), env: { ANTHROPIC_API_KEY: FAKE_KEY }, llm });
    await t.post("/api/sync/garmin");
    const now = new Date(`${TODAY}T12:30:00Z`);
    for (const [name, input] of [["get_today", {}], ["get_week", {}], ["list_races", {}], ["get_race_leadup", { race: "next" }], ["get_metrics", { metric: "training_load" }]] as const) {
      const out = runTool(name, input, { db: t.handle.db, now });
      expect(out, name).not.toMatch(/Readings: (strong|mixed|low|not enough data)/);
      for (const label of OLD_LABELS) expect(out, `${name} ${label}`).not.toContain(label);
      expect(out, name).not.toMatch(OLD_WORD);
    }
    expect(runTool("get_today", {}, { db: t.handle.db, now })).toContain('"readings"'); // the readings themselves are there
    await t.ai.generateIfMissing();
    const sent = String(llm.requests[0]?.messages[0]?.content);
    expect(sent).not.toMatch(/Readings: (strong|mixed|low|not enough data)/);
    for (const label of OLD_LABELS) expect(sent).not.toContain(label);
  });

  it("the Today response carries the new label and none of the old ones", async () => {
    const t = await makeGarminApp({ clock: () => new Date(`${TODAY}T12:30:00Z`) });
    await t.post("/api/sync/garmin");
    const body = await (await t.get("/api/today")).text();
    expect(body).toContain("Readings: mixed");
    for (const label of OLD_LABELS) expect(body).not.toContain(label);
    expect(body).not.toMatch(OLD_WORD);
  });
});
