import { useEffect, useRef, useState, type RefObject } from "react";
import { APIError, api, withRequestDeadline } from "./api";
import { Button, ErrorBox, Modal, RefreshButton, Spinner } from "./ui";
import { DataTable } from "./DataTable";
import {
  assertAssignmentRemovalPreview,
  assertAssignmentRemovalReceipt,
  assertAssignmentRemovalStatus,
  isAssignmentRemovalUncertain,
  setAssignmentRemovalUncertain,
  removalEffectLabel,
  removalStateLabel,
  type AssignmentRemovalPreview,
  type RemovalState,
} from "./assignmentRemovalModel";
import "./assignment-removal.css";

export type AssignmentRemovalProps = {
  deploymentId: string;
  actorId: string;
  allowed: boolean;
  open: boolean;
  onClose(): void;
  onDone(message: string): void;
  onCommittingChange?(busy: boolean): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

function StateDetail({
  state,
  resource,
}: {
  state: RemovalState | null;
  resource: AssignmentRemovalPreview["resource"];
}) {
  return (
    <div className="assignment-removal-state">
      <strong>{removalStateLabel(state, resource)}</strong>
      {state && (
        <>
          {resource === "configuration" &&
            state.version_id &&
            (state.configuration_name === null ||
              state.version_number === null) && (
              <code>Version {state.version_id}</code>
            )}
          {resource === "configuration" && state.assignment_name && (
            <span>{state.assignment_name}</span>
          )}
          {resource === "policy" && state.policy && (
            <span>
              Heartbeat every {state.policy.heartbeat_seconds}s · Telemetry{" "}
              {state.policy.telemetry_enabled ? "on" : "off"} · Sync{" "}
              {state.policy.sync_paused ? "paused" : "enabled"}
            </span>
          )}
        </>
      )}
    </div>
  );
}

export default function AssignmentRemoval({
  deploymentId,
  actorId,
  allowed,
  open,
  onClose,
  onDone,
  onCommittingChange,
  returnFocusRef,
}: AssignmentRemovalProps) {
  const [preview, setPreview] = useState<AssignmentRemovalPreview | null>(null);
  const [busy, setBusy] = useState<"review" | "commit" | "status" | null>(null);
  const [error, setError] = useState("");
  const [invalidated, setInvalidated] = useState(false);
  const [uncertain, setUncertain] = useState(() =>
    isAssignmentRemovalUncertain(actorId, deploymentId),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(1);
  const context = `${actorId}:${deploymentId}`;
  const current = useRef({ context, allowed, open });
  current.current = { context, allowed, open };
  const mounted = useRef(false),
    request = useRef<AbortController | null>(null),
    inFlight = useRef(false),
    phase = useRef<"review" | "commit" | "status" | null>(null);
  const uncertainRef = useRef(
      isAssignmentRemovalUncertain(actorId, deploymentId),
    ),
    invalidatedRef = useRef(false),
    confirmedRef = useRef(false);
  const callbacks = useRef({ onDone, onCommittingChange });
  callbacks.current = { onDone, onCommittingChange };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      callbacks.current.onCommittingChange?.(false);
    };
  }, []);

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    inFlight.current = false;
    phase.current = null;
    const unresolved = isAssignmentRemovalUncertain(actorId, deploymentId);
    uncertainRef.current = unresolved;
    invalidatedRef.current = false;
    confirmedRef.current = false;
    setPreview(null);
    setBusy(null);
    setError("");
    setMessage(
      unresolved
        ? "A previous removal request could not be confirmed. Check current status before making another change."
        : "",
    );
    setUncertain(unresolved);
    setInvalidated(false);
    setConfirmed(false);
    callbacks.current.onCommittingChange?.(false);
  }, [context]);

  useEffect(() => {
    if (!open || !allowed) {
      request.current?.abort();
      request.current = null;
      inFlight.current = false;
      phase.current = null;
      setBusy(null);
      callbacks.current.onCommittingChange?.(false);
      return;
    }
    if (!uncertainRef.current && !confirmedRef.current) void review();
    // A reopen is a new review, except an uncertain request must first be checked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, open, allowed]);

  function start(kind: "review" | "commit" | "status") {
    if (inFlight.current || !allowed || !open) return null;
    const controller = new AbortController();
    request.current = controller;
    inFlight.current = true;
    phase.current = kind;
    setBusy(kind);
    setError("");
    return controller;
  }
  function isCurrent(controller: AbortController, sentContext: string) {
    return (
      mounted.current &&
      !controller.signal.aborted &&
      request.current === controller &&
      current.current.context === sentContext &&
      current.current.allowed &&
      current.current.open
    );
  }
  function settled(controller: AbortController) {
    if (request.current !== controller) return;
    request.current = null;
    inFlight.current = false;
    phase.current = null;
    if (mounted.current) setBusy(null);
  }
  async function review() {
    if (uncertainRef.current || confirmedRef.current) return;
    const controller = start("review");
    if (!controller) return;
    const sentContext = context;
    setPreview(null);
    invalidatedRef.current = true;
    setInvalidated(true);
    setMessage("");
    setPage(1);
    try {
      const value = await withRequestDeadline(
        (signal) =>
          api(`/deployments/${deploymentId}/unassign-preview`, {
            method: "POST",
            body: "{}",
            signal,
          }),
        30000,
        controller.signal,
      );
      const result = assertAssignmentRemovalPreview(deploymentId, value);
      if (!isCurrent(controller, sentContext)) return;
      setPreview(result);
      invalidatedRef.current = false;
      setInvalidated(false);
    } catch (failure) {
      if (isCurrent(controller, sentContext))
        setError((failure as Error).message);
    } finally {
      settled(controller);
    }
  }
  async function commit() {
    if (
      !preview?.ready ||
      invalidatedRef.current ||
      uncertainRef.current ||
      confirmedRef.current
    )
      return;
    const controller = start("commit");
    if (!controller) return;
    const sentContext = context;
    // Once a send starts, closing/losing permission must not make it retryable.
    uncertainRef.current = true;
    setAssignmentRemovalUncertain(actorId, deploymentId, true);
    setUncertain(true);
    callbacks.current.onCommittingChange?.(true);
    try {
      const value = await withRequestDeadline(
        (signal) =>
          api(`/deployments/${deploymentId}/unassign`, {
            method: "POST",
            body: JSON.stringify({ review_token: preview.review_token }),
            signal,
          }),
        30000,
        controller.signal,
      );
      assertAssignmentRemovalReceipt(deploymentId, value);
      if (!isCurrent(controller, sentContext)) return;
      uncertainRef.current = false;
      setAssignmentRemovalUncertain(actorId, deploymentId, false);
      confirmedRef.current = true;
      setUncertain(false);
      setConfirmed(true);
      setMessage(
        "Assignment removed. Devices will reconcile the reviewed desired state; this does not stop Vector.",
      );
      callbacks.current.onDone(
        "Assignment removed. Device verification remains separate.",
      );
    } catch (failure) {
      if (!isCurrent(controller, sentContext)) return;
      invalidatedRef.current = true;
      setInvalidated(true);
      setError((failure as Error).message);
      if (
        failure instanceof APIError &&
        failure.serverRejection &&
        failure.status === 409 &&
        ["ASSIGNMENT_REMOVAL_REVIEW_CHANGED", "CONFLICT"].includes(failure.code)
      ) {
        uncertainRef.current = false;
        setAssignmentRemovalUncertain(actorId, deploymentId, false);
        setUncertain(false);
        setMessage(
          "The review is no longer current. Refresh review and confirm the new scope before making another change.",
        );
      } else {
        setMessage(
          "Removal could not be confirmed. Check current status before making another change. Nothing is resent automatically.",
        );
      }
    } finally {
      if (request.current === controller)
        callbacks.current.onCommittingChange?.(false);
      settled(controller);
    }
  }
  async function checkStatus() {
    const controller = start("status");
    if (!controller) return;
    const sentContext = context;
    try {
      const value = await withRequestDeadline(
        (signal) => api(`/deployments/${deploymentId}/summary`, { signal }),
        30000,
        controller.signal,
      );
      const result = assertAssignmentRemovalStatus(deploymentId, value);
      if (!isCurrent(controller, sentContext)) return;
      uncertainRef.current = false;
      setAssignmentRemovalUncertain(actorId, deploymentId, false);
      setUncertain(false);
      if (result.status === "unassigned") {
        confirmedRef.current = true;
        setConfirmed(true);
        setMessage(
          "Assignment is currently removed. This status does not establish which request removed it.",
        );
        callbacks.current.onDone("Assignment is currently removed.");
      } else {
        setPreview(null);
        invalidatedRef.current = true;
        setInvalidated(true);
        setMessage(
          `Current status: ${result.status.replaceAll("_", " ")}. Refresh review before deciding whether to remove this assignment.`,
        );
      }
    } catch (failure) {
      if (isCurrent(controller, sentContext))
        setError((failure as Error).message);
    } finally {
      settled(controller);
    }
  }
  function close() {
    if (phase.current === "commit") return;
    request.current?.abort();
    request.current = null;
    inFlight.current = false;
    phase.current = null;
    setBusy(null);
    onClose();
  }
  return (
    <Modal
      open={open}
      onClose={close}
      title={confirmed ? "Assignment removed" : "Remove assignment"}
      description="Review each device's desired state after removing this assignment. Device application and verification happen separately."
      wide
      className="assignment-removal-modal"
      returnFocusRef={returnFocusRef}
    >
      <div className="modal-body assignment-removal">
        {error && <ErrorBox message={error} />}
        {message && (
          <p className="assignment-removal-notice" role="status">
            {message}
          </p>
        )}
        {!allowed && (
          <p className="control-muted">
            You no longer have permission to remove this assignment.
          </p>
        )}
        {busy === "review" && (
          <p className="assignment-removal-loading" role="status">
            <Spinner /> Reviewing assignment removal…
          </p>
        )}
        {busy === "status" && (
          <p className="assignment-removal-loading" role="status">
            <Spinner /> Checking current status…
          </p>
        )}
        {busy === "commit" && (
          <p className="assignment-removal-loading" role="status">
            <Spinner /> Removing assignment…
          </p>
        )}
        {preview && !confirmed && (
          <>
            <div className="assignment-removal-heading">
              <h3>
                {preview.devices.length} reviewed{" "}
                {preview.devices.length === 1 ? "device" : "devices"}
              </h3>
              <span>
                {preview.resource === "configuration"
                  ? "Pipeline configuration"
                  : "Agent policy"}
              </span>
            </div>
            <p className="control-muted">
              {preview.resource === "configuration"
                ? "Devices without another effective assignment keep their last working configuration locally. Removing an assignment does not stop Vector."
                : "Devices without another effective policy assignment return to the default agent policy. A host-owned local pause remains in effect."}
            </p>
            {invalidated && !uncertain && (
              <p className="assignment-removal-notice" role="status">
                Refresh review before confirming again.
              </p>
            )}
            {preview.blockers.length > 0 && (
              <div className="assignment-removal-notice" role="status">
                <strong>Removal is not ready</strong>
                <ul>
                  {preview.blockers.map((blocker, index) => (
                    <li key={`${blocker.code}-${index}`}>{blocker.reason}</li>
                  ))}
                </ul>
              </div>
            )}
            <DataTable
              data={preview.devices}
              rowKey={(device) => device.device_id}
              label="Affected devices"
              pagination={{ page, size: 8, onPage: setPage }}
              columns={[
                {
                  id: "device",
                  header: "Device",
                  value: (device) => device.device_name || device.device_id,
                  filter: { placeholder: "Find a reviewed device" },
                  cell: (device) => (
                    <span className="assignment-removal-device">
                      <strong title={device.device_id}>
                        {device.device_name ||
                          `Unnamed device ${device.device_id.slice(0, 8)}`}
                      </strong>
                    </span>
                  ),
                },
                {
                  id: "before",
                  header: "Current desired state",
                  className: "assignment-removal-current-column",
                  cell: (device) => (
                    <StateDetail
                      state={device.before}
                      resource={preview.resource}
                    />
                  ),
                },
                {
                  id: "after",
                  header: "After removal",
                  value: (device) =>
                    removalEffectLabel(device, preview.resource),
                  cell: (device) => (
                    <div className="assignment-removal-effect">
                      <div className="assignment-removal-mobile-current">
                        <span>Current desired state</span>
                        <StateDetail
                          state={device.before}
                          resource={preview.resource}
                        />
                      </div>
                      <span className="assignment-removal-mobile-after">
                        After removal
                      </span>
                      <strong>
                        {removalEffectLabel(device, preview.resource)}
                      </strong>
                      {/* The label names a pipeline version; settings and
                          an unnamed version say more, and a switch names the
                          assignment it switches to. */}
                      {preview.resource === "policy" ||
                      (device.after?.version_id &&
                        (device.after.configuration_name === null ||
                          device.after.version_number === null)) ? (
                        <StateDetail
                          state={device.after}
                          resource={preview.resource}
                        />
                      ) : (
                        device.effect === "fallback" &&
                        device.after?.assignment_name && (
                          <div className="assignment-removal-state">
                            <span>{device.after.assignment_name}</span>
                          </div>
                        )
                      )}
                      {device.effect === "not_targeted" && (
                        <p>No longer targeted by this assignment.</p>
                      )}
                      {device.effect === "retained_pending" &&
                        device.pending_assignment_id && (
                          <p>
                            {device.pending_assignment_name
                              ? `Waiting for ${device.pending_assignment_name}. `
                              : ""}
                            The next assignment hasn't been released to this
                            device yet.
                          </p>
                        )}
                    </div>
                  ),
                },
              ]}
              empty="No reviewed devices match these filters."
            />
            <p className="control-muted assignment-removal-filter-note">
              Filters only change this view. All {preview.devices.length}{" "}
              reviewed devices remain included.
            </p>
          </>
        )}
      </div>
      <div className="modal-footer">
        <Button
          variant="secondary"
          disabled={busy === "commit"}
          onClick={close}
        >
          {confirmed ? "Close" : "Cancel"}
        </Button>
        {!confirmed &&
          allowed &&
          (uncertain && busy !== "commit" ? (
            <RefreshButton
              busy={busy === "status"}
              disabled={!!busy}
              onClick={() => void checkStatus()}
            >
              Check current status
            </RefreshButton>
          ) : (
            <>
              <RefreshButton
                busy={busy === "review"}
                disabled={!!busy}
                onClick={() => void review()}
              >
                Refresh review
              </RefreshButton>
              <Button
                variant="danger"
                busy={busy === "commit"}
                disabled={!!busy || !preview?.ready || invalidated}
                onClick={() => void commit()}
              >
                Remove assignment
              </Button>
            </>
          ))}
      </div>
    </Modal>
  );
}
