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

  it("stays short, counting what it leaves out", () => {
    const draft = structuredClone(saved) as any;
    for (let index = 0; index < 20; index++)
      draft.sinks[`copy_${index}`] = { type: "blackhole", inputs: ["keep"] };
    const summary = draftSummary(saved, draft);
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary).toMatch(/^\+ copy_0 \(blackhole\); .*; \d+ more$/);
  });
});
