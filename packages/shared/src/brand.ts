/** Display names. The code name stays "pulse" (repo, image, container, volumes, env vars). */
export const APP_NAME = "NGtive Split";
export const APP_SHORT_NAME = "NGtive Split";

export const THEME_COLOR_DARK = "#0A1113";
export const THEME_COLOR_LIGHT = "#F4F8F8";

/** Core palette. apps/web/src/styles/tokens.css must match, a test pins it. See docs/DESIGN.md. */
export const BRAND_COLORS = {
  dark: { bg: "#0A1113", surface: "#121C1F", text: "#EAF4F3", muted: "#9DB3B2", accent: "#5EEAD4", onAccent: "#0A1113" },
  light: { bg: "#F4F8F8", surface: "#FFFFFF", text: "#0A1113", muted: "#4B6161", accent: "#0F766E", onAccent: "#FFFFFF" },
  verdict: {
    dark: { easy: "#FBBF24", swap: "#FB923C", rest: "#FB7185" },
    light: { easy: "#B45309", swap: "#C2410C", rest: "#BE123C" },
  },
} as const;
