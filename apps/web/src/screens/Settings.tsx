import { useState } from "react";
import { AI_BUDGET_TEXT } from "@pulse/shared";
import { Button, Card } from "@/components/ui";
import { HistoryCard } from "@/components/HistoryCard";
import { UpdateCard } from "@/components/UpdateCard";
import { useAiStatus } from "@/lib/queries";
import { formatDate, plural } from "@/lib/format";
import { useAuthActions } from "@/lib/auth";
import { getThemeMode, setThemeMode, type ThemeMode } from "@/lib/theme";

const modes: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const gbp = (n: number) => `£${n.toFixed(n < 0.1 ? 3 : 2)}`;

function AiUsage() {
  const q = useAiStatus();
  const s = q.data;
  return (
    <Card title="AI usage">
      {q.isPending && <p className="t-secondary">Loading</p>}
      {q.isError && <p role="alert" className="text-danger">{q.error.message}</p>}
      {s && (
        <div className="space-y-3 text-[15px]">
          <p className="font-semibold">{s.state === "off" ? "AI is off. Set ANTHROPIC_API_KEY to switch it on." : s.state === "budget" ? `${AI_BUDGET_TEXT}. AI returns next month.` : "AI is on."}</p>
          {s.notice && <p role="status">{s.notice}</p>}
          <p className="t-secondary">AI proposals are {s.proposals ? "on" : "off"}.</p>
          <div>
            <p className="t-label">This month ({s.month.label})</p>
            <p className="font-display text-[22px] font-semibold">{gbp(s.month.spentGbp)} <span className="t-secondary font-sans text-[13px] font-normal">of {gbp(s.month.capGbp)}, {s.month.percent} percent, {plural(s.month.calls, "call")}</span></p>
            <div className="mt-1 h-2 rounded-full bg-surface-2" role="img" aria-label={`${s.month.percent} percent of the monthly cap used`}>
              <div className="h-2 rounded-full" style={{ width: `${Math.min(100, s.month.percent)}%`, background: "var(--ai-gradient)" }} />
            </div>
          </div>
          {s.month.byFeature.length > 0 && (
            <ul className="space-y-1">
              {s.month.byFeature.map((f) => <li key={f.feature} className="flex justify-between gap-3"><span className="capitalize">{f.feature}</span><span className="t-secondary">{plural(f.calls, "call")}, {gbp(f.costGbp)}</span></li>)}
            </ul>
          )}
          <p className="t-label">Prices checked {formatDate(s.pricing.checkedOn)}. Rate {s.pricing.usdToGbp}.</p>
        </div>
      )}
    </Card>
  );
}

export function Settings() {
  const { logout } = useAuthActions();
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <Card title="Theme">
        <div className="flex gap-2" role="radiogroup" aria-label="Theme">
          {modes.map((m) => (
            <Button
              key={m.value}
              variant={mode === m.value ? "primary" : "secondary"}
              role="radio"
              aria-checked={mode === m.value}
              onClick={() => {
                setMode(m.value);
                setThemeMode(m.value);
              }}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </Card>
      <AiUsage />
      <UpdateCard />
      <HistoryCard />
      <Button variant="secondary" onClick={() => void logout()}>
        Sign out of all devices
      </Button>
    </div>
  );
}
