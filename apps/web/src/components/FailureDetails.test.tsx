import type { Debrief, Review } from "@pulse/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DebriefView, ReviewView, type BlockState } from "./AiBlocks";
import { FailureDetails } from "./FailureDetails";

const noop = () => undefined;
const failure = { reason: "model_not_found", label: "Model not found", detail: "model: claude-x not found", at: "2026-11-08T19:41:00Z" };
const s = (o: Partial<BlockState> = {}): BlockState => ({ state: "ok", pending: false, failed: false, onWrite: noop, onRefresh: noop, ...o });
const review: Review = { week: "2026-11-02", text: "x", generatedAt: "2026-11-08T19:00:00Z", model: "m", coversUntil: "2026-11-08" };
const debrief: Debrief = { activityId: "1", text: "x", generatedAt: "2026-11-07T12:00:00Z", model: "m" };

describe("failure details", () => {
  it("shows a Details disclosure with the plain reason and time", () => {
    const h = renderToStaticMarkup(<FailureDetails failure={failure} />);
    expect(h).toContain("<summary");
    expect(h).toContain("Details");
    expect(h).toContain("Model not found");
    expect(h).toContain("model: claude-x not found");
    expect(h).toContain("At 19:41 08/11");
  });
  it("shows nothing without a failure", () => {
    expect(renderToStaticMarkup(<FailureDetails failure={null} />)).toBe("");
  });
  it("a failed review card keeps its plain line and adds Details", () => {
    const h = renderToStaticMarkup(<ReviewView review={null} weekEnd="x" {...s({ failed: true, failure })} />);
    expect(h).toContain("The review could not be written. Try again in a moment.");
    expect(h).toContain("Details");
    expect(h).toContain("Model not found");
  });
  it("a reason shown again after a reload still gives the plain failed line", () => {
    const h = renderToStaticMarkup(<ReviewView review={null} weekEnd="x" {...s({ failed: false, failure })} />);
    expect(h).toContain("The review could not be written. Try again in a moment.");
    expect(h).not.toContain("No review for this week yet");
  });
  it("a failed debrief card shows Details, and a good one shows none", () => {
    expect(renderToStaticMarkup(<DebriefView debrief={null} {...s({ failed: true, failure })} />)).toContain("Model not found");
    expect(renderToStaticMarkup(<DebriefView debrief={debrief} {...s()} />)).not.toContain("Details");
    expect(renderToStaticMarkup(<ReviewView review={review} weekEnd="x" {...s()} />)).not.toContain("Details");
  });
});
