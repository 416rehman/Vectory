import { describe, expect, it } from "vitest";
import { diagnoseJSONValue } from "./SchemaValueEditor";
import root from "./generated/vector-schema.json";

describe("JSON field diagnostics", () => {
  it.each([
    null,
    false,
    12.5,
    "text",
    [1, 2],
    { extension: { untouched: true } },
  ])("preserves JSON value %j", (value) => {
    const result = diagnoseJSONValue(JSON.stringify(value));
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual(value);
  });
  it("rejects duplicate keys and positions the duplicate", () => {
    const text = '{"amount":1,"amount":2}';
    const result = diagnoseJSONValue(text);
    expect(result.parseValid).toBe(false);
    expect(result.diagnostics[0].from).toBeGreaterThan(1);
    expect(result.diagnostics[0].message).toMatch(/unique/i);
  });
  it.each([
    '{"amount":}',
    '{"amount":1,}',
    '{"amount":9007199254740993}',
    '{"amount":1e1000}',
  ])("never accepts malformed/lossy JSON %s", (text) => {
    const result = diagnoseJSONValue(text);
    expect(result.parseValid).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.from).toBeGreaterThanOrEqual(0);
      expect(diagnostic.to).toBeLessThanOrEqual(text.length);
    }
  });
  it("checks known bounds, required fields, additional properties and list item types", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["amount"],
      properties: {
        amount: { type: "integer", minimum: 1 },
        items: { type: "array", items: { type: "number" } },
      },
    };
    expect(
      diagnoseJSONValue('{"amount":0}', { schema }).diagnostics.join(),
    ).not.toBe("");
    expect(diagnoseJSONValue("{}", { schema }).diagnostics[0].message).toMatch(
      /amount/,
    );
    expect(
      diagnoseJSONValue('{"amount":2,"extra":true}', { schema }).diagnostics
        .length,
    ).toBeGreaterThan(0);
    expect(
      diagnoseJSONValue('{"amount":2,"items":["bad"]}', { schema }).diagnostics
        .length,
    ).toBeGreaterThan(0);
    expect(
      diagnoseJSONValue('{"amount":2,"items":[3]}', { schema }).diagnostics,
    ).toEqual([]);
  });
  it("keeps native numeric interpolation intact without allowing invalid literal numbers", () => {
    const schema = {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1 } },
    };
    expect(
      diagnoseJSONValue('{"limit":"${LIMIT}"}', { schema }).diagnostics,
    ).toEqual([]);
    expect(
      diagnoseJSONValue('{"limit":0}', { schema }).diagnostics.length,
    ).toBeGreaterThan(0);
  });
  it("preserves forbidden tuple items when validating nested values", () => {
    const schema = {
      type: "array",
      prefixItems: [{ type: "integer" }],
      items: false,
    };
    expect(diagnoseJSONValue("[1]", { schema }).diagnostics).toEqual([]);
    expect(
      diagnoseJSONValue("[1,2]", { schema }).diagnostics.length,
    ).toBeGreaterThan(0);
  });
  it("rejects nested plaintext credentials but does not echo their value", () => {
    const result = diagnoseJSONValue(
      '{"auth":{"user":"private-user","password":"private-password"}}',
    );
    expect(result.diagnostics).toHaveLength(2);
    expect(JSON.stringify(result.diagnostics)).not.toContain("private-user");
    expect(JSON.stringify(result.diagnostics)).not.toContain(
      "private-password",
    );
    expect(
      diagnoseJSONValue(
        '{"auth":{"user":"${USER}","password":"SECRET[local.password]"}}',
      ).diagnostics,
    ).toEqual([]);
  });
  it("propagates sensitive-array metadata and uses exact auth field paths", () => {
    expect(
      diagnoseJSONValue('["literal"]', {
        schema: {
          type: "array",
          items: { type: "string" },
          _metadata: { sensitive: true },
        },
        label: "Tokens",
      }).diagnostics.length,
    ).toBeGreaterThan(0);
    expect(
      diagnoseJSONValue('"literal"', {
        schema: { type: "string" },
        path: "sinks.output.auth.user",
      }).diagnostics.length,
    ).toBeGreaterThan(0);
    expect(
      diagnoseJSONValue('["${TOKEN}"]', {
        schema: {
          type: "array",
          items: { type: "string" },
          _metadata: { sensitive: true },
        },
      }).diagnostics,
    ).toEqual([]);
  });
  it("blocks credential headers and URL userinfo using the backend's reference rules", () => {
    expect(
      diagnoseJSONValue(
        '{"Authorization":"Bearer literal","url":"https://user:password@example.test"}',
      ).diagnostics,
    ).toHaveLength(2);
    expect(
      diagnoseJSONValue(
        '{"Authorization":"Bearer ${TOKEN}","url":"https://${USER}:${PASSWORD}@example.test"}',
      ).diagnostics,
    ).toEqual([]);
  });
  it("allows provider containers and resource paths, and distinguishes synthetic event data", () => {
    expect(
      diagnoseJSONValue(
        '{"local":{"type":"file","path":"/etc/vector/secrets.json"}}',
        { path: "secret" },
      ).diagnostics,
    ).toEqual([]);
    expect(
      diagnoseJSONValue('{"private_key_file":"/etc/vector/key.pem"}')
        .diagnostics,
    ).toEqual([]);
    expect(
      diagnoseJSONValue('{"token":"synthetic-event-data"}', {
        protectCredentials: false,
      }).diagnostics,
    ).toEqual([]);
  });
  it("validates actual HTTP auth schema and permits intentional strategy changes", () => {
    const schema = {
      $ref: "#/definitions/core::option::Option<vector::http::Auth>",
    };
    expect(
      diagnoseJSONValue('{"strategy":"bearer","token":"${TOKEN}"}', {
        schema,
        root,
        path: "auth",
      }).diagnostics,
    ).toEqual([]);
    expect(
      diagnoseJSONValue(
        '{"strategy":"basic","user":"${USER}","password":"${PASSWORD}"}',
        { schema, root, path: "auth" },
      ).diagnostics,
    ).toEqual([]);
    expect(
      diagnoseJSONValue('{"strategy":"bearer"}', { schema, root, path: "auth" })
        .diagnostics.length,
    ).toBeGreaterThan(0);
  });
  it("preserves arbitrary own keys without mutating object prototypes", () => {
    const checked = diagnoseJSONValue('{"__proto__":{"proof":true}}');
    expect(checked.diagnostics).toEqual([]);
    expect(Object.hasOwn(checked.value, "__proto__")).toBe(true);
    expect(({} as any).proof).toBeUndefined();
  });
  it("bounds overly large and deep fields", () => {
    expect(
      diagnoseJSONValue(JSON.stringify("x".repeat(1_048_576))).parseValid,
    ).toBe(false);
    expect(
      diagnoseJSONValue("[".repeat(65) + "1" + "]".repeat(65)).parseValid,
    ).toBe(false);
    expect(
      diagnoseJSONValue("[".repeat(10_000) + "1" + "]".repeat(10_000))
        .parseValid,
    ).toBe(false);
    expect(
      diagnoseJSONValue(JSON.stringify("[".repeat(1000) + '"\\')).diagnostics,
    ).toEqual([]);
  });
});
