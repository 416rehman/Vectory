import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeSeries,
  checklist,
  countLabel,
  desiredNote,
  formatRate,
  healthLabels,
  healthOrder,
  healthStates,
  loopbackAddress,
  metricsAdvice,
  quietSummary,
  readDoneSteps,
  rememberDoneSteps,
  runningGroups,
  runningNotes,
  runningRate,
  settingsOffPhrase,
  telemetryFromCounts,
  unmanagedDetail,
  versionsToRead,
  type SilentDevice,
} from "./overviewModel";
import { deviceDisplayStatus, deviceStatuses } from "./status";
import type { OverviewCounts, OverviewRunning } from "./api";

describe("fleet health buckets", () => {
  it("names every bucket and the device states it stands for", () => {
    // The server counts the buckets; these are the words and links for them.
    expect(healthOrder).toHaveLength(9);
    for (const bucket of healthOrder) {
      expect(healthLabels[bucket]).toBeTruthy();
      expect(healthStates[bucket].length).toBeGreaterThan(0);
      for (const state of healthStates[bucket])
        expect(Object.keys(deviceStatuses)).toContain(state);
    }
    // "Failing" stands for every way an apply can end badly.
    expect(healthStates.failed).toEqual(["failed", "rolled_back", "conflict"]);
    expect(healthStates.degraded).toEqual(["degraded"]);
    // A failed device that keeps a working earlier version is held, never failed.
    expect(healthStates.held).toEqual(["held"]);
    for (const status of ["failed", "rolled_back"])
      expect(
        deviceDisplayStatus({ status, held_on_previous_version: true }),
      ).toBe("held");
    // One word per state, in the bar, the legend and the badge.
    expect(healthLabels.held).toBe("Held on previous version");
    expect(healthLabels.held).toBe(deviceStatuses.held.label);
    // Held sits beside Not delivering in the bar's order, before updating.
    expect(healthOrder.indexOf("held")).toBe(
      healthOrder.indexOf("degraded") + 1,
    );
  });
});

describe("fleet telemetry", () => {
  const telemetry = (
    extra: Partial<OverviewCounts["telemetry"]> = {},
  ): OverviewCounts["telemetry"] => ({
    eligible: 5,
    reporting: 3,
    stale: 1,
    disabled: 0,
    events_in_per_second: 200.5,
    events_in_devices: 2,
    events_out_per_second: null,
    events_out_devices: 0,
    errors: 2,
    errors_per_minute: null,
    newest_sample_at: "2026-09-29T02:59:55.000Z",
    ...extra,
  });

  it("reads what the server summed, with coverage and the busiest devices", () => {
    const summary = telemetryFromCounts(telemetry(), [
      {
        id: "a",
        name: "a",
        events_in_per_second: 120.5,
        events_out_per_second: null,
      },
      {
        id: "b",
        name: "b",
        events_in_per_second: 80,
        events_out_per_second: 79,
      },
    ]);
    expect(summary).toMatchObject({
      eligible: 5,
      reporting: 3,
      stale: 1,
      eventsPerSecond: 200.5,
      rateDevices: 2,
      errors: 2,
      // Older agents report neither delivery nor error rates.
      eventsOutPerSecond: null,
      errorsPerMinute: null,
      freshest: "2026-09-29T02:59:55.000Z",
    });
    expect(summary.top).toEqual([
      { id: "a", name: "a", eventsPerSecond: 120.5, eventsOutPerSecond: null },
      { id: "b", name: "b", eventsPerSecond: 80, eventsOutPerSecond: 79 },
    ]);
  });

  it("keeps missing telemetry missing instead of zero", () => {
    const summary = telemetryFromCounts(
      telemetry({
        reporting: 0,
        events_in_per_second: null,
        events_in_devices: 0,
        errors: null,
        newest_sample_at: null,
      }),
      [],
    );
    expect(summary.reporting).toBe(0);
    expect(summary.eventsPerSecond).toBeNull();
    expect(summary.errors).toBeNull();
    expect(summary.freshest).toBeNull();
    // A real zero from a reporting device stays zero.
    expect(
      telemetryFromCounts(telemetry({ events_in_per_second: 0 }), [])
        .eventsPerSecond,
    ).toBe(0);
  });
});

