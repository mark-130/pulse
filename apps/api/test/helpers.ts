import { hashPassword } from "../src/auth/password.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

export async function makeApp(password = "correct horse", baseUrl = "http://192.168.0.10:8210") {
  const config = loadConfig({
    NODE_ENV: "test",
    PULSE_BASE_URL: baseUrl,
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

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";
import { createGarminModule } from "../src/modules/garmin/module.js";
import { verifyApplied } from "../src/modules/proposals/verify.js";
import type { DestinationStream } from "pino";
import { createAiModule } from "../src/modules/ai/module.js";
import type { LlmClient } from "../src/modules/ai/llm.js";
import { aiConfigured } from "../src/modules/ai/usage.js";
import { createProposalsModule } from "../src/modules/proposals/module.js";
import type { GarminWriterFactory } from "../src/modules/proposals/executors/garmin.js";
import { createRacesModule } from "../src/modules/races/module.js";
import { runBackup } from "../src/modules/system/backup.js";
import { buildInfo } from "../src/modules/update/build.js";
import { createUpdateModule } from "../src/modules/update/module.js";
import { createUpdateService } from "../src/modules/update/service.js";
import { fakeGarmin, type FakeOptions } from "./fixtures.js";

/** App with the Garmin module on a temp database, signed in. `clock` controls "now". */
export interface MockWriter {
  calls: { tool: string; args: Record<string, unknown> }[];
  connects: () => number;
  /** Make the next write fail with this message. */
  failWith: (message: string | null) => void;
  factory: GarminWriterFactory;
}

/** Stands in for the Garmin write session. No test ever reaches a real MCP server. */
export function mockWriter(): MockWriter {
  const calls: MockWriter["calls"] = [];
  let connects = 0;
  let failure: string | null = null;
  return {
    calls,
    connects: () => connects,
    failWith: (m) => void (failure = m),
    factory: async () => {
      connects++;
      return {
        async call(tool, args) {
          calls.push({ tool, args });
          if (failure) throw new Error(failure);
          return { text: "ok" };
        },
        async close() {},
      };
    },
  };
}

export async function makeGarminApp(opts: { fake?: FakeOptions; clock?: () => Date; writes?: boolean; env?: Record<string, string>; llm?: LlmClient; logDestination?: DestinationStream; fetchFn?: typeof fetch; autoDebrief?: boolean } = {}) {
  const password = "pw";
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: mkdtempSync(join(tmpdir(), "pulse-app-")),
    PULSE_PASSWORD_HASH: await hashPassword(password),
    PULSE_SESSION_SECRET: "s".repeat(40),
    PULSE_SECRET_KEY: "ab".repeat(32),
    GARMIN_MCP_URL: "http://garmin-mcp:8000/mcp",
    ...opts.env,
  });
  const handle = openDb(config.DATA_DIR);
  const fake = fakeGarmin(opts.fake);
  const log = opts.logDestination ? createLogger("info", opts.logDestination) : createLogger("silent");
  const aiNow = opts.clock ?? (() => new Date());
  const llm = opts.llm ?? null;
  const ai = createAiModule({ db: handle.db, config, llm: aiConfigured(config) ? llm : null, log, now: aiNow });
  const mod = createGarminModule({ db: handle.db, sqlite: handle.sqlite, config, connect: fake.connect, notify: async () => undefined, log, now: opts.clock, sleep: async () => undefined, onWorkoutsSynced: (n) => void verifyApplied(handle.db, n), onSynced: opts.autoDebrief ? () => void ai.afterSync() : undefined });
  const writer = mockWriter();
  // No test reaches the network: the default fetch fails loudly.
  const fetchFn: typeof fetch = opts.fetchFn ?? (async () => { throw new Error("network is not available in tests"); });
  const updateService = createUpdateService({ build: buildInfo(config), enabled: config.WATCHTOWER_TOKEN.trim() !== "", fetchFn, now: opts.clock });
  const updateModule = createUpdateModule({ db: handle.db, service: updateService, now: opts.clock });
  const backupCalls: string[] = [];
  const app0 = { service: updateService, watchtowerUrl: config.WATCHTOWER_URL, token: config.WATCHTOWER_TOKEN, backup: () => { const f = runBackup(handle.sqlite, config.DATA_DIR, opts.clock?.()); backupCalls.push(f); return f; }, fetchFn };
  const proposals = createProposalsModule({ db: handle.db, connect: fake.connect, getWriter: writer.factory, writesEnabled: opts.writes ?? false, app: app0, log, now: opts.clock });
  const app = createApp({ config, log, modules: [mod.module, updateModule, createRacesModule({ db: handle.db, now: opts.clock }), proposals, ai.module] });
  const login = await req(app, "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const get = (path: string) => req(app, path, { headers: { cookie } });
  const post = (path: string) => req(app, path, { method: "POST", headers: { cookie, "x-csrf-token": csrfToken } });
  return { app, handle, fake, writer, mod, ai, backupCalls, updateService, get, post, cookie, csrfToken, config };
}
