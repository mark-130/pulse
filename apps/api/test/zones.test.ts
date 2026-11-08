import Database from "better-sqlite3";
import { asc } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KOTCHA_SEED_TOPS, garminRanges, kotchaRanges, validateKotchaTops, vo2Change, vo2ResponseSchema, zonesResponseSchema, type Vo2Point } from "@pulse/shared";
import { auditLog, hrZonesHistory, kotchaZone, syncState, vo2maxPoint } from "../src/db/schema.js";
import { GARMIN_READ_TOOLS, assertReadTool, type GarminConnector } from "../src/modules/garmin/client.js";
import { runGarminSync } from "../src/modules/garmin/sync.js";
import { runBackup } from "../src/modules/system/backup.js";
import { chooseProfile, diffZones, topDifferences } from "../src/modules/zones/logic.js";
import { openDb } from "../src/db/index.js";
import { runTool } from "../src/modules/ai/tools.js";
import { FAKE_KEY, mockLlm, text } from "./ai-helpers.js";
import { TODAY, fakeGarmin, payloads } from "./fixtures.js";
import { makeGarminApp, req } from "./helpers.js";

const profile = (o: Record<string, unknown> = {}) => ({ trainingMethod: "LACTATE_THRESHOLD", restingHeartRateUsed: 47, lactateThresholdHeartRateUsed: 162, zone1Floor: 103, zone2Floor: 130, zone3Floor: 144, zone4Floor: 151, zone5Floor: 158, maxHeartRateUsed: 180, sport: "DEFAULT", ...o });

describe("zone ranges", () => {
  const live = chooseProfile([profile()])!;

  it("derives each Garmin zone's top as the next floor minus 1, and zone 5's top as the max heart rate", () => {
    expect(garminRanges(live).map((r) => [r.zone, r.from, r.top])).toEqual([[1, 103, 129], [2, 130, 143], [3, 144, 150], [4, 151, 157], [5, 158, 180]]);
    expect(garminRanges(live)[4]?.top).toBe(live.max);
  });

  it("derives Kotcha's ranges from the tops: zone 1 up to its top, zone 2 from 129, zone 5 ending at max", () => {
    expect(kotchaRanges(KOTCHA_SEED_TOPS).map((r) => [r.zone, r.from, r.top])).toEqual([[1, null, 128], [2, 129, 143], [3, 144, 150], [4, 151, 157], [5, 158, 180]]);
  });

  it("uses the running profile when there is one, and falls back to the DEFAULT profile when there is none", () => {
    const both = chooseProfile([profile(), profile({ sport: "RUNNING", zone2Floor: 132 })])!;
    expect(both).toMatchObject({ profile: "RUNNING", usingDefault: false });
    expect(both.floors[1]).toBe(132);
    expect(chooseProfile([profile()])).toMatchObject({ profile: "DEFAULT", usingDefault: true, method: "LACTATE_THRESHOLD", resting: 47, lactateThreshold: 162, max: 180, floors: [103, 130, 144, 151, 158] });
    expect(chooseProfile([])).toBeNull();
    expect(chooseProfile({ nope: 1 })).toBeNull();
  });

  it("a 1 bpm gap in zone 1 is information: it is listed as a neutral line, and nothing else differs today", () => {
    const d = topDifferences(live, KOTCHA_SEED_TOPS);
    expect(d).toEqual([{ zone: 1, garminTop: 129, kotchaTop: 128, text: "Zone 1 top: Garmin 129, Kotcha 128" }]);
    expect(topDifferences(live, [129, 143, 150, 157, 180])).toEqual([]);
  });

  it("describes what changed in plain phrases", () => {
    const changed = chooseProfile([profile({ zone2Floor: 132, maxHeartRateUsed: 182, trainingMethod: "MAX_HR" })])!;
    expect(diffZones(live, changed)).toEqual(["Method LACTATE_THRESHOLD to MAX_HR", "Zone 2 floor 130 to 132", "Max heart rate 180 to 182"]);
    expect(diffZones(live, live)).toEqual([]);
  });
});

