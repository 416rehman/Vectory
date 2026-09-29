import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ArrowRight, CircleAlert, History } from "lucide-react";
import {
  api,
  can,
  PolicyCreateReceiptSchema,
  PolicyRequestLookupSchema,
  PolicyRequestPageSchema,
  withRequestDeadline,
  type Policy,
  type PolicyCreateReceipt,
  type PolicyRequestPage,
  type SavedPolicy,
  type User,
} from "./api";
import {
  Button,
  DateCell,
  ErrorBox,
  Field,
  Modal,
  Pagination,
  RefreshButton,
} from "./ui";
import { DataTable } from "./DataTable";
import {
  assertAgentSettingsReceipt,
  agentSettingsOperationAvailable,
  beginAgentSettingsOperation,
  dismissAgentSettingsStorageIssue,
  finishAgentSettingsOperation,
  readAgentSettingsOperations,
  useAgentSettingsOperations,
  type AgentSettingsOperation,
  type AgentSettingsStorageIssue,
} from "./agentSettingsRequests";
import "./agent-settings-creation.css";

export type AgentSettingsCreationHandle = {
  /** Opens the create form, optionally prefilled (for Duplicate). */
  openCreate(
    opener: HTMLElement,
    initial?: { name: string; policy: Policy },
  ): void;
  openRecent(opener: HTMLElement): void;
  openSaved(opener: HTMLElement): void;
};
export type AgentSettingsCreationProps = {
  user: User;
  onCreated(settings: SavedPolicy): void;
  onApply?(settings: SavedPolicy): boolean | void;
};
type Selection = {
  id?: string;
  policyId?: string;
  operation?: AgentSettingsOperation;
  issue?: AgentSettingsStorageIssue;
};
type Screen = "create" | "local" | "recent" | "request" | null;
function PolicyValues({ policy }: { policy: Policy }) {
  return (
    <dl className="agent-settings-values">
      <div>
        <dt>Check-in interval</dt>
        <dd>{policy.heartbeat_seconds} seconds</dd>
      </div>
      <div>
        <dt>Configuration sync</dt>
        <dd>{policy.sync_paused ? "Paused" : "Enabled"}</dd>
      </div>
      <div>
        <dt>Operational metrics</dt>
        <dd>{policy.telemetry_enabled ? "Collected" : "Off"}</dd>
      </div>
    </dl>
  );
}
export const AgentSettingsCreation = forwardRef<
  AgentSettingsCreationHandle,
  AgentSettingsCreationProps
>((props, ref) =>
  can(props.user, "operate") ? (
    <CreationCenter
      key={`${props.user.id}:${props.user.role}`}
      {...props}
      ref={ref}
    />
  ) : null,
);
export default AgentSettingsCreation;

const CreationCenter = forwardRef<
  AgentSettingsCreationHandle,
  AgentSettingsCreationProps
