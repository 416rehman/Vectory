/**
 * What the publish review says about the draft's pipeline tests. The server
 * runs the same tests when a version is published and refuses to publish over
 * a failing one unless the request acknowledges it, so the review reads a run
 * by the server's own rule: a test that failed, that Vector could not build,
 * or that did not run is failing; tests Vector skipped with a stated reason
 * (a device runs them) are not.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { APIError, post, type Config } from "./api";
import {
  refusalSentence,
  type PipelineTest,
  type PipelineTestRun,
} from "./PipelineTestResults";

export type TestCounts = {
  total: number;
  passed: number;
  /** Vector ran the test and it failed. */
  failed: number;
  /** Vector could not read or build the test. */
  refused: number;
  /** Vector did not run the test. */
  notRun: number;
};

export type TestsView =
  | { state: "none" }
  | { state: "running"; total: number }
  /** No answer: the runner is down, busy, or the network is. */
  | { state: "unavailable"; total: number; message: string }
  /** Vector skipped them and said why; nothing failed. */
  | { state: "skipped"; total: number; run: PipelineTestRun }
  | { state: "passed"; total: number; counts: TestCounts; run: PipelineTestRun }
  | {
      state: "failing";
      total: number;
      counts: TestCounts;
      run: PipelineTestRun;
      /** 1-based position of the first test that is not passing. */
      first: number;
    };

/** Every test lands in exactly one count, as the server counts them. */
export function countTests(
  tests: PipelineTest[],
  expected: number,
): TestCounts {
  if (!tests.length)
    return {
      total: expected,
      passed: 0,
      failed: 0,
      refused: 0,
      notRun: expected,
    };
  const counts: TestCounts = {
    total: tests.length,
    passed: 0,
    failed: 0,
    refused: 0,
    notRun: 0,
  };
  for (const test of tests) {
    if (test.passed) counts.passed++;
    else if (test.not_run) counts.notRun++;
    else if (test.refused) counts.refused++;
    else counts.failed++;
  }
  return counts;
}

/** The review's reading of one run of `POST /configurations/test`. */
export function readTestRun(run: PipelineTestRun, expected: number): TestsView {
  const tests = run.tests ?? [];
  // No verdicts: a valid reply that says Vector skipped the tests is a skip it
  // explained. Anything else is tests that did not run.
  if (!tests.length && run.valid === true && run.tests_run !== true)
    return { state: "skipped", total: expected, run };
  const counts = countTests(tests, expected);
  if (!counts.failed && !counts.refused && !counts.notRun)
    return { state: "passed", total: counts.total, counts, run };
  const index = tests.findIndex((test) => !test.passed);
  return {
    state: "failing",
    total: counts.total,
    counts,
    run,
    first: index < 0 ? 1 : index + 1,
  };
}

/** Publishing needs an explicit "Publish anyway": the server refuses without it. */
export const stopsPublishing = (view: TestsView) =>
  view.state === "failing" || view.state === "unavailable";

const noun = (count: number) => (count === 1 ? "test" : "tests");
/** "2 of 2 passed", "1 of 3 tests failed", "Vector couldn't build 1 of 2 tests (…); the other didn't run." */
export function testsHeadline(view: TestsView): string {
  switch (view.state) {
    case "none":
      return "";
    case "running":
      return `Running ${view.total} ${noun(view.total)}…`;
    case "unavailable":
      return `Couldn't run ${view.total === 1 ? "the test" : `the ${view.total} tests`}. ${view.message}`;
    case "skipped":
      return "Vector didn't run them here; a device runs them";
    case "passed":
      return `${view.counts.passed} of ${view.counts.total} passed`;
    case "failing": {
      const { counts, run } = view;
      const refusal = refusalSentence(run.tests ?? []);
      if (refusal) return refusal;
      if (counts.failed)
        return `${counts.failed} of ${counts.total} ${noun(counts.total)} failed${
          counts.notRun ? `; ${counts.notRun} didn't run` : ""
        }`;
      return counts.notRun === counts.total
        ? counts.total === 1
          ? "Vector didn't run the test"
          : `Vector didn't run ${counts.total === 2 ? "either" : "any"} of the ${counts.total} tests`
        : `Vector didn't run ${counts.notRun} of ${counts.total} tests`;
    }
  }
}

/** The runner's own refusal in words a person can act on. */
function failureMessage(failure: unknown) {
  if (!(failure instanceof APIError))
    return "Vector's test runner didn't answer.";
  if (failure.code === "CAPABILITY_DENIED")
    return "Vector's test runner isn't available on this server.";
  if (failure.code === "RATE_LIMITED")
    return "Tests were run too often. Try again in a minute.";
  return failure.message;
}

/**
 * Runs the draft's tests when the review opens (about 130 ms), and again on
 * request. A reply for an earlier run, or one that arrives after the review
 * closed, is dropped.
 */
export function usePublishTests(config: Config, open: boolean) {
  const total = Array.isArray(config.tests) ? config.tests.length : 0;
  const [view, setView] = useState<TestsView>({ state: "none" });
  const serial = useRef(0);
  const latest = useRef({ config, total });
  latest.current = { config, total };
  // The run depends on the whole draft, not only its tests.
  const draft = useMemo(
    () => (open && total ? JSON.stringify(config) : ""),
    [open, total, config],
  );
  const run = useCallback(async () => {
    const { config, total } = latest.current;
    const current = ++serial.current;
    if (!total) {
      setView({ state: "none" });
      return;
    }
    setView({ state: "running", total });
    try {
      const result = await post<PipelineTestRun>("/configurations/test", {
        config,
      });
      if (current === serial.current) setView(readTestRun(result, total));
    } catch (failure) {
      if (current === serial.current)
        setView({
          state: "unavailable",
          total,
          message: failureMessage(failure),
        });
    }
  }, []);
  useEffect(() => {
    if (!draft) {
      serial.current++;
      setView({ state: "none" });
      return;
    }
    void run();
    return () => {
      serial.current++;
    };
  }, [draft, run]);
  return { view, run };
}
