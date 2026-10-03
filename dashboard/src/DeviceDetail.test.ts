import { describe, expect, it } from "vitest";
import type { Device } from "./api";
import {
  deliveryMeasurement,
  failedRunningText,
  failurePhrase,
  noPipelineExplanation,
  pickupExplanation,
  unmanagedRunningText,
} from "./DeviceDetail";

const now = Date.parse("2026-09-29T12:00:00Z");
const device = (overrides: Partial<Device> = {}): Device =>
  ({
    id: "device",
    name: "r16-full",
    os: "linux",
    arch: "amd64",
    agent_version: "0.1.0-dev",
    vector_version: "0.58.0",
    status: "unmanaged",
    labels: {},
    apply_state: "unmanaged",
    desired_generation: 0,
    reported_generation: 0,
    sync_paused: false,
    pause_acknowledged: false,
    created_at: "2026-09-29T11:00:00Z",
    ...overrides,
  }) as Device;
const adopted = "1a2b3c4d" + "0".repeat(56);
const failed = (code: string, overrides: Partial<Device> = {}) =>
  device({
    status: "failed",
    apply_state: "failed",
    desired_generation: 1,
    desired_version_id: "00000000-0000-4000-8000-000000000001",
    desired_sha256: "c".repeat(64),
    configuration_attempt: {
      generation: 1,
      version_id: "00000000-0000-4000-8000-000000000001",
      sha256: "c".repeat(64),
      state: "failed",
      error: { code, stage: "rollback", message: "" },
    },
    ...overrides,
  });

describe("a released version on its way", () => {
  const released = (overrides: Partial<Device> = {}) =>
    device({
      status: "applying",
      apply_state: "verified_applied",
      desired_generation: 2,
      reported_generation: 1,
      desired_version_id: "00000000-0000-4000-8000-000000000002",
      desired_sha256: "d".repeat(64),
      check_in_seconds: 60,
      ...overrides,
    });
  it("says seconds while the agent holds a wait", () => {
    expect(pickupExplanation(released({ wake: { listening: true } }))).toBe(
      "Waiting for the agent (connected, usually a few seconds). Its last applied configuration is tracked separately.",
    );
  });
  it("keeps the ordinary explanation otherwise", () => {
    // Not holding a wait, or a server that doesn't say.
    expect(pickupExplanation(released({ wake: { listening: false } }))).toBe(
      null,
    );
    expect(pickupExplanation(released())).toBe(null);
    // Once the agent reports an attempt for this generation, the steps it
    // reports explain the progress, never the wait.
    expect(
      pickupExplanation(
        released({
          wake: { listening: true },
          configuration_attempt: {
            generation: 2,
            version_id: "00000000-0000-4000-8000-000000000002",
            sha256: "d".repeat(64),
            state: "downloaded",
          },
        }),
      ),
    ).toBe(null);
    // Offline, paused or already on the version: nothing is on its way.
    for (const overrides of [
      { status: "offline" },
      { status: "paused", sync_paused: true },
      { status: "verified", reported_generation: 2 },
    ])
      expect(
        pickupExplanation(
          released({ wake: { listening: true }, ...overrides }),
        ),
      ).toBe(null);
  });
});

describe("what runs on a device", () => {
  it("says nothing runs on a new device instead of an adopted workload", () => {
    expect(unmanagedRunningText(device())).toBe(
      "Nothing yet. Vector starts when you deploy a pipeline.",
    );
    expect(
      unmanagedRunningText(
        device({ actual_sha256: adopted, vector_running: true }),
      ),
    ).toBe(
      "A local configuration adopted at setup (SHA-256 1a2b3c4d…) keeps running until you deploy.",
    );
    // Without Vector's state (older agents) it only says the file is there.
    expect(unmanagedRunningText(device({ actual_sha256: adopted }))).toBe(
      "A local configuration adopted at setup (SHA-256 1a2b3c4d…) stays in place until you deploy.",
    );
    expect(
      unmanagedRunningText(
        device({ actual_sha256: adopted, vector_running: false }),
      ),
    ).toBe(
      "A local configuration adopted at setup (SHA-256 1a2b3c4d…) is in place, but Vector isn't running.",
    );
  });

  it("says Vector stopped after a first version that couldn't start", () => {
    expect(failedRunningText(failed("ROLLBACK_UNAVAILABLE"), "v1")).toEqual({
      text: "Nothing running: Vector stopped after v1 failed to start.",
      note: null,
    });
    // An older agent still reports the failed version's digest: never a
    // local configuration.
    expect(
      failedRunningText(
        failed("ROLLBACK_UNAVAILABLE", { actual_sha256: "c".repeat(64) }),
        "v1",
      ).text,
    ).toBe("Nothing running: Vector stopped after v1 failed to start.");
    expect(
      failedRunningText(
        failed("VALIDATION_FAILED", { actual_sha256: "c".repeat(64) }),
        "v1",
      ),
    ).toEqual({ text: "Nothing running yet", note: "v1 failed to apply" });
    expect(
      failedRunningText(
        failed("VALIDATION_FAILED", {
          actual_sha256: adopted,
          vector_running: true,
        }),
        "v2",
      ),
    ).toEqual({
      text: "A local configuration adopted at setup (SHA-256 1a2b3c4d…) keeps running",
      note: "v2 failed to apply",
    });
  });
});

