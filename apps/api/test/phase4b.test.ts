import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiStatusSchema, debriefOneResponseSchema, debriefsResponseSchema, leadUpResponseSchema, proposalSchema, reviewResponseSchema, todayResponseSchema, type LeadUp } from "@pulse/shared";
import { activity, aiText, aiUsage, auditLog, garminSnapshot, proposal as proposalTable, workout } from "../src/db/schema.js";
import { COACH_NOTE, mentionsTrainingAdvice } from "../src/modules/ai/coaching.js";
import { PROPOSAL_TOOLS } from "../src/modules/ai/proposal-tools.js";
import { BRIEFING_TASK, DEBRIEF_TASK, SYSTEM_PROMPT, SYSTEM_PROMPT_PROPOSALS, WEEKLY_REVIEW_TASK } from "../src/modules/ai/prompts.js";
import { ASK_TOOLS, runTool } from "../src/modules/ai/tools.js";
import { buildRaces, type MetaInput, type RaceInput } from "../src/modules/races/logic.js";
import { buildLeadUp, type LeadActivity, type LeadWorkout } from "../src/modules/races/leadup.js";
import { FAKE_KEY, mockLlm, text, toolUse } from "./ai-helpers.js";
import { TODAY } from "./fixtures.js";
import { makeGarminApp, req } from "./helpers.js";

const RHINO = `2026-11-14|rhino run west bridgford`;

// ---------------------------------------------------------------- the race lead-up is facts from the cache
const race = (o: Partial<RaceInput> & Pick<RaceInput, "title" | "date">): RaceInput => ({
  eventKey: `${o.date}|${o.title}`, startTimeLocal: "09:00", timeZone: "Europe/London", distanceM: 10_000, goalTimeSeconds: 3000, isRace: true, primaryEvent: false, location: null, url: null, ...o,
});
const wk = (date: string, name: string, minutes: number, completed = false): LeadWorkout => ({ date, name, durationS: minutes * 60, completed });
const act = (date: string): LeadActivity => ({ date });

function leadFor(r: RaceInput, works: LeadWorkout[], acts: LeadActivity[], today: string, others: RaceInput[] = [], metas: [string, MetaInput][] = []): LeadUp {
  const { races, warnings } = buildRaces([r, ...others], new Map(metas), [], today);
  const view = races.find((x) => x.eventKey === r.eventKey)!;
  return buildLeadUp(view, races, warnings, works, acts, today);
}

