import { useEffect, useRef, useState } from "react";
import { api, withRequestDeadline } from "./api";
import { Button, ErrorBox, Pagination, SearchBox, Spinner } from "./ui";
import { type RollbackPreview } from "./rollbackReview";
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
      {preview && (
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
              ? "This removes the original assignment and creates a rollback deployment at the same priority."
              : "This stops further releases from the original rollout and creates a rollback deployment at a higher priority."}{" "}
            Each included device must validate and verify its prior exact
            artifact. The original device history stays intact.
          </p>
          {invalidated && (
            <p role="status" className="rollback-review-stale">
              Refresh review before confirming again.
            </p>
          )}
          {preview.blockers.length > 0 && (
            <div className="rollback-review-blockers" role="status">
              <strong>Rollback is not ready</strong>
              <ul>
                {preview.blockers.map((blocker, index) => (
                  <li key={`${blocker.code}-${index}`}>{blocker.reason}</li>
                ))}
              </ul>
            </div>
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
                  <code>{device.device_id}</code>
                  {"artifact_sha256" in device && (
                    <code>Prior artifact SHA-256: {device.artifact_sha256}</code>
                  )}
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
