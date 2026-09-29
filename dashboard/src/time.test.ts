import { describe, expect, it } from "vitest";
import { duration, exactUtc, relativeTime, shortLocal } from "./time";

const now = Date.parse("2026-09-29T02:10:00.000Z");

describe("time formatting", () => {
  it("describes recent moments compactly and never invents a time", () => {
    expect(relativeTime("2026-09-29T02:09:58.000Z", now)).toBe("just now");
    expect(relativeTime("2026-09-29T02:09:48.000Z", now)).toBe("12s ago");
    expect(relativeTime("2026-09-29T02:06:00.000Z", now)).toBe("4m ago");
    expect(relativeTime("2026-09-28T23:10:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-26T02:10:00.000Z", now)).toBe("3d ago");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("not a date", now)).toBe("never");
    // Clock skew never produces "in the future" wording.
    expect(relativeTime("2026-09-29T02:11:00.000Z", now)).toBe("just now");
  });

  it("formats durations for rollout and pause ages", () => {
    expect(duration(45_000)).toBe("45s");
    expect(duration(12 * 60_000)).toBe("12m");
    expect(duration(3 * 3_600_000 + 5 * 60_000)).toBe("3h 5m");
    expect(duration(2 * 86_400_000)).toBe("2d");
    expect(duration(-5)).toBe("0s");
  });

  it("shows exact audit times with seconds and an explicit zone", () => {
    expect(exactUtc("2026-09-29T02:01:52.431Z")).toBe(
      "2026-09-29 02:01:52 UTC",
    );
    expect(exactUtc(undefined)).toBe("Unavailable");
    expect(shortLocal("2026-09-29T02:01:52.431Z", "UTC")).toMatch(/02:01:52/);
  });
});
