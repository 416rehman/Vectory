import { describe, expect, it } from "vitest";
import { agentRefusal, capabilityPhrase } from "./agentRefusals";

describe("refusals the agent decides itself", () => {
  it("says an api block is refused by restricted mode, with no allowance to lift it", () => {
    const refusal = agentRefusal([{ code: "LOCAL_API_DENIED" }]);
    expect(refusal?.phrase).toBe(
      "because restricted mode refuses an api block",
    );
    expect(refusal?.reason).toBe(
      "Restricted mode refuses any top-level api block, and no allowance can permit it.",
    );
    expect(refusal?.next).toBe(
      "Remove the api block, or deploy to a full-mode device.",
    );
  });

  it("says a component ID that names a path is refused in both modes", () => {
    const refusal = agentRefusal([{ code: "INVALID_COMPONENT_ID" }]);
    expect(refusal?.phrase).toBe("because a component ID names a path");
    expect(refusal?.reason).toContain("devices in both modes");
    expect(refusal?.reason).not.toMatch(/restricted/i);
    expect(refusal?.next).toBe(
      "Rename the component and the inputs that name it.",
    );
  });

  it("finds a refusal among several findings, or from a rollout's leading code", () => {
    expect(
      agentRefusal([
        { code: "OUTPUT_UNUSED" },
        { code: "INVALID_COMPONENT_ID" },
      ])?.code,
    ).toBe("INVALID_COMPONENT_ID");
    expect(agentRefusal(undefined, "LOCAL_API_DENIED")?.code).toBe(
      "LOCAL_API_DENIED",
    );
    expect(
      agentRefusal([{ code: "INVALID_COMPONENT_ID" }], "ADDRESS_IN_USE")?.code,
    ).toBe("INVALID_COMPONENT_ID");
  });

  it("names nothing for other findings, and never mistakes a property name for a code", () => {
    expect(agentRefusal([{ code: "NETWORK_DESTINATION_DENIED" }])).toBeNull();
    expect(agentRefusal([], null)).toBeNull();
    expect(agentRefusal(undefined, undefined)).toBeNull();
    expect(agentRefusal(null, "constructor")).toBeNull();
    expect(agentRefusal([{ code: "toString" }])).toBeNull();
  });

  it("blames the host's mode for any other capability refusal", () => {
    expect(capabilityPhrase("restricted")).toBe(
      "because this host's restricted mode doesn't allow it",
    );
    expect(capabilityPhrase(undefined)).toBe(
      "because this host's restricted mode doesn't allow it",
    );
    expect(capabilityPhrase("full")).toBe(
      "because this host's local policy doesn't allow it",
    );
  });
});
