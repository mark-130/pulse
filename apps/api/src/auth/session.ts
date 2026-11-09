import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const SESSION_COOKIE = "pulse_session";
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

/** v is the session epoch the token was issued under (D56). A token whose epoch is not the current one is revoked. */
const payloadSchema = z.object({ csrf: z.string(), exp: z.number(), v: z.number().int() });
export type SessionPayload = z.infer<typeof payloadSchema>;

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createSessionToken(secret: string, epoch: number, now = Date.now()): { token: string; payload: SessionPayload } {
  const payload: SessionPayload = { csrf: randomBytes(24).toString("base64url"), exp: now + SESSION_MAX_AGE_S * 1000, v: epoch };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${body}.${sign(body, secret)}`, payload };
}

export function readSessionToken(token: string | undefined, secret: string, epoch: number, now = Date.now()): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = payloadSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    return payload.exp > now && payload.v === epoch ? payload : null;
  } catch {
    return null;
  }
}

export function csrfMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
