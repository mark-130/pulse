import type { Hono } from "hono";
import { PROBE_RESULT_RECORDED, UPDATE_OFF_TEXT, createProposalRequestSchema, type Module, type ProposalsResponse } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { expireDue, listHistory, listPending, ProposalError, proposeAppUpdate, proposeReschedule, proposeUnschedule, rejectProposal } from "./engine.js";
import { registerConfirmRoute, type ConfirmDeps } from "./confirm.js";
import { reconcileUpdates } from "./outcome.js";

export interface ProposalsDeps extends ConfirmDeps {
  db: Db;
}

/** Proposals API. Creating, rejecting and listing never leave our own database. Only confirm can reach an executor. */
export function createProposalsModule(deps: ProposalsDeps): Module<Hono> {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());
  return {
    name: "proposals",
    routes: (app) => {
      app.get("/api/proposals", (c) => {
        expireDue(db, clock());
        if (deps.app) reconcileUpdates(db, deps.app.service.build, clock());
        const body: ProposalsResponse = { writesEnabled: deps.writesEnabled, probeRecorded: PROBE_RESULT_RECORDED, pending: listPending(db), history: listHistory(db) };
        return c.json(body);
      });
      app.post("/api/proposals", async (c) => {
        const body = createProposalRequestSchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "Expected a reschedule (scheduledId, date), an unschedule (scheduledId) or an app update." }, 400);
        if (body.data.kind === "app.update") {
          const wiring = deps.app;
          if (!wiring || wiring.token.trim() === "") return c.json({ error: UPDATE_OFF_TEXT }, 409);
          // A failed check never blocks this: the new build is then simply unknown.
          const check = await wiring.service.check();
          const { build } = wiring.service;
          const latest = check.latest ? { sha: check.latest.sha, builtAt: check.latest.builtAt } : null;
          return c.json({ proposal: proposeAppUpdate(db, { running: { sha: build.sha, builtAt: build.builtAt }, latest, now: clock() }) });
        }
        try {
          const p = body.data.kind === "garmin.reschedule" ? proposeReschedule(db, body.data.scheduledId, body.data.date, clock()) : proposeUnschedule(db, body.data.scheduledId, clock());
          return c.json({ proposal: p });
        } catch (err) {
          if (err instanceof ProposalError) return c.json({ error: err.message }, err.status);
          throw err;
        }
      });
      app.post("/api/proposals/:id/reject", (c) => {
        try {
          return c.json({ proposal: rejectProposal(db, c.req.param("id"), clock()) });
        } catch (err) {
          if (err instanceof ProposalError) return c.json({ error: err.message }, err.status);
          throw err;
        }
      });
      registerConfirmRoute(app, deps);
    },
    jobs: [],
  };
}