describe("first-run checklist", () => {
  it("is driven by real state and completes step by step", () => {
    const empty = checklist({
      releases: 0,
      devices: 0,
      checkedIn: 0,
      pipelines: 0,
      versions: 0,
      applied: 0,
    });
    expect(empty.every((step) => !step.done)).toBe(true);
    const connected = checklist({
      releases: null,
      devices: 1,
      checkedIn: 1,
      pipelines: 1,
      versions: 0,
      applied: 0,
    });
    expect(connected.map((step) => step.done)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  const finished = {
    releases: null,
    devices: 1,
    checkedIn: 1,
    pipelines: 1,
    versions: 1,
    applied: 0,
  };
  it("keeps Deploy and verify done when the only verified device goes offline", () => {
    // Online and verified, then offline: nothing is verified right now, but a
    // device did verify a version.
    expect(checklist({ ...finished, applied: 1 }).every((s) => s.done)).toBe(
      true,
    );
    const offline = { ...finished, applied: 0 };
    expect(checklist(offline).at(-1)).toEqual({ id: "deploy", done: false });
    expect(checklist({ ...offline, verified: 1 }).at(-1)).toEqual({
      id: "deploy",
      done: true,
    });
    expect(checklist({ ...offline, verified: 0 }).at(-1)?.done).toBe(false);
  });
  it("never goes back to a step this account saw done", () => {
    const nothing = { ...finished, devices: 0, checkedIn: 0, pipelines: 0 };
    expect(
      checklist(nothing, new Set(["device", "pipeline"])).map((s) => s.done),
    ).toEqual([false, true, true, true, false]);
    // Memory only adds; it never decides a step on its own account.
    expect(checklist(nothing).map((step) => step.done)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
  });
  describe("what this account saw done", () => {
    afterEach(() => vi.unstubAllGlobals());
    const memory = () => {
      const data = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
      });
      return data;
    };
    it("is kept per account in this browser", () => {
      const data = memory();
      expect([...readDoneSteps("ada")]).toEqual([]);
      expect([...rememberDoneSteps("ada", ["device", "deploy"])]).toEqual([
        "device",
        "deploy",
      ]);
      // Another account has its own, and what was seen only accumulates.
      expect([...readDoneSteps("grace")]).toEqual([]);
      expect([...rememberDoneSteps("ada", ["pipeline"])].sort()).toEqual([
        "deploy",
        "device",
        "pipeline",
      ]);
      expect([...readDoneSteps("ada")].sort()).toEqual([
        "deploy",
        "device",
        "pipeline",
      ]);
      expect(data.size).toBe(1);
    });
    it("ignores what it can't read and survives missing storage", () => {
      const data = memory();
      data.set(`vectory-setup-steps-done:"ada"`, "not json");
      expect([...readDoneSteps("ada")]).toEqual([]);
      data.set(
        `vectory-setup-steps-done:"ada"`,
        JSON.stringify(["device", "somewhere-else", 7]),
      );
      expect([...readDoneSteps("ada")]).toEqual(["device"]);
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      });
      expect([...readDoneSteps("ada")]).toEqual([]);
      // Without storage a step is remembered for this view only.
      expect([
        ...rememberDoneSteps("ada", ["deploy"], new Set(["device"])),
      ]).toEqual(["device", "deploy"]);
    });
  });
});

describe("the On desired version tile", () => {
  const tile = {
    managed: 1,
    onDesired: 0,
    held: 0,
    offlineVerified: 0,
    lastVerified: null,
  };
  it("counts an offline device that verified its version as offline, never as not yet verified", () => {
    expect(
      desiredNote({ ...tile, offlineVerified: 1, lastVerified: 2 }),
    ).toEqual(["1 offline, last verified v2"]);
    expect(desiredNote({ ...tile, offlineVerified: 1 })).toEqual([
      "1 offline, last verified their assigned version",
    ]);
  });
  it("says not yet verified only of the devices that are", () => {
    expect(desiredNote(tile)).toEqual(["1 not yet verified"]);
    expect(
      desiredNote({
        managed: 9,
        onDesired: 2,
        held: 1,
        offlineVerified: 3,
        lastVerified: 4,
      }),
    ).toEqual([
      "1 held on previous version",
      "3 offline, last verified v4",
      "3 not yet verified",
    ]);
    // More out of reach than are unsettled can't be: the rest is clamped, so
    // nothing is invented.
    expect(
      desiredNote({ ...tile, managed: 2, onDesired: 1, offlineVerified: 5 }),
    ).toEqual(["1 offline, last verified their assigned version"]);
    expect(desiredNote({ ...tile, managed: 1, onDesired: 1 })).toEqual([]);
  });
});

