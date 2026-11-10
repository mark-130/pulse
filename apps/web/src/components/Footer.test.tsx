import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Layout } from "./Layout";
import { Footer, TAGLINE } from "./Footer";
import { Login } from "@/screens/Login";

const wrap = (node: React.ReactNode) => renderToString(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>).replaceAll("<!-- -->", "");

describe("footer tagline", () => {
  it("is the exact text, with no punctuation", () => {
    expect(TAGLINE).toBe("Factum a Marco pro Marco");
    expect(TAGLINE).not.toMatch(/[.,;:!\-–—]/);
    expect(wrap(<Footer />)).toContain(`>${TAGLINE}</p>`);
  });

  it("is a plain, non interactive, in flow element", () => {
    const h = wrap(<Footer />);
    expect(h).not.toMatch(/<a |<button|tabindex|fixed|sticky/);
    expect(h).toContain("<footer");
  });

  it("is on the app shell and on the sign in screen, once each", () => {
    for (const html of [wrap(<Layout />), wrap(<Login />)]) expect(html.split(TAGLINE)).toHaveLength(2);
  });
});
