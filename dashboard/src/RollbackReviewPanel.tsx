import { useEffect, useRef, useState } from "react";
import { api, withRequestDeadline } from "./api";
import { Button, ErrorBox, Pagination, SearchBox, Spinner } from "./ui";
import {
  excludedDetail,
  locallyConfigured,
  nothingReleased,
  nothingToRollBackTo,
  restoredName,
  rollbackStory,
  stopsRollout,
  type RollbackPreview,
} from "./rollbackReview";
import "./rollback-review.css";

/** A short identity for a device without a name, never the whole UUID. */
const unnamed = (id: string) => `Unnamed device ${id.slice(0, 8)}`;

export default function RollbackReviewPanel({
  id,
  versionId,
  source,
  supported,
  busy,
  invalidated,
  revision = 0,
  onCancelFirst,
  onChange,
}: {
  id: string;
  versionId?: string | null;
  /** What is rolled back, as the review names it: "web-demo v1". */
  source: string;
  supported: boolean;
  busy: boolean;
  invalidated: boolean;
  /** Changes when the rollout changed underneath (it was cancelled). */
  revision?: number;
  /** Offered when a live rollout's rollback is blocked: stop it first. */
  onCancelFirst?: () => void;
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
  }, [id, versionId, supported, refresh, revision]);
  function refreshReview() {
    if (busy || loading) return;
    onChangeRef.current(null);
    setPreview(null);
    setRefresh((n) => n + 1);
  }
  if (!supported)
    return (
      <p className="control-muted">
        This server cannot provide a reviewed rollback. Update the server to
        roll back from here. Saved request reminders stay available.
      </p>
    );
  const query = search.trim().toLocaleLowerCase();
  const empty = preview ? nothingToRollBackTo(preview) : false;
  const releasedNone = preview && !empty ? nothingReleased(preview) : null;
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
  const restored = preview ? restoredName(preview) : "";
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
  const released = (preview?.eligible_devices || []).map(
    (device) => device.device_name || unnamed(device.device_id),
  );
  const releasedNames =
    released.length <= 2
      ? released.join(" and ")
      : `${released.slice(0, 2).join(", ")} and ${released.length - 2} more`;
  return (
    <div className="rollback-review">
      {loading && (
        <p role="status" className="rollback-review-loading">
          <Spinner /> Checking what each device runs afterwards…
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
      {preview && releasedNone && (
        <div className="rollback-nothing" role="status">
          <strong>Nothing to roll back</strong>
          <p>{releasedNone.reason}</p>
        </div>
      )}
      {preview && !empty && !releasedNone && (
        <>
          <div className="rollback-review-heading">
            <div>
              <span className="control-muted">Restores</span>
              <strong>
                {preview.previous_version_id
                  ? restored
                  : "Previous version unavailable"}
              </strong>
              {preview.previous_version_id &&
                (preview.previous_configuration_name === null ||
                  preview.previous_version_number === null) && (
                  <span className="rollback-version-id">
                    Version ID <code>{preview.previous_version_id}</code>
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
          <ul className="rollback-story" aria-label="What changes">
            {rollbackStory(preview, source).map((line) => (
              <li key={line.text} data-tone={line.tone}>
                {line.text}
              </li>
            ))}
          </ul>
          <p className="rollback-review-effect">
            {preview.source_action === "unassign"
              ? "This assignment is removed, and the restored version takes over at the same priority."
              : "The restored version takes over one priority above this rollout."}{" "}
            Each device verifies it again, and this rollout's history stays.
          </p>
          {invalidated && (
            <p role="status" className="rollback-review-stale">
              Refresh the review before confirming again.
            </p>
          )}
          {otherBlockers.length > 0 && (
            <div className="rollback-review-blockers" role="status">
              <strong>Rollback isn't ready</strong>
              <ul>
                {otherBlockers.map((blocker, index) => (
                  <li key={`${blocker.code}-${index}`}>{blocker.reason}</li>
                ))}
              </ul>
              {onCancelFirst && stopsRollout(preview) && (
                <div className="rollback-cancel-first">
                  <p>
                    Cancel keeps {releasedNames || "the devices it reached"} on{" "}
                    {source} until you roll{" "}
                    {released.length === 1 ? "it" : "them"} back.
                  </p>
                  <Button
                    variant="secondary"
                    disabled={busy || loading}
                    onClick={onCancelFirst}
                  >
                    Cancel rollout, then review rollback
                  </Button>
                </div>
              )}
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
              ? `These devices return to ${restored}. Offline ones stay included and apply it when they reconnect.`
              : `These devices never received ${source}, or no longer follow it. The rollback leaves them out; each one says what it runs afterwards.`}
          </p>
          {sharedDigest && scope === "eligible" && (
            <p className="rollback-shared-digest">
              {preview.eligible_devices.length === 1
                ? "Restores its"
                : `All ${preview.eligible_devices.length} devices restore the same`}{" "}
              exact earlier artifact · SHA-256{" "}
              <code title={sharedDigest} data-digest={sharedDigest}>
                {sharedDigest.slice(0, 8)}…{sharedDigest.slice(-8)}
              </code>
            </p>
          )}
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
            {rows.slice((page - 1) * 8, page * 8).map((device) => {
              const excluded = "effect" in device || device.reason !== null;
              const detail =
                device.reason !== null
                  ? excludedDetail(device, source)
                  : `Returns to ${restored}`;
              const tone =
                "effect" in device &&
                (device.effect === "fallback" || device.effect === "unmanaged")
                  ? "danger"
                  : undefined;
              return (
                <li key={device.device_id} data-tone={tone}>
                  <span>
                    <strong title={device.device_id}>
                      {device.device_name || unnamed(device.device_id)}
                    </strong>
                    <small className="rollback-device-detail">{detail}</small>
                    {!excluded &&
                      "artifact_sha256" in device &&
                      !sharedDigest &&
                      (device.artifact_sha256 ? (
                        <small className="rollback-device-digest">
                          Earlier artifact SHA-256{" "}
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
                  </span>
                </li>
              );
            })}
          </ul>
          {rows.length === 0 && (
            <p className="control-muted">
              {query
                ? "No reviewed devices match your search."
                : scope === "excluded"
                  ? "No devices left out."
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
