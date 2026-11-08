import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { AI_BUDGET_TEXT, AI_OFF_TEXT, type Debrief, type Review } from "@pulse/shared";
import { formatClockDay, formatDate } from "@/lib/format";
import { AiChip } from "./Chip";
import { Button } from "./ui";

type AiState = "ok" | "off" | "budget";

/** Plain text for the states every AI block shares. The rest of the app keeps working in all of them. */
export function aiStateLine(state: AiState, what: string): string | null {
  if (state === "off") return `${AI_OFF_TEXT}. Set ANTHROPIC_API_KEY to switch ${what} on.`;
  if (state === "budget") return `${AI_BUDGET_TEXT}. ${what.charAt(0).toUpperCase()}${what.slice(1)} returns next month.`;
  return null;
}

function Header({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <Sparkles aria-hidden className="size-4 text-accent" />
      <h2 className="t-card-title !text-[15px]">{title}</h2>
      <AiChip />
      {children}
    </div>
  );
}

export interface BlockState {
  state: AiState;
  pending: boolean;
  failed: boolean;
  onWrite: () => void;
  onRefresh: () => void;
}

/** The weekly review on Week. Cached per week, so it is only rewritten when Mark taps Refresh. */
export function ReviewView({ review, weekEnd, ...s }: BlockState & { review: Review | null; weekEnd: string }) {
  const line = review ? null : aiStateLine(s.state, "the weekly review");
  return (
    <section className="card-briefing" aria-labelledby="review-title">
      <Header title="Weekly review">{review && <span className="t-label">Generated {formatClockDay(review.generatedAt)}</span>}</Header>
      <span id="review-title" className="sr-only">Weekly review</span>
      {review && <p className="whitespace-pre-line leading-[1.6] [overflow-wrap:anywhere]">{review.text}</p>}
      {review && review.coversUntil < weekEnd && <p className="t-label mt-2">Covers the week up to {formatDate(review.coversUntil)}.</p>}
      {s.pending && <p role="status" className="leading-[1.6]">Writing your review.</p>}
      {!review && !s.pending && line && <p className="leading-[1.6]">{line}</p>}
      {!review && !s.pending && !line && <p className="leading-[1.6]">{s.failed ? "The review could not be written. Try again in a moment." : "No review for this week yet. It is written on Sunday evening, or when you ask."}</p>}
      {s.failed && review && <p role="alert" className="t-label mt-2">The refresh failed. The earlier review is kept.</p>}
      {s.state === "ok" && !s.pending && (
        <Button variant="secondary" className="mt-3" onClick={review ? s.onRefresh : s.onWrite}>{review ? "Refresh" : "Write review"}</Button>
      )}
    </section>
  );
}

/** The post-run debrief under a recorded run. Cached by activity, so it is only rewritten on Refresh. */
export function DebriefView({ debrief, ...s }: BlockState & { debrief: Debrief | null }) {
  const line = debrief ? null : s.state === "budget" ? `${AI_BUDGET_TEXT}.` : null;
  return (
    <div className="mt-2 rounded-2xl bg-surface-2 p-3" aria-label="Run debrief">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Sparkles aria-hidden className="size-3.5 text-accent" />
        <span className="t-overline">Debrief</span>
        <AiChip />
        {debrief && <span className="t-label">Generated {formatClockDay(debrief.generatedAt)}</span>}
      </div>
      {debrief && <p className="text-[15px] leading-[1.5] [overflow-wrap:anywhere]">{debrief.text}</p>}
      {s.pending && <p role="status" className="text-[15px]">Writing the debrief.</p>}
      {line && !s.pending && <p className="t-secondary">{line}</p>}
      {s.failed && !s.pending && <p role="alert" className="t-secondary">The debrief could not be written. Try again in a moment.</p>}
      {s.state === "ok" && !s.pending && (
        <Button variant="secondary" className="mt-2" onClick={debrief ? s.onRefresh : s.onWrite}>{debrief ? "Refresh" : "Write debrief"}</Button>
      )}
    </div>
  );
}
