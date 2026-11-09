import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { settings } from "../db/schema.js";

/**
 * The session epoch (D56). Every session token carries the epoch it was issued under, and a token is only valid while
 * that is still the current epoch. Logging out bumps it, so all sessions on all devices stop working at once, server side.
 */
export interface SessionEpoch {
  current(): number;
  /** Revokes every session issued so far. Returns the new epoch. */
  revokeAll(): number;
}

const KEY = "session_epoch";

export function dbSessionEpoch(db: Db): SessionEpoch {
  const read = (): number => {
    const v = db.select().from(settings).where(eq(settings.key, KEY)).get()?.value;
    return typeof v === "number" && Number.isInteger(v) ? v : 0;
  };
  return {
    current: read,
    revokeAll() {
      // One statement, so two logouts at once cannot both write the same number.
      const next = db.transaction((tx) => {
        const cur = tx.select().from(settings).where(eq(settings.key, KEY)).get()?.value;
        const n = (typeof cur === "number" && Number.isInteger(cur) ? cur : 0) + 1;
        tx.insert(settings).values({ key: KEY, value: n }).onConflictDoUpdate({ target: settings.key, set: { value: n } }).run();
        return n;
      });
      return next;
    },
  };
}

/** For tests and callers with no database. Lives only as long as the process. */
export function memorySessionEpoch(): SessionEpoch {
  let n = 0;
  return { current: () => n, revokeAll: () => ++n };
}
