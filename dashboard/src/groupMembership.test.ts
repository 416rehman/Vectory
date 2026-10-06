import { afterEach, describe, expect, it, vi } from "vitest";
import { APIError, type GroupMembershipPreview } from "./api";
import {
  AUTO_PREVIEW,
  BUSY_PREVIEW_RETRIES,
  conflictSentences,
  membershipSentence,
  parseMembershipConflicts,
  previewBusy,
  previewWanted,
  previewWithRetries,
  readUnavailableMembers,
  savingBlocked,
} from "./groupMembership";

type Entry = GroupMembershipPreview["devices"][number];
const state = (version: number | null, name = "Web access logs") => ({
  assignment_id: "a",
  assignment_name: null,
  version_id: version ? `v${version}` : null,
  configuration_name: version ? name : null,
  version_number: version,
  generation: 1,
  policy: version
    ? null
    : { heartbeat_seconds: 60, sync_paused: false, telemetry_enabled: true },
});
const unchanged = { changed: false, before: null, after: null, pending: null };

describe("membership change sentences", () => {
  it("says what adding a device deploys", () => {
    const entry: Entry = {
      device_id: "d",
      device_name: "web-01",
      change: "added",
      configuration: {
        changed: true,
        before: null,
        after: state(3),
        pending: null,
      },
      policy: {
        changed: true,
        before: null,
        after: state(null),
        pending: null,
      },
    };
    expect(membershipSentence(entry, "web-01")).toBe(
      "Adding web-01 deploys Web access logs v3 and applies agent settings (sync on · check-ins every 1 min).",
    );
  });
  it("says what removing a device leaves running", () => {
    const entry: Entry = {
      device_id: "d",
      device_name: "edge-02",
      change: "removed",
      configuration: {
        changed: true,
        before: state(2),
        after: null,
        pending: null,
      },
      policy: unchanged,
    };
    expect(membershipSentence(entry, "edge-02")).toBe(
      "Removing edge-02 stops managing its pipeline; it keeps running Web access logs v2.",
    );
    expect(
      membershipSentence({ ...entry, configuration: unchanged }, "edge-02"),
    ).toBe("Removing edge-02 changes nothing on it.");
  });
});

