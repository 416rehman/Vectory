import { useEffect, useState } from "react";
import {
  api,
  withRequestDeadline,
  type Device,
  type Group,
  type GroupMembershipPreview,
} from "./api";
import { Spinner } from "./ui";
import {
  membershipSentence,
  previewBusy,
  previewWithRetries,
} from "./groupMembership";

/**
 * What saving this membership edit would change on each added or removed
 * device, from the server's dry run of the real resolver. Nothing is written.
 */
export default function GroupMembershipEffects({
  group,
  ids,
  devices,
}: {
  group: Group;
  ids: string[];
  devices: Device[];
}) {
  const [preview, setPreview] = useState<GroupMembershipPreview | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const key = [...ids].sort().join(",");
  const changed =
    ids.length !== group.device_ids.length ||
    ids.some((id) => !group.device_ids.includes(id));
  useEffect(() => {
    setPreview(null);
    setError("");
    if (!changed || group.revision === undefined) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        // A busy server is asked again a second later, quietly: the
        // spinner stays until it answers or stays busy a few times.
        const result = await previewWithRetries(
          () =>
            withRequestDeadline(
              (signal) =>
                api<GroupMembershipPreview>("/groups/membership-preview", {
                  method: "POST",
                  body: JSON.stringify({
                    group_id: group.id,
                    device_ids: ids,
                    revision: group.revision,
                  }),
                  signal,
                }),
              30000,
              controller.signal,
            ),
          controller.signal,
        );
        if (!controller.signal.aborted && result.group_id === group.id)
          setPreview(result);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            previewBusy(e) ? "the server is busy" : (e as Error).message,
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // The selection key captures every membership change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, group.id, group.revision]);
  if (!changed) return null;
  const name = (id: string, fallback: string | null) =>
    devices.find((device) => device.id === id)?.name || fallback || id;
  return (
    <section
      className="group-effects"
      aria-live="polite"
      aria-labelledby="group-effects-heading"
    >
      <h4 id="group-effects-heading">What changes when you save</h4>
      {loading && !preview && (
        <p className="control-muted" role="status">
          <Spinner /> Checking each device…
        </p>
      )}
      {error && (
        <p className="control-muted">
          Couldn't preview the effect ({error}). Saving still checks every
          device.
        </p>
      )}
      {preview?.stale && (
        <p className="group-effects-blocker">
          This group changed since you opened it. Saving will ask you to review
          the latest version.
        </p>
      )}
      {preview?.blockers.map((blocker) => (
        <p
          key={blocker.code + blocker.reason}
          className="group-effects-blocker"
        >
          {blocker.reason}
        </p>
      ))}
      {preview && (
        <ul>
          {preview.devices.map((entry) => (
            <li key={entry.device_id} data-change={entry.change}>
              {membershipSentence(
                entry,
                name(entry.device_id, entry.device_name),
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
