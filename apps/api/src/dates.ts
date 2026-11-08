const TZ = "Europe/London";

const dateFmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });

/** YYYY-MM-DD for the given instant in Europe/London. */
export function londonDate(now: Date): string {
  return dateFmt.format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** Monday of the week containing the date. */
export function weekStart(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The greeting for the local time in Europe/London: before 12:00 morning, until 17:00 afternoon, otherwise evening. */
export function greetingWord(now: Date): "Good morning" | "Good afternoon" | "Good evening" {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: TZ }).format(now));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** Replaces a wrong greeting at the start of AI text with the right one. The model is told the greeting, and this makes it certain. */
export function fixGreeting(text: string, now: Date): string {
  return text.replace(/^\s*good (morning|afternoon|evening)\b/i, greetingWord(now));
}
