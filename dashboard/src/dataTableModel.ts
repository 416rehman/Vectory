export type TableValue = string | number | boolean | null | undefined;
export type TableSort = { column: string; direction: "asc" | "desc" };
export type TableValueColumn<T> = {
  id: string;
  value?: (row: T) => TableValue;
  sortValue?: (row: T) => TableValue;
};

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// Missing values stay last in both directions; ties preserve the supplied order.
export function sortTableRows<T>(
  rows: T[],
  columns: TableValueColumn<T>[],
  sort: TableSort | null,
): T[] {
  if (!sort) return rows;
  const column = columns.find((item) => item.id === sort.column);
  const value = column?.sortValue || column?.value;
  if (!value) return rows;
  return rows
    .map((row, index) => ({ row, index, value: value(row) }))
    .sort((a, b) => {
      const missingA =
        a.value == null ||
        (typeof a.value === "number" && !Number.isFinite(a.value));
      const missingB =
        b.value == null ||
        (typeof b.value === "number" && !Number.isFinite(b.value));
      if (missingA || missingB)
        return missingA === missingB ? a.index - b.index : missingA ? 1 : -1;
      const comparison =
        typeof a.value === "number" && typeof b.value === "number"
          ? a.value - b.value
          : typeof a.value === "boolean" && typeof b.value === "boolean"
            ? Number(a.value) - Number(b.value)
            : collator.compare(String(a.value), String(b.value));
      return comparison
        ? comparison * (sort.direction === "asc" ? 1 : -1)
        : a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * The first click sorts in the column's natural direction (newest first for
 * times); later clicks toggle it.
 */
export function nextSort(
  current: TableSort | null,
  column: string,
  defaultDirection: "asc" | "desc" = "asc",
): TableSort {
  if (current?.column !== column)
    return { column, direction: defaultDirection };
  return {
    column,
    direction: current.direction === "asc" ? "desc" : "asc",
  };
}

/** How many rows each option would keep, for counts beside filter choices. */
export function optionCounts<T>(
  rows: T[],
  value: (row: T) => TableValue | TableValue[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const values = value(row);
    for (const item of new Set(Array.isArray(values) ? values : [values])) {
      if (item === null || item === undefined) continue;
      const key = String(item);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

/** Clamp a requested page to the available range for a row count. */
export function clampPage(page: number, count: number, size: number) {
  const pages = Math.max(1, Math.ceil(count / Math.max(1, size)));
  return Math.min(Math.max(1, page), pages);
}

export function matchesTableFilter(
  value: TableValue,
  query: string,
  exact: boolean,
) {
  if (value == null) return false;
  return exact
    ? String(value) === query
    : String(value)
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase());
}
