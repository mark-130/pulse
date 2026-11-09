import type { SyncStatus, TodayResponse, Vo2Response, WeekResponse } from "@pulse/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { weekTile } from "@/lib/today";
import { Metrics, Vo2Tile, WeekTile } from "./Today";

const today = "2026-11-09";
const job = { lastOk: "2026-11-09T08:00:00Z", lastAttempt: null, lastError: null, consecutiveFailures: 0, detail: null, ageMinutes: 5, stale: false };
const group = (id: SyncStatus["groups"][number]["id"], label: string, critical: boolean, stale = false) => ({ id, label, plural: id === "activities" || id === "trends", critical, lastOk: "2026-11-09T08:00:00Z", ageMinutes: stale ? 200 : 5, stale, lastError: null });
const status = (staleActivities = false): SyncStatus => ({ now: "2026-11-09T08:05:00Z", staleAfterMinutes: 90, garmin: job, groups: [group("plan", "the plan", true), group("readiness", "readiness", true), group("activities", "activities", false, staleActivities), group("trends", "trends", false)], alertsEnabled: false, backup: job });

const vo2 = (o: Partial<Vo2Response> = {}): Vo2Response => ({
  points: [
    { date: "2026-10-10", value: 46.5, carriedForward: false },
    { date: "2026-10-20", value: 46.5, carriedForward: true },
    { date: "2026-11-07", value: 45.7, carriedForward: false },
  ],
  current: { date: "2026-11-07", value: 45.7, carriedForward: false },
  change30: { direction: "down", delta: -0.8, text: "Down 0.8 over 30 days" },
  stored: { from: "2026-10-10", to: "2026-11-07" }, fetchedAt: "2026-11-09T08:00:00Z", ageMinutes: 5, stale: false, lastError: null, ...o,
});

const act = (type: string, distanceM: number | null) => ({ id: "x", name: "Run", type, startLocal: "x", date: "x", distanceM, durationS: null, avgHr: null, maxHr: null, calories: null });
const week = (): WeekResponse => ({
  start: "2026-11-09", end: "2026-11-15", today, syncedAt: "2026-11-09T08:00:00Z",
  days: [
    { date: "2026-11-09", workouts: [], activities: [act("running", 7864.2), act("strength_training", null)] },
    { date: "2026-11-10", workouts: [], activities: [] },
    { date: "2026-11-11", workouts: [], activities: [act("running", 9000)] },
    { date: "2026-11-12", workouts: [], activities: [] }, { date: "2026-11-13", workouts: [], activities: [] }, { date: "2026-11-14", workouts: [], activities: [] }, { date: "2026-11-15", workouts: [], activities: [] },
  ],
  totals: { distanceM: 16864.2, durationS: 6600, runs: 2 },
});
const t = { ...week(), today: "2026-11-11" };

const todayData = (o: Partial<TodayResponse["metrics"]> = {}): TodayResponse =>
  ({
    date: today, syncedAt: "2026-11-09T08:00:00Z", proposals: { pending: 0 },
    metrics: {
      sleep: { date: today, score: 89, hours: 10.98, qualifier: "GOOD" },
      hrv: { date: today, lastNightAvg: 45, weeklyAvg: 38, baselineLow: 36, baselineUpper: 41, status: "BALANCED" },
      restingHr: { date: today, bpm: 45, sevenDayAvg: 47 },
      bodyBattery: { date: today, current: 61, highest: 100, lowest: 52, charged: 52, drained: 43 },
      ...o,
    },
  }) as unknown as TodayResponse;

function render(node: React.ReactElement, opts: { vo2?: Vo2Response | null; week?: WeekResponse | null; status?: SyncStatus } = {}): string {
  const qc = new QueryClient();
  if (opts.vo2 !== null) qc.setQueryData(["vo2max", 30], opts.vo2 ?? vo2());
  if (opts.week !== null) qc.setQueryData(["week", null], opts.week ?? week());
  qc.setQueryData(["sync-status"], opts.status ?? status());
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}
const tiles = (h: string) => h.slice(h.indexOf('data-testid="reading-tiles"'));

