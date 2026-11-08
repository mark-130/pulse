import type { FitnessResponse } from "@pulse/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TrendsScreen } from "@/screens/Trends";
import { FitnessView } from "./FitnessTab";

const fresh = { fetchedAt: "2026-11-08T20:00:00Z", ageMinutes: 5, stale: false, lastError: null };
const spark = (n: number) => Array.from({ length: n }, (_, i) => ({ date: `2026-11-0${i + 1}`, seconds: 3137 - i }));
const base: FitnessResponse = {
  predictions: {
    date: "2026-11-08", trackingSince: "2026-11-08", snapshots: 1, ...fresh,
    rows: [
      { key: "5K", label: "5K", seconds: 1490, time: "24:50", pace: "4:58 /km", record: { time: "23:40", seconds: 1420, date: "2025-09-13" }, difference: { seconds: 70, direction: "slower", text: "predicted 1:10 slower than the record" }, spark: [] },
      { key: "10K", label: "10K", seconds: 3137, time: "52:17", pace: "5:14 /km", record: { time: "54:12", seconds: 3252, date: "2025-09-12" }, difference: { seconds: 115, direction: "faster", text: "predicted 1:55 faster than the record" }, spark: [] },
      { key: "half_marathon", label: "Half marathon", seconds: 7060, time: "1:57:40", pace: "5:35 /km", record: { time: "1:57:36", seconds: 7056, date: "2025-09-28" }, difference: { seconds: 4, direction: "slower", text: "predicted 0:04 slower than the record" }, spark: [] },
      { key: "marathon", label: "Marathon", seconds: 15741, time: "4:22:21", pace: "6:13 /km", record: null, difference: null, spark: [] },
    ],
  },
  vo2max: { points: [{ date: "2026-10-10", value: 46.5, carriedForward: true }, { date: "2026-11-08", value: 45.9, carriedForward: false }], current: { date: "2026-11-08", value: 45.9, carriedForward: false }, change30: { direction: "down", delta: -0.6, text: "Down 0.6 over 30 days" }, stored: { from: "2026-10-10", to: "2026-11-08" }, ...fresh },
  endurance: {
    score: 5730, date: "2026-11-08", classification: "trained", classificationLabel: "Trained",
    thresholds: [["intermediate", "Intermediate", 4900], ["trained", "Trained", 5500], ["well_trained", "Well trained", 6100], ["expert", "Expert", 6800], ["superior", "Superior", 7400], ["elite", "Elite", 8000]].map(([key, label, value]) => ({ key: key as string, label: label as string, value: value as number })),
    band: { key: "trained", from: 5500, to: 6100 }, scale: { lo: 4300, hi: 8000 }, weekly: [{ weekStart: "2026-10-05", avg: 5770 }, { weekStart: "2026-10-12", avg: 5755 }, { weekStart: "2026-10-19", avg: 5740 }], ...fresh,
  },
  hill: { overall: 36, strength: 19, endurance: 15, date: "2026-11-08", ...fresh },
  lactate: { heartRate: 162, speedMps: 3.1388801, pace: "5:19 /km", measuredOn: "2026-11-04", ...fresh },
  records: {
    items: [
      { key: "1k", label: "1K", value: "4:33", date: "2025-09-13", isNew: false }, { key: "mile", label: "Mile", value: "7:20", date: "2025-09-13", isNew: false }, { key: "5K", label: "5K", value: "23:40", date: "2025-09-13", isNew: false },
      { key: "10K", label: "10K", value: "51:40", date: "2026-11-09", isNew: true }, { key: "half_marathon", label: "Half marathon", value: "1:57:36", date: "2025-09-28", isNew: false }, { key: "longest_run", label: "Longest run", value: "22.48 km", date: "2025-08-17", isNew: false },
    ],
    ...fresh,
  },
};
const html = (f: FitnessResponse) => renderToStaticMarkup(<FitnessView f={f} />);
const visible = (f: FitnessResponse) => html(f).replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("race predictions card", () => {
  it("shows four rows: Garmin's time, the pace per km, the record with its date, and the difference as a fact", () => {
    const v = visible(base);
    for (const t of ["24:50", "4:58 /km", "52:17", "5:14 /km", "1:57:40", "5:35 /km", "4:22:21", "6:13 /km"]) expect(v).toContain(t);
    expect(v).toContain("Personal record 23:40, 13/09/2025");
    expect(v).toContain("Personal record 54:12, 12/09/2025");
    expect(v).toContain("10K: predicted 1:55 faster than the record");
    expect(v).toContain("5K: predicted 1:10 slower than the record");
    expect(v).toContain("Half marathon: predicted 0:04 slower than the record");
  });
  it("a distance with no record shows no record line and no difference", () => {
    const row = /<li[^>]*>(?:(?!<\/li>)[\s\S])*>Marathon<\/p>(?:(?!<\/li>)[\s\S])*<\/li>/.exec(html(base))?.[0] ?? "";
    expect(row).toContain("4:22:21");
    expect(row).not.toContain("Personal record");
    expect(row).not.toContain("than the record");
  });
  it("says when tracking started and that a trend line comes after 7 days, and has the footnote", () => {
    const v = visible(base);
    expect(v).toContain("Tracking since 08/11/2026, 1 day so far. A trend line appears after 7 days.");
    expect(v).toContain("Garmin cannot give past predictions.");
    expect(v).toContain("Garmin's predictions are estimates based on VO2 max and recent training.");
  });
  it("draws a sparkline per distance only once seven or more daily snapshots exist", () => {
    expect(html(base)).not.toContain("prediction over");
    const withSpark = { ...base, predictions: { ...base.predictions, snapshots: 7, rows: base.predictions.rows.map((r) => ({ ...r, spark: spark(7) })) } };
    expect(html(withSpark).match(/prediction over 7 days/g)).toHaveLength(4);
    expect(visible(withSpark)).toContain("Tracking since 08/11/2026.");
  });
});

