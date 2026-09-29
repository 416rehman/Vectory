import type { Release } from "./api";

export function agentUpgradeRelease(
  releases: Release[],
  os: string,
  arch: string,
): { release?: Release; reason?: string } {
  if (os === "darwin" && arch === "amd64")
    return {
      reason:
        "Vector 0.58.0 has no Intel Mac distribution. The agent download is build-only; this setup is not supported.",
    };
  const matches = releases.filter(
    (item) => item.os === os && item.arch === arch,
  );
  if (!matches.length)
    return {
      reason: "No agent download is available for this device's platform.",
    };
  if (matches.length !== 1)
    return {
      reason:
        "Several downloads match this platform. Ask your administrator to identify the intended build before upgrading.",
    };
  const release = matches[0];
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(release.name) ||
    release.url !== `/api/v1/releases/${release.name}` ||
    typeof release.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(release.version) ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    !Number.isSafeInteger(release.size) ||
    release.size <= 0
  )
    return {
      reason:
        "This download's metadata is incomplete or invalid. Ask your administrator to verify the release catalog.",
    };
  return { release };
}
