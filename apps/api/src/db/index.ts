import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof openDb>["db"];

export function openDb(dataDir: string, migrationsDir?: string) {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, "pulse.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  const folder = migrationsDir ?? join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
  migrate(db, { migrationsFolder: folder });
  return { db, sqlite };
}
