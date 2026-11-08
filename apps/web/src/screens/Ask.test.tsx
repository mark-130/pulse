import type { AiStatus, ChatThread } from "@pulse/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Orb } from "@/components/Orb";
import { Ask } from "./Ask";

const status = (state: AiStatus["state"], message: string | null): AiStatus => ({
  state,
  message,
  notice: null,
  month: { label: "11/2026", spentGbp: 0, capGbp: 5, percent: 0, calls: 0, byFeature: [] },
  pricing: { checkedOn: "2026-11-08", usdToGbp: 0.78, models: [] },
});
const thread = (state: ChatThread["state"], message: string | null, messages: ChatThread["messages"] = []): ChatThread => ({ thread: "main", state, message, messages });

function render(t: ChatThread, s: AiStatus, url = "/ask"): string {
  const qc = new QueryClient();
  qc.setQueryData(["chat", "main"], t);
  qc.setQueryData(["ai-status"], s);
  return renderToString(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Ask />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Ask", () => {
  it("says AI is off in plain text and disables the box", () => {
    const html = render(thread("off", "AI is off"), status("off", "AI is off"));
    expect(html).toContain("AI is off");
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).not.toContain("Suggested questions");
  });
  it("says Monthly AI budget reached", () => {
    const html = render(thread("budget", "Monthly AI budget reached"), status("budget", "Monthly AI budget reached"));
    expect(html).toContain("Monthly AI budget reached");
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });
  it("marks AI replies with the sparkle chip and fixed replies as not AI", () => {
    const html = render(
      thread("ok", null, [
        { id: 1, role: "user", content: "How am I?", tools: [], source: "app" },
        { id: 2, role: "assistant", content: "Fine.", tools: ["get_today"], source: "ai" },
        { id: 3, role: "assistant", content: "Rest.", tools: [], source: "app" },
      ]),
      status("ok", null),
    );
    expect(html).toContain("AI</span>");
    expect(html.replaceAll("<!-- -->", "")).toContain("Looked at: get_today");
    expect(html).toContain("From the app, not AI");
  });
});

describe("orb thinking state", () => {
  it("adds a still ring class that does not depend on motion", () => {
    expect(renderToString(<Orb thinking />)).toContain("orb-thinking");
    expect(renderToString(<Orb />)).not.toContain("orb-thinking");
  });
});
