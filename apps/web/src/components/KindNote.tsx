import type { GroupStatus } from "@pulse/shared";
import { Info } from "lucide-react";
import { kindNote } from "@/lib/stale";
import { useSyncStatus } from "@/lib/queries";

/** Quiet inline note for a stale kind that does not warrant the full banner. */
export function KindNote({ group }: { group: GroupStatus["id"] }) {
  const note = kindNote(useSyncStatus().data, group);
  if (!note) return null;
  return (
    <p className="t-secondary mt-2 flex min-w-0 items-start gap-2 [overflow-wrap:anywhere]">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{note}</span>
    </p>
  );
}
