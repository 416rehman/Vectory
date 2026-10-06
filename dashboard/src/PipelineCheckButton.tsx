import * as Popover from "@radix-ui/react-popover";
import { useEffect } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
} from "lucide-react";
import type { CheckStatus, Problem } from "./pipelineProblems";
import { useHoverDisclosure } from "./useHoverDisclosure";

const icons: Record<CheckStatus, typeof CircleCheck> = {
  unchecked: CircleDashed,
  stale: CircleDashed,
  checking: LoaderCircle,
  passed: CircleCheck,
  device: CircleCheck,
  partial: CircleAlert,
  problems: CircleX,
  unavailable: CircleAlert,
};

/**
 * The status opens the cached findings; only a first check runs from here.
 * Hover and keyboard focus reveal a short summary without changing the result.
 */
export default function PipelineCheckButton({
  status,
  label,
  description,
  problems,
  hasCheckAttempt,
  feedbackId,
  disabled,
  hidden,
  onInspect,
  onCheck,
}: {
  status: CheckStatus;
  label: string;
  description: string;
  problems: readonly Problem[];
  hasCheckAttempt: boolean;
  feedbackId: string;
  disabled: boolean;
  hidden: boolean;
  onInspect: () => void;
  onCheck: () => void;
}) {
  const disclosure = useHoverDisclosure();
  const Icon = icons[status];
  const highlightedProblems = [...problems]
    .sort((a, b) => {
      const priority = (problem: Problem) =>
        (problem.severity === "error" ? 0 : 2) +
        (problem.origin === "vector" ? 0 : 1);
      return priority(a) - priority(b);
    })
    .slice(0, 3);
  const remainingProblems = problems.length - highlightedProblems.length;
  useEffect(() => {
    if (disabled || hidden) disclosure.close();
  }, [disabled, hidden, disclosure.close]);
  if (hidden) return null;
  return (
    <>
      <Popover.Root
        open={disclosure.open}
        onOpenChange={disclosure.onOpenChange}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="editor-check-button"
            data-check-state={status}
            ref={disclosure.triggerRef}
            aria-label={`${hasCheckAttempt ? "Open Problems" : "Check pipeline"}: ${label}`}
            aria-describedby={feedbackId}
            aria-busy={status === "checking" || undefined}
            disabled={disabled}
            {...disclosure.triggerProps}
            onClick={(event) => {
              event.preventDefault();
              disclosure.close();
              if (hasCheckAttempt) onInspect();
              else onCheck();
            }}
          >
            <Icon size={15} aria-hidden="true" />
            <span>{label}</span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            ref={disclosure.contentRef}
            className="editor-check-popover"
            aria-label="Pipeline check summary"
            side="bottom"
            align="end"
            sideOffset={6}
            collisionPadding={12}
            tabIndex={-1}
            {...disclosure.contentProps}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onEscapeKeyDown={disclosure.onEscapeKeyDown}
          >
            <strong>{label}</strong>
            <p>{description}</p>
            {problems.length > 0 && (
              <ul>
                {highlightedProblems.map((problem) => (
                  <li
                    key={problem.key}
                    data-severity={problem.severity}
                    data-stale={problem.stale || undefined}
                  >
                    {problem.component && <code>{problem.component}</code>}
                    <span>
                      {problem.message}
                      {problem.stale && (
                        <small className="editor-check-stale">
                          From an earlier check
                        </small>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {remainingProblems > 0 && (
              <small>
                {`${remainingProblems} more ${remainingProblems === 1 ? "finding" : "findings"} in Problems.`}
              </small>
            )}
            <small>
              {hasCheckAttempt
                ? "Open Problems for details and Check again."
                : "Select to check this pipeline with Vector."}
            </small>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <span id={feedbackId} className="sr-only" aria-live="polite">
        {description}
      </span>
    </>
  );
}
