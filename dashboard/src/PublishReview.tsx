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
import type { CheckStatus, Problem } from "./pipelineProblems";
import {
  programDiff,
  reviewChanges,
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

function describe(component: ComponentChange) {
  if (component.change !== "changed") return component.type;
  const parts = component.programs.map((program) => `${program.label} changed`);
  if (component.options.length)
    parts.push(
      component.options.length > 3
        ? `${component.options.length} options changed`
        : `${component.options.join(", ")} changed`,
    );
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
                : "The server refused to publish. Nothing was published."}
          </strong>
          <p>
            <ProblemText text={rejection.message} />
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
        {onCheck && (status === "unchecked" || status === "stale") && (
          <Button variant="secondary compact" onClick={onCheck}>
            Check now
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
      <section className="publish-review-changes" aria-label="Changes">
        <h4>{published ? `Changes since v${published.number}` : "Steps"}</h4>
        {empty ? (
          <p className="publish-review-empty">
            No configuration changes since v{published?.number}.
          </p>
        ) : (
          <ul>
            {review.components.map((component) => (
              <li key={`${component.section}:${component.id}`}>
                <div className="publish-change-row">
                  <span
                    className="publish-change-kind"
                    data-change={component.change}
                  >
                    {changeWords[component.change]}
                  </span>
                  <code>{component.id}</code>
                  <span className="publish-change-detail">
                    {describe(component)}
                  </span>
                </div>
                {component.change === "changed" &&
                  component.programs.map((program) => (
                    <details key={program.path} className="publish-program">
                      <summary>{program.label}</summary>
                      <ProgramDiff
                        before={program.before}
                        after={program.after}
                      />
                    </details>
                  ))}
              </li>
            ))}
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
    </div>
  );
}
