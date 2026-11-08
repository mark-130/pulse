import type { Hono } from "hono";
import type { Module, UpdateCheckResponse, UpdateStatus } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { reconcileUpdates } from "../proposals/outcome.js";
import type { UpdateService } from "./service.js";

/** GET /api/update: the running build and the cached check. POST /api/update/check: read GHCR (or the 10 minute cache). Reads only. */
export function createUpdateModule(deps: { db: Db; service: UpdateService; now?: () => Date }): Module<Hono> {
  const { service } = deps;
  const clock = deps.now ?? (() => new Date());
  return {
    name: "update",
    routes: (app) => {
      app.get("/api/update", (c) => {
        reconcileUpdates(deps.db, service.build, clock());
        const body: UpdateStatus = { build: service.build, updatesEnabled: service.enabled, check: service.cached() };
        return c.json(body);
      });
      app.post("/api/update/check", async (c) => {
        const body: UpdateCheckResponse = { check: await service.check() };
        return c.json(body);
      });
    },
    jobs: [],
  };
}
