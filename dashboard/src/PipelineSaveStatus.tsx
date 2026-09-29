import {
  Check,
  FilePenLine,
  LoaderCircle,
  Save,
  TriangleAlert,
} from "lucide-react";
import "./pipeline-save-status.css";

export type PipelineSaveStatusProps = {
  status: string;
  publishedVersionNumber?: number;
  archived?: boolean;
};

export default function PipelineSaveStatus({
  status,
  publishedVersionNumber,
  archived = false,
}: PipelineSaveStatusProps) {
  const original = status.trim() || "Save status unavailable";
  const state = /^Save status unknown\b/i.test(original)
    ? "uncertain"
    : /^Save conflict\b/i.test(original)
      ? "conflict"
      : /^Save failed\b/i.test(original)
        ? "failed"
        : /^Saving\b/i.test(original)
          ? "saving"
          : /^Unapplied\b/i.test(original)
            ? "unapplied"
            : /^Unsaved\b/i.test(original)
              ? "unsaved"
              : /^(All changes saved|Saved)$/i.test(original)
                ? "saved"
                : "unknown";
  const display = {
    saved: { label: "Saved", Icon: Check },
    saving: { label: "Saving…", Icon: LoaderCircle },
    unsaved: { label: "Unsaved", Icon: Save },
    unapplied: { label: "Unapplied edits", Icon: FilePenLine },
    failed: { label: "Save failed", Icon: TriangleAlert },
    conflict: { label: "Save conflict", Icon: TriangleAlert },
    uncertain: { label: "Save uncertain", Icon: TriangleAlert },
    unknown: { label: original, Icon: Save },
  }[state];
  const version =
    Number.isSafeInteger(publishedVersionNumber) && publishedVersionNumber! > 0
      ? `Published version ${publishedVersionNumber}`
      : undefined;
  const detail = [
    original,
    archived ? "Archived" : undefined,
    version || (!archived ? "Draft" : undefined),
  ]
    .filter(Boolean)
    .join(" · ");
  const Icon = display.Icon;

  return (
    <span
      className="pipeline-save-status"
      data-save-state={state}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      title={detail}
    >
      <Icon
        size={14}
        aria-hidden="true"
        className={
          state === "saving" ? "pipeline-save-status-spinner" : undefined
        }
      />
      <span className="pipeline-save-status-label" aria-hidden="true">
        {display.label}
      </span>
      <span className="sr-only">{detail}</span>
    </span>
  );
}
