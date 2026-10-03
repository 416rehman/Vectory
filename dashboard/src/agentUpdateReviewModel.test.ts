import { describe, expect, it } from "vitest";
import {
  canaryWhy,
  countWont,
  defaultSettings,
  forkText,
  groupNeedsChoice,
  hostFixBlocks,
  hostFixCommand,
  levelLine,
  nameProblem,
  olderKeyAdvice,
  previewRequest,
  reviewSentence,
  rolloutSettings,
  settingsErrors,
  startRequest,
  windowLine,
  type ReviewForm,
} from "./agentUpdateReviewModel";
import {
  device,
  id,
  install,
  nextFingerprint,
  preview,
  report,
  teamFingerprint,
} from "./agentUpdateFixtures.test-support";

const form = (over: Partial<ReviewForm> = {}): ReviewForm => ({
  releaseId: id(30),
  groupIds: [id(51), id(50)],
  deviceIds: [id(3), id(2)],
  ...defaultSettings,
  canaryDeviceIds: [],
  name: "",
  ...over,
});

describe("the numbers a rollout is started with", () => {
  it("default to the contract's: a canary of one, batches of ten, five minutes, stop at the first failure", () => {
    expect(defaultSettings).toEqual({
      canary: 1,
      batch: 10,
      observe: 300,
      threshold: 0,
    });
    expect(settingsErrors(defaultSettings)).toEqual({});
  });

  it("are whole numbers inside the contract's bounds, said by field", () => {
    expect(
      settingsErrors({ canary: 0, batch: 51, observe: 59, threshold: 101 }),
    ).toEqual({
      canary: "Use a whole number from 1 to 100.",
      batch: "Use a whole number from 1 to 50.",
      observe: "Use 60 to 86,400 seconds, a minute to a day.",
      threshold: "Use a whole number from 0 to 100.",
    });
    expect(
      settingsErrors({
        canary: 100,
        batch: 50,
        observe: 86400,
        threshold: 100,
      }),
    ).toEqual({});
    expect(
      settingsErrors({ canary: 1.5, batch: NaN, observe: 300, threshold: 0 }),
    ).toMatchObject({ canary: expect.any(String), batch: expect.any(String) });
  });

  it("send the canary devices the person named, no more than the canary holds", () => {
    expect(rolloutSettings(form())).toEqual({
      canary_size: 1,
      batch_size: 10,
      observation_seconds: 300,
      failure_threshold: 0,
    });
    expect(
      rolloutSettings(
        form({ canary: 2, canaryDeviceIds: [id(1), id(2), id(3)] }),
      ),
    ).toMatchObject({ canary_device_ids: [id(1), id(2)] });
  });

  it("allow a name of one line, at most 120 characters, or none", () => {
    expect(nameProblem("")).toBe("");
    expect(nameProblem("Edge 0.1.1")).toBe("");
    expect(nameProblem("x".repeat(121))).toMatch(/at most 120/);
    expect(nameProblem("a\nb")).toMatch(/one line/);
  });
});

describe("the requests of a review", () => {
  it("review the same choices in the same order whoever chose first, with no exclusions", () => {
    expect(previewRequest(form())).toEqual({
      release_id: id(30),
      selector: {
        device_ids: [id(2), id(3)],
        group_ids: [id(50), id(51)],
        exclude_ids: [],
      },
      rollout: {
        canary_size: 1,
        batch_size: 10,
        observation_seconds: 300,
        failure_threshold: 0,
      },
    });
  });

  it("start with the review's token and the identity that makes a second send harmless", () => {
    const request = startRequest(
      form({ name: "  Edge 0.1.1  " }),
      preview(),
      id(99),
    );
    expect(request).toMatchObject({
      ...previewRequest(form()),
      name: "Edge 0.1.1",
      review_token: "c".repeat(64),
      request_id: id(99),
    });
    // The same choices and the same identity are the same body, byte for byte.
    expect(JSON.stringify(startRequest(form(), preview(), id(99)))).toBe(
      JSON.stringify(startRequest(form(), preview(), id(99))),
    );
    expect(startRequest(form(), preview(), id(99))).not.toHaveProperty("name");
  });
});

