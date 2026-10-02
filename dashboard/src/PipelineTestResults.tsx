import { CircleCheck, CircleDashed, CircleX } from "lucide-react";
import { ErrorBox } from "./ui";
import "./pipeline-test-results.css";

export type PipelineTest = {
  name: string;
  passed: boolean;
  /** Vector did not run this test; it never counts as passed. */
  not_run?: boolean;
  /** Vector could not read or build this test, so it never ran. */
  refused?: boolean;
  message?: string;
  detail?: string;
  outputs?: unknown[];
};
export type PipelineTestRun = {
  valid: boolean;
  tests_run?: boolean;
  tests?: PipelineTest[];
  errors: string[];
  output?: string;
  deferred?: boolean;
  warnings?: string[];
};

/** Tests that ran, whatever else Vector could not check here. */
const ran = (run: PipelineTestRun) =>
  run.tests_run === true || (run.tests_run !== false && !!run.tests?.length);

/**
 * A run that reported no test although the pipeline has some: Vector did not
 * run them (it could not build them), whatever else the response says.
 */
const unreported = (run: PipelineTestRun, expected: number) =>
  ran(run) && !(run.tests ?? []).length && expected > 0;

/**
 * What Vector said about a test it could not read or build, in the words the
 * canvas uses: "inputs[0]: no step named 'nosuch'". Empty when Vector gave no
 * reason.
 */
export function refusalReason(message: string | undefined) {
  let reason = (message ?? "").trim();
  const prefix = /^(?:Could not build this test|Vector can't read this test)/;
  if (!prefix.test(reason)) return "";
  reason = reason.replace(prefix, "").replace(/^:\s*/, "");
  reason = reason
    .replace(
      /unable to locate target transform '([^']*)'/,
      "no step named '$1'",
    )
    .replace(/, expected one of .*$/s, "")
    .replace(/\s+in [\w.-]+\.$/, "")
    .replace(/\.$/, "")
    .trim();
  return reason.length > 110 ? `${reason.slice(0, 109).trimEnd()}…` : reason;
}

/** "No step named 'nosuch'": the name a refused test points at, if that is why. */
const missingStep = (message: string | undefined) =>
  /unable to locate target transform '([^']*)'/.exec(message ?? "")?.[1] ??
  null;

/**
 * The sentence for tests Vector could not build. Vector reads every test
 * before it runs any, so one it cannot build stops the rest.
 */
export function refusalSentence(tests: PipelineTest[]) {
  const refused = tests.filter((test) => test.refused);
  if (!refused.length) return null;
  const skipped = tests.filter((test) => test.not_run).length;
  const reason = refused.length === 1 ? refusalReason(refused[0].message) : "";
  const what =
    tests.length === 1
      ? "the test"
      : `${refused.length} of ${tests.length} tests`;
  const others =
    skipped === 0
      ? ""
      : skipped === 1
        ? "; the other didn't run"
        : `; the other ${skipped} didn't run`;
  return `Vector couldn't build ${what}${reason ? ` (${reason})` : ""}${others}.`;
}

/** One line that says how the run went, from Vector's own result. */
export function testHeadline(run: PipelineTestRun, expected = 0) {
  const tests = run.tests ?? [];
  if (unreported(run, expected)) return "Vector didn't run these tests";
  if (!ran(run) && run.deferred)
    return "These tests need the device environment";
  if (run.tests_run === false) return "Vector couldn't run these tests";
  if (!tests.length)
    return run.valid ? "Pipeline tests passed" : "Pipeline tests failed";
  const passed = tests.filter((test) => test.passed).length;
  const skipped = tests.filter((test) => test.not_run).length;
  const refusal = refusalSentence(tests);
  if (refusal) return refusal;
  // Vector builds every test before it runs the first: one it can't read or
  // build stops them all.
  if (skipped && !passed) return "Vector couldn't run these tests";
  if (skipped)
    return `${passed} of ${tests.length} tests passed; ${skipped} didn't run`;
  if (passed === tests.length)
    return tests.length === 1
      ? "1 test passed"
      : `All ${tests.length} tests passed`;
  return `${passed} of ${tests.length} tests passed`;
}

/**
 * What still waits for the device after the tests ran here: Vector used
 * stand-ins for device paths, variables or secrets.
 */
export function deferralNote(run: PipelineTestRun) {
  if (!run.deferred || !ran(run)) return null;
  const device = (run.warnings ?? []).find((warning) =>
    warning.startsWith("Each device checks"),
  );
  return `Vector ran them with stand-ins for device values. ${
    device ?? "Each device checks its own values before applying."
  }`;
}

