import type { ForecastHour } from "@pulse/shared";

/** Pure weather rules (D59). No database, no clock, no network. Facts only: nothing here says what to wear or how to run. */

export interface RawHour {
  /** Local time at the place, "YYYY-MM-DDTHH:mm". */
  time: string;
  temperatureC: number | null;
  feelsLikeC: number | null;
  rainChancePct: number | null;
  rainMm: number | null;
  windMph: number | null;
  gustMph: number | null;
  windDirDeg: number | null;
  humidityPct: number | null;
  weatherCode: number | null;
}

const POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"] as const;

/** The direction the wind blows from, as a 16 point compass name. 0 and 360 are north. */
export function compassPoint(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  return POINTS[Math.round(d / 22.5) % 16] as string;
}

/** WMO weather interpretation codes, as used by Open-Meteo. */
const WMO: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Light freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Rain showers",
  82: "Heavy rain showers",
  85: "Light snow showers",
  86: "Snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with heavy hail",
};

export function weatherDescription(code: number | null): string | null {
  return code === null ? null : (WMO[code] ?? "Unknown conditions");
}

const round = (n: number | null, places = 0): number | null => (n === null ? null : Math.round(n * 10 ** places) / 10 ** places);

export function toHour(h: RawHour, isStart: boolean): ForecastHour {
  return {
    time: h.time.slice(11, 16),
    temperatureC: round(h.temperatureC),
    feelsLikeC: round(h.feelsLikeC),
    rainChancePct: round(h.rainChancePct),
    rainMm: round(h.rainMm, 1),
    windMph: round(h.windMph),
    gustMph: round(h.gustMph),
    windDirDeg: round(h.windDirDeg),
    windDir: h.windDirDeg === null ? null : compassPoint(h.windDirDeg),
    humidityPct: round(h.humidityPct),
    weatherCode: h.weatherCode,
    description: weatherDescription(h.weatherCode),
    isStart,
  };
}

function offsetMinutes(instant: Date, zone: string): number {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * A local date and time in one zone, as the local date and time in another. Used so a race start given in the race's own
 * time zone lines up with a forecast whose hours are in the time zone of the coordinates. Returns null for an unknown zone.
 */
export function convertLocal(date: string, hhmm: string, fromZone: string | null, toZone: string | null): { date: string; time: string } | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = m[1] as string;
  const time = `${hh.padStart(2, "0")}:${m[2]}`;
  if (!fromZone || !toZone || fromZone === toZone) return { date, time };
  try {
    const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
    const wall = Date.UTC(y, mo - 1, d, Number(hh), Number(m[2]));
    // Two passes settle the offset across a daylight saving change.
    let instant = new Date(wall - offsetMinutes(new Date(wall), fromZone) * 60_000);
    instant = new Date(wall - offsetMinutes(instant, fromZone) * 60_000);
    const off = offsetMinutes(instant, toZone);
    const local = new Date(instant.getTime() + off * 60_000);
    const iso = local.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  } catch {
    return null;
  }
}

export interface Selection {
  atStart: ForecastHour | null;
  strip: ForecastHour[];
}

/** From 2 hours before the start hour to 3 hours after it, within the hours that were fetched. */
export const STRIP_BEFORE = 2;
export const STRIP_AFTER = 3;
/** With no start time, the morning hours are shown and no start hour figures are given. */
export const UNKNOWN_START_FROM = 6;
export const UNKNOWN_START_TO = 12;

export function selectHours(hours: RawHour[], localDate: string | null, localTime: string | null): Selection {
  const byTime = new Map(hours.map((h) => [h.time, h]));
  const at = (date: string, hour: number) => byTime.get(`${date}T${String(hour).padStart(2, "0")}:00`);
  if (localDate === null || localTime === null) {
    const date = hours[0]?.time.slice(0, 10);
    if (!date) return { atStart: null, strip: [] };
    const strip: ForecastHour[] = [];
    for (let h = UNKNOWN_START_FROM; h <= UNKNOWN_START_TO; h++) {
      const x = at(date, h);
      if (x) strip.push(toHour(x, false));
    }
    return { atStart: null, strip };
  }
  const startHour = Number(localTime.slice(0, 2));
  const strip: ForecastHour[] = [];
  let atStart: ForecastHour | null = null;
  for (let h = startHour - STRIP_BEFORE; h <= startHour + STRIP_AFTER; h++) {
    const x = h >= 0 && h <= 23 ? at(localDate, h) : undefined;
    if (!x) continue;
    const row = toHour(x, h === startHour);
    if (h === startHour) atStart = row;
    strip.push(row);
  }
  return { atStart, strip };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const dayDate = (iso: string) => `${DAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** The one line on Today, for example "Forecast Sat 14/11 09:00: 7C, wind 14 mph W, rain chance 40 percent". Figures only. */
export function todayLine(date: string, atStart: ForecastHour, stale: { fetchedHhmm: string } | null): string {
  const parts: string[] = [];
  if (atStart.temperatureC !== null) parts.push(`${atStart.temperatureC}C`);
  if (atStart.windMph !== null) parts.push(`wind ${atStart.windMph} mph${atStart.windDir ? ` ${atStart.windDir}` : ""}`);
  if (atStart.rainChancePct !== null) parts.push(`rain chance ${atStart.rainChancePct} percent`);
  return `Forecast ${dayDate(date)} ${atStart.time}: ${parts.join(", ")}${stale ? ` (fetched ${stale.fetchedHhmm})` : ""}`;
}

/** "lat,lon" or "lat lon" written as numbers, for a Garmin location that is coordinates and not a name. */
export function parseCoordinates(text: string): { latitude: number; longitude: number } | null {
  const m = text.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}

const NOISE = /\b(half|marathon|ultra|trail|road|run|running|race|10\s?k|5\s?k|10\s?km|5\s?km|mini|fun|parkrun|the|spring|summer|autumn|winter|\d{2,4})\b/gi;

/**
 * Place names to try for a race that has no location, from its title: the title with distance and event words removed, then
 * shorter and shorter endings of it, so a sponsor or event name in front does not stop the town matching.
 * "Rhino Run West Bridgford" gives "Rhino West Bridgford", "West Bridgford". At most 4 are tried.
 */
export function titleCandidates(title: string): string[] {
  const words = title
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " ")
    .replace(NOISE, " ")
    .split(/\s+/)
    .filter((w) => /[a-z]/i.test(w));
  const out: string[] = [];
  for (let i = 0; i < words.length && out.length < 4; i++) {
    const c = words.slice(i).join(" ");
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