describe("fitness metric cards", () => {
  it("shows the endurance score with Garmin's own label and thresholds, and a scale", () => {
    const h = html(base);
    const v = visible(base);
    expect(v).toContain("5730");
    expect(v).toContain("Trained (Garmin's classification)");
    expect(v).toContain("Garmin's band: 5500 to under 6100.");
    expect(v).toContain("Garmin's thresholds");
    for (const t of ["Intermediate 4900", "Trained 5500", "Well trained 6100", "Expert 6800", "Superior 7400", "Elite 8000"]) expect(v).toContain(t);
    expect(h).toContain("Garmin&#x27;s thresholds are Intermediate 4900");
    expect(v).toContain("Weekly average, 3 weeks");
    expect(v.match(/Endurance score/g)).toHaveLength(1); // the card title, not repeated inside the card
  });
  it("shows VO2 max, hill score and lactate threshold with the pace per km and the date measured", () => {
    const v = visible(base);
    expect(v).toContain("45.9");
    expect(v).toContain("Down 0.6 over 30 days");
    expect(v).toContain("36 overall on 08/11/2026");
    expect(v).toMatch(/Strength\s+19/);
    expect(v).toMatch(/Endurance\s+15/);
    expect(v).toContain("162 bpm");
    expect(v).toContain("5:19 /km");
    expect(v).toContain("Measured 04/11/2026");
  });
  it("does not show Garmin's training status or load focus phrases, or running tolerance", () => {
    expect(visible(base)).not.toMatch(/productive|anaerobic shortage|load focus|tolerance|training status/i);
  });
});

describe("personal records card", () => {
  it("lists running records with dates, tags only the new one, and has no cycling or step records", () => {
    const v = visible(base);
    for (const t of ["1K", "Mile", "5K", "10K", "Half marathon", "Longest run", "22.48 km", "17/08/2025"]) expect(v).toContain(t);
    expect(html(base).match(/>New</g)).toHaveLength(1);
    expect(v).toMatch(/10K New/);
    expect(v).not.toMatch(/ride|cycling|steps/i);
  });
});

describe("footer, stale and empty states", () => {
  it("ends with the footer and interprets nothing", () => {
    expect(visible(base)).toContain("From Garmin. Pulse reports these figures and does not interpret them.");
    expect(visible(base)).not.toMatch(/good|bad|excellent|poor|should|recommend|improv/i);
  });
  it("a stale or failed kind keeps its last value and says how old it is", () => {
    const stale = { stale: true, ageMinutes: 300, lastError: "Read timed out" };
    const v = visible({ ...base, hill: { ...(base.hill as NonNullable<FitnessResponse["hill"]>), ...stale }, records: { ...base.records, ...stale }, predictions: { ...base.predictions, ...stale } });
    expect(v).toContain("36 overall");
    expect(v).toContain("Showing the last score Garmin gave, 5 hours old, the latest update failed.");
    expect(v).toContain("Showing the last records Garmin gave, 5 hours old, the latest update failed.");
    expect(v).toContain("Showing the last predictions Garmin gave, 5 hours old, the latest update failed.");
    expect(v).toContain("24:50");
  });
  it("says plainly when there is nothing yet, never a blank card", () => {
    const empty: FitnessResponse = { ...base, predictions: { ...base.predictions, rows: base.predictions.rows.map((r) => ({ ...r, seconds: null, time: null, pace: null, record: null, difference: null })), trackingSince: null, snapshots: 0 }, endurance: null, hill: null, lactate: null, records: { ...base.records, items: [] } };
    const v = visible(empty);
    for (const t of ["No predictions yet", "No endurance score yet", "No hill score yet", "No lactate threshold yet", "No records yet", "Not tracking yet."]) expect(v).toContain(t);
  });
});

describe("the Fitness tab on Trends", () => {
  function screen(url: string) {
    const qc = new QueryClient();
    qc.setQueryData(["fitness"], base);
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <TrendsScreen />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }
  it("is a second tab beside Readings, not a bottom nav item, and both tabs are 44px tall", () => {
    const h = screen("/trends?tab=fitness");
    expect(h).toContain('role="tablist"');
    expect(h.match(/role="tab"/g)).toHaveLength(2);
    expect(h).toContain("Readings");
    expect(h).toContain("Fitness");
    expect(h.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(2);
    expect(h).toContain('aria-selected="true"');
    expect(h).toContain("Race predictions");
  });
  it("opens on Readings by default, without the Fitness cards", () => {
    const h = screen("/trends");
    expect(h).not.toContain("Race predictions");
  });
});
