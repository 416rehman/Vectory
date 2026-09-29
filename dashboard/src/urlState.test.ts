import { describe, expect, it } from "vitest";
import { parseQuery, serializeQuery } from "./urlState";

const defaults = { q: "", status: "", page: 1, size: 25, sort: "name" };

describe("URL-synced table state", () => {
  it("reads typed values and falls back for missing or invalid ones", () => {
    expect(
      parseQuery("?q=edge&status=offline&page=3&size=50", defaults),
    ).toEqual({
      q: "edge",
      status: "offline",
      page: 3,
      size: 50,
      sort: "name",
    });
    expect(parseQuery("page=0&size=abc&unknown=1", defaults)).toEqual(defaults);
    expect(parseQuery("page=-2&size=1.5", defaults)).toEqual(defaults);
    expect(parseQuery("", defaults)).toEqual(defaults);
  });

  it("bounds free text and decodes it safely", () => {
    const long = "x".repeat(500);
    expect(parseQuery(`q=${long}`, defaults).q).toHaveLength(200);
    expect(parseQuery("q=a%20b%26c", defaults).q).toBe("a b&c");
  });

  it("writes only non-default values so shared links stay short", () => {
    expect(serializeQuery(defaults, defaults)).toBe("");
    expect(
      serializeQuery({ ...defaults, status: "failing", page: 2 }, defaults),
    ).toBe("status=failing&page=2");
    expect(serializeQuery({ ...defaults, q: "a b&c" }, defaults)).toBe(
      "q=a+b%26c",
    );
  });

  it("keeps unrelated parameters and drops cleared ones", () => {
    const extra = new URLSearchParams("device=abc&status=offline");
    expect(serializeQuery({ ...defaults }, defaults, extra)).toBe("device=abc");
    expect(
      serializeQuery({ ...defaults, status: "paused" }, defaults, extra),
    ).toBe("device=abc&status=paused");
  });

  it("round-trips every value", () => {
    const value = {
      q: "web ams",
      status: "offline",
      page: 4,
      size: 100,
      sort: "last_seen",
    };
    expect(parseQuery(serializeQuery(value, defaults), defaults)).toEqual(
      value,
    );
  });
});
