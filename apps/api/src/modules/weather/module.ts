import type { Hono } from "hono";
import { forecastPlaceInputSchema, type ForecastPlaceResponse, type Module } from "@pulse/shared";
import type { Db } from "../../db/index.js";
import type { Logger } from "../../logger.js";
import { getRaceWeather, PlaceNotFound, saveForecastPlace, syncWeather } from "./data.js";
import { WeatherError, type FetchFn } from "./openmeteo.js";

/**
 * Race day forecast (D59). The routes read the cache. Only the sync job, and a save of the Forecast place field, talk to
 * Open-Meteo, and they send a place name or coordinates and a date, nothing else. No AI, no writes to Garmin.
 */
export function createWeatherModule(deps: { db: Db; fetchFn?: FetchFn; now?: () => Date; log?: Logger }): { module: Module<Hono>; tick: () => Promise<void> } {
  const { db, log } = deps;
  const clock = deps.now ?? (() => new Date());
  const fetchFn: FetchFn = deps.fetchFn ?? ((...a) => fetch(...a));
  let running: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    running ??= syncWeather(db, fetchFn, clock(), log)
      .then(() => undefined)
      .catch((err: unknown) => void log?.error({ err }, "weather sync failed"))
      .finally(() => void (running = null));
    return running;
  };
  const module: Module<Hono> = {
    name: "weather",
    routes: (app) => {
      app.get("/api/races/weather", (c) => {
        const w = getRaceWeather(db, clock(), c.req.query("race") ?? "");
        return w ? c.json(w) : c.json({ error: "Unknown race." }, 404);
      });
      // An explicit save, audited like the Kotcha zones. Only a place name is sent to Open-Meteo.
      app.put("/api/races/forecast-place", async (c) => {
        const body = forecastPlaceInputSchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "Send a race key and a place name of up to 120 characters." }, 400);
        try {
          await saveForecastPlace(db, fetchFn, clock(), body.data.key, body.data.place);
        } catch (err) {
          if (err instanceof PlaceNotFound) return c.json({ error: err.message }, err.message === "Unknown race." ? 404 : 422);
          if (err instanceof WeatherError) return c.json({ error: err.message }, 502);
          throw err;
        }
        // Fetch the forecast for the new place now, so the card is not empty. A failure is kept for the card to show.
        await tick();
        const weather = getRaceWeather(db, clock(), body.data.key);
        if (!weather) return c.json({ error: "Unknown race." }, 404);
        const out: ForecastPlaceResponse = { weather };
        return c.json(out);
      });
    },
    jobs: [{ name: "weather-sync", schedule: "10,40 * * * *", run: tick }],
  };
  return { module, tick };
}
