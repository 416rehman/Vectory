import { describe, expect, it } from "vitest";
import { variableErrors, variableFields } from "./variableFields";

const config = {
  api: { enabled: false, address: "127.0.0.1:8686" },
  sources: {
    input: { type: "demo_logs", format: "json", interval: 2 },
  },
  transforms: {
    sample: { type: "sample", inputs: ["input"], rate: 10 },
  },
  sinks: {
    output: {
      type: "http",
      inputs: ["sample"],
      uri: "https://example.test/ingest",
      auth: { password: "example" },
      headers: { authorization: "secret" },
      tls: { ca_file: "/etc/ca.pem" },
    },
  },
};

describe("device-specific variable fields", () => {
  it("offers typed scalar leaves while excluding structure, arrays, and secret paths", () => {
    const fields = variableFields(config);
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/sources/input/format",
          type: "string",
        }),
        expect.objectContaining({
          path: "/transforms/sample/rate",
          type: "integer",
        }),
        expect.objectContaining({
          path: "/sinks/output/uri",
          type: "string",
        }),
      ]),
    );
    expect(fields.map((field) => field.path)).not.toEqual(
      expect.arrayContaining([
        "/sources/input/type",
        "/transforms/sample/inputs/0",
        "/sinks/output/auth/password",
        "/sinks/output/headers/authorization",
        "/api/address",
        "/sinks/output/tls/ca_file",
      ]),
    );
  });

  it("flags stale paths and type changes after code edits without dropping declarations", () => {
    expect(
      variableErrors(config, [
        { name: "SITE", path: "/sources/input/format", type: "string" },
      ]),
    ).toEqual([]);
    expect(
      variableErrors(config, [
        { name: "SITE", path: "/sources/input/format", type: "integer" },
        { name: "SITE", path: "/sources/gone/format", type: "string" },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("used more than once"),
        expect.stringContaining("is now string"),
        expect.stringContaining("no longer points"),
      ]),
    );
  });
});
