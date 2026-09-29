import { describe, expect, it } from "vitest";
import {
  DeploymentRequestPageSchema,
  DeploymentRequestSummarySchema,
} from "./api";

const row = {
  request_id: "00000000-0000-4000-8000-000000000001",
  operation: "create",
  source_deployment_id: null,
  deployment_id: "00000000-0000-4000-8000-000000000002",
  created_at: "2026-09-27T12:00:00Z",
  deployment_name: "Synthetic deployment",
  deployment_status: "active",
  configuration_name: "Synthetic pipeline",
  version_number: 3,
  resource: "configuration",
  scheduled_at: null,
};
describe("committed deployment discovery contract", () => {
  it("accepts Unicode character bounds consistently with the server and JSON Schema", () => {
    expect(
      DeploymentRequestSummarySchema.safeParse({
        ...row,
        deployment_name: "🧭".repeat(120),
        configuration_name: "🚀".repeat(240),
      }).success,
    ).toBe(true);
    expect(
      DeploymentRequestSummarySchema.safeParse({
        ...row,
        deployment_name: "🧭".repeat(121),
      }).success,
    ).toBe(false);
  });
  it("requires exact operation/result identities and never accepts a retry payload", () => {
    expect(
      DeploymentRequestSummarySchema.safeParse({
        ...row,
        operation: "rollback",
      }).success,
    ).toBe(false);
    expect(
      DeploymentRequestSummarySchema.safeParse({
        ...row,
        source_deployment_id: row.deployment_id,
      }).success,
    ).toBe(false);
    expect(
      DeploymentRequestSummarySchema.safeParse({
        ...row,
        operation: "rollback",
        source_deployment_id: row.deployment_id,
      }).success,
    ).toBe(true);
    expect(
      DeploymentRequestSummarySchema.safeParse({
        ...row,
        request: { request_id: row.request_id },
      }).success,
    ).toBe(false);
    expect(
      DeploymentRequestSummarySchema.safeParse({
        ...row,
        deployment_id: "#malformed",
      }).success,
    ).toBe(false);
  });
  it("bounds pages and counters before presenting request history", () => {
    const page = { items: [row], total: 1, page: 1, page_size: 12 };
    expect(DeploymentRequestPageSchema.safeParse(page).success).toBe(true);
    expect(
      DeploymentRequestPageSchema.safeParse({
        ...page,
        total: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      DeploymentRequestPageSchema.safeParse({
        ...page,
        items: Array(51).fill(row),
      }).success,
    ).toBe(false);
    expect(
      DeploymentRequestPageSchema.safeParse({ ...page, page_size: 0 }).success,
    ).toBe(false);
  });
});