describe("race lead-up, facts only", () => {
  const rhino = race({ title: "Rhino 10K", date: "2026-11-14" });
  const works = [wk("2026-11-03", "Easy", 40, true), wk("2026-11-05", "Tempo", 50), wk("2026-11-08", "1h50 Long Run", 110)];
  const acts = [act("2026-11-03"), act("2026-11-07")];

  it("counts what Garmin holds for each week: scheduled, minutes, the longest session, rest days, completed so far", () => {
    const l = leadFor(rhino, works, acts, TODAY);
    expect(l.daysToGo).toBe(7);
    expect(l.weeks.map((w) => w.weekStart)).toEqual(["2026-11-02", "2026-11-09"]); // earlier weeks have ended, so there is nothing to report
    expect(l.weeks[0]).toMatchObject({
      weeksBefore: 1, scheduledCount: 3, scheduledMinutes: 200, longest: { date: "2026-11-08", name: "1h50 Long Run", minutes: 110 },
      restDays: 3, scheduledSoFar: 2, completedSoFar: 1, shownUntil: null,
    });
    expect(l.weeks[1]).toMatchObject({ weeksBefore: 0, scheduledCount: 0, scheduledMinutes: 0, longest: null, restDays: 7, scheduledSoFar: null, completedSoFar: null });
  });

  it("carries no suggested number, target or advice anywhere in the data or the wording", () => {
    const l = leadFor(rhino, works, acts, TODAY, [], [[rhino.eventKey, { priority: "B", type: "road", goalOverrideS: null }]]);
    const json = JSON.stringify(l);
    expect(json).not.toMatch(/suggest|target|taper|recommend|should|advice|focus|coach/i);
  });

  it("says priority not set, but still shows the facts", () => {
    const l = leadFor(rhino, works, acts, TODAY);
    expect(l.prioritySet).toBe(false);
    expect(l.flags).toContainEqual({ kind: "priority_not_set", text: "Priority not set." });
    expect(l.weeks).toHaveLength(2);
    const set = leadFor(rhino, works, acts, TODAY, [], [[rhino.eventKey, { priority: "A", type: "road", goalOverrideS: null }]]);
    expect(set.prioritySet).toBe(true);
    expect(set.flags.map((f) => f.kind)).not.toContain("priority_not_set");
  });

  it("flags an unverified start, a workout on race day and another race inside the cluster window", () => {
    const half = race({ title: "Pierrepont Half", date: "2027-03-14", distanceM: 21_100, startTimeLocal: "01:30" });
    const marathon = race({ title: "Brighton Marathon", date: "2027-04-04", distanceM: 42_195 });
    const l = leadFor(half, [wk("2027-03-14", "Race day shakeout", 20)], [], "2027-03-08", [marathon]);
    const kinds = l.flags.map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["unverified_time", "nearby_race", "race_day_workout"]));
    expect(l.nearbyRaces).toEqual([{ title: "Brighton Marathon", date: "2027-04-04", daysApart: 21 }]);
    expect(l.raceDayWorkouts).toEqual([{ name: "Race day shakeout", minutes: 20 }]);
    expect(l.flags.find((f) => f.kind === "race_day_workout")?.text).toBe("A workout is scheduled in Garmin on race day: Race day shakeout, 20 min.");
    expect(l.clashes.map((c) => c.kind)).toContain("cluster");
  });

  it("a 10K and a 10K 10 days apart are not a cluster; a past race has no weeks; a far race has none yet", () => {
    const a = race({ title: "A 10K", date: "2026-11-14" });
    const b = race({ title: "B 10K", date: "2026-11-24" });
    expect(leadFor(a, [], [], TODAY, [b]).nearbyRaces).toEqual([]);
    expect(leadFor(race({ title: "Old", date: "2026-10-01" }), works, acts, TODAY).weeks).toEqual([]);
    const far = leadFor(race({ title: "Far half", date: "2027-05-01", distanceM: 21_100 }), [], [], TODAY);
    expect(far.weeks).toEqual([]);
    expect(far.daysToGo).toBeGreaterThan(100);
  });

  it("a week that runs past what Garmin shows says where the view ends", () => {
    const r = race({ title: "Half", date: "2026-11-29", distanceM: 21_100 });
    const l = leadFor(r, [], [], TODAY);
    expect(l.weeks.map((w) => w.weekStart)).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
    expect(l.weeks.at(-1)).toMatchObject({ weekStart: "2026-11-16", shownUntil: "2026-11-21" }); // 23/11 starts beyond the 14 days the app sees, so it is left out
  });
});

