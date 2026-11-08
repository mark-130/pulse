import type { CSSProperties } from "react";

/** Reserved for AI surfaces: Today hero, briefing, Ask, AI proposals. CSS only, see index.css. */
export function Orb({ size = 96, className = "", thinking = false }: { size?: number; className?: string; thinking?: boolean }) {
  return <span aria-hidden="true" className={`orb ${thinking ? "orb-thinking" : ""} ${className}`} style={{ "--orb-size": `${size}px` } as CSSProperties} />;
}
