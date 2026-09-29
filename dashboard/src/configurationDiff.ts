export type Difference = {
  path: (string | number)[];
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Compare values at their actual paths. Array order is part of Vector configuration. */
export function configurationDiff(
  before: unknown,
  after: unknown,
): Difference[] {
  const differences: Difference[] = [];
  function visit(left: unknown, right: unknown, path: (string | number)[]) {
    if (left === right) return;
    if (object(left) && object(right)) {
      for (const key of [
        ...new Set([...Object.keys(left), ...Object.keys(right)]),
      ].sort()) {
        if (!Object.hasOwn(left, key))
          differences.push({
            path: [...path, key],
            kind: "added",
            after: right[key],
          });
        else if (!Object.hasOwn(right, key))
          differences.push({
            path: [...path, key],
            kind: "removed",
            before: left[key],
          });
        else visit(left[key], right[key], [...path, key]);
      }
    } else if (Array.isArray(left) && Array.isArray(right)) {
      for (
        let index = 0;
        index < Math.max(left.length, right.length);
        index++
      ) {
        if (index >= left.length)
          differences.push({
            path: [...path, index],
            kind: "added",
            after: right[index],
          });
        else if (index >= right.length)
          differences.push({
            path: [...path, index],
            kind: "removed",
            before: left[index],
          });
        else visit(left[index], right[index], [...path, index]);
      }
    } else
      differences.push({ path, kind: "changed", before: left, after: right });
  }
  visit(before, after, []);
  return differences;
}

export function differencePath(path: Difference["path"]): string {
  return (
    path.reduce<string>((label, segment) => {
      if (typeof segment === "number") return `${label}[${segment}]`;
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)
        ? `${label}${label ? "." : ""}${segment}`
        : `${label}[${JSON.stringify(segment)}]`;
    }, "") || "Configuration"
  );
}
