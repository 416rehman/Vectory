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
};

/** One line that says how the run went, from Vector's own result. */
export function testHeadline(run: PipelineTestRun) {
  if (run.deferred) return "These tests need the device environment";
  const tests = run.tests ?? [];
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

/** Each test with Vector's verdict; failures show why and what came out. */
export default function PipelineTestResults({ run }: { run: PipelineTestRun }) {
  const tests = run.tests ?? [];
  const failures = tests.filter((test) => !test.passed).length;
  // The headline already counts failures; keep only other messages.
  const errors = (run.errors ?? []).filter(
    (message) =>
      !tests.length || !/^\d+ of \d+ pipeline tests? failed\.?$/.test(message),
  );
  return (
    <div
      className="pipeline-test-results"
      role="status"
      data-state={run.deferred ? "deferred" : run.valid ? "passed" : "failed"}
    >
      <strong>{testHeadline(run)}</strong>
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
      {!tests.length && run.output && (
        <pre className="code-preview">{run.output}</pre>
      )}
    </div>
  );
}
