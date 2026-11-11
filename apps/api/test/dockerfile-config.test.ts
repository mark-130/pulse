import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");

describe("runtime image dependency pinning (PULSE-005)", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

  it("builds the runtime manifest from the lockfile resolution, not from the caret range", () => {
    expect(dockerfile).toContain("node scripts/runtime-manifest.mjs /out");
    expect(dockerfile).not.toMatch(/dependencies\['better-sqlite3'\]/);
  });

  it("writes an exact better-sqlite3 version equal to the one installed from the lockfile", () => {
    const out = mkdtempSync(join(tmpdir(), "pulse-manifest-"));
    execFileSync("node", [join(root, "scripts/runtime-manifest.mjs"), out], { cwd: root, stdio: "pipe" });
    const manifest = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as { dependencies: Record<string, string>; overrides?: Record<string, string> };
    const installed = JSON.parse(readFileSync(join(root, "apps/api/node_modules/better-sqlite3/package.json"), "utf8")) as { version: string };
    expect(manifest.dependencies["better-sqlite3"]).toBe(installed.version);
    expect(manifest.dependencies["better-sqlite3"]).toMatch(/^\d+\.\d+\.\d+$/);
    for (const v of Object.values(manifest.overrides ?? {})) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
