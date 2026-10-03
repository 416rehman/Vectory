import { describe, expect, it } from "vitest";
import { APIError } from "./api";
import { pipelineIssues } from "./catalog";
import { cleanSummary } from "./ProblemsPanel";
import {
  applyFix,
  editDistance,
  fixLooksIntended,
  checkFailureMessage,
  checkLabel,
  checkProblems,
  checkStatus,
  checkVerdict,
  componentProblems,
  countProblems,
  fieldProblems,
  groupProblems,
  localProblems,
  mergeProblems,
  pipelineOrder,
  settleStaleProblems,
  type PipelineCheck,
} from "./pipelineProblems";

const config = {
  sources: { nginx: { type: "file", include: [] } },
  transforms: {
    parse: {
      type: "remap",
      inputs: ["nginx"],
      source: '. = parse_nginx_log(.message, "combined")',
    },
    by_status: {
      type: "route",
      inputs: ["parse"],
      route: { server_errors: ".status >= 500" },
    },
  },
  sinks: { loki: { type: "loki", inputs: ["by_status.server_errors"] } },
};

const check: PipelineCheck = {
  valid: false,
  vector_validated: false,
  static_checked: true,
  deferred: true,
  deferred_reasons: ["device-local paths or external code files"],
  errors: [],
  warnings: [],
  diagnostics: [
    {
      severity: "error",
      section: "transforms",
      component: "parse",
      field: "source",
      code: "E103",
      line: 1,
      column: 5,
      length: 37,
      message: "unhandled fallible assignment",
      fix: {
        label: "Add `!`",
        replacement: 'parse_nginx_log!(.message, "combined")',
        scope: "span",
      },
    },
    {
      severity: "error",
      section: "transforms",
      component: "by_status",
      route_output: "server_errors",
      field: "route.server_errors",
      code: "E100",
      line: 1,
      column: 1,
      length: 14,
      message: "unhandled error",
      fix: {
        label: "Treat errors as no match",
        replacement: "((.status >= 500) ?? false)",
        scope: "span",
      },
    },
    {
      severity: "warning",
      section: "transforms",
      component: "by_status",
      route_output: "_unmatched",
      code: "no_consumers",
      message: "Events that match no route are dropped.",
    },
    {
      severity: "error",
      section: "global",
      field: "bogus",
      message: "unknown field `bogus`",
    },
    {
      severity: "error",
      section: "sources",
      component: "ghost",
      message: "not in this draft",
    },
  ],
};

