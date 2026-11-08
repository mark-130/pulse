import { z } from "zod";

/** The image the app updates from. Fixed in code on the server: no request can change it (D39). */
export const APP_IMAGE = "ghcr.io/mark-130/pulse";
export const APP_IMAGE_REPO = "mark-130/pulse";

/** The reconnect watch gives up after this long. */
export const UPDATE_WATCH_TIMEOUT_MS = 180_000;
export const UPDATE_WATCH_INTERVAL_MS = 3_000;
export const UPDATE_OFF_TEXT = "Updating from the app is off. Set WATCHTOWER_TOKEN to turn it on.";
export const UPDATE_RESTART_TEXT = "The app restarts for about 30 seconds. This screen reconnects by itself.";
export const UPDATE_RECONNECTING_TEXT = "Updating. Reconnecting...";
export const UPDATE_TIMEOUT_TEXT = "The update did not complete or no newer image was found. The app is still running the previous build.";

/** What CI stamped into the image. No secrets. "dev" outside CI images. */
export const buildInfoSchema = z.object({
  sha: z.string(),
  /** First 7 characters of sha, or "dev". */
  shortSha: z.string(),
  /** ISO instant, or null for a build that did not come from CI. */
  builtAt: z.string().nullable(),
});
export type BuildInfo = z.infer<typeof buildInfoSchema>;

/** A build as stored on an app.update proposal. The new build is unknown when the check failed. */
export const buildStateSchema = z.object({ sha: z.string().nullable(), builtAt: z.string().nullable() });
export type BuildState = z.infer<typeof buildStateSchema>;

export const updateCheckSchema = z.object({
  state: z.enum(["up_to_date", "available", "error"]),
  checkedAt: z.string(),
  latest: z.object({ sha: z.string(), shortSha: z.string(), builtAt: z.string().nullable() }).nullable(),
  /** Plain reason under Details when state is error. */
  reason: z.string().nullable(),
});
export type UpdateCheck = z.infer<typeof updateCheckSchema>;

export const updateStatusSchema = z.object({
  build: buildInfoSchema,
  /** False without WATCHTOWER_TOKEN. The check still works, Update now does not. */
  updatesEnabled: z.boolean(),
  /** The cached check, or null if none is cached. */
  check: updateCheckSchema.nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const updateCheckResponseSchema = z.object({ check: updateCheckSchema });
export type UpdateCheckResponse = z.infer<typeof updateCheckResponseSchema>;

export const shortSha = (sha: string): string => (/^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : sha || "dev");
