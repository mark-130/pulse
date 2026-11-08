import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("fails fast with a clear message", () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration[\s\S]*PULSE_PASSWORD_HASH[\s\S]*GARMIN_MCP_URL/);
  });

  const base = {
    PULSE_PASSWORD_HASH: `${"a".repeat(32)}:${"b".repeat(128)}`,
    PULSE_SESSION_SECRET: "s".repeat(40),
    PULSE_SECRET_KEY: "ab".repeat(32),
    GARMIN_MCP_URL: "http://garmin-mcp:8000/mcp",
  };
  it("keeps Garmin writes off unless PULSE_GARMIN_WRITES is exactly on", () => {
    expect(loadConfig(base).PULSE_GARMIN_WRITES).toBe("off");
    expect(loadConfig({ ...base, PULSE_GARMIN_WRITES: "off" }).PULSE_GARMIN_WRITES).toBe("off");
    expect(loadConfig({ ...base, PULSE_GARMIN_WRITES: "on" }).PULSE_GARMIN_WRITES).toBe("on");
    expect(() => loadConfig({ ...base, PULSE_GARMIN_WRITES: "true" })).toThrow(/PULSE_GARMIN_WRITES/);
  });
  it("ships off in the compose file", async () => {
    const { readFileSync } = await import("node:fs");
    const compose = readFileSync(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
    expect(compose).toContain('PULSE_GARMIN_WRITES: "${PULSE_GARMIN_WRITES:-off}"');
  });
});
