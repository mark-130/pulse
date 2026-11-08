import type { Hono } from "hono";
import type { Module } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import { getFitness } from "./data.js";

/** The Fitness tab on Trends (D47). Reads the cache only: Garmin's figures as they are. Nothing here writes anywhere. */
export function createFitnessModule(deps: { db: Db; now?: () => Date }): Module<Hono> {
  const clock = deps.now ?? (() => new Date());
  return { name: "fitness", routes: (app) => void app.get("/api/fitness", (c) => c.json(getFitness(deps.db, clock()))), jobs: [] };
}
