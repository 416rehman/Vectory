import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PipelineTestResults, {
  deferralNote,
  detailAdds,
  refusalReason,
  refusalSentence,
  testHeadline,
  type PipelineTest,
} from "./PipelineTestResults";

const test = (passed: boolean) => ({ name: "t", passed });

describe("pipeline test headline", () => {
  it("counts Vector's own verdicts", () => {
    expect(
      testHeadline({
        valid: true,
        errors: [],
        tests: [test(true), test(true)],
      }),
    ).toBe("All 2 tests passed");
    expect(testHeadline({ valid: true, errors: [], tests: [test(true)] })).toBe(
      "1 test passed",
    );
    expect(
      testHeadline({
        valid: false,
        errors: [],
        tests: [test(true), test(false), test(false)],
      }),
    ).toBe("1 of 3 tests passed");
  });

  it("separates deferred runs and configurations that did not load", () => {
    expect(testHeadline({ valid: false, errors: [], deferred: true })).toBe(
      "These tests need the device environment",
    );
    expect(
      testHeadline({ valid: false, errors: ["x"], tests_run: false }),
    ).toBe("Vector couldn't run these tests");
    expect(testHeadline({ valid: false, errors: ["x"] })).toBe(
      "Pipeline tests failed",
    );
  });

  it("leads with the verdict when deferred tests still ran", () => {
    const run = {
      valid: true,
      errors: [],
      deferred: true,
      tests_run: true,
      output: "2 of 2 tests passed.",
      tests: [test(true), test(true)],
      warnings: [
        "Each device checks /var/log/nginx/access.log before applying this version.",
      ],
    };
    expect(testHeadline(run)).toBe("All 2 tests passed");
    expect(deferralNote(run)).toBe(
      "Vector ran them with stand-ins for device values. Each device checks /var/log/nginx/access.log before applying this version.",
    );
    expect(
      deferralNote({ valid: true, errors: [], tests: [test(true)] }),
    ).toBeNull();
  });

  it("says so when Vector stopped before it ran a test", () => {
    const skipped = { name: "b", passed: false, not_run: true };
    expect(
      testHeadline({
        valid: false,
        errors: [],
        tests_run: true,
        tests: [{ name: "a", passed: false }, skipped],
      }),
    ).toBe("Vector couldn't run these tests");
    expect(
      testHeadline({
        valid: false,
        errors: [],
        tests_run: true,
        tests: [skipped, { ...skipped, name: "c" }],
      }),
    ).toBe("Vector couldn't run these tests");
    expect(
      testHeadline({
        valid: false,
        errors: [],
        tests_run: true,
        tests: [test(true), skipped],
      }),
    ).toBe("1 of 2 tests passed; 1 didn't run");
  });

  it("does not say tests passed when Vector reported none for a pipeline that has some", () => {
    const empty = {
      valid: true,
      errors: [],
      tests_run: true,
      tests: [],
      output: "0 of 0 tests passed.",
    };
    expect(testHeadline(empty, 2)).toBe("Vector didn't run these tests");
    // A pipeline without tests keeps the plain wording.
    expect(testHeadline(empty, 0)).toBe("Pipeline tests passed");
  });
});

const refusedTest: PipelineTest = {
  name: "enrich once",
  passed: false,
  refused: true,
  message:
    "Could not build this test: inputs[0]: unable to locate target transform 'nosuch'.",
  // Vector's own text starts with the same reason.
  detail:
    "Vector could not build this test.\ninputs[0]: unable to locate target transform 'nosuch'.",
};
const notRunTest: PipelineTest = {
  name: "second",
  passed: false,
  not_run: true,
  message: "Vector did not run this test.",
};