describe("Kotcha zone validation", () => {
  it("accepts five whole numbers, strictly ascending, with zone 5 equal to the max heart rate", () => {
    expect(validateKotchaTops([128, 143, 150, 157, 180], 180)).toEqual({ ok: true, tops: [128, 143, 150, 157, 180] });
  });
  it("rejects anything else, with a plain reason", () => {
    const bad = (v: unknown, max: number | null = 180) => {
      const r = validateKotchaTops(v, max);
      return r.ok ? "ok" : r.errors.join(" ");
    };
    expect(bad([128, 143, 150, 157])).toMatch(/all five/);
    expect(bad([128.5, 143, 150, 157, 180])).toMatch(/Zone 1 must be a whole number/);
    expect(bad(["128", 143, 150, 157, 180])).toMatch(/Zone 1 must be a whole number/);
    expect(bad([128, 128, 150, 157, 180])).toMatch(/Zone 2 must be higher than zone 1/);
    expect(bad([128, 143, 140, 157, 180])).toMatch(/Zone 3 must be higher than zone 2/);
    expect(bad([128, 143, 150, 157, 179])).toMatch(/Zone 5 must equal your max heart rate, 180/);
    expect(bad([128, 143, 150, 157, 181])).toMatch(/Zone 5 must equal your max heart rate, 180/);
    expect(bad([128, 143, 150, 157, 180], null)).toMatch(/max heart rate is not known yet/);
    expect(bad([10, 143, 150, 157, 180])).toMatch(/between 30 and 250/);
    expect(bad("nope")).toMatch(/all five/);
  });
});

describe("VO2 max change over 30 days", () => {
  const pt = (date: string, value: number, carriedForward = false): Vo2Point => ({ date, value, carriedForward });
  it("is the last value minus the first value in the 30 days to the latest point", () => {
    expect(vo2Change([pt("2026-10-10", 46.5, true), pt("2026-10-20", 46.3), pt("2026-11-08", 45.9)])?.text).toBe("Down 0.6 over 30 days");
    expect(vo2Change([pt("2026-10-10", 45.5), pt("2026-11-08", 45.9)])).toMatchObject({ direction: "up", delta: 0.4, text: "Up 0.4 over 30 days" });
    expect(vo2Change([pt("2026-10-10", 45.9), pt("2026-11-08", 45.9)])).toEqual({ direction: "none", delta: 0, text: "No change over 30 days" });
  });
  it("only looks 30 days back from the latest point, and needs two values", () => {
    expect(vo2Change([pt("2026-08-01", 40), pt("2026-10-10", 46), pt("2026-11-08", 45)])?.delta).toBe(-1);
    expect(vo2Change([pt("2026-11-08", 45)])).toBeNull();
    expect(vo2Change([])).toBeNull();
    expect(vo2Change([pt("2026-08-01", 40), pt("2026-11-08", 45)])).toBeNull();
  });
  it("counts carried-forward days like any other value, since they are Garmin's last known value", () => {
    expect(vo2Change([pt("2026-10-10", 46.5, true), pt("2026-11-08", 45.9, true)])?.text).toBe("Down 0.6 over 30 days");
  });
  it("rounds to one decimal", () => {
    expect(vo2Change([pt("2026-10-10", 46.04), pt("2026-11-08", 45.9)])?.delta).toBe(-0.1);
  });
});

