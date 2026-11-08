import { asc } from "drizzle-orm";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { UPDATE_OFF_TEXT, proposalSchema, updateCheckResponseSchema, updateStatusSchema, buildInfoSchema, type Proposal } from "@pulse/shared";
import { auditLog, proposal as proposalTable } from "../src/db/schema.js";
import { beginConfirmation, endConfirmation } from "../src/modules/proposals/confirmations.js";
import { AppUpdateError, executeAppUpdate, watchtowerUpdateUrl } from "../src/modules/proposals/executors/app.js";
import { reconcileUpdates } from "../src/modules/proposals/outcome.js";
import { CHECK_CACHE_MS, CHECK_ERROR_CACHE_MS } from "../src/modules/update/service.js";
import { makeGarminApp, req } from "./helpers.js";

const TOKEN = "wt-secret-token-123";
const OLD = "cc3b793aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "9f2a1bebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T0 = new Date("2026-11-08T12:00:00Z");
const WT_URL = "http://watchtower:8080/v1/update?image=ghcr.io%2Fmark-130%2Fpulse";

interface Registry {
  latest: string | null;
  /** HTTP status to answer the manifest request with. */
  manifestStatus: number;
  calls: string[];
}

type WatchtowerBehaviour = { status: number } | { drop: string } | { error: Error };