describe("number formatting", () => {
  it("keeps small rates precise and large ones compact", () => {
    expect(formatRate(0)).toBe("0");
    expect(formatRate(0.395)).toBe("0.40");
    expect(formatRate(4.943)).toBe("4.9");
    expect(formatRate(1284.4)).toBe("1,284");
    expect(formatRate(12345)).toBe("12.3K");
    expect(countLabel(1, "device")).toBe("1 device");
    expect(countLabel(3, "device")).toBe("3 devices");
  });
});

describe("fleet series", () => {
  const minute = (m: number, devices: number | null = 4) => ({
    at: new Date(Date.UTC(2026, 8, 29, 8, m)).toISOString(),
    devices,
  });
  const at = (m: number, s = 0) => Date.UTC(2026, 8, 29, 8, m, s);

  it("leaves out the bucket that is still collecting", () => {
    const series = [minute(24), minute(25), minute(26, 1)];
    // 08:26:06: the 08:26 bucket has heard from one device of four.
    expect(completeSeries(series, at(26, 6))).toEqual(series.slice(0, 2));
  });

  it("keeps a complete newest bucket", () => {
    const series = [minute(24), minute(25), minute(26)];
    expect(completeSeries(series, at(27, 1))).toEqual(series);
  });

  it("waits briefly for late devices, then shows a real drop", () => {
    const series = [minute(24), minute(25), minute(26, 2)];
    expect(completeSeries(series, at(27, 10))).toHaveLength(2);
    // A device that stays silent is a real drop once the grace passes.
    expect(completeSeries(series, at(28, 1))).toHaveLength(3);
  });

  it("does not mistake a gap in the data for a bucket still collecting", () => {
    // 08:20, then nothing until 08:26: the 08:26 bucket ended at 08:27.
    const series = [minute(20), minute(26)];
    expect(completeSeries(series, at(28))).toEqual(series);
    expect(completeSeries(series, at(26, 30))).toEqual(series.slice(0, 1));
    // A wider bucket stays open until it has ended.
    expect(completeSeries(series, at(28), 5 * 60_000)).toHaveLength(1);
  });

  it("keeps short or malformed series as they are", () => {
    expect(completeSeries([minute(26, 1)], at(26, 6))).toHaveLength(1);
    const bad = [
      { at: "x", devices: 1 },
      { at: "y", devices: 1 },
    ];
    expect(completeSeries(bad, at(26))).toEqual(bad);
  });
});

