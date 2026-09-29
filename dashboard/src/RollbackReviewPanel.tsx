import { useEffect, useRef, useState } from "react";
import { api, withRequestDeadline } from "./api";
import { Button, ErrorBox, Pagination, SearchBox, Spinner } from "./ui";
import {
  locallyConfigured,
  nothingToRollBackTo,
  type RollbackPreview,
} from "./rollbackReview";
import "./rollback-review.css";

const reasons = {
  revoked: "Device revoked",
  removed: "No longer targeted",
  not_released: "Never released",
  missing: "Device unavailable",
};

export default function RollbackReviewPanel({
  id,
  versionId,
  supported,
  busy,
  invalidated,
  onChange,
}: {
  id: string;
  versionId?: string | null;
  supported: boolean;
  busy: boolean;
  invalidated: boolean;
  onChange(preview: RollbackPreview | null): void;
}) {
  const [preview, setPreview] = useState<RollbackPreview | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0),
    [scope, setScope] = useState<"eligible" | "excluded">("eligible");
  const [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const controller = new AbortController();
    onChangeRef.current(null);
    setPreview(null);
    setError("");
    setSearch("");
    setPage(1);
    setScope("eligible");
    if (!supported) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void withRequestDeadline(
      (signal) =>
        api<RollbackPreview>(`/deployments/${id}/rollback-preview`, { signal }),
      30000,
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          value.source_deployment_id.toLowerCase() !== id.toLowerCase() ||
          value.source_version_id.toLowerCase() !== versionId?.toLowerCase()
        )
          throw Error(
            "The review identifies a different deployment or version. Refresh the deployment before continuing.",
          );
        setPreview(value);
        onChangeRef.current(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError((failure as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, versionId, supported, refresh]);
  function refreshReview() {
    if (busy || loading) return;
    onChangeRef.current(null);
    setPreview(null);
    setRefresh((n) => n + 1);
  }
  if (!supported)
    return (
      <p className="control-muted">
        This server cannot provide a reviewed rollback. Update the server before
        using this action. Existing request reminders remain available for
        recovery.
      </p>
    );
  const query = search.trim().toLocaleLowerCase();
  const empty = preview ? nothingToRollBackTo(preview) : false;
  const local = preview ? locallyConfigured(preview) : [];
  const otherBlockers = preview
    ? preview.blockers.filter((b) => b.code !== "PRIOR_VERSION_UNKNOWN")
    : [];
  const digests = new Set(
    (preview?.eligible_devices || [])
      .map((device) => device.artifact_sha256)
      .filter(Boolean),
  );
  const sharedDigest =
    digests.size === 1 && local.length === 0 ? [...digests][0] : null;
  const rows = preview
    ? (scope === "eligible"
        ? preview.eligible_devices.map((d) => ({ ...d, reason: null }))
        : preview.excluded_devices
      ).filter((d) =>
        `${d.device_name || ""} ${d.device_id}`
          .toLocaleLowerCase()
          .includes(query),
      )
    : [];
  return (
    <div className="rollback-review">
      {loading && (
        <p role="status" className="rollback-review-loading">
          <Spinner /> Checking rollback scope…
        </p>
      )}
      {error && <ErrorBox message={error} retry={refreshReview} />}
      {preview && empty && (
        <div className="rollback-nothing" role="status">
          <strong>Nothing to roll back to</strong>
          <p>
            {local.length === preview.eligible_devices.length
              ? local.length === 1
                ? "This device ran its local config before this deployment. Remove the assignment to stop managing it; it keeps the config it runs now."
                : `These ${local.length} devices ran their local config before this deployment. Remove the assignment to stop managing them; they keep the config they run now.`
              : `${local.length} of ${preview.eligible_devices.length} devices ran their local config before this deployment, so this rollout can't be rolled back as a whole. Remove the assignment, or deploy the version you want.`}
          </p>
          <p className="rollback-nothing-devices">
            {local
              .slice(0, 6)
              .map((device) => device.device_name || "Unnamed device")
              .join(", ")}
            {local.length > 6 ? ` and ${local.length - 6} more` : ""}
          </p>
        </div>
      )}
      {preview && !empty && (
        <>
          <div className="rollback-review-heading">
            <div>
              <span className="control-muted">Restore</span>
              <strong>
                {preview.previous_configuration_name || "Previous pipeline"}
                {preview.previous_version_number !== null
                  ? ` · Version ${preview.previous_version_number}`
                  : ""}
              </strong>
              {preview.previous_version_id &&
                (preview.previous_configuration_name === null ||
                  preview.previous_version_number === null) && (
                  <span className="rollback-version-id">
                    Version ID <code>{preview.previous_version_id}</code>
                  </span>
                )}
              {!preview.previous_version_id && (
                <span className="control-muted">
                  Previous version unavailable
                </span>
              )}
            </div>
            <Button
              variant="secondary compact"
              disabled={busy || loading}
              onClick={refreshReview}
            >
              Refresh review
            </Button>
          </div>
          <p className="rollback-review-effect">
            {preview.source_action === "unassign"
              ? "Removes this assignment and restores each device's exact previous artifact at the same priority."
              : "Stops further releases here and restores each device's exact previous artifact at a higher priority."}{" "}
            Each device verifies it again. This rollout's history stays.
          </p>
          {invalidated && (
            <p role="status" className="rollback-review-stale">
              Refresh review before confirming again.
            </p>
          )}
          {otherBlockers.length > 0 && (
            <div className="rollback-review-blockers" role="status">
              <strong>Rollback is not ready</strong>
              <ul>
                {otherBlockers.map((blocker, index) => (
                  <li key={`${blocker.code}-${index}`}>{blocker.reason}</li>
                ))}
              </ul>
            </div>
          )}
          {sharedDigest && (
            <p className="rollback-shared-digest">
              {preview.eligible_devices.length === 1
                ? "Restores its"
                : `All ${preview.eligible_devices.length} devices restore the same`}{" "}
              prior artifact · SHA-256{" "}
              <code title={sharedDigest} data-digest={sharedDigest}>
                {sharedDigest.slice(0, 8)}…{sharedDigest.slice(-8)}
              </code>
            </p>
          )}
          <div
            className="rollback-scope-switch"
            role="group"
            aria-label="Reviewed rollback devices"
          >
            <button
              type="button"
              aria-pressed={scope === "eligible"}
              onClick={() => {
                setScope("eligible");
                setPage(1);
                setSearch("");
              }}
            >
              Included ({preview.eligible_devices.length})
            </button>
            <button
              type="button"
              aria-pressed={scope === "excluded"}
              onClick={() => {
                setScope("excluded");
                setPage(1);
                setSearch("");
              }}
            >
              Excluded ({preview.excluded_devices.length})
            </button>
          </div>
          <p className="control-muted rollback-scope-note">
            {scope === "eligible"
              ? "Only these devices are included if you confirm. Offline devices remain included."
              : "These devices will not receive the rollback. Replacement identities are not added automatically."}
          </p>
          <SearchBox
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            maxLength={200}
            placeholder="Find reviewed devices"
          />
          <ul
            className="rollback-device-list"
            aria-label={
              scope === "eligible" ? "Included devices" : "Excluded devices"
            }
          >
            {rows.slice((page - 1) * 8, page * 8).map((device) => (
              <li key={device.device_id}>
                <span>
                  <strong>{device.device_name || "Unnamed device"}</strong>
                  {"artifact_sha256" in device &&
                    !sharedDigest &&
                    (device.artifact_sha256 ? (
                      <small className="rollback-device-digest">
                        Prior artifact SHA-256{" "}
                        <code
                          title={device.artifact_sha256}
                          data-digest={device.artifact_sha256}
                        >
                          {device.artifact_sha256.slice(0, 12)}…
                          {device.artifact_sha256.slice(-8)}
                        </code>
                      </small>
                    ) : (
                      <span className="rollback-local">
                        Ran its local config
                      </span>
                    ))}
                  <small className="rollback-device-id">
                    Device ID <code>{device.device_id}</code>
                  </small>
                </span>
                {device.reason && (
                  <span className="rollback-exclusion-reason">
                    {reasons[device.reason]}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {rows.length === 0 && (
            <p className="control-muted">
              {query
                ? "No reviewed devices match your search."
                : scope === "excluded"
                  ? "No devices excluded."
                  : "No eligible devices."}
            </p>
          )}
          <Pagination
            count={rows.length}
            page={page}
            size={8}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}
