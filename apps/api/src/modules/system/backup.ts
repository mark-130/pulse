import type Database from "better-sqlite3";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const BACKUP_KEEP = 7;
const NAME = /^pulse-\d{8}-\d{4}\.db$/;

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
}

/** Consistent online copy with VACUUM INTO, then keep only the newest BACKUP_KEEP. Returns the new file path. */
export function runBackup(sqlite: Database.Database, dataDir: string, now: Date = new Date()): string {
  const dir = join(dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `pulse-${stamp(now)}.db`);
  rmSync(target, { force: true });
  sqlite.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  const files = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) rmSync(join(dir, old), { force: true });
  return target;
}
