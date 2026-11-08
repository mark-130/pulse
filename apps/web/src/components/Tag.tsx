import type { ReactNode } from "react";

/** A small tag such as "New". The word is always there, so it never relies on colour alone. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="ml-1 inline-flex min-h-6 items-center rounded-full bg-accent px-2.5 text-xs font-semibold text-accent-foreground">{children}</span>;
}
