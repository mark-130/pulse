import { describe, expect, it } from "vitest";
import { racesResponseSchema, raceMetaResponseSchema } from "@pulse/shared";
import { buildRace, buildRaces, classify, inferDistanceM, inferPriority, inferType, recoveryDays, taperDays, type MetaInput, type RaceInput } from "../src/modules/races/logic.js";
import { TODAY } from "./fixtures.js";
import { makeGarminApp, req } from "./helpers.js";

const race = (o: Partial<RaceInput> & Pick<RaceInput, "title" | "date">): RaceInput => ({
  eventKey: `${o.date}|${o.title}`,
  startTimeLocal: "09:00",
  timeZone: "Europe/London",
  distanceM: 10_000,
  goalTimeSeconds: 3000,
  isRace: true,
  primaryEvent: false,
  location: null,
  url: null,
  ...o,
});
const none = new Map<string, MetaInput>();
const set = (r: RaceInput, priority: MetaInput["priority"], type: MetaInput["type"] = "road"): [string, MetaInput] => [r.eventKey, { priority, type, goalOverrideS: null }];

// Fixtures from docs/TRAINING.md, as seen on 07/11/2026. Test data only.
const rhino = race({ title: "Rhino 10K", date: "2026-11-14" });
const pierrepont = race({ title: "Pierrepont Half", date: "2027-03-14", distanceM: 21_100, isRace: false });
const brighton = race({ title: "Brighton Marathon", date: "2027-04-04", distanceM: 42_195 });
const scottish = race({ title: "Scottish Half", date: "2027-08-15", distanceM: 21_100 });
const sydney = race({ title: "Sydney Marathon", date: "2027-08-29", distanceM: 42_195, startTimeLocal: "06:30", timeZone: "Australia/Sydney" });
const antwerp = race({ title: "Antwerp Half", date: "2027-10-24", distanceM: 21_100, startTimeLocal: "01:30", timeZone: "Europe/Paris", goalTimeSeconds: null });
const longRun = { date: "2026-11-08", durationS: 6600 };

describe("inference defaults (TRAINING.md)", () => {
  it("priority: A if primary, C if not a race, otherwise B", () => {
    expect(inferPriority({ isRace: true, primaryEvent: true })).toBe("A");
    expect(inferPriority({ isRace: false, primaryEvent: false })).toBe("C");
    expect(inferPriority({ isRace: true, primaryEvent: false })).toBe("B");
  });
  it("type: trail if the title says so, otherwise road", () => {
    expect(inferType("Welsh Trail Half")).toBe("trail");
    expect(inferType("Snowdonia Marathon")).toBe("trail");
    expect(inferType("City 10K")).toBe("road");
  });
  it("distance comes from Garmin, and only from the title when Garmin has none, marked inferred", () => {
    expect(inferDistanceM("Autumn Half Marathon")).toBeCloseTo(21097.5);
    expect(inferDistanceM("Spring Marathon")).toBe(42195);
    expect(inferDistanceM("Park 10K")).toBe(10000);
    expect(inferDistanceM("Fun Run")).toBeNull();
    const fromTitle = buildRace(race({ title: "Park 10K", date: "2026-12-01", distanceM: null }), undefined, TODAY);
    expect(fromTitle).toMatchObject({ distanceM: 10000, distanceInferred: true });
    expect(fromTitle.flags.map((f) => f.kind)).toContain("distance_inferred");
    const garmin = buildRace(race({ title: "Park 10K", date: "2026-12-01", distanceM: 9800 }), undefined, TODAY);
    expect(garmin).toMatchObject({ distanceM: 9800, distanceInferred: false });
  });
  it("classes by distance", () => {
    expect([classify(5000), classify(10_000), classify(21_100), classify(42_195), classify(null)]).toEqual(["10k", "10k", "half", "marathon", null]);
  });
  it("is unclassified until both priority and type are set", () => {
    expect(buildRace(rhino, undefined, TODAY)).toMatchObject({ classified: false, priority: "B", priorityInferred: true, typeInferred: true });
    expect(buildRace(rhino, { priority: "A", type: null, goalOverrideS: null }, TODAY)).toMatchObject({ classified: false, priority: "A", priorityInferred: false, typeInferred: true });
    expect(buildRace(rhino, { priority: "A", type: "road", goalOverrideS: null }, TODAY)).toMatchObject({ classified: true });
  });
});

