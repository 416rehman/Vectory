import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Device } from "./api";
import DiagnosticList from "./DiagnosticList";
import { MetricsDiagnosis, agentFindsExporter } from "./TelemetryPanel";
import VectorLogSummaryView from "./VectorLogSummary";

const device = (overrides: Partial<Device> = {}): Device =>
  ({
    id: "device",
    name: "Fixture",
    os: "linux",
    arch: "amd64",
    agent_version: "test",
    vector_version: "0.58.0",
    status: "verified",
    labels: {},
    apply_state: "verified_applied",
    desired_generation: 1,
    reported_generation: 1,
    sync_paused: false,
    pause_acknowledged: false,
    created_at: "2026-09-29T00:00:00Z",
    effective_policy: {
      heartbeat_seconds: 60,
      sync_paused: false,
      telemetry_enabled: true,
    },
    ...overrides,
  }) as Device;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("metrics empty states say exactly what is missing", () => {
  it("names a pipeline without a loopback exporter and the fix", () => {
    const html = text(
      renderToStaticMarkup(
        createElement(MetricsDiagnosis, {
          device: device({ host_runtime: { metrics_source: "none" } }),
        }),
      ),
    );
    expect(html).toContain("No metrics reported");
    expect(html).toContain("allowed by the agent settings");
    expect(html).toContain("has no loopback Prometheus exporter");
    expect(html).toContain("nothing needs to change on the host");
    expect(html).toContain('"type": "prometheus_exporter"');
  });
  it("names disabled collection", () => {
    const html = text(
      renderToStaticMarkup(
        createElement(MetricsDiagnosis, {
          device: device({
            effective_policy: {
              heartbeat_seconds: 60,
              sync_paused: false,
              telemetry_enabled: false,
            },
            host_runtime: {
              metrics_source: "discovered",
              metrics_address: "127.0.0.1:9598",
            },
          }),
        }),
      ),
    );
    expect(html).toContain("turned off in the agent settings");
    expect(html).not.toContain("Waiting for the first sample");
  });
  it("waits for a sample once an exporter is found", () => {
    const html = text(
      renderToStaticMarkup(
        createElement(MetricsDiagnosis, {
          device: device({
            host_runtime: {
              metrics_source: "discovered",
              metrics_address: "127.0.0.1:9598",
            },
          }),
        }),
      ),
    );
    expect(html).toContain("Waiting for the first sample");
    expect(html).toContain("Found the exporter at 127.0.0.1:9598");
    expect(html).toContain("every 60 seconds");
  });
  it("calls an agent too old only from its version, never from a missing report", () => {
    const old = text(
      renderToStaticMarkup(
        createElement(MetricsDiagnosis, {
          device: device({ agent_version: "0.0.9" }),
        }),
      ),
    );
    expect(old).toContain(
      "reads metrics only from a URL configured on the host",
    );
    for (const agent_version of ["0.1.0-dev", "0.2.3", "test", ""]) {
      const html = text(
        renderToStaticMarkup(
          createElement(MetricsDiagnosis, {
            device: device({ agent_version }),
          }),
        ),
      );
      expect(html).toContain("hasn't reported how it reads metrics yet");
      expect(html).not.toContain("Update the agent");
    }
    expect(agentFindsExporter("0.1.0-dev")).toBe(true);
    expect(agentFindsExporter("v1.0.0")).toBe(true);
    expect(agentFindsExporter("0.0.12")).toBe(false);
    expect(agentFindsExporter("synthetic")).toBeNull();
  });
});

describe("runtime evidence views", () => {
  it("lists findings with location and fix as text", () => {
    const html = renderToStaticMarkup(
      createElement(DiagnosticList, {
        diagnostics: [
          {
            severity: "error",
            code: "VRL_E100",
            component_kind: "transform",
            component_id: "by_status",
            route_output: "server_errors",
            field: "route.server_errors",
            line: 1,
            column: 1,
            message: "Unhandled error <script>",
            hint: "Handle the error case.",
          },
        ],
      }),
    );
    expect(html).toContain("by_status.server_errors");
    expect(html).toContain("Line 1, column 1");
    expect(html).toContain("Handle the error case.");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("distinguishes no summaries, nothing to report and grouped lines", () => {
    expect(
      text(renderToStaticMarkup(createElement(VectorLogSummaryView, {}))),
    ).toContain("does not report Vector log summaries");
    expect(
      text(
        renderToStaticMarkup(
          createElement(VectorLogSummaryView, {
            summary: { reported_at: new Date().toISOString(), items: [] },
          }),
        ),
      ),
    ).toContain("no warnings or errors in the last hour");
    const html = text(
      renderToStaticMarkup(
        createElement(VectorLogSummaryView, {
          summary: {
            reported_at: new Date().toISOString(),
            items: [
              {
                fingerprint: "0123456789abcdef",
                level: "warn",
                component_id: "collector",
                component_type: "http",
                message: "Retrying after error.",
                count: 14,
                first_seen: "2026-09-29T04:13:00Z",
                last_seen: new Date().toISOString(),
              },
              {
                fingerprint: "fedcba9876543210",
                level: "error",
                component_id: "collector",
                message: "Healthcheck failed.",
                count: 1,
                first_seen: "2026-09-29T04:13:00Z",
                last_seen: "2026-09-29T04:13:00Z",
              },
            ],
          },
        }),
      ),
    );
    expect(html).toContain("1 error, 1 warning");
    // Errors first, then warnings.
    expect(html.indexOf("Healthcheck failed.")).toBeLessThan(
      html.indexOf("Retrying after error."),
    );
    expect(html).toContain("14 times");
  });
});
