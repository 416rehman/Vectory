import { describe, expect, it } from "vitest";
import {
  agentUpdateIssuesHref,
  agentUpdateRow,
  isAgentUpdateIssue,
} from "./agentUpdateAttention";

const group = (patch = {}) => ({
  count: 2,
  state: "rolled_back",
  reason: "NO_CHECK_IN",
  device_ids: ["a", "b"],
  ...patch,
});

describe("agentUpdateRow", () => {
  it("says what rolled back, why, and that the release isn't tried again", () => {
    const row = agentUpdateRow(group());
    expect(row.title).toBe("Agent update rolled back on 2 devices");
    expect(row.detail).toBe(
      "The new build didn't check in within 5 minutes. Each host took the new build back and won't try this release again.",
    );
    expect(row.code).toBe("NO_CHECK_IN");
  });

  it("opens the issues when several devices share the group", () => {
    const row = agentUpdateRow(group());
    expect(row.href).toBe(agentUpdateIssuesHref);
    expect(row.action).toBe("Open issues");
  });

  it("opens the device when the group is one device", () => {
    const row = agentUpdateRow(group({ count: 1, device_ids: ["edge/02 x"] }));
    expect(row.title).toBe("Agent update rolled back on 1 device");
    expect(row.detail).toContain("The host took the new build back");
    expect(row.href).toBe("#/devices/edge%2F02%20x");
    expect(row.action).toBe("Open device");
  });

  it("falls back to the issues for one device whose id wasn't sent", () => {
    const row = agentUpdateRow(group({ count: 1, device_ids: [] }));
    expect(row.href).toBe(agentUpdateIssuesHref);
    expect(row.action).toBe("Open issues");
  });

  it("does not say a failed update was taken back", () => {
    const row = agentUpdateRow(
      group({ state: "failed", reason: "DOWNLOAD_FAILED" }),
    );
    expect(row.title).toBe("Agent update failed on 2 devices");
    expect(row.detail).toBe(
      "The download failed. The agent tries again at its next check-in. The update didn't finish.",
    );
    expect(row.detail).not.toContain("took the new build back");
  });

  it("shows a code it doesn't know as the code", () => {
    expect(agentUpdateRow(group({ reason: "SOMETHING_NEW" })).detail).toMatch(
      /^SOMETHING_NEW /,
    );
  });

  it("needs no reason", () => {
    const row = agentUpdateRow(group({ reason: null }));
    expect(row.code).toBeNull();
    expect(row.detail).toBe(
      "Each host took the new build back and won't try this release again.",
    );
  });
});

describe("isAgentUpdateIssue", () => {
  it("knows an issue by its code or its stage", () => {
    expect(isAgentUpdateIssue({ code: "AGENT_UPDATE_ROLLED_BACK" })).toBe(true);
    expect(isAgentUpdateIssue({ code: "AGENT_UPDATE_FAILED" })).toBe(true);
    expect(isAgentUpdateIssue({ code: "X", stage: "agent_update" })).toBe(true);
  });

  it("leaves pipeline and delivery issues alone", () => {
    expect(isAgentUpdateIssue({ code: "DATA_PLANE_STALLED" })).toBe(false);
    expect(
      isAgentUpdateIssue({ code: "VALIDATION_FAILED", stage: "apply" }),
    ).toBe(false);
    expect(isAgentUpdateIssue({ code: "Y", stage: null })).toBe(false);
  });
});
