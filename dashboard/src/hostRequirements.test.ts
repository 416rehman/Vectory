import { describe, expect, it } from "vitest";
import catalog from "./generated/vector-catalog.json";
import {
  allowancesFile,
  describeNeeds,
  fullModeRequirements,
  hostApprovals,
} from "./hostRequirements";

describe("restricted-host approvals", () => {
  it("finds destinations, listeners and file roots the way the agent checks them", () => {
    const approvals = hostApprovals({
      data_dir: "/var/lib/vector",
      sources: {
        nginx: { type: "file", include: ["/var/log/nginx/*.log"] },
        syslog: { type: "syslog", address: "0.0.0.0:1514", mode: "tcp" },
      },
      sinks: {
        loki: {
          type: "loki",
          endpoint: "https://logs.example.net",
          inputs: [],
        },
        es: {
          type: "elasticsearch",
          endpoints: ["http://10.0.0.5:9200"],
          inputs: [],
        },
      },
    });
    expect(approvals).toEqual({
      destinations: ["10.0.0.5:9200", "logs.example.net:443"],
      listeners: ["0.0.0.0:1514"],
      fileRoots: ["/var/lib/vector", "/var/log/nginx"],
    });
    expect(JSON.parse(allowancesFile(approvals))).toEqual({
      allowed_file_roots: ["/var/lib/vector", "/var/log/nginx"],
      allowed_network_hosts: ["10.0.0.5:9200", "logs.example.net:443"],
      allowed_listen_addresses: ["0.0.0.0:1514"],
    });
  });
  it("needs nothing for a self-contained pipeline", () => {
    expect(
      hostApprovals({
        sources: { demo: { type: "demo_logs", format: "json" } },
        sinks: { out: { type: "blackhole", inputs: ["demo"] } },
      }),
    ).toEqual({ destinations: [], listeners: [], fileRoots: [] });
  });
});

describe("what a pipeline asks of its devices", () => {
  it("names Full Vector when a restricted device would refuse the pipeline outright", () => {
    const config = {
      sources: { host: { type: "host_metrics" } },
      sinks: {
        out: {
          type: "prometheus_exporter",
          inputs: ["host"],
          address: "127.0.0.1:9599",
        },
      },
    };
    expect(fullModeRequirements(config, catalog)).toEqual([
      "source: host_metrics",
    ]);
    expect(describeNeeds(config, catalog)).toMatchObject({
      kind: "full",
      label: "Needs Full Vector",
    });
  });
  it("names what a restricted host has to approve, briefly", () => {
    expect(
      describeNeeds(
        {
          sources: {
            nginx: { type: "file", include: ["/var/log/nginx/*.log"] },
          },
          sinks: {
            loki: {
              type: "loki",
              endpoint: "https://logs.example.net",
              inputs: ["nginx"],
            },
          },
        },
        catalog,
      ),
    ).toMatchObject({
      kind: "approval",
      label: "Host approval: /var/log/nginx, logs.example.net:443",
    });
  });
  it("says nothing for a self-contained pipeline", () => {
    expect(
      describeNeeds(
        {
          sources: { demo: { type: "demo_logs", format: "json" } },
          sinks: { out: { type: "blackhole", inputs: ["demo"] } },
        },
        catalog,
      ),
    ).toEqual({ kind: "none", label: null, detail: null });
  });
});
