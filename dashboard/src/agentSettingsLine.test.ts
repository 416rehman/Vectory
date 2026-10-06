import { describe, expect, it } from "vitest";
import { agentSettingsLine } from "./agentSettingsLine";

const now = new Date(2026, 9, 2, 12);
const policy = {
  heartbeat_seconds: 15,
  sync_paused: false,
  telemetry_enabled: true,
};
const assignment = {
  id: "00000000-0000-4000-8000-000000000001",
  priority: 100,
  reason: "snapshot assignment; current resolved policy",
  created_by_name: "Ada",
  created_at: new Date(2026, 8, 29, 9).toISOString(),
  policy_id: null,
  policy_name: null,
};

describe("the Agent settings card's provenance line", () => {
  it("reads who applied the settings and when, from what the server reports", () => {
    expect(
      agentSettingsLine(
        { effective_policy: policy, policy_assignment: assignment },
        now,
      ),
    ).toBe("Check-in 15 s · applied by Ada on Sep 29 (not saved)");
  });

  it("names saved settings, and says nothing about saving when the server doesn't", () => {
    expect(
      agentSettingsLine(
        {
          effective_policy: policy,
          policy_assignment: {
            ...assignment,
            policy_id: "p1",
            policy_name: "Quiet hosts",
          },
        },
        now,
      ),
    ).toBe("Check-in 15 s · applied by Ada on Sep 29 (saved as “Quiet hosts”)");
    const { policy_id: _unreported, ...older } = assignment;
    expect(
      agentSettingsLine(
        { effective_policy: policy, policy_assignment: older },
        now,
      ),
    ).toBe("Check-in 15 s · applied by Ada on Sep 29");
  });

  it("says less when the server gives less, and never invents who or when", () => {
    expect(
      agentSettingsLine(
        {
          effective_policy: policy,
          policy_assignment: {
            ...assignment,
            created_by_name: null,
            created_at: null,
          },
        },
        now,
      ),
    ).toBe("Check-in 15 s (not saved)");
    expect(
      agentSettingsLine(
        {
          policy_assignment: { ...assignment, created_at: "not a time" },
        },
        now,
      ),
    ).toBe("Applied by Ada (not saved)");
    expect(
      agentSettingsLine(
        {
          policy_assignment: {
            ...assignment,
            created_by_name: null,
            created_at: null,
          },
        },
        now,
      ),
    ).toBe("Not saved");
  });

  it("keeps a missing assignment explicit, with the interval the agent reports", () => {
    expect(agentSettingsLine({ effective_policy: policy }, now)).toBe(
      "Check-in 15 s · no settings assignment reported",
    );
    expect(agentSettingsLine({}, now)).toBe("No settings assignment reported");
  });

  it("adds the year only for another year", () => {
    expect(
      agentSettingsLine(
        {
          effective_policy: { ...policy, heartbeat_seconds: 120 },
          policy_assignment: {
            ...assignment,
            created_at: new Date(2025, 8, 29, 9).toISOString(),
          },
        },
        now,
      ),
    ).toBe("Check-in 2 min · applied by Ada on Sep 29, 2025 (not saved)");
  });
});
