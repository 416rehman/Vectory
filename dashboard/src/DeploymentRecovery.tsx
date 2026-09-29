import { useEffect, useRef, useState } from "react";
import { ArrowRight, CircleAlert } from "lucide-react";
import {
  boundedAPI as api,
  APIError,
  can,
  boundedPost as post,
  type Deployment,
  type DeploymentReceipt,
  type User,
} from "./api";
import { deploymentRoute } from "./deploymentRouting";
import {
  assertDeploymentLookup,
  assertDeploymentReceipt,
} from "./deploymentReceipt";
import {
  deploymentOperationAvailable,
  finishDeploymentOperation,
  isDeploymentRequestActive,
  releaseDeploymentRequestLeases,
  deploymentOperationPath,
  setDeploymentRequestActive,
  useDeploymentOperation,
  type DeploymentOperation,
  type DeploymentStorageIssue,
} from "./deploymentRequests";
import { DeploymentStorageRecoveryDialog } from "./DeploymentStorageRecovery";
import { Button, ErrorBox, Modal } from "./ui";
import "./deployment-recovery.css";

export function DeploymentRecoveryDialog({
  operation,
  userId,
  allowed = true,
  onClose,
  onRecovered,
  confirmed,
  initialError,
  returnFocusRef,
}: {
  operation: DeploymentOperation;
  userId: string;
  allowed?: boolean;
  onClose(): void;
  onRecovered?(message: string): void;
  confirmed?: Deployment;
  initialError?: string;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const [initialReceipt] = useState(() => {
    if (!confirmed) return { value: null, error: "" };
    try {
      return {
        value: assertDeploymentReceipt(operation, confirmed),
        error: "",
      };
    } catch (failure) {
      return { value: null, error: (failure as Error).message };
    }
  });
  const [requestKind, setRequestKind] = useState<"status" | "retry" | null>(
      null,
    ),
    [error, setError] = useState(initialReceipt.error),
    [found, setFound] = useState<DeploymentReceipt | null>(
      initialReceipt.value,
    ),
    [checked, setChecked] = useState(false),
    [dismissing, setDismissing] = useState(false);
  const busy = requestKind !== null;
  useDeploymentOperation(userId);
  const reminderAvailable = deploymentOperationAvailable(operation);
  const inFlight = useRef(false),
    mounted = useRef(true),
    currentActor = useRef(userId),
    currentAllowed = useRef(allowed),
    recoveredLink = useRef<HTMLAnchorElement>(null);
  currentActor.current = userId;
  currentAllowed.current = allowed;
  const sameActor = userId === operation.actor_id;
  const activeElsewhere =
    isDeploymentRequestActive(operation) && !inFlight.current;
  useEffect(() => {
    mounted.current = true;
    const navigate = (event: Event) => {
      if (inFlight.current) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (inFlight.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("vectory:before-navigate", navigate);
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      window.removeEventListener("vectory:before-navigate", navigate);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  useEffect(() => {
    if (found) recoveredLink.current?.focus();
  }, [found]);
  function current() {
    return (
      mounted.current &&
      currentAllowed.current &&
      currentActor.current === operation.actor_id
    );
  }
  function accept(value: unknown) {
    if (!current()) return;
    const receipt = assertDeploymentReceipt(operation, value);
    let reminderError = "";
    try {
      finishDeploymentOperation(operation);
    } catch {
      reminderError =
        "The request is confirmed, but this browser could not clear its recovery reminder. The saved deployment is still available below.";
    }
    if (!mounted.current) return;
    setFound(receipt);
    setError(reminderError);
    onRecovered?.(
      operation.kind === "rollback"
        ? "Rollback confirmed. Open its deployment to see device results."
        : "Deployment confirmed. Open its progress to see device results.",
    );
  }
  async function resolve(retry: boolean) {
    if (
      inFlight.current ||
      !sameActor ||
      !allowed ||
      activeElsewhere ||
      !operation.retry_supported ||
      (retry && (!checked || !reminderAvailable))
    )
      return;
    if (reminderAvailable && !setDeploymentRequestActive(operation, true))
      return;
    inFlight.current = true;
    setRequestKind(retry ? "retry" : "status");
    setError("");
    setChecked(false);
    try {
      if (retry)
        accept(
          await post<unknown>(
            deploymentOperationPath(operation),
            operation.request,
          ),
        );
      else {
        const value = await api<unknown>(
          `/deployments/requests/${operation.id}`,
        );
        if (!current()) return;
        const response = assertDeploymentLookup(operation, value);
        if (response.found) accept(response.deployment);
        else setChecked(true);
      }
    } catch (failure) {
      if (current())
        setError(
          failure instanceof APIError && failure.code === "CONTRACT_MISMATCH"
            ? "The server could not confirm this request's identity. Your reminder is still saved. Update the server or check deployment history before trying again."
            : (failure as Error).message,
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setRequestKind(null);
      setDeploymentRequestActive(operation, false);
    }
  }
  useEffect(() => {
    if (
      !initialReceipt.value &&
      sameActor &&
      allowed &&
      operation.retry_supported
    )
      void resolve(false);
  }, [operation.id, userId, allowed]);
  if (!sameActor || !allowed) return null;
  const rollback = operation.kind === "rollback";
  const scheduledAt =
    operation.kind === "create" ? operation.request.scheduled_at : null;
  const scheduled = !!scheduledAt;
  const route = deploymentRoute(scheduled, found?.id || null, {
    search: "",
    status: "all",
    page: 1,
  });
  return (
    <Modal
      open
      returnFocusRef={returnFocusRef}
      title={
        found
          ? rollback
            ? "Rollback confirmed"
            : "Deployment confirmed"
          : dismissing
            ? "Dismiss this reminder?"
            : rollback
              ? "Confirm rollback"
              : "Confirm deployment"
      }
      description={
        found
          ? "The original request is saved. This confirmation does not mean devices have applied it."
          : "Check whether the original request was saved before sending another."
      }
      onClose={() => {
        if (!inFlight.current) onClose();
      }}
    >
      <div className="modal-body deployment-recovery-body">
        <strong>{operation.label}</strong>
        {operation.kind === "create" ? (
          <p>
            {operation.request.expected_device_ids.length} devices · Priority{" "}
            {operation.request.priority}
          </p>
        ) : operation.review ? (
          <p>
            {operation.review.configuration_name || "Previous pipeline"}
            {operation.review.version_number !== null &&
              ` · Version ${operation.review.version_number}`}
            <br />
            {(operation.review.configuration_name === null ||
              operation.review.version_number === null) && (
              <>
                Version ID <code>{operation.review.version_id}</code>
                <br />
              </>
            )}
            {operation.review.device_ids.length} reviewed devices ·{" "}
            {operation.review.excluded_count} excluded. Recovery keeps the
            original reviewed scope.
          </p>
        ) : (
          <p>
            Restores the previously managed version using the original request’s
            scope.
          </p>
        )}
        {scheduled && (
          <p>Scheduled for {new Date(scheduledAt!).toLocaleString()}</p>
        )}
        {!found && initialError && initialError !== error && (
          <p>
            <strong>Previous attempt: </strong>
            {initialError}
          </p>
        )}
        {error && <ErrorBox message={error} />}
        {!found && activeElsewhere && (
          <p role="status">
            Another tab may still be checking or sending this request. Its
            reminder updates when that activity ends.
          </p>
        )}
        {!found && !busy && !reminderAvailable && (
          <p role="status">
            This reminder can no longer be retried safely from this tab. Check
            its status or deployment history before starting another request.
          </p>
        )}
        {dismissing ? (
          <p>
            Dismissing only removes this browser reminder. It does not cancel
            the request. Check deployment history before creating a replacement.
          </p>
        ) : (
          !found && (
            <>
              {operation.retry_supported ? (
                <p>
                  {checked
                    ? "No completed request was found yet. It may still be in flight. "
                    : "Check the request status to enable a safe retry. "}
                  Retrying sends the same reviewed request. The server uses its
                  saved request identity to prevent a second deployment.
                </p>
              ) : (
                <p>
                  This server cannot safely retry a request after a lost
                  response. Check deployment history before creating another.
                </p>
              )}
              <div className="deployment-recovery-links">
                <a
                  href={`#/${route}`}
                  aria-disabled={busy || undefined}
                  onClick={(event) => {
                    if (inFlight.current) event.preventDefault();
                  }}
                >
                  View deployment history
                </a>
                <button
                  type="button"
                  disabled={busy || activeElsewhere}
                  onClick={() => setDismissing(true)}
                >
                  Dismiss reminder
                </button>
              </div>
            </>
          )
        )}
      </div>
      <div className="modal-footer deployment-recovery-footer">
        {dismissing ? (
          <>
            <Button variant="secondary" onClick={() => setDismissing(false)}>
              Back
            </Button>
            <Button
              onClick={() => {
                try {
                  finishDeploymentOperation(operation);
                  onClose();
                } catch {
                  setError(
                    "This browser could not remove the reminder. It is still saved; try again after browser storage is available.",
                  );
                }
              }}
            >
              I’ve checked history
            </Button>
          </>
        ) : found ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <a ref={recoveredLink} className="button" href={`#/${route}`}>
              {rollback
                ? "View rollback deployment"
                : scheduled
                  ? "View schedule"
                  : "View deployment"}
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Close
            </Button>
            {operation.retry_supported && (
              <>
                <Button
                  variant="secondary"
                  busy={requestKind === "status"}
                  disabled={busy || activeElsewhere}
                  onClick={() => void resolve(false)}
                >
                  Check status
                </Button>
                <Button
                  busy={requestKind === "retry"}
                  disabled={
                    busy ||
                    activeElsewhere ||
                    !allowed ||
                    !checked ||
                    !reminderAvailable
                  }
                  onClick={() => void resolve(true)}
                >
                  Retry same request
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export default function DeploymentRecoveryCenter({
  user,
  notify,
}: {
  user: User;
  notify(message: string): void;
}) {
  const { pendingOperations, errors, refresh } = useDeploymentOperation(
    user.id,
  );
  useEffect(() => () => releaseDeploymentRequestLeases(user.id), [user.id]);
  const [opened, setOpened] = useState<DeploymentOperation | null>(null);
  const [openedIssue, setOpenedIssue] = useState<DeploymentStorageIssue | null>(
    null,
  );
  const [choosing, setChoosing] = useState(false);
  const chooserOpener = useRef<HTMLElement | null>(null);
  const recoveryOpener = useRef<HTMLElement | null>(null);
  const operation = pendingOperations[0];
  const multiple = pendingOperations.length > 1;
  const visible = opened?.actor_id === user.id ? opened : null;
  const visibleIssue = openedIssue?.actor_id === user.id ? openedIssue : null;
  useEffect(() => {
    if (
      choosing &&
      !visible &&
      !visibleIssue &&
      !pendingOperations.length &&
      !errors.length
    ) {
      if (!chooserOpener.current?.isConnected)
        chooserOpener.current = document.getElementById("main-content");
      setChoosing(false);
    }
  }, [
    choosing,
    visible,
    visibleIssue,
    pendingOperations.length,
    errors.length,
  ]);
  if (!can(user, "operate")) return null;
  return (
    <>
      {(operation || errors.length > 0) && (
        <div className="deployment-recovery-notice" role="status">
          <CircleAlert size={17} aria-hidden="true" />
          <span>
            {errors.length
              ? "Saved deployment requests need review."
              : multiple
                ? `${pendingOperations.length} requests need confirmation.`
                : operation?.kind === "rollback"
                  ? "A rollback request needs confirmation."
                  : "A deployment request needs confirmation."}
          </span>
          <Button
            variant="ghost"
            onClick={(event) => {
              chooserOpener.current = event.currentTarget;
              recoveryOpener.current = event.currentTarget;
              if (multiple || errors.length) setChoosing(true);
              else setOpened(operation);
            }}
          >
            {multiple || errors.length
              ? "Review requests"
              : operation?.kind === "rollback"
                ? "Confirm rollback"
                : "Confirm deployment"}
          </Button>
        </div>
      )}
      {choosing && !visible && !visibleIssue && (
        <Modal
          open
          title="Requests needing confirmation"
          description="Review saved requests and unreadable reminders before sending another deployment or rollback."
          onClose={() => setChoosing(false)}
          returnFocusRef={chooserOpener}
        >
          <div className="modal-body deployment-recovery-list">
            {pendingOperations.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  chooserOpener.current = null;
                  setChoosing(false);
                  setOpened(item);
                }}
              >
                <span>
                  <strong>{item.label}</strong>
                  <small>
                    {item.kind === "rollback" ? "Rollback" : "Deployment"} ·{" "}
                    {new Date(item.recorded_at).toLocaleString()}
                  </small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            ))}
            {errors.map((issue, index) => (
              <div
                className="deployment-recovery-storage-issue"
                key={`${issue.kind}-${issue.id || index}`}
              >
                <ErrorBox message={issue.message} />
                {issue.kind === "corrupt" ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      chooserOpener.current = null;
                      setChoosing(false);
                      setOpenedIssue(issue);
                    }}
                  >
                    Review unreadable reminder
                  </Button>
                ) : (
                  <div className="deployment-recovery-links">
                    <Button variant="secondary" onClick={refresh}>
                      Refresh reminders
                    </Button>
                    <a href="#/deployments?page=1">View deployment history</a>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={() => setChoosing(false)}>
              Close
            </Button>
          </div>
        </Modal>
      )}
      {visible && (
        <DeploymentRecoveryDialog
          operation={visible}
          userId={user.id}
          allowed={can(user, "operate")}
          returnFocusRef={recoveryOpener}
          onClose={() => {
            if (!recoveryOpener.current?.isConnected)
              recoveryOpener.current = document.getElementById("main-content");
            setOpened(null);
          }}
          onRecovered={notify}
        />
      )}
      {visibleIssue && (
        <DeploymentStorageRecoveryDialog
          issue={visibleIssue}
          userId={user.id}
          allowed={can(user, "operate")}
          returnFocusRef={recoveryOpener}
          onClose={() => {
            if (!recoveryOpener.current?.isConnected)
              recoveryOpener.current = document.getElementById("main-content");
            setOpenedIssue(null);
          }}
          onRecovered={notify}
        />
      )}
    </>
  );
}
