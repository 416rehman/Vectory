import { describe, expect, it } from "vitest";
import {
  buildName,
  codeText,
  eligibilityCodes,
  rollbackClause,
} from "./agentUpdateCodes";

describe("codeText", () => {
  it("writes a sentence for a code, ending in a full stop", () => {
    expect(codeText("NO_CHECK_IN").reason).toBe(
      "The new build didn't check in within 5 minutes.",
    );
    expect(codeText("DISK_FULL").reason).toMatch(/\.$/);
  });

  it("names what changes it when someone can change it", () => {
    expect(codeText("UPDATES_PAUSED").fix).toBe(
      "Run vectory update resume on the host.",
    );
    expect(codeText("VERSION_NOT_ON_TRACK").fix).toMatch(/Minor releases too/);
    expect(codeText("DISK_FULL").fix).toBeUndefined();
  });

  it("shows a code it doesn't know as the code, never as a guess", () => {
    expect(codeText("SOMETHING_NEW")).toEqual({ reason: "SOMETHING_NEW" });
    // Not a property of the table's prototype either.
    expect(codeText("constructor")).toEqual({ reason: "constructor" });
    expect(codeText("toString")).toEqual({ reason: "toString" });
  });

  it("knows every reason a host can give for not taking updates", () => {
    for (const code of eligibilityCodes)
      expect(codeText(code).reason, code).not.toBe(code);
  });
});

describe("rollbackClause", () => {
  it("reads as a clause after Rolled back from 0.1.1:", () => {
    expect(rollbackClause("START_FAILED")).toBe("it couldn't start");
    expect(rollbackClause("UNHEALTHY")).toBe("it started but wasn't healthy");
    expect(rollbackClause("NO_CHECK_IN")).toBe(
      "it didn't check in within 5 minutes",
    );
  });

  it("falls back to a clause that claims nothing more", () => {
    expect(rollbackClause(null)).toBe("the new build didn't pass its check");
    expect(rollbackClause("SOMETHING_NEW")).toBe(
      "the new build didn't pass its check",
    );
    expect(rollbackClause("constructor")).toBe(
      "the new build didn't pass its check",
    );
  });
});

describe("buildName", () => {
  it("names the version a report gives, never a guess", () => {
    expect(buildName("0.1.1")).toBe("0.1.1");
    expect(buildName(null)).toBe("an agent build");
    expect(buildName(undefined)).toBe("an agent build");
    expect(buildName("")).toBe("an agent build");
  });
});