describe("taper and recovery defaults", () => {
  it("follow the TRAINING.md table", () => {
    expect([taperDays("10k", "A"), taperDays("10k", "B"), taperDays("half", "A"), taperDays("half", "B"), taperDays("marathon", "A")]).toEqual([7, 4, 10, 6, 21]);
    expect([taperDays("marathon", "C"), taperDays("half", "C"), taperDays(null, "A")]).toEqual([0, 0, 0]);
    expect([recoveryDays("10k", "B", "road"), recoveryDays("half", "B", "road"), recoveryDays("marathon", "A", "road")]).toEqual([3, 6, 12]);
    expect([recoveryDays("half", "B", "trail"), recoveryDays("10k", "B", "trail"), recoveryDays("half", "C", "road")]).toEqual([8, 4, 0]);
  });
  it("gives a taper start date, a status line and a recovery window", () => {
    const r = buildRace(rhino, { priority: "A", type: "road", goalOverrideS: null }, TODAY);
    expect(r.taper).toMatchObject({ days: 7, start: "2026-11-07" });
    expect(r.taper.status).toBe("In the taper, day 1 of 7.");
    expect(r.taper.advice).toContain("Advice only, not medical guidance");
    expect(r.recovery).toEqual({ days: 3, until: "2026-11-17" });
    const b = buildRace(rhino, { priority: "B", type: "road", goalOverrideS: null }, TODAY);
    expect(b.taper).toMatchObject({ days: 4, start: "2026-11-10", status: "Taper starts 10/11, in 3 days." });
    const c = buildRace(rhino, { priority: "C", type: "road", goalOverrideS: null }, TODAY);
    expect(c.taper).toMatchObject({ days: 0, start: null, advice: null, status: "No taper. Treat it as a workout." });
    expect(c.recovery.until).toBeNull();
  });
  it("describes recovery after a race", () => {
    const after = buildRace(race({ title: "Done 10K", date: "2026-11-05" }), undefined, TODAY);
    expect(after).toMatchObject({ past: true, daysUntil: -2 });
    expect(after.taper.status).toBe("Done. Easy running only until 08/11.");
  });
});

describe("data quality flags", () => {
  it("flags a start before 05:00 in its own time zone as unverified", () => {
    const a = buildRace(antwerp, undefined, TODAY);
    expect(a.flags.find((f) => f.kind === "unverified_time")?.text).toContain("01:30 (Europe/Paris)");
    expect(buildRace(sydney, undefined, TODAY).flags.map((f) => f.kind)).not.toContain("unverified_time");
    expect(buildRace(race({ title: "x", date: "2026-12-01", startTimeLocal: "05:00" }), undefined, TODAY).flags.map((f) => f.kind)).not.toContain("unverified_time");
  });
  it("flags no goal time, a goal override clears it", () => {
    expect(buildRace(antwerp, undefined, TODAY).flags.map((f) => f.kind)).toContain("no_goal");
    const withOverride = buildRace(antwerp, { priority: null, type: null, goalOverrideS: 7200 }, TODAY);
    expect(withOverride.goalTimeSeconds).toBe(7200);
    expect(withOverride.flags.map((f) => f.kind)).not.toContain("no_goal");
  });
  it("flags an event Garmin does not mark as a race and a missing start time", () => {
    expect(buildRace(pierrepont, undefined, TODAY).flags.map((f) => f.kind)).toContain("not_a_race");
    expect(buildRace(race({ title: "x", date: "2026-12-01", startTimeLocal: null }), undefined, TODAY).flags.map((f) => f.kind)).toContain("start_unknown");
  });
});

