import { Card, EmptyState } from "@/components/ui";
import { widgets } from "@/modules/registry";

export function Today() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Today</h1>
      <Card title="Readiness">
        <EmptyState>No data yet. Garmin sync arrives in Phase 1.</EmptyState>
      </Card>
      <Card title="Today's workout">
        <EmptyState>No data yet.</EmptyState>
      </Card>
      <Card title="Next race">
        <EmptyState>No data yet. Races arrive in Phase 2.</EmptyState>
      </Card>
      <Card title="Pending proposals">
        <EmptyState>None.</EmptyState>
      </Card>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {widgets.map((w) => (
          <div key={w.id} className={w.size === "2x1" ? "sm:col-span-2" : ""}>
            <w.component />
          </div>
        ))}
      </div>
    </div>
  );
}
