import { CircleCheck, CircleX } from "lucide-react";
import { ErrorBox } from "./ui";
import "./pipeline-test-results.css";

export type PipelineTest = {
  name: string;
  passed: boolean;
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

/** One line that says how the run went, from Vector's own result. */
export function testHeadline(run: PipelineTestRun, expected = 0) {
  const tests = run.tests ?? [];
  if (unreported(run, expected)) return "Vector didn't run these tests";
  if (!ran(run) && run.deferred)
    return "These tests need the device environment";
  if (run.tests_run === false)
    return "Vector couldn't load this pipeline to run its tests";
  if (!tests.length)
    return run.valid ? "Pipeline tests passed" : "Pipeline tests failed";
  const passed = tests.filter((test) => test.passed).length;
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

/** Each test with Vector's verdict; failures show why and what came out. */
export default function PipelineTestResults({
  run,
  expected = 0,
}: {
  run: PipelineTestRun;
  /** How many tests the pipeline has. */
  expected?: number;
}) {
  const tests = run.tests ?? [];
  const failures = tests.filter((test) => !test.passed).length;
  // The headline already counts failures; keep only other messages.
  const errors = (run.errors ?? []).filter(
    (message) =>
      !tests.length || !/^\d+ of \d+ pipeline tests? failed\.?$/.test(message),
  );
  const missing = unreported(run, expected);
  const note = missing
    ? "Vector couldn't build them. Check the pipeline for problems, then run them again."
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
      <strong>{testHeadline(run, expected)}</strong>
      {note && <p className="pipeline-test-note">{note}</p>}
      {tests.length > 0 && (
        <ul className="pipeline-test-list" aria-label="Test results">
          {tests.map((test, index) => (
            <li
              key={`${index}:${test.name}`}
              data-passed={test.passed || undefined}
            >
              <div className="pipeline-test-name">
                {test.passed ? (
                  <CircleCheck size={15} aria-label="Passed" />
                ) : (
                  <CircleX size={15} aria-label="Failed" />
                )}
                <span>{test.name}</span>
              </div>
              {!test.passed &&
                (test.message || test.detail || test.outputs?.length) && (
                  <details open={failures === 1 || undefined}>
                    <summary>{test.message || "Why it failed"}</summary>
                    {test.detail && <pre>{test.detail}</pre>}
                    {!!test.outputs?.length && (
                      <>
                        <p>What the step produced</p>
                        <pre>{JSON.stringify(test.outputs, null, 2)}</pre>
                      </>
                    )}
                  </details>
                )}
            </li>
          ))}
        </ul>
      )}
      {errors.length > 0 && <ErrorBox message={errors.join("\n")} />}
      {!tests.length && !missing && run.output && (
        <pre className="code-preview">{run.output}</pre>
      )}
    </div>
  );
}
