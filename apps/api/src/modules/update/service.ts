import { shortSha, type BuildInfo, type UpdateCheck } from "@pulse/shared";
import { fetchLatestImage, RegistryError } from "./registry.js";

export const CHECK_CACHE_MS = 10 * 60_000;
/** A failed check is remembered briefly so a broken registry is not hammered by repeated taps. */
export const CHECK_ERROR_CACHE_MS = 60_000;

export interface UpdateService {
  build: BuildInfo;
  /** False without WATCHTOWER_TOKEN. */
  enabled: boolean;
  /** The cached check if still fresh, otherwise null. */
  cached(): UpdateCheck | null;
  /** Reads GHCR unless a fresh result is cached. Never throws. */
  check(): Promise<UpdateCheck>;
}

export function createUpdateService(opts: { build: BuildInfo; enabled: boolean; fetchFn?: typeof fetch; now?: () => Date }): UpdateService {
  const clock = opts.now ?? (() => new Date());
  let last: { check: UpdateCheck; until: number } | null = null;
  let inflight: Promise<UpdateCheck> | null = null;

  const fresh = () => (last && clock().getTime() < last.until ? last.check : null);

  async function run(): Promise<UpdateCheck> {
    const checkedAt = clock().toISOString();
    let check: UpdateCheck;
    try {
      const latest = await fetchLatestImage(opts.fetchFn);
      const l = { sha: latest.sha, shortSha: shortSha(latest.sha), builtAt: latest.builtAt };
      if (opts.build.sha === "dev") {
        check = { state: "error", checkedAt, latest: l, reason: "This build was not made by CI, so it has no commit to compare with." };
      } else {
        const same = latest.sha.startsWith(opts.build.sha) || opts.build.sha.startsWith(latest.sha);
        check = { state: same ? "up_to_date" : "available", checkedAt, latest: l, reason: null };
      }
    } catch (err) {
      check = { state: "error", checkedAt, latest: null, reason: err instanceof RegistryError ? err.message : "The check failed unexpectedly." };
    }
    last = { check, until: clock().getTime() + (check.state === "error" ? CHECK_ERROR_CACHE_MS : CHECK_CACHE_MS) };
    return check;
  }

  return {
    build: opts.build,
    enabled: opts.enabled,
    cached: fresh,
    check: async () => {
      const hit = fresh();
      if (hit) return hit;
      inflight ??= run().finally(() => void (inflight = null));
      return inflight;
    },
  };
}
