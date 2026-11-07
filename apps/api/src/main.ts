import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { createMcpConnector } from "./modules/garmin/client.js";
import { createGarminModule } from "./modules/garmin/module.js";
import { modules, startJobs } from "./modules/registry.js";
import { createNotifier } from "./notify.js";

const log = createLogger();

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const { db, sqlite } = openDb(config.DATA_DIR, config.MIGRATIONS_DIR);
const { module: garminModule, garmin } = createGarminModule({
  db,
  sqlite,
  config,
  connect: createMcpConnector(config.GARMIN_MCP_URL),
  notify: createNotifier(config, log),
  log,
});
modules.push(garminModule);
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
