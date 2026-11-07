import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { sanitiseError } from "../src/notify.js";
import { BACKUP_KEEP, runBackup } from "../src/modules/system/backup.js";
import { backoffMinutes, createTrackedJob, getState, isDue } from "../src/modules/system/jobs.js";

let dir: string;
let handle: ReturnType<typeof openDb>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-jobs-"));
  handle = openDb(dir);
});
afterEach(() => {
  handle.sqlite.close();
  rmSync(dir, { recursive: true });
});

describe("backoff", () => {
  it("doubles from 30 minutes up to 4 hours", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMinutes)).toEqual([0, 30, 60, 120, 240, 240, 240]);
  });
  it("is due immediately with no failures and waits after one", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    expect(isDue(undefined, now)).toBe(true);
    expect(isDue({ lastAttempt: "2026-11-07T11:55:00Z", consecutiveFailures: 0 }, now)).toBe(true);
    expect(isDue({ lastAttempt: "2026-11-07T11:45:00Z", consecutiveFailures: 1 }, now)).toBe(false);
    expect(isDue({ lastAttempt: "2026-11-07T11:20:00Z", consecutiveFailures: 1 }, now)).toBe(true);
  });
});

describe("tracked job", () => {
  const log = createLogger("silent");

  it("records success and clears the error", async () => {
    const notify = vi.fn<(message: string) => Promise<void>>(async () => undefined);
    let fail = true;
    let t = Date.parse("2026-11-07T08:00:00Z");
    const job = createTrackedJob({ db: handle.db, name: "garmin", log, notify, now: () => new Date(t), run: async () => { if (fail) throw new Error("nope https://x.test/mcp?token=abc123"); return { detail: "partial" }; } });
    await job.runNow();
    expect(getState(handle.db, "garmin")).toMatchObject({ consecutiveFailures: 1, lastOk: null });
    expect(getState(handle.db, "garmin")?.lastError).not.toContain("abc123");
    fail = false;
    t += 60_000;
    await job.runNow();
    expect(getState(handle.db, "garmin")).toMatchObject({ consecutiveFailures: 0, lastError: null, detail: "partial" });
    expect(getState(handle.db, "garmin")?.lastOk).toBe("2026-11-07T08:01:00.000Z");
  });

  it("alerts after 3 failures and at most once a day", async () => {
    const notify = vi.fn<(message: string) => Promise<void>>(async () => undefined);
    let t = Date.parse("2026-11-07T08:00:00Z");
    const job = createTrackedJob({ db: handle.db, name: "garmin", log, notify, now: () => new Date(t), run: async () => { throw new Error("down"); } });
    for (let i = 0; i < 6; i++) {
      await job.runNow();
      t += 10 * 60_000;
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0])).toContain("failed 3 times");
    t = Date.parse("2026-11-08T08:00:00Z");
    await job.runNow();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("tick respects backoff, runNow does not, and runs never overlap", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const t = Date.parse("2026-11-07T08:00:00Z");
    const job = createTrackedJob({ db: handle.db, name: "garmin", log, notify: async () => undefined, now: () => new Date(t), run: async () => { calls++; if (calls === 1) throw new Error("x"); await new Promise<void>((r) => (release = r)); } });
    await job.tick();
    await job.tick();
    expect(calls).toBe(1);
    const running = job.runNow();
    expect((await job.runNow()).ran).toBe(false);
    release();
    await running;
    expect(calls).toBe(2);
  });
});

describe("sanitiseError", () => {
  it("removes urls and token values", () => {
    expect(sanitiseError(new Error("fetch http://garmin-mcp:8000/mcp?token=abc failed, key=zzz"))).toBe("fetch [url] failed, key=[redacted]");
  });
});

describe("backup", () => {
  it("writes a consistent copy and keeps only the newest 7", () => {
    handle.sqlite.prepare("insert into settings (key, value) values ('k', '1')").run();
    let last = "";
    for (let day = 1; day <= 9; day++) last = runBackup(handle.sqlite, dir, new Date(`2026-11-${String(day).padStart(2, "0")}T03:10:00Z`));
    const files = readdirSync(join(dir, "backups")).sort();
    expect(files).toHaveLength(BACKUP_KEEP);
    expect(files[0]).toBe("pulse-20261103-0310.db");
    const copy = new Database(last, { readonly: true });
    expect(copy.prepare("select value from settings where key = 'k'").get()).toEqual({ value: "1" });
    expect(copy.prepare("pragma integrity_check").get()).toEqual({ integrity_check: "ok" });
    copy.close();
  });
});