// ---------------------------------------------------------------- the app
const clock = () => new Date(`${TODAY}T12:30:00Z`);
async function setup(o: Parameters<typeof makeGarminApp>[0] = {}) {
  const t = await makeGarminApp({ clock, ...o, env: { ANTHROPIC_API_KEY: FAKE_KEY, ...o.env } });
  await t.post("/api/sync/garmin");
  const json = (path: string, body?: unknown, method = "POST") =>
    req(t.app, path, { method, headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const leadup = async (key = RHINO) => leadUpResponseSchema.parse(await (await t.get(`/api/leadup?race=${encodeURIComponent(key)}`)).json());
  const review = async (week?: string, refresh = false) => json("/api/review", { week, refresh });
  const chat = (message: string) => json("/api/chat", { thread: "main", message });
  const addUsage = (cost: number, feature = "ask") => t.handle.db.insert(aiUsage).values({ ts: `${TODAY}T08:00:00.000Z`, feature, model: "claude-sonnet-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costGbp: cost }).run();
  return { t, json, leadup, review, chat, addUsage };
}

describe("race lead-up in the app", () => {
  it("works with AI switched off, and at the cap, and never calls the model", async () => {
    const off = await setup({ env: { ANTHROPIC_API_KEY: "" } });
    const l = await off.leadup();
    expect(l.leadUp).toMatchObject({ raceKey: RHINO, daysToGo: 7, prioritySet: false });
    expect(l.leadUp.weeks.length).toBeGreaterThan(0);
    expect(l.leadUp.weeks.find((w) => w.weekStart === "2026-11-02")).toMatchObject({ scheduledCount: 1, longest: { name: "1h50 Long Run", minutes: 110 } });
    const llm = mockLlm(() => text("never"));
    const capped = await setup({ llm });
    capped.addUsage(5);
    expect((await capped.leadup()).leadUp.weeks.length).toBeGreaterThan(0);
    expect(llm.requests).toHaveLength(0);
    expect(todayResponseSchema.parse(await (await capped.t.get("/api/today")).json()).verdict.state).not.toBe("unknown");
  });

  it("404 for an unknown race, and needs a session", async () => {
    const s = await setup();
    expect((await s.t.get("/api/leadup?race=nope")).status).toBe(404);
    expect((await req(s.t.app, `/api/leadup?race=${encodeURIComponent(RHINO)}`)).status).toBe(401);
  });

  it("Ask sees the same facts, with Priority not set and no taper advice", async () => {
    const llm = mockLlm((_r, n) => (n === 1 ? toolUse("list_races", {}, "a") : n === 2 ? toolUse("get_race_leadup", { race: "rhino" }, "b") : text("ok")));
    const s = await setup({ llm });
    await s.chat("what is scheduled before the Rhino?");
    const results = JSON.stringify(llm.requests.at(-1)?.messages);
    expect(results).toContain("Priority not set");
    expect(results).toContain("scheduledCount");
    expect(results).not.toMatch(/taper|Final week at|advice/i);
  });
});

// ---------------------------------------------------------------- weekly review
describe("weekly review", () => {
  const WEEK = "2026-11-02";

  it("writes one review per week with the smart model, caches it, refreshes on request, and not for a future week", async () => {
    const llm = mockLlm(() => text("Load: 110 minutes against 110 scheduled."));
    const s = await setup({ llm });
    const r1 = reviewResponseSchema.parse(await (await s.review(WEEK)).json());
    expect(r1.review).toMatchObject({ week: WEEK, text: "Load: 110 minutes against 110 scheduled.", coversUntil: TODAY });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.model).toBe("claude-sonnet-5-5");
    await s.review(WEEK);
    expect(llm.requests).toHaveLength(1);
    expect(reviewResponseSchema.parse(await (await s.t.get(`/api/review?week=${WEEK}`)).json()).review?.text).toContain("Load:");
    await s.review(WEEK, true);
    expect(llm.requests).toHaveLength(2);
    await s.review("2026-10-26");
    expect(llm.requests).toHaveLength(3); // another week is its own cache entry
    expect((await s.review("2026-11-09")).status).toBe(400);
    expect(s.t.handle.db.select().from(aiText).all().filter((r) => r.kind === "weekly_review")).toHaveLength(2);
  });

  it("caps what the tools return: nothing older than 28 days, only summaries, and no advice fields", async () => {
    const llm = mockLlm(() => text("ok"));
    const s = await setup({ llm });
    s.t.handle.db.insert(activity).values({ garminActivityId: "old", name: "ANCIENT RUN", type: "running", startLocal: "2026-01-05 07:00:00", date: "2026-01-05", durationS: 3000, distanceM: 9000, firstSeen: "x", lastSeen: "x" }).run();
    s.t.handle.db.insert(garminSnapshot).values({ kind: "sleep", date: "2026-01-05", payload: { sleep_score: 11 }, fetchedAt: "x" }).run();
    await s.review(WEEK);
    const full = String(llm.requests[0]?.messages[0]?.content);
    const body = full.slice(full.indexOf("<data")); // the data block, not the task prompt
    expect(body).not.toContain("ANCIENT RUN");
    expect(body).not.toContain('"date":"2026-01-05"');
    expect(body).not.toMatch(/split|fit_data|per.second|recommend|suggest|focus|taper/i);
    expect(body).toMatch(/"sleepScore":\{/);
    expect(body).toMatch(/"hrvLastNightMs":\{/);
    expect(body).toMatch(/"readiness":\{/);
    expect(WEEKLY_REVIEW_TASK).toContain("Do not suggest, recommend or judge anything about training");
  });

  it("reports a workout whose date moved between schedule snapshots", async () => {
    const llm = mockLlm(() => text("ok"));
    const s = await setup({ llm });
    const sched = (date: string) => ({ count: 1, scheduled_workouts: [{ date, scheduled_workout_id: 777, workout_id: 1, name: "Moved tempo", sport: "running", completed: false, estimated_duration_seconds: 3000 }] });
    s.t.handle.db.insert(garminSnapshot).values({ kind: "scheduled_workouts", date: "2026-11-03", payload: sched("2026-11-05"), fetchedAt: "x" }).run();
    s.t.handle.db.insert(garminSnapshot).values({ kind: "scheduled_workouts", date: "2026-11-05", payload: sched("2026-11-06"), fetchedAt: "x" }).run();
    await s.review(WEEK);
    expect(String(llm.requests[0]?.messages[0]?.content)).toMatch(/"movedWorkouts":\[\{"name":"Moved tempo","from":"2026-11-05","to":"2026-11-06"\}\]/);
  });

  it("says which scheduled sessions were done and which were missed", async () => {
    const llm = mockLlm(() => text("ok"));
    const s = await setup({ llm });
    s.t.handle.db.insert(workout).values({ garminScheduledId: "m1", date: "2026-11-03", name: "Missed tempo", durationS: 3000, completed: false, firstSeen: "x", lastSeen: "x" }).run();
    s.t.handle.db.insert(workout).values({ garminScheduledId: "d1", date: "2026-11-05", name: "Done intervals", durationS: 3600, completed: true, firstSeen: "x", lastSeen: "x" }).run();
    await s.review(WEEK);
    const body = String(llm.requests[0]?.messages[0]?.content);
    expect(body).toMatch(/"name":"Missed tempo"[^}]*"status":"missed"/);
    expect(body).toMatch(/"name":"Done intervals"[^}]*"status":"done"/);
  });

  it("says AI is off, or the cap is reached, and makes no call", async () => {
    const off = await setup({ env: { ANTHROPIC_API_KEY: "" } });
    expect(reviewResponseSchema.parse(await (await off.review(WEEK)).json())).toMatchObject({ state: "off", review: null, message: "AI is off" });
    const llm = mockLlm(() => text("never"));
    const capped = await setup({ llm });
    capped.addUsage(5);
    expect(reviewResponseSchema.parse(await (await capped.review(WEEK)).json())).toMatchObject({ state: "budget", message: "AI cap reached for this month" });
    expect(llm.requests).toHaveLength(0);
  });

  it("the Sunday evening job writes this week's review once, and is quiet at the cap", async () => {
    const llm = mockLlm(() => text("Load: fine."));
    const s = await setup({ llm });
    const job = s.t.ai.module.jobs?.find((j) => j.name === "weekly-review");
    expect(job?.schedule).toBe("0 19 * * 0");
    await job?.run();
    await job?.run();
    expect(llm.requests).toHaveLength(1);
    const capped = await setup({ llm: mockLlm(() => text("never")) });
    capped.addUsage(5);
    await capped.t.ai.module.jobs?.find((j) => j.name === "weekly-review")?.run();
  });
});

// ---------------------------------------------------------------- post-run debrief
describe("post-run debrief", () => {
  const RUN = "24996772536";
  const ids = (s: Awaited<ReturnType<typeof setup>>) => s.t.handle.db.select().from(aiText).all().filter((r) => r.kind === "debrief").map((r) => r.key).sort();

  it("writes one debrief per new run after a sync, with the fast model, and never twice for the same activity", async () => {
    const llm = mockLlm(() => text("A 7.86 km easy run, average 133 bpm."));
    const s = await setup({ llm, autoDebrief: true });
    await s.t.ai.afterSync();
    expect(ids(s)).toEqual(["24990000001", RUN]); // the strength session is not a run
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests.every((r) => r.model === "claude-haiku-5-5")).toBe(true);
    await s.t.post("/api/sync/garmin"); // too soon: 429, but a direct afterSync must not rewrite either
    await s.t.ai.afterSync();
    expect(llm.requests).toHaveLength(2);
    const got = debriefsResponseSchema.parse(await (await s.t.get(`/api/debriefs?ids=${RUN},nope`)).json());
    expect(Object.keys(got.debriefs)).toEqual([RUN]);
    expect(got.debriefs[RUN]?.text).toContain("7.86 km");
  });

  it("sends a summary only: the activity and the workout Garmin has scheduled that day, no splits, no other runs", async () => {
    const llm = mockLlm(() => text("ok"));
    const s = await setup({ llm, autoDebrief: true });
    await s.t.ai.afterSync();
    const body = String(llm.requests.find((r) => String(r.messages[0]?.content).includes(RUN))?.messages[0]?.content);
    expect(body).toContain('"avgHr":133');
    expect(body).toContain("scheduledInGarminThatDay");
    expect(body).not.toMatch(/recentRuns|"splits"|fit/i);
    expect(DEBRIEF_TASK).toMatch(/Do not judge, praise, criticise or give advice/);
  });

  it("Refresh rewrites it and a plain request does not; a non-run has none", async () => {
    const llm = mockLlm((_r, n) => text(`debrief ${n}`));
    const s = await setup({ llm });
    const ask = async (id: string, refresh?: boolean) => debriefOneResponseSchema.parse(await (await s.json("/api/debrief", { id, refresh })).json());
    expect((await ask(RUN)).debrief?.text).toBe("debrief 1");
    expect((await ask(RUN)).debrief?.text).toBe("debrief 1");
    expect(llm.requests).toHaveLength(1);
    expect((await ask(RUN, true)).debrief?.text).toBe("debrief 2");
    expect((await ask("24980000002")).debrief).toBeNull(); // strength training
    expect(llm.requests).toHaveLength(2);
  });

  it("does nothing, quietly, when AI is off or the cap is reached, and a failing model never breaks the sync", async () => {
    const off = await setup({ env: { ANTHROPIC_API_KEY: "" } });
    await off.t.ai.afterSync();
    expect(ids(off)).toEqual([]);
    const llm = mockLlm(() => text("never"));
    const capped = await setup({ llm });
    capped.addUsage(5);
    await capped.t.ai.afterSync();
    expect(llm.requests).toHaveLength(0);
    const broken = await setup({ llm: mockLlm(() => { throw new Error("boom"); }) });
    await broken.t.ai.afterSync();
    expect(ids(broken)).toEqual([]);
    expect((await broken.t.get("/api/today")).status).toBe(200);
  });
});

// ---------------------------------------------------------------- proposal tools
describe("AI proposal tools: both flags must be on", () => {
  const WID = "1833019748";
  const proposalRows = (s: Awaited<ReturnType<typeof setup>>) => s.t.handle.db.select().from(proposalTable).all();
  const script = (name: string, input: unknown) => mockLlm((_r, n) => (n === 1 ? toolUse(name, input, "p1") : text("Done.")));
  const flags = (ai: "on" | "off", writes: "on" | "off") => ({ env: { AI_PROPOSALS: ai, PULSE_GARMIN_WRITES: writes }, writes: writes === "on" });

  it("with either flag off, the model is not offered the tools and a forced call creates nothing", async () => {
    for (const [ai, writes] of [["off", "off"], ["on", "off"], ["off", "on"]] as const) {
      for (const [name, input] of [["propose_reschedule", { scheduled_id: WID, date: "2026-11-10", reason: "rest" }], ["propose_unschedule", { scheduled_id: WID }]] as const) {
        const llm = script(name, input);
        const s = await setup({ llm, ...flags(ai, writes) });
        await s.chat("move my long run to Tuesday");
        expect(llm.requests[0]?.tools?.map((t) => t.name).some((n) => n.startsWith("propose_")), `${ai}/${writes}`).toBe(false);
        expect(llm.requests[0]?.system).toBe(SYSTEM_PROMPT);
        expect(JSON.stringify(llm.requests[1]?.messages.at(-1))).toContain("Proposals are switched off");
        expect(proposalRows(s), `${ai}/${writes}`).toHaveLength(0);
        expect(s.t.handle.db.select().from(auditLog).all().filter((a) => a.action === "proposal.created")).toHaveLength(0);
        expect(s.t.writer.calls).toHaveLength(0);
      }
    }
  });

  it("the defaults are both off", async () => {
    const s = await setup();
    expect(s.t.config.AI_PROPOSALS).toBe("off");
    expect(s.t.config.PULSE_GARMIN_WRITES).toBe("off");
    expect(aiStatusSchema.parse(await (await s.t.get("/api/ai/status")).json()).proposals).toBe(false);
  });

  it("with both on, a request creates a pending proposal by AI, for a date only, and sends nothing", async () => {
    const llm = script("propose_reschedule", { scheduled_id: WID, date: "2026-11-10", reason: "Moved at your request." });
    const s = await setup({ llm, ...flags("on", "on") });
    await s.chat("move my long run to Tuesday");
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["propose_reschedule", "propose_unschedule"]));
    expect(llm.requests[0]?.system).toBe(SYSTEM_PROMPT_PROPOSALS);
    expect(proposalRows(s)).toHaveLength(1);
    const p = proposalSchema.parse(((await (await s.t.get("/api/proposals")).json()) as { pending: unknown[] }).pending[0]);
    expect(p).toMatchObject({ kind: "garmin.reschedule", status: "pending", createdBy: "ai", rationale: "Moved at your request.", after: { date: "2026-11-10" } });
    if (p.kind === "garmin.reschedule") expect({ ...p.after, date: p.before.date }).toEqual(p.before); // only the date differs
    expect(s.t.handle.db.select().from(auditLog).all().find((a) => a.action === "proposal.created")?.actor).toBe("ai");
    expect(JSON.stringify(llm.requests[1]?.messages.at(-1))).toContain("Nothing has changed");
    expect(s.t.writer.calls).toHaveLength(0);
    expect(s.t.writer.connects()).toBe(0);
    expect(aiStatusSchema.parse(await (await s.t.get("/api/ai/status")).json()).proposals).toBe(true);
  });

  it("the tools take dates and a scheduled id only: nothing about workout content", () => {
    for (const t of PROPOSAL_TOOLS) expect(Object.keys(t.input_schema.properties).sort()).toEqual(t.name === "propose_reschedule" ? ["date", "reason", "scheduled_id"] : ["reason", "scheduled_id"]);
  });

  it("refuses what the engine refuses: a date beyond the 14 day window, an unknown workout, bad input", async () => {
    for (const input of [{ scheduled_id: WID, date: "2027-01-01" }, { scheduled_id: "nope", date: "2026-11-10" }, { scheduled_id: WID, date: "tomorrow" }]) {
      const llm = script("propose_reschedule", input);
      const s = await setup({ llm, ...flags("on", "on") });
      await s.chat("move it");
      expect(proposalRows(s)).toHaveLength(0);
      expect(JSON.stringify(llm.requests[1]?.messages.at(-1))).toContain('\\"created\\":false');
    }
  });

  it("the AI module can only create proposals: it imports the engine's creators and no executor, confirm route or Garmin client", () => {
    const dir = join(import.meta.dirname, "../src/modules/ai");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/executors\//);
      expect(src, f).not.toMatch(/proposals\/confirm/);
      expect(src, f).not.toMatch(/garmin\/client/);
      for (const m of src.matchAll(/from\s+"\.\.\/proposals\/([^"]+)"/g)) {
        expect(f, "only proposal-tools.ts may import proposal code").toBe("proposal-tools.ts");
        expect(m[1]).toBe("engine.js");
      }
    }
  });
});