describe("cluster and clash warnings (TRAINING.md fixtures)", () => {
  const warn = (rows: RaceInput[], metas = none, workouts = [longRun]) => buildRaces(rows, metas, workouts, TODAY).warnings;

  it("flags a 10K six days after the 08/11 long run, with a taper start", () => {
    const w = warn([rhino]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: "long_run", severity: "info", raceKeys: [rhino.eventKey] });
    expect(w[0]?.taperStarts).toEqual([{ raceKey: rhino.eventKey, date: "2026-11-10" }]);
    expect(w[0]?.message).toContain("6 days before");
  });
  it("leaves a C race alone and ignores a short session or an older one", () => {
    expect(warn([rhino], new Map([set(rhino, "C")]))).toEqual([]);
    expect(warn([rhino], none, [{ date: "2026-11-08", durationS: 3000 }])).toEqual([]);
    expect(warn([rhino], none, [{ date: "2026-11-01", durationS: 6600 }])).toEqual([]);
  });
  it("flags a half and a marathon 21 days apart and asks for one A", () => {
    const w = warn([pierrepont, brighton], none, []);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: "cluster", severity: "action", needsChoice: true });
    expect(w[0]?.raceKeys).toEqual([pierrepont.eventKey, brighton.eventKey]);
    expect(w[0]?.taperStarts).toEqual([
      { raceKey: pierrepont.eventKey, date: "2027-03-08" },
      { raceKey: brighton.eventKey, date: "2027-03-25" },
    ]);
  });
  it("flags a half and a marathon 14 days apart", () => {
    const w = warn([scottish, sydney], none, []);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: "cluster", needsChoice: true });
    expect(w[0]?.taperStarts.map((t) => t.date)).toEqual(["2027-08-09", "2027-08-19"]);
  });
  it("is settled, and quieter, once exactly one A is set by Mark", () => {
    const metas = new Map([set(scottish, "C"), set(sydney, "A")]);
    const w = warn([scottish, sydney], metas, []);
    expect(w[0]).toMatchObject({ kind: "cluster", needsChoice: false, severity: "info" });
    expect(warn([scottish, sydney], new Map([set(scottish, "A"), set(sydney, "A")]), [])[0]).toMatchObject({ needsChoice: true, severity: "action" });
  });
  it("needs a half or longer, and 21 days or fewer", () => {
    const tenA = race({ title: "10K A", date: "2027-01-10" });
    const tenB = race({ title: "10K B", date: "2027-01-20" });
    expect(warn([tenA, tenB], none, [])).toEqual([]);
    expect(warn([pierrepont, race({ title: "Late Marathon", date: "2027-04-05", distanceM: 42_195 })], none, [])).toEqual([]);
    expect(warn([pierrepont, brighton], none, []).filter((x) => x.kind === "cluster")).toHaveLength(1);
  });
  it("flags a race inside the recovery window of an earlier race", () => {
    const half = race({ title: "Early Half", date: "2027-02-07", distanceM: 21_100 });
    const ten = race({ title: "Soon 10K", date: "2027-02-10" });
    const w = warn([half, ten], new Map([set(half, "B"), set(ten, "B")]), []);
    const rec = w.find((x) => x.kind === "recovery_clash");
    expect(rec?.message).toContain("3 days after Early Half");
    expect(rec?.message).toContain("until 13/02");
  });
  it("flags a race inside the taper of a later race", () => {
    const ten = race({ title: "Tune Up 10K", date: "2027-04-28" });
    const goal = race({ title: "Goal Marathon", date: "2027-05-02", distanceM: 42_195 });
    const w2 = warn([ten, goal], new Map([set(ten, "B"), set(goal, "A")]), []);
    expect(w2.find((x) => x.kind === "taper_clash")?.message).toContain("falls inside the taper for Goal Marathon");
  });
  it("ignores races that are already over for clusters", () => {
    const past = race({ title: "Old Half", date: "2026-10-30", distanceM: 21_100 });
    expect(warn([past, rhino], none, []).filter((x) => x.kind === "cluster")).toEqual([]);
  });
});

