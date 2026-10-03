import { describe, expect, it } from "vitest";
import { catalog, componentSchema, pipelineIssues, starter } from "./catalog";
import { vectorSchema } from "./catalog";
import { pipelineTemplates } from "./pipelineTemplates";
import {
  mapValueSchema,
  resolveSchema,
  schemaPropertyKeys,
  type Schema,
} from "./pipelineSchema";

/**
 * Vector accepts an option it doesn't have without a word: a starter that
 * writes one looks configured and does nothing (an `encoding` on an HTTP
 * server is how events arrived undecoded under a card that said JSON). The
 * generated schema is the pinned Vector's own description of every option, so
 * every option a starter writes must be one it declares for that component
 * type. A starter is incomplete on purpose (what a person must choose is left
 * out), so this asks what the schema declares, never whether it validates.
 */
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The options in `value` that `schema` doesn't declare, as dotted paths. The
 * keys of a map are values, not options, and are not checked.
 */
function undeclared(
  schema: Schema,
  value: unknown,
  path: string[] = [],
): string[] {
  if (!record(value)) return [];
  const known = new Set(schemaPropertyKeys(schema, vectorSchema));
  if (!known.size) return [];
  const resolved = resolveSchema(schema, vectorSchema, value);
  return Object.entries(value).flatMap(([key, child]) =>
    known.has(key)
      ? undeclared(mapValueSchema(resolved, key), child, [...path, key])
      : [[...path, key].join(".")],
  );
}

/** What a step of this kind and type writes that Vector's schema doesn't declare. */
function unknownOptions(
  kind: string,
  type: string,
  component: Record<string, unknown>,
) {
  const definition = catalog.find(
    (item) => item.kind === kind && item.type === type,
  );
  if (!definition) return [`${kind}.${type}: not a Vector component`];
  return undeclared(componentSchema(definition)!, component).map(
    (path) => `${kind}.${type}: ${path}`,
  );
}

describe("what a starter writes", () => {
  it("is only options the pinned Vector's schema declares, for every component a step can start from", () => {
    const found: string[] = [];
    for (const item of catalog) {
      if (!Object.keys(item.defaults).length) continue;
      found.push(
        ...unknownOptions(item.kind, item.type, {
          type: item.type,
          ...structuredClone(item.defaults),
          ...(item.kind === "sources" ? {} : { inputs: [] }),
        }),
      );
    }
    expect(found).toEqual([]);
  });

  it("is the same for the starting pipeline and for every template", () => {
    const found: string[] = [];
    for (const config of [
      starter,
      ...pipelineTemplates.map((template) => template.config),
    ] as Record<string, any>[])
      for (const kind of ["sources", "transforms", "sinks"])
        for (const component of Object.values(config[kind] ?? {}) as any[])
          found.push(...unknownOptions(kind, component.type, component));
    expect(found).toEqual([]);
  });

  it("notices an option Vector doesn't have, at any depth, and leaves map keys alone", () => {
    expect(
      unknownOptions("sources", "http_server", {
        type: "http_server",
        address: "127.0.0.1:8088",
        encoding: "json",
      }),
    ).toEqual(["sources.http_server: encoding"]);
    expect(
      unknownOptions("sinks", "console", {
        type: "console",
        inputs: [],
        encoding: { codec: "json", frobnicate: true },
      }),
    ).toEqual(["sinks.console: encoding.frobnicate"]);
    expect(
      unknownOptions("sources", "opentelemetry", {
        type: "opentelemetry",
        grpc: { address: "127.0.0.1:4317", bogus: 1 },
        http: { address: "127.0.0.1:4318" },
      }),
    ).toEqual(["sources.opentelemetry: grpc.bogus"]);
    expect(
      unknownOptions("sinks", "loki", {
        type: "loki",
        inputs: [],
        endpoint: "http://127.0.0.1:3100",
        labels: { any_name_at_all: "{{ host }}" },
      }),
    ).toEqual([]);
  });

  it("decodes what an HTTP server receives, as the card says", () => {
    const http = catalog.find(
      (item) => item.kind === "sources" && item.type === "http_server",
    )!;
    expect(http.defaults).toEqual({
      address: "127.0.0.1:8088",
      decoding: { codec: "json" },
    });
  });

  it("leaves out an option the person must choose, never writing an empty placeholder", () => {
    // `uri: ""` satisfied the required-option check and failed later in
    // Vector, filed under the pipeline's settings. A starter leaves the key
    // out, and the local check names it.
    for (const item of catalog) {
      const empties = Object.entries(item.defaults).filter(
        ([, value]) =>
          value === "" || (Array.isArray(value) && value.length === 0),
      );
      expect(empties, `${item.kind}.${item.type}`).toEqual([]);
    }
    for (const [kind, type, option] of [
      ["sinks", "http", "uri"],
      ["sinks", "loki", "endpoint"],
      ["sources", "file", "include"],
    ] as const) {
      const item = catalog.find(
        (entry) => entry.kind === kind && entry.type === type,
      )!;
      const component = {
        type,
        ...(kind === "sources" ? {} : { inputs: ["demo"] }),
        ...structuredClone(item.defaults),
      };
      const config =
        kind === "sources"
          ? {
              sources: { step: component },
              sinks: {
                out: { type: "console", inputs: ["step"], encoding: {} },
              },
            }
          : {
              sources: { demo: { type: "demo_logs" } },
              sinks: { step: component },
            };
      expect(
        pipelineIssues(config).map((issue) => issue.message),
        `${kind}.${type}`,
      ).toContain(`step: Enter ${option}.`);
    }
  });
});
