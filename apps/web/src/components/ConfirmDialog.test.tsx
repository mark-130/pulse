import type { Proposal } from "@pulse/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

const failed: Proposal = {
  id: "p", kind: "app.update", targetSystem: "app", status: "failed", createdBy: "user", rationale: null, before: { sha: "cc3b793aaaa", builtAt: null }, after: null,
  createdAt: "2026-11-08T12:00:00Z", expiresAt: "2026-11-09T12:00:00Z", decidedAt: "2026-11-08T12:01:00Z", result: { error: "Could not reach Watchtower. Nothing was updated." },
};

describe("confirm dialog errors", () => {
  it("shows a failed update's reason once", () => {
    const h = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ConfirmDialog proposal={failed} writesEnabled probeRecorded onClose={() => undefined} />
      </QueryClientProvider>,
    );
    expect(h.match(/Could not reach Watchtower/g)).toHaveLength(1);
    expect(h).toContain("Failed.");
  });
});
