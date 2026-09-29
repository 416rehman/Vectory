import { describe, expect, it } from "vitest";
import {
  componentSummary,
  componentTitle,
  endpointSummary,
  nodeOutputPorts,
  pipelineNodeHeight,
  PIPELINE_NODE_BODY_HEIGHT,
  PIPELINE_NODE_HEADER_HEIGHT,
  PIPELINE_NODE_COLUMN_GAP,
  PIPELINE_NODE_PORT_HEIGHT,
  PIPELINE_NODE_WIDTH,
} from "./pipelineNodeModel";

describe("pipeline node configuration summaries", () => {
  it("shows the actual destination rather than duplicating the type or input count", () => {
    expect(
      componentSummary(
        {
          type: "aws_s3",
          bucket: "production-logs",
          key_prefix: "events/",
          region: "ca-central-1",
          encoding: { codec: "json" },
          inputs: ["clean"],
        },
        "sinks",
      ),
    ).toEqual({
      primary: "s3://production-logs/events/",
      secondary: "ca-central-1 · JSON encoding",
    });
    expect(componentTitle("aws_s3", "sinks")).toBe("Amazon S3");
  });

  it("keeps broker addresses intact and shows topics and consumer groups", () => {
    expect(
      componentSummary(
        {
          type: "kafka",
          topics: ["orders", "invoices", "events"],
          group_id: "ingest",
          bootstrap_servers: "broker1:9092,broker2:9092",
        },
        "sources",
      ),
    ).toEqual({
      primary: "orders, invoices +1 more",
      secondary: "Group ingest · broker1:9092,broker2:9092",
    });
    expect(endpointSummary("[::1]:9000")).toBe("[::1]:9000");
  });

  it("strips URL userinfo, query strings and fragments before making a compact endpoint", () => {
    expect(
      endpointSummary(
        "https://username:secret@example.com:443/ingest?api_key=private#fragment",
      ),
    ).toBe("https://example.com/ingest");
    expect(
      endpointSummary(
        `https://user:${"private".repeat(1000)}@example.com/ingest?private=1`,
      ),
    ).toBe("https://example.com/ingest");
    expect(endpointSummary("username:password@localhost:9092")).toBe(
      "localhost:9092",
    );
    expect(
      endpointSummary("https://user:private@${HOST}/events?password=hidden"),
    ).toBe("https://${HOST}/events");
  });

  it("does not resolve local references or reflect arbitrary authentication objects", () => {
    for (const value of [
      "${ENDPOINT}",
      "SECRET[backend.endpoint]",
      "vectory-secret:ENDPOINT",
    ])
      expect(endpointSummary(value)).toBe("Endpoint from local reference");
    expect(
      componentSummary(
        {
          type: "custom",
          headers: { authorization: "private" },
          auth: { password: "private" },
          custom_private: "private",
        },
        "sinks",
      ),
    ).toEqual({ primary: "Open settings to configure", secondary: undefined });
  });

  it("handles malformed imported drafts without object text or crashes", () => {
    for (const component of [
      { type: "file", include: "bad", exclude: 42 },
      { type: "route", route: "bad" },
      { type: "exclusive_route", routes: [null, 42] },
      { type: "prometheus_scrape", endpoints: [null, {}, 42] },
      { type: "filter", condition: [{}] },
    ]) {
      const summary = componentSummary(component, "transforms");
      expect(typeof summary.primary).toBe("string");
      expect(JSON.stringify(summary)).not.toContain("[object Object]");
      expect(() => nodeOutputPorts(component, "transforms")).not.toThrow();
    }
    expect(componentTitle("constructor", "sinks")).toBe("constructor");
    expect(componentTitle("__proto__", "sinks")).toBe("__proto__");
  });

  it("shows VRL logic or the selected file without inventing a program", () => {
    expect(
      componentSummary(
        {
          type: "remap",
          source: '# Comment\n.level = "info"\n.delayed = true',
        },
        "transforms",
      ),
    ).toMatchObject({ primary: '.level = "info"', code: true });
    expect(
      componentSummary(
        { type: "remap", file: "programs/normalize.vrl" },
        "transforms",
      ),
    ).toMatchObject({
      primary: "programs/normalize.vrl",
      secondary: "Load a VRL program from file",
      code: false,
    });
    expect(
      componentSummary(
        {
          type: "filter",
          condition: { type: "vrl", source: ".status >= 500" },
        },
        "transforms",
      ),
    ).toMatchObject({ primary: ".status >= 500", code: true });
  });

  it("makes route conditions visible while retaining exact named port identity", () => {
    const route = { type: "route", route: { accepted: '.level == "info"' } };
    expect(componentSummary(route, "transforms")).toEqual({
      primary: 'accepted: .level == "info"',
      secondary: "Includes unmatched output",
      code: true,
    });
    expect(nodeOutputPorts(route, "transforms")).toEqual([
      "accepted",
      "_unmatched",
    ]);
    expect(
      componentSummary(
        {
          type: "exclusive_route",
          routes: [
            { name: "errors", condition: ".status >= 500" },
            { name: "other", condition: "true" },
          ],
        },
        "transforms",
      ),
    ).toMatchObject({
      primary: "errors: .status >= 500",
      secondary: "2 conditional routes · Includes unmatched output",
    });
  });

  it("shows configured sampling and the pinned demo interval default", () => {
    expect(
      componentSummary({ type: "sample", rate: 10 }, "transforms").primary,
    ).toBe("Keep 1 in every 10 events");
    expect(
      componentSummary({ type: "sample", ratio: 0.15 }, "transforms").primary,
    ).toBe("Keep 15% of events");
    expect(
      componentSummary({ type: "demo_logs", format: "json" }, "sources"),
    ).toEqual({ primary: "JSON log events", secondary: "Generate every 1 s" });
    expect(
      componentSummary(
        { type: "demo_logs", format: "json", interval: 0 },
        "sources",
      ).secondary,
    ).toBe("Generate without delay");
    expect(
      componentSummary(
        { type: "demo_logs", format: "json", interval: 0.25 },
        "sources",
      ).secondary,
    ).toBe("Generate every 0.25 s");
  });

  it("distinguishes enrichment table writes and implicit reads", () => {
    const component = {
      type: "memory",
      ttl: 60,
      source_config: { source_key: "cache_out", export_expired_items: true },
    };
    expect(
      componentTitle("memory", "sinks", { enrichmentTable: "lookup" }),
    ).toBe("Memory table");
    expect(
      componentTitle("memory", "sources", {
        enrichmentTable: "lookup",
        implicitSource: true,
      }),
    ).toBe("Memory table export");
    expect(
      componentSummary(component, "sources", {
        enrichmentTable: "lookup",
        implicitSource: true,
      }),
    ).toEqual({
      primary: "Read from lookup",
      secondary: "TTL 60 s · Expired-items output",
    });
    expect(
      componentSummary(component, "sinks", { enrichmentTable: "lookup" })
        .primary,
    ).toBe("Write to lookup");
  });
});

