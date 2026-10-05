import { useEffect, useRef, useState } from "react";
import {
  api,
  PipelineCreateReceiptSchema,
  PipelineRequestLookupSchema,
  withRequestDeadline,
  type Config,
  type Graph,
  type PipelineCreateReceipt,
  type VariableDeclaration,
} from "./api";
import {
  beginPipelineCreationOperation,
  finishPipelineCreationOperation,
  isDefinitivePipelineCreationRejection,
  pipelineCreationOperationAvailable,
  pipelineNameError,
} from "./pipelineCreationRequests";
import { Button, ErrorBox, Modal } from "./ui";

export type StaleDraftCopy = {
  sourceName: string;
  name: string;
  description: string;
  config: Config;
  graph: Graph;
  variables: VariableDeclaration[];
};

/** Creates an independent draft from the exact local snapshot, never the stale server draft. */
export default function StaleDraftCopyDialog({
  actorId,
  copy,
  onClose,
  onReviewRequest,
  onOpen,
}: {
  actorId: string;
  copy: StaleDraftCopy;
  onClose: () => void;
  onReviewRequest: () => void;
  onOpen: (id: string) => void;
}) {
  const [name, setName] = useState(copy.name);
  const [description, setDescription] = useState(copy.description);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [created, setCreated] = useState<PipelineCreateReceipt | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);

  async function create() {
    if (busy || uncertain || created) return;
    const nameProblem = pipelineNameError(name);
    if (nameProblem) {
      setError(nameProblem);
      return;
    }
    if (new TextEncoder().encode(description).length > 2000) {
      setError("Shorten the description to at most 2000 UTF-8 bytes.");
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    let operation: ReturnType<typeof beginPipelineCreationOperation> | null =
      null;
    let sent = false;
    try {
      operation = beginPipelineCreationOperation(actorId, {
        operation: "create",
        request: {
          name: name.trim(),
          description,
          config: copy.config,
          graph: copy.graph,
          variables: copy.variables,
        },
      });
      // Confirm this server can correlate the saved ID before any create is sent.
      const lookup = await withRequestDeadline(
        (signal) =>
          api(
            `/configurations/requests/${operation!.id}`,
            { signal },
            PipelineRequestLookupSchema,
          ),
        30000,
        controller.signal,
      );
      if (!mounted.current || active.current !== controller) return;
      if (lookup.request_id !== operation.id || lookup.found)
        throw Error(
          "The saved request needs review before creating a pipeline.",
        );
      if (!pipelineCreationOperationAvailable(operation))
        throw Error(
          "The saved request changed in another tab. Review it before continuing.",
        );
      sent = true;
      const result = await withRequestDeadline(
        (signal) =>
          api(
            "/configurations",
            {
              method: "POST",
              body: JSON.stringify(operation!.request),
              signal,
            },
            PipelineCreateReceiptSchema,
          ),
        30000,
        controller.signal,
      );
      if (!mounted.current || active.current !== controller) return;
      if (result.request_id !== operation.id)
        throw Error("The server returned a different request identity.");
      setCreated(result);
      try {
        finishPipelineCreationOperation(operation);
      } catch {
        setError(
          "The new pipeline is saved, but this browser could not clear its reminder. Review the saved request after closing this dialog.",
        );
      }
    } catch (failure) {
      if (!mounted.current || active.current !== controller) return;
      if (operation && isDefinitivePipelineCreationRejection(failure, sent)) {
        try {
          finishPipelineCreationOperation(operation);
          setError((failure as Error).message);
          return;
        } catch {
          // An uncleared reminder still needs review before another creation.
        }
      }
      if (operation) {
        setUncertain(true);
        setError(
          `${(failure as Error).message} The create result is unknown. Review the saved request before retrying; your edits remain in the original editor.`,
        );
      } else setError((failure as Error).message);
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  const sourceCounts = ["sources", "transforms", "sinks"].map(
    (section) => Object.keys(copy.config[section] || {}).length,
  );
  return (
    <Modal
      open
      wide
      title={created ? "New pipeline saved" : "Save mine as a new pipeline"}
      description={
        created
          ? "The original pipeline and your local edits remain unchanged."
          : `Create an independent draft from your local edits to ${copy.sourceName}. The newer server draft stays unchanged.`
      }
      onClose={() => !busy && onClose()}
    >
      <div className="modal-body stale-draft-review">
        {created ? (
          <p role="status">
            <strong>{created.name}</strong> was saved as a separate draft. It is
            not published or assigned to devices.
          </p>
        ) : (
          <>
            <label>
              New pipeline name
              <input
                autoFocus
                value={name}
                maxLength={120}
                disabled={busy || uncertain}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              Description
              <textarea
                value={description}
                disabled={busy || uncertain}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <p>
              Local draft: {sourceCounts[0]} sources, {sourceCounts[1]}{" "}
              transforms, {sourceCounts[2]} sinks and {copy.variables.length}{" "}
              variable
              {copy.variables.length === 1 ? " declaration" : " declarations"}.
              The canvas layout is included.
            </p>
            {copy.variables.length > 0 && (
              <ul>
                {copy.variables.map((variable) => (
                  <li key={variable.name}>
                    <code>{variable.name}</code> ({variable.type}) at{" "}
                    <code>{variable.path}</code>
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary>Review the exact local configuration and graph</summary>
              <pre tabIndex={0}>
                {JSON.stringify(
                  {
                    config: copy.config,
                    graph: copy.graph,
                    variables: copy.variables,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <p>
              Creating this copy does not resolve the original save conflict or
              change what any device runs.
            </p>
          </>
        )}
        {error && <ErrorBox message={error} />}
      </div>
      <div className="modal-footer">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {created ? "Keep editing original" : "Back to my edits"}
        </Button>
        {created ? (
          <Button onClick={() => onOpen(created.id)}>Open new pipeline</Button>
        ) : uncertain ? (
          <Button onClick={onReviewRequest}>Review saved request</Button>
        ) : (
          <Button busy={busy} onClick={() => void create()}>
            Create new pipeline
          </Button>
        )}
      </div>
    </Modal>
  );
}