describe("delivery Vectory can and can't measure", () => {
  it("says so in the quiet summary only where delivery goes unmeasured", () => {
    expect(quietSummary(2)).toBe("Nothing is failing that Vectory can measure");
    expect(quietSummary(0)).toBe("Nothing is failing");
  });
  const silent = (
    name: string,
    over: Partial<SilentDevice> = {},
  ): SilentDevice => ({
    id: `id-${name}`,
    name,
    effective_policy: { telemetry_enabled: true },
    running_version: null,
    ...over,
  });
  const runs = (
    pipeline: string,
    number: number,
    versionId = `${pipeline}-${number}`,
  ) => ({
    running_version: {
      id: versionId,
      number,
      configuration_id: `cfg-${pipeline}`,
      configuration_name: pipeline,
    },
  });
  /** What each version's config says about its exporter, as read so far. */
  const exporters =
    (known: Record<string, string | null>) => (versionId: string) =>
      known[versionId];
  it("leads with metrics being off in a device's agent settings, naming the settings", () => {
    const advice = metricsAdvice(
      [
        silent("qa-linux-1", {
          effective_policy: { telemetry_enabled: false },
          policy_assignment: { policy_name: "No metrics" },
          ...runs("First pipeline", 2),
        }),
        silent("qa-linux-2"),
      ],
      exporters({ "First pipeline-2": "127.0.0.1:8655" }),
    );
    expect(advice.settingsOff).toEqual([
      { id: "id-qa-linux-1", name: "qa-linux-1", settings: "No metrics" },
    ]);
    expect(settingsOffPhrase(advice.settingsOff)).toEqual({
      names: "qa-linux-1",
      owner: "its",
      settings: " (“No metrics”)",
    });
    // The pipeline it runs has an exporter, so there is nothing to add; the
    // address printed is the one it has.
    expect(advice.monitoring).toBeNull();
    expect(advice.noExporter).toBe(0);
    expect(advice.exporters).toEqual([
      {
        pipeline: "First pipeline v2",
        address: "127.0.0.1:8655",
        loopback: true,
      },
    ]);
    // A device that runs nothing has no exporter to lack.
    expect(advice.noPipeline).toBe(1);
  });
  it("says when an exporter is somewhere an agent doesn't read", () => {
    const advice = metricsAdvice(
      [silent("a", runs("Orders", 3))],
      exporters({ "Orders-3": "0.0.0.0:9598" }),
    );
    // It has an exporter, so Add monitoring has nothing to add either.
    expect(advice.monitoring).toBeNull();
    expect(advice.exporters).toEqual([
      { pipeline: "Orders v3", address: "0.0.0.0:9598", loopback: false },
    ]);
    for (const address of ["127.0.0.1:9598", "127.0.1.1:8655", "[::1]:9598"])
      expect(loopbackAddress(address)).toBe(true);
    for (const address of [
      "0.0.0.0:9598",
      "localhost:9598",
      "10.0.0.5:9598",
      "127.0.0.1",
      "[::]:9598",
    ])
      expect(loopbackAddress(address)).toBe(false);
  });
  it("offers monitoring only for a running version that has no exporter", () => {
    const advice = metricsAdvice(
      [
        silent("a", runs("Orders", 3)),
        silent("b", runs("Web", 1)),
        silent("c", runs("Web", 2)),
        silent("d", runs("Audit", 1)),
        // Settings that turn metrics off don't hide a missing exporter.
        silent("e", {
          effective_policy: { telemetry_enabled: false },
          ...runs("Web", 2),
        }),
      ],
      exporters({
        "Orders-3": "127.0.0.1:9598",
        "Web-1": null,
        "Web-2": null,
        "Audit-1": null,
      }),
    );
    // Two versions of one pipeline: their devices add up.
    expect(advice.monitoring).toEqual({
      id: "cfg-Web",
      name: "Web",
      devices: 3,
    });
    expect(advice.noExporter).toBe(4);
    expect(advice.exporters).toEqual([
      { pipeline: "Orders v3", address: "127.0.0.1:9598", loopback: true },
    ]);
    expect(advice.settingsOff.map((device) => device.name)).toEqual(["e"]);
  });
  it("never calls a version exporter-less before its config was read", () => {
    const advice = metricsAdvice(
      [silent("a", runs("Orders", 3)), silent("b", runs("Web", 1))],
      exporters({ "Web-1": null }),
    );
    expect(advice.noExporter).toBe(1);
    expect(advice.monitoring?.name).toBe("Web");
    const unknown = metricsAdvice(
      [silent("a", runs("Orders", 3))],
      () => undefined,
    );
    expect(unknown.monitoring).toBeNull();
    expect(unknown.noExporter).toBe(0);
    expect(unknown.noPipeline).toBe(0);
  });
  it("counts devices that run no pipeline apart from those without an exporter", () => {
    const advice = metricsAdvice(
      [silent("a"), silent("b", { running_version: null }), silent("c")],
      () => null,
    );
    expect(advice).toEqual({
      settingsOff: [],
      noPipeline: 3,
      noExporter: 0,
      monitoring: null,
      exporters: [],
    });
    // A pipeline without a name can't be linked to.
    expect(
      metricsAdvice(
        [
          silent("a", {
            running_version: {
              id: "v",
              number: 1,
              configuration_id: null,
              configuration_name: null,
            },
          }),
        ],
        () => null,
      ),
    ).toMatchObject({ noExporter: 1, monitoring: null });
  });
  it("says which devices and which settings to turn metrics on in", () => {
    const device = (name: string, settings: string | null) => ({
      id: name,
      name,
      settings,
    });
    expect(settingsOffPhrase([device("edge-01", null)])).toEqual({
      names: "edge-01",
      owner: "its",
      settings: "",
    });
    expect(
      settingsOffPhrase([
        device("edge-01", "No metrics"),
        device("edge-02", "No metrics"),
      ]),
    ).toEqual({
      names: "edge-01 and edge-02",
      owner: "their",
      settings: " (“No metrics”)",
    });
    expect(
      settingsOffPhrase(
        [device("edge-01", "No metrics"), device("edge-02", "Quiet")],
        5,
      ),
    ).toEqual({
      names: "edge-01, edge-02 and 3 more",
      owner: "their",
      settings: " (“No metrics” and “Quiet”)",
    });
    expect(
      settingsOffPhrase(
        ["A", "B", "C"].map((settings) => device(`edge-${settings}`, settings)),
      ).settings,
    ).toBe(" (“A” and “B” and 1 more)");
  });
  it("reads the versions silent devices run, most devices first", () => {
    const device = (name: string, version: string | null) =>
      silent(
        name,
        version ? runs("Orders", Number(version.slice(1)), version) : {},
      );
    expect(
      versionsToRead([
        device("a", "v3"),
        device("b", "v1"),
        device("c", "v1"),
        device("d", null),
        device("e", "v2"),
      ]),
    ).toEqual(["v1", "v2", "v3"]);
    expect(
      versionsToRead(
        ["v1", "v2", "v3"].map((version) => device(version, version)),
        2,
      ),
    ).toEqual(["v1", "v2"]);
    expect(versionsToRead([])).toEqual([]);
  });
  it("says what runs on devices without a pipeline", () => {
    expect(unmanagedDetail(1, 0)).toBe(
      "Vector starts on it when you deploy a pipeline.",
    );
    expect(unmanagedDetail(2, 0)).toBe(
      "Vector starts on them when you deploy a pipeline.",
    );
    expect(unmanagedDetail(1, 1)).toBe(
      "A local configuration adopted at setup keeps running until you deploy one.",
    );
    expect(unmanagedDetail(3, 3)).toBe(
      "Local configurations adopted at setup keep running until you deploy one.",
    );
    expect(unmanagedDetail(3, 1)).toBe(
      "1 runs a local configuration adopted at setup until you deploy one; Vector starts on the others when you deploy.",
    );
    expect(unmanagedDetail(4, 2)).toBe(
      "2 run a local configuration adopted at setup until you deploy one; Vector starts on the others when you deploy.",
    );
  });
});

