import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { createNotifier, ntfyEnabled } from "../src/notify.js";
import { createTrackedJob, getState } from "../src/modules/system/jobs.js";
import { syncStatusSchema } from "@pulse/shared";
import { TODAY } from "./fixtures.js";
import { makeGarminApp } from "./helpers.js";

const cfg = { NTFY_URL: "http://ntfy.test:8090", NTFY_TOPIC: "t", NTFY_TOKEN: "" };
const warnLog = () => {
  const log = createLogger("silent");
  const warn = vi.spyOn(log, "warn");
  const info = vi.spyOn(log, "info");
  return { log, warn, info };
};

describe("ntfy is optional", () => {
  it("an empty or blank token never calls ntfy and logs nothing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { log, warn, info } = warnLog();
    for (const NTFY_TOKEN of ["", "  "]) {
      expect(ntfyEnabled({ NTFY_TOKEN })).toBe(false);
      await createNotifier({ ...cfg, NTFY_TOKEN }, log, fetchImpl)("hello");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("sends with a bearer token and a timeout when configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    await createNotifier({ ...cfg, NTFY_TOKEN: "tk_secret" }, createLogger("silent"), fetchImpl)("hello");
    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tk_secret");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([401, 403])("a %i response is one warning, never throws and never leaks the token or URL", async (status) => {
    const { log, warn } = warnLog();
    const notify = createNotifier({ ...cfg, NTFY_TOKEN: "tk_secret" }, log, async () => new Response("no", { status }));
    await expect(notify("hello")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/tk_secret|ntfy\.test/);
  });

  it("a network error or timeout is one sanitised warning and never throws", async () => {
    const { log, warn } = warnLog();
    const notify = createNotifier({ ...cfg, NTFY_TOKEN: "tk_secret" }, log, async () => {
      throw new Error("fetch failed http://ntfy.test:8090/x?token=tk_secret");
    });
    await expect(notify("hello")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/tk_secret|ntfy\.test/);
  });
});

describe("a rejected ntfy send does not change a sync", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pulse-ntfy-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("failure state, backoff counters and the run result are the same with a 403", async () => {
    const h = openDb(dir);
    const log = createLogger("silent");
    const run = async () => {
      throw new Error("down");
    };
    const t = new Date(`${TODAY}T12:00:00Z`);
    const send403 = createNotifier({ ...cfg, NTFY_TOKEN: "tk" }, log, async () => new Response("no", { status: 403 }));
    const throwing = async () => {
      throw new Error("notifier exploded");
    };
    for (const notify of [send403, throwing]) {
      const job = createTrackedJob({ db: h.db, name: `garmin-${notify === send403 ? "a" : "b"}`, log, notify, now: () => t, run });
      for (let i = 0; i < 3; i++) await expect(job.runNow()).resolves.toEqual({ ran: true });
      expect(getState(h.db, `garmin-${notify === send403 ? "a" : "b"}`)).toMatchObject({ consecutiveFailures: 3, lastError: "down" });
    }
    h.sqlite.close();
  });

  it("the status API says alerts are off without a token", async () => {
    const t = await makeGarminApp({ clock: () => new Date(`${TODAY}T12:30:00Z`) });
    expect(syncStatusSchema.parse(await (await t.get("/api/sync/status")).json()).alertsEnabled).toBe(false);
  });
});
