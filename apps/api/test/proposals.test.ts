import { describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { garminProposalSchema, proposalSchema, proposalsResponseSchema, todayResponseSchema } from "@pulse/shared";
import { auditLog, proposal as proposalTable } from "../src/db/schema.js";
import { executeGarminProposal } from "../src/modules/proposals/executors/garmin.js";
import { getProposal } from "../src/modules/proposals/engine.js";
import { TODAY, scheduled, type FakeOptions } from "./fixtures.js";
import { makeGarminApp, req } from "./helpers.js";

const ID = String(scheduled.scheduled_workouts[0]?.scheduled_workout_id);
const T0 = new Date(`${TODAY}T12:30:00Z`);

async function setup(o: { writes?: boolean } = {}) {
  let now = T0;
  const fake: FakeOptions = { overrides: {} };
  const t = await makeGarminApp({ clock: () => now, fake, writes: o.writes ?? false });
  await t.post("/api/sync/garmin");
  now = new Date(now.getTime() + 5 * 60_000);
  const json = (path: string, body?: unknown, method = "POST", csrf = true) =>
    req(t.app, path, { method, headers: { cookie: t.cookie, ...(csrf ? { "x-csrf-token": t.csrfToken } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const move = (date = "2026-11-10") => json("/api/proposals", { kind: "garmin.reschedule", scheduledId: ID, date });
  const remove = () => json("/api/proposals", { kind: "garmin.unschedule", scheduledId: ID });
  const confirm = (id: string) => json(`/api/proposals/${id}/confirm`);
  const reject = (id: string) => json(`/api/proposals/${id}/reject`);
  const created = async (res: Response) => proposalSchema.parse(((await res.json()) as { proposal: unknown }).proposal);
  const list = async () => proposalsResponseSchema.parse(await (await t.get("/api/proposals")).json());
  const audit = () => t.handle.db.select().from(auditLog).orderBy(asc(auditLog.id)).all();
  const advance = (ms: number) => void (now = new Date(now.getTime() + ms));
  const liveWorkout = (date: string, name = "1h50 Long Run") => ({ scheduled_workouts: [{ ...scheduled.scheduled_workouts[0], date, name }] });
  return { t, fake, json, move, remove, confirm, reject, created, list, audit, advance, liveWorkout, now: () => now, setNow: (d: Date) => void (now = d) };
}

describe("creating proposals", () => {
  it("only creates a pending proposal with the exact before and after, an expiry and an audit entry", async () => {
    const s = await setup();
    const p = await s.created(await s.move("2026-11-10"));
    expect(p).toMatchObject({ kind: "garmin.reschedule", targetSystem: "garmin", status: "pending", createdBy: "user" });
    expect(p.before).toEqual({ scheduledId: ID, name: "1h50 Long Run", date: "2026-11-08", durationS: 6600, completed: false });
    expect(p.after).toEqual({ ...p.before, date: "2026-11-10" });
    expect(Date.parse(p.expiresAt) - Date.parse(p.createdAt)).toBe(24 * 3_600_000);
    const row = s.t.handle.db.select().from(proposalTable).all()[0];
    expect(row?.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.audit().map((a) => a.action)).toContain("proposal.created");
    expect(s.t.writer.calls).toHaveLength(0);
    expect(s.t.writer.connects()).toBe(0);
  });

  it("creates an unschedule proposal with no after state", async () => {
    const s = await setup();
    const p = await s.created(await s.remove());
    expect(p).toMatchObject({ kind: "garmin.unschedule", after: null, status: "pending" });
  });

  it("is idempotent by scheduled workout: the same change returns the same proposal, another is refused", async () => {
    const s = await setup();
    const a = await s.created(await s.move("2026-11-10"));
    const b = await s.created(await s.move("2026-11-10"));
    expect(b.id).toBe(a.id);
    expect(s.t.handle.db.select().from(proposalTable).all()).toHaveLength(1);
    const other = await s.move("2026-11-11");
    expect(other.status).toBe(409);
    expect((await s.remove()).status).toBe(409);
  });

  it("validates dates and workouts", async () => {
    const s = await setup();
    expect((await s.move("2026-11-08")).status).toBe(400);
    expect((await s.move("2026-11-06")).status).toBe(400);
    expect((await s.move("2027-03-01")).status).toBe(400);
    expect((await s.json("/api/proposals", { kind: "garmin.reschedule", scheduledId: "999", date: "2026-11-10" })).status).toBe(404);
    expect((await s.json("/api/proposals", { kind: "garmin.schedule", scheduledId: ID })).status).toBe(400);
    expect((await s.json("/api/proposals", { kind: "garmin.reschedule", scheduledId: ID, date: "tomorrow" })).status).toBe(400);
  });
});

describe("session and CSRF", () => {
  it("every proposals route needs a session and the mutating ones a CSRF token", async () => {
    const s = await setup();
    const p = await s.created(await s.move());
    expect((await req(s.t.app, "/api/proposals")).status).toBe(401);
    expect((await req(s.t.app, `/api/proposals/${p.id}/confirm`, { method: "POST" })).status).toBe(401);
    expect((await s.json("/api/proposals", { kind: "garmin.unschedule", scheduledId: ID }, "POST", false)).status).toBe(403);
    expect((await s.json(`/api/proposals/${p.id}/confirm`, undefined, "POST", false)).status).toBe(403);
    expect((await s.json(`/api/proposals/${p.id}/reject`, undefined, "POST", false)).status).toBe(403);
    expect(getProposal(s.t.handle.db, p.id)?.status).toBe("pending");
    expect(s.t.writer.calls).toHaveLength(0);
  });
});

describe("dry run (writes off, the default)", () => {
  it("runs the whole confirm flow, audits it, and makes no MCP write call or connection", async () => {
    const s = await setup({ writes: false });
    const p = await s.created(await s.move("2026-11-10"));
    const res = await s.confirm(p.id);
    expect(res.status).toBe(200);
    const done = await s.created(res);
    expect(done.status).toBe("applied");
    expect(done.result).toMatchObject({ mode: "dry_run" });
    expect(done.result?.message).toContain("Dry run: nothing will be sent to Garmin");
    expect(done.result?.verification).toBeUndefined();
    expect(s.t.writer.connects()).toBe(0);
    expect(s.t.writer.calls).toHaveLength(0);
    // The live state check is a read, and the only Garmin traffic.
    expect(s.t.fake.calls.at(-1)?.tool).toBe("get_scheduled_workouts");
    const entry = s.audit().find((a) => a.action === "proposal.applied");
    expect(entry).toMatchObject({ actor: "user", result: "dry run" });
    expect(entry?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await s.list()).writesEnabled).toBe(false);
  });
});

describe("live mode with a mocked MCP client", () => {
  it("reschedules through the one allowed tool with the calendar id and new date", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    const done = await s.created(await s.confirm(p.id));
    expect(done).toMatchObject({ status: "applied", result: { mode: "live", verification: { state: "waiting", matches: 0 } } });
    expect(s.t.writer.calls).toEqual([{ tool: "reschedule_workout", args: { scheduled_workout_id: Number(ID), calendar_date: "2026-11-10" } }]);
    expect(s.audit().find((a) => a.action === "proposal.applied")?.result).toBe("live");
  });

  it("unschedules through the one allowed tool", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.remove());
    await s.confirm(p.id);
    expect(s.t.writer.calls).toEqual([{ tool: "unschedule_workout", args: { scheduled_workout_id: Number(ID) } }]);
  });

  it("is idempotent: confirming again, or twice at once, sends one write", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    const [a, b] = await Promise.all([s.confirm(p.id), s.confirm(p.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const again = await s.confirm(p.id);
    expect(again.status).toBe(200);
    expect((await s.created(again)).status).toBe("applied");
    expect(s.t.writer.calls).toHaveLength(1);
    expect(s.audit().filter((x) => x.action === "proposal.applied")).toHaveLength(1);
  });

  it("records a failure, sanitised, and does not mark it applied", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    s.t.writer.failWith("boom http://garmin-mcp:8000/mcp?token=abc123");
    const res = await s.confirm(p.id);
    expect(res.status).toBe(502);
    const failed = getProposal(s.t.handle.db, p.id);
    expect(failed?.status).toBe("failed");
    expect(JSON.stringify(failed?.result)).not.toMatch(/abc123|garmin-mcp/);
    expect(s.audit().map((a) => a.action)).toContain("proposal.failed");
    expect((await s.confirm(p.id)).status).toBe(409);
    expect(s.t.writer.calls).toHaveLength(1);
  });
});

describe("stale hash", () => {
  it("marks the proposal stale and shows the new state when Garmin changed, with no write", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    s.fake.overrides = { get_scheduled_workouts: s.liveWorkout("2026-11-09") };
    const res = await s.confirm(p.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; proposal: unknown };
    const stale = proposalSchema.parse(body.proposal);
    expect(stale.status).toBe("stale");
    expect(stale.result?.live).toMatchObject({ date: "2026-11-09", name: "1h50 Long Run" });
    expect(s.t.writer.calls).toHaveLength(0);
    expect(s.audit().map((a) => a.action)).toContain("proposal.stale");
    expect((await s.confirm(p.id)).status).toBe(409);
    expect(s.t.writer.calls).toHaveLength(0);
  });

  it("is stale when the workout is renamed in Garmin", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    s.fake.overrides = { get_scheduled_workouts: s.liveWorkout("2026-11-08", "Renamed") };
    expect((await s.confirm(p.id)).status).toBe(409);
    expect(getProposal(s.t.handle.db, p.id)?.status).toBe("stale");
    expect(s.t.writer.calls).toHaveLength(0);
  });

  it("is stale, with no live state, when the workout is gone from Garmin", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.remove());
    s.fake.overrides = { get_scheduled_workouts: { scheduled_workouts: [] } };
    expect((await s.confirm(p.id)).status).toBe(409);
    expect(getProposal(s.t.handle.db, p.id)).toMatchObject({ status: "stale", result: { live: null } });
    expect(s.t.writer.calls).toHaveLength(0);
  });

  it("does not execute when live state cannot be read, and leaves the proposal pending", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    s.fake.overrides = { get_scheduled_workouts: "not a schedule" };
    const res = await s.confirm(p.id);
    expect(res.status).toBe(502);
    expect(getProposal(s.t.handle.db, p.id)?.status).toBe("pending");
    expect(s.t.writer.calls).toHaveLength(0);
    expect(s.audit().map((a) => a.action)).toContain("proposal.confirm_blocked");
  });
});

