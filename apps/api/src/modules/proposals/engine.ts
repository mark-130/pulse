import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { APP_IMAGE, PROPOSAL_EXPIRY_HOURS, SCHEDULE_AHEAD_DAYS, isGarminProposal, proposalSchema, type BuildState, type GarminProposal, type Proposal, type WorkoutState } from "@pulse/shared";
import { addDays, londonDate } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { proposal as proposalTable, workout } from "../../db/schema.js";
import { appendAudit, canonicalHash } from "./audit.js";

/**
 * The proposal engine. createProposal is the only way a proposal comes to exist, and nothing in this file can
 * write to an outside system: executors are not imported here (see eslint.config.js and the import test).
 */

export class ProposalError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** What state_hash covers: the fields a change depends on. If Garmin differs at confirm time the proposal is stale. */
export function stateHashOf(state: WorkoutState | BuildState | null): string {
  return canonicalHash(state);
}

export function workoutState(row: typeof workout.$inferSelect): WorkoutState {
  return { scheduledId: row.garminScheduledId, name: row.name, date: row.date, durationS: row.durationS, completed: row.completed };
}

/** The audit target of a proposal. */
export function targetOf(p: Proposal): string {
  return isGarminProposal(p) ? `${p.kind}:${p.before.scheduledId}` : "app.update:app";
}

export interface NewProposal {
  kind: GarminProposal["kind"];
  createdBy: "user" | "ai";
  rationale: string | null;
  before: WorkoutState;
  after: WorkoutState | null;
  now: Date;
}

const PENDING_BLOCK = "A change for this workout is already waiting. Confirm or reject it first.";

/**
 * Inserts a pending proposal and returns it. Writes nothing outside our own database.
 * Idempotent by scheduled workout: the same change again returns the existing pending proposal,
 * and a different change for the same workout is refused until the first is decided.
 */
export function createProposal(db: Db, input: NewProposal): Proposal {
  expireDue(db, input.now);
  const sameWorkout = listPending(db).filter(isGarminProposal).filter((p) => p.before.scheduledId === input.before.scheduledId);
  for (const p of sameWorkout) {
    const sameChange = p.kind === input.kind && JSON.stringify(p.after) === JSON.stringify(input.after);
    if (sameChange) return p;
  }
  if (sameWorkout.length > 0) throw new ProposalError(PENDING_BLOCK, 409);

  const id = randomUUID();
  const nowIso = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + PROPOSAL_EXPIRY_HOURS * 3_600_000).toISOString();
  db.transaction(() => {
    db.insert(proposalTable)
      .values({
        id,
        kind: input.kind,
        targetSystem: "garmin",
        payload: { scheduledId: input.before.scheduledId, date: input.after?.date ?? null },
        before: input.before,
        after: input.after,
        rationale: input.rationale,
        createdBy: input.createdBy,
        stateHash: stateHashOf(input.before),
        status: "pending",
        createdAt: nowIso,
        expiresAt,
      })
      .run();
    appendAudit(db, { ts: nowIso, actor: input.createdBy, action: "proposal.created", target: `${input.kind}:${input.before.scheduledId}`, payload: { id, before: input.before, after: input.after }, result: "pending" });
  });
  return getProposal(db, id) as Proposal;
}

function toProposal(row: typeof proposalTable.$inferSelect): Proposal {
  return proposalSchema.parse({
    id: row.id,
    kind: row.kind,
    targetSystem: row.targetSystem,
    status: row.status,
    createdBy: row.createdBy,
    rationale: row.rationale,
    before: row.before,
    after: row.after ?? null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    result: row.result ?? null,
  });
}

export function getProposal(db: Db, id: string): Proposal | null {
  const row = db.select().from(proposalTable).where(eq(proposalTable.id, id)).get();
  return row ? toProposal(row) : null;
}

export function getStateHash(db: Db, id: string): string | null {
  return db.select({ h: proposalTable.stateHash }).from(proposalTable).where(eq(proposalTable.id, id)).get()?.h ?? null;
}

