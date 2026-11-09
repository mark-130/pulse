import type { HistoryStatus } from "@pulse/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { finishText, movingAverage7, primaryAction, progressText, stateLine } from "@/lib/history";
import { HistoryView } from "./HistoryCard";

const kinds: HistoryStatus["kinds"] = [
  { id: "activities", label: "Activities", done: 730, total: 730, failed: 0, state: "done", reason: null },
  { id: "sleep", label: "Sleep", done: 214, total: 730, failed: 1, state: "running", reason: null },
  { id: "hrv", label: "HRV", done: 0, total: 730, failed: 0, state: "waiting", reason: null },
];
const base: HistoryStatus = { state: "idle", days: 730, from: "2024-11-10", to: "2026-11-09", startedAt: null, estimatedFinish: null, pausedUntil: null, reason: null, current: null, waiting: false, kinds, failedWindows: [], notImported: ["Race predictions", "Personal records", "Heart rate zones"] };
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
    expect(primaryAction({ ...base, state: "complete_with_issues" })).toEqual({ label: "Start again", action: "start" });
    expect(html(base)).toContain(">Start<");
    expect(html({ ...base, state: "running" })).toContain(">Pause<");
    expect(html({ ...base, state: "paused" })).toContain(">Resume<");
  });

  it("every button is a 44px tap target", () => {
    for (const state of ["idle", "running", "paused", "stopped", "complete_with_issues"] as const) {
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
  });

  const attention: HistoryStatus["kinds"] = [
    { id: "activities", label: "Activities", done: 730, total: 730, failed: 0, state: "done", reason: null },
    { id: "vo2max", label: "VO2 max", done: 730, total: 730, failed: 0, state: "done", reason: null },
    { id: "body_battery", label: "Body battery", done: 360, total: 730, failed: 5, state: "attention", reason: "Garmin rejected the date range as too long." },
  ];
  const failed = [{ kind: "body_battery", label: "Body battery", from: "2025-05-19", to: "2025-07-17", reason: "Garmin rejected the date range as too long." }];

  it("shows a state for every kind in words, not colour alone: Done, Running, Needs attention, Waiting", () => {
    const h = html({ ...base, state: "running", current: "Sleep" });
    expect(h).toContain(">Done<");
    expect(h).toContain("Running, 1 failed");
    expect(h).toContain(">Waiting<");
    expect(html({ ...base, state: "complete_with_issues", kinds: attention, failedWindows: failed })).toContain("Needs attention, 5 failed");
  });

  it("says Complete with issues, names the kinds that need attention, offers Start again, and gives the reasons under Details", () => {
    const h = html({ ...base, state: "complete_with_issues", kinds: attention, failedWindows: failed, reason: "Some windows failed: Body battery. Start again retries only those." });
    expect(h).toContain("Complete with issues.");
    expect(h).toContain("1 kind needs attention: Body battery.");
    expect(h).toContain("Start again retries only the failed windows and anything not yet attempted.");
    expect(h).toContain(">Start again<");
    expect(h).toContain("<summary");
    expect(h).toContain("Body battery:</span> Garmin rejected the date range as too long.");
    expect(h).toContain("Body battery, 19/05/2025 to 17/07/2025: Garmin rejected the date range as too long.");
    expect(stateLine({ ...base, state: "complete_with_issues" })).toBe("Complete with issues.");
  });

  it("a plain shape sentence that already names the kind and the dates is not repeated with a prefix", () => {
    const sentence = "Garmin sent an answer in a shape Pulse did not expect (VO2 max, 14/11/2024 to 27/11/2024)";
    const h = html({ ...base, state: "complete_with_issues", kinds: [{ id: "vo2max", label: "VO2 max", done: 0, total: 730, failed: 1, state: "attention", reason: sentence }], failedWindows: [{ kind: "vo2max", label: "VO2 max", from: "2024-11-14", to: "2024-11-27", reason: sentence }] });
    expect(h).toContain(`<li>${sentence.replace("(", "(")}</li>`);
    expect(h).not.toContain("VO2 max, 14/11/2024 to 27/11/2024: Garmin");
    expect(h).not.toMatch(/invalid_type|expected&quot;|"code"|\[ \{/);
  });

  it("does not list needs attention while the import is still running", () => {
    expect(html({ ...base, state: "running", kinds: attention })).not.toContain("need attention");
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
