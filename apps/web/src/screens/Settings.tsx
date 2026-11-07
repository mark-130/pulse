import { useState } from "react";
import { Button, Card } from "@/components/ui";
import { useAuthActions } from "@/lib/auth";
import { getThemeMode, setThemeMode, type ThemeMode } from "@/lib/theme";

const modes: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

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
      <Button variant="secondary" onClick={() => void logout()}>
        Sign out
      </Button>
    </div>
  );
}
