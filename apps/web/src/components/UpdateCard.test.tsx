import { UPDATE_OFF_TEXT, type UpdateCheck, type UpdateStatus } from "@pulse/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { checkSummary, UpdateCard } from "./UpdateCard";

const build = { sha: "cc3b793aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortSha: "cc3b793", builtAt: "2026-11-07T11:30:00Z" };
const available: UpdateCheck = { state: "available", checkedAt: "2026-11-08T12:00:00Z", latest: { sha: "9f2a1be0000000000000000000000000000000000", shortSha: "9f2a1be", builtAt: "2026-11-08T11:00:00Z" }, reason: null };

function render(s: UpdateStatus): string {
  const qc = new QueryClient();
  qc.setQueryData(["update"], s);
  qc.setQueryData(["proposals"], { writesEnabled: false, probeRecorded: false, pending: [], history: [] });
  return renderToString(
    <QueryClientProvider client={qc}>
      <UpdateCard />
    </QueryClientProvider>,
  ).replaceAll("<!-- -->", "");
}

describe("app update card", () => {
  it("shows the build, the check and an enabled Update now", () => {
    const html = render({ build, updatesEnabled: true, check: available });
    expect(html).toContain("Build cc3b793, built 07/11/2026 11:30");
    expect(html).toContain("Update available: build 9f2a1be, built 08/11/2026 11:00");
    expect(html).toContain("Check for update");
    expect(html).not.toContain(UPDATE_OFF_TEXT);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Update now/);
    expect(html).toMatch(/<button[^>]*bg-accent[^>]*>Update now/);
  });

  it("uses the quiet outline style for Update now unless an update is available", () => {
    const quiet = /<button[^>]*border-border-strong[^>]*>Update now/;
    expect(render({ build, updatesEnabled: true, check: { ...available, state: "up_to_date", latest: null } })).toMatch(quiet);
    expect(render({ build, updatesEnabled: true, check: null })).toMatch(quiet);
    expect(render({ build, updatesEnabled: true, check: available })).not.toMatch(quiet);
  });

  it("without a token still shows the build and the check, disables Update now and says why", () => {
    const html = render({ build, updatesEnabled: false, check: available });
    expect(html).toContain("Build cc3b793");
    expect(html).toContain("Update available");
    expect(html).toContain(UPDATE_OFF_TEXT);
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Update now/);
  });

  it("puts the reason for a failed check under Details", () => {
    const html = render({ build, updatesEnabled: true, check: { state: "error", checkedAt: "2026-11-08T12:00:00Z", latest: null, reason: "GHCR refused an anonymous read (manifest, 401)." } });
    expect(html).toContain("Could not check");
    expect(html).toContain("<summary");
    expect(html).toContain("GHCR refused an anonymous read");
  });

  it("words the three results", () => {
    expect(checkSummary({ ...available, state: "up_to_date", latest: null }).headline).toBe("Up to date");
    expect(checkSummary(available).headline).toBe("Update available: build 9f2a1be, built 08/11/2026 11:00");
    expect(checkSummary({ ...available, state: "error", reason: "x" })).toEqual({ headline: "Could not check", detail: "x" });
  });
});