describe("what the review says", () => {
  it("counts everybody who won't update", () => {
    expect(countWont(preview())).toBe(2);
    expect(countWont(preview({ wont_update: [] }))).toBe(0);
  });

  it("says who goes first and why", () => {
    expect(canaryWhy(preview())).toBe(
      "Chosen for you: devices that take updates by themselves with a window open or none, the most ready first.",
    );
    expect(
      canaryWhy(
        preview({
          canary: { size: 1, chosen_by_you: true, device_ids: [id(1)] },
        }),
      ),
    ).toBe("You chose edge-01 as the first to update.");
    expect(
      canaryWhy(
        preview({
          will_update: [],
          canary: { size: 1, chosen_by_you: false, device_ids: [] },
        }),
      ),
    ).toBe("Nobody will update, so no device is released first.");
  });

  it("describes a device's level and window", () => {
    const [first, second] = preview().will_update;
    const when = (instant: string) => `on ${instant.slice(0, 10)}`;
    expect(levelLine(first)).toBe("Automatic");
    expect(levelLine(second)).toBe("Ask on the host");
    expect(windowLine(first, when)).toBe(
      "Mon–Fri 02:00–04:00 · next on 2026-10-05",
    );
    expect(windowLine(second, when)).toBe("Any time");
    expect(
      windowLine(
        { windows: ["daily 01:00-02:00"], next_window_at: null },
        when,
      ),
    ).toBe("daily 01:00–02:00 · open now");
  });

  it("sums the reviewed devices in one sentence", () => {
    expect(reviewSentence(preview(), rolloutSettings(form()))).toBe(
      "Agent 0.1.1 goes to 2 of 4 devices you chose, a canary of 1 first, then batches of 10.",
    );
  });
});

