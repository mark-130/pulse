import { useId } from "react";

/** Split-bar mark: a short dim bar above a longer gradient bar (a negative split). */
export function LogoMark({ size = 28 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#5EEAD4" />
          <stop offset="0.55" stopColor="#3B82F6" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect x="3" y="7" width="12" height="5" rx="2.5" fill="currentColor" opacity="0.35" />
      <rect x="3" y="16" width="22" height="5" rx="2.5" fill={`url(#${id})`} />
    </svg>
  );
}