// ---------------------------------------------------------------- no training advice (D42)
describe("no training advice: Garmin facts, and the coach for the rest", () => {
  it("the system prompt carries the rule, in both variants", () => {
    for (const p of [SYSTEM_PROMPT, SYSTEM_PROMPT_PROPOSALS]) {
      expect(p).toContain("Training content belongs to Mark's coaching app and his coach");
      expect(p).toContain("You never suggest, design or critique training load, sessions, paces, tapers, recovery or race preparation");
      expect(p).toContain("say that the question is for his coach");
    }
  });

  it("a question asking for training advice gets the coach note, other questions do not", async () => {
    for (const q of ["Should I run today?", "What should I do for the taper?", "can I run tomorrow", "How hard should I go on Thursday?", "Recommend a session"]) expect(mentionsTrainingAdvice(q), q).toBe(true);
    for (const q of ["What is my next race?", "How did I sleep?", "What is scheduled on Thursday?"]) expect(mentionsTrainingAdvice(q), q).toBe(false);
    const llm = mockLlm(() => text("Readiness was 63 on 07/11. That question is for your coach."));
    const s = await setup({ llm });
    await s.chat("Should I run today?");
    expect(String(llm.requests[0]?.messages.at(-1)?.content)).toContain(COACH_NOTE);
    await s.chat("What is my next race?");
    expect(String(llm.requests[1]?.messages.at(-1)?.content)).not.toContain(COACH_NOTE);
  });

  it("the tools hand the model readings and schedules, never the app's Go or Rest status or advice", async () => {
    const s = await setup();
    const out = runTool("get_today", {}, { db: s.t.handle.db, now: clock() });
    expect(out).toContain('"readings"');
    expect(out).not.toMatch(/Go but easier|Swap for recovery|Go as planned|"verdict"|taper|recommend/i);
    const races = runTool("list_races", {}, { db: s.t.handle.db, now: clock() });
    expect(races).not.toMatch(/taper|recovery|advice/i);
  });

  it("the briefing context carries readings and no status, taper or advice", async () => {
    const llm = mockLlm(() => text("Readiness 63 on 07/11."));
    const s = await setup({ llm });
    await s.t.ai.generateIfMissing();
    const full = String(llm.requests[0]?.messages[0]?.content);
    const body = full.slice(full.indexOf("<data")); // the data block, not the task prompt
    expect(body).toContain('"readings"');
    expect(body).not.toMatch(/Go but easier|Swap for recovery|taper|recommend/i);
    expect(BRIEFING_TASK).toContain("Do not suggest, recommend or comment on training");
  });

  it("no task prompt, tool description or screen text offers training advice", () => {
    for (const t of [...ASK_TOOLS, ...PROPOSAL_TOOLS]) expect(t.description, t.name).not.toMatch(/taper|recommend|should|advice|focus|coach/i);
    for (const p of [BRIEFING_TASK, WEEKLY_REVIEW_TASK, DEBRIEF_TASK]) expect(p).toMatch(/Do not (suggest|judge)|Report only/);
    const root = join(import.meta.dirname, "../../web/src");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx?$/.test(f) && !/\.test\./.test(f) ? [join(d, f)] : []));
    for (const f of walk(root)) expect(readFileSync(f, "utf8"), f).not.toMatch(/Taper advice|Taper plan|Taper from|In the taper|Explain the plan|Suggested minutes|Consider shortening|controlled effort/);
  });
});

