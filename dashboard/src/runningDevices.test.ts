import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  answer: (_path: string): unknown => undefined,
  paths: [] as string[],
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: async (path: string) => {
    reads.paths.push(path);
    return reads.answer(path);
  },
  withRequestDeadline: <T>(request: (signal: AbortSignal) => Promise<T>) =>
    request(new AbortController().signal),
}));

import {
  commonGroups,
  readRunningDevices,
  runningSummary,
  runningVersions,
  versionsLabel,
  NAMED_LIMIT,
} from "./runningDevices";

const pipeline = "00000000-0000-4000-8000-0000000000c1";
const version = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const device = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  name: `edge-${n}`,
});
const refs = (...names: string[]) => ({
  total: names.length,
  items: names.map((name) => ({ id: `g-${name}`, name })),
});
const telemetry = (
  versions: [number, number][],
  configuration_id = pipeline,
) => ({
  configuration_id,
  devices_running: versions.reduce((sum, [, devices]) => sum + devices, 0),
  versions: versions.map(([number, devices]) => ({
    version_id: version(number),
    version_number: number,
    devices_running: devices,
    devices_reporting: devices,
  })),
});

beforeEach(() => {
  reads.paths = [];
  reads.answer = () => undefined;
});

describe("what a deployment says about the devices it starts from", () => {
  it("names the versions they run", () => {
    const v = (number: number | null) => ({ id: "x", number, devices: 1 });
    expect(versionsLabel([v(1)])).toBe("v1");
    expect(versionsLabel([v(1), v(2)])).toBe("v1 and v2");
    expect(versionsLabel([v(1), v(2), v(4)])).toBe("v1, v2 and v4");
    expect(versionsLabel([1, 2, 3, 4, 5].map(v))).toBe(
      "v1, v2, v3 and 2 more versions",
    );
    expect(versionsLabel([v(null)])).toBe("an earlier version");
    expect(versionsLabel([])).toBe("");
  });

  it("reads as one sentence, with the group when there is one", () => {
    const base = { total: 3, versions: [{ id: "x", number: 1, devices: 3 }] };
    expect(runningSummary({ ...base, groups: ["Edge collectors"] })).toBe(
      "Update the 3 devices running v1 (Edge collectors)",
    );
    expect(runningSummary({ ...base, groups: [] })).toBe(
      "Update the 3 devices running v1",
    );
    expect(runningSummary({ ...base, total: 1, groups: [] })).toBe(
      "Update the device running v1",
    );
    expect(
      runningSummary({ ...base, total: 12000, groups: ["A", "B", "C", "D"] }),
    ).toBe(
      `Update the ${(12000).toLocaleString()} devices running v1 (A, B, C and 1 more groups)`,
    );
    expect(runningSummary({ total: 2, versions: [], groups: [] })).toBe(
      "Update the 2 devices that run this pipeline",
    );
  });

  it("names a group only when it holds every device", () => {
    const rows = [device(1), device(2), device(3)];
    expect(
      commonGroups(rows, {
        [rows[0].id]: refs("Edge collectors", "Berlin"),
        [rows[1].id]: refs("Edge collectors"),
        [rows[2].id]: refs("Edge collectors", "Paris"),
      }),
    ).toEqual(["Edge collectors"]);
    expect(
      commonGroups(rows, {
        [rows[0].id]: refs("Edge collectors"),
        [rows[1].id]: refs("Berlin"),
        [rows[2].id]: refs("Edge collectors"),
      }),
    ).toEqual([]);
    // A device in no group (or one the page did not describe) leaves none.
    expect(
      commonGroups(rows, { [rows[0].id]: refs("Edge collectors") }),
    ).toEqual([]);
    expect(commonGroups([], {})).toEqual([]);
  });

  it("lists the versions devices run, newest first, without the empty ones", () => {
    expect(
      runningVersions(
        telemetry([
          [1, 2],
          [3, 0],
          [2, 1],
        ]),
      ).map((v) => v.number),
    ).toEqual([2, 1]);
    expect(runningVersions({})).toEqual([]);
  });
});

