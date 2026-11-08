import type { Priority, RaceView } from "@pulse/shared";

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type DayKind = "today" | "race" | "plain";

/** The seven day row on the Today race card: today outlined, race day filled. */
export function sevenDayRow(today: string, race: Pick<RaceView, "date"> | null): DayKind[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i);
    if (race && date === race.date) return "race";
    return i === 0 ? "today" : "plain";
  });
}

export function priorityLabel(race: Pick<RaceView, "priority" | "priorityInferred">): string {
  return race.priorityInferred ? `${race.priority}, suggested` : race.priority;
}

export function typeLabel(race: Pick<RaceView, "type" | "typeInferred">): string {
  const t = race.type === "trail" ? "Trail" : "Road";
  return race.typeInferred ? `${t}, suggested` : t;
}

export const PRIORITIES: Priority[] = ["A", "B", "C"];

/** Plain words for an undo notice. */
export function changeText(title: string, current: { priority: Priority | null; type: "road" | "trail" | null }): string {
  const parts = [current.priority && `priority ${current.priority}`, current.type && current.type].filter(Boolean);
  return parts.length ? `${title}: ${parts.join(", ")} saved.` : `${title}: reset to the suggested values.`;
}
