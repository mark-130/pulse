import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isRunning, SportIcon } from "./SportIcon";

describe("sport icon", () => {
  it("treats running types as runs and nothing else", () => {
    for (const s of ["running", "trail_running", "treadmill_running", "track_running", "Running"]) expect(isRunning(s)).toBe(true);
    for (const s of ["strength_training", "cycling", "walking", null, undefined]) expect(isRunning(s)).toBe(false);
  });
  it("draws the runner for runs and footprints otherwise, always aria-hidden", () => {
    const run = renderToStaticMarkup(<SportIcon sport="running" />);
    const other = renderToStaticMarkup(<SportIcon sport="strength_training" />);
    expect(run).toContain("M13 4m-1 0a1 1 0 1 0 2 0");
    expect(other).not.toContain("M13 4m-1 0a1 1 0 1 0 2 0");
    expect(other).toContain("lucide-footprints");
    expect(run).toContain('aria-hidden="true"');
    expect(other).toContain('aria-hidden="true"');
  });
});
