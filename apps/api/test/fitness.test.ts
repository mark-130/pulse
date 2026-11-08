import { asc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  PREDICTION_DISTANCES, fitnessResponseSchema, formatDuration, leadUpResponseSchema, matchPredictionDistance, paceFromSpeed, paceFromTime, parseDuration, predictionDifference,
} from "@pulse/shared";
import { personalRecord, racePrediction, syncState } from "../src/db/schema.js";
import { enduranceBand } from "../src/modules/fitness/data.js";
import { runTool } from "../src/modules/ai/tools.js";
import { GARMIN_READ_TOOLS, assertReadTool } from "../src/modules/garmin/client.js";
import { TODAY, payloads } from "./fixtures.js";
import { makeGarminApp, req } from "./helpers.js";

describe("pace and time wording", () => {
  it("converts Garmin's lactate threshold speed to a pace per km: 3.1388801 m/s is 5:19 per km", () => {
    expect(paceFromSpeed(3.1388801000000006)).toBe("5:19 /km");
    expect(paceFromSpeed(3.0)).toBe("5:33 /km");
    expect(paceFromSpeed(0)).toBeNull();
  });
  it("works out the pace per km of each prediction in code", () => {
    expect(paceFromTime(1490, 5000)).toBe("4:58 /km");
    expect(paceFromTime(3137, 10_000)).toBe("5:14 /km");
    expect(paceFromTime(7060, 21_097.5)).toBe("5:35 /km");
    expect(paceFromTime(15741, 42_195)).toBe("6:13 /km");
  });
  it("formats times as m:ss or h:mm:ss, and reads Garmin's own strings back", () => {
    expect(formatDuration(1490)).toBe("24:50");
    expect(formatDuration(7060)).toBe("1:57:40");
    expect(formatDuration(15741)).toBe("4:22:21");
    expect(parseDuration("23:40")).toBe(1420);
    expect(parseDuration("1:57:36")).toBe(7056);
    expect(parseDuration("22.48 km")).toBeNull();
  });
  it("says how a prediction compares with a record as a plain fact", () => {
    expect(predictionDifference(3137, 3252).text).toBe("predicted 1:55 faster than the record");
    expect(predictionDifference(1490, 1420)).toEqual({ seconds: 70, direction: "slower", text: "predicted 1:10 slower than the record" });
    expect(predictionDifference(7060, 7056).text).toBe("predicted 0:04 slower than the record");
    expect(predictionDifference(7200, 3600).text).toBe("predicted 1:00:00 slower than the record");
    expect(predictionDifference(1420, 1420)).toMatchObject({ direction: "same", text: "predicted the same as the record" });
  });
});

describe("race distance matching", () => {
  it("matches 5K, 10K, half marathon and marathon within 2 percent, and nothing else", () => {
    const m = (metres: number | null) => matchPredictionDistance(metres)?.key ?? null;
    expect(m(5000)).toBe("5K");
    expect(m(10_000)).toBe("10K");
    expect(m(9800)).toBe("10K"); // 2 percent short
    expect(m(10_200)).toBe("10K"); // 2 percent long
    expect(m(10_201)).toBeNull();
    expect(m(21_100)).toBe("half_marathon");
    expect(m(42_195)).toBe("marathon");
    expect(m(15_000)).toBeNull();
    expect(m(8000)).toBeNull();
    expect(m(null)).toBeNull();
    expect(m(0)).toBeNull();
    expect(PREDICTION_DISTANCES).toHaveLength(4);
  });
});

describe("Garmin's endurance classification", () => {
  const t = { intermediate: 4900, trained: 5500, well_trained: 6100, expert: 6800, superior: 7400, elite: 8000 };
  it("places a score in Garmin's band from Garmin's own thresholds", () => {
    expect(enduranceBand(5730, t)).toEqual({ key: "trained", from: 5500, to: 6100 });
    expect(enduranceBand(5500, t)).toEqual({ key: "trained", from: 5500, to: 6100 });
    expect(enduranceBand(6099, t)?.key).toBe("trained");
    expect(enduranceBand(8200, t)).toEqual({ key: "elite", from: 8000, to: null });
    expect(enduranceBand(4000, t)).toBeNull();
  });
});

