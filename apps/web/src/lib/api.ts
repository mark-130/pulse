import { APP_NAME } from "@pulse/shared";
import type { z } from "zod";

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
  if (!res.ok) {
    const msg = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : "Something went wrong.";
    throw new ApiRequestError(msg, res.status);
  }
  return schema.parse(data);
}
