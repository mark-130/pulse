import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { aiText } from "../../db/schema.js";

export type TextKind = "weekly_review" | "debrief";

export interface StoredText<D = Record<string, unknown>> {
  text: string;
  data: D;
  model: string;
  createdAt: string;
}

/** Generated text is cached here. It is read, and only written again when Mark taps Refresh. */
export function getStored<D = Record<string, unknown>>(db: Db, kind: TextKind, key: string): StoredText<D> | null {
  const r = db.select().from(aiText).where(and(eq(aiText.kind, kind), eq(aiText.key, key))).get();
  return r ? { text: r.text, data: (r.data ?? {}) as D, model: r.model, createdAt: r.createdAt } : null;
}

export function putStored(db: Db, kind: TextKind, key: string, v: { text: string; data?: unknown; model: string; tokens: number; now: Date }): void {
  const values = { kind, key, text: v.text, data: v.data ?? null, model: v.model, tokens: v.tokens, createdAt: v.now.toISOString() };
  db.insert(aiText).values(values).onConflictDoUpdate({ target: [aiText.kind, aiText.key], set: values }).run();
}