// ---------------------------------------------------------------- the app
const clockAt = { now: new Date(`${TODAY}T12:30:00Z`) };
async function setup(o: { fake?: { overrides: Record<string, unknown>; fail: Record<string, string> } } = {}) {
  clockAt.now = new Date(`${TODAY}T12:30:00Z`);
  const fake = o.fake ?? { overrides: {} as Record<string, unknown>, fail: {} as Record<string, string> };
  const t = await makeGarminApp({ clock: () => clockAt.now, fake });
  const sync = async (minutes = 5) => {
    clockAt.now = new Date(clockAt.now.getTime() + minutes * 60_000);
    await t.post("/api/sync/garmin");
  };
  const fitness = async () => fitnessResponseSchema.parse(await (await t.get("/api/fitness")).json());
  await sync(0);
  return { t, fake, sync, fitness };
}

describe("race predictions are stored once a day", () => {
  it("two syncs on one day make one row, and the first prediction of the day is kept", async () => {
    const s = await setup();
    s.fake.overrides.get_race_predictions = { prediction_date: TODAY, predictions: { "5K": { time_seconds: 1400 }, "10K": { time_seconds: 3000 }, half_marathon: { time_seconds: 7000 }, marathon: { time_seconds: 15000 } } };
    await s.sync();
    await s.sync();
    const rows = s.t.handle.db.select().from(racePrediction).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seconds).toMatchObject({ "5K": 1490, "10K": 3137, half_marathon: 7060, marathon: 15741 });
  });

  it("a new day adds a row, and the screen says when tracking started, with no sparkline until seven days", async () => {
    const s = await setup();
    for (let day = 1; day <= 5; day++) await s.sync(24 * 60);
    let f = await s.fitness();
    expect(f.predictions.snapshots).toBe(6);
    expect(f.predictions.trackingSince).toBe(TODAY);
    expect(f.predictions.rows.every((r) => r.spark.length === 0)).toBe(true);
    await s.sync(24 * 60);
    await s.sync(24 * 60);
    f = await s.fitness();
    expect(f.predictions.snapshots).toBe(8);
    expect(f.predictions.rows.every((r) => r.spark.length === 8)).toBe(true);
    expect(f.predictions.rows[0]?.spark[0]).toEqual({ date: TODAY, seconds: 1490 });
  });

  it("shows Garmin's time, the pace, the record with its date, and the difference worked out in code", async () => {
    const f = await (await setup()).fitness();
    const by = Object.fromEntries(f.predictions.rows.map((r) => [r.key, r]));
    expect(by["5K"]).toMatchObject({ label: "5K", time: "24:50", pace: "4:58 /km", record: { time: "23:40", date: "2025-09-13" }, difference: { text: "predicted 1:10 slower than the record" } });
    expect(by["10K"]).toMatchObject({ time: "52:17", pace: "5:14 /km", record: { time: "54:12", date: "2025-09-12" }, difference: { direction: "faster", text: "predicted 1:55 faster than the record" } });
    expect(by.half_marathon).toMatchObject({ time: "1:57:40", record: { time: "1:57:36" }, difference: { text: "predicted 0:04 slower than the record" } });
    expect(by.marathon).toMatchObject({ time: "4:22:21", pace: "6:13 /km", record: null, difference: null }); // no marathon record
    expect(f.predictions.date).toBe(TODAY);
  });
});

