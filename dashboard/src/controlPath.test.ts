import { describe, expect, it } from "vitest";
import { controlPathFor } from "./controlPath";

describe("the control a field path points at", () => {
  const form = ["uri", "encoding", "auth", "auth.auth", "auth.auth.token"];

  it("is the control with that exact path", () => {
    expect(controlPathFor("uri", form)).toBe("uri");
    expect(controlPathFor("auth", form)).toBe("auth");
    expect(controlPathFor("auth.auth.token", form)).toBe("auth.auth.token");
  });

  it("is the one control that ends in the same setting through the same names", () => {
    expect(controlPathFor("auth.token", form)).toBe("auth.auth.token");
    expect(
      controlPathFor("tls.key_pass", [
        "tls",
        "tls.options",
        "tls.options.key_pass",
      ]),
    ).toBe("tls.options.key_pass");
  });

  it("never guesses: no match, a different parent or two candidates match nothing", () => {
    expect(
      controlPathFor("batch.max_size", ["buffer.max_size"]),
    ).toBeUndefined();
    expect(controlPathFor("auth.token", ["auth", "auth.user"])).toBeUndefined();
    expect(
      controlPathFor("auth.token", ["auth.a.token", "auth.b.token"]),
    ).toBeUndefined();
    expect(controlPathFor("token", ["auth.token"])).toBe("auth.token");
    expect(
      controlPathFor("token", ["auth.token", "tls.token"]),
    ).toBeUndefined();
    expect(controlPathFor("auth.token", [])).toBeUndefined();
    // A path of its own length that differs is not a deeper form of it.
    expect(controlPathFor("auth.token", ["tls.token"])).toBeUndefined();
  });
});
