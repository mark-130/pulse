import type { Vo2Response, ZonesResponse } from "@pulse/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sparkline, Vo2Body } from "./Vo2Card";
import { ZonesBody } from "./ZonesCard";

const noop = () => undefined;
const garmin: NonNullable<ZonesResponse["garmin"]> = {
  zones: { profile: "DEFAULT", usingDefault: true, method: "LACTATE_THRESHOLD", resting: 47, lactateThreshold: 162, max: 180, floors: [103, 130, 144, 151, 158] },
  ranges: [{ zone: 1, from: 103, top: 129 }, { zone: 2, from: 130, top: 143 }, { zone: 3, from: 144, top: 150 }, { zone: 4, from: 151, top: 157 }, { zone: 5, from: 158, top: 180 }],
  firstSeen: "2026-11-08", fetchedAt: "2026-11-08T20:00:00Z", ageMinutes: 5, stale: false, lastError: null,
};
const base: ZonesResponse = {
  kotcha: { zones: [{ zone: 1, name: "Recovery", from: null, top: 128 }, { zone: 2, name: "Aerobic Endurance", from: 129, top: 143 }, { zone: 3, name: "Aerobic Power", from: 144, top: 150 }, { zone: 4, name: "Threshold", from: 151, top: 157 }, { zone: 5, name: "Anaerobic", from: 158, top: 180 }], source: "manual", savedAt: "2026-11-08T19:00:00Z" },
  garmin,
  differences: [{ zone: 1, garminTop: 129, kotchaTop: 128, text: "Zone 1 top: Garmin 129, Kotcha 128" }],
  warning: null,
  confirmed: true,
};
const html = (z: ZonesResponse) => renderToStaticMarkup(<ZonesBody z={z} onEdit={noop} onConfirm={noop} confirming={false} />);