describe("personal records", () => {
  it("shows running records only, in order, with their dates, and no cycling or step records", async () => {
    const f = await (await setup()).fitness();
    expect(f.records.items.map((r) => [r.label, r.value, r.date])).toEqual([
      ["1K", "4:33", "2025-09-13"], ["Mile", "7:20", "2025-09-13"], ["5K", "23:40", "2025-09-13"], ["10K", "54:12", "2025-09-12"], ["Half marathon", "1:57:36", "2025-09-28"], ["Longest run", "22.48 km", "2025-08-17"],
    ]);
    expect(JSON.stringify(f.records)).not.toMatch(/ride|cycling|steps/i);
  });

  it("does not tag old records as new on the first import", async () => {
    const f = await (await setup()).fitness();
    expect(f.records.items.every((r) => !r.isNew)).toBe(true);
    expect((await setup()).t.handle.db.select().from(personalRecord).orderBy(asc(personalRecord.typeId)).all()[0]?.firstSeen).toBe("2025-09-13");
  });

  it("detects a changed record, stores the day it was first seen, tags it New for 14 days, and leaves the others alone", async () => {
    const s = await setup();
    const recs = (payloads.get_personal_record as { record_type: string; type_id: number; value: string; raw_value: number; date: string }[]).map((r) => (r.record_type === "Fastest 10K" ? { ...r, value: "51:40", raw_value: 3100, date: "2026-11-09" } : r));
    s.fake.overrides.get_personal_record = recs;
    await s.sync(24 * 60); // 08/11
    let f = await s.fitness();
    const ten = f.records.items.find((r) => r.key === "10K");
    expect(ten).toMatchObject({ value: "51:40", date: "2026-11-09", isNew: true });
    expect(f.records.items.filter((r) => r.isNew)).toHaveLength(1);
    expect(f.predictions.rows.find((r) => r.key === "10K")?.difference?.text).toBe("predicted 0:37 slower than the record"); // 52:17 against 51:40
    const stored = s.t.handle.db.select().from(personalRecord).all().find((r) => r.key === "10K");
    expect(stored?.firstSeen).toBe("2026-11-08");
    // The same value again changes nothing, and after 14 days the tag goes.
    await s.sync(60);
    expect(s.t.handle.db.select().from(personalRecord).all().find((r) => r.key === "10K")?.firstSeen).toBe("2026-11-08");
    clockAt.now = new Date("2026-11-23T12:00:00Z");
    f = await s.fitness();
    expect(f.records.items.find((r) => r.key === "10K")?.isNew).toBe(false);
  });
});

describe("Garmin's other fitness figures", () => {
  it("shows the endurance score with Garmin's own label, its thresholds, its band and the weekly averages", async () => {
    const e = (await (await setup()).fitness()).endurance;
    expect(e).toMatchObject({ score: 5730, date: "2026-11-08", classification: "trained", classificationLabel: "Trained", band: { key: "trained", from: 5500, to: 6100 } });
    expect(e?.thresholds.map((t) => [t.label, t.value])).toEqual([["Intermediate", 4900], ["Trained", 5500], ["Well trained", 6100], ["Expert", 6800], ["Superior", 7400], ["Elite", 8000]]);
    expect(e?.scale).toEqual({ lo: 4300, hi: 8000 });
    expect(e?.weekly.map((w) => w.avg)).toEqual([5770, 5755, 5740, 5735, 5731]);
  });
  it("shows the hill score and the lactate threshold, with the pace worked out in code", async () => {
    const f = await (await setup()).fitness();
    expect(f.hill).toMatchObject({ overall: 36, strength: 19, endurance: 15, date: "2026-11-08" });
    expect(f.lactate).toMatchObject({ heartRate: 162, pace: "5:19 /km", measuredOn: "2026-11-04" });
    expect(f.vo2max.current?.value).toBe(45.7);
  });
  it("shows none of Garmin's training status or load focus phrases, and no running tolerance", async () => {
    const f = JSON.stringify(await (await setup()).fitness());
    expect(f).not.toMatch(/PRODUCTIVE|ANAEROBIC|feedback|tolerance|training_status/i);
  });
});

