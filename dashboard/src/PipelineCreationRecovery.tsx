import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { ArrowRight, CircleAlert, History } from "lucide-react";
import {
  api,
  can,
  PipelineCreateReceiptSchema,
  PipelineRequestLookupSchema,
  withRequestDeadline,
  type Configuration,
  type PipelineCreateReceipt,
  type PipelineRequestPage,
  type User,
} from "./api";
import { DataTable } from "./DataTable";
import {
  Button,
  DateCell,
  ErrorBox,
  Modal,
  Pagination,
  RefreshButton,
} from "./ui";
import {
  dismissPipelineCreationStorageIssue,
  finishPipelineCreationOperation,
  pipelineCreationOperationAvailable,
  usePipelineCreationOperations,
  type PipelineCreationOperation,
  type PipelineCreationStorageIssue,
  assertPipelineCreationResult,
  pipelineCreationPath,
} from "./pipelineCreationRequests";
import "./pipeline-creation-recovery.css";

type Selection = {
  id?: string;
  operation?: PipelineCreationOperation;
  issue?: PipelineCreationStorageIssue;
  metadata?: {
    operation: "create" | "duplicate";
    source_configuration_id: string | null;
    source_revision: number | null;
    configuration_id: string;
  };
};
type Screen = "local" | "recent" | "request" | null;
export type PipelineCreationRecoveryHandle = {
  openRecent(opener: HTMLElement): void;
  openSaved(opener: HTMLElement): void;
};
type Props = {
  user: User;
  showRecent?: boolean;
  ref?: Ref<PipelineCreationRecoveryHandle>;
  onRecovered(version: Configuration): void;
  onReview?(version: Configuration): boolean | void;
};

export function PipelineCreationRecovery(props: Props) {
  // An account change must discard all open dialogs and late callbacks.
  return can(props.user, "edit") ? (
    <RecoveryCenter key={`${props.user.id}:${props.user.role}`} {...props} />
  ) : null;
}
export default PipelineCreationRecovery;

