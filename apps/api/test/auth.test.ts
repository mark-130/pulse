import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { dbSessionEpoch } from "../src/auth/epoch.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { RateLimiter } from "../src/auth/rate-limit.js";
import { createSessionToken, readSessionToken } from "../src/auth/session.js";
import { makeApp, req } from "./helpers.js";

describe("password", () => {
  it("verifies the right password only", async () => {
    const h = await hashPassword("abc");
    expect(h).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await verifyPassword("abc", h)).toBe(true);
    expect(await verifyPassword("abd", h)).toBe(false);
  });
});

describe("session token", () => {
  it("round trips, rejects tampering and expiry", () => {
    const { token, payload } = createSessionToken("k".repeat(32), 0, 1000);
    expect(readSessionToken(token, "k".repeat(32), 0, 2000)?.csrf).toBe(payload.csrf);
    expect(readSessionToken(token, "x".repeat(32), 0, 2000)).toBeNull();
    expect(readSessionToken(`${token}a`, "k".repeat(32), 0, 2000)).toBeNull();
    expect(readSessionToken(token, "k".repeat(32), 0, payload.exp + 1)).toBeNull();
    expect(readSessionToken(undefined, "k".repeat(32), 0)).toBeNull();
  });
});

describe("rate limiter", () => {
  it("blocks the sixth attempt in a window and recovers after it", () => {
    const rl = new RateLimiter(5, 1000);
    for (let i = 0; i < 5; i++) expect(rl.attempt("ip", 0)).toBe(true);
    expect(rl.attempt("ip", 500)).toBe(false);
    expect(rl.attempt("ip", 1500)).toBe(true);
  });

  it("sweeps expired keys so the map does not grow without bound", () => {
    const rl = new RateLimiter(5, 1000, 10_000);
    for (let i = 0; i < 250; i++) rl.attempt(`ip${i}`, 0);
    expect(rl.size).toBe(250);
    // Every earlier key has expired by now. A sweep runs within 100 attempts.
    for (let i = 0; i < 100; i++) rl.attempt("live", 5000);
    expect(rl.size).toBe(1);
  });

  it("caps the number of keys, evicting the least recently used, and never refuses a new key", () => {
    const rl = new RateLimiter(5, 60_000, 50);
    for (let i = 0; i < 200; i++) expect(rl.attempt(`ip${i}`, 1000)).toBe(true);
    expect(rl.size).toBeLessThanOrEqual(50);
    expect(rl.attempt("ip199", 1001)).toBe(true);
  });

  it("keeps the 5 per window limit for one shared key under churn from other keys", () => {
    const rl = new RateLimiter(5, 60_000, 50);
    for (let i = 0; i < 5; i++) expect(rl.attempt("gateway", 1000 + i)).toBe(true);
    for (let i = 0; i < 30; i++) rl.attempt(`other${i}`, 2000);
    expect(rl.attempt("gateway", 3000)).toBe(false);
  });

  it("resets a key after a successful login", () => {
    const rl = new RateLimiter(5, 1000);
    for (let i = 0; i < 5; i++) rl.attempt("ip", 0);
    rl.reset("ip");
    expect(rl.attempt("ip", 1)).toBe(true);
  });
});

const json = { "content-type": "application/json" };