describe("pipeline node port and layout geometry", () => {
  it("preserves named-only and optional outputs without inventing a default", () => {
    expect(nodeOutputPorts({ type: "opentelemetry" }, "sources")).toEqual([
      "logs",
      "metrics",
      "traces",
    ]);
    expect(
      nodeOutputPorts(
        {
          type: "route",
          route: { accepted: "true" },
          reroute_unmatched: false,
        },
        "transforms",
      ),
    ).toEqual(["accepted"]);
    expect(
      nodeOutputPorts({ type: "remap", reroute_dropped: true }, "transforms"),
    ).toEqual(["output", "dropped"]);
    expect(nodeOutputPorts({ type: "blackhole" }, "sinks")).toEqual([]);
  });

  it("reserves exact named-port rows and leaves a useful connection gap", () => {
    expect(PIPELINE_NODE_HEADER_HEIGHT).toBe(80);
    expect(PIPELINE_NODE_HEADER_HEIGHT).toBeLessThan(
      PIPELINE_NODE_BODY_HEIGHT / 2,
    );
    expect(
      pipelineNodeHeight({ kind: "sources", component: { type: "demo_logs" } }),
    ).toBe(PIPELINE_NODE_BODY_HEIGHT);
    expect(
      pipelineNodeHeight({
        kind: "transforms",
        component: { type: "route", route: { accepted: "true" } },
      }),
    ).toBe(PIPELINE_NODE_BODY_HEIGHT + 2 * PIPELINE_NODE_PORT_HEIGHT + 9);
    expect(
      pipelineNodeHeight({
        kind: "sources",
        component: { type: "opentelemetry" },
      }),
    ).toBe(PIPELINE_NODE_BODY_HEIGHT + 3 * PIPELINE_NODE_PORT_HEIGHT + 9);
    expect(
      PIPELINE_NODE_COLUMN_GAP - PIPELINE_NODE_WIDTH,
    ).toBeGreaterThanOrEqual(100);
  });
});
