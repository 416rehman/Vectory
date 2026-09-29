import { describe, expect, it } from "vitest";
import {
  clampPage,
  matchesTableFilter,
  nextSort,
  optionCounts,
  sortTableRows,
} from "./dataTableModel";

describe("table order", () => {
  const rows = [
    { id: "first", value: 10 },
    { id: "missing", value: null },
    { id: "second", value: 2 },
    { id: "zero", value: 0 },
    { id: "tie", value: 2 },
  ];
  const columns = [
    { id: "value", value: (row: (typeof rows)[number]) => row.value },
  ];
  it("sorts numeric values globally before a page is selected, preserving stable ties", () => {
    const result = sortTableRows(rows, columns, {
      column: "value",
      direction: "asc",
    });
    expect(result.map((row) => row.id)).toEqual([
      "zero",
      "second",
      "tie",
      "first",
      "missing",
    ]);
    expect(result.slice(0, 2).map((row) => row.id)).toEqual(["zero", "second"]);
    expect(rows[0].id).toBe("first");
  });
  it("keeps missing measurements last while preserving a real zero in descending order", () => {
    expect(
      sortTableRows(rows, columns, { column: "value", direction: "desc" }).map(
        (row) => row.id,
      ),
    ).toEqual(["first", "second", "tie", "zero", "missing"]);
  });
  it("orders names naturally and does not reorder rows for an unavailable column", () => {
    const values = ["device10", "Device2", "device1"];
    expect(
      sortTableRows(values, [{ id: "name", value: (row) => row }], {
        column: "name",
        direction: "asc",
      }),
    ).toEqual(["device1", "Device2", "device10"]);
    expect(
      sortTableRows(values, [], { column: "missing", direction: "asc" }),
    ).toBe(values);
  });
});

describe("table filters", () => {
  it("matches categorical values exactly rather than including similar states", () => {
    expect(matchesTableFilter("inactive", "active", true)).toBe(false);
    expect(matchesTableFilter("active", "active", true)).toBe(true);
  });
  it("matches normalized text and retains false/zero without inventing missing values", () => {
    expect(matchesTableFilter("Device North", " NORTH ", false)).toBe(true);
    expect(matchesTableFilter(false, "false", true)).toBe(true);
    expect(matchesTableFilter(0, "0", true)).toBe(true);
    expect(matchesTableFilter(null, "null", true)).toBe(false);
  });
});

describe("table interaction model", () => {
  it("sorts time columns newest first on the first click, then toggles", () => {
    const first = nextSort(null, "last_seen", "desc");
    expect(first).toEqual({ column: "last_seen", direction: "desc" });
    expect(nextSort(first, "last_seen", "desc")).toEqual({
      column: "last_seen",
      direction: "asc",
    });
    expect(nextSort(first, "name")).toEqual({
      column: "name",
      direction: "asc",
    });
  });

  it("counts how many rows each filter option keeps", () => {
    const rows = [
      { state: "online", groups: ["edge", "eu"] },
      { state: "offline", groups: ["edge"] },
      { state: "online", groups: [] },
      { state: null, groups: ["eu", "eu"] },
    ];
    const byState = optionCounts(rows, (row) => row.state);
    expect(Object.fromEntries(byState)).toEqual({ online: 2, offline: 1 });
    const byGroup = optionCounts(rows, (row) => row.groups);
    expect(Object.fromEntries(byGroup)).toEqual({ edge: 2, eu: 2 });
  });

  it("clamps pages to the available range", () => {
    expect(clampPage(5, 30, 25)).toBe(2);
    expect(clampPage(0, 30, 25)).toBe(1);
    expect(clampPage(3, 0, 25)).toBe(1);
  });
});