// ---------------------------------------------------------------- the app
const clockAt = { now: new Date(`${TODAY}T12:30:00Z`) };
async function setup(o: { fail?: Record<string, string>; zones?: unknown } = {}) {
  clockAt.now = new Date(`${TODAY}T12:30:00Z`);
  const fake = { overrides: {} as Record<string, unknown>, fail: { ...o.fail } as Record<string, string> };
  const t = await makeGarminApp({ clock: () => clockAt.now, fake });
  const json = (path: string, body?: unknown) =>
    req(t.app, path, { method: "POST", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sync = async (minutes = 5) => {
    clockAt.now = new Date(clockAt.now.getTime() + minutes * 60_000);
    await t.post("/api/sync/garmin");
  };
  const zones = async () => zonesResponseSchema.parse(await (await t.get("/api/zones")).json());
  const audit = () => t.handle.db.select().from(auditLog).orderBy(asc(auditLog.id)).all().filter((a) => a.action.startsWith("settings."));
  await sync(0);
  return { t, fake, json, sync, zones, audit };
}
const SAVE = [128, 143, 150, 157, 180];

describe("zones in the app", () => {
  it("shows Kotcha's seed values first, Garmin's zones beside them, and the 1 bpm note without any warning", async () => {
    const s = await setup();
    const z = await s.zones();
    expect(z.kotcha).toMatchObject({ source: "seed", savedAt: null });
    expect(z.kotcha.zones.map((k) => [k.zone, k.name, k.from, k.top])).toEqual([[1, "Recovery", null, 128], [2, "Aerobic Endurance", 129, 143], [3, "Aerobic Power", 144, 150], [4, "Threshold", 151, 157], [5, "Anaerobic", 158, 180]]);
    expect(z.garmin?.zones).toMatchObject({ profile: "DEFAULT", usingDefault: true, method: "LACTATE_THRESHOLD", resting: 47, lactateThreshold: 162, max: 180 });
    expect(z.garmin?.ranges.map((r) => r.top)).toEqual([129, 143, 150, 157, 180]);
    expect(z.differences.map((d) => d.text)).toEqual(["Zone 1 top: Garmin 129, Kotcha 128"]);
    expect(z.warning).toBeNull();
    expect(z.confirmed).toBe(false);
    expect(z.garmin?.firstSeen).toBe(TODAY);
  });

  it("an invalid save changes nothing and writes no audit entry", async () => {
    const s = await setup();
    for (const tops of [[128, 143, 150, 157, 179], [128, 128, 150, 157, 180], [128.5, 143, 150, 157, 180], [128, 143]]) {
      const res = await s.json("/api/zones/kotcha", { tops });
      expect(res.status).toBe(400);
    }
    expect((await s.zones()).kotcha.source).toBe("seed");
    expect(s.audit()).toHaveLength(0);
  });

  it("a save is explicit: it stores the tops, writes an audit entry with the old and new values, and takes the current Garmin zones as confirmed", async () => {
    const s = await setup();
    const res = await s.json("/api/zones/kotcha", { tops: [129, 143, 150, 157, 180] });
    expect(res.status).toBe(200);
    const z = zonesResponseSchema.parse(await res.json());
    expect(z.kotcha).toMatchObject({ source: "manual" });
    expect(z.kotcha.savedAt).not.toBeNull();
    expect(z.kotcha.zones[0]?.top).toBe(129);
    expect(z.confirmed).toBe(true);
    expect(z.warning).toBeNull(); // no warning straight after the first save
    expect(z.differences).toEqual([]);
    const a = s.audit();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor: "user", action: "settings.kotcha_zones", target: "settings.kotcha_zones" });
    expect(JSON.parse(a[0]?.result ?? "{}")).toMatchObject({ old: [128, 143, 150, 157, 180], new: [129, 143, 150, 157, 180] });
  });

  it("a Garmin change raises the warning with the date and what changed, and the confirm button clears it", async () => {
    const s = await setup();
    await s.json("/api/zones/kotcha", { tops: SAVE });
    s.fake.overrides.get_heart_rate_zones = [profile({ zone2Floor: 132 })];
    await s.sync();
    const z = await s.zones();
    expect(z.warning).toEqual({ changedOn: TODAY, changes: ["Zone 2 floor 130 to 132"], text: "Garmin changed your heart rate zones on 07/11. Zone 2 floor 130 to 132. Update Kotcha, then confirm here." });
    expect(s.t.handle.db.select().from(hrZonesHistory).all()).toHaveLength(2);
    const res = await s.json("/api/zones/confirm");
    expect(res.status).toBe(200);
    expect(zonesResponseSchema.parse(await res.json()).warning).toBeNull();
    expect(s.audit().map((a) => a.action)).toEqual(["settings.kotcha_zones", "settings.kotcha_garmin_confirmed"]);
    // It does not come back while Garmin stays the same, and returns only when Garmin changes again.
    await s.sync();
    expect((await s.zones()).warning).toBeNull();
    s.fake.overrides.get_heart_rate_zones = [profile({ zone2Floor: 132, maxHeartRateUsed: 181, zone5Floor: 158 })];
    await s.sync();
    expect((await s.zones()).warning?.changes).toEqual(["Max heart rate 180 to 181"]); // relative to the zones Mark last confirmed
  });

  it("no warning appears before the first save, even if Garmin changed", async () => {
    const s = await setup();
    s.fake.overrides.get_heart_rate_zones = [profile({ zone2Floor: 132 })];
    await s.sync();
    const z = await s.zones();
    expect(z.confirmed).toBe(false);
    expect(z.warning).toBeNull();
  });

  it("a failed fetch never raises a warning and never clears one, and the last zones stay on show with their age", async () => {
    const s = await setup();
    await s.json("/api/zones/kotcha", { tops: SAVE });
    // Garmin has changed, but the fetch fails: nothing new is seen, so no warning.
    s.fake.overrides.get_heart_rate_zones = [profile({ zone2Floor: 132 })];
    s.fake.fail.get_heart_rate_zones = "boom";
    await s.sync();
    let z = await s.zones();
    expect(z.warning).toBeNull();
    expect(z.garmin?.zones.floors[1]).toBe(130); // the last good value, not a blank
    expect(z.garmin?.lastError).toContain("boom");
    // Now the fetch works and the warning is raised. A later failure leaves it open.
    delete s.fake.fail.get_heart_rate_zones;
    await s.sync();
    expect((await s.zones()).warning).not.toBeNull();
    s.fake.fail.get_heart_rate_zones = "boom again";
    await s.sync();
    z = await s.zones();
    expect(z.warning?.text).toContain("Zone 2 floor 130 to 132");
    expect(z.garmin?.ageMinutes).not.toBeNull();
    expect(s.t.handle.db.select().from(syncState).all().find((r) => r.job === "garmin:hr_zones")?.consecutiveFailures).toBeGreaterThan(0);
  });

  it("confirm needs Garmin zones to exist, and a session", async () => {
    const t = await makeGarminApp({ clock: () => clockAt.now });
    const res = await req(t.app, "/api/zones/confirm", { method: "POST", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken } });
    expect(res.status).toBe(409);
    expect((await req(t.app, "/api/zones")).status).toBe(401);
    expect((await req(t.app, "/api/zones/confirm", { method: "POST", headers: { cookie: t.cookie } })).status).toBe(403);
  });

  it("Kotcha's copy is in the database, so the nightly backup holds it", async () => {
    const s = await setup();
    await s.json("/api/zones/kotcha", { tops: [129, 143, 150, 157, 180] });
    const file = runBackup(s.t.handle.sqlite, s.t.config.DATA_DIR, clockAt.now);
    const copy = new Database(file, { readonly: true });
    expect(copy.prepare("select top_bpm from kotcha_zone order by zone").all()).toEqual([129, 143, 150, 157, 180].map((top_bpm) => ({ top_bpm })));
    copy.close();
    expect(s.t.handle.db.select().from(kotchaZone).all()).toHaveLength(5);
  });
});

