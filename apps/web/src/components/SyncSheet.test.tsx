import type { SyncStatus } from "@pulse/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { SyncSheet } from "./SyncSheet";

const job = { lastOk: "2026-11-07T11:50:00Z", lastAttempt: null, lastError: null, consecutiveFailures: 0, detail: null, ageMinutes: 10, stale: false };
const status = (alertsEnabled: boolean): SyncStatus => ({ now: "2026-11-07T12:00:00Z", staleAfterMinutes: 90, garmin: job, groups: [], alertsEnabled, backup: job });

function render(s: SyncStatus, version: { sha: string; shortSha: string; builtAt: string | null } | null = null): string {
  const qc = new QueryClient();
  qc.setQueryData(["sync-status"], s);
  if (version) qc.setQueryData(["version"], version);
  return renderToString(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SyncSheet open={false} onClose={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const LINE = "Failure alerts are off. This screen is the only place failures show.";

describe("sync sheet", () => {
  it("shows the plain line when ntfy is not configured", () => {
    expect(render(status(false))).toContain(LINE);
  });
  it("shows the build and when it was built", () => {
    const html = render(status(true), { sha: "cc3b793aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortSha: "cc3b793", builtAt: "2026-11-07T11:30:00Z" }).replaceAll("<!-- -->", "");
    expect(html).toContain("Build cc3b793, built 07/11/2026 11:30");
  });
  it("hides it when alerts are on", () => {
    expect(render(status(true))).not.toContain(LINE);
  });
});
