import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("fails fast with a clear message", () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration[\s\S]*PULSE_PASSWORD_HASH[\s\S]*GARMIN_MCP_URL/);
  });
});
