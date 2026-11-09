import { useState } from "react";
import { MapPin, TriangleAlert } from "lucide-react";
import { FORECAST_ATTRIBUTION, type ForecastHour, type RaceWeather } from "@pulse/shared";
import { Button } from "@/components/ui";
import { formatClockDay, formatDate, formatDayDate } from "@/lib/format";
import { useRaceWeather, useSetForecastPlace } from "@/lib/queries";

const SOURCE_TEXT = { manual: "Set by you", garmin: "From the Garmin race event", title: "Guessed from the race title. Check it" } as const;
const n = (v: number | null, unit: string) => (v === null ? "no data" : `${v}${unit}`);

export function windText(h: ForecastHour): string {
  return h.windMph === null ? "Wind: no data" : `Wind ${h.windMph} mph${h.windDir ? ` ${h.windDir}` : ""}${h.gustMph !== null ? `, gusts ${h.gustMph} mph` : ""}`;
}
export function rainText(h: ForecastHour): string {
  return h.rainChancePct === null ? "Rain: no data" : `Rain chance ${h.rainChancePct} percent${h.rainMm !== null ? `, ${h.rainMm} mm` : ""}`;
}

function Strip({ hours }: { hours: ForecastHour[] }) {
  if (hours.length === 0) return null;
  return (
    // Scrolls inside the strip when it is wider than the card, so the page never scrolls sideways.
    <ul className="mt-3 flex gap-2 overflow-x-auto pb-2" tabIndex={0} aria-label="Hourly forecast around the start">
      {hours.map((h) => (
        <li key={h.time} aria-current={h.isStart ? "time" : undefined} className={`min-w-[4.75rem] shrink-0 rounded-2xl border px-2 py-2 text-center ${h.isStart ? "border-accent bg-surface-2" : "border-border"}`}>
          <p className="t-label">{h.time}{h.isStart ? " start" : ""}</p>
          <p className="font-display text-[17px] font-semibold">{n(h.temperatureC, "°")}</p>
          <p className="t-label">{h.windMph === null ? "no wind data" : `${h.windMph} mph ${h.windDir ?? ""}`}</p>
          <p className="t-label">{h.rainChancePct === null ? "no rain data" : `${h.rainChancePct}% rain`}</p>
        </li>
      ))}
    </ul>
  );
}

export function PlaceField({ w }: { w: RaceWeather }) {
  const set = useSetForecastPlace();
  const [text, setText] = useState(w.manualPlace ?? "");
  const place = w.place;
  const save = (value: string) => set.mutate({ key: w.raceKey, place: value });
  return (
    <div className="mt-3 border-t border-border pt-3">
      {place.state === "found" && (
        <>
          <p className="flex items-start gap-1 text-[15px] [overflow-wrap:anywhere]"><MapPin aria-hidden className="mt-0.5 size-4 shrink-0" /><span>{place.name}</span></p>
          <p className="t-secondary">{place.latitude}, {place.longitude}. {SOURCE_TEXT[place.source]}.</p>
        </>
      )}
      {place.state === "not_found" && <p role="status" className="text-[15px] font-medium">Forecast place not found</p>}
      {place.state === "pending" && <p role="status" className="t-secondary">{place.reason ? `${place.reason} It will be tried again.` : "Looking up the forecast place."}</p>}
      <form
        className="mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          save(text.trim());
        }}
      >
        <label htmlFor={`forecast-place-${w.raceKey}`} className="t-label block">Forecast place</label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            id={`forecast-place-${w.raceKey}`}
            value={text}
            maxLength={120}
            onChange={(e) => setText(e.target.value)}
            placeholder="Town or venue"
            autoComplete="off"
            className="min-h-11 min-w-0 flex-1 basis-40 rounded-2xl border border-border-strong bg-surface-2 px-4 text-[15px] text-foreground"
          />
          <Button type="submit" variant="secondary" disabled={set.isPending || text.trim() === (w.manualPlace ?? "")}>{set.isPending ? "Saving" : "Save"}</Button>
        </div>
      </form>
      {w.manualPlace && (
        <Button variant="secondary" className="mt-2" disabled={set.isPending} onClick={() => { setText(""); save(""); }}>Use the automatic place</Button>
      )}
      {set.isError && <p role="alert" className="mt-2 text-[13px] font-medium text-danger">{set.error.message}</p>}
    </div>
  );
}

/** Race day forecast: figures from the cache, as they are. No wording about clothing, pacing or what to do. */
export function ForecastView({ w }: { w: RaceWeather }) {
  const f = w.forecast;
  const start = f?.atStart ?? null;
  return (
    <section className="card min-w-0" aria-labelledby={`forecast-title-${w.raceKey}`}>
      <h2 id={`forecast-title-${w.raceKey}`} className="t-card-title mb-2">Forecast at the start</h2>
      {!w.inWindow && <p className="text-[15px]">Forecast available from {formatDate(w.availableFrom).slice(0, 5)}.</p>}
      {w.inWindow && w.place.state === "not_found" && <p className="text-[15px]">No forecast: the place was not found.</p>}
      {w.inWindow && w.waiting && <p className="text-[15px]">The forecast has not been fetched yet. It is fetched every 3 hours.</p>}
      {w.inWindow && f && (
        <>
          {start ? (
            <>
              <p className="t-label">{formatDayDate(w.date)}, {start.time} hour{w.forecastTimeZone ? `, ${w.forecastTimeZone}` : ""}</p>
              <p className="font-display text-[28px] font-bold">{n(start.temperatureC, "°C")}</p>
              <p className="text-[15px]">{start.feelsLikeC === null ? "Feels like: no data" : `Feels like ${start.feelsLikeC}°C`}</p>
              <p className="text-[15px]">{windText(start)}</p>
              <p className="text-[15px]">{rainText(start)}</p>
              <p className="text-[15px]">{start.description ?? "Conditions: no data"}</p>
            </>
          ) : (
            <p className="text-[15px]">{w.startLocal ? "No hour matches the start time in this forecast." : "The start time is not in Garmin, so there are no start figures. The morning hours are shown."}</p>
          )}
          {w.startUnverified && <p className="t-secondary mt-1 flex items-start gap-1"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-[color:var(--state-warn)]" />Start time unverified ({w.startLocal}).</p>}
          <Strip hours={f.strip} />
          {(f.stale || f.refreshFailed) && (
            <p role="status" className="t-secondary mt-1 [overflow-wrap:anywhere]">
              {f.stale ? `This forecast is ${Math.round(f.ageMinutes / 60)} hours old. ` : ""}{f.refreshFailed ? `The latest refresh failed: ${f.reason}` : ""}
            </p>
          )}
        </>
      )}
      <PlaceField key={`${w.raceKey}|${w.manualPlace ?? ""}`} w={w} />
      <p className="t-label mt-3">{FORECAST_ATTRIBUTION}{f ? ` Fetched ${formatClockDay(f.fetchedAt)}.` : ""}</p>
    </section>
  );
}

export function ForecastCard({ raceKey }: { raceKey: string }) {
  const q = useRaceWeather(raceKey);
  if (q.isPending) return null;
  if (q.isError || q.data.past) return null;
  return <ForecastView w={q.data} />;
}
