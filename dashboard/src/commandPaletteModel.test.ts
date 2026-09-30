import { describe, expect, it } from "vitest";
import {
  addRecent,
  deviceSubtitle,
  fuzzyMatch,
  highlightParts,
  matchEntry,
  parseRecents,
  rankEntries,
  type PaletteEntry,
  type RecentItem,
} from "./commandPaletteModel";

const entries: PaletteEntry[] = [
  {
    key: "page:devices",
    kind: "page",
    title: "Devices",
    keywords: "fleet hosts",
  },
  {
    key: "page:deployments",
    kind: "page",
    title: "Deployments",
    keywords: "rollout canary",
  },
  {
    key: "action:deploy",
    kind: "action",
    title: "Deploy a pipeline",
    keywords: "release",
  },
  {
    key: "device:1",
    kind: "device",
    title: "edge-nyc-01",
    subtitle: "linux / amd64",
  },
  {
    key: "device:2",
    kind: "device",
    title: "edge-nyc-02",
    subtitle: "linux / amd64",
  },
  {
    key: "device:3",
    kind: "device",
    title: "web-ams-01",
    subtitle: "linux / arm64",
  },
  { key: "pipeline:1", kind: "pipeline", title: "Edge syslog processing" },
  { key: "group:1", kind: "group", title: "Edge collectors" },
];

describe("command palette search", () => {
  it("prefers prefixes, then word starts, then substrings, then in-order letters", () => {
    const prefix = fuzzyMatch("edge", "edge-nyc-01")!;
    const word = fuzzyMatch("nyc", "edge-nyc-01")!;
    const inner = fuzzyMatch("dge", "edge-nyc-01")!;
    const scattered = fuzzyMatch("en1", "edge-nyc-01")!;
    expect(prefix.score).toBeGreaterThan(word.score);
    expect(word.score).toBeGreaterThan(inner.score);
    expect(inner.score).toBeGreaterThan(scattered.score);
    expect(prefix.ranges).toEqual([[0, 4]]);
    expect(word.ranges).toEqual([[5, 8]]);
    expect(fuzzyMatch("zzz", "edge-nyc-01")).toBeNull();
  });

  it("finds a device by name and highlights the matched letters", () => {
    const [devices] = rankEntries(entries, "ams").filter(
      (group) => group.kind === "device",
    );
    expect(devices.items.map((item) => item.title)).toEqual(["web-ams-01"]);
    expect(highlightParts("web-ams-01", devices.items[0].ranges)).toEqual([
      { text: "web-", match: false },
      { text: "ams", match: true },
      { text: "-01", match: false },
    ]);
  });

  it("matches every word against the title or keywords", () => {
    expect(matchEntry("edge 02", entries[4])).not.toBeNull();
    expect(matchEntry("edge 03", entries[4])).toBeNull();
    // Keywords find pages by task words without highlighting the title.
    expect(matchEntry("canary", entries[1])).not.toBeNull();
    expect(matchEntry("arm64", entries[5])).not.toBeNull();
  });

  it("groups results in a fixed section order and ranks inside each section", () => {
    const groups = rankEntries(entries, "edge");
    expect(groups.map((group) => group.kind)).toEqual([
      "device",
      "pipeline",
      "group",
    ]);
    expect(groups[0].items.map((item) => item.title)).toEqual([
      "edge-nyc-01",
      "edge-nyc-02",
    ]);
    const deploy = rankEntries(entries, "deploy");
    expect(deploy.map((group) => group.kind)).toEqual(["page", "action"]);
  });

  it("keeps the original order and all sections for an empty query", () => {
    const groups = rankEntries(entries, "", 10);
    expect(groups[0].items.map((item) => item.key)).toEqual([
      "page:devices",
      "page:deployments",
    ]);
    expect(groups.map((group) => group.kind)).toContain("device");
  });

  it("limits each section", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      key: `device:${i}`,
      kind: "device" as const,
      title: `edge-${String(i).padStart(2, "0")}`,
    }));
    expect(rankEntries(many, "edge", 5)[0].items).toHaveLength(5);
  });

  it("keeps what the server matched even when the row doesn't show why", () => {
    // Found by its pipeline, which the row's name and platform don't contain.
    const byPipeline: PaletteEntry = {
      key: "device:9",
      kind: "device",
      title: "cache-9",
      subtitle: "linux / amd64",
    };
    expect(matchEntry("syslog", byPipeline)).toBeNull();
    const found = { ...byPipeline, matched: true };
    expect(matchEntry("syslog", found)).toEqual({ score: 100, ranges: [] });
    // A title that matches still ranks above one that only the server matched.
    const named: PaletteEntry = {
      ...found,
      key: "device:8",
      title: "syslog-1",
    };
    const [devices] = rankEntries([found, named], "syslog");
    expect(devices.items.map((item) => item.title)).toEqual([
      "syslog-1",
      "cache-9",
    ]);
    expect(devices.items[0].ranges).toEqual([[0, 6]]);
  });
});

describe("device rows", () => {
  it("say the platform and the pipeline the device is assigned", () => {
    expect(
      deviceSubtitle({
        os: "linux",
        arch: "amd64",
        desired_version: { configuration_name: "Edge syslog", number: 3 },
      }),
    ).toBe("linux / amd64 · Edge syslog v3");
    expect(
      deviceSubtitle({
        os: "darwin",
        desired_version: { configuration_name: "Edge syslog" },
      }),
    ).toBe("darwin · Edge syslog");
    expect(deviceSubtitle({ os: "linux", arch: "arm64" })).toBe(
      "linux / arm64",
    );
    expect(deviceSubtitle({ desired_version: null })).toBe("Device");
  });
});

describe("recent palette items", () => {
  const item = (n: number): RecentItem => ({
    key: `device:${n}`,
    kind: "device",
    title: `edge-${n}`,
    href: `#/devices/${n}`,
  });
  it("keeps the latest unique items first and bounded", () => {
    let list: RecentItem[] = [];
    for (const n of [1, 2, 3, 2, 4, 5, 6, 7, 8])
      list = addRecent(list, item(n));
    expect(list.map((entry) => entry.key)).toEqual([
      "device:8",
      "device:7",
      "device:6",
      "device:5",
      "device:4",
      "device:2",
    ]);
  });
  it("ignores damaged storage and unsafe links", () => {
    expect(parseRecents("not json")).toEqual([]);
    expect(parseRecents('{"a":1}')).toEqual([]);
    expect(
      parseRecents(
        JSON.stringify([
          item(1),
          { ...item(2), href: "javascript:alert(1)" },
          { ...item(3), kind: "person" },
          { key: 4 },
        ]),
      ),
    ).toEqual([item(1)]);
  });
});
