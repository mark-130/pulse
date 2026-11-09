import { APP_NAME, APP_SHORT_NAME, BRAND_COLORS, THEME_COLOR_DARK, THEME_COLOR_LIGHT } from "@pulse/shared";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const tokens = read("./tokens.css");
const indexCss = read("../index.css");
const css = tokens.toLowerCase();
const [darkBlock = "", lightBlock = ""] = css.split(":root.light");

describe("brand", () => {
  it("pins the display name", () => {
    expect(APP_NAME).toBe("NGtive Split");
    expect(APP_SHORT_NAME).toBe("NGtive Split");
  });
  it("pins theme colours", () => {
    expect(THEME_COLOR_DARK).toBe("#0A1113");
    expect(THEME_COLOR_LIGHT).toBe("#F4F8F8");
  });
});

describe("tokens.css matches the exported palette", () => {
  it("dark core colours", () => {
    for (const hex of Object.values(BRAND_COLORS.dark)) expect(darkBlock).toContain(hex.toLowerCase());
  });
  it("light core colours", () => {
    for (const hex of Object.values(BRAND_COLORS.light)) expect(lightBlock).toContain(hex.toLowerCase());
  });
  it("state colours", () => {
    for (const hex of Object.values(BRAND_COLORS.state.dark)) expect(darkBlock).toContain(hex.toLowerCase());
    for (const hex of Object.values(BRAND_COLORS.state.light)) expect(lightBlock).toContain(hex.toLowerCase());
  });
  it("orb and gradient values from DESIGN.md", () => {
    expect(darkBlock).toContain("radial-gradient(circle at 32% 28%, #c9fff5 0%, #2dd4bf 26%, #3b82f6 60%, #7c3aed 100%)");
    expect(darkBlock).toContain("linear-gradient(90deg, #5eead4, #3b82f6, #8b5cf6)");
    expect(darkBlock).toContain("rgba(94, 234, 212, 0.34)");
  });
});

describe("no external requests", () => {
  it("styles use no CDN or Google Fonts", () => {
    for (const src of [tokens, indexCss]) expect(src).not.toMatch(/https?:\/\//);
  });
});
