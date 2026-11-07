import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

const tones = {
  neutral: "bg-[var(--chip-neutral-bg)] text-[color:var(--chip-neutral-fg)]",
  priorityB: "bg-[var(--chip-b-bg)] text-[color:var(--chip-b-fg)]",
  taper: "bg-[var(--chip-taper-bg)] text-[color:var(--chip-taper-fg)]",
} as const;

export function Chip({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={`inline-flex min-h-6 items-center gap-1 rounded-full px-2.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

/** Every AI-written block carries the sparkle icon and this chip. */
export function AiChip() {
  return (
    <Chip tone="taper">
      <Sparkles aria-hidden className="size-3" />
      AI
    </Chip>
  );
}
