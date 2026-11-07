import { useQuery, useQueryClient } from "@tanstack/react-query";
import { loginRequestSchema, sessionResponseSchema, type SessionResponse } from "@pulse/shared";
import { z } from "zod";
import { api, setCsrfToken } from "./api";

export const SESSION_KEY = ["session"] as const;

export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      const s = await api("/api/auth/session", sessionResponseSchema);
      setCsrfToken(s.csrfToken);
      return s;
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function useAuthActions() {
  const qc = useQueryClient();
  return {
    async login(password: string) {
      const body = loginRequestSchema.parse({ password });
      const s = await api("/api/auth/login", sessionResponseSchema, { method: "POST", body });
      setCsrfToken(s.csrfToken);
      qc.setQueryData<SessionResponse>(SESSION_KEY, s);
    },
    async logout() {
      await api("/api/auth/logout", z.object({ ok: z.boolean() }), { method: "POST" });
      setCsrfToken(null);
      // Saved API responses are personal data. Remove them from this device on sign out.
      await globalThis.caches?.delete("pulse-api").catch(() => false);
      qc.setQueryData<SessionResponse>(SESSION_KEY, { authenticated: false, csrfToken: null });
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
    },
  };
}
