import { describe, expect, it } from "vitest";
import type { Config } from "./api";
import {
  pipelineConnectivity,
  NO_DESTINATION_WARNING,
} from "./pipelineConnectivity";

const ids = (config: Config) => [...pipelineConnectivity(config).keys()].sort();
const fixture = (): Config => ({
  sources: {
    seed: { type: "demo_logs", format: "json" },
    dead_source: { type: "demo_logs", format: "json" },
  },
  transforms: {
    guard: { type: "filter", inputs: ["dead_source"], condition: "true" },
    throttle: {
      type: "throttle",
      inputs: ["guard"],
      threshold: 100,
      window_secs: 1,
    },
  },
  sinks: { output: { type: "blackhole", inputs: ["seed"] } },
});

describe("non-blocking pipeline destination connectivity", () => {
  it("finds the whole dead branch, repairs through one connection, and never changes the config", () => {
    const config = fixture(),
      before = structuredClone(config);
    expect(ids(config)).toEqual(["dead_source", "guard", "throttle"]);
    expect(pipelineConnectivity(config).get("throttle")).toBe(
      NO_DESTINATION_WARNING,
    );
    expect(config).toEqual(before);
    config.sinks.output.inputs.push("throttle");
    expect(ids(config)).toEqual([]);
    config.sinks.output.inputs.pop();
    expect(ids(config)).toEqual(["dead_source", "guard", "throttle"]);
  });

  it("warns unused sources and transforms but never destinations", () => {
    expect(
      ids({
        sources: { orphan: { type: "demo_logs" } },
        transforms: { idle: { type: "remap", inputs: [] } },
        sinks: { out: { type: "blackhole", inputs: [] } },
      }),
    ).toEqual(["idle", "orphan"]);
    expect(ids({ sources: { only: { type: "demo_logs" } } })).toEqual(["only"]);
  });

  it("accepts one connected route output without demanding that every branch is consumed", () => {
    const config = fixture();
    config.transforms.routes = {
      type: "route",
      inputs: ["throttle"],
      route: { accepted: "true", ignored: "false" },
      reroute_unmatched: false,
    };
    config.sinks.output.inputs.push("routes.accepted");
    expect(ids(config)).toEqual([]);
    config.sinks.output.inputs[1] = "routes.does_not_exist";
    expect(ids(config)).toEqual(["dead_source", "guard", "routes", "throttle"]);
    config.sinks.output.inputs[1] = "routes";
    expect(ids(config)).toEqual(["dead_source", "guard", "routes", "throttle"]);
  });

  it("does not let a known nonexistent simple or named source port establish a path", () => {
    const config: Config = {
      sources: { logs: { type: "demo_logs" }, otel: { type: "opentelemetry" } },
      sinks: {
        out: { type: "blackhole", inputs: ["logs.missing", "otel.missing"] },
      },
    };
    expect(ids(config)).toEqual(["logs", "otel"]);
    config.sinks.out.inputs = ["logs", "otel.metrics"];
    expect(ids(config)).toEqual([]);
  });

  it("distinguishes a route named output from the UI's unnamed default handle", () => {
    for (const component of [
      {
        type: "route",
        inputs: ["seed"],
        route: { output: "true" },
        reroute_unmatched: false,
      },
      {
        type: "exclusive_route",
        inputs: ["seed"],
        routes: [{ name: "output", condition: "true" }],
      },
    ]) {
      const config: Config = {
        sources: { seed: { type: "demo_logs" } },
        transforms: { routes: component },
        sinks: { out: { type: "blackhole", inputs: ["routes"] } },
      };
      expect(ids(config)).toEqual(["routes", "seed"]);
      config.sinks.out.inputs = ["routes.output"];
      expect(ids(config)).toEqual([]);
    }
    const config: Config = {
      sources: { seed: { type: "demo_logs" } },
      sinks: { out: { type: "blackhole", inputs: ["seed.output"] } },
    };
    expect(ids(config)).toEqual(["seed"]);
    config.sinks.out.inputs = ["seed"];
    expect(ids(config)).toEqual([]);
  });

  it("terminates for disconnected cycles and accepts a cycle with a literal path to a sink", () => {
    const config: Config = {
      sources: { seed: { type: "demo_logs" } },
      transforms: {
        a: { type: "remap", inputs: ["seed", "b"] },
        b: { type: "remap", inputs: ["a"] },
      },
      sinks: { out: { type: "blackhole", inputs: [] } },
    };
    expect(ids(config)).toEqual(["a", "b", "seed"]);
    config.sinks.out.inputs = ["b"];
    expect(ids(config)).toEqual([]); // graph validation still reports the cycle separately
  });

  it("defers provider and native pattern reachability without guessing glob matches", () => {
    const config = fixture();
    expect(
      ids({
        ...config,
        provider: { type: "http", url: "https://example.test/vector" },
      }),
    ).toEqual([]);
    for (const input of [
      "app_*",
      "app_?",
      "app_[ab]",
      "${INPUT}",
      "SECRET[host.input]",
      "native_registered.events",
    ]) {
      config.sinks.output.inputs = [input];
      expect(ids(config), input).toEqual([]);
    }
    // A dynamic consumer that itself has no destination does not make a path.
    config.sinks.output.inputs = ["seed"];
    config.transforms.throttle.inputs = ["*"];
    expect(ids(config)).toEqual(["dead_source", "guard", "throttle"]);
    config.sinks.output.inputs.push("throttle");
    expect(ids(config)).toEqual([]);
  });

  it("treats unmodelled native named ports as potential literal edges", () => {
    const config: Config = {
      sources: {
        custom: { type: "native_extension" },
        unused: { type: "demo_logs" },
      },
      sinks: {
        out: { type: "blackhole", inputs: ["custom.output.with.dots"] },
      },
    };
    expect(ids(config)).toEqual(["unused"]);
  });

  it("counts memory table consumers as terminals and keeps their export source independent", () => {
    const config = fixture();
    config.enrichment_tables = {
      lookup: {
        type: "memory",
        inputs: ["throttle"],
        source_config: { source_key: "cache_events" },
      },
    };
    expect(ids(config)).toEqual([]);
    config.enrichment_tables.lookup.inputs = [];
    config.sinks.output.inputs.push("cache_events");
    expect(ids(config)).toEqual(["dead_source", "guard", "throttle"]);
    config.enrichment_tables.lookup.inputs = ["app_*"];
    expect(ids(config)).toEqual([]);
  });

  it("leaves ambiguous or malformed topology to existing graph diagnostics", () => {
    expect(
      ids({
        sources: { same: { type: "demo_logs" } },
        sinks: { same: { type: "blackhole", inputs: [] } },
      }),
    ).toEqual([]);
    expect(ids({ sources: { missing: null, list: [], broken: {} } })).toEqual(
      [],
    );
    expect(ids(null as unknown as Config)).toEqual([]);
  });
});