describe("tests Vector could not build", () => {
  it("says which step a test named and that it stopped the rest", () => {
    expect(refusalSentence([refusedTest, notRunTest])).toBe(
      "Vector couldn't build 1 of 2 tests (inputs[0]: no step named 'nosuch'); the other didn't run.",
    );
    expect(
      testHeadline(
        {
          valid: false,
          errors: [],
          tests_run: true,
          tests: [refusedTest, notRunTest],
        },
        2,
      ),
    ).toBe(
      "Vector couldn't build 1 of 2 tests (inputs[0]: no step named 'nosuch'); the other didn't run.",
    );
    expect(refusalSentence([refusedTest, notRunTest, notRunTest])).toContain(
      "; the other 2 didn't run.",
    );
    expect(refusalSentence([refusedTest])).toBe(
      "Vector couldn't build the test (inputs[0]: no step named 'nosuch').",
    );
    // Two refused tests have no single reason to quote.
    expect(refusalSentence([refusedTest, { ...refusedTest, name: "b" }])).toBe(
      "Vector couldn't build 2 of 2 tests.",
    );
    expect(refusalSentence([{ name: "a", passed: false }])).toBeNull();
  });

  it("gives Vector's reason in the canvas's words and keeps it short", () => {
    expect(
      refusalReason("Could not build this test: unhandled error in by_status."),
    ).toBe("unhandled error");
    expect(
      refusalReason(
        "Vector can't read this test: inputs[0].log_fieldz: unknown field `log_fieldz`, expected one of `insert_at`, `type`, `value`, `source`, `log_fields`, `metric`",
      ),
    ).toBe("inputs[0].log_fieldz: unknown field `log_fieldz`");
    expect(refusalReason("Vector could not build this test.")).toBe("");
    expect(refusalReason("assertion failed")).toBe("");
    expect(refusalReason(undefined)).toBe("");
    const long = refusalReason(
      `Could not build this test: ${"x".repeat(300)}.`,
    );
    expect(long.length).toBeLessThanOrEqual(110);
    expect(long.endsWith("…")).toBe(true);
  });

  it("prints Vector's reason once and lists the steps a test can use", () => {
    expect(detailAdds(refusedTest)).toBe(false);
    const html = renderToStaticMarkup(
      createElement(PipelineTestResults, {
        run: {
          valid: false,
          errors: [],
          tests_run: true,
          tests: [refusedTest, notRunTest],
        },
        expected: 2,
        steps: ["demo", "enrich", "output"],
      }),
    );
    // One line that says it, in the canvas's words: not Vector's phrase as
    // well, and not a second copy in a preformatted block.
    expect(html).not.toContain("unable to locate target transform");
    expect(html).not.toContain("<pre>");
    expect(html).toContain(
      "No step named &#x27;nosuch&#x27;. Steps you can test: demo, enrich, output.",
    );
    expect(html).toContain("Not run");
  });

  it("names the missing step even when the pipeline has no transforms", () => {
    const html = renderToStaticMarkup(
      createElement(PipelineTestResults, {
        run: {
          valid: false,
          errors: [],
          tests_run: true,
          tests: [refusedTest],
        },
        expected: 1,
        steps: [],
      }),
    );
    expect(html).toContain("This pipeline has no transform steps");
  });

  it("keeps detail that says more than the message", () => {
    const compile: PipelineTest = {
      name: "route",
      passed: false,
      refused: true,
      message: "Could not build this test: unhandled error in by_status.",
      detail:
        'Vector could not build this test.\nTransform "by_status":\nerror[E100]: unhandled error\n1 │ .status >= 500',
    };
    expect(detailAdds(compile)).toBe(true);
    expect(
      renderToStaticMarkup(
        createElement(PipelineTestResults, {
          run: { valid: false, errors: [], tests_run: true, tests: [compile] },
          expected: 1,
        }),
      ),
    ).toContain(".status &gt;= 500");
    // A test that ran and failed keeps what it produced.
    expect(
      detailAdds({
        name: "a",
        passed: false,
        message: "assertion failed",
        detail: "condition 0 failed: .a == 1",
      }),
    ).toBe(true);
    expect(detailAdds({ name: "a", passed: false, message: "x" })).toBe(false);
  });

  it("can leave the headline to the caller", () => {
    const run = { valid: true, errors: [], tests: [test(true)] };
    expect(
      renderToStaticMarkup(
        createElement(PipelineTestResults, { run, headline: null }),
      ),
    ).not.toContain("<strong>");
    expect(
      renderToStaticMarkup(
        createElement(PipelineTestResults, { run, headline: "Mine" }),
      ),
    ).toContain("<strong>Mine</strong>");
  });
});