describe("stale and failed kinds keep their last value", () => {
  it("a failed fetch leaves the last figures on show, with their age and the error, never a blank", async () => {
    const s = await setup();
    s.fake.fail.get_hill_score = "Read timed out";
    s.fake.fail.get_lactate_threshold = "Read timed out";
    s.fake.fail.get_personal_record = "Read timed out";
    s.fake.fail.get_endurance_score = "Read timed out";
    s.fake.fail.get_race_predictions = "Read timed out";
    await s.sync(180);
    const f = await s.fitness();
    expect(f.hill).toMatchObject({ overall: 36, stale: true });
    expect(f.hill?.lastError).toContain("timed out");
    expect(f.hill?.ageMinutes).toBeGreaterThanOrEqual(180);
    expect(f.lactate).toMatchObject({ heartRate: 162, stale: true });
    expect(f.endurance).toMatchObject({ score: 5730, stale: true });
    expect(f.records.items).toHaveLength(6);
    expect(f.records.stale).toBe(true);
    expect(f.predictions.rows[0]?.time).toBe("24:50");
    expect(f.predictions.stale).toBe(true);
    expect(s.t.handle.db.select().from(syncState).all().find((r) => r.job === "garmin:hill")?.consecutiveFailures).toBeGreaterThan(0);
  });
  it("before the first sync there is nothing to show, and the screen says so plainly", async () => {
    const t = await makeGarminApp({ clock: () => clockAt.now });
    const f = fitnessResponseSchema.parse(await (await t.get("/api/fitness")).json());
    expect(f.hill).toBeNull();
    expect(f.endurance).toBeNull();
    expect(f.lactate).toBeNull();
    expect(f.records.items).toEqual([]);
    expect(f.predictions.rows.every((r) => r.time === null)).toBe(true);
    expect((await req(t.app, "/api/fitness")).status).toBe(401);
  });
});

describe("the race lead-up shows Garmin's prediction for the distance", () => {
  const RHINO = "2026-11-14|rhino run west bridgford";
  it("states it as a fact for a 10K, a half and a marathon", async () => {
    const s = await setup();
    const l = leadUpResponseSchema.parse(await (await s.t.get(`/api/leadup?race=${encodeURIComponent(RHINO)}`)).json());
    expect(l.leadUp.prediction).toEqual({ distance: "10K", time: "52:17", date: TODAY });
    const plod = leadUpResponseSchema.parse(await (await s.t.get(`/api/leadup?race=${encodeURIComponent("2027-03-14|pierrepont plod spring 27")}`)).json());
    expect(plod.leadUp.prediction).toEqual({ distance: "Half marathon", time: "1:57:40", date: TODAY }); // 21.1 km is within 2 percent of a half
    const marathon = leadUpResponseSchema.parse(await (await s.t.get(`/api/leadup?race=${encodeURIComponent("549c1bbe-991c-492a-9511-e59aa0733386")}`)).json());
    expect(marathon.leadUp.prediction).toEqual({ distance: "Marathon", time: "4:22:21", date: TODAY });
  });
  it("shows nothing before any prediction is stored", async () => {
    const t = await makeGarminApp({ clock: () => clockAt.now });
    const res = await t.get(`/api/leadup?race=${encodeURIComponent(RHINO)}`);
    expect(res.status).toBe(404); // no races yet either
  });
});

describe("for the AI: figures and dates, no judgement", () => {
  it("get_fitness_summary returns Garmin's figures with dates, labels as Garmin's, and nothing that interprets them", async () => {
    const s = await setup();
    const out = runTool("get_fitness_summary", {}, { db: s.t.handle.db, now: clockAt.now });
    expect(out).toContain('"predicted":"52:17"');
    expect(out).toContain('"differenceFromRecord":"predicted 1:55 faster than the record"');
    expect(out).toContain('"garminClassification":"trained"');
    expect(out).toContain('"garminThresholds":{"intermediate":4900');
    expect(out).toContain('"pacePerKm":"5:19 /km"');
    expect(out).toContain("history starts on the first day the app stored one");
    expect(out).not.toMatch(/recommend|should|good|poor|improv|target|advice/i);
  });
  it("the system prompt forbids judging a figure", async () => {
    const { SYSTEM_PROMPT } = await import("../src/modules/ai/prompts.js");
    expect(SYSTEM_PROMPT).toContain("Never say whether a prediction, score or record is good, bad, high, low or improving");
  });
});

describe("read only", () => {
  it("the new tools are get_ tools on the allowlist, and no write tool is reachable", () => {
    for (const t of ["get_personal_record", "get_hill_score", "get_lactate_threshold", "get_race_predictions", "get_endurance_score", "get_vo2max_trend"]) expect(GARMIN_READ_TOOLS).toContain(t);
    expect(GARMIN_READ_TOOLS.every((t) => t.startsWith("get_"))).toBe(true);
    for (const w of ["set_personal_record", "delete_personal_record", "set_lactate_threshold", "set_heart_rate_zones", "update_hill_score"]) expect(() => assertReadTool(w)).toThrow(/not on the read-only allowlist/);
  });
});