function mocks(opts: { registry?: Partial<Registry>; watchtower?: WatchtowerBehaviour; onWatchtower?: (url: string, init: RequestInit) => void } = {}) {
  const registry: Registry = { latest: NEW, manifestStatus: 200, calls: [], ...opts.registry };
  const watchtower = { calls: [] as { url: string; init: RequestInit }[], behaviour: opts.watchtower ?? ({ status: 200 } as WatchtowerBehaviour) };
  const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("http://watchtower:8080")) {
      watchtower.calls.push({ url, init });
      opts.onWatchtower?.(url, init);
      const b = watchtower.behaviour;
      if ("drop" in b) throw Object.assign(new TypeError("fetch failed"), { cause: { code: b.drop } });
      if ("error" in b) throw b.error;
      return new Response("", { status: b.status });
    }
    registry.calls.push(url);
    if (url.startsWith("https://ghcr.io/token")) return res({ token: "anon" });
    if (url.endsWith("/manifests/latest")) {
      if (registry.manifestStatus !== 200) return res({ errors: [] }, registry.manifestStatus);
      return res({ manifests: [{ digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" } }, { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } }] });
    }
    if (url.endsWith("/manifests/sha256:amd")) return res({ config: { digest: "sha256:cfg" } });
    if (url.endsWith("/blobs/sha256:cfg")) {
      const labels: Record<string, string> = registry.latest ? { "org.opencontainers.image.revision": registry.latest, "org.opencontainers.image.created": "2026-11-08T11:00:00Z" } : {};
      return res({ config: { Labels: labels } });
    }
    return res({}, 500);
  }) as typeof fetch;
  return { fetchFn, registry, watchtower };
}

async function setup(o: { token?: string; sha?: string; registry?: Partial<Registry>; watchtower?: WatchtowerBehaviour; logs?: string[]; onWatchtower?: (url: string, init: RequestInit) => void } = {}) {
  let now = T0;
  const m = mocks({ registry: o.registry, watchtower: o.watchtower, onWatchtower: o.onWatchtower });
  const env: Record<string, string> = { PULSE_BUILD_SHA: o.sha ?? OLD, PULSE_BUILD_TIME: "2026-11-07T11:00:00Z" };
  if (o.token !== "") env.WATCHTOWER_TOKEN = o.token ?? TOKEN;
  const logDestination = o.logs ? { write: (line: string) => void o.logs?.push(line) } : undefined;
  const t = await makeGarminApp({ clock: () => now, env, fetchFn: m.fetchFn, logDestination });
  const json = (path: string, body?: unknown, method = "POST") =>
    req(t.app, path, { method, headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const propose = () => json("/api/proposals", { kind: "app.update" });
  const created = async (res: Response) => proposalSchema.parse(((await res.json()) as { proposal: unknown }).proposal);
  const confirm = (id: string) => json(`/api/proposals/${id}/confirm`);
  const audit = () => t.handle.db.select().from(auditLog).orderBy(asc(auditLog.id)).all();
  const row = (id: string) => t.handle.db.select().from(proposalTable).all().find((r) => r.id === id);
  const advance = (ms: number) => void (now = new Date(now.getTime() + ms));
  return { t, m, json, propose, created, confirm, audit, row, advance, now: () => now };
}

describe("build identity", () => {
  it("serves the build on a public route and nothing secret", async () => {
    const s = await setup({ sha: OLD.toUpperCase() });
    const res = await req(s.t.app, "/api/health/version"); // no cookie
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(buildInfoSchema.parse(JSON.parse(text))).toEqual({ sha: OLD, shortSha: "cc3b793", builtAt: "2026-11-07T11:00:00.000Z" });
    expect(text).not.toContain(TOKEN);
  });

  it("reports dev outside CI images", async () => {
    const t = await makeGarminApp();
    const body = buildInfoSchema.parse(await (await req(t.app, "/api/health/version")).json());
    expect(body).toEqual({ sha: "dev", shortSha: "dev", builtAt: null });
  });
});

describe("update check", () => {
  it("says Up to date when the revision label matches the running build", async () => {
    const s = await setup({ registry: { latest: OLD } });
    const c = updateCheckResponseSchema.parse(await (await s.json("/api/update/check")).json()).check;
    expect(c).toMatchObject({ state: "up_to_date", reason: null });
  });

  it("says Update available with the new build and time, reading the linux manifest out of the index", async () => {
    const s = await setup();
    const c = updateCheckResponseSchema.parse(await (await s.json("/api/update/check")).json()).check;
    expect(c).toMatchObject({ state: "available", latest: { sha: NEW, shortSha: "9f2a1be", builtAt: "2026-11-08T11:00:00.000Z" } });
    expect(s.m.registry.calls.some((u) => u.endsWith("/manifests/sha256:amd"))).toBe(true);
    expect(s.m.registry.calls.every((u) => u.startsWith("https://ghcr.io/"))).toBe(true);
  });

  it("says Could not check in plain text when the package is private, and the reason names the fix", async () => {
    const s = await setup({ registry: { manifestStatus: 401 } });
    const c = updateCheckResponseSchema.parse(await (await s.json("/api/update/check")).json()).check;
    expect(c.state).toBe("error");
    expect(c.reason).toMatch(/private.*public/);
  });

  it("explains an image without a revision label", async () => {
    const s = await setup({ registry: { latest: null } });
    const c = updateCheckResponseSchema.parse(await (await s.json("/api/update/check")).json()).check;
    expect(c.reason).toMatch(/no revision label/);
  });

  it("cannot compare a dev build", async () => {
    const s = await setup({ sha: "dev" });
    const c = updateCheckResponseSchema.parse(await (await s.json("/api/update/check")).json()).check;
    expect(c).toMatchObject({ state: "error" });
    expect(c.reason).toMatch(/not made by CI/);
  });

  it("caches a good check for 10 minutes and a failed one for one minute", async () => {
    const s = await setup();
    await s.json("/api/update/check");
    const first = s.m.registry.calls.length;
    s.advance(CHECK_CACHE_MS - 1000);
    await s.json("/api/update/check");
    expect(s.m.registry.calls).toHaveLength(first);
    expect(updateStatusSchema.parse(await (await s.t.get("/api/update")).json()).check?.state).toBe("available");
    s.advance(2000);
    await s.json("/api/update/check");
    expect(s.m.registry.calls.length).toBeGreaterThan(first);

    const bad = await setup({ registry: { manifestStatus: 404 } });
    await bad.json("/api/update/check");
    const n = bad.m.registry.calls.length;
    bad.advance(CHECK_ERROR_CACHE_MS - 1000);
    await bad.json("/api/update/check");
    expect(bad.m.registry.calls).toHaveLength(n);
    bad.advance(2000);
    await bad.json("/api/update/check");
    expect(bad.m.registry.calls.length).toBeGreaterThan(n);
  });
});

describe("off without a token", () => {
  it("still checks, but refuses to create or confirm an update and never calls Watchtower", async () => {
    const s = await setup({ token: "" });
    const status = updateStatusSchema.parse(await (await s.t.get("/api/update")).json());
    expect(status.updatesEnabled).toBe(false);
    expect(status.build.shortSha).toBe("cc3b793");
    const c = updateCheckResponseSchema.parse(await (await s.json("/api/update/check")).json()).check;
    expect(c.state).toBe("available");
    const res = await s.propose();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(UPDATE_OFF_TEXT);
    expect(s.m.watchtower.calls).toHaveLength(0);
    expect(s.t.backupCalls).toHaveLength(0);
  });

  it("the executor refuses without a token even if called directly", async () => {
    const p = { ...fakeProposal() };
    beginConfirmation(p.id);
    try {
      await expect(executeAppUpdate(p, { watchtowerUrl: "http://watchtower:8080", token: "  ", backup: () => "/x/a.db", fetchFn: (async () => new Response()) as typeof fetch, hooks: noHooks() })).rejects.toThrow(UPDATE_OFF_TEXT);
    } finally {
      endConfirmation(p.id);
    }
  });
});

function noHooks() {
  return { requested: () => undefined, backupTaken: () => undefined, calling: () => undefined };
}
function fakeProposal(): Extract<Proposal, { kind: "app.update" }> {
  return { id: "p-1", kind: "app.update", targetSystem: "app", status: "pending", createdBy: "user", rationale: null, before: { sha: OLD, builtAt: null }, after: { sha: NEW, builtAt: null }, createdAt: T0.toISOString(), expiresAt: T0.toISOString(), decidedAt: null, result: null };
}

describe("update through the proposal engine", () => {
  it("creates a pending proposal with the running and the new build, and is idempotent", async () => {
    const s = await setup();
    const p = await s.created(await s.propose());
    expect(p).toMatchObject({ kind: "app.update", targetSystem: "app", status: "pending", before: { sha: OLD }, after: { sha: NEW, builtAt: "2026-11-08T11:00:00.000Z" } });
    const again = await s.created(await s.propose());
    expect(again.id).toBe(p.id);
    expect(s.audit().filter((a) => a.action === "proposal.created")).toHaveLength(1);
    expect(s.m.watchtower.calls).toHaveLength(0);
  });

  it("a failed check does not block it: the new build is just unknown", async () => {
    const s = await setup({ registry: { manifestStatus: 401 } });
    const p = await s.created(await s.propose());
    expect(p.after).toBeNull();
  });

  it("takes the backup, saves the proposal as applied, then calls Watchtower with the fixed image and the bearer token", async () => {
    let seen: { backups: number; status: string | undefined; auth: string | null } | null = null;
    const ref: { s?: Awaited<ReturnType<typeof setup>> } = {};
    const s = await setup({
      onWatchtower: (_url, init) => {
        const id = ref.s?.t.handle.db.select().from(proposalTable).all()[0]?.id ?? "";
        seen = { backups: ref.s?.t.backupCalls.length ?? -1, status: ref.s?.row(id)?.status, auth: new Headers(init.headers).get("authorization") };
      },
    });
    ref.s = s;
    const p = await s.created(await s.propose());
    const res = await s.confirm(p.id);
    expect(res.status).toBe(200);
    expect(s.m.watchtower.calls).toHaveLength(1);
    expect(s.m.watchtower.calls[0]?.url).toBe(WT_URL);
    expect(seen).toEqual({ backups: 1, status: "applied", auth: `Bearer ${TOKEN}` });
    const backup = s.t.backupCalls[0] ?? "";
    expect(existsSync(backup)).toBe(true);
    expect(backup).toContain(join("backups", "pulse-"));

    const done = proposalSchema.parse(((await res.json()) as { proposal: unknown }).proposal);
    expect(done.status).toBe("applied");
    expect(done.result?.update).toMatchObject({ state: "requested", watchtowerStatus: 200, backup: backup.split("/").pop() });
    expect(s.audit().map((a) => a.action)).toEqual(["proposal.created", "update.requested", "update.backup_taken", "update.called", "proposal.applied"]);
  });

  it("treats a dropped connection as expected, because Watchtower stops this container", async () => {
    const s = await setup({ watchtower: { drop: "UND_ERR_SOCKET" } });
    const p = await s.created(await s.propose());
    const res = await s.confirm(p.id);
    expect(res.status).toBe(200);
    const done = proposalSchema.parse(((await res.json()) as { proposal: unknown }).proposal);
    expect(done).toMatchObject({ status: "applied", result: { update: { state: "requested", watchtowerStatus: null } } });
  });

  it("records the final outcome when the next process boots on a new build, and not before", async () => {
    const s = await setup({ watchtower: { drop: "ECONNRESET" } });
    const p = await s.created(await s.propose());
    await s.confirm(p.id);
    expect(reconcileUpdates(s.t.handle.db, { sha: OLD }, s.now())).toBe(0);
    s.advance(40_000);
    expect(reconcileUpdates(s.t.handle.db, { sha: NEW }, s.now())).toBe(1);
    const last = proposalSchema.parse((await (await s.t.get("/api/proposals")).json() as { history: unknown[] }).history[0]);
    expect(last.result?.update).toMatchObject({ state: "updated", runningSha: NEW });
    expect(s.audit().at(-1)).toMatchObject({ action: "update.completed", actor: "system", result: "updated" });
    expect(reconcileUpdates(s.t.handle.db, { sha: NEW }, s.now())).toBe(0);
  });

  it("records not completed once three minutes pass on the same build", async () => {
    const s = await setup();
    const p = await s.created(await s.propose());
    await s.confirm(p.id);
    s.advance(179_000);
    await s.t.get("/api/update");
    expect(s.audit().at(-1)?.action).toBe("proposal.applied");
    s.advance(2_000);
    await s.t.get("/api/update");
    expect(s.audit().at(-1)).toMatchObject({ action: "update.not_completed", result: "not_completed" });
    const last = proposalSchema.parse((await (await s.t.get("/api/proposals")).json() as { history: unknown[] }).history[0]);
    expect(last.result?.update?.state).toBe("not_completed");
  });

  it("fails clearly when Watchtower refuses the token, and the proposal is Failed", async () => {
    const s = await setup({ watchtower: { status: 401 } });
    const p = await s.created(await s.propose());
    const res = await s.confirm(p.id);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; proposal: Proposal };
    expect(body.error).toMatch(/refused the token \(401\)/);
    expect(body.proposal.status).toBe("failed");
    expect(s.audit().at(-1)).toMatchObject({ action: "proposal.failed" });
  });

  it("fails clearly when Watchtower cannot be reached (no shared network)", async () => {
    const s = await setup({ watchtower: { drop: "ENOTFOUND" } });
    const p = await s.created(await s.propose());
    const res = await s.confirm(p.id);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/Could not reach Watchtower.*shares a Docker network/);
  });

  it("is stale, and sends nothing, if the app is already on another build", async () => {
    const s = await setup();
    const p = await s.created(await s.propose());
    (s.t.updateService.build as { sha: string }).sha = NEW;
    const res = await s.confirm(p.id);
    expect(res.status).toBe(409);
    expect(s.m.watchtower.calls).toHaveLength(0);
    expect(s.t.backupCalls).toHaveLength(0);
    expect(s.audit().at(-1)?.action).toBe("proposal.stale");
  });

  it("Reject sends nothing and is audited", async () => {
    const s = await setup();
    const p = await s.created(await s.propose());
    const res = await s.json(`/api/proposals/${p.id}/reject`);
    expect(res.status).toBe(200);
    expect(s.m.watchtower.calls).toHaveLength(0);
    expect(s.audit().at(-1)).toMatchObject({ action: "proposal.rejected", target: "app.update:app" });
  });

  it("confirming twice sends one request", async () => {
    const s = await setup();
    const p = await s.created(await s.propose());
    await Promise.all([s.confirm(p.id), s.confirm(p.id)]);
    await s.confirm(p.id);
    expect(s.m.watchtower.calls).toHaveLength(1);
    expect(s.t.backupCalls).toHaveLength(1);
  });
});

describe("the executor on its own", () => {
  it("refuses to run unless the confirm route registered the proposal", async () => {
    await expect(executeAppUpdate(fakeProposal(), { watchtowerUrl: "http://watchtower:8080", token: TOKEN, backup: () => "/x/a.db", fetchFn: (async () => new Response()) as typeof fetch, hooks: noHooks() })).rejects.toThrow(/not being confirmed/);
  });

  it("does not call Watchtower if the backup fails", async () => {
    const p = fakeProposal();
    let called = false;
    beginConfirmation(p.id);
    try {
      const err = await executeAppUpdate(p, {
        watchtowerUrl: "http://watchtower:8080",
        token: TOKEN,
        backup: () => {
          throw new Error("disk full");
        },
        fetchFn: (async () => {
          called = true;
          return new Response();
        }) as typeof fetch,
        hooks: noHooks(),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppUpdateError);
      expect((err as Error).message).toMatch(/backup failed.*nothing was sent/i);
      expect(called).toBe(false);
    } finally {
      endConfirmation(p.id);
    }
  });

  it("builds the URL from the configured base only: the image is fixed", () => {
    expect(watchtowerUpdateUrl("http://watchtower:8080/")).toBe(WT_URL);
    expect(watchtowerUpdateUrl("http://10.0.0.5:9000")).toBe("http://10.0.0.5:9000/v1/update?image=ghcr.io%2Fmark-130%2Fpulse");
  });

  it("is imported only by the confirm route (eslint)", async () => {
    const eslint = new ESLint({ cwd: join(import.meta.dirname, "../../..") });
    const code = 'import { executeAppUpdate } from "./modules/proposals/executors/app.js";\nexport const x = executeAppUpdate;\n';
    const bad = await eslint.lintText(code, { filePath: join(import.meta.dirname, "../src/rogue.ts") });
    expect(bad[0]?.messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);
  });
});

describe("the token never leaks", () => {
  it("is absent from logs, responses, errors and stored rows in success and failure flows", async () => {
    const logs: string[] = [];
    const seen: string[] = [];
    for (const watchtower of [{ status: 200 }, { status: 401 }, { status: 500 }, { drop: "ENOTFOUND" }, { error: new Error(`boom Bearer ${TOKEN} token=${TOKEN}`) }] as WatchtowerBehaviour[]) {
      const s = await setup({ watchtower, logs });
      seen.push(await (await s.t.get("/api/update")).text());
      const pr = await s.propose();
      seen.push(await pr.clone().text());
      const p = await s.created(pr);
      const res = await s.confirm(p.id);
      seen.push(await res.text(), await (await s.t.get("/api/proposals")).text(), await (await s.t.get("/api/health/version")).text(), JSON.stringify(s.t.handle.db.select().from(proposalTable).all()), JSON.stringify(s.audit()));
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const text of [...logs, ...seen]) expect(text).not.toContain(TOKEN);
  });
});
