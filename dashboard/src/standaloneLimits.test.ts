import { expect, it } from "vitest";
import {
  graphIsTooLarge,
  renderBoundedConfiguration,
} from "./standaloneLimits";
import { MAX_CONFIGURATION_BYTES, parseSource } from "./configurationSource";

const pipeline = () => ({
  sources: { events: { type: "demo_logs", format: "json" } },
  transforms: {},
  sinks: {
    out: { type: "console", inputs: ["events"], encoding: { codec: "json" } },
  },
});

it("keeps ordinary graphs and unknown settings intact", () => {
  const config = { ...pipeline(), custom: { future: "kept" } };
  expect(graphIsTooLarge(config)).toBe(false);
  expect(
    parseSource(renderBoundedConfiguration(config, "yaml"), "yaml"),
  ).toEqual(config);
});

it("bounds route and exclusive route handles even when there are few edges", () => {
  const config = pipeline();
  for (const component of [
    {
      type: "route",
      route: Object.fromEntries(
        Array.from({ length: 20000 }, (_, i) => [`r${i}`, "true"]),
      ),
    },
    {
      type: "exclusive_route",
      routes: Array.from({ length: 20000 }, (_, i) => ({
        name: `r${i}`,
        condition: "true",
      })),
    },
  ]) {
    expect(
      graphIsTooLarge({
        ...config,
        transforms: { route: { ...component, inputs: ["events"] } },
      }),
    ).toBe(true);
  }
});

it("bounds total output handles across otherwise small route components", () => {
  const routes = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [
      `route${i}`,
      {
        type: "route",
        inputs: ["events"],
        route: Object.fromEntries(
          Array.from({ length: 60 }, (_, j) => [`r${j}`, "true"]),
        ),
      },
    ]),
  );
  expect(graphIsTooLarge({ ...pipeline(), transforms: routes })).toBe(true);
});

it("counts implicit memory nodes and expanded wildcard connections", () => {
  const tables = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [
      `t${i}`,
      {
        type: "memory",
        inputs: ["events"],
        source_config: { source_key: `s${i}` },
      },
    ]),
  );
  expect(graphIsTooLarge({ ...pipeline(), enrichment_tables: tables })).toBe(
    true,
  );
  const sources = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`s${i}`, { type: "demo_logs" }]),
  );
  const sinks = Object.fromEntries(
    Array.from({ length: 84 }, (_, i) => [
      `out${i}`,
      { type: "blackhole", inputs: ["*"] },
    ]),
  );
  expect(graphIsTooLarge({ sources, sinks })).toBe(true);
  expect(
    graphIsTooLarge({
      sources,
      sinks: Object.fromEntries(Object.entries(sinks).slice(0, 80)),
    }),
  ).toBe(false);
});

it("rejects oversized conversion before replacing the exportable original", () => {
  const config = {
    ...pipeline(),
    custom: Array.from({ length: 3000 }, () => ({
      a: { b: { c: "x".repeat(325) } },
    })),
  };
  const original = JSON.stringify(config);
  expect(new TextEncoder().encode(original).length).toBeLessThan(
    MAX_CONFIGURATION_BYTES,
  );
  const parsed = parseSource(original, "json");
  for (const format of ["yaml", "json", "toml"] as const)
    expect(() => renderBoundedConfiguration(parsed, format)).toThrow(/1 MiB/);
  expect(parseSource(original, "json")).toEqual(config);
});
