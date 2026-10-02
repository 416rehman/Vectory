import { useId } from "react";

/**
 * The devices a deployment starts from when its pipeline already runs: one
 * line saying which, with a way to change or clear the choice. The list and
 * search for choosing devices stay a click away.
 */
export default function RunningSelection({
  summary,
  note,
  disabled = false,
  onChange,
  onClear,
}: {
  /** "Update the 3 devices running v1 (Edge collectors)". */
  summary: string;
  /** What is left out, when the server's limit cut the choice short. */
  note?: string | null;
  disabled?: boolean;
  onChange: () => void;
  onClear: () => void;
}) {
  const id = useId();
  return (
    <div className="target-running">
      <p>
        <span id={id} className="target-running-text" role="status">
          {summary}
        </span>
        <span className="target-running-actions">
          <span className="target-running-dot" aria-hidden="true">
            {" "}
            ·{" "}
          </span>
          <button
            type="button"
            className="target-link-button"
            aria-describedby={id}
            disabled={disabled}
            onClick={onChange}
          >
            Change
          </button>
          <span className="target-running-dot" aria-hidden="true">
            {" "}
            ·{" "}
          </span>
          <button
            type="button"
            className="target-link-button"
            aria-describedby={id}
            disabled={disabled}
            onClick={onClear}
          >
            Clear
          </button>
        </span>
      </p>
      {note && <small>{note}</small>}
    </div>
  );
}
