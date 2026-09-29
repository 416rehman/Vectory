import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  PipelineCreateReceiptSchema,
  PipelineRequestLookupSchema,
  PipelineRequestPageSchema,
} from "./api";

afterEach(() => vi.unstubAllGlobals());
const key = "00000000-0000-4000-8000-000000000001";
const source = "00000000-0000-4000-8000-000000000002";
const result = "00000000-0000-4000-8000-000000000003";
const receipt = {
  id: result,
  request_id: key,
  name: "An independently edited copy",
  description: "Changed after creation",
  revision: 9,
  graph: { nodes: [], edges: [] },
  config: { sources: {}, sinks: {} },
  archived: true,
  archived_at: "2026-09-27T12:00:00Z",
  created_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-27T12:00:00Z",
};
const origin = {
  operation: "duplicate",
  source_configuration_id: source,
  source_revision: 4,
};
const found = {
  request_id: key,
  found: true,
  ...origin,
  configuration: receipt,
};

describe("durable pipeline creation responses", () => {
  it("accepts the current edited or archived result while requiring an identifiable complete receipt", () => {
    expect(PipelineCreateReceiptSchema.parse(receipt)).toEqual(receipt);
    for (const field of [
      "id",
      "request_id",
      "description",
      "revision",
      "created_at",
      "updated_at",
      "archived",
      "archived_at",
      "graph",
      "config",
    ]) {
      const missing: Record<string, unknown> = { ...receipt };
      delete missing[field];
      expect(
        PipelineCreateReceiptSchema.safeParse(missing).success,
        field,
      ).toBe(false);
    }
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "9", null])
      expect(
        PipelineCreateReceiptSchema.safeParse({ ...receipt, revision }).success,
      ).toBe(false);
    expect(
      PipelineCreateReceiptSchema.safeParse({
        ...receipt,
        id: "not-a-pipeline",
      }).success,
    ).toBe(false);
  });
  it("routes exact request lookups ahead of detail and preserves immutable source metadata", async () => {
    const absent = { request_id: key, found: false };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(found)))
        .mockResolvedValueOnce(new Response(JSON.stringify(absent))),
    );
    expect(await api(`/configurations/requests/${key}`)).toEqual(found);
    expect(await api(`/configurations/requests/${key}`)).toEqual(absent);
    expect(
      PipelineRequestLookupSchema.safeParse({ ...found, request_id: source })
        .success,
    ).toBe(false);
    expect(
      PipelineRequestLookupSchema.safeParse({
        ...found,
        configuration: { ...receipt, id: source },
      }).success,
    ).toBe(false);
    expect(
      PipelineRequestLookupSchema.safeParse({ ...found, found: false }).success,
    ).toBe(false);
    expect(
      PipelineRequestLookupSchema.safeParse({ found: false }).success,
    ).toBe(false);
  });
  it("rejects mixed create and duplicate origins without inferring a missing source or revision", () => {
    expect(
      PipelineRequestLookupSchema.safeParse({
        ...found,
        operation: "create",
        source_configuration_id: null,
        source_revision: null,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { operation: "create" },
      { source_configuration_id: null },
      { source_revision: null },
      { source_revision: Number.MAX_SAFE_INTEGER + 1 },
      { operation: "restore" },
    ])
      expect(
        PipelineRequestLookupSchema.safeParse({ ...found, ...invalid }).success,
      ).toBe(false);
  });
  it("only exposes bounded discovery metadata, including nullable current names", async () => {
    const row = {
      request_id: key,
      ...origin,
      configuration_id: result,
      configuration_name: null,
      created_at: receipt.created_at,
    };
    const page = { items: [row], page: 1, page_size: 12, total: 1 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(page))),
    );
    expect(await api("/configurations/requests?page=1&page_size=12")).toEqual(
      page,
    );
    expect(
      PipelineRequestPageSchema.safeParse({
        ...page,
        items: [{ ...row, configuration_name: "\u{1F600}".repeat(240) }],
      }).success,
    ).toBe(true);
    expect(
      PipelineRequestPageSchema.safeParse({
        ...page,
        items: [{ ...row, configuration_name: "\u{1F600}".repeat(241) }],
      }).success,
    ).toBe(false);
    for (const field of [
      "config",
      "graph",
      "request",
      "payload_sha256",
      "actor_id",
      "description",
    ])
      expect(
        PipelineRequestPageSchema.safeParse({
          ...page,
          items: [{ ...row, [field]: {} }],
        }).success,
      ).toBe(false);
    for (const invalid of [
      { items: Array(51).fill(row) },
      { page: 0 },
      { page_size: 51 },
      { total: Number.MAX_SAFE_INTEGER + 1 },
      { items: [{ ...row, operation: "create" }] },
    ])
      expect(
        PipelineRequestPageSchema.safeParse({ ...page, ...invalid }).success,
      ).toBe(false);
  });
  it("treats malformed successful responses as uncertain instead of a proven rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: result, request_id: key })),
        ),
    );
    await expect(
      api("/configurations", { method: "POST" }, PipelineCreateReceiptSchema),
    ).rejects.toMatchObject({
      code: "CONTRACT_MISMATCH",
      serverRejection: false,
    });
  });
});
