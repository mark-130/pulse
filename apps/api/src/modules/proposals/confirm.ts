import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Proposal } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { proposal as proposalTable } from "../../db/schema.js";
import type { Logger } from "../../logger.js";
import { sanitiseError } from "../../notify.js";
import type { GarminConnector } from "../garmin/client.js";
import { appendAudit } from "./audit.js";
import { beginConfirmation, endConfirmation } from "./confirmations.js";
import { expireDue, getProposal, getStateHash, stateHashOf } from "./engine.js";
// The only import of an executor in the API source. eslint.config.js and a test enforce that.
import { createMcpWriterFactory, executeGarminProposal, type GarminWriterFactory } from "./executors/garmin.js";
import { fetchLiveWorkout } from "./live.js";

export { createMcpWriterFactory };

export interface ConfirmDeps {
  db: Db;
  /** Read only Garmin connector, used to re-fetch live state. */
  connect: GarminConnector;
  getWriter: GarminWriterFactory;
  writesEnabled: boolean;
  log: Logger;
  now?: () => Date;
  /** Called after a live change is applied, for example to start a sync. Must not throw. */
  onApplied?: () => void;
}

function decide(db: Db, id: string, status: "applied" | "failed" | "stale", nowIso: string, result: unknown): void {
  db.update(proposalTable).set({ status, decidedAt: nowIso, result }).where(and(eq(proposalTable.id, id), eq(proposalTable.status, "pending"))).run();
}

/**
 * POST /api/proposals/:id/confirm. The session and CSRF checks are the app-wide middleware for every non-GET request.
 * Order: pending and not expired, re-fetch live state, compare state_hash (stale if different), execute, audit, update status.
 */
export function registerConfirmRoute(app: Hono, deps: ConfirmDeps): void {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());

  app.post("/api/proposals/:id/confirm", async (c) => {
    const id = c.req.param("id");
    const now = clock();
    const nowIso = now.toISOString();
    expireDue(db, now);
    const p = getProposal(db, id);
    if (!p) return c.json({ error: "Unknown proposal." }, 404);
    // Idempotent: confirming an applied proposal again returns it and executes nothing.
    if (p.status === "applied") return c.json({ proposal: p });
    if (p.status !== "pending") return c.json({ error: `This proposal is ${p.status}. Nothing was sent.`, proposal: p }, 409);
    if (!beginConfirmation(id)) return c.json({ error: "This proposal is already being confirmed." }, 409);

    try {
      const target = `${p.kind}:${p.before.scheduledId}`;
      let live: Proposal["before"] | null;
      try {
        live = await fetchLiveWorkout(deps.connect, p.before);
      } catch (err) {
        // Cannot compare, so do not execute. The proposal stays pending.
        appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.confirm_blocked", target, payload: { id }, result: "live state unavailable" });
        deps.log.warn({ id, err: sanitiseError(err) }, "confirm blocked: live state unavailable");
        return c.json({ error: "Could not read the current schedule from Garmin. Nothing was sent. Try again shortly." }, 502);
      }
      const storedHash = getStateHash(db, id);
      if (live === null || stateHashOf(live) !== storedHash) {
        decide(db, id, "stale", nowIso, { live, message: live === null ? "The workout is no longer on the Garmin schedule." : "The workout changed in Garmin after this was proposed." });
        appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.stale", target, payload: { id, live }, result: "stale" });
        return c.json({ error: "The workout changed in Garmin since this was proposed. Nothing was sent.", proposal: getProposal(db, id) }, 409);
      }

      try {
        const out = await executeGarminProposal(p, { writesEnabled: deps.writesEnabled, getWriter: deps.getWriter });
        const result = { mode: out.mode, message: out.message, ...(out.mode === "live" ? { verification: { state: "waiting", matches: 0, checks: [] } } : {}) };
        db.transaction(() => {
          decide(db, id, "applied", nowIso, result);
          appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.applied", target, payload: { id, before: p.before, after: p.after }, result: out.mode === "dry_run" ? "dry run" : "live" });
        });
        if (out.mode === "live") {
          try {
            deps.onApplied?.();
          } catch {
            /* a follow-up sync must never turn an applied change into an error */
          }
        }
        return c.json({ proposal: getProposal(db, id) });
      } catch (err) {
        const error = sanitiseError(err);
        db.transaction(() => {
          decide(db, id, "failed", nowIso, { error });
          appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.failed", target, payload: { id }, result: error });
        });
        deps.log.error({ id, err: error }, "proposal execution failed");
        return c.json({ error: "Garmin did not accept the change. See the history for details.", proposal: getProposal(db, id) }, 502);
      }
    } finally {
      endConfirmation(id);
    }
  });
}
