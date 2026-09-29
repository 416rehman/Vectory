import { describe, expect, it } from "vitest";
import {
  previousSummary,
  readDeviceCa,
  shortFingerprint,
  type PreviousDeviceCa,
} from "./deviceCaStatus";

const current = {
  sha256: "a".repeat(64),
  subject: "CN=Vectory device CA 2026-09-29 1a2b3c4d",
  not_before: "2026-09-29T00:00:00Z",
  not_after: "2036-09-27T00:00:00Z",
};
const previous = (patch: Partial<PreviousDeviceCa> = {}): PreviousDeviceCa => ({
  sha256: "b".repeat(64),
  subject: "CN=Vectory device CA",
  not_before: "2026-01-01T00:00:00Z",
  not_after: "2035-12-30T00:00:00Z",
  devices: 2,
  device_names: ["edge-01", "edge-02"],
  last_expires_at: "2026-10-29T12:00:00Z",
  ...patch,
});

describe("device CA status", () => {
  it("reads the settings field and refuses a malformed one", () => {
    expect(readDeviceCa({ current, previous: null })).toEqual({
      current,
      previous: null,
    });
    expect(
      readDeviceCa({ current, previous: previous() })?.previous?.devices,
    ).toBe(2);
    for (const bad of [
      undefined,
      null,
      {},
      { current: { ...current, sha256: "short" }, previous: null },
      { current, previous: { ...previous(), devices: "2" } },
      { current, previous: { ...previous(), device_names: null } },
    ])
      expect(readDeviceCa(bad)).toBeNull();
    // An older server without the field: the card isn't shown.
    expect(readDeviceCa(undefined)).toBeNull();
  });

  it("shortens a fingerprint to both ends", () => {
    expect(shortFingerprint("0123456789abcdef".repeat(4))).toBe(
      "01234567…89abcdef",
    );
  });

  it("says who still uses the previous authority and what to do", () => {
    expect(previousSummary(previous({ devices: 0, device_names: [] }))).toBe(
      "No device uses it anymore. Retire it with vectory-admin retire-device-ca --apply on the stopped server.",
    );
    expect(
      previousSummary(
        previous({
          devices: 1,
          device_names: ["edge-01"],
          last_expires_at: null,
        }),
      ),
    ).toBe("1 device still uses it: edge-01.");
    expect(previousSummary(previous())).toMatch(
      /^2 devices still use it: edge-01 and edge-02\. Each moves when it renews; the last of their certificates expires /,
    );
    expect(
      previousSummary(
        previous({ devices: 25, device_names: ["a", "b", "c", "d"] }),
      ),
    ).toMatch(/^25 devices still use it: a, b, c and 22 more\./);
  });
});
