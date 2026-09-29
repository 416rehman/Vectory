import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  assertExactNumbers,
  parseExactJSON,
  stringifyExactJSON,
} from "./configurationNumbers";

describe("configuration numeric precision boundary", () => {
  it("rejects rounded integers on JSON read and nested outgoing writes", () => {
    expect(() =>
      parseExactJSON('{"request":{"retry_attempts":9223372036854775807}}'),
    ).toThrow("configuration.request.retry_attempts");
    expect(() =>
      stringifyExactJSON({
        config: {
          sources: { input: { limit: Number("18446744073709551615") } },
        },
      }),
    ).toThrow("not loaded or saved");
  });
  it("rejects YAML precision loss and nonfinite values before replacement", () => {
    expect(() =>
      assertExactNumbers(YAML.parse("max_bytes: 9223372036854775807")),
    ).toThrow("configuration.max_bytes");
    expect(() => assertExactNumbers({ ratio: Infinity })).toThrow(
      "configuration.ratio",
    );
  });
  it("round trips exact bounds, fractional settings, numeric-looking strings and references", () => {
    const value = {
      min: -9007199254740991,
      max: 9007199254740991,
      ratio: 0.125,
      text: "9223372036854775807",
      ref: "${MAX_BYTES}",
      empty: null,
    };
    expect(parseExactJSON(stringifyExactJSON(value))).toEqual(value);
  });
});