describe("the zones fetch: running first, DEFAULT as the fallback", () => {
  async function runWith(answer: (args: Record<string, unknown>) => { kind: "json"; data: unknown } | { kind: "message"; text: string }) {
    const dir = mkdtempSync(join(tmpdir(), "pulse-zones-"));
    const h = openDb(dir);
    const calls: Record<string, unknown>[] = [];
    const base = fakeGarmin();
    const connect: GarminConnector = async () => {
      const s = await base.connect();
      return {
        async call(tool, args) {
          if (tool !== "get_heart_rate_zones") return s.call(tool, args);
          calls.push(args);
          return answer(args);
        },
        close: () => s.close(),
      };
    };
    const res = await runGarminSync({ db: h.db, connect, now: () => new Date(`${TODAY}T12:30:00Z`), sleep: async () => undefined });
    return { res, calls, h };
  }

  it("asks for the running profile first, and uses DEFAULT when Garmin says none is configured", async () => {
    const { res, calls, h } = await runWith((args) => (args.sport === "running" ? { kind: "message", text: "No configured heart-rate zones found for sport RUNNING." } : { kind: "json", data: [profile()] }));
    expect(calls).toEqual([{ sport: "running" }, {}]);
    expect(res.tasks.find((t) => t.name === "hr_zones")?.status).toBe("ok");
    const row = h.sqlite.prepare("select payload from garmin_snapshot where kind='hr_zones'").get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ profile: "DEFAULT", usingDefault: true, max: 180 });
  });

  it("uses the running profile when it exists, in one call", async () => {
    const { calls, h } = await runWith(() => ({ kind: "json", data: [profile(), profile({ sport: "RUNNING", zone2Floor: 132 })] }));
    expect(calls).toEqual([{ sport: "running" }]);
    const row = h.sqlite.prepare("select payload from garmin_snapshot where kind='hr_zones'").get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ profile: "RUNNING", usingDefault: false });
  });

  it("a failed call is a failed kind, not an empty one, and stores nothing", async () => {
    const { res, h } = await runWith(() => ({ kind: "message", text: "Error retrieving zones: Read timed out" }));
    expect(res.tasks.find((t) => t.name === "hr_zones")?.status).toBe("failed");
    expect(h.sqlite.prepare("select count(*) n from garmin_snapshot where kind='hr_zones'").get()).toEqual({ n: 0 });
    expect(res.ok).toBe(true); // the other kinds still count
  });

  it("only ever calls get_heart_rate_zones, which is on the read allowlist, and no zone write tool is reachable", () => {
    expect(GARMIN_READ_TOOLS).toContain("get_heart_rate_zones");
    expect(GARMIN_READ_TOOLS).toContain("get_vo2max_trend");
    expect(GARMIN_READ_TOOLS.some((t) => /^set_|^update_|^delete_/.test(t))).toBe(false);
    expect(() => assertReadTool("set_heart_rate_zones")).toThrow(/not on the read-only allowlist/);
    expect(payloads.get_heart_rate_zones).toBeDefined();
  });
});

