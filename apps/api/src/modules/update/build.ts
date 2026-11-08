import { shortSha, type BuildInfo } from "@pulse/shared";
import type { Config } from "../../config.js";

/** The build CI stamped into the image. No secrets here: this is served without a session. */
export function buildInfo(config: Pick<Config, "PULSE_BUILD_SHA" | "PULSE_BUILD_TIME">): BuildInfo {
  const sha = config.PULSE_BUILD_SHA.trim().toLowerCase() || "dev";
  const t = Date.parse(config.PULSE_BUILD_TIME.trim());
  return { sha, shortSha: shortSha(sha), builtAt: Number.isNaN(t) ? null : new Date(t).toISOString() };
}
