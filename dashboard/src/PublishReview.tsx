import { useMemo } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
} from "lucide-react";
import { ago, type Config, type Version } from "./api";
import { Button } from "./ui";
import ProblemText from "./ProblemText";
import { displayLabel, type Kind } from "./catalog";
import type { CheckStatus, Problem } from "./pipelineProblems";
import { SecretBindingSteps } from "./SecretReferenceField";
import { secretReview } from "./secretFields";
import {
  groupChanges,
  programDiff,
  reviewChanges,
  sectionCount,
  shortValue,
  type ComponentChange,
} from "./publishReview";
import "./publish-review.css";

const statusIcons: Record<CheckStatus, typeof CircleCheck> = {
  unchecked: CircleDashed,
  stale: CircleDashed,
  checking: LoaderCircle,
  passed: CircleCheck,
  device: CircleCheck,
  partial: CircleAlert,
  problems: CircleX,
  unavailable: CircleAlert,
};
const changeWords: Record<ComponentChange["change"], string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

/** Refusals that mean the checker could not run, not that the draft is wrong. */
const checkerDown = (code: string) =>
  code === "CAPABILITY_DENIED" || code === "WORKER_BUSY";

function ChangeRow({ component }: { component: ComponentChange }) {
  return (
    <li>
      <div className="publish-change-row">
        <span className="publish-change-kind" data-change={component.change}>
          {changeWords[component.change]}
        </span>
        <code>{component.id}</code>
        <span className="publish-change-detail">
          {describe(component)}
          {component.change !== "changed" && component.type && (
            <code className="publish-change-type">{component.type}</code>
          )}
        </span>
      </div>
      {component.change === "changed" &&
        component.programs.map((program) => (
          <details key={program.path} className="publish-program">
            <summary>{program.label}</summary>
            <ProgramDiff before={program.before} after={program.after} />
          </details>
        ))}
    </li>
  );
}

function describe(component: ComponentChange) {
  if (component.change !== "changed")
    return displayLabel(component.type, component.section as Kind);
  const parts = component.programs.map((program) => `${program.label} changed`);
  if (component.options.length) {
    // "rate 10 → 7" where the values are short, "endpoint changed" where not.
    if (component.options.length <= 3)
      parts.push(
        component.options
          .map((key) => {
            const value = component.values[key];
            return value
              ? `${key} ${shortValue(value.before)} → ${shortValue(value.after)}`
              : `${key} changed`;
          })
          .join(", "),
      );
    else parts.push(`${component.options.length} options changed`);
  }
  if (component.rewired) parts.push("inputs changed");
  return parts.join(" · ");
}

function ProgramDiff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => programDiff(before, after), [before, after]);
  return (
    <pre className="publish-diff">
      {lines.map((line, index) =>
        line.kind === "fold" ? (
          <span key={index} className="publish-diff-fold">
            {line.count} unchanged {line.count === 1 ? "line" : "lines"}
          </span>
        ) : (
          <span key={index} data-kind={line.kind}>
            <span className="publish-diff-sign" aria-hidden="true">
              {line.kind === "added"
                ? "+"
                : line.kind === "removed"
                  ? "−"
                  : " "}
            </span>
            <span className="sr-only">
              {line.kind === "added"
                ? "Added: "
                : line.kind === "removed"
                  ? "Removed: "
                  : ""}
            </span>
            {line.text || " "}
          </span>
        ),
      )}
    </pre>
  );
}

/**
 * What publishing will create: the change against the published version,
 * the check of this draft, and where the pipeline runs today.
 */
