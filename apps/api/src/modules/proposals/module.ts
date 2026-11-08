import type { Hono } from "hono";
import { PROBE_RESULT_RECORDED, createProposalRequestSchema, type Module, type ProposalsResponse } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { expireDue, listHistory, listPending, ProposalError, proposeReschedule, proposeUnschedule, rejectProposal } from "./engine.js";
import { registerConfirmRoute, type ConfirmDeps } from "./confirm.js";

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
        const body: ProposalsResponse = { writesEnabled: deps.writesEnabled, probeRecorded: PROBE_RESULT_RECORDED, pending: listPending(db), history: listHistory(db) };
        return c.json(body);
      });
      app.post("/api/proposals", async (c) => {
        const body = createProposalRequestSchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "Expected a reschedule (scheduledId, date) or an unschedule (scheduledId)." }, 400);
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
