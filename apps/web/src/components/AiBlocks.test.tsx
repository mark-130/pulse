import type { Debrief, Review } from "@pulse/shared";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { aiStateLine, DebriefView, ReviewView, type BlockState } from "./AiBlocks";

const noop = () => undefined;
const s = (o: Partial<BlockState> = {}): BlockState => ({ state: "ok", pending: false, failed: false, onWrite: noop, onRefresh: noop, ...o });
const html = (node: React.ReactElement) => renderToString(node).replaceAll("<!-- -->", "");
const review: Review = { week: "2026-11-02", text: "Load: 110 minutes against 110 scheduled.", generatedAt: "2026-11-08T19:00:00Z", model: "m", coversUntil: "2026-11-07" };
const debrief: Debrief = { activityId: "1", text: "A 7.86 km easy run.", generatedAt: "2026-11-07T12:00:00Z", model: "m" };

describe("weekly review block", () => {
  it("shows the text with the sparkle chip, when it was generated, how far it covers, and Refresh", () => {
    const h = html(<ReviewView review={review} weekEnd="2026-11-08" {...s()} />);
    expect(h).toContain("Load: 110 minutes against 110 scheduled.");
    expect(h).toContain("AI");
    expect(h).toContain("Generated 19:00 08/11");
    expect(h).toContain("Covers the week up to 07/11/2026.");
    expect(h).toContain("Refresh");
  });
  it("offers Write review when there is none, and explains the cap and the off state in plain text without a button", () => {
    expect(html(<ReviewView review={null} weekEnd="x" {...s()} />)).toContain("Write review");
    const capped = html(<ReviewView review={null} weekEnd="x" {...s({ state: "budget" })} />);
    expect(capped).toContain("AI cap reached for this month. The weekly review returns next month.");
    expect(capped).not.toContain("Write review");
    expect(html(<ReviewView review={null} weekEnd="x" {...s({ state: "off" })} />)).toContain("AI is off. Set ANTHROPIC_API_KEY to switch the weekly review on.");
  });
  it("keeps the earlier review when a refresh fails", () => {
    expect(html(<ReviewView review={review} weekEnd="x" {...s({ failed: true })} />)).toContain("The earlier review is kept.");
  });
});

describe("debrief block", () => {
  it("shows the cached text with Refresh, and Write debrief when there is none", () => {
    expect(html(<DebriefView debrief={debrief} {...s()} />)).toContain("A 7.86 km easy run.");
    expect(html(<DebriefView debrief={debrief} {...s()} />)).toContain("Refresh");
    expect(html(<DebriefView debrief={null} {...s()} />)).toContain("Write debrief");
  });
  it("says the cap is reached without a button", () => {
    const h = html(<DebriefView debrief={null} {...s({ state: "budget" })} />);
    expect(h).toContain("AI cap reached for this month.");
    expect(h).not.toContain("Write debrief");
  });
  it("has the line for each shared state", () => {
    expect(aiStateLine("ok", "x")).toBeNull();
  });
});