/**
 * Whether a test's detail says something its message does not. Vector's own
 * text for a test it could not build starts with the message's reason, so
 * showing both prints the same sentence twice.
 */
export function detailAdds(test: PipelineTest) {
  const detail = (test.detail ?? "").trim();
  if (!detail) return false;
  const message = (test.message ?? "").toLowerCase();
  return detail
    .split("\n")
    .map((line) => line.trim().replace(/\.$/, ""))
    .filter((line) => line && !/^vector could not build this test$/i.test(line))
    .some((line) => !message.includes(line.toLowerCase()));
}

/** The transform steps a test can name, when the pipeline says which. */
function stepHint(test: PipelineTest, steps: string[] | undefined) {
  const missing = test.refused ? missingStep(test.message) : null;
  if (missing === null || !steps || steps.includes(missing)) return null;
  const shown = steps.slice(0, 8).join(", ");
  return steps.length
    ? `No step named '${missing}'. Steps you can test: ${shown}${steps.length > 8 ? ", …" : ""}.`
    : `No step named '${missing}'. This pipeline has no transform steps; a test runs an event through one.`;
}

/** Each test with Vector's verdict; failures show why and what came out. */
export default function PipelineTestResults({
  run,
  expected = 0,
  steps,
  headline,
}: {
  run: PipelineTestRun;
  /** How many tests the pipeline has. */
  expected?: number;
  /** The pipeline's transform steps, to name the ones a test can use. */
  steps?: string[];
  /** Replaces the headline, or drops it (null) for a caller that leads with its own line. */
  headline?: string | null;
}) {
  const tests = run.tests ?? [];
  const failures = tests.filter((test) => !test.passed && !test.not_run).length;
  const skipped = tests.some((test) => test.not_run);
  // The headline already counts failures; keep only other messages.
  const errors = (run.errors ?? []).filter(
    (message) =>
      !tests.length ||
      !/^\d+ of \d+ pipeline tests? (failed|did not run)\b/.test(message),
  );
  const missing = unreported(run, expected);
  const note = missing
    ? "Vector couldn't build them. Check the pipeline for problems, then run them again."
    : skipped
      ? failures
        ? "Vector reads every test before it runs any, so a test it can't read or build stops them all. Fix the failing test, then run them again."
        : "Vector didn't run some of these tests. Run them again."
      : deferralNote(run);
  const state = missing
    ? "failed"
    : ran(run)
      ? run.valid
        ? "passed"
        : "failed"
      : run.deferred
        ? "deferred"
        : run.valid
          ? "passed"
          : "failed";
  return (
    <div className="pipeline-test-results" role="status" data-state={state}>
      {headline !== null && (
        <strong>{headline ?? testHeadline(run, expected)}</strong>
      )}
      {headline !== null && note && (
        <p className="pipeline-test-note">{note}</p>
      )}
      {tests.length > 0 && (
        <ul className="pipeline-test-list" aria-label="Test results">
          {tests.map((test, index) => {
            const hint = stepHint(test, steps);
            const extra =
              !test.passed &&
              !test.not_run &&
              (detailAdds(test) || !!test.outputs?.length);
            return (
              <li
                key={`${index}:${test.name}`}
                data-passed={test.passed || undefined}
                data-not-run={test.not_run || undefined}
              >
                <div className="pipeline-test-name">
                  {test.passed ? (
                    <CircleCheck size={15} aria-label="Passed" />
                  ) : test.not_run ? (
                    <CircleDashed size={15} aria-label="Not run" />
                  ) : (
                    <CircleX size={15} aria-label="Failed" />
                  )}
                  <span>{test.name}</span>
                  {test.not_run && (
                    <span className="pipeline-test-skipped">Not run</span>
                  )}
                </div>
                {!test.passed && !test.not_run && extra && (
                  <details open={failures === 1 || undefined}>
                    <summary>{test.message || "Why it failed"}</summary>
                    {detailAdds(test) && <pre>{test.detail}</pre>}
                    {!!test.outputs?.length && (
                      <>
                        <p>What the step produced</p>
                        <pre>{JSON.stringify(test.outputs, null, 2)}</pre>
                      </>
                    )}
                  </details>
                )}
                {!test.passed &&
                  !test.not_run &&
                  !extra &&
                  !hint &&
                  test.message && (
                    <p className="pipeline-test-reason">{test.message}</p>
                  )}
                {hint && <p className="pipeline-test-hint">{hint}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {errors.length > 0 && <ErrorBox message={errors.join("\n")} />}
      {!tests.length && !missing && run.output && (
        <pre className="code-preview">{run.output}</pre>
      )}
    </div>
  );
}
