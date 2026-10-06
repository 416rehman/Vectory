import { useEffect, useState, type RefObject } from "react";
import { Button, ErrorBox, Field, Modal } from "./ui";

export default function PipelineDetails({
  name,
  description,
  onSave,
  onClose,
  onPendingChange,
  preserveAfterFailedSave = false,
  editable,
  returnFocusRef,
}: {
  name: string;
  description: string;
  onSave: (name: string, description: string) => Promise<boolean>;
  onClose: () => void;
  onPendingChange: (id: string, pending: boolean) => void;
  preserveAfterFailedSave?: boolean;
  editable: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [title, setTitle] = useState(name),
    [summary, setSummary] = useState(description);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const changed = title !== name || summary !== description;
  useEffect(() => {
    onPendingChange("pipeline-details", changed);
    return () => onPendingChange("pipeline-details", false);
  }, [changed, onPendingChange]);
  function close() {
    if (busy) return;
    if (
      changed &&
      !confirm(
        preserveAfterFailedSave
          ? "Discard the new details you just typed? The previous unconfirmed save remains in your local draft."
          : "Discard changes to pipeline details?",
      )
    )
      return;
    onClose();
  }
  return (
    <Modal
      open
      returnFocusRef={returnFocusRef}
      onClose={close}
      title="Pipeline details"
      description={
        editable
          ? "Give this pipeline a name your team will recognize."
          : "This pipeline's details are read-only."
      }
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!editable || busy) return;
          setBusy(true);
          setError("");
          try {
            if (await onSave(title.trim(), summary)) onClose();
            else
              setError(
                "Details could not be saved. Your changes are still here.",
              );
          } catch (failure) {
            setError((failure as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body stack">
          {error && <ErrorBox message={error} />}
          {preserveAfterFailedSave && (
            <p role="status">
              The previous save was not confirmed. Those attempted details stay
              in your local draft until you resolve or discard it. New edits in
              this dialog need another save.
            </p>
          )}
          <Field label="Pipeline name">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={120}
              autoFocus
              disabled={busy}
              readOnly={!editable}
            />
          </Field>
          <Field label="Description">
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              maxLength={2000}
              rows={3}
              disabled={busy}
              readOnly={!editable}
            />
          </Field>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={close} disabled={busy}>
            {editable && !preserveAfterFailedSave ? "Cancel" : "Close"}
          </Button>
          {editable && (
            <Button
              type="submit"
              busy={busy}
              disabled={!title.trim() || !changed}
            >
              Save details
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
