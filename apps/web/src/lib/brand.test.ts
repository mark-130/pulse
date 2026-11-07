import { APP_NAME, APP_SHORT_NAME } from "@pulse/shared";
import { describe, expect, it } from "vitest";

describe("brand", () => {
  it("uses the exact display name", () => {
    expect(APP_NAME).toBe("NGtive Split");
    expect(APP_SHORT_NAME).toBe("NGtive Split");
  });
});
