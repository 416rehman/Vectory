import { useContext, useId, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  CircleX,
  ExternalLink,
  Maximize2,
  Wand2,
} from "lucide-react";
import VrlEditor from "./VrlEditor";
import { VrlFieldContext } from "./vrlFieldContext";
import { applyFix, type Problem } from "./pipelineProblems";
import ProblemText from "./ProblemText";

type FieldProblem = Pick<
  Problem,
  | "severity"
  | "message"
  | "hint"
  | "code"
  | "line"
  | "column"
  | "length"
  | "fix"
  | "detail"
  | "docsUrl"
  | "stale"
>;

function ProblemRow({
  problem,
  text,
  readOnly,
  onInput,
}: {
  problem: FieldProblem;
  text: string;
  readOnly: boolean;
  onInput: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const fixed = problem.fix && !readOnly ? applyFix(text, problem) : null;
  const Icon = problem.severity === "error" ? CircleX : AlertTriangle;
  const hint = problem.hint?.split("\n")[0];
  return (
    <li
      data-severity={problem.severity}
      data-stale={problem.stale || undefined}
    >
      <Icon size={14} aria-hidden="true" className="vrl-problem-icon" />
      <div className="vrl-problem-body">
        <p>
          {problem.line ? (
            <span className="vrl-problem-position">
              Line {problem.line}
              {problem.column ? `:${problem.column}` : ""}
            </span>
          ) : null}
          <strong>
            <ProblemText text={problem.message} />
          </strong>
          {problem.code && (
            <code className="vrl-problem-code">{problem.code}</code>
          )}
        </p>
        {hint &&
          hint.toLowerCase() !==
            problem.message.toLowerCase().replace(/\.$/, "") && (
            <p className="vrl-problem-hint">
              <ProblemText text={hint} />
            </p>
          )}
        {(problem.detail || fixed !== null) && (
          <div className="vrl-problem-actions">
            {fixed !== null && problem.fix && (
              <button
                type="button"
                className="vrl-problem-fix"
                onClick={() => onInput(fixed)}
              >
                <Wand2 size={13} aria-hidden="true" />
                <ProblemText text={problem.fix.label} />
              </button>
            )}
            {problem.detail && (
              <button
                type="button"
                className="vrl-problem-detail-toggle"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                <ChevronRight size={13} aria-hidden="true" />
                Vector’s message
              </button>
            )}
            {problem.docsUrl && (
              <a href={problem.docsUrl} target="_blank" rel="noreferrer">
                {problem.code} reference
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </div>
        )}
        {open && problem.detail && (
          <pre className="vrl-problem-detail">{problem.detail}</pre>
        )}
      </div>
    </li>
  );
}

/** A VRL program or condition with Vector's findings and quick fixes. */
export default function VrlField({
  path,
  title,
  text,
  readOnly,
  describedBy,
  onInput,
}: {
  path: string;
  title: string;
  text: string;
  readOnly: boolean;
  describedBy?: string;
  onInput: (next: string) => void;
}) {
  const services = useContext(VrlFieldContext);
  const problems = (services?.problems(path) ?? []) as FieldProblem[];
  const problemsId = useId();
  const lines = text ? text.split("\n").length : 0;
  const errors = problems.filter(
    (problem) => problem.severity === "error",
  ).length;
  return (
    <div className="vrl-field" data-field-path={path}>
      <div className="vrl-field-toolbar">
        <span className="vrl-field-language">VRL</span>
        <span className="vrl-field-meta">
          {lines} {lines === 1 ? "line" : "lines"}
          {errors > 0 && (
            <span className="vrl-field-count">
              {errors} {errors === 1 ? "error" : "errors"}
            </span>
          )}
        </span>
        {services?.expand && (
          <button
            type="button"
            className="vrl-field-action"
            onClick={() => services.expand!(path)}
            aria-label={`Expand ${title}`}
            title="Open the wide editor"
          >
            <Maximize2 size={13} aria-hidden="true" />
            Expand
          </button>
        )}
      </div>
      <VrlEditor
        value={text}
        onChange={onInput}
        label={title}
        readOnly={readOnly}
        problems={problems}
        pathHints={services?.pathHints}
        describedBy={[describedBy, problems.length ? problemsId : ""]
          .filter(Boolean)
          .join(" ")}
        placeholder={
          readOnly ? undefined : "# Write VRL. Type to see functions."
        }
        onRun={services?.run ? () => services.run!(path) : undefined}
        onView={(view) => services?.registerView?.(path, view)}
      />
      {problems.length > 0 && (
        <ul
          className="vrl-field-problems"
          id={problemsId}
          aria-label={`Problems in ${title}`}
        >
          {problems.map((problem, index) => (
            <ProblemRow
              key={`${problem.code}:${problem.line}:${problem.column}:${index}`}
              problem={problem}
              text={text}
              readOnly={readOnly}
              onInput={onInput}
            />
          ))}
        </ul>
      )}
      {services?.after?.(path)}
    </div>
  );
}