describe("expiry and rejection", () => {
  it("expires after 24 hours: confirm is refused, nothing is sent, it moves to history", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    s.advance(24 * 3_600_000 + 60_000);
    const res = await s.confirm(p.id);
    expect(res.status).toBe(409);
    expect(getProposal(s.t.handle.db, p.id)?.status).toBe("expired");
    expect(s.t.writer.calls).toHaveLength(0);
    const l = await s.list();
    expect(l.pending).toHaveLength(0);
    expect(l.history[0]?.status).toBe("expired");
    expect(s.audit().map((a) => a.action)).toContain("proposal.expired");
  });

  it("is still confirmable just before the 24 hours are up", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    s.advance(23 * 3_600_000);
    expect((await s.confirm(p.id)).status).toBe(200);
  });

  it("a rejected proposal can never be confirmed", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    expect((await s.created(await s.reject(p.id))).status).toBe("rejected");
    expect((await s.reject(p.id)).status).toBe(409);
    expect((await s.confirm(p.id)).status).toBe(409);
    expect(s.t.writer.calls).toHaveLength(0);
    expect(s.audit().map((a) => a.action)).toContain("proposal.rejected");
    expect((await s.move("2026-11-11")).status).toBe(200);
  });
});

describe("state machine", () => {
  it("only moves forward from pending, and applied, rejected, expired, stale and failed are final", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    await s.confirm(p.id);
    expect((await s.reject(p.id)).status).toBe(409);
    expect(getProposal(s.t.handle.db, p.id)?.status).toBe("applied");
    expect((await s.json("/api/proposals/nope/confirm")).status).toBe(404);
    expect((await s.json("/api/proposals/nope/reject")).status).toBe(404);
  });
});

