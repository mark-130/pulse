/**
 * Registry of proposals that are being confirmed right now. Only the confirm route adds to it.
 * Executors refuse to run for an id that is not in here, so an executor can never run without a confirmed proposal.
 */
const active = new Set<string>();

export function beginConfirmation(id: string): boolean {
  if (active.has(id)) return false;
  active.add(id);
  return true;
}

export function endConfirmation(id: string): void {
  active.delete(id);
}

export function isBeingConfirmed(id: string): boolean {
  return active.has(id);
}
