import { basename } from "node:path";
import { APP_IMAGE, UPDATE_OFF_TEXT, type AppUpdateProposal } from "@pulse/shared";
import { sanitiseError } from "../../../notify.js";
import { isBeingConfirmed } from "../confirmations.js";

/**
 * The app update executor. It asks Watchtower to pull and restart this app, and does nothing else.
 * Imported only by the confirm route, like every executor. The image is fixed here, never taken from a request.
 * Order: requested, backup, backup taken, called, then the call. The old process is stopped by Watchtower while the
 * request is open, so the "called" step is recorded before the call is made.
 */
export const WATCHTOWER_CALL_TIMEOUT_MS = 20_000;

export interface AppUpdateHooks {
  requested(): void;
  backupTaken(file: string): void;
  /** Called once, just before the request. The confirm route saves the proposal as applied here. */
  calling(): void;
}

export interface AppUpdateDeps {
  watchtowerUrl: string;
  token: string;
  /** Takes the same VACUUM INTO backup as the nightly job. Returns the file path. */
  backup: () => string;
  fetchFn: typeof fetch;
  hooks: AppUpdateHooks;
  timeoutMs?: number;
}

export interface AppUpdateOutcome {
  backup: string;
  /** Null when the connection dropped, which is expected while Watchtower restarts this container. */
  watchtowerStatus: number | null;
  message: string;
}

/** Thrown for a failure that happened before the app could be restarted. Safe to show. */
export class AppUpdateError extends Error {
  /** True once Watchtower was called, so the proposal was already saved as applied. */
  constructor(
    message: string,
    readonly afterCall = false,
  ) {
    super(message);
  }
}

const NOT_REACHED = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

function causeCode(err: unknown): string {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : "";
  return code;
}

export function watchtowerUpdateUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/v1/update?image=${encodeURIComponent(APP_IMAGE)}`;
}

export async function executeAppUpdate(p: AppUpdateProposal, deps: AppUpdateDeps): Promise<AppUpdateOutcome> {
  if (!isBeingConfirmed(p.id)) throw new Error("Refusing to run: this proposal is not being confirmed.");
  if (p.status !== "pending") throw new Error("Refusing to run: the proposal is not pending.");
  if (deps.token.trim() === "") throw new AppUpdateError(UPDATE_OFF_TEXT);

  deps.hooks.requested();
  let file: string;
  try {
    file = basename(deps.backup());
  } catch (err) {
    throw new AppUpdateError(`The backup failed, so nothing was sent to Watchtower. ${sanitiseError(err)}`);
  }
  deps.hooks.backupTaken(file);

  deps.hooks.calling();
  let res: Response;
  try {
    res = await deps.fetchFn(watchtowerUpdateUrl(deps.watchtowerUrl), {
      method: "GET",
      headers: { authorization: `Bearer ${deps.token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? WATCHTOWER_CALL_TIMEOUT_MS),
    });
  } catch (err) {
    const code = causeCode(err);
    if (NOT_REACHED.has(code)) throw new AppUpdateError("Could not reach Watchtower. Check WATCHTOWER_URL and that it shares a Docker network with this app. Nothing was updated.", true);
    // The request was accepted and the connection dropped, or Watchtower is still pulling. The build change decides the outcome.
    return { backup: file, watchtowerStatus: null, message: "Watchtower was called and the connection dropped, which is expected while the app restarts." };
  }
  if (res.status === 401 || res.status === 403) throw new AppUpdateError(`Watchtower refused the token (${res.status}). Check WATCHTOWER_TOKEN matches WATCHTOWER_HTTP_API_TOKEN.`, true);
  if (res.status === 404) throw new AppUpdateError("Watchtower has no update endpoint (404). Set WATCHTOWER_HTTP_API_UPDATE=true on Watchtower.", true);
  if (res.status === 429) throw new AppUpdateError("Watchtower is already running an update (429). Try again in a minute.", true);
  if (!res.ok) throw new AppUpdateError(`Watchtower answered ${res.status}. Nothing was updated.`, true);
  return { backup: file, watchtowerStatus: res.status, message: "Watchtower accepted the request." };
}
