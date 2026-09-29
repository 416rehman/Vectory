export type FieldChange = {
  path: string;
  kind: "added" | "changed" | "removed";
  before?: unknown;
  after?: unknown;
};

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const segment = (key: string) =>
  /^[A-Za-z_@][\w@]*$/.test(key) ? key : JSON.stringify(key);

/** Leaf paths of an event in VRL path syntax (`.a.b`, `."x y"`); arrays are leaves. */
export function flattenEvent(
  value: unknown,
  prefix = "",
  out = new Map<string, unknown>(),
): Map<string, unknown> {
  if (!record(value)) {
    if (prefix) out.set(prefix, value);
    return out;
  }
  const keys = Object.keys(value);
  if (!keys.length && prefix) out.set(prefix, {});
  for (const key of keys)
    flattenEvent(value[key], `${prefix}.${segment(key)}`, out);
  return out;
}

const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Field-level changes from a sample to the event a step emitted. */
export function diffEvents(before: unknown, after: unknown): FieldChange[] {
  const left = flattenEvent(before),
    right = flattenEvent(after);
  const changes: FieldChange[] = [];
  for (const [path, value] of right) {
    if (!left.has(path)) changes.push({ path, kind: "added", after: value });
    else if (!same(left.get(path), value))
      changes.push({
        path,
        kind: "changed",
        before: left.get(path),
        after: value,
      });
  }
  for (const [path, value] of left)
    if (!right.has(path))
      changes.push({ path, kind: "removed", before: value });
  const rank = { changed: 0, added: 1, removed: 2 };
  return changes.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path),
  );
}

/** Display a value compactly; timestamps use VRL's `t'…'` literal. */
export function displayValue(value: unknown, timestamp = false): string {
  if (timestamp && typeof value === "string") return `t'${value}'`;
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "—";
  const text = JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}
