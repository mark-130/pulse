import type { Vo2Point, ZonesResponse } from "@pulse/shared";
import { describe, expect, it } from "vitest";
import { barSpans, checkTops, notImportedNote, parseTops, rangeText, sparkPoints, vo2Ranges } from "./zones";

const kotcha: ZonesResponse["kotcha"]["zones"] = [
  { zone: 1, name: "Recovery", from: null, top: 128 }, { zone: 2, name: "Aerobic Endurance", from: 129, top: 143 }, { zone: 3, name: "Aerobic Power", from: 144, top: 150 },
  { zone: 4, name: "Threshold", from: 151, top: 157 }, { zone: 5, name: "Anaerobic", from: 158, top: 180 },
];

describe("zone wording and bars", () => {
  it("writes zone 1 as up to its top and the rest as a range", () => {
    expect(rangeText(null, 128)).toBe("up to 128 bpm");
    expect(rangeText(129, 143)).toBe("129 to 143 bpm");
  });
  it("sizes the bars on one scale: zone 5 is the widest, zones sit end to end and the last one ends at the max", () => {
    const b = barSpans(kotcha, 103);
    expect(b).toHaveLength(5);
    expect(b[4]?.width).toBeGreaterThan(b[3]?.width ?? 0);
    expect(b[1]?.left).toBeGreaterThan(b[0]?.left ?? 0);
    const last = b[4];
    expect((last?.left ?? 0) + (last?.width ?? 0)).toBeCloseTo(100, 5);
    for (const s of b) expect(s.width).toBeGreaterThanOrEqual(2);
  });
});

describe("edit sheet checks", () => {
  it("accepts the seed values and rejects the same mistakes the server does", () => {
    expect(checkTops(["128", "143", "150", "157", "180"], 180)).toEqual([]);
    expect(checkTops(["128", "143", "150", "157", "179"], 180).join(" ")).toMatch(/Zone 5 must equal your max heart rate, 180/);
    expect(checkTops(["128", "128", "150", "157", "180"], 180).join(" ")).toMatch(/Zone 2 must be higher than zone 1/);
    expect(checkTops(["128.5", "143", "150", "157", "180"], 180).join(" ")).toMatch(/Zone 1 must be a whole number/);
    expect(checkTops(["", "143", "150", "157", "180"], 180).join(" ")).toMatch(/Zone 1 must be a whole number/);
    expect(checkTops(["128", "143", "150", "157", "180"], null).join(" ")).toMatch(/not known yet/);
  });
  it("reads only plain whole numbers", () => {
    expect(parseTops([" 128 ", "1e2", "-5", "12.0", "0x10"]).map((n) => (Number.isNaN(n) ? "NaN" : n))).toEqual([128, "NaN", "NaN", "NaN", "NaN"]);
  });
});

describe("sparkline", () => {
  const p = (date: string, value: number, carriedForward = false): Vo2Point => ({ date, value, carriedForward });
  it("places points by date and value and keeps the carried-forward flag", () => {
    const s = sparkPoints([p("2026-10-10", 46.5, true), p("2026-10-25", 46.0), p("2026-11-08", 45.9)], 280, 56);
    expect(s.map((x) => x.carried)).toEqual([true, false, false]);
    expect(s[0]?.x).toBeLessThan(s[1]?.x ?? 0);
    expect(s[0]?.y).toBeLessThan(s[2]?.y ?? 0); // a higher value is nearer the top
    expect(sparkPoints([], 280, 56)).toEqual([]);
  });
});

describe("Trends VO2 max ranges", () => {
  it("offers 4 weeks and 3 months, and 12 months only once more than 100 days are stored", () => {
    expect(vo2Ranges("2026-08-09", "2026-11-08").map((r) => r.label)).toEqual(["4 weeks", "3 months"]);
    expect(vo2Ranges(null, "2026-11-08").map((r) => r.label)).toEqual(["4 weeks", "3 months"]);
    expect(vo2Ranges("2026-01-01", "2026-11-08").map((r) => r.label)).toEqual(["4 weeks", "3 months", "12 months"]);
  });
  it("says Not imported yet when the range starts before the stored data", () => {
    expect(notImportedNote(90, "2026-09-10", "2026-11-08")).toBe("Not imported yet before 10/09/2026.");
    expect(notImportedNote(28, "2026-09-10", "2026-11-08")).toBeNull();
    expect(notImportedNote(365, null, "2026-11-08")).toBeNull();
  });
});