describe("what runs where", () => {
  const running = (extra: Partial<OverviewRunning> = {}): OverviewRunning => ({
    configuration_id: "c1",
    configuration_name: "Edge syslog processing",
    version_id: "v1",
    version: 1,
    device_count: 3,
    devices_reporting: 3,
    groups: [{ id: "g1", name: "Edge collectors", device_count: 3 }],
    more_groups: 0,
    events_in_per_second: 14,
    events_out_per_second: 4.5,
    state: "running",
    not_delivering: 0,
    canary: null,
    ...extra,
  });

  it("lists the groups a version runs in, each leading to that version's devices there", () => {
    expect(runningGroups(running({ groups: [], more_groups: 0 }))).toEqual({
      chips: [],
      more: 0,
    });
    expect(
      runningGroups(
        running({
          version_id: "v 1",
          groups: [
            { id: "g1", name: "Edge collectors", device_count: 3 },
            { id: "g2", name: "Web tier", device_count: 1 },
          ],
          more_groups: 4,
        }),
      ),
    ).toEqual({
      chips: [
        {
          id: "g1",
          name: "Edge collectors",
          count: 3,
          href: "#/devices?running=v%201&group=g1",
        },
        {
          id: "g2",
          name: "Web tier",
          count: 1,
          href: "#/devices?running=v%201&group=g2",
        },
      ],
      more: 4,
    });
  });

  it("shows events in and out, never a zero for an unknown rate", () => {
    expect(runningRate(running())).toBe("14.0 → 4.5/s");
    expect(runningRate(running({ events_out_per_second: null }))).toBe(
      "14.0/s in",
    );
    expect(runningRate(running({ events_in_per_second: null }))).toBe(
      "4.5/s out",
    );
    expect(
      runningRate(
        running({ events_in_per_second: null, events_out_per_second: null }),
      ),
    ).toBeNull();
    // A real zero from reporting devices stays a zero.
    expect(
      runningRate(
        running({ events_in_per_second: 0, events_out_per_second: 0 }),
      ),
    ).toBe("0 → 0/s");
  });

  it("says nothing extra about a version that simply runs", () => {
    expect(runningNotes(running())).toEqual([]);
  });

  it("names devices that aren't delivering and the canary that is measuring", () => {
    expect(
      runningNotes(
        running({
          state: "not_delivering",
          not_delivering: 1,
          canary: {
            deployment_id: "d1",
            phase: "measuring",
            device_count: 1,
            device_names: ["edge-nyc-02"],
          },
        }),
      ),
    ).toEqual([
      {
        text: "1 not delivering",
        tone: "danger",
        href: "#/devices?running=v1&status=degraded",
      },
      {
        text: "canary on edge-nyc-02 · measuring delivery",
        tone: "info",
        href: "#/deployments/d1",
      },
    ]);
  });

  it("says where a canary runs however many devices it holds", () => {
    const canary = (count: number, names: string[]) =>
      runningNotes(
        running({
          state: "canary",
          canary: {
            deployment_id: "d1",
            phase: "observing",
            device_count: count,
            device_names: names,
          },
        }),
      )[0].text;
    expect(canary(2, ["edge-1", "edge-2"])).toBe(
      "canary on edge-1 and edge-2 · observing for problems",
    );
    expect(canary(7, ["edge-1", "edge-2", "edge-3"])).toBe(
      "canary on 7 devices · observing for problems",
    );
  });
});
