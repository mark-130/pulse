import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { loginRequestSchema, sessionResponseSchema, type SessionResponse } from "@pulse/shared";
import { z } from "zod";
import { api, ApiRequestError, setCsrfToken, setUnauthorizedHandler } from "./api";

export const SESSION_KEY = ["session"] as const;
/** How often an open page asks the server whether its session is still valid (PULSE-006). Focus and reconnect also ask. */
export const SESSION_RECHECK_MS = 5 * 60_000;
/** Cache names that hold personal data. The app shell cache is not private and stays. */
const PRIVATE_CACHE_PREFIX = "pulse-api";
/** A flag, not a credential: the page was signed in last time, so offline it can still show the saved snapshot. */
const HAD_SESSION_KEY = "pulse.hadSession";

const SIGNED_OUT: SessionResponse = { authenticated: false, csrfToken: null };

function flag(value: boolean | null): boolean {
  try {
    if (value === null) return globalThis.localStorage?.getItem(HAD_SESSION_KEY) === "1";
    if (value) globalThis.localStorage?.setItem(HAD_SESSION_KEY, "1");
    else globalThis.localStorage?.removeItem(HAD_SESSION_KEY);
  } catch {
    /* storage can be blocked */
  }
  return value ?? false;
}

/**
 * Forgets everything private on this device: the CSRF token, every cached query except the session itself, queued
 * mutations and the service worker's saved API responses. Safe to call twice.
 */
export async function clearPrivateState(qc: QueryClient): Promise<void> {
  setCsrfToken(null);
  flag(false);
  const private_ = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== SESSION_KEY[0];
  await qc.cancelQueries({ predicate: private_ });
  qc.removeQueries({ predicate: private_ });
  qc.getMutationCache().clear();
  try {
    const store = globalThis.caches;
    if (store) {
      for (const name of await store.keys()) if (name.startsWith(PRIVATE_CACHE_PREFIX)) await store.delete(name);
    }
  } catch {
    /* no Cache API here */
  }
}

/** Marks the session signed out in the query cache and drops all private data. */
export async function endSession(qc: QueryClient): Promise<void> {
  qc.setQueryData<SessionResponse>(SESSION_KEY, SIGNED_OUT);
  await clearPrivateState(qc);
}

/**
 * Asks the server about this browser's session. A signed out answer clears private data. When the server cannot be
 * reached and this page was signed in before, the last saved snapshot stays usable (offline), with no CSRF token until
 * the next successful check.
 */
export async function checkSession(qc: QueryClient): Promise<SessionResponse> {
  let s: SessionResponse;
  try {
    s = await api("/api/auth/session", sessionResponseSchema);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 0 && flag(null)) return { authenticated: true, csrfToken: null };
    throw err;
  }
  if (s.authenticated) {
    setCsrfToken(s.csrfToken);
    flag(true);
  } else {
    await clearPrivateState(qc);
  }
  return s;
}

/** Any 401 from a protected request means the session was revoked or expired: sign out locally. Returns a remover. */
export function installAuthGuard(qc: QueryClient): () => void {
  let running = false;
  setUnauthorizedHandler(() => {
    if (running) return;
    running = true;
    void endSession(qc).finally(() => void (running = false));
  });
  return () => setUnauthorizedHandler(null);
}

export function useSession() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: () => checkSession(qc),
    staleTime: Infinity,
    retry: false,
    refetchInterval: SESSION_RECHECK_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
}

export function useAuthActions() {
  const qc = useQueryClient();
  return {
    async login(password: string) {
      const body = loginRequestSchema.parse({ password });
      const s = await api("/api/auth/login", sessionResponseSchema, { method: "POST", body });
      setCsrfToken(s.csrfToken);
      flag(true);
      qc.setQueryData<SessionResponse>(SESSION_KEY, s);
    },
    async logout() {
      try {
        await api("/api/auth/logout", z.object({ ok: z.boolean() }), { method: "POST" });
      } catch (err) {
        // Already revoked from another device: the goal is reached, so finish signing out here too.
        if (!(err instanceof ApiRequestError && err.status === 401)) throw err;
      }
      await endSession(qc);
    },
  };
}