describe("a busy membership preview", () => {
  const busy = () =>
    new APIError("CAPACITY_BUSY", "Preview busy, retrying", 429, true, 1);
  const attempts = (outcomes: (Error | string)[]) => {
    let calls = 0;
    const request = async () => {
      const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    return { request, calls: () => calls };
  };

  it("is asked again once a second, quietly, until it answers", async () => {
    const { request, calls } = attempts([busy(), busy(), "preview"]);
    const waits: number[] = [];
    const result = await previewWithRetries(
      request,
      new AbortController().signal,
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(result).toBe("preview");
    expect(calls()).toBe(3);
    expect(waits).toEqual([1000, 1000]);
  });

  it("shows the error once it stays busy a few times", async () => {
    const { request, calls } = attempts([busy()]);
    const failure = await previewWithRetries(
      request,
      new AbortController().signal,
      async () => {},
    ).catch((error: unknown) => error);
    expect(previewBusy(failure)).toBe(true);
    expect(calls()).toBe(1 + BUSY_PREVIEW_RETRIES);
  });

  it("never retries any other failure", async () => {
    const conflict = new APIError("CONFLICT", "Changed", 409, true);
    const throttled = new APIError("RATE_LIMITED", "Too many", 429, true, 30);
    for (const error of [conflict, throttled]) {
      const { request, calls } = attempts([error]);
      await expect(
        previewWithRetries(request, new AbortController().signal, async () => {
          throw new Error("waited");
        }),
      ).rejects.toBe(error);
      expect(previewBusy(error)).toBe(false);
      expect(calls()).toBe(1);
    }
  });

  it("stops retrying when the edit moves on", async () => {
    vi.useFakeTimers();
    try {
      const { request, calls } = attempts([busy(), "preview"]);
      const controller = new AbortController();
      const pending = previewWithRetries(request, controller.signal);
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(500);
      controller.abort(new Error("edited"));
      expect(await settled).toEqual(new Error("edited"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("when an edit is previewed", () => {
  it("reads a small edit's preview at once and a large one's only when asked", () => {
    expect(AUTO_PREVIEW).toBe(500);
    expect(previewWanted(0, "", "")).toBe(false);
    expect(previewWanted(1, "a|b", "")).toBe(true);
    expect(previewWanted(500, "a|b", "")).toBe(true);
    expect(previewWanted(501, "a|b", "")).toBe(false);
    // Asked for this very edit; a different edit asks again.
    expect(previewWanted(4750, "a|b", "a|b")).toBe(true);
    expect(previewWanted(4751, "a|b,c", "a|b")).toBe(false);
  });
});

describe("members the server no longer knows", () => {
  afterEach(() => vi.unstubAllGlobals());
  const member = (id: string, unavailable = false) => ({
    id,
    name: unavailable ? null : `device ${id}`,
    status: unavailable ? "unavailable" : "verified",
  });
  /** A group whose member list is `list`, served a page at a time. */
  function serve(list: ReturnType<typeof member>[]) {
    const reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://synthetic.test");
        reads.push(url.pathname.replace("/api/v1", "") + url.search);
        const page = Number(url.searchParams.get("page"));
        const size = Number(url.searchParams.get("page_size"));
        return new Response(
          JSON.stringify({
            items: list.slice((page - 1) * size, page * size),
            total: list.length,
            page,
            page_size: size,
          }),
        );
      }),
    );
    return reads;
  }
  const known = (n: number) =>
    Array.from({ length: n }, (_, i) => member(`k${i}`));
  const gone = (n: number) =>
    Array.from({ length: n }, (_, i) => member(`u${i}`, true));
  const signal = () => new AbortController().signal;

  it("reads only the last page of a group that has none", async () => {
    const reads = serve(known(250));
    expect(await readUnavailableMembers("g1", 250, signal())).toEqual([]);
    expect(reads).toEqual(["/groups/g1/members?page=3&page_size=100"]);
  });

  it("finds them at the end, in order, without listing the group", async () => {
    const reads = serve([...known(4748), ...gone(2)]);
    expect(await readUnavailableMembers("g1", 4750, signal())).toEqual([
      "u0",
      "u1",
    ]);
    expect(reads).toEqual(["/groups/g1/members?page=48&page_size=100"]);
  });

  it("goes back a page while a whole page is unavailable, and stops at five", async () => {
    let reads = serve([...known(50), ...gone(150)]);
    expect((await readUnavailableMembers("g1", 200, signal())).length).toBe(
      150,
    );
    expect(reads).toHaveLength(2);
    reads = serve(gone(900));
    expect((await readUnavailableMembers("g1", 900, signal())).length).toBe(
      500,
    );
    expect(reads).toHaveLength(5);
  });

  it("reads one page for an empty group", async () => {
    const reads = serve([]);
    expect(await readUnavailableMembers("g1", 0, signal())).toEqual([]);
    expect(reads).toHaveLength(1);
  });
});

describe("a group edit that collides with another assignment", () => {
  const BERLIN = "00000000-0000-4000-8000-0000000000b1";
  const ROME = "00000000-0000-4000-8000-0000000000b2";
  const description = (over: Record<string, unknown>) => ({
    id: "a1",
    name: null,
    resource: "policy",
    priority: 100,
    target_mode: "snapshot",
    status: "active",
    created_at: null,
    version_id: null,
    version_number: null,
    configuration_id: null,
    configuration_name: null,
    policy: {
      heartbeat_seconds: 15,
      sync_paused: false,
      telemetry_enabled: true,
    },
    policy_id: null,
    policy_name: null,
    targets: "devices",
    groups: [],
    ...over,
  });
  const byHand = (over: Record<string, unknown> = {}) =>
    description({ id: "a1", policy_name: "Fast check-in", ...over });
  const followingBerlin = (over: Record<string, unknown> = {}) =>
    description({
      id: "b1",
      policy_name: "Group defaults",
      target_mode: "persistent",
      targets: "group",
      groups: [{ id: BERLIN, name: "Berlin edge" }],
      ...over,
    });
  const collision = (device: string, assignments: unknown[], over = {}) => ({
    device_id: `00000000-0000-4000-8000-0000000000${device.slice(-2)}`,
    device_name: device,
    resource: "policy",
    priority: 100,
    assignments,
    ...over,
  });
  const parsed = (list: unknown[], total?: number) => {
    const named = parseMembershipConflicts(list, total);
    expect(named).not.toBeNull();
    return named!;
  };

  it("names the device, both assignments and what to do", () => {
    const named = parsed([collision("edge-01", [byHand(), followingBerlin()])]);
    expect(conflictSentences(named, BERLIN)).toEqual([
      "edge-01 already follows “Fast check-in” (agent settings, priority 100), and “Group defaults” follows Berlin edge at the same priority. Give one of them another priority, or remove edge-01 from the targets of “Fast check-in”, then add it to the group.",
    ]);
    // The order the server lists the two in does not matter.
    const swapped = parsed([
      collision("edge-01", [followingBerlin(), byHand()]),
    ]);
    expect(conflictSentences(swapped, BERLIN)).toEqual(
      conflictSentences(named, BERLIN),
    );
  });

  it("says pipeline, with the version, for pipelines", () => {
    const metrics = description({
      id: "p1",
      resource: "configuration",
      policy: null,
      configuration_name: "Edge metrics",
      version_number: 1,
    });
    const logs = description({
      id: "p2",
      resource: "configuration",
      policy: null,
      configuration_name: "Access logs",
      version_number: 4,
      target_mode: "persistent",
      targets: "group",
      groups: [{ id: BERLIN, name: "Berlin edge" }],
    });
    expect(
      conflictSentences(
        parsed([
          collision("edge-03", [metrics, logs], { resource: "configuration" }),
        ]),
        BERLIN,
      ),
    ).toEqual([
      "edge-03 already follows Edge metrics v1 (pipeline, priority 100), and Access logs v4 follows Berlin edge at the same priority. Give one of them another priority, or remove edge-03 from the targets of Edge metrics v1, then add it to the group.",
    ]);
  });

  it("sends a device that follows another group out of that group", () => {
    const viaRome = byHand({
      targets: "group",
      groups: [{ id: ROME, name: "Rome edge" }],
      target_mode: "persistent",
    });
    expect(
      conflictSentences(
        parsed([collision("edge-01", [viaRome, followingBerlin()])]),
        BERLIN,
      )[0],
    ).toContain("or take edge-01 out of Rome edge, then add it to the group.");
  });

  it("names the first devices once for the same two assignments", () => {
    const named = parsed(
      ["edge-01", "edge-02", "edge-03", "edge-04", "edge-05"].map((device) =>
        collision(device, [byHand(), followingBerlin()]),
      ),
    );
    const lines = conflictSentences(named, BERLIN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "edge-01, edge-02 and 3 more already follow “Fast check-in” (agent settings, priority 100), and “Group defaults” follows Berlin edge at the same priority. Give one of them another priority, or remove those devices from the targets of “Fast check-in”, then add them to the group.",
    );
  });

  it("says each pair of assignments once and counts what is not listed", () => {
    const other = byHand({ id: "a2", policy_name: "Slow check-in" });
    const named = parsed(
      [
        collision("edge-01", [byHand(), followingBerlin()]),
        collision("edge-02", [other, followingBerlin()]),
      ],
      12,
    );
    const lines = conflictSentences(named, BERLIN);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^edge-01 already follows “Fast check-in”/);
    expect(lines[1]).toMatch(/^edge-02 already follows “Slow check-in”/);
    expect(lines[2]).toBe("10 more conflicts aren't listed here.");
    expect(
      conflictSentences(
        parsed([collision("edge-01", [byHand(), followingBerlin()])], 2),
        BERLIN,
      ).at(-1),
    ).toBe("1 more conflict isn't listed here.");
  });

  it("does not guess which assignment is new when it can't tell", () => {
    const both = parsed([
      collision("edge-01", [
        byHand({
          targets: "group",
          groups: [{ id: BERLIN, name: "Berlin edge" }],
        }),
        followingBerlin(),
      ]),
    ]);
    expect(conflictSentences(both, BERLIN)[0]).toBe(
      "edge-01 would follow both “Fast check-in” and “Group defaults” (agent settings, priority 100). Give one of them another priority, or take edge-01 out of one of them, then save again.",
    );
  });

  it("falls back to the server's sentence when it names nothing usable", () => {
    expect(parseMembershipConflicts(undefined)).toBeNull();
    expect(parseMembershipConflicts([])).toBeNull();
    expect(parseMembershipConflicts("edge-01")).toBeNull();
    expect(
      parseMembershipConflicts([collision("edge-01", [byHand()])]),
    ).toBeNull();
    expect(
      parseMembershipConflicts(
        Array.from({ length: 11 }, () =>
          collision("edge-01", [byHand(), followingBerlin()]),
        ),
      ),
    ).toBeNull();
    // A total that is not larger than what is listed is never believed.
    expect(
      parseMembershipConflicts(
        [collision("edge-01", [byHand(), followingBerlin()])],
        0,
      )?.total,
    ).toBe(1);
  });

  it("blocks saving with the reason, and never for an edit that is fine", () => {
    const sentence =
      "Group membership creates conflicting equal-priority assignments";
    const preview = (blockers: GroupMembershipPreview["blockers"]) =>
      ({
        group_id: BERLIN,
        revision: 1,
        stale: false,
        ready: !blockers.length,
        blockers,
        devices: [],
      }) as GroupMembershipPreview;
    expect(savingBlocked(null)).toBe("");
    expect(savingBlocked(preview([]))).toBe("");
    expect(
      savingBlocked(
        preview([
          {
            code: "CONFLICT",
            reason: sentence,
            details: [collision("edge-01", [byHand(), followingBerlin()])],
            details_total: 1,
          },
        ]),
      ),
    ).toBe("Saving is blocked until the conflict above is resolved.");
    // Another blocker, or a conflict an older server did not name, says what
    // the server said.
    expect(
      savingBlocked(
        preview([
          { code: "ACTIVE_CANARY_OVERLAP", reason: "Wait for the canary." },
        ]),
      ),
    ).toBe("Wait for the canary.");
    expect(
      savingBlocked(preview([{ code: "CONFLICT", reason: sentence }])),
    ).toBe(sentence);
  });
});