describe("audit log", () => {
  it("is append only: the database refuses updates and deletes", async () => {
    const s = await setup();
    await s.move("2026-11-10");
    const db = s.t.handle.sqlite;
    expect(() => db.prepare("update audit_log set result = 'x'").run()).toThrow(/append only/);
    expect(() => db.prepare("delete from audit_log").run()).toThrow(/append only/);
    expect(s.audit().length).toBeGreaterThan(0);
  });

  it("records who, what and a payload hash for every step, in order", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    await s.confirm(p.id);
    const rows = s.audit();
    expect(rows.map((r) => r.action)).toEqual(["proposal.created", "proposal.applied"]);
    for (const r of rows) expect(r.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]?.target).toBe(`garmin.reschedule:${ID}`);
  });
});

describe("executors never run without a confirmed proposal", () => {
  it("refuses a direct call, and no route other than confirm touches the writer", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    await expect(executeGarminProposal(garminProposalSchema.parse(p), { writesEnabled: true, getWriter: s.t.writer.factory, holdsClaim: () => true })).rejects.toThrow(/not being confirmed/);
    await s.reject(p.id);
    await s.list();
    await s.t.get("/api/today");
    await s.t.get("/api/races");
    expect(s.t.writer.connects()).toBe(0);
    expect(s.t.writer.calls).toHaveLength(0);
  });
});

