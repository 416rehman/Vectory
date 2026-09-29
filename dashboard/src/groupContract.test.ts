import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  AuditDetailsSchema,
  GroupSchema,
  GroupCreateReceiptSchema,
  GroupRequestLookupSchema,
  GroupRequestPageSchema,
} from "./api";

afterEach(() => vi.unstubAllGlobals());
const group = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Example",
  description: "",
  device_ids: [],
  revision: 1,
};
describe("group responses", () => {
  const request_id = "00000000-0000-4000-8000-000000000010";
  it("distinguishes exact request lookup from group detail and rejects mismatched receipts", async () => {
    const receipt = { ...group, request_id };
    const lookup = { request_id, found: true, group: receipt };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(lookup))),
    );
    expect(await api(`/groups/requests/${request_id}`)).toEqual(lookup);
    expect(GroupCreateReceiptSchema.safeParse(group).success).toBe(false);
    expect(
      GroupRequestLookupSchema.safeParse({
        ...lookup,
        group: { ...receipt, request_id: group.id },
      }).success,
    ).toBe(false);
    expect(
      GroupRequestLookupSchema.safeParse({
        request_id,
        found: false,
        group: receipt,
      }).success,
    ).toBe(false);
    expect(
      GroupRequestLookupSchema.safeParse({ request_id, found: true }).success,
    ).toBe(false);
    expect(
      GroupRequestLookupSchema.parse({ request_id, found: false }),
    ).toEqual({ request_id, found: false });
  });
  it("accepts only bounded group request metadata without saved payloads or membership", async () => {
    const row = {
      request_id,
      group_id: group.id,
      group_name: "Renamed group",
      created_at: "2026-09-27T00:00:00Z",
    };
    const page = { items: [row], total: 1, page: 1, page_size: 12 };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...page, items: [{ ...row, device_ids: [] }] }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...page, page_size: 51 })),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await api("/groups/requests?page=1&page_size=12")).toEqual(page);
    expect(
      GroupRequestPageSchema.safeParse({
        ...page,
        items: [{ ...row, group_name: "😀".repeat(240) }],
      }).success,
    ).toBe(true);
    expect(
      GroupRequestPageSchema.safeParse({
        ...page,
        items: [{ ...row, group_name: "😀".repeat(241) }],
      }).success,
    ).toBe(false);
    await expect(api("/groups/requests")).rejects.toMatchObject({
      code: "CONTRACT_MISMATCH",
    });
    await expect(api("/groups/requests")).rejects.toMatchObject({
      code: "CONTRACT_MISMATCH",
    });
  });
  it("preserves exact recorded group revisions, including legacy zero, without inventing absent audit fields", () => {
    for (const previous_group_revision of [0, Number.MAX_SAFE_INTEGER - 1]) {
      const details = {
        previous_group_revision,
        group_revision: previous_group_revision + 1,
      };
      expect(AuditDetailsSchema.parse(details)).toEqual(details);
    }
    expect(AuditDetailsSchema.parse({})).toEqual({});
    expect(AuditDetailsSchema.parse({ group_revision: 4 })).toEqual({
      group_revision: 4,
    });
    for (const value of [-1, 0.25, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      expect(
        AuditDetailsSchema.safeParse({ group_revision: value }).success,
      ).toBe(false);
      expect(
        AuditDetailsSchema.safeParse({ previous_group_revision: value })
          .success,
      ).toBe(false);
    }
  });
  it("validates arrays for reads and objects for create/edit receipts", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([group])))
      .mockResolvedValueOnce(new Response(JSON.stringify(group)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...group, revision: 2 })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(group)));
    vi.stubGlobal("fetch", fetch);
    expect(await api("/groups")).toEqual([group]);
    expect(await api("/groups", { method: "POST" })).toEqual(group);
    expect(await api(`/groups/${group.id}`, { method: "PUT" })).toEqual({
      ...group,
      revision: 2,
    });
    expect(await api(`/groups/${group.id}`)).toEqual(group);
  });
  it("rejects malformed successful save receipts instead of accepting them as saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: group.id, revision: 2 })),
        ),
    );
    await expect(
      api(`/groups/${group.id}`, { method: "PUT" }),
    ).rejects.toMatchObject({
      code: "CONTRACT_MISMATCH",
      serverRejection: false,
    });
  });
  it("keeps old servers readable without inventing a concurrency revision", () => {
    const { revision: _, ...legacy } = group;
    expect(GroupSchema.parse(legacy)).not.toHaveProperty("revision");
    expect(GroupSchema.parse({ ...group, revision: 0 }).revision).toBe(0);
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      expect(GroupSchema.safeParse({ ...group, revision }).success).toBe(false);
    }
  });
});
