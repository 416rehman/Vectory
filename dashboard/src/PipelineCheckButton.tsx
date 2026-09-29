import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
} from "lucide-react";
import type { CheckStatus } from "./pipelineProblems";

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
 * Labeled pipeline check. The text is the state ("Checked", "3 problems",
 * "Not checked"); clicking runs a check and opens the Problems panel.
 */
export default function PipelineCheckButton({
  status,
  label,
  description,
  feedbackId,
  disabled,
  hidden,
  onCheck,
}: {
  status: CheckStatus;
  label: string;
  description: string;
  feedbackId: string;
  disabled: boolean;
  hidden: boolean;
  onCheck: () => void;
}) {
  const Icon = icons[status];
  if (hidden) return null;
  return (
    <>
      <button
        type="button"
        className="editor-check-button"
        data-check-state={status}
        aria-label={`Check pipeline: ${label}`}
        aria-describedby={feedbackId}
        aria-busy={status === "checking" || undefined}
        title={description}
        disabled={disabled}
        onClick={onCheck}
      >
        <Icon size={15} aria-hidden="true" />
        <span>{label}</span>
      </button>
      <span id={feedbackId} className="sr-only" aria-live="polite">
        {description}
      </span>
    </>
  );
}
