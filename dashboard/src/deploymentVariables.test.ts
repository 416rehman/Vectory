import { describe, expect, it } from "vitest";
import { pastedValues, resolveVariableBindings } from "./deploymentVariables";

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
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("future group members")]),
    );
    expect(
      resolveVariableBindings(
        declarations,
        inputs,
        ["device-a", "device-b"],
        false,
      ).errors,
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("1 selected device")]),
    );
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

describe("pasted per-device values", () => {
  const devices = [
    { id: "id-fra", name: "edge-fra-01" },
    { id: "id-nyc", name: "edge-nyc-01" },
  ];
  it("fills values by device name from CSV or a spreadsheet copy", () => {
    expect(
      pastedValues(
        "device,SITE,COUNT\nedge-fra-01,fra,3\nEDGE-NYC-01\tnyc\t\nedge-lon-01,lon,1\n",
        declarations.slice(0, 2),
        devices,
      ),
    ).toEqual({
      values: {
        "id-fra": { SITE: "fra", COUNT: "3" },
        "id-nyc": { SITE: "nyc" },
      },
      applied: 2,
      unknown: ["edge-lon-01"],
    });
  });
});
