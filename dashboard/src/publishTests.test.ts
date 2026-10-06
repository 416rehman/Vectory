import { describe, expect, it } from "vitest";
import {
  countTests,
  readTestRun,
  stopsPublishing,
  testsHeadline,
  type TestsView,
} from "./publishTests";
import type { PipelineTest, PipelineTestRun } from "./PipelineTestResults";

const ok = (name: string): PipelineTest => ({ name, passed: true });
const failed = (name: string): PipelineTest => ({
  name,
  passed: false,
  message: "assertion failed",
});
const refused = (name: string, reason: string): PipelineTest => ({
  name,
  passed: false,
  refused: true,
  message: `Could not build this test: ${reason}.`,
});
const skipped = (name: string): PipelineTest => ({
  name,
  passed: false,
  not_run: true,
  message: "Vector did not run this test.",
});
const run = (tests: PipelineTest[], valid: boolean): PipelineTestRun => ({
  valid,
  tests_run: true,
  tests,
  errors: [],
});
const view = (tests: PipelineTest[], valid = false) =>
  readTestRun(run(tests, valid), tests.length);

describe("the publish review reads tests the way the server does", () => {
  it("counts every test once", () => {
    expect(
      countTests(
        [ok("a"), failed("b"), refused("c", "x"), skipped("d"), skipped("e")],
        5,
      ),
    ).toEqual({ total: 5, passed: 1, failed: 1, refused: 1, notRun: 2 });
    // No verdicts at all: every configured test did not run.
    expect(countTests([], 3)).toEqual({
      total: 3,
      passed: 0,
      failed: 0,
      refused: 0,
      notRun: 3,
    });
  });

  it("passes when every test passed and stops on anything else", () => {
    const passing = view([ok("a"), ok("b")], true);
    expect(passing.state).toBe("passed");
    expect(stopsPublishing(passing)).toBe(false);
    for (const tests of [
      [ok("a"), failed("b")],
      [refused("a", "x"), skipped("b")],
      [ok("a"), skipped("b")],
      [skipped("a")],
    ]) {
      const result = view(tests);
      expect(result.state, JSON.stringify(tests)).toBe("failing");
      expect(stopsPublishing(result)).toBe(true);
    }
  });

  it("points at the first test that is not passing", () => {
    const result = view([ok("a"), ok("b"), failed("c"), failed("d")]);
    expect(result.state === "failing" && result.first).toBe(3);
  });

  it("does not stop on tests Vector skipped and explained", () => {
    // A program that calls out: valid, nothing ran, a device runs them.
    const result = readTestRun(
      { valid: true, tests_run: false, tests: [], errors: [] },
      2,
    );
    expect(result.state).toBe("skipped");
    expect(stopsPublishing(result)).toBe(false);
    // The same reply with an error, or from a server that ran nothing yet said
    // it did, is tests that did not run.
    for (const reply of [
      { valid: false, tests_run: false, tests: [], errors: ["x"] },
      { valid: true, tests_run: true, tests: [], errors: [] },
    ]) {
      const stopped = readTestRun(reply, 2);
      expect(stopped.state).toBe("failing");
      expect(stopped.state === "failing" && stopped.counts.notRun).toBe(2);
    }
  });

  it("stops on the server's answer for a Lua step: the tests did not run here", () => {
    const lua: PipelineTestRun = {
      valid: false,
      tests_run: false,
      tests: [],
      deferred: true,
      errors: [
        "Lua can run any program, so tests that include it run only on devices. Use Check on devices with Also run the pipeline's tests.",
      ],
      warnings: ["Each device checks Lua code before applying this version."],
    };
    const result = readTestRun(lua, 2);
    expect(result.state).toBe("failing");
    expect(stopsPublishing(result)).toBe(true);
    expect(result.state === "failing" && result.counts).toEqual({
      total: 2,
      passed: 0,
      failed: 0,
      refused: 0,
      notRun: 2,
    });
    expect(testsHeadline(result)).toBe(
      "Vector didn't run either of the 2 tests",
    );
  });

  it("stops when no answer came, because the server will not publish either", () => {
    const none: TestsView = {
      state: "unavailable",
      total: 2,
      message: "Vector's test runner isn't available on this server.",
    };
    expect(stopsPublishing(none)).toBe(true);
    expect(stopsPublishing({ state: "running", total: 2 })).toBe(false);
    expect(stopsPublishing({ state: "none" })).toBe(false);
  });
});

describe("the review's one line about the tests", () => {
  it("says how many passed", () => {
    expect(testsHeadline(view([ok("a"), ok("b")], true))).toBe("2 of 2 passed");
    expect(testsHeadline(view([ok("a")], true))).toBe("1 of 1 passed");
  });

  it("names what Vector could not build, and what it therefore did not run", () => {
    expect(
      testsHeadline(
        view([
          refused(
            "inputs",
            "inputs[0]: unable to locate target transform 'nosuch'",
          ),
          skipped("other"),
        ]),
      ),
    ).toBe(
      "Vector couldn't build 1 of 2 tests (inputs[0]: no step named 'nosuch'); the other didn't run.",
    );
    expect(
      testsHeadline(
        view([
          refused("only", "unit test must contain at least one of `outputs`"),
        ]),
      ),
    ).toBe(
      "Vector couldn't build the test (unit test must contain at least one of `outputs`).",
    );
  });

  it("counts failures and tests that did not run without the word checked", () => {
    expect(testsHeadline(view([ok("a"), failed("b"), failed("c")]))).toBe(
      "2 of 3 tests failed",
    );
    expect(testsHeadline(view([failed("a")]))).toBe("1 of 1 test failed");
    expect(testsHeadline(view([skipped("a"), skipped("b")]))).toBe(
      "Vector didn't run either of the 2 tests",
    );
    expect(testsHeadline(view([ok("a"), skipped("b")]))).toBe(
      "Vector didn't run 1 of 2 tests",
    );
    for (const tests of [
      [ok("a"), failed("b")],
      [refused("a", "x"), skipped("b")],
      [skipped("a")],
    ])
      expect(testsHeadline(view(tests))).not.toMatch(/checked/i);
  });

  it("says why nothing ran", () => {
    expect(
      testsHeadline({
        state: "unavailable",
        total: 2,
        message: "Tests were run too often. Try again in a minute.",
      }),
    ).toBe(
      "Couldn't run the 2 tests. Tests were run too often. Try again in a minute.",
    );
    expect(testsHeadline({ state: "running", total: 1 })).toBe(
      "Running 1 test…",
    );
    expect(
      testsHeadline(
        readTestRun(
          { valid: true, tests_run: false, tests: [], errors: [] },
          1,
        ),
      ),
    ).toBe("Vector didn't run them here; a device runs them");
  });
});
