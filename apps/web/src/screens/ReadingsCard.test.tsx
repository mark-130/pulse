import type { TodayResponse } from "@pulse/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReadingsCard } from "./Today";

const lines = [
  "Garmin training readiness 63 out of 100 (moderate) on 07/11, 7 day average 70: below.",
  "HRV 45 ms on 07/11, baseline 36 to 41 ms: above baseline.",
  "Sleep score 89 on 07/11, 7 day average 82: above.",
  "Resting heart rate 45 bpm on 07/11, 7 day average 47 bpm: 2 bpm below.",
  "Body battery peaked at 100 on 07/11, 5 day average peak 100: in line.",
  "Acute load 699 against chronic 436, ratio 1.6 on 07/11: acute above chronic.",
  "Scheduled today in Garmin: 1h50 Long Run, 110 min.",
];
const data = (state: "strong" | "mixed" | "low" | "unknown", label: string, l = lines): TodayResponse =>
  ({
    date: "2026-11-07", syncedAt: "2026-11-07T12:00:00Z", proposals: { pending: 0 },
    readings: { state, label, lines: l, signals: [], points: 2, scheduledToday: null, healthNote: "If you are ill, in pain or injured, rest and see a doctor or physio. This is not medical advice." },
    readiness: { date: "2026-11-07", score: 63, level: "MODERATE", feedback: null, sleepScore: null, recoveryTimeHours: null, acuteLoad: null },
  }) as unknown as TodayResponse;
const html = (d: TodayResponse) => renderToStaticMarkup(<ReadingsCard data={d} />);

describe("today's readings card", () => {
  it("shows the neutral label and every reading as a fact, in order", () => {
    const h = html(data("mixed", "Readings: mixed"));
    expect(h).toContain("Today&#x27;s readings");
    expect(h).toContain("Readings: mixed");
    for (const l of lines) expect(h).toContain(l.replace(/'/g, "&#x27;"));
    expect(h.indexOf("HRV 45")).toBeLessThan(h.indexOf("Sleep score 89"));
    expect(h).toContain("Garmin&#x27;s own readiness score");
  });
  it("has no disclosure, so every line shows", () => {
    expect(html(data("mixed", "Readings: mixed"))).not.toContain("<details");
  });
  it("uses all four labels and never an old one", () => {
    for (const [state, label] of [["strong", "Readings: strong"], ["mixed", "Readings: mixed"], ["low", "Readings: low"], ["unknown", "Readings: not enough data"]] as const) {
      const h = html(data(state, label));
      expect(h).toContain(label);
      expect(h).not.toMatch(/Go as planned|Go but easier|Swap for recovery|No verdict|verdict/i);
    }
  });
  it("keeps the illness note under the card", () => {
    expect(html(data("low", "Readings: low"))).toContain("rest and see a doctor or physio");
  });
});