// ---------------------------------------------------------------- secrets and prompts
describe("secrets and prompts", () => {
  it("the key is in no log line, response or prompt across review, debrief and a failing model", async () => {
    const lines: string[] = [];
    const llm = mockLlm((_r, n) => {
      if (n % 2 === 0) throw new Error(`401 invalid x-api-key ${FAKE_KEY}`);
      return text("fine");
    });
    const s = await setup({ llm, logDestination: { write: (l: string) => void lines.push(l) } });
    const bodies: string[] = [];
    for (const res of [await s.review("2026-11-02"), await s.review("2026-11-02", true), await s.json("/api/debrief", { id: "24996772536", refresh: true }), await s.json("/api/debrief", { id: "24996772536", refresh: true }), await s.chat("how did I sleep?"), await s.chat("and my HRV?")]) bodies.push(await res.text());
    bodies.push(await (await s.t.get("/api/ai/status")).text(), JSON.stringify(s.t.handle.db.select().from(aiText).all()), JSON.stringify(s.t.handle.db.select().from(aiUsage).all()));
    expect(llm.requests.length).toBeGreaterThan(3);
    for (const t of [...lines, ...bodies, ...llm.requests.map((r) => JSON.stringify(r))]) expect(t).not.toContain(FAKE_KEY);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("every prompt in the code is in docs/AI.md word for word", () => {
    const doc = readFileSync(join(import.meta.dirname, "../../../docs/AI.md"), "utf8");
    for (const [name, p] of Object.entries({ SYSTEM_PROMPT, SYSTEM_PROMPT_PROPOSALS, BRIEFING_TASK, WEEKLY_REVIEW_TASK, DEBRIEF_TASK })) expect(doc, name).toContain(p);
  });

  it("no prompt contains an en or em dash", () => {
    for (const p of [SYSTEM_PROMPT, SYSTEM_PROMPT_PROPOSALS, BRIEFING_TASK, WEEKLY_REVIEW_TASK, DEBRIEF_TASK, COACH_NOTE]) expect(p).not.toMatch(/[\u2013\u2014]/);
  });
});
