import { describe, expect, it } from "vitest";
import { formatClock, formatDate, formatDateTime, formatDayDate, formatDurationMin, formatKm, formatRaceTime, humanise, formatTime, formatRaceKm } from "./format";

describe("format", () => {
  it("formats dates dd/mm/yyyy with a weekday", () => {
    expect(formatDate("2026-11-08")).toBe("08/11/2026");
    expect(formatDayDate("2026-11-08")).toBe("Sun 08/11/2026");
  });
  it("shows Europe/London times, including British Summer Time", () => {
    expect(formatTime("2026-11-07T12:30:00Z")).toBe("12:30");
    expect(formatTime("2026-07-07T12:30:00Z")).toBe("13:30");
    expect(formatDateTime("2026-11-07T12:30:00Z")).toBe("07/11/2026 12:30");
  });
  it("formats durations, distances and clocks", () => {
    expect(formatDurationMin(6600)).toBe("110 min");
    expect(formatKm(7864.2)).toBe("7.9 km");
    expect(formatClock(3000)).toBe("50:00");
    expect(formatClock(7106)).toBe("1:58:26");
  });
  it("formats race distances without padding", () => {
    expect([10000, 21100, 42195, 21097].map(formatRaceKm)).toEqual(["10 km", "21.1 km", "42.195 km", "21.097 km"]);
  });
  it("humanises Garmin enums", () => {
    expect(humanise("RECOVERY_IN_PROGRESS")).toBe("Recovery in progress");
    expect(humanise("PRODUCTIVE_6")).toBe("Productive");
  });
  it("keeps a race in its own time zone", () => {
    expect(formatRaceTime("06:30", "Australia/Sydney")).toBe("06:30 Australia/Sydney");
    expect(formatRaceTime(null, null)).toBe("start time unknown");
  });
});
