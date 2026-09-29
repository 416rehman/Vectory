import { describe, expect, it } from "vitest";
import { ConfigurationAttemptSchema, type Device } from "./api";
import {
  currentConfigurationAttempt,
  deviceApplicationExplanation,
} from "./deviceApplication";

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
      "rejected this version during Vector validation",
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
      "rejected this version during Vector validation",
    );
    expect(currentConfigurationAttempt(device({ desired_sha256: targetDigest }), version)).toBeUndefined();
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
  it("shows only known safe explanations, never raw failure diagnostics", () => {
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
