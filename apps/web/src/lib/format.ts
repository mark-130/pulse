const TZ = "Europe/London";

/** "2026-11-07" to "07/11/2026". */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function dow(iso: string): number {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay();
}

/** "Sun 08/11/2026". */
export function formatDayDate(iso: string): string {
  return `${WEEKDAYS[dow(iso)]} ${formatDate(iso)}`;
}

export function weekdayLong(iso: string): string {
  return WEEKDAYS_LONG[dow(iso)] ?? "";
}

/** "HH:mm" in Europe/London from an ISO instant. */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ }).format(new Date(iso));
}

/** "07/11/2026 12:30" in Europe/London from an ISO instant. */
export function formatDateTime(iso: string): string {
  const d = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ }).format(new Date(iso));
  return `${d} ${formatTime(iso)}`;
}

export function formatDurationMin(seconds: number | null): string {
  return seconds === null ? "unknown duration" : `${Math.round(seconds / 60)} min`;
}

/** "1:50:00" or "50:00" from seconds. */
export function formatClock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function formatKm(meters: number | null, digits = 1): string {
  return meters === null ? "no distance" : `${(meters / 1000).toFixed(digits)} km`;
}

/** Garmin enums such as RECOVERY_IN_PROGRESS to "Recovery in progress". */
export function humanise(value: string | null): string {
  if (!value) return "";
  const t = value.replace(/_\d+$/, "").replaceAll("_", " ").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** "09:00 Europe/London". The race's own time zone, never the viewer's. */
export function formatRaceTime(start: string | null, zone: string | null): string {
  if (!start) return "start time unknown";
  return zone ? `${start} ${zone}` : start;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Race distances without padding: 10 km, 21.1 km, 42.195 km. */
export function formatRaceKm(meters: number): string {
  return `${Number((meters / 1000).toFixed(3))} km`;
}