export default function PublishReview({
  config,
  published,
  reach,
  status,
  statusLabel,
  verdict,
  problems,
  rejection,
  onCheck,
  onGoToProblem,
}: {
  config: Config;
  published: Version | null;
  /** "Assigned to 3 devices (v2) · …", or null while loading. */
  reach: string | null;
  status: CheckStatus;
  statusLabel: string;
  verdict: string;
  problems: readonly Problem[];
  /** A definitive refusal of the last publish attempt. */
  rejection: { code: string; message: string } | null;
  onCheck?: () => void;
  onGoToProblem: (problem: Problem) => void;
}) {
  const review = useMemo(
    () => reviewChanges(published?.config || null, config),
    [published, config],
  );
  const Icon = statusIcons[status];
  const errors = problems.filter((problem) => problem.severity === "error");
  const warnings = problems.filter((problem) => problem.severity === "warning");
  const rows = useMemo(
    () => groupChanges(review.components),
    [review.components],
  );
  const secrets = useMemo(
    () => secretReview(published?.config || null, config),
    [published, config],
  );
  const newSecrets = secrets.filter((secret) => secret.added).length;
  const empty =
    !review.components.length && !review.settings.length && !review.tests;
  return (
    <div className="publish-review">
      {rejection && (
        <div className="publish-rejection" role="alert">
          <strong>
            {rejection.code === "VALIDATION_FAILED"
              ? "Vector rejected this version. Nothing was published."
              : rejection.code === "STALE_REVISION"
                ? "The draft changed while you reviewed it. Nothing was published."
                : checkerDown(rejection.code)
                  ? "Not published. Vector's checker is unavailable, so Vectory couldn't verify this draft."
                  : "The server refused to publish. Nothing was published."}
          </strong>
          <p>
            {checkerDown(rejection.code) ? (
              "Try again in a minute."
            ) : (
              <ProblemText text={rejection.message} />
            )}
          </p>
        </div>
      )}
      <p className="publish-review-facts">
        {published
          ? `Compared with v${published.number}, published ${ago(published.created_at).replace(/^Just now$/, "just now")}.`
          : "This will be the first version of this pipeline."}{" "}
        {reach ?? "Checking where it runs…"}
      </p>
      <div className="publish-review-check" data-check-state={status}>
        <Icon size={16} aria-hidden="true" />
        <strong>{statusLabel}</strong>
        <span>{verdict}</span>
        {onCheck &&
          (status === "unchecked" ||
            status === "stale" ||
            status === "unavailable") && (
            <Button variant="secondary compact" onClick={onCheck}>
              {status === "unavailable" ? "Check again" : "Check now"}
            </Button>
          )}
      </div>
      {errors.length > 0 && (
        <ul className="publish-review-problems" aria-label="Problems to fix">
          {errors.slice(0, 8).map((problem) => (
            <li key={problem.key}>
              <span>
                {problem.component && <code>{problem.component}</code>}
                {problem.field && <code>{problem.field}</code>}
                <ProblemText text={problem.message} />
              </span>
              <Button
                variant="ghost compact"
                onClick={() => onGoToProblem(problem)}
              >
                Go to problem
              </Button>
            </li>
          ))}
          {errors.length > 8 && (
            <li className="publish-review-more">
              {errors.length - 8} more in the Problems panel.
            </li>
          )}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul
          className="publish-review-problems publish-review-warnings"
          aria-label="Warnings"
        >
          {warnings.slice(0, 4).map((problem) => (
            <li key={problem.key}>
              <span>
                {problem.component && <code>{problem.component}</code>}
                <ProblemText text={problem.message} />
              </span>
              <Button
                variant="ghost compact"
                onClick={() => onGoToProblem(problem)}
              >
                Go to warning
              </Button>
            </li>
          ))}
          {warnings.length > 4 && (
            <li className="publish-review-more">
              {warnings.length - 4} more in the Problems panel.
            </li>
          )}
        </ul>
      )}
      <section className="publish-review-changes" aria-label="Changes">
        <h4>{published ? `Changes since v${published.number}` : "Steps"}</h4>
        {empty ? (
          <p className="publish-review-empty">
            No configuration changes since v{published?.number}.
          </p>
        ) : (
          <ul>
            {rows.map((row) =>
              row.kind === "step" ? (
                <ChangeRow
                  key={`${row.component.section}:${row.component.id}`}
                  component={row.component}
                />
              ) : (
                <li key={`${row.change}:${row.section}`}>
                  <details className="publish-group">
                    <summary className="publish-change-row">
                      <span
                        className="publish-change-kind"
                        data-change={row.change}
                      >
                        {changeWords[row.change]}
                      </span>
                      <span className="publish-change-detail">
                        {sectionCount(row.section, row.components.length)}
                      </span>
                    </summary>
                    <ul>
                      {row.components.map((component) => (
                        <ChangeRow
                          key={`${component.section}:${component.id}`}
                          component={component}
                        />
                      ))}
                    </ul>
                  </details>
                </li>
              ),
            )}
            {review.settings.length > 0 && (
              <li>
                <div className="publish-change-row">
                  <span className="publish-change-kind" data-change="changed">
                    Changed
                  </span>
                  <span className="publish-change-detail">
                    Pipeline settings: {review.settings.join(", ")}
                  </span>
                </div>
              </li>
            )}
            {review.tests && (
              <li>
                <div className="publish-change-row">
                  <span className="publish-change-kind" data-change="changed">
                    Changed
                  </span>
                  <span className="publish-change-detail">
                    Pipeline tests: {review.tests.before} → {review.tests.after}
                  </span>
                </div>
              </li>
            )}
          </ul>
        )}
      </section>
      {secrets.length > 0 && (
        <section className="publish-review-secrets" aria-label="Device secrets">
          <h4>Device secrets</h4>
          <p>
            Each device reads these from its own files; their values never reach
            Vectory. Bind them on every device before you deploy: a device
            missing one keeps what it runs now.
            {newSecrets > 0 &&
              ` ${newSecrets === 1 ? "One is" : `${newSecrets} are`} new since v${published?.number}.`}
          </p>
          <ul>
            {secrets.map((secret) => (
              <li key={secret.name} className="publish-change-row">
                <code>{secret.name}</code>
                {secret.added && (
                  <span
                    className="publish-secret-new"
                    title={`Not read by v${published?.number}`}
                  >
                    New
                  </span>
                )}
                <span className="publish-change-detail">
                  in {secret.uses.join(", ")}
                </span>
              </li>
            ))}
          </ul>
          <details className="secret-picker-help">
            <summary>How to bind them on a device</summary>
            <SecretBindingSteps names={secrets.map((secret) => secret.name)} />
          </details>
        </section>
      )}
    </div>
  );
}
