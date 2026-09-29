import { useEffect, useRef, useState } from "react";
import {
  APIError,
  api,
  withRequestDeadline,
  type SavedPolicyListItem,
} from "./api";
import { Button, ErrorBox, Field, Modal } from "./ui";
import { devicesText, policySummary } from "./deploymentReviewModel";
import "./agent-settings.css";

/**
 * Edits a saved settings template under its revision. Saving changes the
 * template only; devices keep what they were given until it is applied again.
 */
export default function AgentSettingsEditor({
  setting,
  returnFocusRef,
  onClose,
  onSaved,
  onApply,
}: {
  setting: SavedPolicyListItem;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose(): void;
  onSaved(updated: SavedPolicyListItem): void;
  /** Re-apply the saved values to the devices that use this template. */
  onApply(updated: SavedPolicyListItem, deviceIds: string[]): void;
}) {
  const [name, setName] = useState(setting.name),
    [heartbeat, setHeartbeat] = useState(
      String(setting.policy.heartbeat_seconds),
    ),
    [paused, setPaused] = useState(setting.policy.sync_paused),
    [telemetry, setTelemetry] = useState(setting.policy.telemetry_enabled),
    [revision, setRevision] = useState(setting.revision ?? 0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stale, setStale] = useState(false),
    [saved, setSaved] = useState<SavedPolicyListItem | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const seconds = Number(heartbeat);
  const validInterval =
    Number.isInteger(seconds) && seconds >= 10 && seconds <= 3600;
  const policy = {
    heartbeat_seconds: seconds,
    sync_paused: paused,
    telemetry_enabled: telemetry,
  };
  const unchanged =
    name.trim() === setting.name &&
    policy.heartbeat_seconds === setting.policy.heartbeat_seconds &&
    policy.sync_paused === setting.policy.sync_paused &&
    policy.telemetry_enabled === setting.policy.telemetry_enabled;
  async function loadLatest() {
    setBusy(true);
    setError("");
    try {
      const latest = await withRequestDeadline(
        (signal) =>
          api<SavedPolicyListItem>(
            `/policies/${encodeURIComponent(setting.id)}`,
            {
              signal,
            },
          ),
        30000,
      );
      if (!mounted.current) return;
      if (latest.id !== setting.id)
        throw Error(
          "The server returned different settings. Close and reopen them.",
        );
      setName(latest.name);
      setHeartbeat(String(latest.policy.heartbeat_seconds));
      setPaused(latest.policy.sync_paused);
      setTelemetry(latest.policy.telemetry_enabled);
      setRevision(latest.revision ?? 0);
      setStale(false);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !validInterval || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const updated = await withRequestDeadline(
        (signal) =>
          api<SavedPolicyListItem>(
            `/policies/${encodeURIComponent(setting.id)}`,
            {
              method: "PUT",
              body: JSON.stringify({ name: name.trim(), policy, revision }),
              signal,
            },
          ),
        30000,
      );
      if (!mounted.current) return;
      if (updated.id !== setting.id || updated.revision !== revision + 1)
        throw Error(
          "The response didn't confirm this edit. Reload the settings before editing again.",
        );
      setSaved(updated);
      onSaved(updated);
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof APIError && e.code === "STALE_REVISION") setStale(true);
      setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  // Who used these settings before the edit, including devices matched by value.
  const applied = setting.applied_devices || [];
  const count = setting.applied_device_count || 0;
  const policyChanged =
    !!saved &&
    (saved.policy.heartbeat_seconds !== setting.policy.heartbeat_seconds ||
      saved.policy.sync_paused !== setting.policy.sync_paused ||
      saved.policy.telemetry_enabled !== setting.policy.telemetry_enabled);
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      returnFocusRef={returnFocusRef}
      className="agent-settings-editor"
      title={saved ? "Settings saved" : `Edit ${setting.name}`}
      description={
        saved
          ? "Saved. No devices change until you apply these settings."
          : "Saving changes these settings only. Devices keep what they were given until you apply them again."
      }
    >
      {saved ? (
        <>
          <div className="modal-body agent-settings-editor-body">
            <p className="agent-settings-editor-summary">
              <strong>{saved.name}</strong>
              <span>{policySummary(saved.policy)}</span>
            </p>
            {!policyChanged ? (
              <p className="control-muted">
                Only the name changed. Devices keep the same settings.
              </p>
            ) : count > 0 ? (
              <p>
                {count === 1
                  ? "1 device still uses the earlier values."
                  : `${devicesText(count)} still use the earlier values.`}{" "}
                {count > applied.length
                  ? "Choose which ones to update."
                  : count === 1
                    ? "Apply the edit to update it."
                    : "Apply the edit to update them."}
              </p>
            ) : (
              <p className="control-muted">
                No devices use these settings yet.
              </p>
            )}
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
            {policyChanged && count > 0 && (
              <Button
                onClick={() =>
                  onApply(
                    saved,
                    count <= applied.length
                      ? applied.map((device) => device.id)
                      : [],
                  )
                }
              >
                {count <= applied.length
                  ? `Apply to ${devicesText(count)}`
                  : "Choose devices"}
              </Button>
            )}
          </div>
        </>
      ) : (
        <form onSubmit={save}>
          <div className="modal-body agent-settings-editor-body">
            {error && <ErrorBox message={error} />}
            {stale && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void loadLatest()}
              >
                Load the latest values
              </Button>
            )}
            <Field label="Settings name">
              <input
                value={name}
                required
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field
              label="Check-in interval (seconds)"
              hint={
                validInterval
                  ? "Between 10 and 3,600 seconds."
                  : "Enter 10 to 3,600 seconds."
              }
            >
              <input
                type="number"
                min={10}
                max={3600}
                step={1}
                required
                aria-invalid={!validInterval || undefined}
                value={heartbeat}
                onChange={(event) => setHeartbeat(event.target.value)}
              />
            </Field>
            <label className="toggle-row">
              <span>
                <strong>Pause configuration sync</strong>
                <small>Keep the current pipeline. Check-ins continue.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={paused}
                onChange={(event) => setPaused(event.target.checked)}
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
                onChange={(event) => setTelemetry(event.target.checked)}
              />
            </label>
            {(setting.applied_device_count || 0) > 0 && (
              <p className="control-muted">
                {devicesText(setting.applied_device_count || 0)} use these
                settings now. They keep their current values until you apply the
                edit.
              </p>
            )}
          </div>
          <div className="modal-footer">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              busy={busy}
              disabled={
                busy || stale || unchanged || !validInterval || !name.trim()
              }
            >
              Save changes
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
