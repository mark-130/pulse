import { and, eq, or } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { UPDATE_OFF_TEXT, VERIFY_WINDOW_HOURS, isAppUpdate, type AppUpdateProposal, type Proposal } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { proposal as proposalTable } from "../../db/schema.js";
import type { Logger } from "../../logger.js";
import { sanitiseError } from "../../notify.js";
import type { GarminConnector } from "../garmin/client.js";
import { appendAudit } from "./audit.js";
import { beginConfirmation, endConfirmation } from "./confirmations.js";
import { CLAIMED_TEXT, claimProposal, clearStaleClaims, expireDue, getProposal, getStateHash, holdsClaim, releaseClaim, stateHashOf, targetOf } from "./engine.js";
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

const CLAIMED_LOST_TEXT = "This confirmation no longer holds the proposal. Nothing was sent.";

const scrub = (text: string, token: string): string => (token ? text.replaceAll(token, "[redacted]") : text);

/**
 * Records the outcome, only while this confirmation still holds the claim (D63), and drops the claim in the same statement.
 * Returns false when it did not hold it, in which case nothing was changed and the caller must not audit a decision.
 */
function decide(db: Db, id: string, token: string, status: "applied" | "failed" | "stale", nowIso: string, result: unknown): boolean {
  return db.update(proposalTable).set({ status, decidedAt: nowIso, result, claimToken: null, claimedAt: null }).where(and(eq(proposalTable.id, id), eq(proposalTable.status, "pending"), eq(proposalTable.claimToken, token))).run().changes === 1;
}

/**
 * POST /api/proposals/:id/confirm. The session and CSRF checks are the app-wide middleware for every non-GET request.
 * Order: pending and not expired, re-fetch live state, compare state_hash (stale if different), execute, audit, update status.
 */
export function registerConfirmRoute(app: Hono, deps: ConfirmDeps): void {
  const { db } = deps;
  // A new process has no confirmation in flight, so a claim left by a crash is dropped here (D63).
  clearStaleClaims(db);
  const clock = deps.now ?? (() => new Date());

  /**
   * app.update: the live state is the build this process is running. If it differs from the build the proposal started from,
   * the app was already updated (for example by the nightly run), so nothing is sent. Otherwise: audit requested, backup,
   * audit backup taken, save as applied and audit called, then call Watchtower. Watchtower stops this process while the
   * request is open, so the outcome is settled later from the running build (outcome.ts).
   */
  async function confirmAppUpdate(c: Context, p: AppUpdateProposal, now: Date, token: string) {
    const nowIso = now.toISOString();
    const wiring = deps.app;
    const target = targetOf(p);
    if (!wiring || wiring.token.trim() === "") return c.json({ error: UPDATE_OFF_TEXT }, 409);
    const running = { sha: wiring.service.build.sha, builtAt: wiring.service.build.builtAt };
    if (stateHashOf(running) !== getStateHash(db, p.id)) {
      if (decide(db, p.id, token, "stale", nowIso, { message: "The app is on a different build than when this was proposed. Nothing was sent." })) {
        appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.stale", target, payload: { id: p.id, running }, result: "stale" });
      }
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
              // Throws before Watchtower is called if the claim is no longer held, which rolls this back.
              if (!decide(db, p.id, token, "applied", nowIso, { mode: "live", message: "Watchtower is being called. The app is expected to restart.", update })) throw new AppUpdateError(CLAIMED_LOST_TEXT);
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
        // Still ours if it is pending under our claim, or already saved as applied by the calling hook above.
        const res = db
          .update(proposalTable)
          .set({ status: "failed", decidedAt: nowIso, result: { error: message }, claimToken: null, claimedAt: null })
          .where(and(eq(proposalTable.id, p.id), or(and(eq(proposalTable.status, "pending"), eq(proposalTable.claimToken, token)), eq(proposalTable.status, "applied"))))
          .run();
        if (res.changes) appendAudit(db, { ts: nowIso, actor: "system", action: "proposal.failed", target, payload: { id: p.id }, result: message });
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

    // Claim the proposal in the database before anything is awaited. While the claim is held, reject and expiry
    // cannot change it, and every outcome below only applies if this token still holds it (D63).
    let token: string | null = null;
    try {
      token = claimProposal(db, id, now);
      if (!token) {
        const now2 = getProposal(db, id);
        if (now2 && now2.status === "applied") return c.json({ proposal: now2 });
        return c.json({ error: now2 && now2.status === "pending" ? CLAIMED_TEXT : `This proposal is ${now2?.status ?? "gone"}. Nothing was sent.`, proposal: now2 }, 409);
      }
      if (isAppUpdate(p)) return await confirmAppUpdate(c, p, now, token);
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
        if (decide(db, id, token, "stale", nowIso, { live, message: live === null ? "The workout is no longer on the Garmin schedule." : "The workout changed in Garmin after this was proposed." })) {
          appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.stale", target, payload: { id, live }, result: "stale" });
        }
        return c.json({ error: "The workout changed in Garmin since this was proposed. Nothing was sent.", proposal: getProposal(db, id) }, 409);
      }

      try {
        const held = token;
        const out = await executeGarminProposal(p, { writesEnabled: deps.writesEnabled, getWriter: deps.getWriter, holdsClaim: () => holdsClaim(db, id, held) });
        const result = { mode: out.mode, message: out.message, ...(out.mode === "live" ? { verification: { state: "waiting", matches: 0, checks: [], lastConfirmedAt: null, windowEndsAt: new Date(now.getTime() + VERIFY_WINDOW_HOURS * 3_600_000).toISOString() } } : {}) };
        db.transaction(() => {
          // The write has happened, so the audit entry is written whatever decide reports.
          decide(db, id, held, "applied", nowIso, result);
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
        const failedToken = token;
        db.transaction(() => {
          if (decide(db, id, failedToken, "failed", nowIso, { error })) appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.failed", target, payload: { id }, result: error });
        });
        deps.log.error({ id, err: error }, "proposal execution failed");
        return c.json({ error: "Garmin did not accept the change. See the history for details.", proposal: getProposal(db, id) }, 502);
      }
    } finally {
      // Any path that did not decide the proposal (a blocked read, an unexpected error) gives it back as pending.
      if (token) releaseClaim(db, id, token);
      endConfirmation(id);
    }
  });
}
