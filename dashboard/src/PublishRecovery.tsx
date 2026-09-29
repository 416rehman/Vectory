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
  PublishReceiptSchema,
  PublishRequestLookupSchema,
  withRequestDeadline,
  type Version,
  type PublishReceipt,
  type PublishRequestPage,
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
  dismissPublishStorageIssue,
  finishPublishOperation,
  publishOperationAvailable,
  usePublishOperations,
  type PublishOperation,
  type PublishStorageIssue,
  assertPublishReceipt,
} from "./publishRequests";
import "./publish-recovery.css";

type Selection = {
  id?: string;
  operation?: PublishOperation;
  issue?: PublishStorageIssue;
  versionId?: string;
  sourceRevision?: number;
};
type Screen = "local" | "recent" | "request" | null;
export type PublishRecoveryHandle = { openRecent(opener: HTMLElement): void };
type Props = {
  user: User;
  configurationId: string;
  showRecent?: boolean;
  ref?: Ref<PublishRecoveryHandle>;
  onRecovered(version: Version): void;
  onReview?(version: Version): boolean | void;
};

export function PublishRecovery(props: Props) {
  // An account change must discard all open dialogs and late callbacks.
  return can(props.user, "operate") ? (
    <RecoveryCenter
      key={`${props.user.id}:${props.configurationId}`}
      {...props}
    />
  ) : null;
}
export default PublishRecovery;

