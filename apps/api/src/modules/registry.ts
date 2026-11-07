import { Cron } from "croner";
import type { Hono } from "hono";
import type { Module } from "@pulse/shared";
import type { Logger } from "../logger.js";

export type ApiModule = Module<Hono>;

/** Modules register here. Empty in Phase 0. */
export const modules: ApiModule[] = [];

export function registerRoutes(app: Hono, mods: ApiModule[]): void {
  for (const mod of mods) mod.routes?.(app);
}

export function startJobs(mods: ApiModule[], log: Logger): Cron[] {
  const crons: Cron[] = [];
  for (const mod of mods) {
    for (const job of mod.jobs ?? []) {
      crons.push(
        new Cron(job.schedule, { timezone: "Europe/London", protect: true }, () => {
          job.run().catch((err: unknown) => log.error({ err, job: job.name }, "job failed"));
        }),
      );
    }
  }
  return crons;
}
