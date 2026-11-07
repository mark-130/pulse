import type { CSSProperties } from "react";

/** Reserved for AI surfaces: Today hero, briefing, Ask, AI proposals. CSS only, see index.css. */
export function Orb({ size = 96, className = "" }: { size?: number; className?: string }) {
  return <span aria-hidden="true" className={`orb ${className}`} style={{ "--orb-size": `${size}px` } as CSSProperties} />;
}
