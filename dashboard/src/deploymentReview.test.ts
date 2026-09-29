import { describe, expect, it } from "vitest";
import type { AssignmentDescription, DeploymentPreview, Device } from "./api";
import {
  assignmentName,
  conflictRows,
  defaultRelease,
  inferPipelineName,
  pauseSource,
  policySummary,
  releaseErrors,
  replacementLine,
  reviewHeadline,
  rolloutFor,
  runningName,
  scheduledAt,
  shortAssignmentName,
  startsIn,
  technicalDetails,
  type RequestedChange,
} from "./deploymentReview";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const described = (
  over: Partial<AssignmentDescription> = {},
): AssignmentDescription => ({
  id: id(1),
  name: null,
  resource: "configuration",
  priority: 110,
  target_mode: "snapshot",
  status: "active",
  created_at: null,
  version_id: id(2),
  version_number: 2,
  configuration_id: id(3),
  configuration_name: "Web access logs",
  policy: null,
  policy_id: null,
  policy_name: null,
  ...over,
});
const v3: RequestedChange = {
  kind: "configuration",
  configurationId: id(3),
  pipeline: null,
  number: 3,
};
const device = (n: number, name: string): Device =>
  ({ id: id(n), name, running_version: null }) as unknown as Device;

describe("replacement review copy", () => {
  it("reads as a version upgrade for the same pipeline", () => {
    const preview = {
      replacements: [
        { assignment: described(), device_ids: [id(10), id(11), id(12)] },
      ],
    };
    expect(reviewHeadline(preview, v3, 3)).toBe(
      "Replace Web access logs v2 → v3 on 3 devices",
    );
    expect(inferPipelineName(preview, id(3))).toBe("Web access logs");
  });
  it("names both pipelines when another pipeline is replaced", () => {
    const other = described({
      configuration_id: id(9),
      configuration_name: "Nginx metrics",
      version_number: 4,
    });
    expect(
      replacementLine(
        { assignment: other, device_ids: [id(10)] },
        { ...v3, pipeline: "Web access logs" },
      ),
    ).toBe("Nginx metrics v4 with Web access logs v3 on 1 device");
  });
  it("falls back to a deploy sentence when only some devices are replaced", () => {
    const preview = {
      replacements: [{ assignment: described(), device_ids: [id(10)] }],
    };
    expect(
      reviewHeadline(preview, { ...v3, pipeline: "Web access logs" }, 3),
    ).toBe("Deploy Web access logs v3 to 3 devices");
  });
  it("describes settings and local configs in plain words", () => {
    expect(
      assignmentName(
        described({
          resource: "policy",
          configuration_name: null,
          version_number: null,
          policy: {
            heartbeat_seconds: 60,
            sync_paused: true,
            telemetry_enabled: true,
          },
        }),
      ),
    ).toBe("Agent settings (sync paused, 1 min check-ins)");
    expect(
      assignmentName(
        described({ resource: "policy", policy_name: "Maintenance" }),
      ),
    ).toBe("“Maintenance” settings");
    expect(runningName(device(1, "edge-01"))).toBe("Nothing running yet");
    expect(
      runningName({ ...device(1, "edge-01"), actual_sha256: "a".repeat(64) }),
    ).toBe("Its local config");
    const running = {
      ...device(2, "edge-02"),
      running_version: {
        id: id(2),
        number: 2,
        configuration_id: id(3),
        configuration_name: "Web access logs",
      },
    };
    expect(runningName(running)).toBe("Web access logs v2");
    expect(runningName(running, id(3))).toBe("v2");
    expect(shortAssignmentName(described(), id(3))).toBe("v2");
    expect(shortAssignmentName(described(), id(9))).toBe("Web access logs v2");
    expect(
      policySummary({
        heartbeat_seconds: 120,
        sync_paused: false,
        telemetry_enabled: false,
      }),
    ).toBe("Sync on · check-ins every 2 min · metrics off");
  });
});

