import { describe, expect, it } from "vitest";
import { matchesTableFilter, sortTableRows } from "./dataTableModel";

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
