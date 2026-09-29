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
