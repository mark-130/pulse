import { Footprints } from "lucide-react";
import type { SVGProps } from "react";

/** Tabler "run" icon (MIT licence), 24px grid, drawn like the lucide icons around it (2px round stroke). */
export function RunIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M13 4m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      <path d="M4 17l5 1l.75 -1.5" />
      <path d="M15 21l0 -4l-4 -3l1 -6" />
      <path d="M7 12l0 -3l5 -1l3 3l3 1" />
    </svg>
  );
}

/** Garmin activity types and plan sports that count as running. Anything unknown is not assumed to be a run. */
export function isRunning(sport: string | null | undefined): boolean {
  return sport != null && /run/i.test(sport);
}

/** Runner for runs, footprints as the fallback for other activity types. Decorative: the label beside it carries the meaning. */
export function SportIcon({ sport, className = "size-5" }: { sport: string | null | undefined; className?: string }) {
  return isRunning(sport) ? <RunIcon aria-hidden className={className} /> : <Footprints aria-hidden className={className} />;
}
