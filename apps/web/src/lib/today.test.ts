import { describe, expect, it } from "vitest";
import { dateLine, greetingFor } from "./today";

describe("today helpers", () => {
  it("greets by time of day in Europe/London", () => {
    expect(greetingFor(new Date("2026-11-07T06:30:00Z"))).toBe("Morning, Mark");
    expect(greetingFor(new Date("2026-11-07T14:00:00Z"))).toBe("Afternoon, Mark");
    expect(greetingFor(new Date("2026-11-07T20:00:00Z"))).toBe("Evening, Mark");
    expect(greetingFor(new Date("2026-07-07T11:30:00Z"))).toBe("Afternoon, Mark");
  });
  it("formats the date as dd/mm/yyyy", () => {
    expect(dateLine(new Date("2026-11-07T12:00:00Z"))).toBe("Saturday 07/11/2026");
  });
});
