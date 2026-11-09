import type { Hono } from "hono";
import { kotchaSaveSchema, type Module } from "@pulse/shared";
import { z } from "zod";
import type { Db } from "../../db/index.js";
import { confirmGarmin, getVo2View, getZonesView, saveKotcha, ZonesError } from "./data.js";

/**
 * Heart rate zones and VO2 max for Today and Trends (D46). Reads the cache. The only writes are to our own tables (Mark's Kotcha copy
 * and the confirmed Garmin zones), each on an explicit tap and audited. Nothing here can write to Garmin or Kotcha.
 */
export function createZonesModule(deps: { db: Db; now?: () => Date }): Module<Hono> {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());
  return {
    name: "zones",
    routes: (app) => {
      app.get("/api/zones", (c) => c.json(getZonesView(db, clock())));
      app.post("/api/zones/kotcha", async (c) => {
        const body = kotchaSaveSchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "Send the five zone tops." }, 400);
        try {
          return c.json(saveKotcha(db, body.data.tops, clock()));
        } catch (err) {
          if (err instanceof ZonesError) return c.json({ error: err.message }, err.status);
          throw err;
        }
      });
      app.post("/api/zones/confirm", (c) => {
        try {
          return c.json(confirmGarmin(db, clock()));
        } catch (err) {
          if (err instanceof ZonesError) return c.json({ error: err.message }, err.status);
          throw err;
        }
      });
      app.get("/api/vo2max", (c) => {
        const q = z.coerce.number().int().min(7).max(1100).safeParse(c.req.query("days") ?? "30");
        return q.success ? c.json(getVo2View(db, clock(), q.data)) : c.json({ error: "days must be 7 to 1100" }, 400);
      });
    },
    jobs: [],
  };
}