describe("delivery health without metrics", () => {
  const applied = (overrides: Partial<Device> = {}) =>
    device({
      status: "verified",
      apply_state: "verified_applied",
      desired_version_id: "00000000-0000-4000-8000-000000000001",
      ...overrides,
    });
  it("never lets Applied imply delivery nobody measures", () => {
    expect(deliveryMeasurement(applied(), now)).toBe("none");
    expect(
      deliveryMeasurement(
        applied({ host_runtime: { metrics_source: "none" } }),
        now,
      ),
    ).toBe("none");
    expect(
      deliveryMeasurement(
        applied({ host_runtime: { metrics_source: "discovered" } }),
        now,
      ),
    ).toBe("waiting");
    expect(
      deliveryMeasurement(
        applied({
          effective_policy: {
            heartbeat_seconds: 60,
            sync_paused: false,
            telemetry_enabled: false,
          },
        }),
        now,
      ),
    ).toBe("disabled");
  });
  it("says nothing when metrics arrive, or when the device isn't applied", () => {
    expect(
      deliveryMeasurement(
        applied({
          telemetry: { sampled_at: "2026-09-29T11:59:00Z" } as never,
        }),
        now,
      ),
    ).toBeNull();
    expect(
      deliveryMeasurement(
        applied({
          telemetry: { sampled_at: "2026-09-29T11:50:00Z" } as never,
        }),
        now,
      ),
    ).toBe("none");
    expect(deliveryMeasurement(failed("VALIDATION_FAILED"), now)).toBeNull();
    // A delivery problem found in Vector's log shows as the problem itself.
    expect(
      deliveryMeasurement(
        applied({
          data_plane: {
            version_id: "00000000-0000-4000-8000-000000000001",
            issues: [
              {
                code: "DATA_PLANE_SINK_ERRORS",
                component_id: "out",
                title: "out can't deliver events",
              },
            ],
          },
        }),
        now,
      ),
    ).toBeNull();
  });
});

describe("what a failed apply says it failed because of", () => {
  const refused = (
    mode: "restricted" | "full",
    diagnostics?: { code: string; message: string }[],
  ) => {
    const snapshot = failed("CAPABILITY_DENIED", { configuration_mode: mode });
    snapshot.configuration_attempt!.error!.diagnostics = diagnostics?.map(
      (finding) => ({ severity: "error" as const, ...finding }),
    );
    return failurePhrase(snapshot, snapshot.configuration_attempt!);
  };
  it("names an api block as restricted mode's refusal, which no allowance lifts", () => {
    expect(
      refused("restricted", [
        {
          code: "LOCAL_API_DENIED",
          message: 'The pipeline has an "api" block.',
        },
      ]),
    ).toBe("because restricted mode refuses an api block");
  });
  it("names a component ID that is a path in either mode, never blaming restricted mode", () => {
    for (const mode of ["restricted", "full"] as const)
      expect(
        refused(mode, [
          {
            code: "INVALID_COMPONENT_ID",
            message: 'Sink "/tmp/x" (http) has a slash in its ID.',
          },
        ]),
      ).toBe("because a component ID names a path");
  });
  it("blames the host's policy by its mode when the finding names no cause", () => {
    expect(refused("restricted")).toBe(
      "because this host's restricted mode doesn't allow it",
    );
    expect(
      refused("restricted", [
        {
          code: "NETWORK_DESTINATION_DENIED",
          message: 'Sink "out" (http) sends to 127.0.0.1:9.',
        },
      ]),
    ).toBe("because this host's restricted mode doesn't allow it");
    expect(refused("full")).toBe(
      "because this host's local policy doesn't allow it",
    );
  });
  it("names the apply step for any other failure", () => {
    const snapshot = failed("ACTIVATION_FAILED");
    expect(failurePhrase(snapshot, snapshot.configuration_attempt!)).toBe(
      "while restarting Vector",
    );
  });
});

describe("a device with no pipeline assigned", () => {
  it("waits for its first version, or keeps what it adopted", () => {
    expect(noPipelineExplanation(device())).toBe(
      "No published pipeline is assigned. The agent checks in and waits; Vector starts with the first version you deploy.",
    );
    expect(noPipelineExplanation(device({ actual_sha256: adopted }))).toBe(
      "No published pipeline is assigned. The configuration adopted at setup stays in place until you deploy one.",
    );
  });
  it("never says a revoked device waits for one", () => {
    for (const actual_sha256 of [undefined, adopted]) {
      const text = noPipelineExplanation(
        device({ status: "revoked", actual_sha256 }),
      );
      expect(text).toBe(
        "No pipeline is assigned. This device's access is revoked, so it no longer checks in and nothing can be deployed to it.",
      );
      expect(text).not.toMatch(/checks in and waits|until you deploy/);
    }
  });
});
