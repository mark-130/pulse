import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { modules, startJobs } from "./modules/registry.js";

const log = createLogger();

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const { sqlite } = openDb(config.DATA_DIR, config.MIGRATIONS_DIR);
const app = createApp({ config, log, modules });
const crons = startJobs(modules, log);

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
