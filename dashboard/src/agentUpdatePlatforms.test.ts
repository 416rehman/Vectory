import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  systemName,
  updatesInRelease,
  updatesNotInRelease,
  updatesShip,
} from "./agentUpdatePlatforms";

// The agent decides which systems take updates; the dashboard only follows it, so
// that Add device never puts a consent in a command that setup would refuse.
describe("the systems whose hosts take agent updates", () => {
  const gate = readFileSync(
    new URL("../../agent/internal/agent/update_gate.go", import.meta.url),
    "utf8",
  );
  const agentSwitch = (name: string) => {
    const found = new RegExp(
      `${name}UpdatesInRelease\\s*=\\s*(true|false)`,
    ).exec(gate);
    expect(found, `${name}UpdatesInRelease`).not.toBeNull();
    return found![1] === "true";
  };

  it("are the ones the agent ships updates on", () => {
    expect(updatesInRelease).toEqual({
      linux: agentSwitch("linux"),
      darwin: agentSwitch("macos"),
      windows: agentSwitch("windows"),
    });
  });

  it("say no for a system nobody named", () => {
    expect(updatesShip("linux")).toBe(updatesInRelease.linux);
    expect(updatesShip("freebsd")).toBe(false);
    expect(updatesShip(null)).toBe(false);
    expect(updatesShip(undefined)).toBe(false);
  });

  it("name the system and say what to do instead", () => {
    expect(updatesNotInRelease("windows")).toBe(
      "Agent updates aren't in this release for Windows hosts. Upgrade the agent on the host instead; Upgrade agent on the device's page shows how.",
    );
    expect(Object.values(systemName)).toEqual(["Linux", "macOS", "Windows"]);
  });
});
