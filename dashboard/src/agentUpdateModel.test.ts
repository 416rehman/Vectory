import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  AgentReleaseSchema,
  AgentUpdatesSchema,
  DeviceAgentUpdateSchema,
  PreviewSchema,
  ReleaseKeySchema,
  UpdateRolloutDetailSchema,
  UpdateRolloutSchema,
  UpdateTargetSchema,
  agentUpdateResponseSchema,
  catalogAction,
  currentUpdate,
  fleetView,
  forkSentence,
  isAgentVersion,
  isLevelKey,
  lastResultText,
  levelHref,
  observationText,
  pinsText,
  platformName,
  releaseDisplayState,
  releaseStartable,
  reviewStartable,
  reviewTitle,
  reviewView,
  rolloutEnding,
  stageTitle,
  strategyText,
  targetDetail,
  targetStateNames,
  thresholdText,
  updateCounts,
  updateSegments,
  updatesLine,
  versionHref,
} from "./agentUpdateModel";
import {
  counts,
  detail,
  finalFingerprint,
  id,
  nextFingerprint,
  preview,
  release,
  releaseKey,
  report,
  rollout,
  target,
  teamFingerprint,
  updates,
} from "./agentUpdateFixtures.test-support";
import { statusOf } from "./status";

// What the contract says every shape is: the generated schemas, run over the
// same data the pages are tested with.
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");
const protocol = JSON.parse(
  readFileSync(
    new URL("../../contracts/protocol.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(protocol);
// A newer contract lists the hosts frozen on a fork in the setting; this test
// runs against either, and checks that member only where the contract has it.
const listsFrozenHosts =
  "frozen_devices" in protocol.$defs.AgentUpdates.properties;
const contract = (name: string, value: unknown) => {
  const check = ajv.getSchema(`${protocol.$id}#/$defs/${name}`);
  expect(check, name).toBeTruthy();
  let given = value;
  if (name === "AgentUpdates" && !listsFrozenHosts) {
    const { frozen_devices: _frozen, ...rest } = value as Record<
      string,
      unknown
    >;
    given = rest;
  }
  const valid = check(given);
  expect(valid ? [] : check.errors, name).toEqual([]);
};

describe("the shapes of the contract", () => {
  it("accepts what the contract describes, and nothing it doesn't", () => {
    const fixtures: [string, unknown, { parse(value: unknown): unknown }][] = [
      ["AgentUpdates", updates(), AgentUpdatesSchema],
      ["AgentReleaseKey", releaseKey(), ReleaseKeySchema],
      ["AgentRelease", release(), AgentReleaseSchema],
      ["AgentUpdateRollout", rollout(), UpdateRolloutSchema],
      ["AgentUpdateRolloutDetail", detail(), UpdateRolloutDetailSchema],
      ["AgentUpdateTarget", target(), UpdateTargetSchema],
      ["AgentUpdatePreview", preview(), PreviewSchema],
      ["DeviceAgentUpdate", report(), DeviceAgentUpdateSchema],
    ];
    for (const [name, value, schema] of fixtures) {
      contract(name, value);
      expect(schema.parse(value), name).toEqual(value);
    }
  });

  it("reads the setting of a server that lists no frozen hosts yet", () => {
    const { frozen_devices: _omitted, ...older } = updates();
    expect(AgentUpdatesSchema.safeParse(older).success).toBe(true);
    const frozen = updates({
      frozen_devices: {
        total: 1,
        items: [
          {
            device_id: id(9),
            device_name: "edge-09",
            rollover_conflict: {
              from: teamFingerprint,
              to: [nextFingerprint, finalFingerprint],
            },
          },
        ],
      },
    });
    contract("AgentUpdates", frozen);
    expect(AgentUpdatesSchema.parse(frozen).frozen_devices?.total).toBe(1);
  });

  it("refuses a reply that breaks a bound", () => {
    const broken = (
      value: unknown,
      schema: { safeParse(v: unknown): { success: boolean } },
    ) => schema.safeParse(value).success;
    expect(broken({ ...updates(), custody: "cloud" }, AgentUpdatesSchema)).toBe(
      false,
    );
    expect(broken(release({ version: "0.01.1" }), AgentReleaseSchema)).toBe(
      false,
    );
    expect(
      broken(release({ manifest_sha256: "A".repeat(64) }), AgentReleaseSchema),
    ).toBe(false);
    expect(
      broken(
        rollout({ state_counts: { ...counts(), verified: -1 } }),
        UpdateRolloutSchema,
      ),
    ).toBe(false);
    const { skipped: _skipped, ...fewer } = counts();
    expect(
      broken({ ...rollout(), state_counts: fewer }, UpdateRolloutSchema),
    ).toBe(false);
    expect(
      broken(
        { ...rollout(), rollout: { ...rollout().rollout, canary_size: 0 } },
        UpdateRolloutSchema,
      ),
    ).toBe(false);
    expect(
      broken(report({ state: "swapping" as never }), DeviceAgentUpdateSchema),
    ).toBe(false);
    expect(broken({ ...preview(), review_token: "short" }, PreviewSchema)).toBe(
      false,
    );
  });

  it("picks the schema by route", () => {
    expect(agentUpdateResponseSchema("/agent-updates", "GET")).toBe(
      AgentUpdatesSchema,
    );
    expect(agentUpdateResponseSchema("/agent-updates/settings", "PUT")).toBe(
      AgentUpdatesSchema,
    );
    expect(agentUpdateResponseSchema("/agent-updates/stop/clear", "POST")).toBe(
      AgentUpdatesSchema,
    );
    expect(
      agentUpdateResponseSchema(
        `/agent-release-keys/${teamFingerprint}/revoke`,
        "POST",
      ),
    ).toBe(ReleaseKeySchema);
    expect(agentUpdateResponseSchema(`/agent-releases/${id(1)}`, "GET")).toBe(
      AgentReleaseSchema,
    );
    expect(
      agentUpdateResponseSchema(`/agent-releases/${id(1)}/signature`, "PUT"),
    ).toBe(AgentReleaseSchema);
    expect(
      agentUpdateResponseSchema("/agent-update-rollouts/preview", "POST"),
    ).toBe(PreviewSchema);
    expect(
      agentUpdateResponseSchema(`/agent-update-rollouts/${id(1)}`, "GET"),
    ).toBe(UpdateRolloutDetailSchema);
    expect(
      agentUpdateResponseSchema(
        `/agent-update-rollouts/${id(1)}/pause`,
        "POST",
      ),
    ).toBe(UpdateRolloutSchema);
    expect(agentUpdateResponseSchema("/devices", "GET")).toBeUndefined();
  });
});

describe("the status language of updates", () => {
  const contractStates = (definition: string, property: string): string[] =>
    protocol.$defs[definition].properties[property].enum;

  it("labels every state the contract names, once", () => {
    for (const state of contractStates("AgentUpdateTarget", "state"))
      expect(statusOf("updateTarget", state).label, state).not.toMatch(/_/);
    expect(new Set(targetStateNames)).toEqual(
      new Set(contractStates("AgentUpdateTarget", "state")),
    );
    for (const state of contractStates("DeviceAgentUpdate", "state"))
      expect(
        Object.hasOwn(
          {
            idle: 1,
            downloading: 1,
            staged: 1,
            waiting_for_host: 1,
            waiting_for_window: 1,
            applying: 1,
            trial: 1,
            refused: 1,
            failed: 1,
          },
          state,
        ),
        state,
      ).toBe(true);
    for (const state of contractStates("AgentUpdateStage", "state"))
      expect(statusOf("updateStage", state).description, state).not.toBe("");
    for (const status of contractStates("AgentUpdateRollout", "status"))
      expect(statusOf("updateRollout", status).description, status).not.toBe(
        "",
      );
    for (const state of contractStates("AgentRelease", "state"))
      expect(statusOf("updateRelease", state).description, state).not.toBe("");
    for (const state of contractStates("AgentReleaseKey", "state"))
      expect(statusOf("releaseKey", state).description, state).not.toBe("");
  });

  it("uses the words of the design for the states of a device", () => {
    const labels = Object.fromEntries(
      targetStateNames.map((state) => [
        state,
        statusOf("updateTarget", state).label,
      ]),
    );
    expect(labels).toEqual({
      verified: "Updated",
      restarted: "Trying the new build",
      applying: "Applying",
      waiting_for_host: "Waiting for the host",
      waiting_for_window: "Waiting for its window",
      staged: "Staged",
      downloading: "Downloading",
      offered: "Offered",
      pending: "Pending",
      rolled_back: "Rolled back",
      failed: "Failed",
      refused: "Refused",
      skipped: "Skipped",
      cancelled: "Cancelled",
    });
    expect(statusOf("updateHost", "trial").label).toBe("Trying the new build");
    expect(statusOf("updateRelease", "awaiting_signature").label).toBe(
      "Waiting for your signature",
    );
  });

  it("names a build updated only when the server saw the new build check in", () => {
    expect(statusOf("updateTarget", "verified").description).toMatch(
      /checked in after the restart/,
    );
    for (const state of ["downloading", "staged", "applying"])
      expect(statusOf("updateTarget", state).label).not.toBe("Updated");
  });
});

describe("the fleet's counts", () => {
  it("never shows a count the server didn't give", () => {
    expect(fleetView(null)).toBeNull();
    expect(fleetView(undefined)).toBeNull();
  });

  it("shows the four ways a host takes updates with the server's own numbers", () => {
    const view = fleetView(updates().fleet)!;
    expect(view.total).toBe(46);
    expect(view.levels).toEqual([
      { key: "automatic", label: "Automatic", devices: 30 },
      { key: "ask", label: "Ask", devices: 4 },
      { key: "off", label: "Off", devices: 9 },
      { key: "cannot_update", label: "Can't update", devices: 3 },
    ]);
    expect(view.versions).toEqual([
      { version: "0.1.1", devices: 3, known: true },
      { version: "0.1.0", devices: 41, known: true },
      { version: "unknown", devices: 2, known: false },
    ]);
  });

  it("adds Not reported only when a device sent nothing, so the buckets add up", () => {
    const fleet = {
      devices_total: 5,
      versions: [{ version: "0.1.0", devices: 5 }],
      levels: {
        automatic: 0,
        ask: 0,
        off: 2,
        cannot_update: 0,
        not_reported: 3,
      },
    };
    const view = fleetView(fleet)!;
    expect(view.levels.at(-1)).toEqual({
      key: "not_reported",
      label: "Not reported",
      devices: 3,
    });
    expect(view.levels.reduce((sum, level) => sum + level.devices, 0)).toBe(5);
    expect(
      fleetView({
        ...fleet,
        devices_total: 2,
        levels: { ...fleet.levels, not_reported: 0 },
      })!.levels.map((level) => level.key),
    ).toEqual(["automatic", "ask", "off", "cannot_update"]);
  });

  it("opens the device list filtered, with a version exactly as reported", () => {
    expect(levelHref("cannot_update")).toBe(
      "#/devices?agent_update=cannot_update",
    );
    expect(versionHref("0.1.0")).toBe("#/devices?agent_version=0.1.0");
    expect(versionHref("dev build/1 2")).toBe(
      "#/devices?agent_version=dev%20build%2F1%202",
    );
  });

  it("reads only the levels and versions the list can filter to from an address", () => {
    for (const key of [
      "automatic",
      "ask",
      "off",
      "cannot_update",
      "not_reported",
    ])
      expect(isLevelKey(key), key).toBe(true);
    for (const key of ["", "Automatic", "auto", "cannot-update", "__proto__"])
      expect(isLevelKey(key), key).toBe(false);
    expect(isAgentVersion("0.1.0")).toBe(true);
    // A development build reports what it reports.
    expect(isAgentVersion("0.1.0-dev+abc")).toBe(true);
    expect(isAgentVersion("")).toBe(false);
    expect(isAgentVersion("a\nb")).toBe(false);
    expect(isAgentVersion("x".repeat(128))).toBe(true);
    expect(isAgentVersion("x".repeat(129))).toBe(false);
    // 128 bytes, not 128 characters.
    expect(isAgentVersion("é".repeat(65))).toBe(false);
  });
});

describe("catalog builds and releases", () => {
  const entry = (over: object) => ({
    ...updates().catalog![0],
    ...over,
  });
  it("offers to prepare a build, to sign one that waits, to start one that is ready", () => {
    expect(catalogAction(entry({ release: null }))).toEqual({
      kind: "prepare",
    });
    expect(
      catalogAction(entry({ release: { id: id(30), state: "withdrawn" } })),
    ).toEqual({ kind: "prepare" });
    expect(
      catalogAction(
        entry({ release: { id: id(30), state: "awaiting_signature" } }),
      ),
    ).toEqual({ kind: "sign", releaseId: id(30) });
    expect(
      catalogAction(entry({ release: { id: id(30), state: "ready" } })),
    ).toEqual({ kind: "start", releaseId: id(30) });
  });

  it("calls a ready release past its expiry expired, and starts only a live one", () => {
    expect(releaseDisplayState(release())).toBe("ready");
    expect(releaseDisplayState(release({ expired: true }))).toBe("expired");
    expect(
      releaseDisplayState(
        release({ state: "awaiting_signature", expired: true }),
      ),
    ).toBe("awaiting_signature");
    expect(releaseStartable(release())).toBe(true);
    expect(releaseStartable(release({ expired: true }))).toBe(false);
    expect(releaseStartable(release({ state: "awaiting_signature" }))).toBe(
      false,
    );
    expect(releaseStartable(release({ state: "withdrawn" }))).toBe(false);
  });

  it("names a platform as people say it", () => {
    expect(platformName({ os: "darwin", arch: "arm64" })).toBe("macOS arm64");
    expect(platformName({ os: "windows", arch: "amd64" })).toBe(
      "Windows amd64",
    );
    expect(platformName({ os: "linux", arch: "amd64" })).toBe("Linux amd64");
  });
});

describe("a rollout's progress", () => {
  it("orders the bar by progress and puts failures last", () => {
    const segments = updateSegments(
      counts({
        verified: 12,
        applying: 2,
        waiting_for_host: 1,
        offered: 3,
        pending: 20,
        rolled_back: 1,
        failed: 1,
        refused: 1,
        cancelled: 4,
      }),
    );
    expect(segments.map((segment) => segment.label)).toEqual([
      "Updated",
      "Trying the new build",
      "Applying",
      "Waiting for the host",
      "Waiting for its window",
      "Staged",
      "Downloading",
      "Offered",
      "Pending",
      "Refused",
      "Not delivering",
      "Rolled back",
      "Failed",
      "Skipped",
      "Cancelled",
    ]);
    expect(
      segments.filter((s) => s.count > 0).map((s) => [s.label, s.count]),
    ).toEqual([
      ["Updated", 12],
      ["Applying", 2],
      ["Waiting for the host", 1],
      ["Offered", 3],
      ["Pending", 20],
      ["Refused", 1],
      ["Rolled back", 1],
      ["Failed", 1],
      ["Cancelled", 4],
    ]);
  });

  it("counts an updated device whose delivery stopped as not delivering, once", () => {
    const segments = updateSegments(counts({ verified: 5 }), 2);
    expect(segments.find((s) => s.label === "Updated")?.count).toBe(3);
    expect(segments.find((s) => s.label === "Not delivering")?.count).toBe(2);
    // More than verified can't move.
    const capped = updateSegments(counts({ verified: 1 }), 9);
    expect(capped.reduce((sum, s) => sum + s.count, 0)).toBe(1);
  });

  it("says Not released for what never started once the rollout ended", () => {
    expect(
      updateSegments(counts({ pending: 4 }), 0, true).find(
        (segment) => segment.count === 4,
      )?.label,
    ).toBe("Not released");
  });

  it("reads one sentence everywhere, and never claims a device it doesn't count", () => {
    expect(updateCounts(rollout()).sentence).toBe("12 of 41 devices updated");
    expect(
      updateCounts(
        rollout({
          state_counts: counts({
            verified: 12,
            rolled_back: 1,
            failed: 2,
            waiting_for_host: 2,
            waiting_for_window: 1,
            pending: 20,
          }),
          target_count: 38,
          degraded: 1,
        }),
      ).sentence,
    ).toBe(
      "11 of 38 devices updated · 1 not delivering · 1 rolled back · 2 failed · 3 waiting",
    );
    expect(
      updateCounts(
        rollout({ target_count: 1, state_counts: counts({ verified: 1 }) }),
      ).sentence,
    ).toBe("1 of 1 device updated");
    const none = updateCounts(
      rollout({ target_count: 0, state_counts: counts() }),
    );
    expect(none.figure).toBeNull();
    expect(none.sentence).toBe("No devices");
  });

  it("says how the rollout proceeds and stops", () => {
    expect(thresholdText(0)).toBe("Stops on the first failure");
    expect(thresholdText(2)).toBe("Stops after 3 failures");
    expect(observationText(60)).toBe("1 min");
    expect(observationText(300)).toBe("5 min");
    expect(observationText(5400)).toBe("1 h 30 min");
    expect(observationText(90)).toBe("1 min 30 s");
    expect(strategyText(rollout().rollout)).toBe(
      "Canary of 1, then batches of 10",
    );
    expect(strategyText(rollout().rollout, "edge-01")).toBe(
      "Canary edge-01, then batches of 10",
    );
    expect(
      strategyText(
        { ...rollout().rollout, canary_size: 3 },
        "edge-01, edge-02 and 1 more",
      ),
    ).toBe("Canary of 3 (edge-01, edge-02 and 1 more), then batches of 10");
    expect(stageTitle({ kind: "canary", index: 0 })).toBe("Canary");
    expect(stageTitle({ kind: "batch", index: 2 })).toBe("Batch 2");
  });

  it("says why a rollout ended", () => {
    const ending = (over: Parameters<typeof rolloutEnding>[0]) =>
      rolloutEnding(over);
    expect(
      ending({ status: "active", failure_reason: null, cancel_reason: null }),
    ).toBeNull();
    expect(
      ending({
        status: "completed",
        failure_reason: null,
        cancel_reason: null,
      }),
    ).toBeNull();
    expect(
      ending({
        status: "failed",
        failure_reason: "threshold",
        cancel_reason: null,
      }),
    ).toBe("Stopped after device failures");
    expect(
      ending({
        status: "failed",
        failure_reason: "data_plane",
        cancel_reason: null,
      }),
    ).toBe("Stopped: an updated device isn't delivering");
    expect(
      ending({
        status: "cancelled",
        failure_reason: null,
        cancel_reason: "stop",
      }),
    ).toBe("Cancelled by Stop all updates");
    expect(
      ending({
        status: "cancelled",
        failure_reason: null,
        cancel_reason: "operator",
      }),
    ).toBe("Cancelled by a person");
    expect(
      ending({
        status: "cancelled",
        failure_reason: null,
        cancel_reason: "key_revoked",
      }),
    ).toMatch(/revoked/);
    expect(
      ending({
        status: "failed",
        failure_reason: "stalled",
        cancel_reason: null,
      }),
    ).toBe("Stopped: it made no progress for 24 hours");
    expect(
      ending({
        status: "cancelled",
        failure_reason: null,
        cancel_reason: "release_expired",
      }),
    ).toBe("Cancelled: its release expired");
  });
});

describe("a device's progress in a rollout, in words", () => {
  const text = (
    state: Parameters<typeof targetDetail>[0]["state"],
    code: string | null = null,
  ) =>
    targetDetail({ state, code, from_version: "0.1.0", to_version: "0.1.1" });

  it("says what each state means without claiming an update", () => {
    expect(text("offered")).toBe("The offer reaches it at its next check-in.");
    expect(text("staged")).toBe("The build is staged. It isn't installed yet.");
    expect(text("waiting_for_host")).toMatch(/vectory update apply/);
    expect(text("verified")).toMatch(/checked in after the restart/);
    expect(
      targetDetail(
        {
          state: "pending",
          code: null,
          from_version: null,
          to_version: "0.1.1",
        },
        { stopped: true },
      ),
    ).toBe("The rollout ended before this device was offered the build.");
  });

  it("says a rolled-back device won't try the release again", () => {
    expect(text("rolled_back", "NO_CHECK_IN")).toBe(
      "The new build didn't check in within 5 minutes. It won't try 0.1.1 again; it takes the next release.",
    );
  });

  it("says why a device failed or refused, from the code", () => {
    expect(text("failed", "DISK_FULL")).toBe(
      "The host has no room for the new build.",
    );
    expect(text("failed", "NO_REPORT")).toBe(
      "The device stopped reporting after the update began.",
    );
    expect(text("refused", "PACKAGE_MANAGED")).toMatch(/package manager/);
    expect(text("failed")).toBe("The update failed.");
    expect(text("refused", "SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("the review", () => {
  it("counts who will update and who won't, from the server's sets", () => {
    const view = reviewView(preview());
    expect(view.willUpdate).toHaveLength(2);
    expect(view.wontCount).toBe(2);
    expect(reviewStartable(view)).toBe(true);
    expect(view.wontUpdate.map((group) => [group.code, group.title])).toEqual([
      ["UPDATES_OFF", "Updates are off on the host"],
      ["RELEASE_ALREADY_TRIED", "Tried this release and rolled back"],
    ]);
  });

  it("keeps the server's sentence and fix, and the names of unnamed devices", () => {
    const view = reviewView(
      preview({
        wont_update: [
          {
            code: "RELEASE_ALREADY_TRIED",
            reason:
              "edge-02 tried 0.1.1 and rolled back; it takes the next release",
            fix: null,
            devices: [
              { device_id: id(2), device_name: null, successors: null },
            ],
          },
        ],
      }),
    );
    expect(view.wontUpdate[0].reason).toBe(
      "edge-02 tried 0.1.1 and rolled back; it takes the next release",
    );
    expect(view.wontUpdate[0].fix).toBeNull();
    expect(view.wontUpdate[0].devices[0].name).toBe("An unnamed device");
  });

  it("names both successors of a fork", () => {
    const view = reviewView(
      preview({
        wont_update: [
          {
            code: "KEY_ROLLOVER_CONFLICT",
            reason: "edge-05 saw two successors of its key.",
            fix: "Run the Upgrade agent command with the right key.",
            devices: [
              {
                device_id: id(5),
                device_name: "edge-05",
                successors: [nextFingerprint, finalFingerprint],
              },
            ],
          },
        ],
      }),
    );
    expect(view.wontUpdate[0].devices[0].successors).toEqual([
      nextFingerprint,
      finalFingerprint,
    ]);
  });

  it("can't start with nobody to update", () => {
    expect(reviewStartable(reviewView(preview({ will_update: [] })))).toBe(
      false,
    );
  });

  it("titles every code the review can give", () => {
    for (const code of protocolReviewCodes())
      expect(reviewTitle(code), code).not.toBe(code);
  });
});

function protocolReviewCodes(): string[] {
  const schema = protocol.$defs.AgentUpdatePreview.properties.wont_update;
  return schema.items.properties.code.enum;
}

describe("a device's own report", () => {
  it("says how a host takes updates, and how to change an off host", () => {
    expect(updatesLine(report())).toBe(
      "Automatic · patch releases · Mon–Fri 02:00–04:00 · key 05cc6c02351af0cb",
    );
    expect(
      updatesLine(report({ consent: "ask", track: "minor", windows: [] })),
    ).toBe(
      "Ask on the host · patch and minor releases · Any time · key 05cc6c02351af0cb",
    );
    expect(updatesLine(report({ consent: "off", windows: [], keys: [] }))).toBe(
      "Off on this host. Run the Upgrade agent command with updates on to let the dashboard update it.",
    );
    expect(updatesLine(report({ keys: [] }))).toMatch(/no key pinned$/);
    expect(
      updatesLine(report({ keys: [teamFingerprint, nextFingerprint] })),
    ).toMatch(/keys 05cc6c02351af0cb, 5f0681261c9f25fa$/);
  });

  it("names the state without inventing a build", () => {
    const now = (over: Parameters<typeof report>[0]) =>
      currentUpdate(report(over), "edge-02");
    expect(now({})).toBeNull();
    expect(now({ state: "downloading", release_version: "0.1.1" })?.text).toBe(
      "Downloading 0.1.1",
    );
    expect(now({ state: "staged", release_version: null })?.text).toBe(
      "Staged an agent build",
    );
    expect(
      now({ state: "waiting_for_host", release_version: "0.1.1" }),
    ).toEqual({
      text: "Staged 0.1.1 · waiting for someone on edge-02",
      command: "apply",
    });
    expect(
      now({ state: "waiting_for_window", release_version: "0.1.1" })?.text,
    ).toBe("Staged 0.1.1 · waiting for its update window");
    expect(now({ state: "trial", release_version: "0.1.1" })?.text).toMatch(
      /^Trying 0\.1\.1 · the host takes it back by itself/,
    );
    expect(
      now({
        state: "refused",
        code: "COUNTER_REPLAYED",
        release_version: "0.1.1",
      })?.text,
    ).toBe(
      "Refused 0.1.1: this release is older than one this host already tried.",
    );
    expect(
      now({
        state: "failed",
        code: "DOWNLOAD_FAILED",
        release_version: "0.1.1",
      })?.text,
    ).toMatch(/^Couldn't update to 0\.1\.1: the download failed/);
  });

  it("says a fork in the words of the design, with the short IDs", () => {
    expect(forkSentence(null)).toBeNull();
    expect(
      forkSentence({
        from: teamFingerprint,
        to: [nextFingerprint, finalFingerprint],
      }),
    ).toBe(
      "Updates stopped on this host: two successors of key 05cc6c02351af0cb were seen, 5f0681261c9f25fa and 9df9d354c16a22b3. Run the Upgrade agent command with the right key.",
    );
    // The sentence stands in for the refusal's own line.
    expect(
      currentUpdate(
        report({
          state: "refused",
          code: "KEY_ROLLOVER_CONFLICT",
          rollover_conflict: {
            from: teamFingerprint,
            to: [nextFingerprint, finalFingerprint],
          },
        }),
        "edge-02",
      ),
    ).toBeNull();
  });

  it("says the last result, rollback included", () => {
    const time = () => "3 Oct 02:14";
    const last = (over: object) => ({
      release: "a".repeat(64),
      outcome: "committed" as const,
      code: null,
      at: "2026-10-03T02:14:09Z",
      from_version: "0.1.0",
      to_version: "0.1.1",
      ...over,
    });
    expect(lastResultText(last({ first_check_in_ms: 2100 }), time)).toBe(
      "Updated 0.1.0 → 0.1.1 · 3 Oct 02:14 · first check-in 2.1 s after restart",
    );
    expect(lastResultText(last({}), time)).toBe(
      "Updated 0.1.0 → 0.1.1 · 3 Oct 02:14",
    );
    expect(
      lastResultText(
        last({ outcome: "rolled_back", code: "NO_CHECK_IN" }),
        time,
      ),
    ).toBe(
      "Rolled back from 0.1.1: it didn't check in within 5 minutes. This device won't try 0.1.1 again; it takes the next release.",
    );
    expect(
      lastResultText(
        last({ outcome: "rolled_back", code: "ROLLBACK_UNHEALTHY" }),
        time,
      ),
    ).toMatch(
      /^Rolled back from 0\.1\.1, but the previous build isn't healthy either\./,
    );
    expect(
      lastResultText(
        last({ outcome: "failed", code: "PROBE_FAILED", to_version: null }),
        time,
      ),
    ).toBe(
      "Couldn't update to the new build: the new build didn't report the version and platform the release names. Nothing was installed.",
    );
  });

  it("says what the command pins, and who holds the key", () => {
    expect(pinsText({ fingerprint: teamFingerprint, custody: "offline" })).toBe(
      "Pins key 05cc6c02351af0cb · kept offline",
    );
    expect(pinsText({ fingerprint: teamFingerprint, custody: "server" })).toBe(
      "Pins key 05cc6c02351af0cb · held by this server",
    );
  });
});
