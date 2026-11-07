import { CalendarDays, Flag, LineChart, ListChecks, MessageSquare, Settings, Sun } from "lucide-react";
import { APP_SHORT_NAME } from "@pulse/shared";
import { NavLink, Outlet } from "react-router";
import { cn } from "@/lib/utils";

const tabs = [
  { to: "/", label: "Today", icon: Sun },
  { to: "/week", label: "Week", icon: CalendarDays },
  { to: "/races", label: "Races", icon: Flag },
  { to: "/trends", label: "Trends", icon: LineChart },
  { to: "/ask", label: "Ask", icon: MessageSquare },
  { to: "/proposals", label: "Proposals", icon: ListChecks },
  { to: "/settings", label: "Settings", icon: Settings },
];

function TabLink({ to, label, icon: Icon, rail }: (typeof tabs)[number] & { rail?: boolean }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        cn(
          "flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg text-xs",
          rail ? "flex-row justify-start gap-3 px-3 text-sm" : "flex-1 flex-col",
          isActive ? "text-accent" : "text-muted hover:text-foreground",
        )
      }
    >
      <Icon aria-hidden className="size-5 shrink-0" />
      <span>{label}</span>
    </NavLink>
  );
}

export function Layout() {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[13rem_1fr]">
      <nav aria-label="Main" className="hidden border-r border-border bg-surface p-3 md:block">
        <div className="mb-4 px-3 text-lg font-semibold">{APP_SHORT_NAME}</div>
        <div className="flex flex-col gap-1">
          {tabs.map((t) => (
            <TabLink key={t.to} {...t} rail />
          ))}
        </div>
      </nav>
      <main className="mx-auto w-full max-w-5xl p-4 pb-24 md:pb-4">
        <Outlet />
      </main>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 flex border-t border-border bg-surface px-1 pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {tabs.map((t) => (
          <TabLink key={t.to} {...t} />
        ))}
      </nav>
    </div>
  );
}
