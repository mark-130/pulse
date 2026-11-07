import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loginRequestSchema, type HealthResponse, type SessionResponse } from "@pulse/shared";
import { verifyPassword } from "./auth/password.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, createSessionToken, csrfMatches, readSessionToken, type SessionPayload } from "./auth/session.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { registerRoutes, type ApiModule } from "./modules/registry.js";

type Env = { Variables: { session: SessionPayload | null } };

export interface AppDeps {
  config: Config;
  log: Logger;
  modules?: ApiModule[];
  version?: string;
}

export function createApp({ config, log, modules = [], version = "0.0.0" }: AppDeps) {
  const app = new Hono<Env>();
  const loginLimiter = new RateLimiter(5, 15 * 60 * 1000);
  const dummyHash = `${"0".repeat(32)}:${"0".repeat(128)}`;

  // Session and CSRF. Public routes: health, login, session. Everything else under /api needs both.
  app.use("/api/*", async (c, next) => {
    const session = readSessionToken(getCookie(c, SESSION_COOKIE), config.PULSE_SESSION_SECRET);
    c.set("session", session);
    const path = c.req.path;
    const isPublic = path === "/api/health" || path === "/api/auth/login" || path === "/api/auth/session";
    if (!isPublic && !session) return c.json({ error: "Not signed in" }, 401);
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (mutating && path !== "/api/auth/login") {
      if (!session || !csrfMatches(session.csrf, c.req.header("x-csrf-token"))) {
        return c.json({ error: "Missing or invalid CSRF token" }, 403);
      }
    }
    await next();
  });

  app.get("/api/health", (c) => {
    const body: HealthResponse = { status: "ok", version, time: new Date().toISOString() };
    return c.json(body);
  });

  app.get("/api/auth/session", (c) => {
    const session = c.get("session");
    const body: SessionResponse = { authenticated: session !== null, csrfToken: session?.csrf ?? null };
    return c.json(body);
  });

  app.post("/api/auth/login", zValidator("json", loginRequestSchema, (result, c) => {
    if (!result.success) return c.json({ error: "Invalid request" }, 400);
    return undefined;
  }), async (c) => {
    // Socket address only. Forwarded headers are client controlled on the LAN.
    const ip = getConnInfo(c).remote.address ?? "unknown";
    if (!loginLimiter.attempt(ip)) {
      log.warn({ ip }, "login rate limited");
      return c.json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    }
    const { password } = c.req.valid("json");
    const ok = await verifyPassword(password, config.PULSE_PASSWORD_HASH);
    if (!ok) {
      await verifyPassword(password, dummyHash);
      log.warn({ ip }, "login failed");
      return c.json({ error: "Incorrect password" }, 401);
    }
    loginLimiter.reset(ip);
    const { token, payload } = createSessionToken(config.PULSE_SESSION_SECRET);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_S,
      secure: c.req.header("x-forwarded-proto") === "https",
    });
    const body: SessionResponse = { authenticated: true, csrfToken: payload.csrf };
    return c.json(body);
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  const modulesApp = new Hono<Env>();
  registerRoutes(modulesApp as unknown as Hono, modules);
  app.route("/", modulesApp);

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // Static web app with SPA fallback.
  const webDist = config.WEB_DIST;
  if (webDist && existsSync(webDist)) {
    const indexHtml = readFileSync(join(webDist, "index.html"), "utf8");
    app.use("/*", serveStatic({ root: webDist }));
    app.get("*", (c) => c.html(indexHtml));
  }

  return app;
}
