import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { api, ApiRequestError } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("api answers that do not match the page's schema", () => {
  it("never surfaces the validation JSON: a plain sentence, with the detail in the console only", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ state: "idle" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = await api("/api/history", z.object({ state: z.string(), incomplete: z.boolean() })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    const message = (err as ApiRequestError).message;
    expect(message).toBe("This page is out of date with the app. Reload it to update.");
    expect(message).not.toMatch(/expected|invalid_type|incomplete|\[|\{|"code"/);
    expect(warn).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("still returns a matching answer", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ state: "idle" }));
    await expect(api("/api/history", z.object({ state: z.string() }))).resolves.toEqual({ state: "idle" });
    vi.unstubAllGlobals();
  });
});
