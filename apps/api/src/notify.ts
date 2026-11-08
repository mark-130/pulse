import { APP_NAME } from "@pulse/shared";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

export type Notifier = (message: string) => Promise<void>;

export const NTFY_TIMEOUT_MS = 5000;

/** ntfy is optional: it is on only when NTFY_TOKEN is set. */
export function ntfyEnabled(config: Pick<Config, "NTFY_TOKEN">): boolean {
  return config.NTFY_TOKEN.trim() !== "";
}

/**
 * ntfy: JSON POST to the root URL. Messages never carry confirm actions or secrets.
 * Without a token it does nothing and makes no call. A failed send is logged once as a warning
 * (no token, no URL) and never throws, so it cannot fail or hold up a sync.
 */
export function createNotifier(config: Pick<Config, "NTFY_URL" | "NTFY_TOPIC" | "NTFY_TOKEN">, log: Logger, fetchImpl: typeof fetch = fetch): Notifier {
  if (!ntfyEnabled(config)) return async () => undefined;
  return async (message) => {
    try {
      const res = await fetchImpl(config.NTFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.NTFY_TOKEN}` },
        body: JSON.stringify({ topic: config.NTFY_TOPIC, title: APP_NAME, message, tags: ["warning"] }),
        signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
      });
      if (!res.ok) log.warn({ status: res.status }, "ntfy send failed");
    } catch (err) {
      log.warn({ err: sanitiseError(err) }, "ntfy send failed");
    }
  };
}

/** Strips URLs and token-like values so errors are safe to store, show and send. */
export function sanitiseError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(token|key|secret|password)=\S+/gi, "$1=[redacted]")
    .slice(0, 300);
}
