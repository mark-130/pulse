import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";

describe("db", () => {
  it("applies migrations to a fresh database", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-"));
    const { sqlite } = openDb(dir);
    const tables = sqlite.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ["garmin_snapshot", "workout", "race", "proposal", "audit_log", "sync_state", "briefing", "chat_message", "ai_usage", "settings", "secret"]) {
      expect(names).toContain(t);
    }
    sqlite.close();
    rmSync(dir, { recursive: true });
  });
});
