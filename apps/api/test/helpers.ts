import { hashPassword } from "../src/auth/password.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

export async function makeApp(password = "correct horse") {
  const config = loadConfig({
    NODE_ENV: "test",
    PULSE_PASSWORD_HASH: await hashPassword(password),
    PULSE_SESSION_SECRET: "s".repeat(40),
    PULSE_SECRET_KEY: "ab".repeat(32),
    GARMIN_MCP_URL: "http://garmin-mcp:8000/mcp",
  });
  return createApp({ config, log: createLogger("silent") });
}

/** Hono's test client has no socket, so supply one for getConnInfo. */
export function req(app: Awaited<ReturnType<typeof makeApp>>, path: string, init: RequestInit = {}, ip = "10.0.0.1") {
  return app.request(path, init, { incoming: { socket: { remoteAddress: ip } } });
}
