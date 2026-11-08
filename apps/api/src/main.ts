import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { createMcpConnector } from "./modules/garmin/client.js";
import { createGarminModule } from "./modules/garmin/module.js";
import { modules, startJobs } from "./modules/registry.js";
import { createMcpWriterFactory } from "./modules/proposals/confirm.js";
import { createProposalsModule } from "./modules/proposals/module.js";
import { verifyApplied } from "./modules/proposals/verify.js";
import { createAnthropicClient } from "./modules/ai/anthropic.js";
import { createAiModule } from "./modules/ai/module.js";
import { aiConfigured } from "./modules/ai/usage.js";
import { reconcileUpdates } from "./modules/proposals/outcome.js";
import { createRacesModule } from "./modules/races/module.js";
import { runBackup } from "./modules/system/backup.js";
import { buildInfo } from "./modules/update/build.js";
import { createUpdateModule } from "./modules/update/module.js";
import { createUpdateService } from "./modules/update/service.js";
import { createNotifier, ntfyEnabled } from "./notify.js";

const log = createLogger();

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

if (!ntfyEnabled(config)) log.info("ntfy alerts off");
const { db, sqlite } = openDb(config.DATA_DIR, config.MIGRATIONS_DIR);
const connectGarmin = createMcpConnector(config.GARMIN_MCP_URL);
const { module: aiModule, afterSync } = createAiModule({
  db,
  config,
  llm: aiConfigured(config) ? createAnthropicClient(config.ANTHROPIC_API_KEY) : null,
  log,
  now: () => new Date(),
});
const { module: garminModule, garmin } = createGarminModule({
  db,
  sqlite,
  config,
  connect: connectGarmin,
  onWorkoutsSynced: (now) => void verifyApplied(db, now),
  onSynced: () => void afterSync(),
  notify: createNotifier(config, log),
  log,
});
log.info(aiConfigured(config) ? "ai on" : "ai off, no key set");
const aiProposalsOn = config.AI_PROPOSALS === "on" && config.PULSE_GARMIN_WRITES === "on";
log.info({ aiProposals: config.AI_PROPOSALS }, aiProposalsOn ? "ai proposals on" : "ai proposals off, no proposal will be created by AI");
const writesEnabled = config.PULSE_GARMIN_WRITES === "on";
log.info({ writes: writesEnabled ? "on" : "off" }, writesEnabled ? "garmin writes on" : "garmin writes off, confirmed changes are dry runs");
const updateService = createUpdateService({ build: buildInfo(config), enabled: config.WATCHTOWER_TOKEN.trim() !== "" });
log.info({ build: updateService.build.shortSha }, updateService.enabled ? "app updates from the app on" : "app updates from the app off, no watchtower token");
// A previous update may have restarted us: settle its outcome now.
reconcileUpdates(db, updateService.build, new Date());
modules.push(
  garminModule,
  createUpdateModule({ db, service: updateService }),
  createRacesModule({ db }),
  aiModule,
  createProposalsModule({
    db,
    connect: connectGarmin,
    getWriter: createMcpWriterFactory(config.GARMIN_MCP_URL),
    writesEnabled,
    app: { service: updateService, watchtowerUrl: config.WATCHTOWER_URL, token: config.WATCHTOWER_TOKEN, backup: () => runBackup(sqlite, config.DATA_DIR), fetchFn: fetch },
    log,
    onApplied: () => void garmin.runNow().catch(() => undefined),
  }),
);
const app = createApp({ config, log, modules });
const crons = startJobs(modules, log);
// Catch up shortly after boot instead of waiting up to 30 minutes.
setTimeout(() => void garmin.tick(), 10_000);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  log.info({ port: info.port }, "pulse listening");
});

function shutdown() {
  for (const c of crons) c.stop();
  server.close();
  sqlite.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
