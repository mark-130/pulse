import { useCallback, useEffect, useRef, useState } from "react";
import { UPDATE_WATCH_INTERVAL_MS, UPDATE_WATCH_TIMEOUT_MS, buildInfoSchema, type BuildInfo } from "@pulse/shared";
import { formatTime } from "./format";

export type WatchResult = { state: "updated"; build: BuildInfo } | { state: "timeout"; detail: string };

export interface WatchOptions {
  /** The build the update started from. */
  fromSha: string;
  /** One read of /api/health/version. May throw while the app is restarting. */
  poll: () => Promise<BuildInfo>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: { cancelled: boolean };
}

/** Polls until the build changes or the time runs out. A dropped connection is expected and just means "try again". */
export async function watchForBuild(o: WatchOptions): Promise<WatchResult> {
  const interval = o.intervalMs ?? UPDATE_WATCH_INTERVAL_MS;
  const timeout = o.timeoutMs ?? UPDATE_WATCH_TIMEOUT_MS;
  const start = o.now();
  let answered: { build: BuildInfo; at: number } | null = null;
  let failures = 0;
  while (o.now() - start < timeout) {
    if (o.signal?.cancelled) return { state: "timeout", detail: "Stopped watching." };
    try {
      const build = await o.poll();
      answered = { build, at: o.now() };
      if (build.sha !== o.fromSha) return { state: "updated", build };
    } catch {
      failures++;
    }
    await o.sleep(interval);
  }
  const last = answered ? `The app last answered at ${formatTime(new Date(answered.at).toISOString())} on build ${answered.build.shortSha}.` : "The app did not answer at all while watching.";
  return { state: "timeout", detail: `${last} ${failures} reads failed. Watchtower may not have found a newer image, or it could not reach this app's network.` };
}

export async function pollVersion(): Promise<BuildInfo> {
  const res = await fetch("/api/health/version", { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return buildInfoSchema.parse(await res.json());
}

export type UpdateWatchState = { phase: "idle" } | { phase: "watching"; fromSha: string } | { phase: "updated"; build: BuildInfo } | { phase: "timeout"; detail: string };

/** Runs the reconnect watch in the browser. Starting it twice does nothing. */
export function useUpdateWatch() {
  const [state, setState] = useState<UpdateWatchState>({ phase: "idle" });
  const token = useRef({ cancelled: false });
  const running = useRef(false);
  useEffect(() => {
    const t = token.current;
    return () => void (t.cancelled = true);
  }, []);
  const start = useCallback((fromSha: string) => {
    if (running.current) return;
    running.current = true;
    setState({ phase: "watching", fromSha });
    void watchForBuild({ fromSha, poll: pollVersion, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, signal: token.current }).then((r) => {
      running.current = false;
      if (token.current.cancelled) return;
      setState(r.state === "updated" ? { phase: "updated", build: r.build } : { phase: "timeout", detail: r.detail });
    });
  }, []);
  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, start, reset };
}
