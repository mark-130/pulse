import { sanitiseError } from "../../notify.js";

const MAX_DETAIL = 150;

/** A short sanitised line from a provider error. Never the key, a URL or a request body. */
export const shortDetail = (err: unknown, secret?: string): string => {
  const raw = sanitiseError(err);
  return (secret ? raw.replaceAll(secret, "[redacted]") : raw).slice(0, MAX_DETAIL);
};
