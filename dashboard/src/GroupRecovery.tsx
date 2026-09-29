import { useEffect, useRef, useState } from "react";
import { ArrowRight, CircleAlert, History } from "lucide-react";
import {
  api,
  can,
  GroupCreateReceiptSchema,
  GroupRequestLookupSchema,
  withRequestDeadline,
  type Group,
  type GroupCreateReceipt,
  type GroupRequestPage,
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
  dismissGroupStorageIssue,
  finishGroupOperation,
  groupOperationAvailable,
  useGroupOperations,
  type GroupOperation,
  type GroupStorageIssue,
} from "./groupRequests";
import "./group-recovery.css";

type Selection = {
  id?: string;
  operation?: GroupOperation;
  issue?: GroupStorageIssue;
};
type Screen = "local" | "recent" | "request" | null;
type Props = {
  user: User;
  onRecovered(group: Group): void;
  onReview?(group: Group): void;
};

export function GroupRecovery(props: Props) {
  // An account change must discard all open dialogs and late callbacks.
  return can(props.user, "operate") ? (
    <RecoveryCenter key={props.user.id} {...props} />
  ) : null;
}
export default GroupRecovery;

function RecoveryCenter({ user, onRecovered, onReview }: Props) {
  const { operations, errors } = useGroupOperations(user.id);
  const [screen, setScreen] = useState<Screen>(null);
  const [selection, setSelection] = useState<Selection>({});
  const [found, setFound] = useState<GroupCreateReceipt | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [busy, setBusy] = useState<"status" | "retry" | null>(null);
  const [memberPage, setMemberPage] = useState(1);
  const [recentPage, setRecentPage] = useState(1);
  const [recentRefresh, setRecentRefresh] = useState(0);
  const [recent, setRecent] = useState<{
    path: string;
    data: GroupRequestPage | null;
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
  const recentPath = `/groups/requests?page=${recentPage}&page_size=12`;
  const reminder = selection.operation;
  const available = !!reminder && groupOperationAvailable(reminder);

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
      (signal) => api<GroupRequestPage>(recentPath, { signal }),
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
    setMemberPage(1);
    setScreen("request");
  }
  function accept(group: GroupCreateReceipt, selected: Selection) {
    if (group.request_id !== selected.id)
      throw Error(
        "The response identified a different request. Check status again; do not create a replacement yet.",
      );
    let cleanup = "";
    if (selected.operation) {
      try {
        finishGroupOperation(selected.operation);
      } catch {
        cleanup =
          "The group is confirmed, but this browser could not clear its reminder. You can still open the saved group. Dismiss the reminder again after browser storage is available.";
      }
    }
    if (!allowed()) return;
    setFound(group);
    setError(cleanup);
    onRecovered(group);
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
        !groupOperationAvailable(selected.operation))
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
        const group = await withRequestDeadline(
          (signal) =>
            api(
              "/groups",
              {
                method: "POST",
                signal,
                body: JSON.stringify(selected.operation!.request),
              },
              GroupCreateReceiptSchema,
            ),
          30000,
          controller.signal,
        );
        if (allowed() && active.current === claim) accept(group, selected);
      } else {
        const response = await withRequestDeadline(
          (signal) =>
            api(
              `/groups/requests/${selected.id}`,
              { signal },
              GroupRequestLookupSchema,
            ),
          30000,
          controller.signal,
        );
        if (!allowed() || active.current !== claim) return;
        if (response.request_id !== selected.id)
          throw Error(
            "The server returned a different request identity. Update the server or check again before retrying.",
          );
        if (response.found) accept(response.group, selected);
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
      if (selection.operation) finishGroupOperation(selection.operation);
      else if (selection.issue) dismissGroupStorageIssue(selection.issue);
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
      <div className="group-recovery-bar">
        {hasReminders && (
          <div className="group-recovery-notice" role="status">
            <CircleAlert size={17} aria-hidden="true" />
            <span>
              {errors.length
                ? "Saved group requests need review."
                : `${operations.length} ${operations.length === 1 ? "group request needs" : "group requests need"} confirmation.`}
            </span>
            <Button
              variant="ghost compact"
              onClick={(event) => open("local", event)}
            >
              Review group requests
            </Button>
          </div>
        )}
        <Button
          variant="ghost compact"
          icon={History}
          onClick={(event) => {
            setRecentPage(1);
            open("recent", event);
          }}
        >
          Your recent group requests
        </Button>
      </div>
      {screen && (
        <Modal
          open
          wide={screen === "recent"}
          className="group-recovery-modal"
          returnFocusRef={opener}
          onClose={close}
          title={
            screen === "local"
              ? "Saved group requests"
              : screen === "recent"
                ? "Your recent group requests"
                : dismissing
                  ? "Dismiss this group reminder?"
                  : found
                    ? "Group confirmed"
                    : "Review group request"
          }
          description={
            screen === "recent"
              ? "Find groups saved by your account, including requests from other tabs and devices."
              : screen === "local"
                ? "These reminders are saved in this browser. Confirm their result before creating another group."
                : "Check whether your group was saved before trying again."
          }
        >
          <div className="modal-body group-recovery-body">
            {screen === "local" && (
              <>
                {!hasReminders && (
                  <p>There are no saved group reminders in this browser.</p>
                )}
                <div className="group-recovery-list">
                  {operations.map((operation) => (
                    <button
                      key={operation.id}
                      type="button"
                      onClick={() => choose({ id: operation.id, operation })}
                    >
                      <span>
                        <strong>{operation.request.name}</strong>
                        <small>
                          {operation.request.device_ids.length} devices ·{" "}
                          {new Date(operation.recorded_at).toLocaleString()}
                        </small>
                      </span>
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  ))}
                  {errors.map((issue, index) => (
                    <div
                      className="group-recovery-storage-error"
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
                    Recent server requests can help find a saved group when
                    local data is unavailable. An absent result does not prove
                    an earlier request failed.
                  </p>
                )}
              </>
            )}
            {screen === "recent" && (
              <>
                <div className="group-recovery-toolbar">
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
                  label="Your recent group requests"
                  data={
                    recentVisible.error ? [] : recentVisible.data?.items || []
                  }
                  rowKey={(row) => row.request_id}
                  loading={recentVisible.loading || correcting}
                  columns={[
                    {
                      id: "group",
                      header: "Group",
                      sortable: false,
                      cell: (row) => (
                        <>
                          <strong>
                            {row.group_name || "Group name unavailable"}
                          </strong>
                          <small className="group-recovery-id">
                            {row.group_id}
                          </small>
                        </>
                      ),
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
                      : "No saved requests found."
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
                  request may still be in flight. A saved group may have been
                  renamed or its membership edited since creation.
                </p>
              </>
            )}
            {screen === "request" && (
              <>
                {error && <ErrorBox message={error} />}
                {selection.id && (
                  <p className="group-recovery-request-id">
                    Request ID <code>{selection.id}</code>
                  </p>
                )}
                {selection.issue && (
                  <ErrorBox message="The original request cannot be safely reconstructed from this reminder. You can check its exact result when the request ID is available, but it cannot be retried." />
                )}
                {dismissing ? (
                  <p>
                    Dismissing removes only this browser reminder. It does not
                    cancel a request or delete a group. Check the server result
                    and recent requests before creating a replacement.
                  </p>
                ) : found ? (
                  <section
                    className="group-recovery-receipt"
                    aria-label="Saved group"
                  >
                    <h3 ref={receiptFocus} tabIndex={-1}>
                      {found.name}
                    </h3>
                    <p>
                      The original request is saved. This is the current group;
                      its name, description or members may have changed since
                      creation.
                    </p>
                    <dl>
                      <div>
                        <dt>Group ID</dt>
                        <dd className="group-recovery-id">{found.id}</dd>
                      </div>
                      <div>
                        <dt>Revision</dt>
                        <dd>{found.revision}</dd>
                      </div>
                      <div>
                        <dt>Current devices</dt>
                        <dd>{found.device_ids.length}</dd>
                      </div>
                    </dl>
                  </section>
                ) : (
                  <>
                    <p role="status">
                      {busy === "status"
                        ? "Checking the exact request…"
                        : busy === "retry"
                          ? "Sending the same saved request…"
                          : checked
                            ? "No completed request was found yet. It may still be in flight."
                            : "Check whether the server saved this request. A failed read does not mean creation failed."}
                    </p>
                    {request && (
                      <p>
                        Retry sends the original details with the same request
                        ID. The server returns the existing group if that
                        request was already saved.
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
                    className="group-recovery-original"
                    aria-label="Original group request"
                  >
                    <h3>Original request</h3>
                    <dl>
                      <div>
                        <dt>Name</dt>
                        <dd>{request.name}</dd>
                      </div>
                      <div>
                        <dt>Description</dt>
                        <dd>{request.description || "No description"}</dd>
                      </div>
                    </dl>
                    <details>
                      <summary>
                        Original devices ({request.device_ids.length})
                      </summary>
                      {request.device_ids.length === 0 ? (
                        <p>No devices selected.</p>
                      ) : (
                        <>
                          <ul className="group-recovery-members">
                            {request.device_ids
                              .slice((memberPage - 1) * 12, memberPage * 12)
                              .map((id) => (
                                <li key={id}>{id}</li>
                              ))}
                          </ul>
                          <Pagination
                            count={request.device_ids.length}
                            page={memberPage}
                            size={12}
                            onPage={setMemberPage}
                          />
                        </>
                      )}
                    </details>
                  </section>
                )}
                {canDismiss && !dismissing && (
                  <button
                    type="button"
                    className="group-recovery-dismiss"
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
          <div className="modal-footer group-recovery-footer">
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
                Your recent group requests
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
                      opener.current = null;
                      setScreen(null);
                      onReview(found);
                    }}
                  >
                    Open group
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