export function listPending(db: Db): Proposal[] {
  return db.select().from(proposalTable).where(eq(proposalTable.status, "pending")).orderBy(proposalTable.createdAt).all().map(toProposal);
}

export function listHistory(db: Db, limit = 50): Proposal[] {
  return db
    .select()
    .from(proposalTable)
    .where(inArray(proposalTable.status, ["applied", "rejected", "expired", "stale", "failed"]))
    .orderBy(desc(proposalTable.createdAt))
    .limit(limit)
    .all()
    .map(toProposal);
}

export function countPending(db: Db, now: Date): number {
  expireDue(db, now);
  return listPending(db).length;
}

/** Marks pending proposals past their expiry as expired, with an audit entry each. Safe to call often. */
export function expireDue(db: Db, now: Date): number {
  const nowIso = now.toISOString();
  let n = 0;
  for (const p of listPending(db)) {
    if (p.expiresAt > nowIso) continue;
    // A proposal that a confirmation has claimed is never expired underneath it (D63).
    const res = db.update(proposalTable).set({ status: "expired", decidedAt: nowIso }).where(and(eq(proposalTable.id, p.id), eq(proposalTable.status, "pending"), isNull(proposalTable.claimToken))).run();
    if (res.changes) {
      appendAudit(db, { ts: nowIso, actor: "system", action: "proposal.expired", target: targetOf(p), payload: { id: p.id }, result: "expired" });
      n++;
    }
  }
  return n;
}

export function rejectProposal(db: Db, id: string, now: Date): Proposal {
  expireDue(db, now);
  const p = getProposal(db, id);
  if (!p) throw new ProposalError("Unknown proposal.", 404);
  if (p.status !== "pending") throw new ProposalError(`This proposal is already ${p.status}.`, 409);
  const nowIso = now.toISOString();
  // One atomic update decides it: it only matches a pending proposal nobody is confirming, and the audit entry
  // is written only when it did, so the table and the audit trail cannot disagree (D63).
  db.transaction(() => {
    const res = db.update(proposalTable).set({ status: "rejected", decidedAt: nowIso }).where(and(eq(proposalTable.id, id), eq(proposalTable.status, "pending"), isNull(proposalTable.claimToken))).run();
    if (!res.changes) throw new ProposalError(isClaimed(db, id) ? CLAIMED_TEXT : "This proposal is no longer pending.", 409);
    appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.rejected", target: targetOf(p), payload: { id }, result: "rejected" });
  });
  return getProposal(db, id) as Proposal;
}

export const CLAIMED_TEXT = "This proposal is being confirmed right now. It cannot be rejected until that finishes.";

function isClaimed(db: Db, id: string): boolean {
  return db.select({ t: proposalTable.claimToken }).from(proposalTable).where(and(eq(proposalTable.id, id), eq(proposalTable.status, "pending"), isNotNull(proposalTable.claimToken))).get() !== undefined;
}

/**
 * Atomically claims a pending, unexpired, unclaimed proposal for one confirmation. Returns the claim token, or null when
 * someone else holds it or it is no longer pending. Done before any outside call is awaited (D63).
 */
export function claimProposal(db: Db, id: string, now: Date): string | null {
  const token = randomUUID();
  const nowIso = now.toISOString();
  const res = db
    .update(proposalTable)
    .set({ claimToken: token, claimedAt: nowIso })
    .where(and(eq(proposalTable.id, id), eq(proposalTable.status, "pending"), isNull(proposalTable.claimToken), gt(proposalTable.expiresAt, nowIso)))
    .run();
  return res.changes === 1 ? token : null;
}

/** True only while this token still owns a pending proposal. Checked immediately before every outside write. */
export function holdsClaim(db: Db, id: string, token: string): boolean {
  return db.select({ id: proposalTable.id }).from(proposalTable).where(and(eq(proposalTable.id, id), eq(proposalTable.status, "pending"), eq(proposalTable.claimToken, token))).get() !== undefined;
}

