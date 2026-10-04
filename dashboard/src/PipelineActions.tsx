import { useEffect, useRef, useState } from "react";
import {
  api,
  APIError,
  when,
  can,
  withRequestDeadline,
  PipelineCreateReceiptSchema,
  PipelineRequestLookupSchema,
  type Configuration,
  type User,
} from "./api";
import {
  beginPipelineCreationOperation,
  finishPipelineCreationOperation,
  isDefinitivePipelineCreationRejection,
  pipelineCreationOperationAvailable,
  usePipelineCreationOperations,
  type PipelineCreationOperation,
  pipelineCopyName,
} from "./pipelineCreationRequests";
import { Button, ErrorBox, Field, Modal } from "./ui";

export type PipelineAction = "duplicate" | "archive" | "unarchive";

export default function PipelineActions({
  user,
  configuration,
  action,
  onClose,
  onSaved,
  onReloaded,
  onRecovery,
}: {
  user: User;
  onRecovery?(): void;
  configuration: Pick<
    Configuration,
    "id" | "name" | "description" | "revision" | "updated_at" | "archived"
  >;
  action: PipelineAction;
  onClose(): void;
  onSaved(result: Configuration): void;
  onReloaded(result: Configuration): void;
}) {
  const [snapshot, setSnapshot] = useState(configuration);
  const [latestConfig, setLatestConfig] = useState<
    Configuration["config"] | null
  >(null);
  const [name, setName] = useState(pipelineCopyName(configuration.name));
  const [description, setDescription] = useState(
    configuration.description || "",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stale, setStale] = useState(false),
    [reloaded, setReloaded] = useState(false);
  const pending = usePipelineCreationOperations(user.id);
  const unresolved = pending.operations.length > 0 || pending.errors.length > 0;
  const [notice, setNotice] = useState<"uncertain" | "confirmed" | null>(null);
  const [created, setCreated] = useState<Configuration | null>(null);
  const active = useRef<AbortController | null>(null),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const guard = (e: Event) => {
      if (active.current) e.preventDefault();
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (active.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("vectory:before-navigate", guard);
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      active.current?.abort();
      window.removeEventListener("vectory:before-navigate", guard);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  const alreadyApplied =
    (action === "archive" && snapshot.archived) ||
    (action === "unarchive" && !snapshot.archived);
  async function loadLatest() {
    if (active.current || busy || notice) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const latest = await withRequestDeadline(
        (signal) =>
          api<Configuration>(`/configurations/${configuration.id}`, { signal }),
        30000,
        controller.signal,
      );
      if (!mounted.current || active.current !== controller) return;
      if (latest.id !== configuration.id)
        throw Error(
          "The server returned a different pipeline. Load its current state again before continuing.",
        );
      setSnapshot(latest);
      setLatestConfig(latest.config);
      setStale(false);
      setReloaded(true);
      setError("");
      onReloaded(latest);
    } catch (failure) {
      if (mounted.current && active.current === controller)
        setError((failure as Error).message);
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  const title =
    action === "duplicate"
      ? "Duplicate pipeline"
      : action === "archive"
        ? "Archive pipeline"
        : "Unarchive pipeline";
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      active.current ||
      busy ||
      stale ||
      alreadyApplied ||
      !can(user, "edit") ||
      (action === "duplicate" && (unresolved || notice))
    )
      return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    const current = () => mounted.current && active.current === controller;
    let operation: PipelineCreationOperation | null = null,
      sent = false;
    try {
      let result: Configuration;
      if (action === "duplicate") {
        operation = beginPipelineCreationOperation(user.id, {
          operation: "duplicate",
          source_configuration_id: configuration.id,
          request: {
            revision: snapshot.revision,
            name: name.trim(),
            description,
          },
        });
        const lookup = await withRequestDeadline(
          (signal) =>
            api(
              "/configurations/requests/" + operation!.id,
              { signal },
              PipelineRequestLookupSchema,
            ),
          30000,
          controller.signal,
        );
        if (!current()) return;
        if (lookup.request_id !== operation.id || lookup.found) {
          throw Error(
            "This request needs review before a duplicate can be sent. Close this form and review the saved request.",
          );
        }
        if (!pipelineCreationOperationAvailable(operation))
          throw Error(
            "The saved request changed in another tab. Review it before continuing.",
          );
        sent = true;
        const receipt = await withRequestDeadline(
          (signal) =>
            api(
              "/configurations/" + configuration.id + "/duplicate",
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
        if (!current()) return;
        if (
          receipt.request_id !== operation.id ||
          receipt.id === configuration.id
        )
          throw Error("The receipt did not match this duplicate request.");
        result = receipt;
        setCreated(result);
        try {
          finishPipelineCreationOperation(operation);
        } catch {
          setNotice("confirmed");
          setError(
            "The copy is saved, but this browser could not clear its reminder. Close this form and review the saved request.",
          );
          return;
        }
      } else {
        result = await withRequestDeadline(
          (signal) =>
            api<Configuration>(
              "/configurations/" + configuration.id + "/" + action,
              {
                method: "POST",
                body: JSON.stringify({ revision: snapshot.revision }),
                signal,
              },
            ),
          30000,
          controller.signal,
        );
        if (!current()) return;
        if (result.id !== configuration.id)
          throw Error(
            "The server returned a different pipeline. Load its current state before continuing.",
          );
      }
      active.current = null;
      onSaved(result);
    } catch (failure) {
      if (!current()) return;
      if (operation && isDefinitivePipelineCreationRejection(failure, sent)) {
        try {
          finishPipelineCreationOperation(operation);
          setError(failure.message);
          return;
        } catch {
          setNotice("uncertain");
          setError(
            "The server rejected this request, but this browser could not clear its reminder. Review the saved request before trying again.",
          );
          return;
        }
      }
      // This guard is emitted only after keyed replay inside the writer.
      // Source revisions are monotonic, so this exact rejected copy cannot
      // subsequently succeed. Other errors do not establish that boundary.
      if (
        operation &&
        sent &&
        failure instanceof APIError &&
        failure.serverRejection &&
        failure.status === 409 &&
        failure.code === "STALE_REVISION"
      ) {
        try {
          finishPipelineCreationOperation(operation);
          setStale(true);
          setError(failure.message);
          return;
        } catch {
          setNotice("uncertain");
          setError(
            "The source changed, but this browser could not clear its request reminder. Review the saved request before trying again.",
          );
          return;
        }
      }
      if (operation) {
        setNotice("uncertain");
        const message =
          failure instanceof APIError &&
          [404, 405].includes(failure.status) &&
          !sent
            ? "This tab did not send a creation request. Update the server to enable recovery, then review or dismiss this saved request."
            : (failure as Error).message;
        setError(
          message +
            " Review the saved pipeline request before trying again. A request in another tab may still complete.",
        );
        return;
      }
      setError((failure as Error).message);
      setStale(
        failure instanceof APIError && failure.code === "STALE_REVISION",
      );
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={title}
      onClose={() => !active.current && !busy && onClose()}
      description={snapshot.name}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          {notice && (
            <section role="status">
              <h3>
                {notice === "confirmed"
                  ? "Pipeline saved"
                  : "Duplicate result needs confirmation"}
              </h3>
              <p>
                {notice === "confirmed"
                  ? `The copy ${created?.name || "pipeline"} is saved. Its browser reminder still needs review.`
                  : "The original request is saved in this browser, including after closing or reloading this tab."}
              </p>
            </section>
          )}
          {action === "duplicate" && unresolved && !notice && !busy && (
            <ErrorBox message="Review the saved pipeline requests before creating another copy." />
          )}
          {stale && (
            <p>
              The pipeline changed since you opened it.{" "}
              <Button
                type="button"
                variant="secondary compact"
                disabled={
                  busy || (action === "duplicate" && (!!notice || unresolved))
                }
                onClick={() => void loadLatest()}
              >
                Load latest for review
              </Button>
            </p>
          )}
          {reloaded && (
            <div className="pipeline-action-review">
              <p>
                Loaded draft revision {snapshot.revision}, updated{" "}
                {when(snapshot.updated_at)}. Review this snapshot before
                continuing.
                {action === "duplicate" &&
                  " Your copy name and description are preserved."}
              </p>
              <details>
                <summary>Review latest configuration</summary>
                <pre tabIndex={0}>{JSON.stringify(latestConfig, null, 2)}</pre>
              </details>
            </div>
          )}
          {alreadyApplied && (
            <p role="status">
              This pipeline is already{" "}
              {action === "archive" ? "archived" : "active"}. Close this dialog
              to continue.
            </p>
          )}
          {action === "duplicate" ? (
            <>
              <p>
                The saved draft and graph become a new pipeline. Published
                versions, history, and device assignments stay with the
                original.
              </p>
              <Field label="Pipeline name">
                <input
                  required
                  autoFocus
                  disabled={
                    busy || (action === "duplicate" && (!!notice || unresolved))
                  }
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Description">
                <textarea
                  rows={3}
                  disabled={
                    busy || (action === "duplicate" && (!!notice || unresolved))
                  }
                  maxLength={2000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
            </>
          ) : action === "archive" ? (
            <>
              <p>
                The draft becomes read-only and moves to the archived library.
                You can unarchive it at any time.
              </p>
              <p>
                Running devices, scheduled deployments, and published versions
                remain unchanged. Published versions can still be deployed or
                used for rollback.
              </p>
            </>
          ) : (
            <p>
              Move this pipeline back to the active library and allow editing
              and publishing again.
            </p>
          )}
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              if (active.current) return;
              if (notice && onRecovery) onRecovery();
              else onClose();
            }}
          >
            {notice ? "Close and review request" : "Cancel"}
          </Button>
          <Button
            type="submit"
            busy={busy}
            disabled={
              stale ||
              !!alreadyApplied ||
              (action === "duplicate" &&
                (!name.trim() || !!notice || unresolved))
            }
          >
            {title}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