describe("races routes", () => {
  const clock = () => new Date(`${TODAY}T12:30:00Z`);

  it("require a session and list races sorted by date with the Garmin data", async () => {
    const t = await makeGarminApp({ clock });
    expect((await req(t.app, "/api/races")).status).toBe(401);
    await t.post("/api/sync/garmin");
    const view = racesResponseSchema.parse(await (await t.get("/api/races")).json());
    expect(view.races.map((r) => r.date)).toEqual([...view.races.map((r) => r.date)].sort());
    expect(view.races[0]).toMatchObject({ title: "Rhino Run West Bridgford", daysUntil: 7, priority: "B", priorityInferred: true, classified: false });
    const antwerp = view.races.find((r) => r.title.startsWith("The Trek Antwerp"));
    expect(antwerp?.flags.map((f) => f.kind)).toEqual(expect.arrayContaining(["unverified_time", "no_goal"]));
    expect(view.races.find((r) => r.title.startsWith("Pierrepont"))?.flags.map((f) => f.kind)).toContain("not_a_race");
    const kinds = view.warnings.map((w) => w.kind);
    expect(kinds).toContain("cluster");
    expect(kinds).toContain("long_run");
  });

  it("saves priority and type locally, returns the previous values for undo, and survives a re-sync", async () => {
    let now = new Date(`${TODAY}T12:30:00Z`);
    const t = await makeGarminApp({ clock: () => now });
    await t.post("/api/sync/garmin");
    now = new Date(`${TODAY}T13:30:00Z`);
    const key = (racesResponseSchema.parse(await (await t.get("/api/races")).json())).races[0]!.eventKey;
    const put = (body: unknown) => req(t.app, "/api/races/meta", { method: "PUT", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken, "content-type": "application/json" }, body: JSON.stringify(body) });

    const first = raceMetaResponseSchema.parse(await (await put({ key, priority: "A", type: "road" })).json());
    expect(first).toEqual({ previous: { priority: null, type: null }, current: { priority: "A", type: "road" } });
    let view = racesResponseSchema.parse(await (await t.get("/api/races")).json());
    expect(view.races[0]).toMatchObject({ priority: "A", priorityInferred: false, classified: true });
    expect(view.races[0]?.taper.days).toBe(7);

    const second = raceMetaResponseSchema.parse(await (await put({ key, priority: "C", type: "trail" })).json());
    expect(second.previous).toEqual({ priority: "A", type: "road" });
    // Undo: put the previous values back, then back to nothing.
    await put({ key, ...second.previous });
    expect((racesResponseSchema.parse(await (await t.get("/api/races")).json())).races[0]).toMatchObject({ priority: "A", type: "road" });
    await put({ key, priority: null, type: null });
    view = racesResponseSchema.parse(await (await t.get("/api/races")).json());
    expect(view.races[0]).toMatchObject({ classified: false, priority: "B", priorityInferred: true });

    await put({ key, priority: "A", type: "road" });
    // Sync again and the local metadata is untouched.
    await req(t.app, "/api/sync/garmin", { method: "POST", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken } });
    expect((racesResponseSchema.parse(await (await t.get("/api/races")).json())).races[0]).toMatchObject({ priority: "A", classified: true });
  });

  it("rejects bad input, unknown races and a missing CSRF token", async () => {
    const t = await makeGarminApp({ clock });
    await t.post("/api/sync/garmin");
    const key = (racesResponseSchema.parse(await (await t.get("/api/races")).json())).races[0]!.eventKey;
    const headers = { cookie: t.cookie, "x-csrf-token": t.csrfToken, "content-type": "application/json" };
    expect((await req(t.app, "/api/races/meta", { method: "PUT", headers, body: JSON.stringify({ key, priority: "Z", type: null }) })).status).toBe(400);
    expect((await req(t.app, "/api/races/meta", { method: "PUT", headers, body: JSON.stringify({ key: "nope", priority: "A", type: null }) })).status).toBe(404);
    expect((await req(t.app, "/api/races/meta", { method: "PUT", headers: { cookie: t.cookie, "content-type": "application/json" }, body: JSON.stringify({ key, priority: "A", type: null }) })).status).toBe(403);
  });
});
