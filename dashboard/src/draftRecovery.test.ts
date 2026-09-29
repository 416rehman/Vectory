import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRecoveryDraft,
  holdsPlainCredential,
  readRecoveryDraft,
  storeRecoveryDraft,
} from "./draftRecovery";

const draft = {
  revision: 4,
  config: {
    sources: { app: { type: "demo_logs", format: "json" } },
    sinks: {
      out: {
        type: "http",
        inputs: ["app"],
        uri: "https://collector.example/ingest",
        auth: { strategy: "bearer", token: "SECRET[vault.ingest_token]" },
      },
    },
  },
  positions: { app: { x: 60, y: 100 }, out: { x: 350, y: 100 } },
  variables: [],
};

describe("draft recovery", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    });
  });

  it("keeps unsaved edits per account and pipeline until cleared", () => {
    expect(storeRecoveryDraft("user-1", "pipe-1", draft)).toBe(true);
    expect(readRecoveryDraft("user-1", "pipe-1")).toMatchObject({
      revision: 4,
      config: draft.config,
      positions: draft.positions,
    });
    expect(readRecoveryDraft("user-2", "pipe-1")).toBeNull();
    expect(readRecoveryDraft("user-1", "pipe-2")).toBeNull();
    clearRecoveryDraft("user-1", "pipe-1");
    expect(readRecoveryDraft("user-1", "pipe-1")).toBeNull();
  });

  it("never writes plain credentials to browser storage", () => {
    storeRecoveryDraft("user-1", "pipe-1", draft);
    const plain = structuredClone(draft);
    plain.config.sinks.out.auth.token = "abc123-plain";
    expect(holdsPlainCredential(plain.config)).toBe(true);
    expect(storeRecoveryDraft("user-1", "pipe-1", plain)).toBe(false);
    // The earlier copy is removed rather than left behind as stale.
    expect(readRecoveryDraft("user-1", "pipe-1")).toBeNull();
    expect(
      holdsPlainCredential({ auth: { password: "${INGEST_PASSWORD}" } }),
    ).toBe(false);
    expect(
      holdsPlainCredential({
        auth: { user: "svc", password: "vectory-secret:ingest" },
      }),
    ).toBe(false);
  });

  it("ignores damaged or foreign stored values", () => {
    for (const value of [
      "not json",
      JSON.stringify({
        ...draft,
        revision: "4",
        saved_at: "2026-09-29T10:00:00Z",
      }),
      JSON.stringify({ ...draft, saved_at: "yesterday" }),
      JSON.stringify({
        ...draft,
        saved_at: "2026-09-29T10:00:00Z",
        positions: { app: { x: "1", y: 2 } },
      }),
    ]) {
      localStorage.setItem("vectory.draft.v1:user-1:pipe-1", value);
      expect(readRecoveryDraft("user-1", "pipe-1")).toBeNull();
    }
  });
});
