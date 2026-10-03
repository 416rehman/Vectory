import { describe, expect, it } from "vitest";
import { refusedSave } from "./saveRefusal";

const plaintext = {
  message: "Plaintext credentials cannot be stored in draft history",
};

describe("a draft the server refused to store", () => {
  it("names the step and setting a plaintext credential is in, and keeps the edits", () => {
    const refusal = refusedSave(plaintext, {
      sources: { seed: { type: "demo_logs", format: "json" } },
      sinks: {
        out_http: {
          type: "http",
          inputs: ["seed"],
          uri: "http://127.0.0.1:9/ingest",
          encoding: { codec: "json" },
          auth: { strategy: "bearer", token: "plain-text-token" },
        },
      },
    });
    expect(refusal).toEqual({
      message:
        "Not saved. Replace the plaintext credential in auth.token on out_http with a device secret, such as vectory-secret:NAME. A draft never stores one. Your edits are still here.",
      component: "out_http",
      field: "auth.token",
    });
    // The value is never repeated back.
    expect(JSON.stringify(refusal)).not.toContain("plain-text-token");
  });

  it("goes to the first one when there are several", () => {
    const refusal = refusedSave(plaintext, {
      sinks: {
        a: {
          type: "http",
          inputs: [],
          auth: { strategy: "bearer", token: "x" },
        },
        b: {
          type: "http",
          inputs: [],
          auth: { strategy: "basic", user: "u", password: "p" },
        },
      },
    });
    expect(refusal.component).toBe("a");
    expect(refusal.field).toBe("auth.token");
  });

  it("says only what the server said when the draft doesn't show the cause", () => {
    // The server's rule is wider than the editor's own: no step is invented.
    expect(
      refusedSave(plaintext, {
        sinks: { out: { type: "blackhole", inputs: [] } },
      }),
    ).toEqual({
      message:
        "Not saved. Plaintext credentials cannot be stored in draft history. Your edits are still here.",
    });
    expect(
      refusedSave({ message: "Graph exceeds 1000 nodes or 5000 edges" }, {}),
    ).toEqual({
      message:
        "Not saved. Graph exceeds 1000 nodes or 5000 edges. Your edits are still here.",
    });
    expect(
      refusedSave({ message: "Description is too long." }, {}).message,
    ).toBe("Not saved. Description is too long. Your edits are still here.");
  });

  it("never points at a credential for a refusal about something else", () => {
    const refusal = refusedSave(
      { message: "Graph exceeds 1000 nodes or 5000 edges" },
      {
        sinks: {
          a: {
            type: "http",
            inputs: [],
            auth: { strategy: "bearer", token: "x" },
          },
        },
      },
    );
    expect(refusal.component).toBeUndefined();
    expect(refusal.field).toBeUndefined();
  });
});