describe("the command that fixes a device that won't update", () => {
  const key = nextFingerprint;
  const group = (code: string) => ({ code });

  it("asks for a choice about a host with no consent to keep, and makes none without it", () => {
    const off = device({ agent_update: report({ consent: "off" }) });
    expect(groupNeedsChoice(group("UPDATES_OFF"))).toBe(true);
    expect(groupNeedsChoice(group("AGENT_TOO_OLD"))).toBe(true);
    expect(groupNeedsChoice(group("KEY_NOT_PINNED"))).toBe(false);
    expect(
      hostFixCommand({
        group: group("UPDATES_OFF"),
        device: off,
        install,
        key,
      }),
    ).toBeNull();
    const command = hostFixCommand({
      group: group("UPDATES_OFF"),
      device: off,
      install,
      key,
      choice: { level: "auto" },
    })!;
    expect(command).toContain(`--updates auto`);
    expect(command).toContain(`--update-key-sha256 ${key}`);
    expect(command).toContain("--update-track patch");
    expect(command).not.toContain("--update-window");
  });

  it("keeps what a host already allows and pins this server's key", () => {
    const keeps = device({
      agent_update: report({
        consent: "ask",
        track: "minor",
        windows: ["Sat,Sun 01:00-03:00 UTC"],
        keys: [teamFingerprint],
      }),
    });
    const command = hostFixCommand({
      group: group("KEY_NOT_PINNED"),
      device: keeps,
      install,
      key,
    })!;
    expect(command).toContain("--updates ask");
    expect(command).toContain(`--update-key-sha256 ${key}`);
    expect(command).toContain("--update-track minor");
    expect(command).toContain("--update-window 'Sat,Sun 01:00-03:00 UTC'");
    expect(command).not.toContain(teamFingerprint);
  });

  it("moves a host to the minor track when its track is the problem", () => {
    const command = hostFixCommand({
      group: group("VERSION_NOT_ON_TRACK"),
      device: device({
        agent_update: report({ consent: "auto", track: "patch" }),
      }),
      install,
      key,
    })!;
    expect(command).toContain("--update-track minor");
  });

  it("follows the host's own state directory and service", () => {
    const command = hostFixCommand({
      group: group("KEY_ROLLOVER_CONFLICT"),
      device: device({
        state_dir: "/srv/vectory state",
        service_manager: "none",
        agent_update: report({ consent: "auto" }),
      }),
      install,
      key,
    })!;
    expect(command).toContain("--state-dir '/srv/vectory state'");
    expect(command).toContain("--service none");
  });

  it("makes no command where none fits: Windows, a refusal with no command, a host nobody can quote", () => {
    const reported = report({ consent: "auto" });
    expect(
      hostFixCommand({
        group: group("KEY_NOT_PINNED"),
        device: device({ os: "windows", agent_update: reported }),
        install,
        key,
      }),
    ).toBeNull();
    expect(
      hostFixCommand({
        group: group("RELEASE_ALREADY_TRIED"),
        device: device({ agent_update: reported }),
        install,
        key,
      }),
    ).toBeNull();
    expect(
      hostFixCommand({
        group: group("PACKAGE_MANAGED"),
        device: device({ agent_update: reported }),
        install,
        key,
      }),
    ).toBeNull();
    expect(
      hostFixCommand({
        group: group("KEY_NOT_PINNED"),
        device: device({ state_dir: "/srv/a\nb", agent_update: reported }),
        install,
        key,
      }),
    ).toBeNull();
  });

  it("shares one block among devices with the same command", () => {
    expect(
      hostFixBlocks([
        { name: "edge-01", command: "run a" },
        { name: "edge-02", command: "run b" },
        { name: "edge-03", command: "run a" },
        { name: "win-01", command: null },
      ]),
    ).toEqual({
      blocks: [
        { command: "run a", devices: ["edge-01", "edge-03"] },
        { command: "run b", devices: ["edge-02"] },
      ],
      without: ["win-01"],
    });
  });

  it("names a fork's two successors, and which one this server signs with", () => {
    const pair: [string, string] = [teamFingerprint, nextFingerprint];
    expect(forkText(pair, nextFingerprint)).toBe(
      `Two successors of its key: ${teamFingerprint.slice(0, 16)} and ${nextFingerprint.slice(0, 16)}. This server signs with ${nextFingerprint.slice(0, 16)}.`,
    );
    expect(forkText(pair, "f".repeat(64))).toMatch(/signs with neither/);
    expect(forkText(pair, null)).toMatch(/signs with neither/);
  });
});

describe("hosts that pin no key reaching the signer of an older release", () => {
  it("says a release is the fix, not a command, when an older key signed it", () => {
    const advice = olderKeyAdvice(
      "KEY_NOT_PINNED",
      teamFingerprint,
      nextFingerprint,
    )!;
    expect(advice.signer).toBe(teamFingerprint.slice(0, 16));
    expect(advice.current).toBe(nextFingerprint.slice(0, 16));
    expect(advice.fix).toMatch(/Withdraw this release and prepare it again/);
    expect(advice.fix).toMatch(/Pinning the current key/);
  });

  it("is silent when the current key signed it, when either key is unknown, and for any other reason", () => {
    expect(
      olderKeyAdvice("KEY_NOT_PINNED", nextFingerprint, nextFingerprint),
    ).toBeNull();
    expect(olderKeyAdvice("KEY_NOT_PINNED", null, nextFingerprint)).toBeNull();
    expect(olderKeyAdvice("KEY_NOT_PINNED", teamFingerprint, null)).toBeNull();
    for (const code of [
      "UPDATES_OFF",
      "AGENT_TOO_OLD",
      "KEY_ROLLOVER_CONFLICT",
    ])
      expect(olderKeyAdvice(code, teamFingerprint, nextFingerprint)).toBeNull();
  });
});