/** Gives a claim back without deciding anything, so the proposal is pending again. No-op if the token is not the holder. */
export function releaseClaim(db: Db, id: string, token: string): boolean {
  return db.update(proposalTable).set({ claimToken: null, claimedAt: null }).where(and(eq(proposalTable.id, id), eq(proposalTable.status, "pending"), eq(proposalTable.claimToken, token))).run().changes === 1;
}

/** Boot: no confirmation can be running in a new process, so any claim left by a crash is dropped. Returns how many. */
export function clearStaleClaims(db: Db): number {
  return db.update(proposalTable).set({ claimToken: null, claimedAt: null }).where(isNotNull(proposalTable.claimToken)).run().changes;
}

/** Manual creators. Workout content is never edited, only the date. They only create proposals. */
export interface Creator {
  createdBy: "user" | "ai";
  rationale: string | null;
}
const USER: Creator = { createdBy: "user", rationale: null };

export function proposeReschedule(db: Db, scheduledId: string, date: string, now: Date, by: Creator = USER): Proposal {
  const row = db.select().from(workout).where(eq(workout.garminScheduledId, scheduledId)).get();
  if (!row) throw new ProposalError("Unknown workout.", 404);
  const today = londonDate(now);
  if (row.completed) throw new ProposalError("A completed workout cannot be moved.", 400);
  if (row.date < today) throw new ProposalError("A past workout cannot be moved.", 400);
  if (date < today || date > addDays(today, SCHEDULE_AHEAD_DAYS)) throw new ProposalError(`Pick a date from today up to ${SCHEDULE_AHEAD_DAYS} days ahead.`, 400);
  if (date === row.date) throw new ProposalError("The workout is already on that date.", 400);
  const before = workoutState(row);
  return createProposal(db, { kind: "garmin.reschedule", createdBy: by.createdBy, rationale: by.rationale, before, after: { ...before, date }, now });
}

export function proposeUnschedule(db: Db, scheduledId: string, now: Date, by: Creator = USER): Proposal {
  const row = db.select().from(workout).where(eq(workout.garminScheduledId, scheduledId)).get();
  if (!row) throw new ProposalError("Unknown workout.", 404);
  if (row.completed) throw new ProposalError("A completed workout cannot be removed.", 400);
  if (row.date < londonDate(now)) throw new ProposalError("A past workout cannot be removed.", 400);
  const before = workoutState(row);
  return createProposal(db, { kind: "garmin.unschedule", createdBy: by.createdBy, rationale: by.rationale, before, after: null, now });
}

/**
 * Creates the app.update proposal. Idempotent: a pending one is returned as it is. The new build comes from the last
 * update check and is null when there is none, because a failed check must not block updating (D39).
 */
export function proposeAppUpdate(db: Db, input: { running: BuildState; latest: BuildState | null; now: Date }): Proposal {
  expireDue(db, input.now);
  const existing = listPending(db).find((p) => p.kind === "app.update");
  if (existing) return existing;
  const id = randomUUID();
  const nowIso = input.now.toISOString();
  db.transaction(() => {
    db.insert(proposalTable)
      .values({
        id,
        kind: "app.update",
        targetSystem: "app",
        payload: { image: APP_IMAGE },
        before: input.running,
        after: input.latest,
        rationale: null,
        createdBy: "user",
        stateHash: stateHashOf(input.running),
        status: "pending",
        createdAt: nowIso,
        expiresAt: new Date(input.now.getTime() + PROPOSAL_EXPIRY_HOURS * 3_600_000).toISOString(),
      })
      .run();
    appendAudit(db, { ts: nowIso, actor: "user", action: "proposal.created", target: "app.update:app", payload: { id, before: input.running, after: input.latest }, result: "pending" });
  });
  return getProposal(db, id) as Proposal;
}
