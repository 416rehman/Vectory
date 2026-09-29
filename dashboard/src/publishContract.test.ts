import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  PublishReceiptSchema,
  PublishRequestLookupSchema,
  PublishRequestPageSchema,
} from "./api";

afterEach(() => vi.unstubAllGlobals());
const key = "00000000-0000-4000-8000-000000000001";
const parent = "00000000-0000-4000-8000-000000000002";
const receipt = {
  id: "00000000-0000-4000-8000-000000000003",
  configuration_id: parent,
  request_id: key,
  number: 3,
  source_revision: 4,
  graph: { nodes: [], edges: [] },
  config: {},
  artifact: "{}",
  sha256: "a".repeat(64),
  size: 2,
  created_at: "2026-09-27T00:00:00Z",
  message: "Reviewed change",
  validation: { valid: true, vector_validated: false },
};
describe("publication receipts", () => {
  it("requires an immutable version with explicit origin and successful validation", () => {
    expect(PublishReceiptSchema.parse(receipt)).toEqual(receipt);
    for (const field of [
      "request_id",
      "configuration_id",
      "source_revision",
      "id",
      "artifact",
      "validation",
    ]) {
      const missing = { ...receipt } as Record<string, unknown>;
      delete missing[field];
      expect(PublishReceiptSchema.safeParse(missing).success).toBe(false);
    }
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4", null]) {
      expect(
        PublishReceiptSchema.safeParse({ ...receipt, source_revision: value })
          .success,
      ).toBe(false);
    }
    expect(
      PublishReceiptSchema.safeParse({
        ...receipt,
        validation: { valid: false },
      }).success,
    ).toBe(false);
    expect(
      PublishReceiptSchema.safeParse({ ...receipt, message: "é".repeat(1000) })
        .success,
    ).toBe(true);
    expect(
      PublishReceiptSchema.safeParse({ ...receipt, message: "é".repeat(1001) })
        .success,
    ).toBe(false);
  });
  it("keeps exact lookup separate from pipeline detail and rejects a mismatched nested identity", async () => {
    const found = { request_id: key, found: true, version: receipt };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(found))),
    );
    expect(await api(`/configurations/publish-requests/${key}`)).toEqual(found);
    expect(
      PublishRequestLookupSchema.safeParse({ ...found, request_id: parent })
        .success,
    ).toBe(false);
    expect(
      PublishRequestLookupSchema.safeParse({ ...found, found: false }).success,
    ).toBe(false);
    expect(PublishRequestLookupSchema.safeParse({ found: false }).success).toBe(
      false,
    );
    expect(
      PublishRequestLookupSchema.parse({ request_id: key, found: false }),
    ).toEqual({ request_id: key, found: false });
  });
  it("validates bounded metadata discovery without configuration, note or retry body", async () => {
    const row = {
      request_id: key,
      configuration_id: parent,
      version_id: receipt.id,
      number: receipt.number,
      source_revision: receipt.source_revision,
      created_at: receipt.created_at,
    };
    const page = { items: [row], page: 1, page_size: 12, total: 1 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(page))),
    );
    expect(
      await api(`/configurations/publish-requests?configuration_id=${parent}`),
    ).toEqual(page);
    for (const field of [
      "config",
      "graph",
      "artifact",
      "message",
      "request",
      "payload_sha256",
    ]) {
      expect(
        PublishRequestPageSchema.safeParse({
          ...page,
          items: [{ ...row, [field]: {} }],
        }).success,
      ).toBe(false);
    }
    expect(
      PublishRequestPageSchema.safeParse({
        ...page,
        items: Array(51).fill(row),
      }).success,
    ).toBe(false);
    expect(
      PublishRequestPageSchema.safeParse({ ...page, page_size: 51 }).success,
    ).toBe(false);
    expect(
      PublishRequestPageSchema.safeParse({ ...page, page: 0 }).success,
    ).toBe(false);
  });
});