describe("pause and resume never dead-end", () => {
  const paused = described({
    resource: "policy",
    configuration_id: null,
    configuration_name: null,
    version_number: null,
    policy: {
      heartbeat_seconds: 60,
      sync_paused: true,
      telemetry_enabled: true,
    },
  });
  const resume: RequestedChange = {
    kind: "policy",
    policy: {
      heartbeat_seconds: 60,
      sync_paused: false,
      telemetry_enabled: true,
    },
    name: null,
  };
  it("reads as resuming when it replaces paused settings", () => {
    expect(
      reviewHeadline(
        { replacements: [{ assignment: paused, device_ids: [id(10)] }] },
        resume,
        1,
      ),
    ).toBe("Resume sync on 1 device");
    expect(
      reviewHeadline(
        { replacements: [] },
        { ...resume, policy: { ...resume.policy, sync_paused: true } },
        2,
      ),
    ).toBe("Pause sync on 2 devices");
  });
  it("says who paused a device and how", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(
      pauseSource(
        {
          sync_paused: true,
          local_paused: false,
          policy_assignment: {
            id: id(4),
            priority: 100,
            reason: "",
            policy_name: "Maintenance",
            created_by_name: "Ada",
            created_at: "2026-09-29T10:00:00Z",
          },
        },
        now,
      ),
    ).toBe(
      "Paused by “Maintenance” settings, applied by Ada, 2h ago · priority 100.",
    );
    expect(
      pauseSource({
        sync_paused: false,
        local_paused: true,
        policy_assignment: undefined,
      }),
    ).toMatch(/Only someone on that host/);
    expect(
      pauseSource({
        sync_paused: false,
        local_paused: false,
        policy_assignment: undefined,
      }),
    ).toBeNull();
  });
});

describe("conflict rows", () => {
  it("lists the assignment in the way for conflicts and higher priorities", () => {
    const other = described({
      id: id(7),
      configuration_name: "Nginx metrics",
      version_number: 4,
    });
    const preview: Pick<
      DeploymentPreview,
      "outcomes" | "conflicts" | "devices"
    > = {
      devices: [
        device(10, "edge-01"),
        device(11, "edge-02"),
        device(12, "edge-03"),
      ],
      conflicts: [
        {
          device_id: id(10),
          assignment_ids: [id(7), "preview"],
          priority: 100,
          resource: "configuration",
          assignments: [other],
        },
      ],
      outcomes: [
        { device_id: id(10), resource: "configuration", outcome: "conflict" },
        {
          device_id: id(11),
          resource: "configuration",
          outcome: "higher_priority",
          assignment: { id: id(8), priority: 200, reason: "" },
        },
        { device_id: id(12), resource: "configuration", outcome: "requested" },
      ],
    };
    const rows = conflictRows(preview, "configuration");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      device_name: "edge-01",
      kind: "conflict",
      priority: 100,
    });
    expect(rows[0].assignments.map((a) => a.id)).toEqual([id(7)]);
    expect(rows[1]).toMatchObject({ kind: "higher_priority", priority: 200 });
    expect(rows[1].assignments[0].id).toBe(id(8));
  });
});

describe("scheduling and technical details", () => {
  it("says when a schedule starts", () => {
    const now = Date.parse("2026-09-29T10:00:00Z");
    expect(startsIn("2026-09-29T12:05:00Z", now)).toBe("in 2 h 5 min");
    expect(startsIn("2026-09-29T10:20:00Z", now)).toBe("in 20 min");
    expect(startsIn("2026-09-29T09:00:00Z", now)).toBeNull();
  });
  it("never copies device-specific values", () => {
    const text = technicalDetails(
      {
        version_id: id(2),
        variable_bindings: { defaults: { region: "eu" }, devices: {} },
      },
      { conflicts: [], outcomes: [], replacements: [], warnings: [] },
    );
    expect(text).not.toContain("region");
    expect(JSON.parse(text).request.version_id).toBe(id(2));
  });
});

describe("release settings", () => {
  it("validates canary numbers and the schedule only when they apply", () => {
    const now = Date.parse("2026-09-29T10:00:00Z");
    expect(releaseErrors({ ...defaultRelease, canary: 0 }, now)).toEqual({});
    expect(
      releaseErrors(
        { ...defaultRelease, strategy: "canary", canary: 0, threshold: 10001 },
        now,
      ),
    ).toEqual({
      canary: "Enter 1 to 10,000 devices.",
      threshold: "Enter 0 to 10,000 devices.",
    });
    expect(
      releaseErrors({ ...defaultRelease, strategy: "scheduled" }, now).schedule,
    ).toBe("Choose a start date and time.");
  });
  it("sends the canary settings, including the failure threshold", () => {
    expect(
      rolloutFor({
        ...defaultRelease,
        strategy: "canary",
        canary: 2,
        batch: 3,
        observe: 0,
        threshold: 4,
      }),
    ).toEqual({
      kind: "canary",
      canary_size: 2,
      batch_size: 3,
      observation_seconds: 0,
      failure_threshold: 4,
    });
    expect(
      rolloutFor({ ...defaultRelease, threshold: 9 }).failure_threshold,
    ).toBe(0);
    expect(
      rolloutFor({
        ...defaultRelease,
        strategy: "scheduled",
        scheduledKind: "canary",
      }).kind,
    ).toBe("canary");
    expect(scheduledAt(defaultRelease)).toBeNull();
  });
});
