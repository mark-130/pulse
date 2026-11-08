import { useEffect, useRef } from "react";
import { useBriefing, useGenerateBriefing } from "./queries";

/**
 * Today's briefing. If AI is on, within budget and today's briefing is missing, ask the server to write it, once per visit.
 * The server allows one generation a day and waits ten minutes after a failure, so this cannot loop.
 */
export function useBriefingFlow() {
  const query = useBriefing();
  const gen = useGenerateBriefing();
  const asked = useRef(false);
  const d = query.data;
  useEffect(() => {
    if (d && d.state === "ok" && !d.briefing && !d.failed && !asked.current && !gen.isPending) {
      asked.current = true;
      gen.mutate();
    }
  }, [d, gen]);
  const shown = gen.data ?? d;
  return { data: shown, generating: gen.isPending, loading: query.isPending, failed: (shown?.failed ?? false) || gen.isError };
}
