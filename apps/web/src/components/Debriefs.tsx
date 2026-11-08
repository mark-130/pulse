import type { ActivityItem } from "@pulse/shared";
import { useDebriefs, useWriteDebrief } from "@/lib/queries";
import { DebriefView } from "./AiBlocks";

/** Debrief blocks for the running activities in a list. One request for the whole list. Shows nothing when AI is off. */
export function useDebriefBlocks(activities: ActivityItem[]) {
  const runs = activities.filter((a) => a.type === "running");
  const ids = runs.map((a) => a.id);
  const q = useDebriefs(ids);
  const write = useWriteDebrief();
  const state = q.data?.state ?? "off";
  return (id: string) => {
    if (!ids.includes(id) || !q.data || state === "off") return null;
    return (
      <DebriefView
        debrief={q.data.debriefs[id] ?? null}
        state={state}
        pending={write.isPending && write.variables?.id === id}
        failed={write.variables?.id === id && (write.isError || (write.data?.failed ?? false))}
        onWrite={() => write.mutate({ id, refresh: false })}
        onRefresh={() => write.mutate({ id, refresh: true })}
      />
    );
  };
}
