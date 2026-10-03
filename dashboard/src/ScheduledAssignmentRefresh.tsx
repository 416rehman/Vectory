import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { APIError, api, withRequestDeadline } from "./api";
import { Button, ErrorBox, Modal, RefreshButton, Spinner } from "./ui";
import { DataTable } from "./DataTable";
import { namedDevices } from "./deploymentReviewModel";
import {
  assertScheduledAssignmentRefreshPreview,
  assertScheduledAssignmentRefreshReceipt,
  assertScheduledAssignmentRefreshStatus,
  getScheduleRefreshUncertainty,
  reviewedDeviceName,
  setScheduleRefreshUncertainty,
  sameScheduleSelection,
  scheduleSelectionRows,
  type ScheduledAssignmentRefreshPreview,
} from "./scheduledAssignmentRefreshModel";
import "./scheduled-assignment-refresh.css";

export type ScheduledAssignmentRefreshProps = {
  deploymentId: string;
  actorId: string;
  allowed: boolean;
  open: boolean;
  onClose(): void;
  onDone(message: string): void;
  onCommittingChange?(busy: boolean): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/** Why the selection cannot be updated, with the blocked devices by name. */
function Blockers({ preview }: { preview: ScheduledAssignmentRefreshPreview }) {
  const nameOf = useMemo(() => reviewedDeviceName(preview), [preview]);
  return (
    <div className="scheduled-refresh-notice" role="status">
      <strong>Selection cannot be updated</strong>
      <ul>
        {preview.blockers.map((blocker, index) => (
          <li key={`${blocker.code}-${index}`}>
            {blocker.reason}
            {!!blocker.device_ids?.length && (
              <span className="scheduled-refresh-blocked">
                {blocker.device_ids.length.toLocaleString()} affected{" "}
                {blocker.device_ids.length === 1 ? "device" : "devices"}:{" "}
                {namedDevices(blocker.device_ids, nameOf)}.
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ScheduledAssignmentRefresh({
  deploymentId,
  actorId,
  allowed,
  open,
  onClose,
  onDone,
  onCommittingChange,
  returnFocusRef,
}: ScheduledAssignmentRefreshProps) {
  const [preview, setPreview] =
    useState<ScheduledAssignmentRefreshPreview | null>(null);
  const [busy, setBusy] = useState<"review" | "commit" | "status" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const [result, setResult] = useState<"saved" | "observed" | null>(null);
  const [inactiveStatus, setInactiveStatus] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(
    () => !!getScheduleRefreshUncertainty(actorId, deploymentId),
  );
  const [page, setPage] = useState(1);
  const context = `${actorId}:${deploymentId}`;
  const current = useRef({ context, allowed, open });
  current.current = { context, allowed, open };
  const mounted = useRef(false),
    request = useRef<AbortController | null>(null),
    phase = useRef<"review" | "commit" | "status" | null>(null);
  const pending = useRef(getScheduleRefreshUncertainty(actorId, deploymentId));
  const invalidated = useRef(false);
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
    phase.current = null;
    pending.current = getScheduleRefreshUncertainty(actorId, deploymentId);
    invalidated.current = false;
    setUncertain(!!pending.current);
    setPreview(null);
    setBusy(null);
    setError("");
    setMessage(
      pending.current
        ? "A previous update could not be confirmed. Check current selection before making another change."
        : "",
    );
    setNeedsReview(false);
    setResult(null);
    setInactiveStatus(null);
    callbacks.current.onCommittingChange?.(false);
  }, [context]);
  useEffect(() => {
    if (!open || !allowed) {
      request.current?.abort();
      request.current = null;
      phase.current = null;
      setBusy(null);
      callbacks.current.onCommittingChange?.(false);
      return;
    }
    if (!pending.current) void review();
    // Reopening begins a fresh review unless a sent update remains uncertain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, open, allowed]);
  function start(kind: "review" | "commit" | "status") {
    if (request.current || !allowed || !open) return null;
    const controller = new AbortController();
    request.current = controller;
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
    phase.current = null;
    if (mounted.current) setBusy(null);
  }
  function clearUncertainty() {
    pending.current = null;
    setUncertain(false);
    setScheduleRefreshUncertainty(actorId, deploymentId, null);
  }
  async function fetchReview(signal: AbortSignal) {
    const value = await api(`/deployments/${deploymentId}/refresh-preview`, {
      method: "POST",
      body: "{}",
      signal,
    });
    return assertScheduledAssignmentRefreshPreview(deploymentId, value);
  }
  async function review() {
    if (pending.current) return;
    const controller = start("review");
    if (!controller) return;
    const sentContext = context;
    invalidated.current = true;
    setNeedsReview(true);
    setPreview(null);
    setResult(null);
    setInactiveStatus(null);
    setMessage("");
    setPage(1);
    try {
      const value = await withRequestDeadline(
        fetchReview,
        30000,
        controller.signal,
      );
      if (!isCurrent(controller, sentContext)) return;
      setPreview(value);
      invalidated.current = false;
      setNeedsReview(false);
      if (value.source_status !== "scheduled")
        setInactiveStatus(value.source_status);
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
      invalidated.current ||
      pending.current ||
      result ||
      sameScheduleSelection(
        preview.saved_devices.map((d) => d.id),
        preview.devices.map((d) => d.id),
      )
    )
      return;
    const controller = start("commit");
    if (!controller) return;
    const sentContext = context,
      expected = preview.devices.map((d) => d.id);
    pending.current = [...expected];
    setScheduleRefreshUncertainty(actorId, deploymentId, expected);
    setUncertain(true);
    callbacks.current.onCommittingChange?.(true);
    try {
      const value = await withRequestDeadline(
        (signal) =>
          api(`/deployments/${deploymentId}/refresh`, {
            method: "POST",
            body: JSON.stringify({
              review_token: preview.review_token,
              expected_device_ids: expected,
            }),
            signal,
          }),
        30000,
        controller.signal,
      );
      assertScheduledAssignmentRefreshReceipt(deploymentId, expected, value);
      if (!isCurrent(controller, sentContext)) return;
      clearUncertainty();
      setResult("saved");
      setMessage(
        "The reviewed device selection was saved. This does not activate the schedule or verify device application.",
      );
      callbacks.current.onDone("Scheduled device selection updated.");
    } catch (failure) {
      if (!isCurrent(controller, sentContext)) return;
      invalidated.current = true;
      setNeedsReview(true);
      setError((failure as Error).message);
      if (
        failure instanceof APIError &&
        failure.serverRejection &&
        failure.status === 409 &&
        failure.code === "SCHEDULE_REFRESH_REVIEW_CHANGED"
      ) {
        clearUncertainty();
        setMessage(
          "The saved selection or membership changed. Refresh review and confirm the new selection separately.",
        );
      } else
        setMessage(
          "The update could not be confirmed. Check current selection before making another change. Nothing is resent automatically.",
        );
    } finally {
      if (request.current === controller)
        callbacks.current.onCommittingChange?.(false);
      settled(controller);
    }
  }
  async function checkSelection() {
    const controller = start("status");
    if (!controller) return;
    const sentContext = context,
      expected = pending.current;
    try {
      const observation = await withRequestDeadline(
        async (signal) => {
          try {
            return { preview: await fetchReview(signal) };
          } catch (failure) {
            // A legacy/inactive endpoint may reject review. Only an exact source
            // summary can establish its current status; neither read resends.
            if (
              !(failure instanceof APIError) ||
              !failure.serverRejection ||
              failure.status !== 409
            )
              throw failure;
            const value = await api(`/deployments/${deploymentId}/summary`, {
              signal,
            });
            return {
              status: assertScheduledAssignmentRefreshStatus(
                deploymentId,
                value,
              ),
            };
          }
        },
        30000,
        controller.signal,
      );
      if (!isCurrent(controller, sentContext)) return;
      if (observation.preview) {
        const value = observation.preview;
        clearUncertainty();
        setPreview(value);
        setPage(1);
        const matches =
          expected &&
          sameScheduleSelection(
            expected,
            value.saved_devices.map((d) => d.id),
          );
        setInactiveStatus(
          value.source_status === "scheduled" ? null : value.source_status,
        );
        setResult(matches ? "observed" : null);
        invalidated.current = true;
        setNeedsReview(true);
        setMessage(
          matches
            ? "The current saved selection matches the devices you reviewed. This observation does not identify which request saved it or cancel any earlier request."
            : "The current saved selection differs from the devices you reviewed. Refresh review before deciding whether to update it; the earlier request is not automatically resent or cancelled.",
        );
      } else {
        const status = observation.status!;
        if (status.status === "scheduled") {
          setError(
            "The schedule is still pending, but its saved selection could not be read. Check current selection again or update the server before continuing.",
          );
          return;
        }
        clearUncertainty();
        setPreview(null);
        setInactiveStatus(status.status);
        setResult(null);
        setMessage(
          "Current status was read successfully. This does not establish the result of an earlier update request.",
        );
      }
      callbacks.current.onDone("Current schedule state refreshed.");
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
    phase.current = null;
    setBusy(null);
    onClose();
  }
  const rows = preview ? scheduleSelectionRows(preview) : [];
  const unchanged =
    !!preview?.ready &&
    preview.source_status === "scheduled" &&
    sameScheduleSelection(
      preview.saved_devices.map((d) => d.id),
      preview.devices.map((d) => d.id),
    );
  return (
    <Modal
      open={open}
      onClose={close}
      title={
        result === "saved"
          ? "Scheduled devices updated"
          : "Update scheduled devices"
      }
      description="Compare the saved device selection with current membership before the schedule activates."
      wide
      className="scheduled-refresh-modal"
      returnFocusRef={returnFocusRef}
    >
      <div className="modal-body scheduled-refresh">
        {error && <ErrorBox message={error} />}
        {message && (
          <p className="scheduled-refresh-notice" role="status">
            {message}
          </p>
        )}
        {!allowed && (
          <p className="control-muted">
            You no longer have permission to update this schedule.
          </p>
        )}
        {busy && (
          <p className="scheduled-refresh-loading" role="status">
            <Spinner />{" "}
            {busy === "review"
              ? "Reviewing scheduled devices…"
              : busy === "commit"
                ? "Saving scheduled devices…"
                : "Checking current selection…"}
          </p>
        )}
        {inactiveStatus && (
          <p className="scheduled-refresh-notice" role="status">
            This schedule is {inactiveStatus.replaceAll("_", " ")}. Its device
            selection can no longer be updated.
          </p>
        )}
        {preview && result !== "saved" && (
          <>
            <div className="scheduled-refresh-heading">
              <h3>
                {inactiveStatus
                  ? "Current saved selection"
                  : "Device selection"}
              </h3>
              <span>
                {preview.saved_devices.length} saved
                {!inactiveStatus && ` → ${preview.devices.length} proposed`}
              </span>
            </div>
            <p className="control-muted">
              {preview.resource === "configuration"
                ? "Pipeline configuration"
                : "Agent policy"}{" "}
              · Scheduled for {new Date(preview.scheduled_at).toLocaleString()}
            </p>
            {unchanged && !uncertain && !needsReview && (
              <p className="scheduled-refresh-notice" role="status">
                Selection is already current.
              </p>
            )}
            {needsReview && !uncertain && !inactiveStatus && (
              <p className="scheduled-refresh-notice" role="status">
                Refresh review before confirming another update.
              </p>
            )}
            {!!preview.blockers.length && <Blockers preview={preview} />}
            {!!preview.warnings.length && (
              <div className="scheduled-refresh-notice">
                <ul>
                  {preview.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            <DataTable
              data={rows}
              rowKey={(row) => row.id}
              label="Scheduled device selection"
              pagination={{ page, size: 8, onPage: setPage }}
              columns={[
                {
                  id: "device",
                  header: "Device",
                  value: (row) => row.name || row.id,
                  filter: { placeholder: "Find a reviewed device" },
                  cell: (row) => (
                    <span className="scheduled-refresh-device">
                      <strong>{row.name || "Unnamed device"}</strong>
                      <details>
                        <summary>Device ID</summary>
                        <code>{row.id}</code>
                      </details>
                      <span>{row.status.replaceAll("_", " ")}</span>
                    </span>
                  ),
                },
                {
                  id: "change",
                  header: inactiveStatus
                    ? "Saved selection"
                    : "Proposed change",
                  value: (row) => row.change,
                  filter: inactiveStatus
                    ? undefined
                    : {
                        options: [
                          { value: "added", label: "Added" },
                          { value: "kept", label: "Kept" },
                          { value: "removed", label: "Removed" },
                        ],
                      },
                  cell: (row) => (
                    <span className="scheduled-refresh-change">
                      <strong>
                        {inactiveStatus
                          ? "Included"
                          : {
                              added: "Add device",
                              kept: "Keep device",
                              removed: "Remove device",
                            }[row.change]}
                      </strong>
                      {!inactiveStatus && (
                        <span>
                          {row.change === "added"
                            ? "Not saved → Included"
                            : row.change === "removed"
                              ? "Included → Not included"
                              : "Included → Included"}
                        </span>
                      )}
                    </span>
                  ),
                },
              ]}
              empty="No reviewed devices match these filters."
            />
            <p className="scheduled-refresh-filter-note">
              Filters only change this view.{" "}
              {inactiveStatus
                ? "The complete saved selection is shown."
                : `All ${preview.devices.length} proposed devices remain included in the update.`}
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
          {result || inactiveStatus ? "Close" : "Cancel"}
        </Button>
        {allowed &&
          result !== "saved" &&
          (uncertain && busy !== "commit" ? (
            <RefreshButton
              busy={busy === "status"}
              disabled={!!busy}
              onClick={() => void checkSelection()}
            >
              Check current selection
            </RefreshButton>
          ) : (
            !inactiveStatus && (
              <>
                <RefreshButton
                  busy={busy === "review"}
                  disabled={!!busy}
                  onClick={() => void review()}
                >
                  Refresh review
                </RefreshButton>
                <Button
                  busy={busy === "commit"}
                  disabled={
                    !!busy ||
                    !preview?.ready ||
                    needsReview ||
                    unchanged ||
                    !!result
                  }
                  onClick={() => void commit()}
                >
                  Update scheduled devices
                </Button>
              </>
            )
          ))}
      </div>
    </Modal>
  );
}
