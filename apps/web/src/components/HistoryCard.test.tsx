import type { HistoryStatus } from "@pulse/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { finishText, movingAverage7, primaryAction, progressText, stateLine } from "@/lib/history";
import { HistoryView } from "./HistoryCard";

const kinds = [
  { id: "activities", label: "Activities", done: 730, total: 730, failed: 0 },
  { id: "sleep", label: "Sleep", done: 214, total: 730, failed: 1 },
  { id: "hrv", label: "HRV", done: 0, total: 730, failed: 0 },
];
const base: HistoryStatus = { state: "idle", days: 730, from: "2024-11-10", to: "2026-11-09", startedAt: null, estimatedFinish: null, pausedUntil: null, reason: null, current: null, waiting: false, kinds, failedWindows: [], incomplete: false, notImported: ["Race predictions", "Personal records", "Heart rate zones"] };
const html = (s: HistoryStatus, pending = false) => renderToStaticMarkup(<HistoryView s={s} pending={pending} onAction={() => undefined} />);

describe("history import card", () => {
  it("shows per kind progress in words, with the range and what is not imported", () => {
    const h = html(base);
    expect(h).toContain("Sleep: 214 of 730 days");
    expect(h).toContain("Activities: 730 of 730 days");
    expect(h).toContain("Covers 730 days, 10/11/2024 to 09/11/2026.");
    expect(h).toContain("Race predictions, personal records and heart rate zones are not imported");
    expect(h).toContain("1 failed");
    expect(h).toContain("the nightly backup covers it");
    expect(progressText(kinds[1] as never)).toBe("Sleep: 214 of 730 days");
  });

  it("offers Start when idle, Pause while running, Resume when paused, and Start again after a stop", () => {
    expect(primaryAction(base)).toEqual({ label: "Start", action: "start" });
    expect(primaryAction({ ...base, state: "running" })).toEqual({ label: "Pause", action: "pause" });
    expect(primaryAction({ ...base, state: "paused" })).toEqual({ label: "Resume", action: "resume" });
    expect(primaryAction({ ...base, state: "stopped" })).toEqual({ label: "Start again", action: "start" });
    expect(primaryAction({ ...base, state: "complete" })).toBeNull();
    expect(primaryAction({ ...base, state: "complete", incomplete: true })).toEqual({ label: "Retry failed windows", action: "start" });
    expect(html(base)).toContain(">Start<");
    expect(html({ ...base, state: "running" })).toContain(">Pause<");
    expect(html({ ...base, state: "paused" })).toContain(">Resume<");
  });

  it("every button is a 44px tap target", () => {
    for (const state of ["idle", "running", "paused", "stopped"] as const) {
      const h = html({ ...base, state });
      expect(h).toContain("min-h-11");
      expect(h).not.toMatch(/<button[^>]*size-/);
    }
  });

  it("says Running with what it is fetching, and the estimated finish; waiting for the sync is said plainly", () => {
    expect(stateLine({ ...base, state: "running", current: "Sleep" })).toBe("Running. Fetching sleep.");
    expect(stateLine({ ...base, state: "running", waiting: true })).toBe("Waiting for the routine sync or the backup to finish.");
    const finish = finishText({ ...base, state: "running", estimatedFinish: "2026-11-09T14:30:00Z" });
    expect(finish).toBe("Estimated finish about 14:30 09/11.");
    expect(html({ ...base, state: "running", estimatedFinish: "2026-11-09T14:30:00Z" })).toContain("Estimated finish about 14:30 09/11.");
    expect(finishText({ ...base, state: "paused", estimatedFinish: "2026-11-09T14:30:00Z" })).toBeNull();
  });

  it("says Complete when done, and puts failed windows and the reason under Details", () => {
    expect(html({ ...base, state: "complete", kinds: kinds.map((k) => ({ ...k, done: 730, failed: 0 })) })).toContain("Complete.");
    expect(html({ ...base, state: "complete", kinds: kinds.map((k) => ({ ...k, done: 730, failed: 0 })) })).not.toContain("Details");
    const stopped = html({ ...base, state: "stopped", reason: "Three windows in a row failed. Last: Sleep, 2026-10-01 to 2026-10-30. Garmin did not answer in time.", failedWindows: [{ kind: "sleep", label: "Sleep", from: "2026-10-01", to: "2026-10-30", reason: "Garmin did not answer in time." }] });
    expect(stopped).toContain("Stopped.");
    expect(stopped).toContain("<summary");
    expect(stopped).toContain("Details");
    expect(stopped).toContain("Three windows in a row failed.");
    expect(stopped).toContain("Sleep, 01/10/2026 to 30/10/2026: Garmin did not answer in time.");
    expect(html({ ...base, state: "complete", incomplete: true, failedWindows: [{ kind: "hrv", label: "HRV", from: "2026-10-01", to: "2026-10-15", reason: "x" }] })).toContain("Finished, 1 window failed.");
  });

  it("explains a rate limit pause and when it resumes", () => {
    const h = html({ ...base, state: "paused", pausedUntil: "2026-11-09T15:00:00Z", reason: "Garmin asked us to slow down three times in a row. The import resumes by itself after an hour." });
    expect(h).toContain("Paused by Garmin&#x27;s rate limit. It resumes by itself at 15:00 09/11.");
    expect(h).toContain("resumes by itself after an hour");
  });

  it("the 7 day average looks only at days inside the window", () => {
    const pts = [{ date: "2026-01-01", value: 10 }, { date: "2026-01-02", value: 20 }, { date: "2026-02-01", value: 40 }];
    expect(movingAverage7(pts).map((p) => p.avg7)).toEqual([10, 15, 40]);
  });
});
