import { describe, expect, it } from "vitest";
import { ConfigurationAttemptSchema, type Device } from "./api";
import {
  attemptDiagnostics,
  currentConfigurationAttempt,
  deviceApplicationExplanation,
} from "./deviceApplication";
import type { Diagnostic } from "./runtimeModel";

const version = {
  id: "00000000-0000-4000-8000-000000000001",
  sha256: "a".repeat(64),
};
const device = (overrides: Partial<Device> = {}): Device =>
  ({
    id: "device",
    name: "Fixture",
    os: "linux",
    arch: "amd64",
    agent_version: "test",
    vector_version: "0.58.0",
    status: "failed",
    labels: {},
    apply_state: "failed",
    desired_generation: 2,
    reported_generation: 1,
    desired_version_id: version.id,
    configuration_attempt: {
      generation: 2,
      version_id: version.id,
      sha256: version.sha256,
      state: "failed",
      error: {
        code: "VALIDATION_FAILED",
        stage: "validation",
        message: "sanitized",
      },
    },
    ...overrides,
  }) as Device;

describe("current configuration attempt presentation", () => {
  it("identifies the failed new version without advancing last verified evidence", () => {
    const snapshot = device();
    expect(deviceApplicationExplanation(snapshot, version)).toContain(
      "Vector rejected this version",
    );
    expect(snapshot.reported_generation).toBe(1);
  });
  it.each([
    { generation: 1 },
    { version_id: "00000000-0000-4000-8000-000000000002" },
    { sha256: "b".repeat(64) },
  ])(
    "does not attribute a mismatched attempt to the current assignment: %j",
    (mismatch) => {
      const snapshot = device({
        apply_state: "desired",
        configuration_attempt: {
          ...device().configuration_attempt!,
          ...mismatch,
        },
      });
      expect(currentConfigurationAttempt(snapshot, version)).toBeUndefined();
      expect(deviceApplicationExplanation(snapshot, version)).toContain(
        "Waiting for the agent",
      );
    },
  );
  it("does not attribute an older secret revision to a new materialization", () => {
    const snapshot = device({
      uses_local_secrets: true,
      secret_revision: 3,
      configuration_attempt: {
        ...device().configuration_attempt!,
        secret_revision: 2,
      },
    });
    expect(currentConfigurationAttempt(snapshot, version)).toBeUndefined();
  });
  it("attributes an attempt using the target-specific rendered artifact digest", () => {
    const targetDigest = "b".repeat(64);
    const snapshot = device({
      desired_sha256: targetDigest,
      configuration_attempt: {
        ...device().configuration_attempt!,
        sha256: targetDigest,
      },
    });
    expect(currentConfigurationAttempt(snapshot, version)).toEqual(
      snapshot.configuration_attempt,
    );
    expect(deviceApplicationExplanation(snapshot, version)).toContain(
      "Vector rejected this version",
    );
    expect(
      currentConfigurationAttempt(
        device({ desired_sha256: targetDigest }),
        version,
      ),
    ).toBeUndefined();
  });
  it("legacy failure with an older verified generation cannot identify this attempt", () => {
    expect(
      deviceApplicationExplanation(
        device({ configuration_attempt: undefined }),
        version,
      ),
    ).toContain("without identifying an attempt");
  });
  it("offline and paused states retain their operational limits", () => {
    expect(
      deviceApplicationExplanation(device({ status: "offline" }), version),
    ).toContain("cannot be confirmed");
    expect(
      deviceApplicationExplanation(device({ local_paused: true }), version),
    ).toContain("when sync resumes");
    // A revoked device no longer checks in: nothing it runs is confirmed.
    expect(
      deviceApplicationExplanation(device({ status: "revoked" }), version),
    ).toBe(
      "This device's access is revoked, so it no longer checks in: what it runs now is unknown.",
    );
  });
  it("a claimed successful attempt alone never presents verified activation", () => {
    const snapshot = device({
      apply_state: "verification_unknown",
      configuration_attempt: {
        ...device().configuration_attempt!,
        state: "verified_applied",
      },
    });
    expect(deviceApplicationExplanation(snapshot, version)).toContain(
      "could not confirm",
    );
  });
  it("normalized uncertain health takes priority over a historical attempt failure", () => {
    expect(
      deviceApplicationExplanation(
        device({ apply_state: "verification_unknown" }),
        version,
      ),
    ).toContain("could not confirm");
  });
  it("never shows the free-text failure message", () => {
    const snapshot = device({
      configuration_attempt: {
        ...device().configuration_attempt!,
        error: {
          code: "UNKNOWN",
          stage: "unknown",
          message: "private diagnostic",
        },
      },
    });
    expect(deviceApplicationExplanation(snapshot, version)).not.toContain(
      "private diagnostic",
    );
    expect(deviceApplicationExplanation(snapshot, version)).toContain(
      "Review device activity",
    );
  });
  it("explains a failure with the device's leading finding and its fix", () => {
    const diagnostics: Diagnostic[] = [
      {
        severity: "warning",
        code: "OUTPUT_UNUSED",
        component_id: "app",
        message: "Nothing reads the output of app.",
      },
      {
        severity: "error",
        code: "VRL_E100",
        component_kind: "transform",
        component_id: "by_severity",
        route_output: "errors",
        field: "route.errors",
        line: 1,
        column: 1,
        message:
          "Unhandled error: expression can result in runtime error; handle the error case to ensure runtime success",
        hint: "Handle the error case, for example with a fallback: to_int(.status) ?? 0.",
      },
    ];
    const snapshot = device({
      configuration_attempt: {
        ...device().configuration_attempt!,
        error: {
          code: "VALIDATION_FAILED",
          stage: "validation",
          message: "",
          diagnostics,
        },
      },
    });
    expect(attemptDiagnostics(snapshot, version)).toEqual(diagnostics);
    expect(deviceApplicationExplanation(snapshot, version)).toBe(
      "Vector rejected this version on the device. Unhandled error: expression can result in runtime error; handle the error case to ensure runtime success (by_severity.errors, line 1, column 1). Handle the error case, for example with a fallback: to_int(.status) ?? 0.",
    );
    const rolledBack = device({
      apply_state: "rolled_back",
      configuration_attempt: {
        ...device().configuration_attempt!,
        state: "rolled_back",
        error: {
          code: "APPLY_ROLLED_BACK",
          stage: "startup",
          message: "",
          diagnostics: [
            {
              severity: "error",
              code: "DATA_DIR_MISSING",
              field: "data_dir",
              message:
                'The data directory "/srv/missing" does not exist on this device.',
              hint: "Remove data_dir from the pipeline to use the device's own data directory, or create this directory on the device.",
            },
          ],
        },
      },
    });
    expect(deviceApplicationExplanation(rolledBack, version)).toBe(
      'This version did not start successfully. The agent restored its last verified configuration. The data directory "/srv/missing" does not exist on this device. Remove data_dir from the pipeline to use the device\'s own data directory, or create this directory on the device.',
    );
    // Findings from another attempt never explain this assignment.
    const stale = device({
      apply_state: "failed",
      configuration_attempt: {
        ...snapshot.configuration_attempt!,
        generation: 1,
      },
    });
    expect(attemptDiagnostics(stale, version)).toEqual([]);
    expect(deviceApplicationExplanation(stale, version)).not.toContain(
      "Unhandled error",
    );
  });
  it("a paused device still running its verified version says so", () => {
    expect(
      deviceApplicationExplanation(
        device({
          status: "paused",
          local_paused: true,
          apply_state: "verified_applied",
          reported_generation: 2,
          configuration_attempt: {
            ...device().configuration_attempt!,
            state: "verified_applied",
            error: undefined,
          },
        }),
        version,
      ),
    ).toContain("keeps running it");
  });
  it("accepts bounded diagnostics and rejects malformed ones", () => {
    const withDiagnostics = (diagnostics: unknown) =>
      ConfigurationAttemptSchema.safeParse({
        ...device().configuration_attempt,
        error: {
          code: "VALIDATION_FAILED",
          stage: "validation",
          message: "x",
          diagnostics,
        },
      }).success;
    const valid = { severity: "error", code: "DATA_DIR_MISSING", message: "x" };
    expect(withDiagnostics([valid])).toBe(true);
    expect(withDiagnostics(Array(11).fill(valid))).toBe(false);
    expect(withDiagnostics([{ ...valid, severity: "fatal" }])).toBe(false);
    expect(withDiagnostics([{ ...valid, message: "" }])).toBe(false);
    expect(withDiagnostics([{ ...valid, line: 0 }])).toBe(false);
  });
  it("rejects malformed or unsafe attempt identities and unknown state", () => {
    expect(
      ConfigurationAttemptSchema.safeParse(device().configuration_attempt)
        .success,
    ).toBe(true);
    for (const invalid of [
      { generation: Number.MAX_SAFE_INTEGER + 1 },
      { version_id: "not-a-uuid" },
      { state: "success" },
      { sha256: "x" },
      { secret_revision: -1 },
    ])
      expect(
        ConfigurationAttemptSchema.safeParse({
          ...device().configuration_attempt,
          ...invalid,
        }).success,
      ).toBe(false);
  });
});
