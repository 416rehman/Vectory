import { describe, expect, it } from "vitest";
import {
  MAX_PATTERN_EDGES,
  globMatch,
  patternEdges,
  patternInputs,
  patternSummary,
  unmatchedPatternMessage,
} from "./inputPatterns";
import {
  checkProblems,
  localProblems,
  mergeProblems,
} from "./pipelineProblems";

describe("glob matching as Vector applies it to component names", () => {
  it("supports *, ? and character sets", () => {
    expect(globMatch("app_*", "app_a")).toBe(true);
    expect(globMatch("app_*", "app_")).toBe(true);
    expect(globMatch("app_*", "web_a")).toBe(false);
    expect(globMatch("*_logs", "nginx_logs")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "ac")).toBe(false);
    expect(globMatch("app_[ab]", "app_b")).toBe(true);
    expect(globMatch("app_[ab]", "app_c")).toBe(false);
    expect(globMatch("app_[!ab]", "app_c")).toBe(true);
    expect(globMatch("v[0-9]*", "v2_edge")).toBe(true);
    expect(globMatch("route.*", "route.errors")).toBe(true);
    expect(globMatch("[", "[")).toBe(true);
  });

  it("cannot be stalled by a pattern with many stars", () => {
    const started = Date.now();
    expect(globMatch("*a".repeat(60) + "b", "a".repeat(200))).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
    expect(globMatch("*".repeat(300), "anything")).toBe(false);
  });
});

const config = {
  sources: {
    app_a: { type: "demo_logs" },
    app_b: { type: "demo_logs" },
    other: { type: "demo_logs" },
  },
  transforms: {
    app_route: {
      type: "route",
      inputs: ["other"],
      route: { errors: "true" },
    },
  },
  sinks: {
    out: { type: "console", inputs: ["app_*"] },
    env: { type: "console", inputs: ["${SOURCE_NAME}", "other"] },
  },
};

describe("wildcard inputs", () => {
  it("list what each pattern matches, including named outputs", () => {
    const found = patternInputs(config);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ target: "out", pattern: "app_*" });
    expect(found[0].matches.map((match) => match.reference)).toEqual([
      "app_a",
      "app_b",
      "app_route.errors",
      "app_route._unmatched",
    ]);
    expect(patternSummary(found[0])).toBe(
      "app_* matches app_a, app_b, app_route.errors and app_route._unmatched. Vector resolves the pattern on each device.",
    );
  });

  it("never match the step that holds the pattern", () => {
    const self = {
      sources: { a: { type: "demo_logs" } },
      transforms: { a_out: { type: "remap", inputs: ["a*"] } },
    };
    expect(patternInputs(self)[0].matches.map((m) => m.id)).toEqual(["a"]);
  });

  it("draw one dashed edge per match from the output it names", () => {
    const edges = patternEdges(patternInputs(config));
    expect(
      edges.map((edge) => [edge.source, edge.sourceHandle, edge.target]),
    ).toEqual([
      ["app_a", "output", "out"],
      ["app_b", "output", "out"],
      ["app_route", "errors", "out"],
      ["app_route", "_unmatched", "out"],
    ]);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
    expect(edges.every((edge) => edge.pattern === "app_*")).toBe(true);
  });

  it("stop drawing after a limit and say how many more match", () => {
    const many = {
      sources: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `s${index}`,
          { type: "demo_logs" },
        ]),
      ),
      sinks: { out: { type: "console", inputs: ["s*"] } },
    };
    const edges = patternEdges(patternInputs(many));
    expect(edges).toHaveLength(MAX_PATTERN_EDGES);
    expect(edges.at(-1)!.more).toBe(40 - MAX_PATTERN_EDGES);
    expect(edges.slice(0, -1).every((edge) => edge.more === 0)).toBe(true);
  });

  it("warn only when a pattern matches nothing, without contradicting the check", () => {
    const empty = {
      sources: { web: { type: "demo_logs" } },
      sinks: { out: { type: "console", inputs: ["app_*"] } },
    };
    const problems = localProblems([], new Map(), [], empty);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      severity: "warning",
      component: "out",
      field: "inputs",
      code: "pattern_unmatched",
      message: "app_* matches no step in this pipeline.",
    });
    expect(problems[0].hint).toMatch(/wildcard_matching to relaxed/);
    expect(
      unmatchedPatternMessage(patternInputs(empty)[0], {
        ...empty,
        wildcard_matching: "relaxed",
      }).hint,
    ).toMatch(/still runs/);
    // A pattern with matches adds no problem, and Vector's generic
    // structural note is dropped.
    expect(localProblems([], new Map(), [], config)).toEqual([]);
    expect(
      checkProblems(
        {
          valid: true,
          vector_validated: true,
          static_checked: true,
          errors: [],
          warnings: [],
          diagnostics: [
            {
              severity: "warning",
              section: "sinks",
              component: "out",
              field: "inputs",
              message:
                "dynamic input pattern requires native Vector topology validation",
            },
          ],
        },
        config,
      ),
    ).toEqual([]);
  });
});

describe("an empty pipeline", () => {
  it("shows its guidance once, not again in Vector's words", () => {
    const local = localProblems(
      [
        {
          severity: "error",
          message: "Add a source to choose where events come from.",
        },
        {
          severity: "error",
          message: "Add a destination to choose where events go.",
        },
      ],
      new Map(),
      [],
      {},
    );
    const vector = checkProblems(
      {
        valid: false,
        vector_validated: false,
        static_checked: true,
        errors: [],
        warnings: [],
        diagnostics: [
          { severity: "error", message: "No sources defined in the config." },
          { severity: "error", message: "No sinks defined in the config." },
        ],
      },
      {},
    );
    expect(mergeProblems(local, vector).map((item) => item.message)).toEqual([
      "Add a source to choose where events come from.",
      "Add a destination to choose where events go.",
    ]);
  });
});