describe("heart rate zones card", () => {
  it("shows the Kotcha zones as the main display with names and ranges derived from the tops", () => {
    const h = html(base);
    for (const n of ["Recovery", "Aerobic Endurance", "Aerobic Power", "Threshold", "Anaerobic"]) expect(h).toContain(n);
    expect(h).toContain("up to 128 bpm");
    expect(h).toContain("129 to 143 bpm");
    expect(h).toContain("158 to 180 bpm");
    expect(h.match(/aria-label="Zone \d,/g)).toHaveLength(5);
    expect(h).toContain("Edit Kotcha zones");
  });
  it("puts Garmin's zones, the method and the default profile line under a Details disclosure", () => {
    const h = html(base);
    expect(h).toContain("<summary");
    expect(h).toContain("Garmin zones");
    expect(h).toContain("Running uses your default profile");
    expect(h).toContain("lactate threshold");
    expect(h).toContain("162 bpm");
    expect(h).toContain("180 bpm");
    expect(h).toContain("47 bpm");
    expect(h).toContain("103 to 129 bpm");
  });
  it("shows the 1 bpm difference as a neutral line, not as a warning", () => {
    const h = html(base);
    expect(h).toContain("Zone 1 top: Garmin 129, Kotcha 128");
    expect(h).not.toContain('role="alert"');
    expect(h).not.toContain("Garmin changed your heart rate zones");
  });
  it("shows the Garmin change warning with its one button when Garmin's zones changed", () => {
    const text = "Garmin changed your heart rate zones on 12/11. Zone 2 floor 130 to 132. Update Kotcha, then confirm here.";
    const h = html({ ...base, warning: { changedOn: "2026-11-12", changes: ["Zone 2 floor 130 to 132"], text } });
    expect(h).toContain('role="alert"');
    expect(h).toContain(text);
    expect(h).toContain("Kotcha is up to date");
    expect(h.match(/Kotcha is up to date/g)).toHaveLength(1);
  });
  it("without a running profile gets no default line, and with no Garmin data says so", () => {
    expect(html({ ...base, garmin: { ...garmin, zones: { ...garmin.zones, usingDefault: false, profile: "RUNNING" } } })).not.toContain("Running uses your default profile");
    expect(html({ ...base, garmin: null, differences: [] })).toContain("No Garmin zones yet");
  });
  it("a stale or failed fetch keeps the last zones with their age, never a blank", () => {
    const h = html({ ...base, garmin: { ...garmin, stale: true, ageMinutes: 300, lastError: "Read timed out" } });
    expect(h).toContain("103 to 129 bpm");
    expect(h).toContain("Showing the last zones Garmin gave, 5 hours old, the latest update failed.");
  });
  it("says whether the copy is saved or still the starting values", () => {
    expect(html(base)).toContain("Your copy of Kotcha, saved 08/11/2026 19:00.");
    expect(html({ ...base, kotcha: { ...base.kotcha, source: "seed", savedAt: null } })).toContain("Starting values for your copy of Kotcha");
  });
  it("says nothing about how to train in zones", () => {
    const visible = html({ ...base, warning: { changedOn: "2026-11-12", changes: [], text: "Garmin changed your heart rate zones on 12/11. Update Kotcha, then confirm here." } }).replace(/<[^>]*>/g, " ");
    expect(visible).not.toMatch(/should|recommend|train in|target|easy|hard/i);
  });
});

const v: Vo2Response = {
  points: [{ date: "2026-10-10", value: 46.5, carriedForward: true }, { date: "2026-10-25", value: 46.1, carriedForward: false }, { date: "2026-11-08", value: 45.9, carriedForward: false }],
  current: { date: "2026-11-08", value: 45.9, carriedForward: false },
  change30: { direction: "down", delta: -0.6, text: "Down 0.6 over 30 days" },
  stored: { from: "2026-08-10", to: "2026-11-08" }, fetchedAt: "2026-11-08T20:00:00Z", ageMinutes: 5, stale: false, lastError: null,
};

describe("VO2 max card", () => {
  it("shows the current value large with its date, the 30 day change and a sparkline, and no interpretation", () => {
    const h = renderToStaticMarkup(<Vo2Body v={v} />);
    expect(h).toContain("45.9");
    expect(h).toContain("on 08/11/2026");
    expect(h).toContain("Down 0.6 over 30 days");
    expect(h).toContain("<svg");
    expect(h).not.toMatch(/good|bad|excellent|poor|should|improv|declin/i);
  });
  it("draws carried-forward days lighter", () => {
    const h = renderToStaticMarkup(<Sparkline points={v.points} />);
    expect(h.match(/data-carried="true"/g)).toHaveLength(1);
    expect(h).toMatch(/fill-opacity="0.3"[^>]*data-carried="true"|data-carried="true"[^>]*fill-opacity="0.3"/);
    expect(h.match(/fill-opacity="1"/g)).toHaveLength(2);
  });
  it("says carried forward when the latest value is one, and shows Up and No change wording", () => {
    expect(renderToStaticMarkup(<Vo2Body v={{ ...v, current: { date: "2026-11-08", value: 45.9, carriedForward: true } }} />)).toContain("carried forward");
    expect(renderToStaticMarkup(<Vo2Body v={{ ...v, change30: { direction: "up", delta: 0.4, text: "Up 0.4 over 30 days" } }} />)).toContain("Up 0.4 over 30 days");
    expect(renderToStaticMarkup(<Vo2Body v={{ ...v, change30: { direction: "none", delta: 0, text: "No change over 30 days" } }} />)).toContain("No change over 30 days");
  });
  it("a stale or failed fetch shows the last value with its age, and no data says so", () => {
    expect(renderToStaticMarkup(<Vo2Body v={{ ...v, stale: true, ageMinutes: 3000, lastError: "x" }} />)).toContain("Showing the last value Garmin gave, 2 days old, the latest update failed.");
    expect(renderToStaticMarkup(<Vo2Body v={{ ...v, points: [], current: null, change30: null, stored: null }} />)).toContain("No VO2 max yet");
  });
});
