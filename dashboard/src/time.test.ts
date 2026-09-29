import { describe, expect, it } from "vitest";
import { ago } from "./api";
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

  it("names a missing time however the caller needs it", () => {
    expect(relativeTime(undefined, now)).toBe("never");
    expect(relativeTime(null, now, "Never")).toBe("Never");
    expect(relativeTime("not a date", now, "Never connected")).toBe(
      "Never connected",
    );
    // Account pages read as before: minutes and hours, days beyond that.
    expect(relativeTime("2026-09-29T02:05:00.000Z", now)).toBe("5m ago");
    expect(relativeTime("2026-09-26T02:10:00.000Z", now)).toBe("3d ago");
  });

  it("keeps the older ago helper on the same format", () => {
    expect(ago(null)).toBe("Never connected");
    expect(ago(new Date().toISOString())).toBe("Just now");
    expect(ago(new Date(Date.now() - 4 * 60_000).toISOString())).toBe("4m ago");
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
