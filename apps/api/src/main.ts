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
import { createRacesModule } from "./modules/races/module.js";
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
const { module: garminModule, garmin } = createGarminModule({
  db,
  sqlite,
  config,
  connect: connectGarmin,
  onWorkoutsSynced: (now) => void verifyApplied(db, now),
  notify: createNotifier(config, log),
  log,
});
const writesEnabled = config.PULSE_GARMIN_WRITES === "on";
log.info({ writes: writesEnabled ? "on" : "off" }, writesEnabled ? "garmin writes on" : "garmin writes off, confirmed changes are dry runs");
modules.push(
  garminModule,
  createRacesModule({ db }),
  createProposalsModule({
    db,
    connect: connectGarmin,
    getWriter: createMcpWriterFactory(config.GARMIN_MCP_URL),
    writesEnabled,
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
