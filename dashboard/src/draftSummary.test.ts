import { describe, expect, it } from "vitest";
import { draftSummary } from "./draftSummary";

const saved = {
  sources: { nginx: { type: "file", include: ["/var/log/nginx/*.log"] } },
  transforms: {
    enrich: { type: "remap", inputs: ["nginx"], source: ".a = 1" },
    keep: { type: "filter", inputs: ["enrich"], condition: ".ok == true" },
  },
  sinks: {
    loki: { type: "loki", inputs: ["keep"], endpoint: "http://loki:3100" },
  },
};

describe("draft summary", () => {
  it("names program changes, new steps and removed steps", () => {
    const draft = structuredClone(saved) as any;
    draft.transforms.enrich.source = ".a = 2";
    draft.sinks.archive = {
      type: "aws_s3",
      inputs: ["enrich"],
      bucket: "logs",
    };
    delete draft.sinks.loki;
    expect(draftSummary(saved, draft)).toBe(
      "enrich: VRL changed; + archive (aws_s3); − loki",
    );
  });

  it("describes options, conditions, rewiring and type changes briefly", () => {
    const draft = structuredClone(saved) as any;
    draft.transforms.keep.condition = ".ok";
    draft.transforms.keep.inputs = ["nginx"];
    draft.sinks.loki.endpoint = "http://loki.internal:3100";
    draft.sinks.loki.labels = { app: "nginx" };
    draft.sources.nginx = { type: "journald" };
    expect(draftSummary(saved, draft)).toBe(
      "nginx: now journald; keep: condition changed, rewired; loki: 2 options changed",
    );
  });

  it("reports tests, pipeline settings and variables", () => {
    const draft = {
      ...structuredClone(saved),
      timezone: "UTC",
      tests: [{ name: "a" }, { name: "b" }],
    };
    expect(draftSummary(saved, draft, [], [{ name: "region" }])).toBe(
      "pipeline settings changed; + 2 tests; variables changed",
    );
    expect(draftSummary(saved, saved)).toBe("No configuration changes");
  });

  it("compares by meaning: the order of keys is no change", () => {
    // The server stores keys sorted and a draft keeps the order they were
    // typed in; the same tests and options are not a change.
    const withTests = {
      ...saved,
      tests: [
        {
          name: "parses",
          inputs: [{ insert_at: "enrich", type: "log", log_fields: { a: 1 } }],
          outputs: [{ extract_from: "enrich", conditions: [{ type: "vrl" }] }],
        },
      ],
    };
    const sorted = {
      ...saved,
      tests: [
        {
          outputs: [{ conditions: [{ type: "vrl" }], extract_from: "enrich" }],
          inputs: [{ log_fields: { a: 1 }, insert_at: "enrich", type: "log" }],
          name: "parses",
        },
      ],
    };
    expect(draftSummary(withTests, sorted)).toBe("No configuration changes");
    const reordered = structuredClone(saved) as any;
    reordered.sinks.loki = {
      endpoint: "http://loki:3100",
      inputs: ["keep"],
      type: "loki",
    };
    expect(draftSummary(saved, reordered)).toBe("No configuration changes");
    // A step fed by the same inputs in another order is not rewired.
    const two = {
      ...saved,
      sinks: { loki: { ...saved.sinks.loki, inputs: ["keep", "enrich"] } },
    };
    const swapped = {
      ...saved,
      sinks: { loki: { ...saved.sinks.loki, inputs: ["enrich", "keep"] } },
    };
    expect(draftSummary(two, swapped)).toBe("No configuration changes");
    // A real change to a test still shows.
    const edited = structuredClone(sorted) as any;
    edited.tests[0].inputs[0].log_fields.a = 2;
    expect(draftSummary(sorted, edited)).toBe("tests changed");
  });

  it("stays short, counting what it leaves out", () => {
    const draft = structuredClone(saved) as any;
    for (let index = 0; index < 20; index++)
      draft.sinks[`copy_${index}`] = { type: "blackhole", inputs: ["keep"] };
    const summary = draftSummary(saved, draft);
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary).toMatch(/^\+ copy_0 \(blackhole\); .*; \d+ more$/);
  });
});
