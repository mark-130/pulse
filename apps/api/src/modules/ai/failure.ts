import { createHash } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import type { AiFailureInfo } from "@pulse/shared";
import { auditLog } from "../../db/schema.js";
import { sanitiseError } from "../../notify.js";
import { AiFailure, type LlmResponse } from "./llm.js";
export { shortDetail } from "./failure-detail.js";
import { AiUnavailable, type AiFeature, type AiRuntime } from "./runtime.js";

/** A failure is shown again after a reload for this long, until a good result replaces it. */
const SHOW_FOR_MS = 60 * 60_000;
const MAX_DETAIL = 150;

/** Turns anything thrown during an AI feature into a plain failure. Never throws. */
export function toFailure(err: unknown): AiFailure {
  if (err instanceof AiFailure) return err;
  if (err instanceof AiUnavailable) return new AiFailure("cap");
  return new AiFailure("unknown", sanitiseError(err).slice(0, MAX_DETAIL));
}

/**
 * Logs the reason and writes it to the audit record (action ai.failed, target the feature), so the Details line on the
 * card and the record say the same thing. A cap or an AI-off state is not a failure and is not recorded.
 */
export function noteFailure(rt: AiRuntime, feature: AiFeature, err: unknown): AiFailure | null {
  if (err instanceof AiUnavailable) return null;
  const f = toFailure(err);
  const info = { reason: f.reason, label: f.label, detail: f.detail };
  rt.log.warn({ feature, reason: f.reason, detail: f.detail }, "ai feature failed");
  rt.db
    .insert(auditLog)
    .values({ ts: rt.now().toISOString(), actor: "system", action: "ai.failed", target: feature, payloadHash: createHash("sha256").update(JSON.stringify(info)).digest("hex"), result: JSON.stringify(info) })
    .run();
  return f;
}

export function toInfo(f: AiFailure, now: Date): AiFailureInfo {
  return { reason: f.reason, label: f.label, detail: f.detail, at: now.toISOString() };
}

/** The most recent recorded failure for a feature in the last hour, for a card that has no good result. */
export function lastFailure(rt: AiRuntime, feature: AiFeature): AiFailureInfo | null {
  const since = new Date(rt.now().getTime() - SHOW_FOR_MS).toISOString();
  const row = rt.db.select().from(auditLog).where(and(eq(auditLog.action, "ai.failed"), eq(auditLog.target, feature), gte(auditLog.ts, since))).orderBy(desc(auditLog.id)).limit(1).get();
  if (!row) return null;
  try {
    const p = JSON.parse(row.result) as { reason: string; label: string; detail: string | null };
    return { reason: p.reason, label: p.label, detail: p.detail ?? null, at: row.ts };
  } catch {
    return null;
  }
}

/** The text of a reply, or a failure that says why there is none. Truncated text is never stored. */
export function textFrom(res: LlmResponse): string {
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (res.stopReason === "max_tokens") throw new AiFailure("limit", `Stopped at ${res.usage.outputTokens} output tokens.`);
  if (!text) throw new AiFailure("unreadable", "The reply had no text.");
  return text;
}