describe("api", () => {
  it("serves health without a session", async () => {
    const app = await makeApp();
    const res = await req(app, "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("rejects protected routes without a session", async () => {
    const app = await makeApp();
    expect((await req(app, "/api/anything")).status).toBe(401);
  });

  it("logs in, sets an httpOnly cookie and enforces CSRF on non-GET", async () => {
    const app = await makeApp("pw");
    const bad = await req(app, "/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ password: "no" }) });
    expect(bad.status).toBe(401);

    const ok = await req(app, "/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ password: "pw" }) });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const { csrfToken } = (await ok.json()) as { csrfToken: string };
    const cookieHeader = cookie.split(";")[0] ?? "";

    const noCsrf = await req(app, "/api/auth/logout", { method: "POST", headers: { cookie: cookieHeader } });
    expect(noCsrf.status).toBe(403);
    const withCsrf = await req(app, "/api/auth/logout", { method: "POST", headers: { cookie: cookieHeader, "x-csrf-token": csrfToken } });
    expect(withCsrf.status).toBe(200);

    // The old cookie value no longer works: logout revokes it on the server (D56), not only in the browser.
    const session = await req(app, "/api/auth/session", { headers: { cookie: cookieHeader } });
    expect(await session.json()).toMatchObject({ authenticated: false });
  });

  it("rate limits login to 5 attempts per IP and ignores forwarded headers", async () => {
    const app = await makeApp("pw");
    const attempt = (ip: string) =>
      req(app, "/api/auth/login", { method: "POST", headers: { ...json, "x-forwarded-for": "1.2.3.4" }, body: JSON.stringify({ password: "no" }) }, ip);
    for (let i = 0; i < 5; i++) expect((await attempt("10.0.0.9")).status).toBe(401);
    expect((await attempt("10.0.0.9")).status).toBe(429);
    expect((await attempt("10.0.0.10")).status).toBe(401);
  });
});

describe("cookie Secure flag", () => {
  const login = async (baseUrl: string, headers: Record<string, string> = {}) => {
    const app = await makeApp("pw", baseUrl);
    const res = await req(app, "/api/auth/login", { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ password: "pw" }) });
    expect(res.status).toBe(200);
    return res.headers.get("set-cookie") ?? "";
  };

  it("is not Secure when PULSE_BASE_URL is http, so it works on the LAN", async () => {
    const cookie = await login("http://192.168.0.10:8210");
    expect(cookie).toMatch(/pulse_session=/);
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("ignores a client supplied x-forwarded-proto", async () => {
    expect(await login("http://192.168.0.10:8210", { "x-forwarded-proto": "https" })).not.toMatch(/Secure/i);
  });

  it("is Secure when PULSE_BASE_URL is https", async () => {
    expect(await login("https://home-lab.tailnet.ts.net:8443")).toMatch(/Secure/i);
  });
});


describe("server side session revocation (D56)", () => {
  async function setup(dataDir?: string) {
    const dir = dataDir ?? mkdtempSync(join(tmpdir(), "pulse-epoch-"));
    const config = loadConfig({ NODE_ENV: "test", PULSE_BASE_URL: "http://192.168.0.10:8210", PULSE_PASSWORD_HASH: await hashPassword("pw"), PULSE_SESSION_SECRET: "s".repeat(40), PULSE_SECRET_KEY: "ab".repeat(32), GARMIN_MCP_URL: "http://garmin-mcp:8000/mcp" });
    const handle = openDb(dir);
    const app = createApp({ config, log: createLogger("silent"), sessionEpoch: dbSessionEpoch(handle.db) });
    return { dir, handle, app, config };
  }
  async function login(app: Awaited<ReturnType<typeof setup>>["app"]) {
    const res = await req(app, "/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ password: "pw" }) });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    return { cookie, csrfToken };
  }
  const session = async (app: Awaited<ReturnType<typeof setup>>["app"], cookie: string) => (await req(app, "/api/auth/session", { headers: { cookie } })).json() as Promise<{ authenticated: boolean }>;

  it("logout revokes every session on every device, including a copied cookie", async () => {
    const { app } = await setup();
    const phone = await login(app);
    const laptop = await login(app);
    expect((await session(app, phone.cookie)).authenticated).toBe(true);
    expect((await session(app, laptop.cookie)).authenticated).toBe(true);
    const out = await req(app, "/api/auth/logout", { method: "POST", headers: { cookie: phone.cookie, "x-csrf-token": phone.csrfToken } });
    expect(out.status).toBe(200);
    // The cookie the browser deleted is gone, but the copied value must also stop working.
    expect((await session(app, phone.cookie)).authenticated).toBe(false);
    expect((await session(app, laptop.cookie)).authenticated).toBe(false);
    expect((await req(app, "/api/anything", { headers: { cookie: laptop.cookie } })).status).toBe(401);
  });

  it("signing in again after a logout works, and CSRF is still enforced", async () => {
    const { app } = await setup();
    const first = await login(app);
    await req(app, "/api/auth/logout", { method: "POST", headers: { cookie: first.cookie, "x-csrf-token": first.csrfToken } });
    const second = await login(app);
    expect((await session(app, second.cookie)).authenticated).toBe(true);
    expect((await req(app, "/api/auth/logout", { method: "POST", headers: { cookie: second.cookie } })).status).toBe(403);
    expect((await session(app, second.cookie)).authenticated).toBe(true);
  });

  it("logout needs a session and a CSRF token, so nobody else can sign the owner out", async () => {
    const { app } = await setup();
    const me = await login(app);
    expect((await req(app, "/api/auth/logout", { method: "POST" })).status).toBe(401);
    expect((await session(app, me.cookie)).authenticated).toBe(true);
  });

  it("the epoch survives a restart, so a revoked session stays revoked", async () => {
    const a = await setup();
    const me = await login(a.app);
    await req(a.app, "/api/auth/logout", { method: "POST", headers: { cookie: me.cookie, "x-csrf-token": me.csrfToken } });
    a.handle.sqlite.close();
    const b = await setup(a.dir);
    expect((await session(b.app, me.cookie)).authenticated).toBe(false);
    const again = await login(b.app);
    expect((await session(b.app, again.cookie)).authenticated).toBe(true);
  });

  it("rejects a token from before the epoch existed (no v), so every device signs in once after the deploy", async () => {
    const { app, config } = await setup();
    const { createHmac, randomBytes } = await import("node:crypto");
    const body = Buffer.from(JSON.stringify({ csrf: randomBytes(24).toString("base64url"), exp: Date.now() + 1e9 })).toString("base64url");
    const token = `${body}.${createHmac("sha256", config.PULSE_SESSION_SECRET).update(body).digest("base64url")}`;
    expect((await session(app, `pulse_session=${token}`)).authenticated).toBe(false);
  });

  it("a token from a newer or older epoch is not accepted", () => {
    const { token } = createSessionToken("k".repeat(32), 3, 1000);
    expect(readSessionToken(token, "k".repeat(32), 3, 2000)).not.toBeNull();
    expect(readSessionToken(token, "k".repeat(32), 4, 2000)).toBeNull();
    expect(readSessionToken(token, "k".repeat(32), 2, 2000)).toBeNull();
  });
});
