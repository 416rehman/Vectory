import { useEffect, useRef, useState } from "react";
import {
  api,
  APIError,
  withRequestDeadline,
  type DeploymentReceipt,
} from "./api";
import { assertDeploymentLookupById } from "./deploymentReceipt";
import {
  dismissDeploymentStorageIssue,
  readDeploymentRegistry,
  type DeploymentStorageIssue,
} from "./deploymentRequests";
import { deploymentRoute, isDeploymentId } from "./deploymentRouting";
import { Button, ErrorBox, Modal } from "./ui";
import "./deployment-storage-recovery.css";

type ViewState = {
  issue: DeploymentStorageIssue;
  found: DeploymentReceipt | null;
  error: string;
  checked: boolean;
  busy: boolean;
  dismissing: boolean;
  cleared: boolean;
  storageMessage: string | null;
};
const initialState = (issue: DeploymentStorageIssue): ViewState => ({
  issue,
  found: null,
  error: "",
  checked: false,
  busy: false,
  dismissing: false,
  cleared: false,
  storageMessage: null,
});

/** An unreadable reminder permits exact-key reads, never reconstructed retries. */
export function DeploymentStorageRecoveryDialog({
  issue,
  userId,
  allowed = true,
  onClose,
  onRecovered,
  returnFocusRef,
}: {
  issue: DeploymentStorageIssue;
  userId: string;
  allowed?: boolean;
  onClose(): void;
  onRecovered?(message: string): void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState(() => initialState(issue));
  const current = useRef({ issue, userId, allowed });
  current.current = { issue, userId, allowed };
  const mounted = useRef(false);
  const active = useRef<{
    issue: DeploymentStorageIssue;
    controller: AbortController;
  } | null>(null);
  const resultLink = useRef<HTMLAnchorElement>(null);
  const view = state.issue === issue ? state : initialState(issue);
  const authorized = allowed && issue.actor_id === userId;
  const lookupId =
    issue.kind === "corrupt" && issue.id && isDeploymentId(issue.id)
      ? issue.id
      : null;

  function isCurrent(selected: DeploymentStorageIssue) {
    const context = current.current;
    return (
      mounted.current &&
      context.issue === selected &&
      context.allowed &&
      context.userId === selected.actor_id
    );
  }
  function abortRead() {
    const request = active.current;
    active.current = null;
    request?.controller.abort();
  }
  function close() {
    abortRead();
    onClose();
  }
  async function checkStatus() {
    if (active.current || !lookupId || !isCurrent(issue)) return;
    const selected = issue;
    const claim = { issue: selected, controller: new AbortController() };
    active.current = claim;
    setState({ ...initialState(selected), busy: true });
    try {
      const value = await withRequestDeadline(
        (signal) =>
          api<unknown>(
            `/deployments/requests/${encodeURIComponent(lookupId)}`,
            {
              signal,
            },
          ),
        30000,
        claim.controller.signal,
      );
      if (!isCurrent(selected) || active.current !== claim) return;
      const response = assertDeploymentLookupById(lookupId, value);
      if (!response.found) {
        setState({ ...initialState(selected), checked: true });
        return;
      }
      let cleanupError = "";
      let cleared = false;
      try {
        // The registry compares the exact captured bytes. A peer's repaired
        // or replaced reminder must survive even a valid old lookup result.
        dismissDeploymentStorageIssue(selected);
        cleared = true;
      } catch (failure) {
        cleanupError =
          "The request is confirmed, but its browser reminder could not be cleared. " +
          (failure as Error).message;
      }
      if (!isCurrent(selected) || active.current !== claim) return;
      setState({
        ...initialState(selected),
        found: response.deployment,
        error: cleanupError,
        cleared,
      });
      onRecovered?.(
        response.operation === "rollback"
          ? "Rollback confirmed. Open its deployment to see device results."
          : "Deployment confirmed. Open its progress to see device results.",
      );
    } catch (failure) {
      if (isCurrent(selected) && active.current === claim)
        setState({
          ...initialState(selected),
          error:
            failure instanceof APIError && failure.code === "CONTRACT_MISMATCH"
              ? "The server could not confirm this request's identity. The reminder is still saved. Update the server or review deployment history before trying again."
              : (failure as Error).message,
        });
    } finally {
      if (active.current === claim) {
        active.current = null;
        if (isCurrent(selected))
          setState((previous) => ({ ...previous, busy: false }));
      }
    }
  }
  function dismiss() {
    if (active.current || !isCurrent(issue) || issue.kind !== "corrupt") return;
    try {
      dismissDeploymentStorageIssue(issue);
      close();
    } catch (failure) {
      setState((previous) => ({
        ...previous,
        error: (failure as Error).message,
      }));
    }
  }
  function refreshReminders() {
    if (active.current || !isCurrent(issue)) return;
    const registry = readDeploymentRegistry(userId);
    const message = registry.errors.length
      ? registry.errors.map((problem) => problem.message).join(" ")
      : registry.operations.length
        ? `Browser storage is available. ${registry.operations.length} saved ${registry.operations.length === 1 ? "request still needs" : "requests still need"} confirmation. Close this dialog to review them.`
        : "Browser storage is available. No saved deployment reminders need review.";
    setState((previous) => ({
      ...previous,
      storageMessage: message,
      error: "",
    }));
  }
  useEffect(() => {
    mounted.current = true;
    setState(initialState(issue));
    if (authorized && lookupId) void checkStatus();
    return () => {
      mounted.current = false;
      abortRead();
    };
  }, [issue, userId, allowed]);
  useEffect(() => {
    if (view.found) resultLink.current?.focus();
  }, [view.found]);

  if (!authorized) return null;
  const resultRoute = view.found
    ? deploymentRoute(!!view.found.scheduled_at, view.found.id, {
        search: "",
        status: "all",
        page: 1,
      })
    : null;
  return (
    <Modal
      open
      className="deployment-storage-modal"
      returnFocusRef={returnFocusRef}
      onClose={close}
      title={
        view.dismissing
          ? "Dismiss this reminder?"
          : view.found
            ? view.found.operation === "rollback"
              ? "Rollback confirmed"
              : "Deployment confirmed"
            : "Review saved deployment reminder"
      }
      description={
        view.found
          ? "The server confirmed the saved request. Device application is reported separately."
          : "Review the server result before starting another request. This reminder cannot be retried."
      }
    >
      <div className="modal-body deployment-storage-body">
        {view.dismissing ? (
          <p className="deployment-storage-warning">
            Dismissing removes only this browser reminder. It does not cancel an
            in-flight request or delete a deployment. Review deployment history
            before starting a replacement.
          </p>
        ) : view.found ? (
          <section
            className="deployment-storage-result"
            aria-label="Confirmed deployment"
          >
            <h3>{view.found.name || "Saved deployment"}</h3>
            <p>
              This is the original request’s current result. Its status and
              targets may have changed since it was saved.
            </p>
            <dl>
              <div>
                <dt>Request</dt>
                <dd>
                  {view.found.operation === "rollback"
                    ? "Rollback"
                    : "Deployment"}
                </dd>
              </div>
              <div>
                <dt>Current status</dt>
                <dd className="deployment-storage-status">
                  {view.found.status.replaceAll("_", " ")}
                </dd>
              </div>
              <div>
                <dt>Deployment ID</dt>
                <dd>
                  <code>{view.found.id}</code>
                </dd>
              </div>
            </dl>
            <a ref={resultLink} href={`#/${resultRoute}`}>
              Open deployment
            </a>
          </section>
        ) : (
          <>
            <p role={view.storageMessage ? "status" : undefined}>
              {view.storageMessage || issue.message}
            </p>
            {view.busy ? (
              <p role="status">Checking the saved request…</p>
            ) : view.checked ? (
              <p role="status">
                No committed result was found yet. An earlier request may still
                be in flight. Keep this reminder and check again.
              </p>
            ) : null}
            {issue.kind === "corrupt" && (
              <p>
                {lookupId
                  ? "The original request cannot be safely reconstructed. Its request ID can only be used to check the saved result."
                  : "This reminder has no usable request ID. Review deployment history before dismissing it or starting another request."}
              </p>
            )}
          </>
        )}
        {view.error && <ErrorBox message={view.error} />}
        {lookupId && (
          <p className="deployment-storage-id">
            Request ID <code>{lookupId}</code>
          </p>
        )}
        <div className="deployment-storage-links">
          <a href="#/deployments">View deployment history</a>
          {issue.kind === "corrupt" && !view.cleared && !view.dismissing && (
            <button
              type="button"
              disabled={view.busy}
              onClick={() =>
                setState((previous) => ({ ...previous, dismissing: true }))
              }
            >
              Dismiss reminder
            </button>
          )}
        </div>
      </div>
      <div className="modal-footer deployment-storage-footer">
        {view.dismissing ? (
          <>
            <Button
              variant="secondary"
              onClick={() =>
                setState((previous) => ({ ...previous, dismissing: false }))
              }
            >
              Back
            </Button>
            <Button onClick={dismiss}>Dismiss reminder</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
            {!view.found && lookupId && (
              <Button
                busy={view.busy}
                disabled={view.busy}
                onClick={() => void checkStatus()}
              >
                Check status
              </Button>
            )}
            {issue.kind !== "corrupt" && (
              <Button onClick={refreshReminders}>Refresh reminders</Button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