describe("pipeline problems", () => {
  it("attributes Vector findings to components, fields and positions", () => {
    const problems = checkProblems(check, config);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toMatchObject({
      component: "parse",
      field: "source",
      line: 1,
      column: 5,
      message: "Unhandled fallible assignment.",
      origin: "vector",
    });
    // A finding about a missing component stays visible but unattributed.
    expect(problems[4].component).toBeUndefined();
    expect(
      fieldProblems(problems, "by_status", "route.server_errors"),
    ).toHaveLength(1);
  });

  it("falls back to text errors from older servers", () => {
    const legacy = checkProblems(
      {
        valid: false,
        vector_validated: false,
        errors: ["parse: enter vrl program."],
        warnings: [],
      },
      config,
    );
    expect(legacy[0]).toMatchObject({
      component: "parse",
      message: "Enter vrl program.",
    });
  });

  it("merges local checks without duplicating Vector findings", () => {
    const local = localProblems(
      [
        {
          severity: "error",
          message: "nginx: enter included paths.",
          componentId: "nginx",
        },
        {
          severity: "error",
          message: "parse: unhandled fallible assignment",
          componentId: "parse",
        },
      ],
      new Map([["parse", "This branch has no path to a destination."]]),
      ["Variable `region` needs a value."],
      config,
    );
    expect(local.map((problem) => problem.message)).toEqual([
      "Enter included paths.",
      "Unhandled fallible assignment.",
      "This branch has no path to a destination.",
      "Variable `region` needs a value.",
    ]);
    const merged = mergeProblems(local, checkProblems(check, config));
    const fallible = merged.filter(
      (problem) => problem.message === "Unhandled fallible assignment.",
    );
    expect(fallible).toHaveLength(1);
    expect(fallible[0].origin).toBe("vector");
    expect(countProblems(merged)).toEqual({ errors: 6, warnings: 2 });
  });

  it("groups components in pipeline order with errors first", () => {
    const groups = groupProblems(checkProblems(check, config), config);
    expect(groups.map((group) => group.key)).toEqual([
      "component:parse",
      "component:by_status",
      "section:global",
      "section:sources",
    ]);
    expect(groups[1].problems.map((problem) => problem.severity)).toEqual([
      "error",
      "warning",
    ]);
    const badges = componentProblems(checkProblems(check, config));
    expect(badges.get("by_status")).toMatchObject({ errors: 1, warnings: 1 });
  });

  it("labels the Check button by state", () => {
    expect(
      checkLabel(
        checkStatus({ checking: false, check: null, stale: false, errors: 0 }),
        0,
      ),
    ).toBe("Not checked");
    expect(
      checkLabel(
        checkStatus({ checking: true, check: null, stale: false, errors: 0 }),
        0,
      ),
    ).toBe("Checking…");
    expect(
      checkLabel(
        checkStatus({ checking: false, check, stale: false, errors: 3 }),
        3,
      ),
    ).toBe("3 problems");
    const clean = { ...check, valid: true, diagnostics: [] };
    expect(
      checkStatus({ checking: false, check: clean, stale: false, errors: 0 }),
    ).toBe("device");
    expect(checkLabel("device", 0)).toBe("Checked");
    expect(
      checkStatus({ checking: false, check: clean, stale: true, errors: 0 }),
    ).toBe("stale");
    expect(
      checkStatus({
        checking: false,
        check: { ...clean, vector_validated: true, deferred: false },
        stale: false,
        errors: 0,
      }),
    ).toBe("passed");
  });

  it("writes an honest one-line verdict", () => {
    expect(checkVerdict({ ...check, valid: true, diagnostics: [] }, 0)).toBe(
      "Vector 0.58 accepted this pipeline. Each device checks local files and paths before applying it.",
    );
    expect(
      checkVerdict(
        {
          ...check,
          valid: true,
          vector_validated: true,
          deferred: false,
          diagnostics: [],
        },
        0,
      ),
    ).toBe("Vector 0.58 accepted this pipeline.");
    expect(
      checkVerdict(
        {
          valid: true,
          vector_validated: false,
          static_checked: false,
          errors: [],
          warnings: [],
          diagnostics: [
            { severity: "warning", code: "structural_only", message: "" },
          ],
        },
        0,
      ),
    ).toMatch(/Only the pipeline structure/);
    expect(checkVerdict(check, 2)).toBe("2 problems to fix before publishing.");
  });

  it("says enrichment tables are read on devices once, in a sentence", () => {
    const tables: PipelineCheck = {
      ...check,
      valid: true,
      diagnostics: [],
      deferred_reasons: [
        "Enrichment tables are read on devices",
        "device enrichment data",
        "device-local paths or external code files",
      ],
    };
    const verdict = checkVerdict(tables, 0);
    expect(verdict).toBe(
      "Vector 0.58 accepted this pipeline. Each device checks enrichment data files and local files and paths before applying it.",
    );
    expect(verdict).not.toContain("Enrichment tables are read on devices");
  });

  it("says a Lua step is checked on devices in a sentence, never as the raw reason", () => {
    const lua: PipelineCheck = {
      ...check,
      valid: true,
      diagnostics: [],
      deferred_reasons: ["Lua runs on devices"],
    };
    expect(checkVerdict(lua, 0)).toBe(
      "Vector 0.58 accepted this pipeline. Each device checks Lua code before applying it.",
    );
    expect(
      checkVerdict(
        {
          ...lua,
          deferred_reasons: ["Lua runs on devices", "environment variables"],
        },
        0,
      ),
    ).toBe(
      "Vector 0.58 accepted this pipeline. Each device checks Lua code and environment variables before applying it.",
    );
  });

  it("says an instance metadata step is checked on devices in a sentence, never as the raw reason", () => {
    const metadata: PipelineCheck = {
      ...check,
      valid: true,
      diagnostics: [],
      deferred_reasons: [
        "The AWS instance metadata step is checked on devices",
      ],
    };
    expect(checkVerdict(metadata, 0)).toBe(
      "Vector 0.58 accepted this pipeline. Each device checks the AWS instance metadata step before applying it.",
    );
    expect(
      checkVerdict(
        {
          ...metadata,
          deferred_reasons: [
            "Lua runs on devices",
            "The AWS instance metadata step is checked on devices",
            "Enrichment tables are read on devices",
          ],
        },
        0,
      ),
    ).toBe(
      "Vector 0.58 accepted this pipeline. Each device checks Lua code, the AWS instance metadata step and enrichment data files before applying it.",
    );
  });

  it("applies span and line fixes and refuses stale positions", () => {
    const program = '. = parse_nginx_log(.message, "combined")\n.ok = true';
    expect(applyFix(program, check.diagnostics![0] as any)).toBe(
      '. = parse_nginx_log!(.message, "combined")\n.ok = true',
    );
    expect(
      applyFix("  .code = to_int(.status)", {
        line: 1,
        column: 11,
        length: 15,
        fix: {
          label: "",
          replacement: ".code, err = to_int(.status)",
          scope: "line",
        },
      }),
    ).toBe("  .code, err = to_int(.status)");
    expect(
      applyFix("x", {
        line: 4,
        column: 1,
        length: 1,
        fix: { label: "", replacement: "y", scope: "span" },
      }),
    ).toBeNull();
    expect(
      applyFix("é = 1", {
        line: 1,
        column: 1,
        length: 1,
        fix: { label: "", replacement: ".e", scope: "span" },
      }),
    ).toBe(".e = 1");
  });

  it("reads the option path from local messages and skips deferral notes", () => {
    const local = localProblems(
      [
        {
          severity: "error",
          message: "sinks.loki.buffer.max_size: must be at least 1.",
          componentId: "loki",
        },
        {
          severity: "error",
          message: "parse: Enter source.",
          componentId: "parse",
        },
        {
          severity: "warning",
          code: "deferred",
          message: "Each device resolves secrets before applying.",
        },
      ],
      new Map(),
      [],
      config,
    );
    expect(local).toHaveLength(2);
    expect(local[0]).toMatchObject({
      component: "loki",
      section: "sinks",
      field: "buffer.max_size",
      message: "Must be at least 1.",
    });
    expect(local[1]).toMatchObject({ field: "source", code: "missing_field" });
  });

  it("jumps to the credential a bearer or basic strategy still needs", () => {
    const sink = {
      sinks: {
        out: { type: "http", inputs: ["in"], auth: { strategy: "bearer" } },
      },
    };
    const issue = pipelineIssues({
      sources: { in: { type: "demo_logs", format: "json" } },
      sinks: {
        out: {
          type: "http",
          inputs: ["in"],
          uri: "https://logs.example.test",
          encoding: { codec: "json" },
          auth: { strategy: "bearer" },
        },
      },
    }).filter((item) => item.id === "out");
    expect(issue).toHaveLength(1);
    const [problem] = localProblems(
      issue.map((item) => ({
        severity: "error" as const,
        message: item.message,
        componentId: item.id,
      })),
      new Map(),
      [],
      sink,
    );
    expect(problem).toMatchObject({
      component: "out",
      field: "auth.token",
      message: "Enter a valid token secret reference in Authentication.",
    });
  });

  it("lets a local settings finding stand in for Vector's, but never hides VRL or unknown options", () => {
    const local = localProblems(
      [
        {
          severity: "error",
          message: "loki: Enter endpoint.",
          componentId: "loki",
        },
      ],
      new Map(),
      [],
      config,
    );
    const vector = checkProblems(
      {
        valid: false,
        vector_validated: false,
        static_checked: true,
        errors: [],
        warnings: [],
        diagnostics: [
          {
            severity: "error",
            component: "loki",
            code: "missing_field",
            field: "endpoint",
            message: "Required setting `endpoint` is missing.",
          },
          {
            severity: "error",
            component: "loki",
            code: "invalid_type",
            message: "invalid type: string, expected a map",
          },
          {
            severity: "error",
            component: "loki",
            code: "unknown_field",
            field: "labls",
            message: "`labls` is not a loki option.",
          },
          {
            severity: "error",
            component: "parse",
            code: "E103",
            field: "source",
            message: "unhandled fallible assignment",
          },
          {
            severity: "error",
            section: "global",
            code: "empty_pipeline",
            message: "At least one source is required",
          },
        ],
      },
      config,
    );
    const merged = mergeProblems(local, vector).map((problem) => problem.code);
    expect(merged).toEqual([
      "missing_field",
      "unknown_field",
      "E103",
      "empty_pipeline",
    ]);
    const empty = localProblems(
      [
        {
          severity: "error",
          message: "Add a source to choose where events come from.",
        },
      ],
      new Map(),
      [],
      config,
    );
    expect(
      mergeProblems(empty, vector).filter(
        (problem) => problem.code === "empty_pipeline",
      ),
    ).toHaveLength(0);
  });

  it("keeps a stale finding's position and fix only while its program is unchanged", () => {
    const stale = checkProblems(check, config, true);
    const unchanged = settleStaleProblems(stale, () => "same");
    expect(unchanged[0]).toMatchObject({
      line: 1,
      column: 5,
      fix: { scope: "span" },
    });
    const edited = settleStaleProblems(stale, (draft) =>
      draft === "checked" ? "before" : "after",
    );
    expect(edited[0].line).toBeUndefined();
    expect(edited[0].fix).toBeUndefined();
    expect(edited[0].message).toBe("Unhandled fallible assignment.");
    // Findings without a program position are untouched.
    expect(edited[2]).toBe(stale[2]);
  });

  it("treats a check that could not run as the check's state, not a problem", () => {
    const unavailable: PipelineCheck = {
      valid: false,
      vector_validated: false,
      static_checked: false,
      errors: [],
      warnings: [],
      diagnostics: [
        {
          severity: "error",
          code: "validator_unavailable",
          message:
            "Configured isolated Vector validator is unavailable; publication is blocked.",
        },
      ],
    };
    expect(checkProblems(unavailable, config)).toEqual([]);
    const status = checkStatus({
      checking: false,
      check: unavailable,
      stale: false,
      errors: 0,
    });
    expect(status).toBe("unavailable");
    expect(checkLabel(status, 0)).toBe("Couldn't check");
    expect(checkVerdict(unavailable, 0)).toMatch(/checker isn.t reachable/);
    expect(
      checkStatus({
        checking: false,
        check: null,
        stale: false,
        errors: 0,
        failed: true,
      }),
    ).toBe("unavailable");
    const structural: PipelineCheck = {
      valid: true,
      vector_validated: false,
      static_checked: false,
      errors: [],
      warnings: [],
      diagnostics: [
        {
          severity: "warning",
          code: "structural_only",
          message: "Only structure",
        },
      ],
    };
    expect(
      checkStatus({
        checking: false,
        check: structural,
        stale: false,
        errors: 0,
      }),
    ).toBe("partial");
    expect(checkLabel("partial", 0)).toBe("Partly checked");
    expect(checkVerdict(null, 2)).toBe("2 problems to fix before publishing.");
  });

  it("orders components the way events flow, not by name", () => {
    const order = pipelineOrder({
      sinks: { archive: { type: "blackhole", inputs: ["a_route.kept"] } },
      transforms: {
        a_route: { type: "route", inputs: ["b_parse"] },
        b_parse: { type: "remap", inputs: ["z_source"] },
      },
      sources: { z_source: { type: "demo_logs" } },
      enrichment_tables: { geo: { type: "file" } },
    });
    expect([...order.keys()]).toEqual([
      "z_source",
      "b_parse",
      "a_route",
      "archive",
      "geo",
    ]);
  });

  it("never reads as clean when the check could not run", () => {
    expect(cleanSummary("unavailable")).toBe("Not checked");
    expect(cleanSummary("unchecked")).toBe("Not checked");
    expect(cleanSummary("stale")).toBe("Not checked");
    expect(cleanSummary("checking")).toBe("Checking…");
    expect(cleanSummary("passed")).toBe("No problems");
    expect(cleanSummary("device")).toBe("No problems");
    expect(
      checkFailureMessage(
        new APIError(
          "CAPABILITY_DENIED",
          "Isolated Vector validator is unavailable",
          503,
          true,
        ),
      ),
    ).toBe(
      "Vector's checker isn't reachable, so this draft hasn't been checked. Publishing waits for a successful check.",
    );
    expect(checkFailureMessage(new TypeError("Failed to fetch"))).toMatch(
      /^Couldn't reach Vectory/,
    );
    expect(
      checkFailureMessage(
        new APIError("INVALID_INPUT", "Bad draft", 400, true),
      ),
    ).toBe("Couldn't check with Vector: Bad draft");
  });

  it("keeps a compound condition's logic when a span fix is applied", () => {
    expect(
      applyFix(".status >= 400 && .status < 500", {
        line: 1,
        column: 1,
        length: 14,
        fix: {
          label: "Treat errors as no match",
          replacement: "((.status >= 400) ?? false)",
          scope: "span",
        },
      }),
    ).toBe("((.status >= 400) ?? false) && .status < 500");
  });

  it("shows an event type mismatch as a problem on the consumer's inputs", () => {
    const problems = checkProblems(
      {
        valid: false,
        vector_validated: false,
        static_checked: false,
        errors: ["`r.a` emits logs but `dd` accepts metrics."],
        warnings: [],
        diagnostics: [
          {
            severity: "error",
            section: "sinks",
            component: "dd",
            field: "inputs",
            code: "type_mismatch",
            message: "`r.a` emits logs but `dd` accepts metrics.",
            hint: "Connect a step that produces the event type this component accepts.",
          },
        ],
      },
      { sinks: { dd: { type: "datadog_metrics", inputs: ["r.a"] } } },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      severity: "error",
      component: "dd",
      field: "inputs",
      code: "type_mismatch",
    });
  });

  it("treats an incomplete check as not checked", () => {
    const incomplete: PipelineCheck = {
      valid: false,
      vector_validated: false,
      static_checked: false,
      errors: [],
      warnings: [],
      diagnostics: [
        {
          severity: "error",
          code: "validator_incomplete",
          message: "Vector did not finish checking this pipeline.",
        },
      ],
    };
    expect(checkProblems(incomplete, {})).toEqual([]);
    expect(
      checkStatus({
        checking: false,
        check: incomplete,
        stale: false,
        errors: 0,
      }),
    ).toBe("unavailable");
  });

  it("offers a did-you-mean fix only for a near miss", () => {
    const fix = (replacement: string) => ({
      label: `Change to \`${replacement}\``,
      replacement,
      scope: "span" as const,
    });
    expect(editDistance("parse_timestmp", "parse_timestamp")).toBe(1);
    // A near miss reads as a typo.
    expect(
      fixLooksIntended(".ts = parse_timestmp!(.t)", {
        line: 1,
        column: 7,
        length: 14,
        fix: fix("parse_timestamp"),
      }),
    ).toBe(true);
    // Half-typed, the closest suggestion is far off and would only be noise.
    expect(
      fixLooksIntended(".ts = parse_tim", {
        line: 1,
        column: 7,
        length: 9,
        fix: fix("false"),
      }),
    ).toBe(false);
    // Exact fixes are always offered.
    expect(
      fixLooksIntended(".a = to_int(.b)", {
        line: 1,
        column: 6,
        length: 9,
        fix: {
          label: "Add `!`",
          replacement: "to_int!(.b)",
          scope: "span",
        },
      }),
    ).toBe(true);
  });
});
