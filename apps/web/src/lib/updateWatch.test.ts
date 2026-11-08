import type { BuildInfo } from "@pulse/shared";
import { describe, expect, it } from "vitest";
import { watchForBuild } from "./updateWatch";

const build = (sha: string): BuildInfo => ({ sha, shortSha: sha.slice(0, 7), builtAt: null });

/** A fake clock: sleeping advances it, so three minutes of polling takes no real time. */
function clock() {
  let t = Date.parse("2026-11-08T12:00:00Z");
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("reconnect watch", () => {
  it("polls every 3 seconds, tolerates dropped connections, and stops when the build changes", async () => {
    const c = clock();
    const calls: number[] = [];
    let n = 0;
    const r = await watchForBuild({
      fromSha: "aaaaaaa",
      ...c,
      poll: async () => {
        calls.push(c.now());
        n++;
        if (n <= 3) throw new Error("connection dropped");
        if (n === 4) return build("aaaaaaa"); // old container still answering
        return build("bbbbbbb");
      },
    });
    expect(r).toEqual({ state: "updated", build: build("bbbbbbb") });
    expect(calls.map((t, i) => (i === 0 ? 0 : t - (calls[i - 1] ?? 0)))).toEqual([0, 3000, 3000, 3000, 3000]);
  });

  it("gives up after 3 minutes on the same build", async () => {
    const c = clock();
    let n = 0;
    const r = await watchForBuild({ fromSha: "aaaaaaa", ...c, poll: async () => (n++, build("aaaaaaa")) });
    expect(r.state).toBe("timeout");
    expect(n).toBe(60);
    expect(c.now() - Date.parse("2026-11-08T12:00:00Z")).toBe(180_000);
    if (r.state === "timeout") expect(r.detail).toMatch(/last answered at .* on build aaaaaaa/);
  });

  it("times out with a plain detail when the app never answers", async () => {
    const c = clock();
    const r = await watchForBuild({ fromSha: "aaaaaaa", ...c, poll: async () => Promise.reject(new Error("down")) });
    expect(r).toMatchObject({ state: "timeout" });
    if (r.state === "timeout") expect(r.detail).toMatch(/did not answer at all/);
  });

  it("can be cancelled", async () => {
    const c = clock();
    const signal = { cancelled: false };
    const r = await watchForBuild({ fromSha: "a", ...c, signal, poll: async () => (signal.cancelled = true, build("a")) });
    expect(r).toEqual({ state: "timeout", detail: "Stopped watching." });
  });
});
