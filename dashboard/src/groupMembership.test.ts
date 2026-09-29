import { describe, expect, it } from "vitest";
import type { GroupMembershipPreview } from "./api";
import { membershipSentence } from "./groupMembership";

type Entry = GroupMembershipPreview["devices"][number];
const state = (version: number | null, name = "Web access logs") => ({
  assignment_id: "a",
  assignment_name: null,
  version_id: version ? `v${version}` : null,
  configuration_name: version ? name : null,
  version_number: version,
  generation: 1,
  policy: version
    ? null
    : { heartbeat_seconds: 60, sync_paused: false, telemetry_enabled: true },
});
const unchanged = { changed: false, before: null, after: null, pending: null };

describe("membership change sentences", () => {
  it("says what adding a device deploys", () => {
    const entry: Entry = {
      device_id: "d",
      device_name: "web-01",
      change: "added",
      configuration: {
        changed: true,
        before: null,
        after: state(3),
        pending: null,
      },
      policy: {
        changed: true,
        before: null,
        after: state(null),
        pending: null,
      },
    };
    expect(membershipSentence(entry, "web-01")).toBe(
      "Adding web-01 deploys Web access logs v3 and applies agent settings (sync on · check-ins every 1 min).",
    );
  });
  it("says what removing a device leaves running", () => {
    const entry: Entry = {
      device_id: "d",
      device_name: "edge-02",
      change: "removed",
      configuration: {
        changed: true,
        before: state(2),
        after: null,
        pending: null,
      },
      policy: unchanged,
    };
    expect(membershipSentence(entry, "edge-02")).toBe(
      "Removing edge-02 stops managing its pipeline; it keeps running Web access logs v2.",
    );
    expect(
      membershipSentence({ ...entry, configuration: unchanged }, "edge-02"),
    ).toBe("Removing edge-02 changes nothing on it.");
  });
});
