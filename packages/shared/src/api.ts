import { z } from "zod";

export const loginRequestSchema = z.object({ password: z.string().min(1).max(512) });
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionResponseSchema = z.object({
  authenticated: z.boolean(),
  csrfToken: z.string().nullable(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof apiErrorSchema>;