describe("finding the devices that run a pipeline", () => {
  it("finds nothing when no device runs it, and asks nothing more", async () => {
    reads.answer = () => telemetry([]);
    expect((await readRunningDevices(pipeline)).total).toBe(0);
    expect(reads.paths).toEqual([`/configurations/${pipeline}/telemetry`]);
  });

  it("ignores an answer about another pipeline", async () => {
    reads.answer = () => telemetry([[1, 2]], "someone-else");
    expect((await readRunningDevices(pipeline)).ids).toEqual([]);
  });

  it("reads a few devices with their rows, one request for each version", async () => {
    const [one, two, three] = [device(1), device(2), device(3)];
    reads.answer = (path) => {
      if (path.endsWith("/telemetry"))
        return telemetry([
          [2, 1],
          [1, 2],
        ]);
      const running = new URL(path, "http://x").searchParams.get(
        "running_version",
      );
      const items = running === version(1) ? [one, two] : [three];
      return {
        items,
        total: items.length,
        page: 1,
        page_size: 100,
        device_groups: Object.fromEntries(
          items.map((row) => [row.id, refs("Edge collectors")]),
        ),
      };
    };
    const found = await readRunningDevices(pipeline);
    expect(found.ids.sort()).toEqual([one.id, two.id, three.id]);
    expect(found.rows).toHaveLength(3);
    expect(found.total).toBe(3);
    expect(found.truncated).toBe(false);
    expect(found.groups).toEqual(["Edge collectors"]);
    expect(found.versions.map((v) => v.number)).toEqual([1, 2]);
    // Rows come one page at a time, 100 at most, never the whole fleet.
    const pages = reads.paths.filter((path) => path.includes("inventory"));
    expect(pages).toHaveLength(2);
    for (const path of pages)
      expect(path).toContain(`page_size=${NAMED_LIMIT}`);
  });

  it("reads only ids when there are more devices than a page names", async () => {
    const many = Array.from({ length: 150 }, (_, i) => device(i + 1));
    reads.answer = (path) => {
      if (path.endsWith("/telemetry")) return telemetry([[1, 150]]);
      return { ids: many.map((row) => row.id), total: 150, truncated: false };
    };
    const found = await readRunningDevices(pipeline);
    expect(found.ids).toHaveLength(150);
    expect(found.rows).toEqual([]);
    expect(found.groups).toEqual([]);
    expect(reads.paths.some((path) => path.includes("/inventory/ids"))).toBe(
      true,
    );
    expect(reads.paths.some((path) => path.includes("page_size"))).toBe(false);
  });

  it("says so when the server's limit cuts the ids short", async () => {
    reads.answer = (path) =>
      path.endsWith("/telemetry")
        ? telemetry([[1, 12000]])
        : {
            ids: Array.from({ length: 10000 }, (_, i) => device(i + 1).id),
            total: 12000,
            truncated: true,
          };
    const found = await readRunningDevices(pipeline);
    expect(found.ids).toHaveLength(10000);
    expect(found.total).toBe(12000);
    expect(found.truncated).toBe(true);
  });

  it("falls back to ids when devices arrived after the count", async () => {
    const rows = [device(1), device(2)];
    reads.answer = (path) => {
      if (path.endsWith("/telemetry")) return telemetry([[1, 1]]);
      if (path.includes("/inventory/ids"))
        return { ids: rows.map((row) => row.id), total: 2, truncated: false };
      return {
        items: [rows[0]],
        total: 2,
        page: 1,
        page_size: 100,
        device_groups: {},
      };
    };
    expect((await readRunningDevices(pipeline)).ids).toHaveLength(2);
  });

  it("looks at the newest ten versions and says the rest were left out", async () => {
    const versions = Array.from(
      { length: 12 },
      (_, i) => [i + 1, 1] as [number, number],
    );
    reads.answer = (path) => {
      if (path.endsWith("/telemetry")) return telemetry(versions);
      const running = new URL(path, "http://x").searchParams.get(
        "running_version",
      );
      const row = device(Number(running!.slice(-2)));
      return {
        items: [row],
        total: 1,
        page: 1,
        page_size: 100,
        device_groups: { [row.id]: refs("Edge collectors") },
      };
    };
    const found = await readRunningDevices(pipeline);
    expect(found.rows).toHaveLength(10);
    expect(found.truncated).toBe(true);
    expect(found.versions.map((v) => v.number)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
});
