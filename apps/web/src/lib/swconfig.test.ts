import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("service worker config", () => {
  const src = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
  const pattern = /urlPattern: \(\{ url \}: \{ url: URL \}\) => (\/.*\/)\.test\(url\.pathname\)/.exec(src)?.[1];

  it("never caches the session endpoint, and still caches the dashboard snapshots", () => {
    expect(pattern).toBeDefined();
    const re = new RegExp((pattern as string).slice(1, -1));
    expect(re.test("/api/auth/session")).toBe(false);
    for (const p of ["/api/today", "/api/week", "/api/trends", "/api/races", "/api/sync/status"]) expect(re.test(p)).toBe(true);
    expect(re.test("/api/proposals")).toBe(false);
  });
});
