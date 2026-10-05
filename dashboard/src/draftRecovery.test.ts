import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRecoveryDraft,
  holdsPlainCredential,
  listRecoveryDrafts,
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
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    });
  });

  it("keeps unsaved edits per account and pipeline until cleared", () => {
    const withBase = {
      ...draft,
      base: {
        config: structuredClone(draft.config),
        variables: [],
        positions: structuredClone(draft.positions),
      },
    };
    expect(storeRecoveryDraft("user-1", "pipe-1", withBase)).toBe(true);
    expect(readRecoveryDraft("user-1", "pipe-1")).toMatchObject({
      revision: 4,
      config: draft.config,
      positions: draft.positions,
      base: withBase.base,
    });
    expect(readRecoveryDraft("user-2", "pipe-1")).toBeNull();
    expect(readRecoveryDraft("user-1", "pipe-2")).toBeNull();
    clearRecoveryDraft("user-1", "pipe-1");
    expect(readRecoveryDraft("user-1", "pipe-1")).toBeNull();
  });

  it("keeps two tabs' copies separate and lets the operator select either", () => {
    const first = {
      ...draft,
      config: { ...draft.config, api: { enabled: true } },
    };
    const second = {
      ...draft,
      config: { ...draft.config, api: { enabled: false } },
    };
    expect(
      storeRecoveryDraft(
        "user-1",
        "pipe-1",
        first,
        new Date("2026-10-04T10:00:00Z"),
        "tab-a",
      ),
    ).toBe(true);
    expect(
      storeRecoveryDraft(
        "user-1",
        "pipe-1",
        second,
        new Date("2026-10-04T10:01:00Z"),
        "tab-b",
      ),
    ).toBe(true);
    const copies = listRecoveryDrafts("user-1", "pipe-1");
    expect(copies).toHaveLength(2);
    expect(copies.map(({ draft }) => draft.config.api)).toEqual([
      { enabled: false },
      { enabled: true },
    ]);
    clearRecoveryDraft("user-1", "pipe-1", copies[0].id);
    expect(listRecoveryDrafts("user-1", "pipe-1")).toMatchObject([
      { draft: { config: first.config } },
    ]);
    // A key from another account cannot be cleared through this pipeline.
    clearRecoveryDraft("user-2", "pipe-1", copies[1].id);
    expect(listRecoveryDrafts("user-1", "pipe-1")).toHaveLength(1);
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
        sinks: {
          out: {
            type: "splunk_hec_logs",
            default_token: "vectory-secret:INGEST",
          },
        },
      }),
    ).toBe(false);
    const unsafeUrl = structuredClone(draft);
    unsafeUrl.config.sinks.out.uri =
      "https://collector.example/ingest?api_key=plaintext-token";
    expect(storeRecoveryDraft("user-1", "pipe-1", unsafeUrl)).toBe(false);
    const unsupportedReference = structuredClone(draft);
    unsupportedReference.config.sinks.out.uri =
      "https://collector.example/ingest?api_key=vectory-secret:INGEST";
    expect(storeRecoveryDraft("user-1", "pipe-1", unsupportedReference)).toBe(
      false,
    );
    const unsafeBase = {
      ...draft,
      base: {
        config: structuredClone(draft.config),
        variables: [],
        positions: draft.positions,
      },
    };
    unsafeBase.base.config.sinks.out.auth.token = "plain-base-token";
    expect(storeRecoveryDraft("user-1", "pipe-1", unsafeBase)).toBe(true);
    expect(readRecoveryDraft("user-1", "pipe-1")?.base).toBeUndefined();
    expect(readRecoveryDraft("user-1", "pipe-1")?.config).toEqual(draft.config);
  });

  it("rejects credential-shaped metadata and declarations before writing a recovery copy", () => {
    const key = "vectory.draft.v2:user-1:pipe-1:tab-a";
    const safe = {
      ...draft,
      metadata: { name: "Pipeline", description: "Receives logs" },
    };
    expect(
      storeRecoveryDraft("user-1", "pipe-1", safe, new Date(), "tab-a"),
    ).toBe(true);
    const unsafeMetadata = {
      ...safe,
      metadata: {
        ...safe.metadata,
        description: "https://user:literal-secret@example.test/ingest",
      },
    };
    expect(
      storeRecoveryDraft(
        "user-1",
        "pipe-1",
        unsafeMetadata,
        new Date(),
        "tab-a",
      ),
    ).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();

    const unsafeDeclaration = {
      ...safe,
      variables: [
        {
          name: "ghp_syntheticcredential123",
          path: "sources.app.host",
          type: "string" as const,
        },
      ],
    };
    expect(
      storeRecoveryDraft(
        "user-1",
        "pipe-1",
        unsafeDeclaration,
        new Date(),
        "tab-a",
      ),
    ).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();

    const unsafeBase = {
      ...safe,
      base: {
        config: safe.config,
        positions: safe.positions,
        variables: [],
        metadata: unsafeMetadata.metadata,
      },
    };
    expect(
      storeRecoveryDraft("user-1", "pipe-1", unsafeBase, new Date(), "tab-a"),
    ).toBe(true);
    expect(readRecoveryDraft("user-1", "pipe-1")?.base).toBeUndefined();
  });

  it("keeps current edits without a large merge base and clears an obsolete copy when even current edits do not fit", () => {
    const largeVariables = [
      {
        name: "v".repeat(800_000),
        path: "sources.app.host",
        type: "string" as const,
      },
    ];
    const large = {
      ...draft,
      variables: largeVariables,
      base: {
        config: draft.config,
        variables: largeVariables,
        positions: draft.positions,
      },
    };
    expect(storeRecoveryDraft("user-1", "pipe-1", large)).toBe(true);
    expect(readRecoveryDraft("user-1", "pipe-1")?.base).toBeUndefined();
    expect(
      readRecoveryDraft("user-1", "pipe-1")?.variables[0].name.length,
    ).toBe(800_000);

    const tooLarge = {
      ...large,
      variables: [
        {
          name: "v".repeat(1_600_000),
          path: "sources.app.host",
          type: "string" as const,
        },
      ],
    };
    expect(storeRecoveryDraft("user-1", "pipe-1", tooLarge)).toBe(false);
    expect(readRecoveryDraft("user-1", "pipe-1")).toBeNull();
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
      JSON.stringify({
        ...draft,
        saved_at: "2026-09-29T10:00:00Z",
        base: {
          config: {},
          variables: [],
          positions: { app: { x: NaN, y: 2 } },
        },
      }),
    ]) {
      localStorage.setItem("vectory.draft.v1:user-1:pipe-1", value);
      expect(readRecoveryDraft("user-1", "pipe-1")).toBeNull();
    }
  });

  it("clears an older stored draft containing a newly recognized credential", () => {
    const old = structuredClone(draft);
    old.config.sinks.out.uri =
      "https://discord.com/api/webhooks/123/long-webhook-token";
    const storageKey = "vectory.draft.v1:user-1:pipe-1";
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ...old, saved_at: new Date().toISOString() }),
    );
    expect(readRecoveryDraft("user-1", "pipe-1")).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("removes an older recovery copy with credential-shaped metadata", () => {
    const storageKey = "vectory.draft.v1:user-1:pipe-1";
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...draft,
        metadata: {
          name: "Pipeline",
          description: "https://collector.example/?api_key=short",
        },
        saved_at: new Date().toISOString(),
      }),
    );
    expect(readRecoveryDraft("user-1", "pipe-1")).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
});