describe("the readings grid", () => {
  it("renders six tiles: sleep, HRV, resting HR, body battery, VO2 max and this week", () => {
    const h = render(<Metrics data={todayData()} />);
    const grid = tiles(h);
    expect(grid.match(/class="card /g)).toHaveLength(6);
    for (const label of ["Sleep", "HRV", "Resting HR", "Body battery", "VO2 max", "This week"]) expect(grid).toContain(label);
    expect(grid.indexOf("Body battery")).toBeLessThan(grid.indexOf("VO2 max"));
    expect(grid.indexOf("VO2 max")).toBeLessThan(grid.indexOf("This week"));
  });

  it("never leaves an empty cell: 6 tiles fill 2 columns (3 rows) and 3 columns (2 rows), capped at 3, across the full width", () => {
    const grid = render(<Metrics data={todayData()} />);
    expect(grid).toContain("grid-cols-2");
    expect(grid).toContain("min-[900px]:grid-cols-3");
    expect(grid).not.toMatch(/grid-cols-[456]|col-span-[2-9]\s[^"]*"\s+data-testid/); // no wider grid and no tile that spans columns
    expect(6 % 2).toBe(0);
    expect(6 % 3).toBe(0);
    // The wrapper spans all six columns of the Today grid, so the tiles use the full content width, not two thirds.
    expect(grid.startsWith('<div class="md:col-span-6">')).toBe(true);
    expect(grid).not.toContain("md:col-span-4");
  });

  it("the separate VO2 max card is gone from Today, so nothing is shown twice", () => {
    const src = readFileSync(join(import.meta.dirname, "./Today.tsx"), "utf8");
    expect(src).not.toContain("<Vo2Card");
    expect(src).not.toContain("md:col-span-4\">\n      <div className=\"grid grid-cols-2 gap-3\"");
    expect(render(<Metrics data={todayData()} />).match(/VO2 max/g)?.length).toBeGreaterThanOrEqual(1);
    expect(render(<Metrics data={todayData()} />).match(/<h2/g)).toBeNull(); // tiles have no card heading of their own
  });

  it("the four Garmin tiles keep their last value and say how old it is", () => {
    const h = tiles(render(<Metrics data={todayData({ sleep: { date: "2026-11-07", score: 89, hours: 10.98, qualifier: "GOOD" } })} />));
    expect(h).toContain("89");
    expect(h).toContain("Good, 11.0 h, from 07/11/2026");
  });
});

describe("VO2 max tile", () => {
  it("shows the current value, the 30 day change from the existing calculation, the date, and a sparkline with carried-forward days lighter", () => {
    const h = render(<Vo2Tile />);
    expect(h).toContain("45.7");
    expect(h).toContain("ml/kg/min");
    expect(h).toContain("Down 0.8 over 30 days, on 07/11/2026");
    expect(h).toContain('data-carried="true"');
    expect(h).toContain('fill-opacity="0.3"');
    expect(h).toContain('data-carried="false"');
  });
  it("says Up, Down or No change in words", () => {
    expect(render(<Vo2Tile />, { vo2: vo2({ change30: { direction: "up", delta: 0.4, text: "Up 0.4 over 30 days" } }) })).toContain("Up 0.4 over 30 days");
    expect(render(<Vo2Tile />, { vo2: vo2({ change30: { direction: "none", delta: 0, text: "No change over 30 days" } }) })).toContain("No change over 30 days");
  });
  it("opens Trends on the VO2 max chart, and the whole tile is a 44px tap target", () => {
    const h = render(<Vo2Tile />);
    expect(h).toMatch(/<a [^>]*class="card block min-h-11[^>]*href="\/trends#vo2max"/);
    expect(h).toContain("Open the chart on Trends.");
  });
  it("a stale or failed update keeps the last value with its age, never a blank", () => {
    const h = render(<Vo2Tile />, { vo2: vo2({ stale: true, ageMinutes: 200, lastError: "Read timed out" }) });
    expect(h).toContain("45.7");
    expect(h).toContain("Showing the last value Garmin gave, 3 hours old, the latest update failed.");
  });
  it("with no data it says so instead of leaving a gap, and still opens the chart", () => {
    const h = render(<Vo2Tile />, { vo2: vo2({ points: [], current: null, change30: null }) });
    expect(h).toContain("No data yet");
    expect(h).toContain("--");
    expect(h).toContain('href="/trends#vo2max"');
  });
});

describe("this week tile", () => {
  it("shows distance, minutes and runs from the Week screen's own totals", () => {
    const h = render(<WeekTile />);
    expect(h).toContain("16.9");
    expect(h).toContain("km");
    expect(h).toContain("110 min, 2 runs, Monday to today");
    expect(h).toContain("This week");
  });
  it("is the same calculation as the Week screen: the tile reads the totals the Week screen shows", () => {
    expect(weekTile(week())).toMatchObject({ km: "16.9", minutes: 110, runs: 2 });
    expect(weekTile({ ...week(), totals: { distanceM: 0, durationS: 0, runs: 0 } })).toMatchObject({ km: "0.0", minutes: 0, runs: 0 });
    const src = readFileSync(join(import.meta.dirname, "../lib/today.ts"), "utf8");
    expect(src).toContain("w.totals.distanceM");
    expect(src).toContain("w.totals.durationS");
    expect(src).toContain("w.totals.runs");
  });
  it("draws a thin 7 day line of daily running distance that stops at today, with no bar, target or interpretation", () => {
    expect(weekTile(t).daily).toEqual([7.9, 0, 9, null, null, null, null]);
    const h = render(<WeekTile />, { week: t });
    expect(h).toContain('data-points="3"');
    expect(h).toContain("Daily running distance this week, Monday to today: 7.9 km, 0 km, 9 km, not yet, not yet, not yet, not yet");
    expect(h).not.toMatch(/target|goal|progress|%|on track|behind|ahead/i);
    expect(h).not.toContain('role="progressbar"');
  });
  it("opens Week, as a 44px tap target", () => {
    expect(render(<WeekTile />)).toMatch(/<a [^>]*class="card block min-h-11[^>]*href="\/week"/);
  });
  it("on a Monday with one day of data it still shows a point, not a blank", () => {
    const monday = { ...week(), today: "2026-11-09" };
    expect(weekTile(monday).daily).toEqual([7.9, null, null, null, null, null, null]);
    expect(render(<WeekTile />, { week: monday })).toContain('data-points="1"');
  });
  it("stale activities keep the last values and add the quiet note with the age; a week that has not loaded says Loading", () => {
    const h = render(<WeekTile />, { status: status(true) });
    expect(h).toContain("16.9");
    expect(h).toContain("Activities are 3 hours old. Retrying automatically.");
    const loading = render(<WeekTile />, { week: null });
    expect(loading).toContain("Loading");
    expect(loading).toContain("--");
  });
});
