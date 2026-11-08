import { and, eq, inArray } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { UPDATE_OFF_TEXT, VERIFY_WINDOW_HOURS, isAppUpdate, type AppUpdateProposal, type Proposal } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { proposal as proposalTable } from "../../db/schema.js";
import type { Logger } from "../../logger.js";
import { sanitiseError } from "../../notify.js";
import type { GarminConnector } from "../garmin/client.js";
import { appendAudit } from "./audit.js";
import { beginConfirmation, endConfirmation } from "./confirmations.js";
import { expireDue, getProposal, getStateHash, stateHashOf, targetOf } from "./engine.js";
import type { UpdateService } from "../update/service.js";
// The only import of an executor in the API source. eslint.config.js and a test enforce that.
import { AppUpdateError, executeAppUpdate } from "./executors/app.js";
import { createMcpWriterFactory, executeGarminProposal, type GarminWriterFactory } from "./executors/garmin.js";
import { fetchLiveWorkout } from "./live.js";

export { createMcpWriterFactory };

/** What the app.update executor needs. Absent or without a token means updating from the app is off. */
export interface AppUpdateWiring {
  service: UpdateService;
  watchtowerUrl: string;
  /** Never logged, returned or stored. */
  token: string;
  /** Same VACUUM INTO backup as the nightly job. Returns the file path. */
  backup: () => string;
  fetchFn: typeof fetch;
}

export interface ConfirmDeps {
  app?: AppUpdateWiring;
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

const scrub = (text: string, token: string): string => (token ? text.replaceAll(token, "[redacted]") : text);

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

  /**
   * app.update: the live state is the build this process is running. If it differs from the build the proposal started from,
   * the app was already updated (for example by the nightly run), so nothing is sent. Otherwise: audit requested, backup,
   * audit backup taken, save as applied and audit called, then call Watchtower. Watchtower stops this process while the
   * request is open, so the outcome is settled later from the running build (outcome.ts).
   */
  async function confirmAppUpdate(c: Context, p: AppUpdateProposal, now: Date) {
    const nowIso = now.toISOString();
    const wiring = deps.app;
    const target = targetOf(p);
    if (!wiring || wiring.token.trim() === "") return c.json({ error: UPDATE_OFF_TEXT }, 409);
    const running = { sha: wiring.service.build.sha, builtAt: wiring.service.build.builtAt };
    if (stateHashOf(running) !== getStateHash(db, p.id)) {
      decide(db, p.id, "stale", nowIso, { message: "The app is on a different build than when this was proposed. Nothing was sent." });
      appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.stale", target, payload: { id: p.id, running }, result: "stale" });
      return c.json({ error: "The app is on a different build than when this was proposed. Nothing was sent.", proposal: getProposal(db, p.id) }, 409);
    }
    let backupFile: string | null = null;
    try {
      const out = await executeAppUpdate(p, {
        watchtowerUrl: wiring.watchtowerUrl,
        token: wiring.token,
        backup: wiring.backup,
        fetchFn: wiring.fetchFn,
        hooks: {
          requested: () => appendAudit(db, { ts: nowIso, actor: "user", action: "update.requested", target, payload: { id: p.id, from: p.before.sha, to: p.after?.sha ?? null }, result: "requested" }),
          backupTaken: (file) => {
            backupFile = file;
            appendAudit(db, { ts: nowIso, actor: "system", action: "update.backup_taken", target, payload: { id: p.id, file }, result: "ok" });
          },
          calling: () =>
            db.transaction(() => {
              const update = { state: "requested" as const, calledAt: nowIso, backup: backupFile, watchtowerStatus: null, resolvedAt: null, runningSha: null };
              decide(db, p.id, "applied", nowIso, { mode: "live", message: "Watchtower is being called. The app is expected to restart.", update });
              appendAudit(db, { ts: nowIso, actor: "system", action: "update.called", target, payload: { id: p.id }, result: "calling" });
              appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.applied", target, payload: { id: p.id, before: p.before, after: p.after }, result: "live" });
            }),
        },
      });
      const done = getProposal(db, p.id);
      if (done && isAppUpdate(done) && done.result?.update) {
        db.update(proposalTable)
          .set({ result: { ...done.result, message: out.message, update: { ...done.result.update, watchtowerStatus: out.watchtowerStatus } } })
          .where(and(eq(proposalTable.id, p.id), eq(proposalTable.status, "applied")))
          .run();
      }
      deps.log.info({ id: p.id, status: out.watchtowerStatus }, "app update: watchtower called");
      return c.json({ proposal: getProposal(db, p.id) });
    } catch (err) {
      const message = scrub(err instanceof AppUpdateError ? err.message : `The update request failed. ${sanitiseError(err)}`, wiring.token);
      db.transaction(() => {
        db.update(proposalTable).set({ status: "failed", decidedAt: nowIso, result: { error: message } }).where(and(eq(proposalTable.id, p.id), inArray(proposalTable.status, ["pending", "applied"]))).run();
        appendAudit(db, { ts: nowIso, actor: "system", action: "proposal.failed", target, payload: { id: p.id }, result: message });
      });
      deps.log.error({ id: p.id, err: message }, "app update failed");
      return c.json({ error: message, proposal: getProposal(db, p.id) }, 502);
    }
  }

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
      if (isAppUpdate(p)) return await confirmAppUpdate(c, p, now);
      const target = targetOf(p);
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
        const result = { mode: out.mode, message: out.message, ...(out.mode === "live" ? { verification: { state: "waiting", matches: 0, checks: [], lastConfirmedAt: null, windowEndsAt: new Date(now.getTime() + VERIFY_WINDOW_HOURS * 3_600_000).toISOString() } } : {}) };
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
