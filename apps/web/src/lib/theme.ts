import { THEME_COLOR_DARK, THEME_COLOR_LIGHT } from "@pulse/shared";

export type ThemeMode = "system" | "dark" | "light";
const KEY = "pulse-theme";

export function resolveTheme(mode: ThemeMode, prefersLight: boolean): "dark" | "light" {
  if (mode === "system") return prefersLight ? "light" : "dark";
  return mode;
}

export function themeColor(theme: "dark" | "light"): string {
  return theme === "light" ? THEME_COLOR_LIGHT : THEME_COLOR_DARK;
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
  const theme = resolveTheme(mode, matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.classList.toggle("light", theme === "light");
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", themeColor(theme)));
}
