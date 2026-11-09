import { describe, expect, it } from "vitest";
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
    const { token, payload } = createSessionToken("k".repeat(32), 1000);
    expect(readSessionToken(token, "k".repeat(32), 2000)?.csrf).toBe(payload.csrf);
    expect(readSessionToken(token, "x".repeat(32), 2000)).toBeNull();
    expect(readSessionToken(`${token}a`, "k".repeat(32), 2000)).toBeNull();
    expect(readSessionToken(token, "k".repeat(32), payload.exp + 1)).toBeNull();
    expect(readSessionToken(undefined, "k".repeat(32))).toBeNull();
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

    const session = await req(app, "/api/auth/session", { headers: { cookie: cookieHeader } });
    expect(await session.json()).toMatchObject({ authenticated: true });
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