describe("today count", () => {
  it("shows the real number of pending proposals", async () => {
    const s = await setup();
    expect(todayResponseSchema.parse(await (await s.t.get("/api/today")).json()).proposals.pending).toBe(0);
    const p = await s.created(await s.move("2026-11-10"));
    expect(todayResponseSchema.parse(await (await s.t.get("/api/today")).json()).proposals.pending).toBe(1);
    await s.reject(p.id);
    expect(todayResponseSchema.parse(await (await s.t.get("/api/today")).json()).proposals.pending).toBe(0);
  });
});

describe("conflict probe (72 hour window)", () => {
  type S = Awaited<ReturnType<typeof setup>>;
  const verification = async (s: S, id: string) => getProposal(s.t.handle.db, id)?.result?.verification;
  const sync = async (s: S, ms = 30 * 60_000) => {
    s.advance(ms);
    await s.t.post("/api/sync/garmin");
  };
  const checks = (s: S) => s.audit().filter((a) => a.action === "verification.checked").length;
  const applied = async (s: S, date = "2026-11-10") => {
    const p = await s.created(await s.move(date));
    await s.confirm(p.id);
    return p;
  };

  it("keeps checking on every sync for 72 hours and stays in Checking, never Verified early", async () => {
    const s = await setup({ writes: true });
    const p = await applied(s);
    expect(await verification(s, p.id)).toMatchObject({ state: "waiting", matches: 0, lastConfirmedAt: null });
    s.fake.overrides = { get_scheduled_workouts: s.liveWorkout("2026-11-10") };
    for (let i = 0; i < 8; i++) await sync(s);
    const v = await verification(s, p.id);
    expect(v).toMatchObject({ state: "waiting", matches: 8 });
    expect(v?.lastConfirmedAt).toBe(s.now().toISOString());
    expect(v?.checks).toHaveLength(5);
    expect(checks(s)).toBe(8);
  });

  it("is Verified only when the 72 hour window closes with the date still in place", async () => {
    const s = await setup({ writes: true });
    const p = await applied(s);
    s.fake.overrides = { get_scheduled_workouts: s.liveWorkout("2026-11-10") };
    await sync(s);
    await sync(s, 71 * 3_600_000);
    expect((await verification(s, p.id))?.state).toBe("waiting");
    await sync(s, 2 * 3_600_000);
    expect(await verification(s, p.id)).toMatchObject({ state: "verified", matches: 3 });
    expect(s.audit().map((a) => a.action)).toContain("verification.verified");
    const before = checks(s);
    await sync(s);
    expect(checks(s)).toBe(before);
  });

  it("catches a late revert by the plan app after earlier syncs matched, and then stops checking", async () => {
    const s = await setup({ writes: true });
    const p = await applied(s);
    s.fake.overrides = { get_scheduled_workouts: s.liveWorkout("2026-11-10") };
    await sync(s);
    await sync(s);
    expect((await verification(s, p.id))?.state).toBe("waiting");
    // The plan app's next batch puts the original date back, a day later.
    s.fake.overrides = { get_scheduled_workouts: s.liveWorkout("2026-11-08") };
    await sync(s, 24 * 3_600_000);
    const v = await verification(s, p.id);
    expect(v).toMatchObject({ state: "reverted", matches: 2 });
    expect(v?.checks.at(-1)?.seen).toContain("original date");
    expect(s.audit().map((a) => a.action)).toContain("verification.reverted");
    const n = checks(s);
    s.fake.overrides = { get_scheduled_workouts: s.liveWorkout("2026-11-10") };
    await sync(s);
    expect(checks(s)).toBe(n);
    expect((await verification(s, p.id))?.state).toBe("reverted");
  });

  it("is Reverted at the first sync if the date already went back", async () => {
    const s = await setup({ writes: true });
    const p = await applied(s);
    await sync(s);
    expect(await verification(s, p.id)).toMatchObject({ state: "reverted", matches: 0 });
  });

  it("checks an unschedule the same way", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.remove());
    await s.confirm(p.id);
    s.fake.overrides = { get_scheduled_workouts: { scheduled_workouts: [] } };
    await sync(s);
    await sync(s, 73 * 3_600_000);
    expect(await verification(s, p.id)).toMatchObject({ state: "verified" });
  });

  it("does not probe a dry run", async () => {
    const s = await setup({ writes: false });
    const p = await s.created(await s.move("2026-11-10"));
    await s.confirm(p.id);
    await sync(s);
    expect(await verification(s, p.id)).toBeUndefined();
    expect(checks(s)).toBe(0);
  });
});

