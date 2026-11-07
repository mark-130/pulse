import { APP_NAME } from "@pulse/shared";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

export type Notifier = (message: string) => Promise<void>;

/** ntfy: JSON POST to the root URL. Messages never carry confirm actions or secrets. */
export function createNotifier(config: Pick<Config, "NTFY_URL" | "NTFY_TOPIC" | "NTFY_TOKEN">, log: Logger, fetchImpl: typeof fetch = fetch): Notifier {
  return async (message) => {
    try {
      const res = await fetchImpl(config.NTFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json", ...(config.NTFY_TOKEN ? { authorization: `Bearer ${config.NTFY_TOKEN}` } : {}) },
        body: JSON.stringify({ topic: config.NTFY_TOPIC, title: APP_NAME, message, tags: ["warning"] }),
      });
      if (!res.ok) log.warn({ status: res.status }, "ntfy rejected message");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : "unknown" }, "ntfy unreachable");
    }
  };
}

/** Strips URLs and token-like values so errors are safe to store, show and send. */
export function sanitiseError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/(token|key|secret|password)=\S+/gi, "$1=[redacted]")
    .slice(0, 300);
}
