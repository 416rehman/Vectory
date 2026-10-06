import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DiagnosticSchema, VectorLogGroupSchema } from "./runtimeModel";

// The server stores the IDs a device reports as they are sent, up to 128 UTF-8
// bytes of any letters, digits, spaces and punctuation Vector accepts. What it
// stores must read back, or one component with a long or non-ASCII name would
// break the device's page. The server's and the agent's rules read the same
// fixture, which says which IDs a device may report.

type Id = string | Id[] | { repeat: Id; times: number };
type Fixture = {
  max_bytes: number;
  cases: { name: string; id: Id; valid: boolean }[];
};
const fixture: Fixture = JSON.parse(
  readFileSync(
    new URL(
      "vector-catalog/fixtures/component-ids.json",
      new URL("../../", import.meta.url),
    ),
    "utf8",
  ),
);
// An id is a string, a list of ids joined together, or an id repeated.
const idOf = (id: Id): string =>
  typeof id === "string"
    ? id
    : Array.isArray(id)
      ? id.map(idOf).join("")
      : idOf(id.repeat).repeat(id.times);

const diagnostic = (extra: Record<string, unknown>) => ({
  severity: "error",
  code: "VRL_E100",
  message: "Mapping failed.",
  ...extra,
});

const group = (extra: Record<string, unknown>) => ({
  fingerprint: "0123456789abcdef",
  level: "error",
  message: "Mapping failed with event.",
  count: 1,
  first_seen: "2026-10-03T00:00:00Z",
  last_seen: "2026-10-03T00:00:01Z",
  ...extra,
});

describe("the component IDs and output names a device reports", () => {
  it("read back, in a diagnostic and in a log group, for every ID the shared fixture allows", () => {
    const allowed = fixture.cases.filter((c) => c.valid);
    expect(allowed.length).toBeGreaterThan(10);
    for (const { name, id } of allowed) {
      const text = idOf(id);
      expect(
        DiagnosticSchema.safeParse(
          diagnostic({ component_id: text, route_output: text }),
        ).success,
        name,
      ).toBe(true);
      expect(
        VectorLogGroupSchema.safeParse(group({ component_id: text })).success,
        name,
      ).toBe(true);
    }
  });

  it("stop at the bound the server keeps", () => {
    expect(fixture.max_bytes).toBe(128);
    const tooLong = "x".repeat(fixture.max_bytes + 1);
    expect(
      DiagnosticSchema.safeParse(diagnostic({ component_id: tooLong })).success,
    ).toBe(false);
    expect(
      DiagnosticSchema.safeParse(diagnostic({ route_output: tooLong })).success,
    ).toBe(false);
    expect(
      VectorLogGroupSchema.safeParse(group({ component_id: tooLong })).success,
    ).toBe(false);
  });
});
