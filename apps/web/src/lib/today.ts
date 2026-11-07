const TZ = "Europe/London";

export function greetingFor(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: TZ }).format(now));
  const part = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  return `${part}, Mark`;
}

/** For example "Saturday 07/11/2026". */
export function dateLine(now: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: TZ }).format(now);
  const date = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ }).format(now);
  return `${day} ${date}`;
}
