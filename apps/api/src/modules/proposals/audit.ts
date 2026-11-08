import { createHash } from "node:crypto";
import type { Db } from "../../db/index.js";
import { auditLog } from "../../db/schema.js";

/** Stable hash of any JSON value: keys sorted, so the same content always hashes the same. */
export function canonicalHash(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canon(value))).digest("hex");
}

/** The only way the app writes audit_log. There is no update or delete here, and the database refuses both (migration 0004). */
export function appendAudit(db: Db, entry: { ts: string; actor: "user" | "ai" | "system"; action: string; target: string; payload: unknown; result: string }): void {
  db.insert(auditLog)
    .values({ ts: entry.ts, actor: entry.actor, action: entry.action, target: entry.target, payloadHash: canonicalHash(entry.payload), result: entry.result })
    .run();
}
