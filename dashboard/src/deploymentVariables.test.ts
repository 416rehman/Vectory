import { describe, expect, it } from "vitest";
import { resolveVariableBindings } from "./deploymentVariables";

const declarations = [
  { name: "SITE", path: "/api/address", type: "string" as const },
  { name: "COUNT", path: "/sources/input/count", type: "integer" as const },
  { name: "ENABLED", path: "/api/enabled", type: "boolean" as const },
];

describe("deployment variable bindings", () => {
  it("parses typed defaults and per-device overrides without changing target identity", () => {
    const result = resolveVariableBindings(
      declarations,
      {
        defaults: { SITE: "", COUNT: "2", ENABLED: "false" },
        devices: {
          "device-a": { SITE: "edge-a", COUNT: "3", ENABLED: "true" },
          "device-not-selected": { SITE: "ignored" },
        },
      },
      ["device-a", "device-b"],
      true,
    );
    expect(result.errors).toEqual([]);
    expect(result.bindings).toEqual({
      defaults: { SITE: "", COUNT: 2, ENABLED: false },
      devices: { "device-a": { SITE: "edge-a", COUNT: 3, ENABLED: true } },
    });
  });

  it("requires persistent defaults and complete snapshot coverage", () => {
    const inputs = {
      defaults: {},
      devices: { "device-a": { SITE: "edge-a", COUNT: "3", ENABLED: "true" } },
    };
    expect(
      resolveVariableBindings(declarations, inputs, ["device-a"], false).errors,
    ).toEqual([]);
    expect(
      resolveVariableBindings(declarations, inputs, ["device-a"], true).errors,
    ).toEqual(expect.arrayContaining([expect.stringContaining("future group members")]));
    expect(
      resolveVariableBindings(declarations, inputs, ["device-a", "device-b"], false).errors,
    ).toEqual(expect.arrayContaining([expect.stringContaining("1 selected device")]));
  });

  it("rejects unsafe values before preview", () => {
    const result = resolveVariableBindings(
      declarations,
      {
        defaults: {
          SITE: "https://user:pass@example.test",
          COUNT: "9007199254740992",
          ENABLED: "yes",
        },
        devices: {},
      },
      ["device-a"],
      false,
    );
    expect(result.errors).toHaveLength(3);
  });
});
