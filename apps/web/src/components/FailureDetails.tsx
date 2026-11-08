import type { AiFailureInfo } from "@pulse/shared";
import { formatClockDay } from "@/lib/format";

/** The plain reason an AI card could not be written. It never holds a key, a URL or a request body. */
export function FailureDetails({ failure }: { failure: AiFailureInfo | null | undefined }) {
  if (!failure) return null;
  return (
    <details className="mt-1 min-w-0">
      <summary className="t-secondary flex min-h-11 cursor-pointer items-center">Details</summary>
      <div className="space-y-1 rounded-2xl bg-surface p-3 text-[13px] [overflow-wrap:anywhere]">
        <p className="font-semibold">{failure.label}</p>
        {failure.detail && <p className="t-secondary">{failure.detail}</p>}
        <p className="t-label">At {formatClockDay(failure.at)}</p>
      </div>
    </details>
  );
}
