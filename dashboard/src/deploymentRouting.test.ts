import { describe, expect, it } from "vitest";
import {
  deploymentRoute,
  isDeploymentId,
  readDeploymentQuery,
} from "./deploymentRouting";

describe("deployment permalink routing", () => {
  it("round trips origin and explicit list context without interpreting actions", () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    const query = { search: "logs & 東京 /?", status: "failed", page: 3 };
    const route = deploymentRoute(true, id, query);
    expect(route.startsWith(`schedules/${id}?`)).toBe(true);
    expect(readDeploymentQuery(route.split("?")[1])).toEqual(query);
    expect(
      readDeploymentQuery("action=rollback&token=private"),
    ).toBeUndefined();
    expect(readDeploymentQuery("action=pause&page=2")).toEqual({
      search: "",
      status: "all",
      page: 2,
    });
  });
  it("distinguishes explicit default context from no browse parameters", () => {
    expect(readDeploymentQuery("")).toBeUndefined();
    expect(
      deploymentRoute(false, null, { search: "", status: "all", page: 1 }),
    ).toBe("deployments?page=1");
    expect(readDeploymentQuery("page=1")).toEqual({
      search: "",
      status: "all",
      page: 1,
    });
  });
  it("bounds malformed inputs without accepting unsafe numeric pages or status injection", () => {
    for (const page of [
      "0",
      "-1",
      "1.5",
      "Infinity",
      "9007199254740992",
      "1e4",
      "1/summary",
    ])
      expect(
        readDeploymentQuery(`page=${encodeURIComponent(page)}&status=__proto__`)
          ?.page,
      ).toBe(1);
    expect(
      readDeploymentQuery(`search=${"x".repeat(500)}&status=unknown`)?.search,
    ).toHaveLength(200);
    expect(readDeploymentQuery("status=unknown")?.status).toBe("all");
  });
  it("accepts only complete immutable UUID identities before a route fetch", () => {
    expect(isDeploymentId("12345678-1234-1234-1234-123456789abc")).toBe(true);
    for (const value of [
      "",
      "../devices",
      "%2fsummary",
      "x".repeat(500),
      "12345678-1234-1234-1234-123456789abc/summary",
    ])
      expect(isDeploymentId(value)).toBe(false);
  });
  it("preserves Unicode scalar search bounds and canonicalizes uppercase UUIDs", () => {
    for (const search of ["x".repeat(199) + "🧭", "🧭".repeat(200)]) {
      const route = deploymentRoute(
        false,
        "ABCDEFAB-1234-1234-1234-ABCDEFABCDEF",
        { search, status: "all", page: 1 },
      );
      expect(readDeploymentQuery(route.split("?")[1])?.search).toBe(search);
      expect(
        route.startsWith("deployments/abcdefab-1234-1234-1234-abcdefabcdef?"),
      ).toBe(true);
    }
    expect(
      Array.from(readDeploymentQuery(`search=${"🧭".repeat(201)}`)!.search),
    ).toHaveLength(200);
  });
});

describe("deployment global sorting route state", () => {
  it("honors direction-only links using the server's default sort", () => {
    expect(readDeploymentQuery("direction=asc")).toEqual({
      search: "",
      status: "all",
      page: 1,
      sort: "created_at",
      direction: "asc",
    });
  });
  it("preserves header sorting through detail URLs and rejects unknown sort text", () => {
    for (const sort of [
      "name",
      "status",
      "verified",
      "created_at",
      "scheduled_at",
    ] as const) {
      const query = {
        search: "night",
        status: "active",
        page: 3,
        sort,
        direction: "asc" as const,
      };
      const route = deploymentRoute(
        false,
        "12345678-1234-1234-1234-123456789abc",
        query,
      );
      expect(readDeploymentQuery(route.split("?")[1])).toEqual(query);
    }
    expect(readDeploymentQuery("sort=arbitrary&direction=sideways")).toEqual({
      search: "",
      status: "all",
      page: 1,
    });
    expect(readDeploymentQuery("sort=name&direction=sideways")).toEqual({
      search: "",
      status: "all",
      page: 1,
      sort: "name",
      direction: "desc",
    });
  });
});
