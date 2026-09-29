import { describe, expect, it } from "vitest";
import {
  auditActionLabel,
  auditChanges,
  auditDateError,
  auditFilterParams,
  auditHistoryPath,
  auditResourceRoute,
  auditRoute,
  defaultAuditQuery,
  normalizeAuditQuery,
  readAuditQuery,
} from "./auditModel";

const id = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
describe("audit view queries and identities", () => {
  it("uses bounded API pages and inclusive UTC dates without leaking paging into export filters", () => {
    const query = {
      ...defaultAuditQuery,
      page: 3,
      search: " pipeline ",
      from: "2026-09-01",
      to: "2026-09-26",
      device_id: id.toLowerCase(),
    };
    const params = new URL(auditHistoryPath(query), "https://example.test")
      .searchParams;
    expect(params.get("page_size")).toBe("12");
    expect(params.get("page")).toBe("3");
    expect(params.get("search")).toBe("pipeline");
    expect(params.get("from")).toBe("2026-09-01T00:00:00.000Z");
    expect(params.get("to")).toBe("2026-09-26T23:59:59.999Z");
    expect(auditFilterParams(query).has("page")).toBe(false);
    expect(auditFilterParams(query).has("page_size")).toBe(false);
  });
  it("round trips list context using canonical IDs and date-only URLs", () => {
    const q = {
      ...defaultAuditQuery,
      device_id: id.toLowerCase(),
      family: "configuration",
      from: "2026-09-01",
      page: 2,
    };
    const route = auditRoute(id, q);
    expect(route.startsWith(`audit/${id.toLowerCase()}?`)).toBe(true);
    expect(route).toContain(`device=${id.toLowerCase()}`);
    expect(route).not.toContain("T00");
    expect(readAuditQuery(route.split("?")[1])).toEqual(q);
    expect(readAuditQuery(`device_id=${id}`)?.device_id).toBe(id.toLowerCase());
  });
  it("ignores action-like unknown parameters and preserves scalar Unicode at the search boundary", () => {
    expect(readAuditQuery("execute=delete&token=secret")).toBeUndefined();
    const query = readAuditQuery(
      new URLSearchParams({
        search: "x".repeat(199) + "😀extra",
        page: "9007199254740992",
        action: "configuration.publish",
        family: "device",
        execute: "revoke",
      }).toString(),
    )!;
    expect(Array.from(query.search)).toHaveLength(200);
    expect(query.search.endsWith("😀")).toBe(true);
    expect(query.page).toBe(1);
    expect(query.family).toBe("");
    expect(auditRoute(id, query)).not.toContain("execute");
    expect(normalizeAuditQuery({ search: "😀".repeat(200) }).search).toBe(
      "😀".repeat(200),
    );
  });
  it("links only typed, complete supported identities and never guesses from a label", () => {
    expect(auditResourceRoute("device", id)).toBe(
      `devices/${id.toLowerCase()}`,
    );
    expect(auditResourceRoute("configuration", id)).toBe(
      `configurations/${id.toLowerCase()}`,
    );
    expect(auditResourceRoute("deployment", id)).toBe(
      `deployments/${id.toLowerCase()}`,
    );
    expect(auditResourceRoute("unknown", id)).toBeNull();
    expect(auditResourceRoute("user", id)).toBeNull();
    expect(auditResourceRoute("device", `${id}:${id}`)).toBeNull();
    expect(auditResourceRoute("device", "../../users")).toBeNull();
    expect(auditActionLabel("configuration.publish")).toBe(
      "Pipeline published",
    );
  });
  it("retains server-wide browsing order in permalinks but excludes it from prepared export filters", () => {
    const q = {
      ...defaultAuditQuery,
      sort: "actor" as const,
      direction: "asc" as const,
      page: 3,
    };
    expect(readAuditQuery(auditRoute(id, q).split("?")[1])).toEqual(q);
    expect(auditHistoryPath(q)).toContain("sort=actor&direction=asc");
    expect(auditFilterParams(q).has("sort")).toBe(false);
    expect(auditFilterParams(q).has("direction")).toBe(false);
    expect(readAuditQuery("sort=private&direction=DROP")?.sort).toBe(
      "created_at",
    );
    expect(readAuditQuery("sort=private&direction=DROP")?.direction).toBe(
      "desc",
    );
    expect(auditRoute(null, defaultAuditQuery)).toBe("audit?page=1");
  });
  it("hides sign-ins by default, keeps the scope in page URLs and lets event filters win", () => {
    const api = (query: typeof defaultAuditQuery) =>
      new URL(auditHistoryPath(query), "https://example.test").searchParams;
    expect(api(defaultAuditQuery).get("scope")).toBe("changes");
    expect(api({ ...defaultAuditQuery, scope: "security" }).get("scope")).toBe(
      "security",
    );
    expect(api({ ...defaultAuditQuery, scope: "all" }).has("scope")).toBe(
      false,
    );
    // An explicit event filter shows matching events of any kind.
    expect(api({ ...defaultAuditQuery, action: "login" }).has("scope")).toBe(
      false,
    );
    expect(auditRoute(null, defaultAuditQuery)).not.toContain("scope");
    const security = { ...defaultAuditQuery, scope: "security" as const };
    expect(auditRoute(null, security)).toContain("scope=security");
    expect(readAuditQuery("scope=security")).toEqual(security);
    expect(readAuditQuery("scope=everything")?.scope).toBe("changes");
    expect(auditFilterParams(security).get("scope")).toBe("security");
  });
  it("rejects inverted, nonexistent and malformed days before any API query", () => {
    expect(auditDateError("2026-09-27", "2026-09-26")).toMatch(/end date/);
    expect(auditDateError("2026-02-30", "")).toMatch(/valid start/);
    expect(auditDateError("2024-02-29", "2024-02-29")).toBe("");
    expect(auditDateError("2026-09-01T00:00:00Z", "")).toMatch(/valid/);
  });
});

describe("what changed", () => {
  it("pairs before and after values and names recorded ones", () => {
    expect(
      auditChanges({
        previous_state: "written",
        state: "verified_applied",
        previous_group_revision: 3,
        group_revision: 4,
        version_number: 7,
        password: "never shown",
      }),
    ).toEqual([
      { label: "State", before: "Applying", after: "Applied" },
      { label: "Version", after: "v7" },
    ]);
    expect(auditChanges({ generation: 2 })).toEqual([
      { label: "Configuration generation", before: undefined, after: "2" },
    ]);
    expect(auditChanges(null)).toEqual([]);
    expect(auditChanges({ state: { nested: true } })).toEqual([]);
  });
});
