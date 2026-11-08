import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { raceMetaInputSchema, type Module, type RaceMetaResponse } from "@pulse/shared";
import { z } from "zod";
import type { Db } from "../../db/index.js";
import { race, raceMeta } from "../../db/schema.js";
import { getRaceView } from "./data.js";

const putBody = raceMetaInputSchema.extend({ key: z.string().min(1).max(300) });

/**
 * Races screen data and local metadata (D29). Metadata edits are writes to our own database only.
 * Nothing here talks to Garmin, so no confirm tap is needed (docs/ARCHITECTURE.md, race_meta).
 */
export function createRacesModule(deps: { db: Db; now?: () => Date }): Module<Hono> {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());
  return {
    name: "races",
    routes: (app) => {
      app.get("/api/races", (c) => c.json(getRaceView(db, clock())));
      // Sets exactly these fields. null clears one, both null removes the row. The response carries the previous values for an undo.
      app.put("/api/races/meta", async (c) => {
        const body = putBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "Expected key, priority (A, B, C or null) and type (road, trail or null)." }, 400);
        const { key, priority, type } = body.data;
        if (!db.select({ id: race.id }).from(race).where(eq(race.eventKey, key)).get()) return c.json({ error: "Unknown race." }, 404);
        const prev = db.select().from(raceMeta).where(eq(raceMeta.metaKey, key)).get();
        const previous = { priority: prev?.priority ?? null, type: prev?.type ?? null };
        if (priority === null && type === null && !prev?.goalOverrideS && !prev?.notes) {
          db.delete(raceMeta).where(eq(raceMeta.metaKey, key)).run();
        } else {
          const values = { priority, type, updatedAt: clock().toISOString() };
          db.insert(raceMeta).values({ metaKey: key, ...values }).onConflictDoUpdate({ target: raceMeta.metaKey, set: values }).run();
        }
        const out: RaceMetaResponse = { previous, current: { priority, type } };
        return c.json(out);
      });
    },
    jobs: [],
  };
}