describe("VO2 max in the app", () => {
  it("stores the points, marks carried-forward days, and works out the 30 day change in code", async () => {
    const s = await setup();
    const rows = s.t.handle.db.select().from(vo2maxPoint).orderBy(asc(vo2maxPoint.date)).all();
    expect(rows.map((r) => [r.date, r.value, r.carriedForward])).toEqual([["2026-09-01", 46.8, false], ["2026-10-09", 46.5, true], ["2026-10-10", 46.5, false], ["2026-11-07", 45.7, false]]);
    const v = vo2ResponseSchema.parse(await (await s.t.get("/api/vo2max")).json());
    expect(v.current).toEqual({ date: "2026-11-07", value: 45.7, carriedForward: false });
    expect(v.change30).toEqual({ direction: "down", delta: -0.8, text: "Down 0.8 over 30 days" });
    expect(v.points.map((p) => p.date)).toEqual(["2026-10-09", "2026-10-10", "2026-11-07"]); // 30 days
    expect(v.points[0]?.carriedForward).toBe(true);
    expect(v.stored).toEqual({ from: "2026-09-01", to: "2026-11-07" });
    const long = vo2ResponseSchema.parse(await (await s.t.get("/api/vo2max?days=90")).json());
    expect(long.points).toHaveLength(4);
    expect((await s.t.get("/api/vo2max?days=3")).status).toBe(400);
  });

  it("a failed VO2 max fetch keeps the last values, with their age and the error", async () => {
    const s = await setup();
    s.fake.fail.get_vo2max_trend = "Read timed out";
    await s.sync(120);
    const v = vo2ResponseSchema.parse(await (await s.t.get("/api/vo2max")).json());
    expect(v.current?.value).toBe(45.7);
    expect(v.stale).toBe(true);
    expect(v.lastError).toContain("timed out");
  });
});

describe("zones and VO2 max for the AI: facts only", () => {
  it("get_hr_zones returns both sets labelled, the differing tops and any open warning, with no advice", async () => {
    const s = await setup();
    const call = () => runTool("get_hr_zones", {}, { db: s.t.handle.db, now: clockAt.now });
    const first = call();
    expect(first).toContain('"kotchaCopy"');
    expect(first).toContain('"garmin"');
    expect(first).toContain("Kotcha, Mark's coaching app, which owns them");
    expect(first).toContain("Zone 1 top: Garmin 129, Kotcha 128");
    expect(first).toContain('"openWarning":null');
    expect(first).toContain('"runningUsesDefaultProfile":true');
    expect(first).not.toMatch(/recommend|should|train in|advice/i);
    await s.json("/api/zones/kotcha", { tops: SAVE });
    s.fake.overrides.get_heart_rate_zones = [profile({ zone2Floor: 132 })];
    await s.sync();
    expect(call()).toContain("Garmin changed your heart rate zones on 07/11. Zone 2 floor 130 to 132.");
  });

  it("get_vo2max returns the last 30 days with carried-forward days marked", async () => {
    const s = await setup();
    const out = runTool("get_vo2max", {}, { db: s.t.handle.db, now: clockAt.now });
    expect(out).toContain('"change30Days":"Down 0.8 over 30 days"');
    expect(out).toContain('"carriedForward":true');
    expect(out).not.toContain("2026-09-01"); // older than 30 days is not returned
  });

  it("the briefing is given an open zones warning as a fact, and nothing when there is none", async () => {
    const llm = mockLlm(() => text("Good afternoon Mark."));
    const fake = { overrides: {} as Record<string, unknown> };
    const t = await makeGarminApp({ clock: () => clockAt.now, env: { ANTHROPIC_API_KEY: FAKE_KEY }, llm, fake });
    await t.post("/api/sync/garmin");
    const post = (path: string, body?: unknown) => req(t.app, path, { method: "POST", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    await post("/api/briefing/generate");
    expect(String(llm.requests[0]?.messages[0]?.content)).toContain('"zonesWarning":null');
    expect(llm.requests[0]?.system).toContain("never say how to train in a zone");
    // Next day: Mark has saved his copy, Garmin then changes, and the briefing states it as a fact.
    await post("/api/zones/kotcha", { tops: SAVE });
    fake.overrides.get_heart_rate_zones = [profile({ zone2Floor: 132 })];
    clockAt.now = new Date(`2026-11-08T08:00:00Z`);
    await t.post("/api/sync/garmin");
    await post("/api/briefing/generate");
    expect(String(llm.requests[1]?.messages[0]?.content)).toContain("Garmin heart rate zones changed on 08/11 and the Kotcha copy has not been confirmed.");
  });
});
