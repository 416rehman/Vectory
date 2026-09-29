import { describe, expect, it } from "vitest";
import { agentUpgradeRelease } from "./agentUpgradeModel";
import type { Release } from "./api";

const release: Release = {
  name: "vectory-0.1.0-dev-windows-amd64.exe",
  os: "windows",
  arch: "amd64",
  version: "0.1.0-dev",
  sha256: "a".repeat(64),
  size: 7000000,
  url: "/api/v1/releases/vectory-0.1.0-dev-windows-amd64.exe",
  signed: false,
};
describe("agent upgrade downloads", () => {
  it("uses the exact device architecture without guessing from version", () => {
    expect(agentUpgradeRelease([release], "windows", "amd64").release).toBe(
      release,
    );
    expect(
      agentUpgradeRelease([release], "windows", "arm64").release,
    ).toBeUndefined();
    expect(
      agentUpgradeRelease([release], "linux", "amd64").release,
    ).toBeUndefined();
  });
  it("does not choose an arbitrary build when the platform is ambiguous", () => {
    expect(
      agentUpgradeRelease(
        [release, { ...release, sha256: "b".repeat(64) }],
        "windows",
        "amd64",
      ).reason,
    ).toMatch(/Several/);
  });
  it.each([
    "https://example.test/agent.exe",
    "//example.test/agent.exe",
    "/api/v1/releases/../session",
    release.url + "?redirect=1",
  ])("refuses a noncanonical download URL: %s", (url) => {
    expect(
      agentUpgradeRelease([{ ...release, url }], "windows", "amd64").release,
    ).toBeUndefined();
  });
  it.each([
    { size: -1 },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { size: undefined },
    { version: undefined },
    { sha256: "invalid" },
    { name: "../agent.exe", url: "/api/v1/releases/../agent.exe" },
  ])("refuses incomplete or invalid release metadata %j", (patch) => {
    expect(
      agentUpgradeRelease(
        [{ ...release, ...patch } as Release],
        "windows",
        "amd64",
      ).release,
    ).toBeUndefined();
  });
  it("does not offer the unsupported Intel Mac build", () => {
    const mac = { ...release, os: "darwin", arch: "amd64" };
    expect(agentUpgradeRelease([mac], "darwin", "amd64").reason).toMatch(
      /Intel Mac/,
    );
  });
});
