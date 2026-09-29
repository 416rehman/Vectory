import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleX,
  Wand2,
} from "lucide-react";
import type { Config } from "./api";
import type { Kind } from "./catalog";
import ComponentIcon from "./ComponentIcon";
import { componentTitle } from "./pipelineNodeModel";
import {
  countProblems,
  groupProblems,
  type Problem,
  type ProblemSection,
} from "./pipelineProblems";
import ProblemText from "./ProblemText";
import "./problems-panel.css";

const sectionLabels: Record<ProblemSection, string> = {
  sources: "Source",
  transforms: "Transform",
  sinks: "Destination",
  enrichment_tables: "Enrichment table",
  tests: "Pipeline tests",
  global: "Pipeline settings",
};

function location(problem: Problem) {
  const parts: string[] = [];
  if (problem.routeOutput)
    parts.push(
      problem.routeOutput === "_unmatched"
        ? "Unmatched output"
        : `Output ${problem.routeOutput}`,
    );
  else if (
    problem.field &&
    problem.field !== "source" &&
    problem.field !== "condition"
  )
    parts.push(problem.field);
  if (problem.line)
    parts.push(
      `Line ${problem.line}${problem.column ? `:${problem.column}` : ""}`,
    );
  return parts.join(" · ");
}

/**
 * Every finding for the draft, grouped by component. Local checks update
 * instantly; Vector findings come from the latest check of this draft.
 */
export default function ProblemsPanel({
  problems,
  config,
  open,
  onOpenChange,
  verdict,
  autoCheck,
  onAutoCheckChange,
  onSelect,
  onFix,
  checking,
  canFix,
}: {
  problems: Problem[];
  config: Config;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  verdict: string;
  /** Omit for people who cannot run checks. */
  autoCheck?: boolean;
  onAutoCheckChange?: (value: boolean) => void;
  onSelect: (problem: Problem) => void;
  onFix: (problem: Problem) => void;
  checking: boolean;
  canFix: (problem: Problem) => boolean;
}) {
  const { errors, warnings } = countProblems(problems);
  const groups = groupProblems(problems, config);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const summary =
    errors || warnings
      ? [
          errors ? `${errors} ${errors === 1 ? "problem" : "problems"}` : "",
          warnings
            ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "No problems";
  return (
    <section
      className="problems-panel"
      data-open={open || undefined}
      data-state={errors ? "error" : warnings ? "warning" : "clean"}
      aria-label="Problems"
    >
      <div className="problems-bar">
        <button
          type="button"
          className="problems-toggle"
          aria-expanded={open}
          aria-controls="pipeline-problems-list"
          onClick={() => onOpenChange(!open)}
        >
          {errors ? (
            <CircleX
              size={15}
              aria-hidden="true"
              className="problems-icon-error"
            />
          ) : warnings ? (
            <AlertTriangle
              size={15}
              aria-hidden="true"
              className="problems-icon-warning"
            />
          ) : (
            <CheckCircle2
              size={15}
              aria-hidden="true"
              className="problems-icon-clean"
            />
          )}
          <strong>{summary}</strong>
          <ChevronDown
            size={15}
            aria-hidden="true"
            className="problems-chevron"
          />
        </button>
        <span className="problems-verdict" aria-live="polite">
          {checking ? "Checking with Vector…" : verdict}
        </span>
        {autoCheck !== undefined && onAutoCheckChange && (
          <label
            className="problems-auto"
            title="Check with Vector after you pause editing"
          >
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(event) => onAutoCheckChange(event.target.checked)}
            />
            Auto-check
          </label>
        )}
      </div>
      {open && (
        <div className="problems-list" id="pipeline-problems-list">
          {groups.length === 0 ? (
            <p className="problems-empty">Nothing to fix. {verdict}</p>
          ) : (
            groups.map((group) => {
              const component = group.component
                ? config[group.section as Kind]?.[group.component] ||
                  config.enrichment_tables?.[group.component]
                : null;
              const kind = (group.section as Kind) || "transforms";
              const isCollapsed = collapsed.has(group.key);
              return (
                <section key={group.key} className="problems-group">
                  <button
                    type="button"
                    className="problems-group-header"
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                  >
                    {component ? (
                      <span
                        className="problems-group-icon"
                        data-pipeline-category={kind}
                      >
                        <ComponentIcon
                          type={component.type}
                          kind={kind}
                          size={15}
                        />
                      </span>
                    ) : null}
                    <span className="problems-group-title">
                      {component
                        ? componentTitle(component.type, kind)
                        : sectionLabels[group.section || "global"]}
                    </span>
                    {group.component && <code>{group.component}</code>}
                    <span className="problems-group-counts">
                      {group.errors > 0 && (
                        <span data-tone="error">{group.errors}</span>
                      )}
                      {group.warnings > 0 && (
                        <span data-tone="warning">{group.warnings}</span>
                      )}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <ul>
                      {group.problems.map((problem) => (
                        <li
                          key={problem.key}
                          data-severity={problem.severity}
                          data-stale={problem.stale || undefined}
                        >
                          <button
                            type="button"
                            className="problems-item"
                            onClick={() => onSelect(problem)}
                          >
                            {problem.severity === "error" ? (
                              <CircleX size={14} aria-hidden="true" />
                            ) : (
                              <AlertTriangle size={14} aria-hidden="true" />
                            )}
                            <span className="problems-message">
                              <span>
                                <ProblemText text={problem.message} />
                              </span>
                              {problem.hint && (
                                <small>
                                  <ProblemText
                                    text={problem.hint.split("\n")[0]}
                                  />
                                </small>
                              )}
                            </span>
                            <span className="problems-location">
                              {location(problem)}
                              {problem.code && /^E\d+$/.test(problem.code) && (
                                <code>{problem.code}</code>
                              )}
                            </span>
                          </button>
                          {problem.fix && canFix(problem) && (
                            <button
                              type="button"
                              className="problems-fix"
                              onClick={() => onFix(problem)}
                            >
                              <Wand2 size={13} aria-hidden="true" />
                              <ProblemText text={problem.fix.label} />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
