import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

const tones = {
  neutral: "bg-[var(--chip-neutral-bg)] text-[color:var(--chip-neutral-fg)]",
  priorityA: "bg-accent text-accent-foreground",
  priorityB: "bg-[var(--chip-b-bg)] text-[color:var(--chip-b-fg)]",
  soft: "bg-[var(--chip-soft-bg)] text-[color:var(--chip-soft-fg)]",
} as const;

export function Chip({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={`inline-flex min-h-6 items-center gap-1 rounded-full px-2.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

/** A is the accent, B the violet chip, C the neutral chip. The letter is always in the text. */
export function PriorityChip({ priority, suggested = false }: { priority: "A" | "B" | "C"; suggested?: boolean }) {
  const tone = priority === "A" ? "priorityA" : priority === "B" ? "priorityB" : "neutral";
  return <Chip tone={tone}>{`Priority ${priority}${suggested ? ", suggested" : ""}`}</Chip>;
}

/** Every AI-written block carries the sparkle icon and this chip. */
export function AiChip() {
  return (
    <Chip tone="soft">
      <Sparkles aria-hidden className="size-3" />
      AI
    </Chip>
  );
}
