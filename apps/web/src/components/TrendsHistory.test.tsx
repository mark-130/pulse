import type { HistorySeries, YearOnYear } from "@pulse/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RangePicker } from "./RangePicker";
import { ReadingsChartView } from "./ReadingsChart";
import { YearOnYearView } from "./YearOnYearCard";

const series: HistorySeries = {
  from: "2024-11-10", to: "2026-11-09",
  series: [
    { id: "sleep", label: "Sleep score", unit: "score", points: [{ date: "2026-10-20", value: 70, avg7: 70 }, { date: "2026-10-21", value: 80, avg7: 75 }], stored: { from: "2025-06-01", to: "2026-10-21" } },
    { id: "hrv", label: "HRV", unit: "ms", points: [], stored: null },
    { id: "rhr", label: "Resting heart rate", unit: "bpm", points: [], stored: null },
    { id: "readiness", label: "Training readiness", unit: "score", points: [], stored: null },
    { id: "body_battery", label: "Body battery charged", unit: "", points: [], stored: null },
  ],
};
const noop = () => undefined;

describe("trends range choices", () => {
  it("offers 4 weeks, 3 months, 12 months and 24 months, 44px tall, with the chosen one pressed", () => {
    const h = renderToStaticMarkup(<RangePicker days={365} onPick={noop} />);
    for (const l of ["4 weeks", "3 months", "12 months", "24 months"]) expect(h).toContain(l);
    expect(h.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(h.match(/min-h-11/g)).toHaveLength(4);
    expect(h).toContain("grid-cols-2"); // two by two on a narrow screen
  });
});

describe("daily readings chart", () => {
  it("has a chip per reading and says the thin line is daily and the bold line the 7 day average", () => {
    const h = renderToStaticMarkup(<ReadingsChartView data={series} days={730} kind="sleep" onKind={noop} today="2026-11-09" />);
    for (const l of ["Sleep score", "HRV", "Resting heart rate", "Training readiness", "Body battery charged"]) expect(h).toContain(l);
    expect(h).toContain("the bold line is the 7 day average");
    expect(h).toContain("Show as table");
    expect(h).toContain("min-h-11");
  });
  it("says Not imported yet beyond the stored range, in plain words", () => {
    const h = renderToStaticMarkup(<ReadingsChartView data={series} days={730} kind="sleep" onKind={noop} today="2026-11-09" />);
    expect(h).toContain("Not imported yet before 01/06/2025.");
    const inside = renderToStaticMarkup(<ReadingsChartView data={series} days={91} kind="sleep" onKind={noop} today="2026-11-09" />);
    expect(inside).not.toContain("Not imported yet");
  });
  it("an empty reading points to the import instead of a blank chart", () => {
    const h = renderToStaticMarkup(<ReadingsChartView data={series} days={91} kind="hrv" onKind={noop} today="2026-11-09" />);
    expect(h).toContain("Nothing stored yet. Start the history import in Settings to fill it.");
  });
});

describe("this year against last year", () => {
  const y: YearOnYear = {
    thisYear: { from: "2026-01-01", to: "2026-11-09" }, lastYear: { from: "2025-01-01", to: "2025-11-09" },
    rows: [
      { key: "distance", label: "Running distance", thisYear: "1204.5 km", lastYear: "980.0 km", note: null },
      { key: "runs", label: "Runs", thisYear: "141", lastYear: "122", note: null },
      { key: "rhr", label: "Average resting heart rate", thisYear: "46.2 bpm", lastYear: null, note: "Not imported yet." },
      { key: "vo2max", label: "VO2 max at the end of the period", thisYear: "45.7 ml/kg/min on 07/11/2026", lastYear: "44.2 ml/kg/min on 01/11/2025", note: null },
    ],
  };
  it("shows both periods and the two values side by side, with notes, and no judgement", () => {
    const h = renderToStaticMarkup(<YearOnYearView y={y} />);
    expect(h).toContain("01/01/2026 to 09/11/2026 against 01/01/2025 to 09/11/2025");
    expect(h).toContain("1204.5 km");
    expect(h).toContain("980.0 km");
    expect(h).toContain("Not imported yet.");
    expect(h).toContain("--");
    // A date never shares a line with the value, so it cannot break across lines.
    expect(h).toContain("45.7 ml/kg/min<span");
    expect(h).toContain("on 07/11/2026");
    expect(h).not.toMatch(/better|worse|improv|decline|should|target|behind|ahead|up |down /i);
  });
});