function RecoveryCenter({
  user,
  showRecent = true,
  ref,
  onRecovered,
  onReview,
}: Props) {
  const { operations, errors } = usePipelineCreationOperations(user.id);
  const [screen, setScreen] = useState<Screen>(null);
  const [selection, setSelection] = useState<Selection>({});
  const [found, setFound] = useState<PipelineCreateReceipt | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [busy, setBusy] = useState<"status" | "retry" | null>(null);
  const [recentPage, setRecentPage] = useState(1);
  const [recentRefresh, setRecentRefresh] = useState(0);
  const [recent, setRecent] = useState<{
    path: string;
    data: PipelineRequestPage | null;
    error: string;
    loading: boolean;
  }>({ path: "", data: null, error: "", loading: false });
  const opener = useRef<HTMLElement | null>(null);
  const receiptFocus = useRef<HTMLHeadingElement | null>(null);
  const active = useRef<{
    controller: AbortController;
    kind: "status" | "retry";
  } | null>(null);
  const mounted = useRef(true);
  const actor = useRef(user.id);
  const currentRole = useRef(user.role);
  actor.current = user.id;
  currentRole.current = user.role;
  const allowed = () =>
    mounted.current &&
    actor.current === user.id &&
    ["admin", "editor"].includes(currentRole.current);
  const recentPath = `/configurations/requests?page=${recentPage}&page_size=12`;
  const reminder = selection.operation;
  const available = !!reminder && pipelineCreationOperationAvailable(reminder);

  useImperativeHandle(ref, () => ({
    openSaved(trigger) {
      if (active.current || !allowed()) return;
      opener.current = trigger;
      setError("");
      setDismissing(false);
      setScreen("local");
    },
    openRecent(trigger) {
      if (active.current || !allowed()) return;
      opener.current = trigger;
      setRecentPage(1);
      setError("");
      setDismissing(false);
      setScreen("recent");
    },
  }));

  useEffect(() => {
    mounted.current = true;
    const navigate = (event: Event) => {
      if (active.current?.kind === "retry") event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (active.current?.kind === "retry") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("vectory:before-navigate", navigate);
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      window.removeEventListener("vectory:before-navigate", navigate);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  useEffect(() => {
    if (found) receiptFocus.current?.focus();
  }, [found]);
  useEffect(() => {
    if (screen !== "recent") return;
    const controller = new AbortController();
    let current = true;
    setRecent({ path: recentPath, data: null, error: "", loading: true });
    void withRequestDeadline(
      (signal) => api<PipelineRequestPage>(recentPath, { signal }),
      30000,
      controller.signal,
    )
      .then((data) => {
        if (current && allowed())
          setRecent({ path: recentPath, data, error: "", loading: false });
      })
      .catch((failure) => {
        if (current && allowed())
          setRecent({
            path: recentPath,
            data: null,
            error: (failure as Error).message,
            loading: false,
          });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [screen, recentPath, recentRefresh]);
  const recentVisible =
    recent.path === recentPath
      ? recent
      : { data: null, error: "", loading: true };
  const lastPage = Math.max(
    1,
    Math.ceil((recentVisible.data?.total || 0) / 12),
  );
  const correcting =
    screen === "recent" &&
    !recentVisible.loading &&
    !recentVisible.error &&
    recentPage > lastPage;
  useEffect(() => {
    if (correcting) setRecentPage(lastPage);
  }, [correcting, lastPage]);

  function close() {
    if (active.current?.kind === "retry") return;
    active.current?.controller.abort();
    active.current = null;
    setBusy(null);
    if (
      !opener.current?.isConnected ||
      opener.current.matches(':disabled, [aria-disabled="true"]')
    )
      opener.current = document.getElementById("main-content");
    setScreen(null);
  }
  function open(next: Screen, event: React.MouseEvent<HTMLButtonElement>) {
    opener.current = event.currentTarget;
    setError("");
    setDismissing(false);
    setScreen(next);
  }
  function choose(next: Selection) {
    setSelection(next);
    setFound(null);
    setChecked(false);
    setError("");
    setDismissing(false);
    setScreen("request");
  }
  function accept(
    result: Extract<import("./api").PipelineRequestLookup, { found: true }>,
    selected: Selection,
  ) {
    const version = result.configuration;
    if (result.request_id !== selected.id || version.request_id !== selected.id)
      throw Error(
        "The response did not match this request. Check status before creating another pipeline.",
      );
    if (
      selected.metadata &&
      (result.operation !== selected.metadata.operation ||
        result.source_configuration_id !==
          selected.metadata.source_configuration_id ||
        result.source_revision !== selected.metadata.source_revision ||
        version.id !== selected.metadata.configuration_id)
    )
      throw Error("The result does not match the selected pipeline request.");
    if (selected.operation)
      assertPipelineCreationResult(selected.operation, result);
    let cleanup = "";
    if (selected.operation) {
      try {
        finishPipelineCreationOperation(selected.operation);
      } catch {
        cleanup =
          "The pipeline is saved, but this browser could not clear its reminder. You can open the pipeline, or dismiss the reminder after browser storage is available.";
      }
    }
    if (!allowed()) return;
    setFound(version);
    setError(cleanup);
    onRecovered(version);
  }
  async function resolve(retry: boolean, selected = selection) {
    if (
      active.current ||
      !allowed() ||
      !selected.id ||
      (selected.operation && selected.operation.actor_id !== user.id)
    )
      return;
    if (
      retry &&
      (!checked ||
        !selected.operation ||
        !pipelineCreationOperationAvailable(selected.operation))
    )
      return;
    const controller = new AbortController(),
      claim = {
        controller,
        kind: retry ? ("retry" as const) : ("status" as const),
      };
    active.current = claim;
    setBusy(claim.kind);
    setError("");
    setChecked(false);
    try {
      if (retry) {
        const version = await withRequestDeadline(
          (signal) =>
            api(
              pipelineCreationPath(selected.operation!),
              {
                method: "POST",
                signal,
                body: JSON.stringify(selected.operation!.request),
              },
              PipelineCreateReceiptSchema,
            ),
          30000,
          controller.signal,
        );
        if (allowed() && active.current === claim)
          accept(
            {
              request_id: selected.id,
              found: true,
              operation: selected.operation!.operation,
              source_configuration_id:
                selected.operation!.source_configuration_id,
              source_revision:
                selected.operation!.operation === "duplicate"
                  ? selected.operation!.request.revision
                  : null,
              configuration: version,
            },
            selected,
          );
      } else {
        const response = await withRequestDeadline(
          (signal) =>
            api(
              `/configurations/requests/${selected.id}`,
              { signal },
              PipelineRequestLookupSchema,
            ),
          30000,
          controller.signal,
        );
        if (!allowed() || active.current !== claim) return;
        if (response.request_id !== selected.id)
          throw Error(
            "The server returned a different request identity. Update the server or check again before retrying.",
          );
        if (response.found) accept(response, selected);
        else setChecked(true);
      }
    } catch (failure) {
      if (allowed() && active.current === claim)
        setError((failure as Error).message);
    } finally {
      if (active.current === claim) {
        active.current = null;
        if (mounted.current) setBusy(null);
      }
    }
  }
  function dismiss() {
    if (active.current || !allowed()) return;
    try {
      if (selection.operation)
        finishPipelineCreationOperation(selection.operation);
      else if (selection.issue)
        dismissPipelineCreationStorageIssue(selection.issue);
      close();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  // Opening a reminder performs only a read. Retrying always needs a deliberate
  // click after an exact, schema-checked found:false response proves support.
  useEffect(() => {
    if (screen === "request" && selection.id) void resolve(false, selection);
  }, [screen, selection]);

  const hasReminders = operations.length > 0 || errors.length > 0;
  const localCount =
    operations.length +
    errors.filter((issue) => issue.kind === "corrupt").length;
  const canDismiss =
    (!!selection.operation && (!found || available)) ||
    selection.issue?.kind === "corrupt";
  const request = selection.operation?.request;
  return (
    <>
      {(hasReminders || showRecent) && (
        <div className="pipeline-creation-recovery-bar">
          {hasReminders && (
            <div className="pipeline-creation-recovery-notice" role="status">
              <CircleAlert size={17} aria-hidden="true" />
              <span>
                {errors.length
                  ? "Review saved pipeline requests before creating or duplicating another."
                  : `${operations.length} ${operations.length === 1 ? "pipeline request needs" : "pipeline requests need"} confirmation before creating or duplicating another.`}
              </span>
              <Button
                variant="ghost compact"
                onClick={(event) => open("local", event)}
              >
                Review pipeline requests
              </Button>
            </div>
          )}
          {showRecent && (
            <Button
              variant="ghost compact"
              icon={History}
              onClick={(event) => {
                setRecentPage(1);
                open("recent", event);
              }}
            >
              Your pipeline requests
            </Button>
          )}
        </div>
      )}
      {screen && (
        <Modal
          open
          wide={screen === "recent"}
          className="pipeline-creation-recovery-modal"
          returnFocusRef={opener}
          onClose={close}
          title={
            screen === "local"
              ? "Saved pipeline requests"
              : screen === "recent"
                ? "Your pipeline requests"
                : dismissing
                  ? "Dismiss this pipeline reminder?"
                  : found
                    ? "Pipeline saved"
                    : "Review pipeline request"
          }
          description={
            screen === "recent"
              ? "Find pipelines created or duplicated by your account, including requests from other tabs and devices."
              : screen === "local"
                ? "These reminders are saved in this browser. Confirm their result before creating or duplicating another pipeline."
                : "Check whether the pipeline was saved before trying again. Existing pipelines stay unchanged."
          }
        >
          <div className="modal-body pipeline-creation-recovery-body">
            {screen === "local" && (
              <>
                {!hasReminders && <p>There are no saved pipeline reminders.</p>}
                <div className="pipeline-creation-recovery-list">
                  {operations.map((operation) => (
                    <button
                      key={operation.id}
                      type="button"
                      onClick={() => choose({ id: operation.id, operation })}
                    >
                      <span>
                        <strong>{operation.request.name}</strong>
                        <small>
                          {operation.operation === "duplicate"
                            ? "Duplicate pipeline"
                            : "Create pipeline"}
                        </small>
                        <small>
                          {new Date(operation.recorded_at).toLocaleString()}
                        </small>
                      </span>
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  ))}
                  {errors.map((issue, index) => (
                    <div
                      className="pipeline-creation-recovery-storage-error"
                      key={`${issue.id || issue.kind}:${index}`}
                    >
                      <ErrorBox message={issue.message} />
                      {issue.kind === "corrupt" && (
                        <Button
                          variant="secondary"
                          onClick={() => choose({ id: issue.id, issue })}
                        >
                          Review unreadable reminder
                          {localCount > 1 ? ` ${index + 1}` : ""}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                {errors.length > 0 && (
                  <p>
                    Recent server requests can help find a saved pipeline when
                    local data is unavailable. An absent result does not prove
                    an earlier request failed.
                  </p>
                )}
              </>
            )}
            {screen === "recent" && (
              <>
                <div className="pipeline-creation-recovery-toolbar">
                  <RefreshButton
                    busy={recentVisible.loading}
                    onClick={() => setRecentRefresh((value) => value + 1)}
                  >
                    Refresh requests
                  </RefreshButton>
                </div>
                {recentVisible.error && (
                  <ErrorBox
                    message={recentVisible.error}
                    retry={() => setRecentRefresh((value) => value + 1)}
                  />
                )}
                <DataTable
                  label="Your pipeline requests"
                  data={
                    recentVisible.error ? [] : recentVisible.data?.items || []
                  }
                  rowKey={(row) => row.request_id}
                  loading={recentVisible.loading || correcting}
                  columns={[
                    {
                      id: "name",
                      header: "Pipeline",
                      sortable: false,
                      cell: (row) => (
                        <>
                          <strong>
                            {row.configuration_name || "Saved pipeline"}
                          </strong>
                          <small className="pipeline-creation-recovery-id">
                            {row.configuration_id}
                          </small>
                        </>
                      ),
                    },
                    {
                      id: "operation",
                      header: "Request",
                      sortable: false,
                      cell: (row) =>
                        row.operation === "create" ? "Create" : "Duplicate",
                    },
                    {
                      id: "created",
                      header: "Saved",
                      sortable: false,
                      cell: (row) => <DateCell value={row.created_at} />,
                    },
                    {
                      id: "action",
                      header: <span className="sr-only">Actions</span>,
                      label: "Actions",
                      sortable: false,
                      cell: (row) => (
                        <Button
                          variant="ghost compact"
                          onClick={() =>
                            choose({
                              id: row.request_id,
                              metadata: row,
                              operation: operations.find(
                                (op) => op.id === row.request_id,
                              ),
                            })
                          }
                        >
                          View request
                        </Button>
                      ),
                    },
                  ]}
                  empty={
                    recentVisible.error
                      ? "Requests unavailable."
                      : "No saved pipeline requests found."
                  }
                />
                {!recentVisible.loading &&
                  !recentVisible.error &&
                  !correcting && (
                    <Pagination
                      count={recentVisible.data?.total || 0}
                      page={recentPage}
                      size={12}
                      onPage={setRecentPage}
                    />
                  )}
                <p>
                  Only requests saved by the server appear here. A missing
                  request may still be in flight. This list cannot reconstruct a
                  retry if its original browser reminder was lost.
                </p>
              </>
            )}
            {screen === "request" && (
              <>
                {error && <ErrorBox message={error} />}
                {selection.id && (
                  <p className="pipeline-creation-recovery-request-id">
                    Request ID <code>{selection.id}</code>
                  </p>
                )}
                {selection.issue && (
                  <ErrorBox message="The original request cannot be safely reconstructed from this reminder. You can check its exact result when the request ID is available, but it cannot be retried." />
                )}
                {dismissing ? (
                  <p>
                    Dismissing removes only this browser reminder. It does not
                    cancel a request or delete a pipeline. Check your pipeline
                    requests before starting a separate create or duplicate.
                  </p>
                ) : found ? (
                  <section
                    className="pipeline-creation-recovery-receipt"
                    aria-label="Saved pipeline"
                  >
                    <h3 ref={receiptFocus} tabIndex={-1}>
                      {found.name}
                    </h3>
                    <p>
                      This is the saved pipeline with its current details,
                      including any later edits. Recovery does not restore the
                      original request or publish or deploy a version.
                    </p>
                    <dl>
                      <div>
                        <dt>Pipeline ID</dt>
                        <dd className="pipeline-creation-recovery-id">
                          {found.id}
                        </dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>
                          {found.archived ? "Archived" : "Active"} / Draft{" "}
                          {found.revision}
                        </dd>
                      </div>
                      <div>
                        <dt>Description</dt>
                        <dd>{found.description || "No description"}</dd>
                      </div>
                      <div>
                        <dt>Updated</dt>
                        <dd>
                          <DateCell value={found.updated_at} />
                        </dd>
                      </div>
                    </dl>
                  </section>
                ) : (
                  <>
                    <p role="status">
                      {busy === "status"
                        ? "Checking the pipeline request…"
                        : busy === "retry"
                          ? "Sending the same saved request…"
                          : checked
                            ? "No completed request was found yet. It may still be in flight."
                            : "Check whether the server saved this pipeline. A failed read does not mean creation failed."}
                    </p>
                    {request && (
                      <p>
                        {reminder?.operation === "create"
                          ? "Retry uses the original name, description, configuration and graph."
                          : "Retry uses the originally reviewed source revision. If the source changed before this request was saved, review it before starting again."}
                      </p>
                    )}
                    {request && !available && (
                      <p>
                        This reminder changed or was dismissed in another tab.
                        Status lookup remains available; retry is disabled.
                      </p>
                    )}
                  </>
                )}
                {request && (
                  <section
                    className="pipeline-creation-recovery-original"
                    aria-label="Original pipeline request"
                  >
                    <h3>Original request</h3>
                    <dl>
                      <div>
                        <dt>Request</dt>
                        <dd>
                          {reminder?.operation === "duplicate"
                            ? "Duplicate pipeline"
                            : "Create pipeline"}
                        </dd>
                      </div>
                      <div>
                        <dt>Name</dt>
                        <dd>{request.name}</dd>
                      </div>
                      <div>
                        <dt>Description</dt>
                        <dd>{request.description || "No description"}</dd>
                      </div>
                      {reminder?.operation === "duplicate" && (
                        <>
                          <div>
                            <dt>Source ID</dt>
                            <dd className="pipeline-creation-recovery-id">
                              {reminder.source_configuration_id}
                            </dd>
                          </div>
                          <div>
                            <dt>Source revision</dt>
                            <dd>{reminder.request.revision}</dd>
                          </div>
                        </>
                      )}
                      {reminder?.operation === "create" && (
                        <div>
                          <dt>Configuration</dt>
                          <dd>
                            Original configuration and graph are retained
                            exactly in this browser.
                          </dd>
                        </div>
                      )}
                    </dl>
                    {reminder?.operation === "create" && (
                      <details className="pipeline-creation-original-data">
                        <summary>View original configuration and graph</summary>
                        <pre tabIndex={0}>
                          {JSON.stringify(
                            {
                              config: reminder.request.config,
                              graph: reminder.request.graph,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    )}
                  </section>
                )}
                {canDismiss && !dismissing && (
                  <button
                    type="button"
                    className="pipeline-creation-recovery-dismiss"
                    disabled={!!busy}
                    onClick={() => {
                      setDismissing(true);
                      setError("");
                    }}
                  >
                    Dismiss reminder
                  </button>
                )}
              </>
            )}
          </div>
          <div className="modal-footer pipeline-creation-recovery-footer">
            <Button
              variant="secondary"
              disabled={busy === "retry"}
              onClick={close}
            >
              Close
            </Button>
            {screen === "local" && (
              <Button
                variant="secondary"
                onClick={() => {
                  setRecentPage(1);
                  setScreen("recent");
                }}
              >
                Your pipeline requests
              </Button>
            )}
            {screen === "request" &&
              (dismissing ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => setDismissing(false)}
                  >
                    Keep reminder
                  </Button>
                  <Button variant="danger" onClick={dismiss}>
                    Dismiss reminder
                  </Button>
                </>
              ) : found ? (
                onReview && (
                  <Button
                    icon={ArrowRight}
                    onClick={() => {
                      if (onReview(found) === false) return;
                      opener.current = null;
                      setScreen(null);
                    }}
                  >
                    Open pipeline
                  </Button>
                )
              ) : (
                <>
                  {selection.id && (
                    <Button
                      variant="secondary"
                      busy={busy === "status"}
                      disabled={!!busy}
                      onClick={() => void resolve(false)}
                    >
                      Check status
                    </Button>
                  )}
                  {request && (
                    <Button
                      busy={busy === "retry"}
                      disabled={!!busy || !checked || !available}
                      onClick={() => void resolve(true)}
                    >
                      Retry same request
                    </Button>
                  )}
                </>
              ))}
          </div>
        </Modal>
      )}
    </>
  );
}
