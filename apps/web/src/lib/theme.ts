export type ThemeMode = "system" | "dark" | "light";
const KEY = "pulse-theme";

export function resolveTheme(mode: ThemeMode, prefersLight: boolean): "dark" | "light" {
  if (mode === "system") return prefersLight ? "light" : "dark";
  return mode;
}

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage unavailable, theme applies for this session only */
  }
  applyTheme(mode);
}

export function applyTheme(mode: ThemeMode): void {
  const light = resolveTheme(mode, matchMedia("(prefers-color-scheme: light)").matches) === "light";
  document.documentElement.classList.toggle("light", light);
}
