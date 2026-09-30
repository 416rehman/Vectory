import type { Device, Version } from "./api";
import {
  describeDiagnostic,
  leadingDiagnostic,
  type Diagnostic,
} from "./runtimeModel";

export function currentConfigurationAttempt(
  device: Device,
  version?: Pick<Version, "id" | "sha256"> | null,
) {
  const attempt = device.configuration_attempt;
  const desiredDigest =
    device.desired_sha256 === undefined
      ? version && version.id === device.desired_version_id
        ? version.sha256
        : undefined
      : device.desired_sha256;
  if (
    !attempt ||
    attempt.generation !== device.desired_generation ||
    attempt.version_id !== device.desired_version_id ||
    (device.desired_version_id && desiredDigest === null) ||
    (desiredDigest && desiredDigest !== attempt.sha256) ||
    (device.uses_local_secrets &&
      (attempt.secret_revision ?? 0) !== (device.secret_revision ?? 0))
  )
    return undefined;
  return attempt;
}

/**
 * Redacted Vector findings for the current assignment's failed attempt. An
 * attempt for another generation, version or digest never explains this one.
 */
export function attemptDiagnostics(
  device: Device,
  version?: Pick<Version, "id" | "sha256"> | null,
): Diagnostic[] {
  const attempt = currentConfigurationAttempt(device, version);
  if (
    !attempt ||
    !["failed", "rolled_back"].includes(attempt.state) ||
    attempt.state !== device.apply_state
  )
    return [];
  return attempt.error?.diagnostics ?? [];
}

const failureReasons: Record<string, string> = {
  VALIDATION_FAILED: "Vector rejected this version on the device.",
  ACTIVATION_FAILED: "Vector didn't confirm startup with this version.",
  CAPABILITY_DENIED:
    "This version requires capabilities that are not allowed on this host.",
  INCOMPATIBLE: "This version requires a different Vector version.",
  ADOPTION_REQUIRED:
    "A host operator must prepare this device before it can apply this version.",
  DOWNLOAD_FAILED: "The agent could not download and verify this version.",
  DIGEST_MISMATCH: "The agent could not download and verify this version.",
  SECRET_RESOLUTION_FAILED:
    "The agent could not resolve the local references required by this version.",
  SECRET_REVISION_EXHAUSTED:
    "The local secret revision limit was reached. Host recovery is required.",
  WRITE_FAILED: "The agent could not safely write this version on the host.",
  PATH_UNSAFE: "The managed configuration path could not be used safely.",
  MANIFEST_EXPIRED:
    "The signed update expired before the device applied it. The agent retries on its next check-in.",
  ROLLBACK_FAILED:
    "The update failed and the previous configuration could not be restored. Inspect the host.",
  ROLLBACK_UNAVAILABLE:
    "Vector stopped after this first version failed to start, and there is no earlier version to go back to, so nothing is running.",
};

/** A general sentence, then the device's own leading finding and its fix. */
function withFinding(reason: string, diagnostics: Diagnostic[]) {
  const finding = leadingDiagnostic(diagnostics);
  return finding ? `${reason} ${describeDiagnostic(finding)}` : reason;
}

export function deviceApplicationExplanation(
  device: Device,
  version?: Pick<Version, "id" | "sha256"> | null,
) {
  if (device.status === "offline")
    return "This is the assigned version. Current operation cannot be confirmed while the device is offline.";
  if (device.status === "revoked")
    return "This device's access is revoked, so it no longer checks in: what it runs now is unknown.";
  if (device.status === "verified")
    return "The agent verified that this version is active.";
  if (device.sync_paused || device.local_paused)
    return device.apply_state === "verified_applied" &&
      device.reported_generation === device.desired_generation
      ? "The agent verified this version before sync was paused, and Vector keeps running it. New assignments wait until sync resumes."
      : "The assignment will be reconciled when sync resumes.";
  const attempt = currentConfigurationAttempt(device, version);
  if (device.apply_state === "verification_unknown")
    return "The agent could not confirm that this version is running. Inspect the host before retrying.";
  if (device.apply_state === "failed" && attempt?.state === "failed")
    return withFinding(
      failureReasons[attempt.error?.code || ""] ||
        "The agent could not apply this version. Review device activity for the reported issue.",
      attemptDiagnostics(device, version),
    );
  if (device.apply_state === "rolled_back" && attempt?.state === "rolled_back")
    return withFinding(
      "This version did not start successfully. The agent restored its last verified configuration.",
      attemptDiagnostics(device, version),
    );
  if (!attempt && device.reported_generation < device.desired_generation) {
    if (["failed", "rolled_back"].includes(device.apply_state))
      return "The agent reported a problem without identifying an attempt for this assignment. Review device activity before retrying.";
    return "Waiting for the agent to report an attempt for this assignment. Its last applied configuration is tracked separately.";
  }
  return "The agent has not yet confirmed this assignment as active.";
}
