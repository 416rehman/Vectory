import type { Device, Version } from "./api";

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

const failureReasons: Record<string, string> = {
  VALIDATION_FAILED:
    "The agent rejected this version during Vector validation.",
  CAPABILITY_DENIED:
    "This version requires capabilities that are not allowed on this host.",
  INCOMPATIBLE: "This version requires a different Vector version.",
  ADOPTION_REQUIRED:
    "A host operator must prepare this device before it can apply this version.",
  DOWNLOAD_FAILED: "The agent could not download and verify this version.",
  SECRET_RESOLUTION_FAILED:
    "The agent could not resolve the local references required by this version.",
  SECRET_REVISION_EXHAUSTED:
    "The local secret revision limit was reached. Host recovery is required.",
  WRITE_FAILED: "The agent could not safely write this version on the host.",
  PATH_UNSAFE: "The managed configuration path could not be used safely.",
  ROLLBACK_FAILED:
    "The update failed and the previous configuration could not be restored. Inspect the host.",
  ROLLBACK_UNAVAILABLE:
    "The update failed and no verified configuration was available to restore. Inspect the host.",
};

export function deviceApplicationExplanation(
  device: Device,
  version?: Pick<Version, "id" | "sha256"> | null,
) {
  if (device.status === "offline")
    return "This is the assigned version. Current operation cannot be confirmed while the device is offline.";
  if (device.status === "verified")
    return "The agent verified that this version is active.";
  if (device.sync_paused || device.local_paused)
    return "The assignment will be reconciled when sync resumes.";
  const attempt = currentConfigurationAttempt(device, version);
  if (device.apply_state === "verification_unknown")
    return "The agent could not confirm that this version is running. Inspect the host before retrying.";
  if (device.apply_state === "failed" && attempt?.state === "failed")
    return (
      failureReasons[attempt.error?.code || ""] ||
      "The agent could not apply this version. Review device activity for the reported issue."
    );
  if (device.apply_state === "rolled_back" && attempt?.state === "rolled_back")
    return "This version did not start successfully. The agent restored its last verified configuration.";
  if (!attempt && device.reported_generation < device.desired_generation) {
    if (["failed", "rolled_back"].includes(device.apply_state))
      return "The agent reported a problem without identifying an attempt for this assignment. Review device activity before retrying.";
    return "Waiting for the agent to report an attempt for this assignment. Its last verified configuration is tracked separately.";
  }
  return "The agent has not yet confirmed this assignment as active.";
}
