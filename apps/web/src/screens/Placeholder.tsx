import { EmptyState } from "@/components/ui";

export function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <EmptyState>Not built yet. Arrives in {phase}.</EmptyState>
    </div>
  );
}
