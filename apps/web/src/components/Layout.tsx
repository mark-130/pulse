import { APP_NAME } from "@pulse/shared";
import { CalendarDays, Flag, LineChart, Sun } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import { formatTime } from "@/lib/format";
import { useSyncStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { LogoMark } from "./LogoMark";
import { Orb } from "./Orb";
import { StaleBanner } from "./StaleBanner";
import { SyncSheet } from "./SyncSheet";

const tabs = [
  { to: "/", label: "Today", icon: Sun },
  { to: "/week", label: "Week", icon: CalendarDays },
  { to: "/ask", label: "Ask", icon: null },
  { to: "/races", label: "Races", icon: Flag },
  { to: "/trends", label: "Trends", icon: LineChart },
] as const;

function TabLink({ to, label, icon: Icon, rail }: (typeof tabs)[number] & { rail?: boolean }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      aria-label={label}
      className={({ isActive }) =>
        cn(
          "flex min-h-11 min-w-11 items-center rounded-2xl text-xs font-medium",
          rail ? "gap-3 px-3 text-[15px]" : "flex-1 flex-col justify-center gap-0.5",
          isActive ? "text-accent" : "text-muted hover:text-foreground",
        )
      }
    >
      {Icon ? (
        <Icon aria-hidden className="size-5 shrink-0" />
      ) : rail ? (
        <Orb size={20} />
      ) : (
        <Orb size={58} className="-mt-6" />
      )}
      {(Icon || rail) && <span>{label}</span>}
      {!Icon && !rail && <span className="sr-only">{label}</span>}
    </NavLink>
  );
}

function pillText(lastOk: string | null | undefined, stale: boolean | undefined): string {
  if (lastOk === undefined) return "Checking sync";
  if (lastOk === null) return "Not synced yet";
  return `${stale ? "Stale, synced" : "Synced"} ${formatTime(lastOk)}`;
}

/** At 320px the word "synced" is dropped so the wordmark keeps its room. */
function PillLabel({ text }: { text: string }) {
  const [lead, word, time] = text.split(/(synced |Synced )/);
  if (!word) return <>{text}</>;
  return (
    <>
      {lead}
      <span className="max-[359px]:hidden">{word}</span>
      {time}
    </>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  const g = useSyncStatus().data?.garmin;
  return (
    <header className="flex items-center justify-between pb-4">
      <div className="flex min-w-0 items-center gap-2 font-display text-[17px] font-semibold md:hidden">
        <LogoMark />
        <span className="truncate">{APP_NAME}</span>
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-border-strong bg-surface-2 px-3 text-[13px] text-muted min-[360px]:px-4"
      >
        <span><PillLabel text={pillText(g?.lastOk, g?.stale)} /></span>
      </button>
      <SyncSheet open={open} onClose={() => setOpen(false)} />
    </header>
  );
}

export function Layout() {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[13rem_1fr]">
      <nav aria-label="Main" className="hidden border-r border-border p-3 md:block">
        <div className="mb-4 flex items-center gap-2 px-3 font-display text-[17px] font-semibold">
          <LogoMark />
          <span className="truncate">{APP_NAME}</span>
        </div>
        <div className="flex flex-col gap-1">
          {tabs.map((t) => (
            <TabLink key={t.to} {...t} rail />
          ))}
        </div>
      </nav>
      <main className="mx-auto w-full max-w-[1120px] px-5 pt-5 pb-28 md:pb-8">
        <Header />
        <StaleBanner />
        <Outlet />
      </main>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 flex items-center border-t border-border bg-surface/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {tabs.map((t) => (
          <TabLink key={t.to} {...t} />
        ))}
      </nav>
    </div>
  );
}
