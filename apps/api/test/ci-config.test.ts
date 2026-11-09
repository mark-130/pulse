import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ci = readFileSync(resolve(__dirname, "../../../.github/workflows/ci.yml"), "utf8");
const jobBlock = (name: string): string => {
  const start = ci.indexOf(`\n  ${name}:`);
  const next = ci.slice(start + 1).search(/\n {2}[a-z]+:\n/);
  return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
};

describe("CI workflow permissions (D55)", () => {
  it("grants nothing by default", () => {
    expect(ci).toMatch(/^permissions: \{\}$/m);
  });
  it("gives the check job read-only access", () => {
    const check = jobBlock("check");
    expect(check).toMatch(/contents: read/);
    expect(check).not.toMatch(/write/);
  });
  it("gives only the image job packages: write", () => {
    expect(jobBlock("image")).toMatch(/packages: write/);
    expect(ci.match(/packages: write/g)).toHaveLength(1);
    expect(ci.match(/: write/g)).toHaveLength(1);
  });
  it("pins every action to a full commit SHA", () => {
    const uses = [...ci.matchAll(/uses: (\S+)/g)].map((m) => m[1] as string);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});
