import { useMemo, useState } from "react";
import type { Configuration } from "./api";
import {
  graphPositions,
  mergeDraftCopies,
  staleDraftDifferences,
  type DraftContent,
  type DraftMergeChoice,
  type LocalDraftCopy,
} from "./staleDraftRecovery";
import { Button, Modal } from "./ui";
import "./stale-draft-review.css";

const MAX_VISIBLE_CHANGES = 100;
const MAX_VALUE_CHARACTERS = 240;

function preview(value: unknown): string {
  if (value === undefined) return "(not present)";
  const text = JSON.stringify(value);
  return text.length > MAX_VALUE_CHARACTERS
    ? `${text.slice(0, MAX_VALUE_CHARACTERS)}…`
    : text;
}

function FullValue({ value }: { value: unknown }) {
  const full =
    value === undefined ? "(not present)" : JSON.stringify(value, null, 2);
  if (full.length <= MAX_VALUE_CHARACTERS) return null;
  return (
    <details className="stale-draft-full-value">
      <summary>Show full value</summary>
      <pre>{full}</pre>
    </details>
  );
}

export default function StaleDraftReview({
  local,
  server,
  onClose,
  onDownload,
  onApply,
}: {
  local: LocalDraftCopy;
  server: Configuration;
  onClose: () => void;
  onDownload: () => void;
  onApply: (
    merged: DraftContent,
    server: Configuration,
    local: LocalDraftCopy,
  ) => Promise<string | null>;
}) {
  const [choices, setChoices] = useState<Record<string, DraftMergeChoice>>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const serverContent = useMemo(
    () => ({
      config: server.config,
      variables: server.variables || [],
      positions: graphPositions(server.graph),
      metadata: { name: server.name, description: server.description },
    }),
    [server],
  );
  const changes = useMemo(
    () => staleDraftDifferences(local, serverContent),
    [local, serverContent],
  );
  const merge = useMemo(
    () =>
      local.base
        ? mergeDraftCopies(local.base, local, serverContent, choices)
        : null,
    [local, serverContent, choices],
  );
  const unresolved =
    merge?.conflicts.filter((conflict) => !choices[conflict.path]) || [];
  async function applyMerge() {
    if (!merge || unresolved.length || local.unappliedCode || applying) return;
    setApplying(true);
    setApplyError("");
    try {
      const failure = await onApply(merge.merged, server, local);
      if (failure) setApplyError(failure);
    } catch (failure) {
      setApplyError((failure as Error).message);
    } finally {
      setApplying(false);
    }
  }
  return (
    <Modal
      open
      wide
      className="stale-draft-dialog"
      title="Compare draft copies"
      description={`Your edits started from revision ${local.revision}; the server is now at revision ${server.revision}. Comparing does not change either copy.`}
      onClose={() => !applying && onClose()}
    >
      <div className="modal-body stale-draft-review">
        <p>
          {changes.length} pipeline, configuration or variable{" "}
          {changes.length === 1 ? "difference" : "differences"} between your
          copy and the current server draft.
        </p>
        {changes.length ? (
          <div
            role="region"
            aria-label="Draft differences"
            tabIndex={0}
            className="stale-draft-differences"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Server draft</th>
                  <th scope="col">My edits</th>
                </tr>
              </thead>
              <tbody>
                {changes.slice(0, MAX_VISIBLE_CHANGES).map((change, index) => (
                  <tr key={`${change.path}-${index}`}>
                    <th scope="row">{change.path}</th>
                    <td data-label="Server draft">
                      <code>{preview(change.server)}</code>
                    </td>
                    <td data-label="My edits">
                      <code>{preview(change.local)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>
            The pipeline details, configuration and variable declarations match.
            Node layout and unapplied Code edits are not compared here.
          </p>
        )}
        {changes.length > MAX_VISIBLE_CHANGES && (
          <p>
            Showing the first {MAX_VISIBLE_CHANGES} differences. Download your
            copy to inspect everything.
          </p>
        )}
        {merge ? (
          <section
            className="stale-draft-merge"
            aria-label="Merge draft changes"
          >
            <h3>Combine the two drafts</h3>
            <p>
              Different fields combine automatically. Choose a side for each
              conflict. Review and save the result afterward.
            </p>
            {merge.conflicts.map((conflict, index) => (
              <fieldset
                key={`${conflict.path}-${index}`}
                className="stale-draft-conflict"
              >
                <legend>{conflict.path}</legend>
                <p>
                  Original: <code>{preview(conflict.base)}</code>
                </p>
                <FullValue value={conflict.base} />
                <label>
                  <input
                    type="radio"
                    disabled={applying}
                    name={`draft-conflict-${index}`}
                    checked={choices[conflict.path] === "server"}
                    onChange={() =>
                      setChoices((current) => ({
                        ...current,
                        [conflict.path]: "server",
                      }))
                    }
                  />
                  Keep server: <code>{preview(conflict.server)}</code>
                </label>
                <FullValue value={conflict.server} />
                <label>
                  <input
                    type="radio"
                    disabled={applying}
                    name={`draft-conflict-${index}`}
                    checked={choices[conflict.path] === "local"}
                    onChange={() =>
                      setChoices((current) => ({
                        ...current,
                        [conflict.path]: "local",
                      }))
                    }
                  />
                  Keep mine: <code>{preview(conflict.local)}</code>
                </label>
                <FullValue value={conflict.local} />
              </fieldset>
            ))}
            {unresolved.length > 0 && (
              <p role="status">
                Choose a copy for {unresolved.length} conflicting{" "}
                {unresolved.length === 1 ? "field" : "fields"}.
              </p>
            )}
          </section>
        ) : (
          <p>
            This browser copy has no stored starting revision to merge safely.
            Compare or download it, then bring the edits across manually.
          </p>
        )}
        {local.unappliedCode && (
          <p>
            Apply or discard the unfinished Code text before combining drafts.
            The download includes that text.
          </p>
        )}
        {applyError && <p role="alert">{applyError}</p>}
        <p>
          Download includes node positions and unapplied Code text. It may
          contain credentials, so keep it private.
        </p>
      </div>
      <div className="modal-footer">
        <Button variant="secondary" onClick={onDownload}>
          Download my draft
        </Button>
        <Button variant="secondary" disabled={applying} onClick={onClose}>
          Keep editing my copy
        </Button>
        {merge && (
          <Button
            disabled={!!unresolved.length || !!local.unappliedCode}
            busy={applying}
            onClick={() => void applyMerge()}
          >
            Apply combined draft
          </Button>
        )}
      </div>
    </Modal>
  );
}