function RecoveryCenter({
  user,
  configurationId,
  showRecent = true,
  ref,
  onRecovered,
  onReview,
}: Props) {
  const { operations, errors } = usePublishOperations(user.id, configurationId);
  const [screen, setScreen] = useState<Screen>(null);
  const [selection, setSelection] = useState<Selection>({});
  const [found, setFound] = useState<PublishReceipt | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [busy, setBusy] = useState<"status" | "retry" | null>(null);
  const [recentPage, setRecentPage] = useState(1);
  const [recentRefresh, setRecentRefresh] = useState(0);
  const [recent, setRecent] = useState<{
    path: string;
    data: PublishRequestPage | null;
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
    ["admin", "operator"].includes(currentRole.current);
  const recentPath = `/configurations/publish-requests?configuration_id=${configurationId}&page=${recentPage}&page_size=12`;
  const reminder = selection.operation;
  const available = !!reminder && publishOperationAvailable(reminder);

  useImperativeHandle(ref, () => ({
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
      (signal) => api<PublishRequestPage>(recentPath, { signal }),
      30000,
      controller.signal,
    )
      .then((data) => {
        if (
          data.items.some((item) => item.configuration_id !== configurationId)
        )
          throw Error(
            "The server returned publications for a different pipeline. Refresh before reviewing a result.",
          );
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
    if (!opener.current?.isConnected)
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
  function accept(version: PublishReceipt, selected: Selection) {
    if (
      version.request_id !== selected.id ||
      version.configuration_id !== configurationId ||
      (selected.versionId !== undefined && version.id !== selected.versionId) ||
      (selected.sourceRevision !== undefined &&
        version.source_revision !== selected.sourceRevision)
    )
      throw Error(
        "The response did not match this publication. Check status again before publishing another version.",
      );
    if (selected.operation) assertPublishReceipt(selected.operation, version);
    let cleanup = "";
    if (selected.operation) {
      try {
        finishPublishOperation(selected.operation);
      } catch {
        cleanup =
          "The version is published, but this browser could not clear its reminder. You can still review the published version. Dismiss the reminder again after browser storage is available.";
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
      (selected.operation &&
        (selected.operation.actor_id !== user.id ||
          selected.operation.configuration_id !== configurationId))
    )
      return;
    if (
      retry &&
      (!checked ||
        !selected.operation ||
        !publishOperationAvailable(selected.operation))
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
              `/configurations/${configurationId}/publish`,
              {
                method: "POST",
                signal,
                body: JSON.stringify(selected.operation!.request),
              },
              PublishReceiptSchema,
            ),
          30000,
          controller.signal,
        );
        if (allowed() && active.current === claim) accept(version, selected);
      } else {
        const response = await withRequestDeadline(
          (signal) =>
            api(
              `/configurations/publish-requests/${selected.id}`,
              { signal },
              PublishRequestLookupSchema,
            ),
          30000,
          controller.signal,
        );
        if (!allowed() || active.current !== claim) return;
        if (response.request_id !== selected.id)
          throw Error(
            "The server returned a different request identity. Update the server or check again before retrying.",
          );
        if (response.found) accept(response.version, selected);
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
      if (selection.operation) finishPublishOperation(selection.operation);
      else if (selection.issue) dismissPublishStorageIssue(selection.issue);
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
        <div className="publish-recovery-bar">
          {hasReminders && (
            <div className="publish-recovery-notice" role="status">
              <CircleAlert size={17} aria-hidden="true" />
              <span>
                {errors.length
                  ? "Saved publication requests need review."
                  : `${operations.length} ${operations.length === 1 ? "publication needs" : "publications need"} confirmation.`}
              </span>
              <Button
                variant="ghost compact"
                onClick={(event) => open("local", event)}
              >
                Review publish requests
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
              Your recent publications
            </Button>
          )}
        </div>
      )}
      {screen && (
        <Modal
          open
          wide={screen === "recent"}
          className="publish-recovery-modal"
          returnFocusRef={opener}
          onClose={close}
          title={
            screen === "local"
              ? "Saved publish requests"
              : screen === "recent"
                ? "Your recent publications"
                : dismissing
                  ? "Dismiss this publication reminder?"
                  : found
                    ? "Published"
                    : "Review publication"
          }
          description={
            screen === "recent"
              ? "Find versions published by your account for this pipeline, including requests from other tabs and devices."
              : screen === "local"
                ? "These reminders are saved in this browser. Confirm their result before publishing this pipeline again."
                : "Check whether the version was published before trying again. Your current draft stays unchanged."
          }
        >
          <div className="modal-body publish-recovery-body">
            {screen === "local" && (
              <>
                {!hasReminders && (
                  <p>
                    There are no saved publication reminders for this pipeline.
                  </p>
                )}
                <div className="publish-recovery-list">
                  {operations.map((operation) => (
                    <button
                      key={operation.id}
                      type="button"
                      onClick={() => choose({ id: operation.id, operation })}
                    >
                      <span>
                        <strong>
                          Draft revision {operation.request.revision}
                        </strong>
                        <small>
                          {operation.request.message ||
                            "No publication message"}
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
                      className="publish-recovery-storage-error"
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
                    Recent server publications can help find a saved version
                    when local data is unavailable. An absent result does not
                    prove an earlier request failed.
                  </p>
                )}
              </>
            )}
            {screen === "recent" && (
              <>
                <div className="publish-recovery-toolbar">
                  <RefreshButton
                    busy={recentVisible.loading}
                    onClick={() => setRecentRefresh((value) => value + 1)}
                  >
                    Refresh publications
                  </RefreshButton>
                </div>
                {recentVisible.error && (
                  <ErrorBox
                    message={recentVisible.error}
                    retry={() => setRecentRefresh((value) => value + 1)}
                  />
                )}
                <DataTable
                  label="Your recent publications"
                  data={
                    recentVisible.error ? [] : recentVisible.data?.items || []
                  }
                  rowKey={(row) => row.request_id}
                  loading={recentVisible.loading || correcting}
                  columns={[
                    {
                      id: "version",
                      header: "Version",
                      sortable: false,
                      cell: (row) => (
                        <>
                          <strong>Version {row.number}</strong>
                          <small className="publish-recovery-id">
                            {row.version_id}
                          </small>
                        </>
                      ),
                    },
                    {
                      id: "revision",
                      header: "Draft revision",
                      sortable: false,
                      cell: (row) => row.source_revision,
                    },
                    {
                      id: "created",
                      header: "Published",
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
                              versionId: row.version_id,
                              sourceRevision: row.source_revision,
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
                      ? "Publications unavailable."
                      : "No saved publications found."
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
                  <p className="publish-recovery-request-id">
                    Request ID <code>{selection.id}</code>
                  </p>
                )}
                {selection.issue && (
                  <ErrorBox message="The original request cannot be safely reconstructed from this reminder. You can check its exact result when the request ID is available, but it cannot be retried." />
                )}
                {dismissing ? (
                  <p>
                    Dismissing removes only this browser reminder. It does not
                    cancel publication or delete a version. Check recent
                    publications before reviewing the current draft for a
                    separate publication.
                  </p>
                ) : found ? (
                  <section
                    className="publish-recovery-receipt"
                    aria-label="Published version"
                  >
                    <h3 ref={receiptFocus} tabIndex={-1}>
                      Version {found.number}
                    </h3>
                    <p>
                      This immutable version is published. Your current draft
                      stays unchanged. Publication does not deploy it to
                      devices.
                    </p>
                    <dl>
                      <div>
                        <dt>Version ID</dt>
                        <dd className="publish-recovery-id">{found.id}</dd>
                      </div>
                      <div>
                        <dt>Draft revision</dt>
                        <dd>{found.source_revision}</dd>
                      </div>
                      <div>
                        <dt>Message</dt>
                        <dd>{found.message || "No publication message"}</dd>
                      </div>
                      <div>
                        <dt>Published</dt>
                        <dd>
                          <DateCell value={found.created_at} />
                        </dd>
                      </div>
                    </dl>
                  </section>
                ) : (
                  <>
                    <p role="status">
                      {busy === "status"
                        ? "Checking the publication…"
                        : busy === "retry"
                          ? "Sending the same saved request…"
                          : checked
                            ? "No completed request was found yet. It may still be in flight."
                            : "Check whether the server published this version. A failed read does not mean publication failed."}
                    </p>
                    {request && (
                      <>
                        <p>
                          Retry uses the original revision and message with the
                          same request ID. It cannot publish a newer draft.
                        </p>
                        <p>
                          If that revision has changed or the pipeline is
                          archived, the server may reject the request. Dismiss
                          the reminder deliberately, then review the current
                          draft before starting a new publication.
                        </p>
                      </>
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
                    className="publish-recovery-original"
                    aria-label="Original publication request"
                  >
                    <h3>Original request</h3>
                    <dl>
                      <div>
                        <dt>Pipeline ID</dt>
                        <dd className="publish-recovery-id">
                          {configurationId}
                        </dd>
                      </div>
                      <div>
                        <dt>Draft revision</dt>
                        <dd>{request.revision}</dd>
                      </div>
                      <div>
                        <dt>Message</dt>
                        <dd>{request.message || "No publication message"}</dd>
                      </div>
                    </dl>
                  </section>
                )}
                {canDismiss && !dismissing && (
                  <button
                    type="button"
                    className="publish-recovery-dismiss"
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
          <div className="modal-footer publish-recovery-footer">
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
                Your recent publications
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
                    Review published version
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
