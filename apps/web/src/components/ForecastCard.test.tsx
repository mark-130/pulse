import type { ForecastHour, RaceWeather } from "@pulse/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ForecastView, rainText, windText } from "./ForecastCard";

const hour = (time: string, isStart = false, o: Partial<ForecastHour> = {}): ForecastHour => ({ time, temperatureC: 7, feelsLikeC: 4, rainChancePct: 40, rainMm: 0.2, windMph: 14, gustMph: 26, windDirDeg: 270, windDir: "W", humidityPct: 80, weatherCode: 61, description: "Light rain", isStart, ...o });
const base: RaceWeather = {
  raceKey: "k", title: "Rhino Run West Bridgford", date: "2026-11-14", daysUntil: 7, past: false,
  place: { state: "found", name: "West Bridgford, England, United Kingdom", latitude: 52.9266, longitude: -1.1275, source: "title" },
  manualPlace: null, inWindow: true, availableFrom: "2026-10-31", startLocal: "09:00", startUnverified: false, raceTimeZone: "Europe/London", forecastTimeZone: "Europe/London",
  forecast: { fetchedAt: "2026-11-07T12:00:00Z", ageMinutes: 30, stale: false, refreshFailed: false, reason: null, atStart: hour("09:00", true), strip: ["07:00", "08:00", "09:00", "10:00", "11:00", "12:00"].map((t) => hour(t, t === "09:00")) },
  waiting: false,
};
const html = (w: RaceWeather) => renderToString(<QueryClientProvider client={new QueryClient()}><ForecastView w={w} /></QueryClientProvider>).replaceAll("<!-- -->", "");

describe("race forecast card", () => {
  it("shows the start hour figures, the hourly strip, the place and the attribution with the fetch time", () => {
    const h = html(base);
    expect(h).toContain("Forecast at the start");
    expect(h).toContain("Sat 14/11/2026, 09:00 hour");
    expect(h).toContain("7°C");
    expect(h).toContain("Feels like 4°C");
    expect(h).toContain("Wind 14 mph W, gusts 26 mph");
    expect(h).toContain("Rain chance 40 percent, 0.2 mm");
    expect(h).toContain("Light rain");
    expect(h).toContain("09:00 start");
    expect(h).toContain("West Bridgford, England, United Kingdom");
    expect(h).toContain("52.9266, -1.1275");
    expect(h).toContain("Guessed from the race title. Check it.");
    expect(h).toContain("Weather data by Open-Meteo.com. Forecasts change. Fetched 12:00 07/11.");
  });
  it("the strip scrolls inside itself, so the page does not scroll sideways", () => {
    const h = html(base);
    expect(h).toMatch(/<ul[^>]*overflow-x-auto[^>]*aria-label="Hourly forecast around the start"/);
    expect(h).toContain('aria-current="time"');
  });
  it("has a Forecast place field with a 44px input and an explicit Save", () => {
    const h = html(base);
    expect(h).toContain(">Forecast place<");
    expect(h).toMatch(/<input[^>]*min-h-11/);
    expect(h).toMatch(/<button[^>]*min-h-11[^>]*type="submit"[^>]*>Save/);
  });
  it("for a race more than 14 days away, says when the forecast is available", () => {
    expect(html({ ...base, inWindow: false, daysUntil: 30, forecast: null, availableFrom: "2026-10-31" })).toContain("Forecast available from 31/10.");
  });
  it("says Forecast place not found, with the field", () => {
    const h = html({ ...base, place: { state: "not_found" }, forecast: null, waiting: false });
    expect(h).toContain("Forecast place not found");
    expect(h).toContain(">Forecast place<");
  });
  it("keeps the last forecast with its age when stale or when the refresh failed", () => {
    const h = html({ ...base, forecast: { ...base.forecast!, ageMinutes: 420, stale: true, refreshFailed: true, reason: "Could not reach Open-Meteo." } });
    expect(h).toContain("This forecast is 7 hours old.");
    expect(h).toContain("The latest refresh failed: Could not reach Open-Meteo.");
    expect(h).toContain("Wind 14 mph W");
  });
  it("shows the unverified start flag and the manual place with a way back to automatic", () => {
    const h = html({ ...base, startLocal: "01:30", startUnverified: true, manualPlace: "Nottingham", place: { state: "found", name: "Nottingham, England", latitude: 52.95, longitude: -1.15, source: "manual" } });
    expect(h).toContain("Start time unverified (01:30).");
    expect(h).toContain("Set by you");
    expect(h).toContain("Use the automatic place");
  });
  it("shows no data plainly and never blanks a field", () => {
    const h = html({ ...base, forecast: { ...base.forecast!, atStart: hour("09:00", true, { temperatureC: null, windMph: null, rainChancePct: null, description: null, feelsLikeC: null }) } });
    expect(h).toContain("no data");
    expect(h).toContain("Wind: no data");
    expect(h).toContain("Rain: no data");
  });
  it("formats wind and rain as plain facts", () => {
    expect(windText(hour("09:00", false, { gustMph: null }))).toBe("Wind 14 mph W");
    expect(rainText(hour("09:00", false, { rainMm: null }))).toBe("Rain chance 40 percent");
  });
  it("carries no clothing, pacing or advice wording", () => {
    expect(html(base)).not.toMatch(/wear|dress|cloth|jacket|layer|gloves|should|recommend|advice|suggest|pacing|prepare|slow down|focus|taper/i);
  });
});
