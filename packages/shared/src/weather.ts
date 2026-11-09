import { z } from "zod";

/** Race day forecast (D59). Facts from Open-Meteo, read from the cache. No advice, no AI. */
export const WEATHER_WINDOW_DAYS = 14;
/** A forecast is refreshed when it is older than this. */
export const FORECAST_REFRESH_HOURS = 3;
/** Past this age, the card says the forecast is stale and shows its age. */
export const FORECAST_STALE_HOURS = 6;
export const FORECAST_ATTRIBUTION = "Weather data by Open-Meteo.com. Forecasts change.";

export const forecastHourSchema = z.object({
  /** Local time at the place, "HH:mm". */
  time: z.string(),
  temperatureC: z.number().nullable(),
  feelsLikeC: z.number().nullable(),
  rainChancePct: z.number().nullable(),
  rainMm: z.number().nullable(),
  windMph: z.number().nullable(),
  gustMph: z.number().nullable(),
  windDirDeg: z.number().nullable(),
  /** Compass point worked out in code from the degrees, for example "WSW". */
  windDir: z.string().nullable(),
  humidityPct: z.number().nullable(),
  weatherCode: z.number().nullable(),
  /** Plain description worked out in code from the weather code. */
  description: z.string().nullable(),
  isStart: z.boolean(),
});
export type ForecastHour = z.infer<typeof forecastHourSchema>;

export const placeSourceSchema = z.enum(["manual", "garmin", "title"]);
export type PlaceSource = z.infer<typeof placeSourceSchema>;

export const forecastPlaceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("found"), name: z.string(), latitude: z.number(), longitude: z.number(), source: placeSourceSchema }),
  z.object({ state: z.literal("not_found") }),
  /** Not looked up yet, or the lookup failed and will be retried. */
  z.object({ state: z.literal("pending"), reason: z.string().nullable() }),
]);
export type ForecastPlace = z.infer<typeof forecastPlaceSchema>;

export const raceWeatherSchema = z.object({
  raceKey: z.string(),
  title: z.string(),
  date: z.string(),
  daysUntil: z.number(),
  past: z.boolean(),
  place: forecastPlaceSchema,
  /** What Mark typed in the Forecast place field, if anything. */
  manualPlace: z.string().nullable(),
  /** False until the race is within 14 days. availableFrom is the date it becomes true. */
  inWindow: z.boolean(),
  availableFrom: z.string(),
  startLocal: z.string().nullable(),
  startUnverified: z.boolean(),
  raceTimeZone: z.string().nullable(),
  forecastTimeZone: z.string().nullable(),
  forecast: z
    .object({
      fetchedAt: z.string(),
      ageMinutes: z.number(),
      stale: z.boolean(),
      /** The latest attempt failed. The last good forecast is still shown. */
      refreshFailed: z.boolean(),
      reason: z.string().nullable(),
      atStart: forecastHourSchema.nullable(),
      /** From 2 hours before the start to 3 hours after it. With no start time, 06:00 to 12:00. */
      strip: z.array(forecastHourSchema),
    })
    .nullable(),
  /** In window, place found, and no forecast stored yet. */
  waiting: z.boolean(),
});
export type RaceWeather = z.infer<typeof raceWeatherSchema>;

export const forecastPlaceInputSchema = z.object({ key: z.string().min(1).max(300), place: z.string().trim().max(120) });
export type ForecastPlaceInput = z.infer<typeof forecastPlaceInputSchema>;

export const forecastPlaceResponseSchema = z.object({ weather: raceWeatherSchema });
export type ForecastPlaceResponse = z.infer<typeof forecastPlaceResponseSchema>;
