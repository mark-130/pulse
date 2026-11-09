import { TREND_RANGES } from "@pulse/shared";
import { Button } from "./ui";

/** Trends range choices: 4 weeks, 3 months, 12 months and 24 months. Two by two on a narrow screen, 44px tall. */
export function RangePicker({ days, onPick }: { days: number; onPick: (days: number) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" role="group" aria-label="Range">
      {TREND_RANGES.map((r) => (
        <Button key={r.days} variant={days === r.days ? "primary" : "secondary"} aria-pressed={days === r.days} onClick={() => onPick(r.days)}>
          {r.label}
        </Button>
      ))}
    </div>
  );
}
