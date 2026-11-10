import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setCsrfToken } from "./api";
import { SESSION_KEY, checkSession, clearPrivateState, installAuthGuard } from "./auth";
import { z } from "zod";

/** A tiny stand-in for the server: one session epoch, a cookie per browser, a CSRF token per cookie. */
function fakeServer() {
  let epoch = 0;
  const calls: string[] = [];
  let current = "";
  const cookies = new Map<string, { epoch: number; csrf: string }>();
  let down = false;
  const valid = () => {
    const c = cookies.get(current);
    return c !== undefined && c.epoch === epoch ? c : null;
  };
  const fetchFn = async (path: string, init?: { method?: string }): Promise<Response> => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (down) throw new TypeError("offline");
    if (path === "/api/auth/session") {
      const c = valid();
      return Response.json(c ? { authenticated: true, csrfToken: c.csrf } : { authenticated: false, csrfToken: null });
    }
    if (path === "/api/auth/logout") {
      if (!valid()) return Response.json({ error: "Sign in." }, { status: 401 });
      epoch++;
      return Response.json({ ok: true });
    }
    if (!valid()) return Response.json({ error: "Sign in." }, { status: 401 });
    return Response.json({ secret: "personal" });
  };
  return {
    fetchFn,
    calls,
    signIn: (name: string) => void cookies.set(name, { epoch, csrf: `csrf-${name}` }),
    as: (name: string) => void (current = name),
    setDown: (d: boolean) => void (down = d),
  };
}

class FakeStorage {
  private m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}
class FakeCaches {
  names = new Set<string>(["pulse-api", "workbox-precache-v2-x"]);
  keys = async () => [...this.names];
  delete = async (n: string) => this.names.delete(n);
}

let server: ReturnType<typeof fakeServer>;
let caches: FakeCaches;
const priv = z.object({ secret: z.string() });
const seed = (qc: QueryClient) => qc.setQueryData(["today"], { secret: "personal" });

beforeEach(() => {
  server = fakeServer();
  caches = new FakeCaches();
  vi.stubGlobal("fetch", server.fetchFn);
  vi.stubGlobal("localStorage", new FakeStorage());
  vi.stubGlobal("caches", caches);
  setCsrfToken(null);
});
afterEach(() => vi.unstubAllGlobals());

describe("revoked sessions (PULSE-006)", () => {
  it("a second signed in client sees the revocation on its next session check and drops private data and caches", async () => {
    const a = new QueryClient();
    const b = new QueryClient();
    server.signIn("a");
    server.signIn("b");
    server.as("a");
    expect((await checkSession(a)).authenticated).toBe(true);
    server.as("b");
    expect((await checkSession(b)).authenticated).toBe(true);
    seed(b);
    expect(b.getQueryData(["today"])).toBeDefined();

    // Client A signs out of every device.
    server.as("a");
    await api("/api/auth/logout", z.object({ ok: z.boolean() }), { method: "POST" });

    // Client B asks again, as the focus and interval checks do.
    server.as("b");
    const s = await checkSession(b);
    expect(s).toEqual({ authenticated: false, csrfToken: null });
    expect(b.getQueryData(["today"])).toBeUndefined();
    expect([...caches.names]).toEqual(["workbox-precache-v2-x"]);
    expect(localStorage.getItem("pulse.hadSession")).toBeNull();
  });

  it("a 401 from any protected request signs the page out centrally", async () => {
    const qc = new QueryClient();
    const remove = installAuthGuard(qc);
    server.signIn("b");
    server.as("b");
    await checkSession(qc);
    qc.setQueryData(SESSION_KEY, { authenticated: true, csrfToken: "csrf-b" });
    seed(qc);
    server.as("other"); // the server no longer accepts this browser
    await expect(api("/api/today", priv)).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(qc.getQueryData(SESSION_KEY)).toEqual({ authenticated: false, csrfToken: null }));
    await vi.waitFor(() => expect(caches.names.has("pulse-api")).toBe(false));
    expect(qc.getQueryData(["today"])).toBeUndefined();
    remove();
  });

  it("a wrong password is an ordinary 401 and does not sign the page out", async () => {
    const qc = new QueryClient();
    const remove = installAuthGuard(qc);
    seed(qc);
    vi.stubGlobal("fetch", async () => Response.json({ error: "Wrong password." }, { status: 401 }));
    await expect(api("/api/auth/login", z.object({}), { method: "POST", body: { password: "x" } })).rejects.toMatchObject({ status: 401 });
    await new Promise((r) => setTimeout(r, 10));
    expect(qc.getQueryData(["today"])).toBeDefined();
    expect(caches.names.has("pulse-api")).toBe(true);
    remove();
  });

  it("ordinary local logout still clears the token, queries and caches", async () => {
    const qc = new QueryClient();
    server.signIn("a");
    server.as("a");
    await checkSession(qc);
    seed(qc);
    await clearPrivateState(qc);
    expect(qc.getQueryData(["today"])).toBeUndefined();
    expect(caches.names.has("pulse-api")).toBe(false);
    expect(caches.names.has("workbox-precache-v2-x")).toBe(true);
    // The CSRF token is gone, so a later write carries none.
    let header: string | undefined;
    vi.stubGlobal("fetch", async (_p: string, init: { headers: Record<string, string> }) => {
      header = init.headers["x-csrf-token"];
      return Response.json({ ok: true });
    });
    await api("/api/anything", z.object({ ok: z.boolean() }), { method: "POST" });
    expect(header).toBeUndefined();
  });
});

describe("offline behaviour", () => {
  it("offline, a page that was signed in keeps its saved snapshot and does not clear anything", async () => {
    const qc = new QueryClient();
    server.signIn("a");
    server.as("a");
    await checkSession(qc);
    seed(qc);
    server.setDown(true);
    const s = await checkSession(qc);
    expect(s.authenticated).toBe(true);
    expect(qc.getQueryData(["today"])).toBeDefined();
    expect(caches.names.has("pulse-api")).toBe(true);
  });

  it("offline with no earlier sign in is an error, not a signed in page", async () => {
    const qc = new QueryClient();
    server.setDown(true);
    await expect(checkSession(qc)).rejects.toMatchObject({ status: 0 });
  });

  it("back online, a revoked session is then caught and the saved snapshot goes", async () => {
    const qc = new QueryClient();
    server.signIn("a");
    server.as("a");
    await checkSession(qc);
    seed(qc);
    server.setDown(true);
    await checkSession(qc);
    server.setDown(false);
    server.as("revoked");
    expect((await checkSession(qc)).authenticated).toBe(false);
    expect(qc.getQueryData(["today"])).toBeUndefined();
    expect(caches.names.has("pulse-api")).toBe(false);
  });
});
