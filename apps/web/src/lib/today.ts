const TZ = "Europe/London";

export function greetingFor(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: TZ }).format(now));
  const part = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  return `${part}, Mark`;
}

/** For example "Saturday 07/11/2026". */
export function dateLine(now: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: TZ }).format(now);
  const date = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ }).format(now);
  return `${day} ${date}`;
}

/** Tile values for the "This week" tile. Read from the same week totals the Week screen shows, so the two always agree. */
export interface WeekLike {
  today: string;
  totals: { distanceM: number; durationS: number; runs: number };
  days: { date: string; activities: { type: string; distanceM: number | null }[] }[];
}

export function weekTile(w: WeekLike) {
  return {
    km: (w.totals.distanceM / 1000).toFixed(1),
    minutes: Math.round(w.totals.durationS / 60),
    runs: w.totals.runs,
    /** Running distance in km for each of the 7 days Monday to Sunday. Days after today are null, so the line stops at today. */
    daily: w.days.map((d) => (d.date > w.today ? null : Math.round(d.activities.filter((a) => a.type === "running").reduce((n, a) => n + (a.distanceM ?? 0), 0) / 100) / 10)),
  };
}
