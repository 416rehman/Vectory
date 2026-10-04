import { describe, expect, it } from "vitest";
import {
  mergeDraftCopies,
  serializeLocalDraftCopy,
  staleDraftDifferences,
} from "./staleDraftRecovery";

describe("stale draft recovery", () => {
  it("compares configuration and declarations without mutating either copy", () => {
    const server = {
      config: {
        sources: { input: { type: "demo_logs", format: "json" } },
        sinks: { output: { type: "console", inputs: ["input"] } },
      },
      variables: [
        { name: "port", path: "sources.input.port", type: "integer" as const },
      ],
    };
    const local = structuredClone(server);
    local.config.sources.input.format = "shuffle";
    local.variables[0].path = "sources.other.port";
    const original = structuredClone(server);

    expect(staleDraftDifferences(local, server)).toEqual([
      { path: "sources.input.format", server: "json", local: "shuffle" },
      {
        path: "Variables [0].path",
        server: "sources.input.port",
        local: "sources.other.port",
      },
    ]);
    expect(server).toEqual(original);
  });

  it("downloads a complete local copy including layout and unapplied Code text", () => {
    const backup = JSON.parse(
      serializeLocalDraftCopy({
        revision: 9,
        config: { sources: { local: { type: "demo_logs" } } },
        variables: [],
        positions: { local: { x: 12, y: 30 } },
        unappliedCode: { format: "yaml", text: "sources:\n  local:" },
      }),
    );
    expect(backup).toEqual({
      format: "vectory-local-draft-backup-v1",
      base_revision: 9,
      config: { sources: { local: { type: "demo_logs" } } },
      variables: [],
      positions: { local: { x: 12, y: 30 } },
      unapplied_code: { format: "yaml", text: "sources:\n  local:" },
    });
  });

  it("merges separate component fields and node moves without changing any input", () => {
    const base = {
      config: {
        sources: { input: { type: "demo_logs", format: "json", interval: 1 } },
      },
      variables: [],
      positions: { input: { x: 20, y: 30 } },
    };
    const local = structuredClone(base);
    local.config.sources.input.interval = 2;
    local.positions.input.x = 80;
    const server = structuredClone(base);
    server.config.sources.input.format = "shuffle";
    server.positions.input.y = 50;
    const originals = structuredClone({ base, local, server });

    expect(mergeDraftCopies(base, local, server)).toEqual({
      merged: {
        config: {
          sources: {
            input: { type: "demo_logs", format: "shuffle", interval: 2 },
          },
        },
        variables: [],
        positions: { input: { x: 80, y: 50 } },
      },
      conflicts: [],
    });
    expect({ base, local, server }).toEqual(originals);
  });

  it("lists same-field, delete-versus-change, and reordered-array conflicts", () => {
    const base = {
      config: {
        transforms: { map: { type: "remap", source: ".x = 1" } },
        sinks: { out: { type: "console", inputs: ["map", "other"] } },
      },
      variables: [],
      positions: {},
    };
    const local = structuredClone(base);
    local.config.transforms.map.source = ".x = 2";
    local.config.sinks.out.inputs = ["other", "map"];
    const server = structuredClone(base);
    server.config.transforms.map.source = ".x = 3";
    delete (server.config.sinks as Record<string, unknown>).out;
    const result = mergeDraftCopies(base, local, server);
    expect(result.conflicts.map((conflict) => conflict.path)).toEqual([
      "transforms.map.source",
      "sinks.out",
    ]);
    expect(result.merged.config.transforms.map.source).toBe(".x = 3");
    expect(result.merged.config.sinks).toEqual({});
    const mine = mergeDraftCopies(base, local, server, {
      "transforms.map.source": "local",
      "sinks.out": "local",
    });
    expect(mine.merged.config.transforms.map.source).toBe(".x = 2");
    expect(mine.merged.config.sinks.out.inputs).toEqual(["other", "map"]);
  });

  it("keeps ordered variable declarations atomic when both sides edit them", () => {
    const base = {
      config: {},
      variables: [
        { name: "port", path: "sources.in.port", type: "integer" as const },
      ],
      positions: {},
    };
    const local = structuredClone(base);
    local.variables[0].path = "sources.local.port";
    const server = structuredClone(base);
    server.variables[0].path = "sources.server.port";
    const merged = mergeDraftCopies(base, local, server);
    expect(merged.conflicts.map((conflict) => conflict.path)).toEqual([
      "Variables",
    ]);
    expect(merged.merged.variables).toEqual(server.variables);
  });

  it("does not carry fields across a component type replacement", () => {
    const base = {
      config: { transforms: { step: { type: "remap", source: ".x = 1" } } },
      variables: [],
      positions: {},
    };
    const local = {
      ...base,
      config: { transforms: { step: { type: "filter", condition: ".x > 0" } } },
    };
    const server = {
      ...base,
      config: { transforms: { step: { type: "remap", source: ".x = 2" } } },
    };
    const result = mergeDraftCopies(base, local, server);
    expect(result.conflicts.map((conflict) => conflict.path)).toEqual([
      "transforms.step",
    ]);
    expect(result.merged.config.transforms.step).toEqual(
      server.config.transforms.step,
    );
    expect(
      mergeDraftCopies(base, local, server, {
        "transforms.step": "local",
      }).merged.config.transforms.step,
    ).toEqual(local.config.transforms.step);
  });

  it("keeps an incomplete component atomic when editors supply different types", () => {
    const base = {
      config: { transforms: { step: {} } },
      variables: [],
      positions: {},
    };
    const local = {
      ...base,
      config: { transforms: { step: { type: "filter", condition: ".x > 0" } } },
    };
    const server = {
      ...base,
      config: { transforms: { step: { type: "remap", source: ".x = 1" } } },
    };
    const result = mergeDraftCopies(base, local, server);
    expect(result.conflicts.map((conflict) => conflict.path)).toEqual([
      "transforms.step",
    ]);
    expect(result.merged.config.transforms.step).toEqual(
      server.config.transforms.step,
    );
    expect(
      mergeDraftCopies(base, local, server, {
        "transforms.step": "local",
      }).merged.config.transforms.step,
    ).toEqual(local.config.transforms.step);
  });

  it("merges pipeline details with the same explicit conflict rule", () => {
    const base = {
      config: {},
      variables: [],
      positions: {},
      metadata: { name: "Pipeline", description: "Original" },
    };
    const local = {
      ...base,
      metadata: { name: "My pipeline", description: "Original" },
    };
    const server = {
      ...base,
      metadata: { name: "Pipeline", description: "Peer description" },
    };
    expect(mergeDraftCopies(base, local, server).merged.metadata).toEqual({
      name: "My pipeline",
      description: "Peer description",
    });
    const competing = {
      ...server,
      metadata: { name: "Peer pipeline", description: "Peer description" },
    };
    expect(
      mergeDraftCopies(base, local, competing).conflicts.map(
        (conflict) => conflict.path,
      ),
    ).toEqual(["Pipeline name"]);
  });

  it("requires a metadata choice when an older backup has no metadata base", () => {
    const base = { config: {}, variables: [], positions: {} };
    const local = {
      ...base,
      metadata: { name: "My pipeline", description: "Local" },
    };
    const server = {
      ...base,
      metadata: { name: "Peer pipeline", description: "Server" },
    };
    const result = mergeDraftCopies(base, local, server);
    expect(result.conflicts.map((conflict) => conflict.path)).toEqual([
      "Pipeline details",
    ]);
    expect(result.merged.metadata).toEqual(server.metadata);
    expect(
      mergeDraftCopies(base, local, server, { "Pipeline details": "local" })
        .merged.metadata,
    ).toEqual(local.metadata);
  });
});
