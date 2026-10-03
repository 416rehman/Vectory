import { describe, expect, it } from "vitest";
import { emptyConsent, readConsent } from "./agentUpdateConsent";
import { teamFingerprint } from "./agentUpdateFixtures.test-support";

describe("what a person chooses about updates for a host", () => {
  it("makes no consent until a level is chosen, and so adds nothing to a command", () => {
    expect(readConsent(emptyConsent, teamFingerprint)).toEqual({
      consent: undefined,
      problem: "",
      chosen: false,
    });
    // A track or a window typed first is nothing without a level.
    expect(
      readConsent(
        { ...emptyConsent, track: "minor", windowsText: "daily 01:00-02:00" },
        teamFingerprint,
      ).consent,
    ).toBeUndefined();
  });

  it("is off in one word, with no key, track or window", () => {
    expect(
      readConsent({ ...emptyConsent, level: "off", windowsText: "junk" }, null),
    ).toEqual({ consent: { level: "off" }, problem: "", chosen: true });
  });

  it("carries the level, the track, the windows and the key the server signs with", () => {
    expect(
      readConsent(
        {
          level: "auto",
          track: "minor",
          windowsText: "Mon-Fri 02:00-04:00\n\nSat,Sun 01:00-03:00 UTC\n",
        },
        teamFingerprint,
      ),
    ).toEqual({
      consent: {
        level: "auto",
        track: "minor",
        windows: ["Mon-Fri 02:00-04:00", "Sat,Sun 01:00-03:00 UTC"],
        key: teamFingerprint,
      },
      problem: "",
      chosen: true,
    });
  });

  it("names the window that is wrong, in the agent's grammar", () => {
    const read = readConsent(
      {
        level: "ask",
        track: "patch",
        windowsText: "Mon-Fri 02:00-04:00\nSoon",
      },
      teamFingerprint,
    );
    expect(read.consent).toBeUndefined();
    expect(read.field).toBe("windows");
    expect(read.problem).toMatch(/^Window 2: Write a window like/);
  });

  it("can't ask a host to pin a key the server doesn't have", () => {
    const read = readConsent({ ...emptyConsent, level: "auto" }, null);
    expect(read.consent).toBeUndefined();
    expect(read.field).toBe("key");
    expect(read.problem).toMatch(/no release key yet/);
  });

  it("refuses a level the place doesn't offer", () => {
    expect(
      readConsent({ ...emptyConsent, level: "off" }, teamFingerprint, {
        levels: ["auto", "ask"],
      }).chosen,
    ).toBe(false);
  });
});
