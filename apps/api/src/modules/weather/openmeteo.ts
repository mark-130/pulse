import { z } from "zod";
import type { RawHour } from "./logic.js";

/**
 * The only code that talks to Open-Meteo (D59). No key. What is sent: a place name (geocoding) or coordinates and a date
 * (forecast). Nothing about Mark, no account, no race title unless it is the place name guessed from it, and a generic
 * User-Agent with no email address or other personal detail.
 */
export const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const USER_AGENT = "ngtive-split-weather/1.0";
export const TIMEOUT_MS = 15_000;

export type FetchFn = typeof fetch;

/** A plain reason for the card. Never holds a URL, so it never holds coordinates or a place name. */
export class WeatherError extends Error {}

const geocodeSchema = z.object({
  results: z
    .array(z.object({ name: z.string(), latitude: z.number(), longitude: z.number(), country: z.string().optional(), admin1: z.string().optional(), timezone: z.string().optional() }))
    .optional(),
});

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
}

async function getJson(fetchFn: FetchFn, url: URL): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    throw new WeatherError(name === "TimeoutError" || name === "AbortError" ? "Open-Meteo did not answer in time." : "Could not reach Open-Meteo.");
  }
  if (res.status === 429) throw new WeatherError("Open-Meteo is limiting requests. Try again later.");
  if (!res.ok) throw new WeatherError(`Open-Meteo answered with an error (${res.status}).`);
  try {
    return await res.json();
  } catch {
    throw new WeatherError("Open-Meteo sent an answer that could not be read.");
  }
}

/** The first match for a place name, or null. Only the name is sent. */
export async function geocodeOne(fetchFn: FetchFn, name: string): Promise<Place | null> {
  const url = new URL(GEOCODING_URL);
  url.searchParams.set("name", name);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const parsed = geocodeSchema.safeParse(await getJson(fetchFn, url));
  if (!parsed.success) throw new WeatherError("Open-Meteo sent an answer that could not be read.");
  const hit = parsed.data.results?.[0];
  if (!hit) return null;
  const label = [hit.name, hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : null, hit.country].filter(Boolean).join(", ");
  return { name: label, latitude: hit.latitude, longitude: hit.longitude };
}

/** Tries the whole text, then the part before the first comma ("Brighton and Hove, GB" then "Brighton and Hove"). */
export async function geocodePlace(fetchFn: FetchFn, text: string): Promise<Place | null> {
  const t = text.trim();
  if (!t) return null;
  const first = await geocodeOne(fetchFn, t);
  if (first) return first;
  const head = t.split(",")[0]?.trim();
  return head && head !== t ? geocodeOne(fetchFn, head) : null;
}

const HOURLY = ["temperature_2m", "apparent_temperature", "precipitation_probability", "precipitation", "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "weather_code", "relative_humidity_2m"] as const;

const numArr = z.array(z.number().nullable());
const forecastSchema = z.object({
  timezone: z.string(),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: numArr,
    apparent_temperature: numArr,
    precipitation_probability: numArr,
    precipitation: numArr,
    wind_speed_10m: numArr,
    wind_gusts_10m: numArr,
    wind_direction_10m: numArr,
    weather_code: numArr,
    relative_humidity_2m: numArr,
  }),
});

export interface Forecast {
  timeZone: string;
  hours: RawHour[];
}

/** The hourly forecast for one date at one place. Only coordinates and the date are sent. Metric, with wind in mph. */
export async function fetchForecast(fetchFn: FetchFn, latitude: number, longitude: number, date: string): Promise<Forecast> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set("latitude", String(Math.round(latitude * 10_000) / 10_000));
  url.searchParams.set("longitude", String(Math.round(longitude * 10_000) / 10_000));
  url.searchParams.set("hourly", HOURLY.join(","));
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("precipitation_unit", "mm");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);
  const parsed = forecastSchema.safeParse(await getJson(fetchFn, url));
  if (!parsed.success) throw new WeatherError("Open-Meteo sent a forecast that could not be read.");
  const h = parsed.data.hourly;
  const hours: RawHour[] = h.time.map((time, i) => ({
    time,
    temperatureC: h.temperature_2m[i] ?? null,
    feelsLikeC: h.apparent_temperature[i] ?? null,
    rainChancePct: h.precipitation_probability[i] ?? null,
    rainMm: h.precipitation[i] ?? null,
    windMph: h.wind_speed_10m[i] ?? null,
    gustMph: h.wind_gusts_10m[i] ?? null,
    windDirDeg: h.wind_direction_10m[i] ?? null,
    humidityPct: h.relative_humidity_2m[i] ?? null,
    weatherCode: h.weather_code[i] ?? null,
  }));
  if (hours.length === 0) throw new WeatherError("Open-Meteo sent no hours for that date.");
  return { timeZone: parsed.data.timezone, hours };
}
