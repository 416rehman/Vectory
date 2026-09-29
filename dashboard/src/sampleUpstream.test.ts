import { describe, expect, it } from "vitest";
import { parseSamples } from "./sampleStore";
import { eventsOnPort, sourceSamples, upstreamOf } from "./sampleUpstream";

const nginx = {
  sources: { nginx: { type: "file", include: ["/var/log/nginx/access.log"] } },
  transforms: {
    parse: {
      type: "remap",
      inputs: ["nginx"],
      source: '. = parse_nginx_log!(.message, "combined")',
    },
    by_status: {
      type: "route",
      inputs: ["parse"],
      route: { server_errors: ".status >= 500" },
    },
    errors_only: { type: "filter", inputs: ["by_status.server_errors"] },
    sampled: { type: "sample", inputs: ["parse"], rate: 10 },
    after_sample: { type: "remap", inputs: ["sampled"], source: "." },
  },
};

describe("sample tester upstream", () => {
  it("follows the first input back to the source, source side first", () => {
    expect(upstreamOf(nginx, "parse")).toMatchObject({
      steps: [],
      source: { id: "nginx", type: "file" },
      blocked: null,
    });
    const route = upstreamOf(nginx, "by_status");
    expect(route.steps.map((step) => [step.id, step.port])).toEqual([
      ["parse", ""],
    ]);
    expect(route.steps[0].transform).not.toHaveProperty("inputs");
    expect(
      upstreamOf(nginx, "errors_only").steps.map((step) => [
        step.id,
        step.port,
      ]),
    ).toEqual([
      ["parse", ""],
      ["by_status", "server_errors"],
    ]);
  });

  it("starts after a step the tester can't run", () => {
    const upstream = upstreamOf(nginx, "after_sample");
    expect(upstream.steps).toEqual([]);
    expect(upstream.blocked).toEqual({ id: "sampled", type: "sample" });
    expect(upstream.source?.id).toBe("nginx");
  });

  it("stops at cycles and wildcard inputs", () => {
    const cycle = {
      transforms: {
        a: { type: "remap", inputs: ["b"], source: "." },
        b: { type: "remap", inputs: ["a"], source: "." },
        c: { type: "remap", inputs: ["app_*"], source: "." },
      },
    };
    expect(upstreamOf(cycle, "a").steps.map((step) => step.id)).toEqual(["b"]);
    expect(upstreamOf(cycle, "c")).toEqual({
      steps: [],
      source: null,
      blocked: null,
    });
  });

  it("passes on the events a step sent to the output the next step reads", () => {
    const results = [
      {
        sample: 0,
        outcome: "emitted" as const,
        outputs: [
          { port: "server_errors", event: { status: 503 }, timestamps: [] },
        ],
      },
      {
        sample: 1,
        outcome: "emitted" as const,
        outputs: [
          { port: "_unmatched", event: { status: 200 }, timestamps: [] },
        ],
      },
    ];
    expect(eventsOnPort(results, "server_errors")).toEqual([
      { event: { status: 503 }, origin: 0 },
    ]);
  });
});

describe("example events from the source", () => {
  it("match each demo_logs format and recognizable log files", () => {
    for (const format of [
      "apache_common",
      "apache_error",
      "syslog",
      "bsd_syslog",
      "json",
    ]) {
      const text = sourceSamples({
        id: "demo",
        type: "demo_logs",
        component: { type: "demo_logs", format },
      });
      const parsed = parseSamples(text);
      expect(parsed.errors).toEqual([]);
      expect(parsed.samples.length).toBe(2);
      expect(parsed.samples[0]).toMatchObject({ source_type: "demo_logs" });
    }
    const nginxEvents = parseSamples(
      sourceSamples({
        id: "nginx",
        type: "file",
        component: nginx.sources.nginx,
      }),
    ).samples;
    expect(nginxEvents[0]).toMatchObject({
      file: "/var/log/nginx/access.log",
      source_type: "file",
    });
    expect(String(nginxEvents[0].message)).toMatch(/^\S+ - - \[.+\] "GET /);
  });

  it("start empty when the data can't be known ahead", () => {
    expect(
      sourceSamples({
        id: "app",
        type: "file",
        component: { type: "file", include: ["/var/log/app/*.log"] },
      }),
    ).toBe("");
    expect(sourceSamples({ id: "k", type: "kafka", component: {} })).toBe("");
    expect(sourceSamples(null)).toBe("");
  });
});
