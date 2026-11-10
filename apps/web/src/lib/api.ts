import { APP_NAME, aiFailureSchema, type AiFailureInfo } from "@pulse/shared";
import type { z } from "zod";

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

/**
 * Called once for any 401 from a protected request, so a revoked session is handled in one place (PULSE-006).
 * The sign in request itself is left out: a wrong password is an ordinary 401.
 */
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn;
};

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Set when an AI call failed: the plain reason for the Details line. */
    readonly failure: AiFailureInfo | null = null,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, schema: z.ZodType<T>, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, credentials: "same-origin", body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  } catch {
    throw new ApiRequestError(`Cannot reach ${APP_NAME}. Check your connection.`, 0);
  }
  const data: unknown = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/auth/login")) onUnauthorized?.();
  if (!res.ok) {
    const msg = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : "Something went wrong.";
    const failure = typeof data === "object" && data !== null && "failure" in data ? aiFailureSchema.safeParse(data.failure) : null;
    throw new ApiRequestError(msg, res.status, failure?.success ? failure.data : null);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    // Never show the validation error: it is raw JSON. The usual cause is a page from before an update talking to the updated
    // app, which a reload fixes. The detail stays in the browser console, with no values in it.
    console.warn(`${method} ${path.split("?")[0]}: the answer did not match what this page expects`, parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(answer)"}: ${i.message}`));
    throw new ApiRequestError("This page is out of date with the app. Reload it to update.", res.status);
  }
  return parsed.data;
}
