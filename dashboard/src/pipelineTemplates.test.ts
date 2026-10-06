import { describe, expect, it } from "vitest";
import type { Config } from "./api";
import {
  MONITORING_ADDRESS,
  MONITORING_SINK,
  MONITORING_SOURCE,
  pipelineTemplate,
  pipelineTemplates,
  withMonitoring,
} from "./pipelineTemplates";
import { metricsExporter } from "./metricsExporter";

describe("pipeline templates", () => {
  it("have unique ids and say what a device needs", () => {
    const ids = pipelineTemplates.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of pipelineTemplates) {
      expect(template.needs.length).toBeGreaterThan(0);
      expect(Object.keys(template.config.sources || {})).not.toHaveLength(0);
      expect(Object.keys(template.config.sinks || {})).not.toHaveLength(0);
    }
    expect(pipelineTemplate("syslog-loki")?.title).toBeTruthy();
    expect(pipelineTemplate("missing")).toBeNull();
  });

  it("never ship a vendor-specific Loki label or an uncompressed S3 sink", () => {
    const loki = pipelineTemplate("syslog-loki")!.config.sinks;
    expect(JSON.stringify(loki)).not.toMatch(/vendor/i);
    const s3 = Object.values(
      pipelineTemplate("files-s3")!.config.sinks,
    )[0] as Config;
    expect(s3.compression).toBe("gzip");
    expect(s3.encoding.codec).toBe("json");
  });

  it("ships the synthetic example with exactly the monitoring pair Add monitoring makes", () => {
    const example = pipelineTemplate("synthetic-demo")!.config;
    expect(withMonitoring(example)).toBeNull();
    const bare = structuredClone(example);
    delete bare.sources[MONITORING_SOURCE];
    delete bare.sinks[MONITORING_SINK];
    expect(withMonitoring(bare)).toEqual(example);
  });

  it("adds monitoring without touching existing steps", () => {
    const base = structuredClone(pipelineTemplate("syslog-loki")!.config);
    const next = withMonitoring(base)!;
    expect(next.sources[MONITORING_SOURCE].type).toBe("internal_metrics");
    expect(next.sinks[MONITORING_SINK]).toMatchObject({
      type: "prometheus_exporter",
      address: MONITORING_ADDRESS,
      inputs: [MONITORING_SOURCE],
    });
    for (const [id, sink] of Object.entries(base.sinks))
      expect(next.sinks[id]).toEqual(sink);
    expect(withMonitoring(next)).toBeNull();
  });

  it("reads where a pipeline exports its internal metrics", () => {
    // The synthetic example is the pair Add monitoring makes.
    expect(metricsExporter(pipelineTemplate("synthetic-demo")!.config)).toBe(
      MONITORING_ADDRESS,
    );
    expect(metricsExporter(null)).toBeNull();
    expect(metricsExporter({})).toBeNull();
    // Another port is the address it has, not the one Add monitoring picks.
    const sinks = (address?: string) => ({
      out: {
        type: "prometheus_exporter",
        inputs: ["metrics"],
        ...(address ? { address } : {}),
      },
    });
    const config = (extra: Config = {}): Config => ({
      sources: { metrics: { type: "internal_metrics" } },
      sinks: sinks("127.0.0.1:8655"),
      ...extra,
    });
    expect(metricsExporter(config())).toBe("127.0.0.1:8655");
    // Vector's default address when the sink names none.
    expect(metricsExporter(config({ sinks: sinks() }))).toBe("0.0.0.0:9598");
    // Fed through transforms, and through one output of a route.
    expect(
      metricsExporter({
        sources: { metrics: { type: "internal_metrics" } },
        transforms: {
          tag: { type: "remap", inputs: ["metrics"] },
          split: { type: "route", inputs: ["tag"], route: {} },
        },
        sinks: {
          out: {
            type: "prometheus_exporter",
            inputs: ["split.all"],
            address: "127.0.0.1:9599",
          },
        },
      }),
    ).toBe("127.0.0.1:9599");
    // An exporter nothing from internal metrics feeds is not it.
    expect(
      metricsExporter({
        sources: {
          metrics: { type: "internal_metrics" },
          logs: { type: "demo_logs" },
        },
        sinks: {
          out: {
            type: "prometheus_exporter",
            inputs: ["logs"],
            address: "127.0.0.1:9598",
          },
        },
      }),
    ).toBeNull();
    // Internal metrics that go elsewhere, and a loop between transforms.
    expect(
      metricsExporter({
        sources: { metrics: { type: "internal_metrics" } },
        sinks: { console: { type: "console", inputs: ["metrics"] } },
      }),
    ).toBeNull();
    expect(
      metricsExporter({
        sources: { metrics: { type: "internal_metrics" } },
        transforms: {
          a: { type: "remap", inputs: ["b"] },
          b: { type: "remap", inputs: ["a"] },
        },
        sinks: { out: { type: "prometheus_exporter", inputs: ["a"] } },
      }),
    ).toBeNull();
    // Names that belong to every object are not components.
    expect(
      metricsExporter({
        sources: { metrics: { type: "internal_metrics" } },
        sinks: {
          out: { type: "prometheus_exporter", inputs: ["constructor"] },
        },
      }),
    ).toBeNull();
  });

  it("picks free names and ports when they are taken", () => {
    const base = {
      sources: {
        [MONITORING_SOURCE]: { type: "host_metrics" },
      },
      sinks: {
        [MONITORING_SINK]: {
          type: "prometheus_exporter",
          inputs: [MONITORING_SOURCE],
          address: MONITORING_ADDRESS,
        },
      },
    };
    const next = withMonitoring(base)!;
    const added = next.sinks[`${MONITORING_SINK}_2`];
    expect(added.inputs).toEqual([`${MONITORING_SOURCE}_2`]);
    expect(added.address).not.toBe(MONITORING_ADDRESS);
  });
});