describe("confirmation claim: reject and expiry cannot race a live read (D63)", () => {
  /** Starts a confirm whose Garmin read waits, and returns once the read is in flight. */
  async function confirmWaiting(s: Awaited<ReturnType<typeof setup>>, id: string) {
    let release!: () => void;
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => (entered = r));
    s.fake.defer = { tool: "get_scheduled_workouts", entered, until: new Promise<void>((r) => (release = r)) };
    const pending = s.confirm(id);
    await inFlight;
    return { pending, release };
  }
  const actions = (s: Awaited<ReturnType<typeof setup>>) => s.audit().map((a) => a.action);

  it("rejecting while the read is awaited is refused, and the confirm then applies exactly once", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    const w = await confirmWaiting(s, p.id);
    const rejected = await s.reject(p.id);
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { error: string }).error).toMatch(/being confirmed/);
    expect(getProposal(s.t.handle.db, p.id)?.status).toBe("pending");
    expect(s.t.writer.calls).toHaveLength(0);
    w.release();
    const res = await w.pending;
    expect(res.status).toBe(200);
    expect(getProposal(s.t.handle.db, p.id)?.status).toBe("applied");
    expect(s.t.writer.calls).toHaveLength(1);
    expect(actions(s).filter((a) => a === "proposal.rejected")).toHaveLength(0);
    expect(actions(s).filter((a) => a === "proposal.applied")).toHaveLength(1);
    const row = s.t.handle.db.select().from(proposalTable).all()[0];
    expect(row?.claimToken).toBeNull();
  });

  it("expiry while the read is awaited does not expire it, and a second confirm does not write twice", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    const w = await confirmWaiting(s, p.id);
    s.setNow(new Date(Date.parse(p.expiresAt) + 60_000));
    // Anything that lists proposals runs the expiry sweep.
    const listed = await s.list();
    expect(listed.pending.map((x) => x.id)).toContain(p.id);
    expect(getProposal(s.t.handle.db, p.id)?.status).toBe("pending");
    const second = await s.confirm(p.id);
    expect(second.status).toBe(409);
    w.release();
    expect((await w.pending).status).toBe(200);
    expect(getProposal(s.t.handle.db, p.id)?.status).toBe("applied");
    expect(s.t.writer.calls).toHaveLength(1);
    expect(actions(s)).not.toContain("proposal.expired");
    expect(actions(s).filter((a) => a === "proposal.applied")).toHaveLength(1);
  });

  it("whatever the interleaving, the row, the audit trail and the writer agree and at most one write happens", async () => {
    for (const interfere of ["reject", "expire"] as const) {
      const s = await setup({ writes: true });
      const p = await s.created(await s.move("2026-11-10"));
      const w = await confirmWaiting(s, p.id);
      if (interfere === "reject") await s.reject(p.id);
      else {
        s.setNow(new Date(Date.parse(p.expiresAt) + 60_000));
        await s.list();
      }
      w.release();
      await w.pending;
      const status = getProposal(s.t.handle.db, p.id)?.status;
      const acts = actions(s);
      const writes = s.t.writer.calls.length;
      expect(writes).toBeLessThanOrEqual(1);
      // A write happened if and only if the proposal ended applied, and it was never also rejected or expired.
      expect(writes === 1).toBe(status === "applied");
      expect(acts.includes("proposal.applied")).toBe(status === "applied");
      expect(acts.includes("proposal.rejected")).toBe(status === "rejected");
      expect(acts.includes("proposal.expired")).toBe(status === "expired");
      expect(acts.filter((a) => ["proposal.applied", "proposal.rejected", "proposal.expired"].includes(a))).toHaveLength(1);
    }
  });

  it("a failed live read returns the proposal to pending, rejectable again, and still confirmable", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    let release!: () => void;
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => (entered = r));
    s.fake.defer = { tool: "get_scheduled_workouts", entered, until: new Promise<void>((r) => (release = r)) };
    s.fake.overrides = { get_scheduled_workouts: "not a schedule" };
    const pending = s.confirm(p.id);
    await inFlight;
    release();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(getProposal(s.t.handle.db, p.id)?.status).toBe("pending");
    expect(s.t.handle.db.select().from(proposalTable).all()[0]?.claimToken).toBeNull();
    expect(actions(s)).toContain("proposal.confirm_blocked");
    expect(s.t.writer.calls).toHaveLength(0);
    s.fake.overrides = {};
    expect((await s.confirm(p.id)).status).toBe(200);
    expect(s.t.writer.calls).toHaveLength(1);
  });

  it("a rejected proposal can never reach the writer, and reject after the claim is released works", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    expect((await s.reject(p.id)).status).toBe(200);
    const res = await s.confirm(p.id);
    expect(res.status).toBe(409);
    expect(s.t.writer.calls).toHaveLength(0);
    expect(s.t.writer.connects()).toBe(0);
    expect(actions(s)).toContain("proposal.rejected");
    expect(actions(s)).not.toContain("proposal.applied");
  });

  it("stale detection still works under a claim and releases it", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    s.fake.overrides = { get_scheduled_workouts: s.liveWorkout("2026-11-09") };
    const w = await confirmWaiting(s, p.id);
    expect((await s.reject(p.id)).status).toBe(409);
    w.release();
    expect((await w.pending).status).toBe(409);
    const row = s.t.handle.db.select().from(proposalTable).all()[0];
    expect(row?.status).toBe("stale");
    expect(row?.claimToken).toBeNull();
    expect(s.t.writer.calls).toHaveLength(0);
    expect(actions(s)).toContain("proposal.stale");
  });

  it("the executor refuses to write when the claim is not held, before and after connecting", async () => {
    const s = await setup({ writes: true });
    const p = garminProposalSchema.parse(await s.created(await s.move("2026-11-10")));
    const { beginConfirmation, endConfirmation } = await import("../src/modules/proposals/confirmations.js");
    beginConfirmation(p.id);
    try {
      await expect(executeGarminProposal(p, { writesEnabled: true, getWriter: s.t.writer.factory, holdsClaim: () => false })).rejects.toThrow(/no longer holds/);
      expect(s.t.writer.connects()).toBe(0);
      let checks = 0;
      await expect(executeGarminProposal(p, { writesEnabled: true, getWriter: s.t.writer.factory, holdsClaim: () => ++checks < 2 })).rejects.toThrow(/no longer holds/);
      expect(s.t.writer.calls).toHaveLength(0);
    } finally {
      endConfirmation(p.id);
    }
  });

  it("claims left by a crashed process are cleared at boot", async () => {
    const s = await setup({ writes: true });
    const p = await s.created(await s.move("2026-11-10"));
    const { claimProposal, clearStaleClaims } = await import("../src/modules/proposals/engine.js");
    expect(claimProposal(s.t.handle.db, p.id, s.now())).not.toBeNull();
    expect(claimProposal(s.t.handle.db, p.id, s.now())).toBeNull();
    expect((await s.reject(p.id)).status).toBe(409);
    expect(clearStaleClaims(s.t.handle.db)).toBe(1);
    expect((await s.reject(p.id)).status).toBe(200);
  });
});
