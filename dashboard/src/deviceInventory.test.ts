import { describe, expect, it } from "vitest";
import {
  emptyInventory,
  inventoryFilters,
  inventoryIdsPath,
  inventoryPath,
  selectionNote,
  setDifference,
  toggled,
  withIds,
} from "./deviceInventory";

const group = "00000000-0000-4000-8000-0000000000a1";
const version = "00000000-0000-4000-8000-0000000000b1";

describe("inventory addresses", () => {
  it("asks for the default page with nothing but its size", () => {
    expect(inventoryPath({})).toBe("/devices/inventory?page_size=50");
    expect(inventoryPath({ page: 1, size: 25 })).toBe(
      "/devices/inventory?page_size=25",
    );
  });

  it("names filters, order and page the way the server does", () => {
    const path = inventoryPath({
      q: "  edge 01 ",
      status: "failed",
      view: "drift",
      group,
      version,
      running: version,
      sort: "events",
      dir: "desc",
      page: 3,
      size: 100,
    });
    const params = new URL(path, "http://x").searchParams;
    expect(Object.fromEntries(params)).toEqual({
      q: "edge 01",
      status: "failed",
      view: "not_on_desired",
      group,
      desired_version: version,
      running_version: version,
      sort: "events_in",
      dir: "desc",
      page: "3",
      page_size: "100",
    });
    expect(inventoryFilters({ sort: "vector", dir: "asc" }).get("sort")).toBe(
      "version",
    );
  });

  it("leaves empty filters and a bare direction out, and keeps searches short", () => {
    expect(inventoryFilters({ q: "  ", status: "", dir: "desc" }).size).toBe(0);
    expect(inventoryFilters({ q: "x".repeat(300) }).get("q")).toHaveLength(100);
  });

  it("repeats the same filters, never a page, to select every match", () => {
    const filters = { q: "web", status: "offline", group, sort: "name" };
    expect(inventoryIdsPath({ ...filters, dir: "asc", page: 4, size: 25 })).toBe(
      `/devices/inventory/ids?q=web&status=offline&group=${group}&sort=name&dir=asc`,
    );
  });

  it("starts a page empty, with zero counts the page never shows as data", () => {
    const empty = emptyInventory(2, 25);
    expect(empty).toMatchObject({ items: [], total: 0, page: 2, page_size: 25 });
    expect(empty.counts.status.revoked).toBe(0);
  });
});

describe("selecting matches", () => {
  it("says how many were selected, and says so when the limit cut them short", () => {
    expect(selectionNote({ ids: ["a"], total: 1, truncated: false })).toBe(
      "Selected the 1 matching device.",
    );
    expect(
      selectionNote({ ids: Array(3), total: 3, truncated: false }),
    ).toBe("Selected all 3 matching devices.");
    expect(selectionNote({ ids: [], total: 0, truncated: false })).toBe(
      "No devices match.",
    );
    expect(
      selectionNote({ ids: Array(10000), total: 12431, truncated: true }),
    ).toBe(
      "Selected the first 10,000 of 12,431 matching devices. Narrow the search to select the rest.",
    );
  });

  it("changes a copy of the selection, never the one that was passed", () => {
    const before = new Set(["a", "b"]);
    expect([...withIds(before, ["b", "c"])]).toEqual(["a", "b", "c"]);
    expect([...toggled(before, "a")]).toEqual(["b"]);
    expect([...toggled(before, "z")]).toEqual(["a", "b", "z"]);
    expect([...before]).toEqual(["a", "b"]);
  });

  it("compares two selections in one pass", () => {
    expect(
      setDifference(new Set(["a", "c", "d"]), new Set(["a", "b", "c"])),
    ).toEqual({ added: ["d"], removed: ["b"] });
    expect(setDifference(new Set(), new Set())).toEqual({
      added: [],
      removed: [],
    });
  });

  it("compares 10,000 selections without noticing", () => {
    const saved = new Set(Array.from({ length: 10000 }, (_, n) => `id-${n}`));
    const now = new Set(saved);
    now.delete("id-1");
    now.add("new");
    const started = performance.now();
    const { added, removed } = setDifference(now, saved);
    expect(performance.now() - started).toBeLessThan(200);
    expect(added).toEqual(["new"]);
    expect(removed).toEqual(["id-1"]);
  });
});