>(function CreationCenter({ user, onCreated, onApply }, ref) {
  const { operations, errors } = useAgentSettingsOperations(user.id);
  const [, refreshStorage] = useState(0);
  const [screen, setScreen] = useState<Screen>(null),
    [selection, setSelection] = useState<Selection>({});
  const [name, setName] = useState(""),
    [heartbeat, setHeartbeat] = useState("60"),
    [paused, setPaused] = useState(false),
    [telemetry, setTelemetry] = useState(true);
  const [found, setFound] = useState<PolicyCreateReceipt | null>(null),
    [checked, setChecked] = useState(false),
    [error, setError] = useState(""),
    [dismissing, setDismissing] = useState(false);
  const [busy, setBusy] = useState<"create" | "retry" | "status" | null>(null);
  const [recentPage, setRecentPage] = useState(1),
    [recentRevision, setRecentRevision] = useState(0);
  const [recent, setRecent] = useState<{
    path: string;
    data: PolicyRequestPage | null;
    error: string;
    loading: boolean;
  }>({ path: "", data: null, error: "", loading: false });
  const opener = useRef<HTMLElement | null>(null),
    receiptFocus = useRef<HTMLHeadingElement | null>(null);
  const active = useRef<{
      controller: AbortController;
      kind: "create" | "retry" | "status";
    } | null>(null),
    mounted = useRef(false);
  const createdHere = useRef<string | null>(null);
  const context = useRef({ id: user.id, role: user.role });
  context.current = { id: user.id, role: user.role };
  const allowed = () =>
    mounted.current &&
    context.current.id === user.id &&
    context.current.role === user.role &&
    can(user, "operate");
  const callbacks = useRef({ onCreated, onApply });
  callbacks.current = { onCreated, onApply };
  const hasReminders = operations.length > 0 || errors.length > 0;
  const available =
    !!selection.operation &&
    agentSettingsOperationAvailable(selection.operation);
  const recentPath = `/policies/requests?page=${recentPage}&page_size=12`;
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
  useEffect(() => {
    mounted.current = true;
    const guard = (event: Event) => {
      if (active.current && active.current.kind !== "status")
        event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (active.current && active.current.kind !== "status") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("vectory:before-navigate", guard);
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      window.removeEventListener("vectory:before-navigate", guard);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  useEffect(() => {
    if (found) receiptFocus.current?.focus();
  }, [found]);
  function open(next: Screen, target: HTMLElement) {
    if (active.current || !allowed()) return;
    opener.current = target;
    setError("");
    setDismissing(false);
    setFound(null);
    setChecked(false);
    if (next === "create") {
      const saved = readAgentSettingsOperations(user.id);
      if (saved.operations.length || saved.errors.length) {
        setScreen("local");
        return;
      }
    }
    if (next === "recent") setRecentPage(1);
    setScreen(next);
  }
  useImperativeHandle(ref, () => ({
    openCreate: (target, initial) => {
      if (initial && !active.current && allowed()) {
        setName(initial.name);
        setHeartbeat(String(initial.policy.heartbeat_seconds));
        setPaused(initial.policy.sync_paused);
        setTelemetry(initial.policy.telemetry_enabled);
      }
      open("create", target);
    },
    openRecent: (target) => open("recent", target),
    openSaved: (target) => open("local", target),
  }));
  function close() {
    if (active.current && active.current.kind !== "status") return;
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
  function choose(next: Selection) {
    if (active.current) return;
    setSelection(next);
    setFound(null);
    setChecked(false);
    setError("");
    setDismissing(false);
    setScreen("request");
  }
  function accept(receipt: PolicyCreateReceipt, selected: Selection) {
    assertAgentSettingsReceipt(
      selected.id!,
      receipt,
      selected.operation,
      selected.policyId,
    );
    if (!allowed()) return;
    let cleanup = "";
    try {
      if (selected.operation) finishAgentSettingsOperation(selected.operation);
      else if (selected.issue) dismissAgentSettingsStorageIssue(selected.issue);
    } catch {
      cleanup =
        "These agent settings are saved, but this browser could not clear its reminder. You can still use the confirmed settings. Dismiss the reminder again when browser storage is available.";
    }
    setFound(receipt);
    setError(cleanup);
    setChecked(false);
    if (selected.operation?.id === createdHere.current) {
      setName("");
      setHeartbeat("60");
      setPaused(false);
      setTelemetry(true);
      createdHere.current = null;
    }
    callbacks.current.onCreated(receipt);
  }
  function claim(kind: "create" | "retry" | "status") {
    if (active.current || !allowed()) return null;
    const value = { controller: new AbortController(), kind };
    active.current = value;
    setBusy(kind);
    setError("");
    return value;
  }
  function current(value: NonNullable<typeof active.current>) {
    return (
      allowed() && active.current === value && !value.controller.signal.aborted
    );
  }
  function settle(value: NonNullable<typeof active.current>) {
    if (active.current === value) {
      active.current = null;
      if (mounted.current) setBusy(null);
    }
  }
  async function lookup(id: string, signal: AbortSignal) {
    const value = await api(
      `/policies/requests/${id}`,
      { signal },
      PolicyRequestLookupSchema,
    );
    if (value.request_id !== id)
      throw Error(
        "The server did not identify this exact settings request. Update the server or check again before continuing.",
      );
    return value;
  }
  async function sendSaved(
    operation: AgentSettingsOperation,
    signal: AbortSignal,
  ) {
    // A peer may dismiss or repair the record during the capability read.
    if (!agentSettingsOperationAvailable(operation))
      throw Error(
        "This browser reminder changed or became unavailable. Check its status before continuing.",
      );
    return api(
      "/policies",
      { method: "POST", signal, body: JSON.stringify(operation.request) },
      PolicyCreateReceiptSchema,
    );
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    const value = claim("create");
    if (!value) return;
    let selected: Selection | undefined;
    try {
      const operation = beginAgentSettingsOperation(user.id, {
        name,
        policy: {
          heartbeat_seconds: Number(heartbeat),
          sync_paused: paused,
          telemetry_enabled: telemetry,
        },
      });
      createdHere.current = operation.id;
      selected = { id: operation.id, operation };
      setSelection(selected);
      setFound(null);
      setChecked(false);
      setScreen("request");
      const response = await withRequestDeadline(
        async (signal) => {
          const observed = await lookup(operation.id, signal);
          return observed.found
            ? observed.policy
            : sendSaved(operation, signal);
        },
        30000,
        value.controller.signal,
      );
      if (current(value)) accept(response, selected);
    } catch (failure) {
      if (current(value)) setError((failure as Error).message);
    } finally {
      settle(value);
    }
  }
  async function resolve(retry: boolean, selected = selection) {
    if (
      !selected.id ||
      (selected.operation && selected.operation.actor_id !== user.id)
    )
      return;
    if (
      retry &&
      (!checked ||
        !selected.operation ||
        !agentSettingsOperationAvailable(selected.operation))
    )
      return;
    const value = claim(retry ? "retry" : "status");
    if (!value) return;
    setChecked(false);
    try {
      const response = await withRequestDeadline(
        async (signal) => {
          const observed = await lookup(selected.id!, signal);
          if (observed.found) return observed.policy;
          if (retry) return sendSaved(selected.operation!, signal);
          return null;
        },
        30000,
        value.controller.signal,
      );
      if (!current(value)) return;
      if (response) accept(response, selected);
      else setChecked(true);
    } catch (failure) {
      if (current(value)) setError((failure as Error).message);
    } finally {
      settle(value);
    }
  }
  useEffect(() => {
    if (screen === "request" && selection.id) void resolve(false, selection);
  }, [screen, selection]);
  useEffect(() => {
    if (screen !== "recent") return;
    const controller = new AbortController();
    let live = true;
    setRecent({ path: recentPath, data: null, error: "", loading: true });
    void withRequestDeadline(
      (signal) => api(recentPath, { signal }, PolicyRequestPageSchema),
      30000,
      controller.signal,
    )
      .then((data) => {
        if (data.page !== recentPage || data.page_size !== 12)
          throw Error(
            "The server returned a different requests page. Refresh requests before continuing.",
          );
        if (live && allowed())
          setRecent({ path: recentPath, data, error: "", loading: false });
      })
      .catch((failure) => {
        if (live && allowed())
          setRecent({
            path: recentPath,
            data: null,
            error: (failure as Error).message,
            loading: false,
          });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [screen, recentPath, recentRevision]);
  function dismiss() {
    if (active.current || !allowed()) return;
    try {
      if (selection.operation)
        finishAgentSettingsOperation(selection.operation);
      else if (selection.issue)
        dismissAgentSettingsStorageIssue(selection.issue);
      close();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  const request = selection.operation?.request;
  const canDismiss =
    (!!selection.operation && (!found || available)) ||
    selection.issue?.kind === "corrupt";
  return (
    <>
      <div className="agent-settings-creation-bar">
        {hasReminders && (
          <div className="agent-settings-creation-notice" role="status">
            <CircleAlert size={17} aria-hidden="true" />
            <span>
              {errors.length
                ? "Saved settings requests need review."
                : `${operations.length} settings ${operations.length === 1 ? "request needs" : "requests need"} confirmation.`}
            </span>
            <Button
              variant="ghost compact"
              onClick={(event) => open("local", event.currentTarget)}
            >
              Review settings requests
            </Button>
          </div>
        )}
        <Button
          variant="ghost compact"
          icon={History}
          onClick={(event) => open("recent", event.currentTarget)}
        >
          Your settings requests
        </Button>
      </div>
      {screen && (
        <Modal
          open
          onClose={close}
          returnFocusRef={opener}
          wide={screen === "recent"}
          className="agent-settings-creation-modal"
          title={
            screen === "create"
              ? "New agent settings"
              : screen === "local"
                ? "Saved settings requests"
                : screen === "recent"
                  ? "Your settings requests"
                  : dismissing
                    ? "Dismiss this settings reminder?"
                    : found
                      ? "Agent settings saved"
                      : "Review settings request"
          }
          description={
            screen === "create"
              ? "Saving does not change any device until you apply these settings."
              : screen === "recent"
                ? "Find settings saved by your account, including requests from other tabs and devices."
                : screen === "local"
                  ? "Confirm saved requests before creating another set of agent settings."
                  : found
                    ? "Saved. No devices change until you apply these settings."
                    : "Check whether your settings were saved before trying again."
          }
        >
          {screen === "create" ? (
            <form onSubmit={create} className="agent-settings-create-form">
              <div className="modal-body">
                {error && <ErrorBox message={error} />}
                <Field label="Settings name">
                  <input
                    value={name}
                    required
                    onChange={(e) => setName(e.target.value)}
                    placeholder="For example, Production defaults"
                  />
                </Field>
                <Field
                  label="Check-in interval (seconds)"
                  hint="Between 10 and 3,600 seconds."
                >
                  <input
                    type="number"
                    min={10}
                    max={3600}
                    step={1}
                    required
                    value={heartbeat}
                    onChange={(e) => setHeartbeat(e.target.value)}
                  />
                </Field>
                <label className="toggle-row">
                  <span>
                    <strong>Pause configuration sync</strong>
                    <small>
                      Keep the current pipeline. Check-ins continue.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={paused}
                    onChange={(e) => setPaused(e.target.checked)}
                  />
                </label>
                <label className="toggle-row">
                  <span>
                    <strong>Collect operational metrics</strong>
                    <small>Throughput, errors and health when available.</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={telemetry}
                    onChange={(e) => setTelemetry(e.target.checked)}
                  />
                </label>
                {!paused && (
                  <p className="control-muted">
                    When applied, enabling sync replaces managed local edits
                    with the latest assigned pipeline.
                  </p>
                )}
              </div>
              <div className="modal-footer">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!!busy}
                  onClick={close}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  busy={busy === "create"}
                  disabled={!!busy}
                >
                  Save settings
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div className="modal-body agent-settings-creation-body">
                {screen === "local" && (
                  <>
                    {!hasReminders && (
                      <p>
                        There are no saved settings reminders in this browser.
                      </p>
                    )}
                    <div className="agent-settings-request-list">
                      {operations.map((operation) => (
                        <button
                          type="button"
                          key={operation.id}
                          onClick={() =>
                            choose({ id: operation.id, operation })
                          }
                        >
                          <span>
                            <strong>{operation.request.name}</strong>
                            <small>
                              {new Date(operation.recorded_at).toLocaleString()}
                            </small>
                          </span>
                          <ArrowRight size={16} aria-hidden="true" />
                        </button>
                      ))}
                      {errors.map((issue, index) => (
                        <div key={`${issue.id || issue.kind}:${index}`}>
                          <ErrorBox message={issue.message} />
                          {issue.kind === "corrupt" && (
                            <Button
                              variant="secondary"
                              onClick={() => choose({ id: issue.id, issue })}
                            >
                              Review unreadable reminder
                              {errors.length > 1 ? ` ${index + 1}` : ""}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                    {!!errors.length && (
                      <p>
                        Recent server requests can help find saved settings when
                        local data is unavailable. An absent result does not
                        prove a request failed.
                      </p>
                    )}
                  </>
                )}
                {screen === "recent" && (
                  <>
                    {recentVisible.error && (
                      <ErrorBox message={recentVisible.error} />
                    )}
                    <DataTable
                      label="Your settings requests"
                      data={
                        recentVisible.error
                          ? []
                          : recentVisible.data?.items || []
                      }
                      rowKey={(row) => row.request_id}
                      loading={recentVisible.loading || correcting}
                      columns={[
                        {
                          id: "settings",
                          header: "Settings",
                          sortable: false,
                          cell: (row) => (
                            <span className="agent-settings-request-name">
                              <strong>
                                {row.policy_name || "Settings name unavailable"}
                              </strong>
                              <small>{row.policy_id}</small>
                            </span>
                          ),
                        },
                        {
                          id: "saved",
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
                                  policyId: row.policy_id,
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
                      request may still be in flight. This list cannot
                      reconstruct an original request for retry.
                    </p>
                  </>
                )}
                {screen === "request" && (
                  <>
                    {error && <ErrorBox message={error} />}
                    {dismissing ? (
                      <p>
                        Dismissing removes only this browser reminder. It does
                        not cancel a request or delete saved settings. Check the
                        server result and recent requests before creating a
                        replacement.
                      </p>
                    ) : found ? (
                      <section
                        className="agent-settings-receipt"
                        aria-label="Saved agent settings"
                      >
                        <h3 ref={receiptFocus} tabIndex={-1}>
                          {found.name}
                        </h3>
                        <PolicyValues policy={found.policy} />
                        <details>
                          <summary>Settings details</summary>
                          <p>
                            Settings ID <code>{found.id}</code>
                          </p>
                          <p>
                            Saved {new Date(found.created_at).toLocaleString()}
                          </p>
                        </details>
                      </section>
                    ) : (
                      <>
                        <p role="status">
                          {busy === "status"
                            ? "Checking the exact request…"
                            : busy === "retry" || busy === "create"
                              ? "Saving the original settings request…"
                              : checked
                                ? "No completed request was found yet. It may still be in flight."
                                : "Check whether the server saved this request. A failed read does not mean saving failed."}
                        </p>
                        {request && (
                          <p>
                            Retry uses the original name, interval, sync and
                            metrics settings with the same request ID.
                          </p>
                        )}
                        {request && !available && (
                          <p>
                            This reminder changed or was dismissed in another
                            tab. Status lookup remains available; retry is
                            disabled.
                          </p>
                        )}
                      </>
                    )}
                    {selection.issue && (
                      <p className="control-muted">
                        The original request cannot be safely reconstructed from
                        this reminder. An exact result can be checked when its
                        request ID is available; retry is unavailable.
                      </p>
                    )}
                    {selection.id && (
                      <details className="agent-settings-request-identity">
                        <summary>Request details</summary>
                        <code>{selection.id}</code>
                      </details>
                    )}
                    {request && !found && (
                      <section
                        className="agent-settings-original"
                        aria-label="Original settings request"
                      >
                        <h3>Original request</h3>
                        <strong>{request.name}</strong>
                        <PolicyValues policy={request.policy} />
                      </section>
                    )}
                    {canDismiss && !dismissing && (
                      <button
                        type="button"
                        className="agent-settings-dismiss"
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
              <div className="modal-footer agent-settings-creation-footer">
                <Button
                  variant="secondary"
                  disabled={busy === "retry" || busy === "create"}
                  onClick={close}
                >
                  Close
                </Button>
                {screen === "local" && (
                  <>
                    <RefreshButton onClick={() => refreshStorage((v) => v + 1)}>
                      Refresh reminders
                    </RefreshButton>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setRecentPage(1);
                        setScreen("recent");
                      }}
                    >
                      Your settings requests
                    </Button>
                  </>
                )}
                {screen === "recent" && (
                  <RefreshButton
                    busy={recentVisible.loading}
                    onClick={() => setRecentRevision((v) => v + 1)}
                  >
                    Refresh requests
                  </RefreshButton>
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
                    onApply && (
                      <Button
                        icon={ArrowRight}
                        onClick={() => {
                          if (
                            !allowed() ||
                            callbacks.current.onApply?.(found) === false
                          )
                            return;
                          opener.current = null;
                          setScreen(null);
                        }}
                      >
                        Apply to devices
                      </Button>
                    )
                  ) : (
                    <>
                      {selection.id && (
                        <RefreshButton
                          busy={busy === "status"}
                          disabled={!!busy}
                          onClick={() => void resolve(false)}
                        >
                          Check status
                        </RefreshButton>
                      )}
                      {request && (
                        <Button
                          busy={busy === "retry" || busy === "create"}
                          disabled={!!busy || !checked || !available}
                          onClick={() => void resolve(true)}
                        >
                          Retry same request
                        </Button>
                      )}
                    </>
                  ))}
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
});
