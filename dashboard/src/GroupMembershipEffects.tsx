import { useEffect, useMemo, useState } from "react";
import {
  api,
  withRequestDeadline,
  type Group,
  type GroupMembershipPreview,
} from "./api";
import { Button, Spinner } from "./ui";
import { setDifference } from "./deviceInventory";
import {
  AUTO_PREVIEW,
  conflictSentences,
  membershipEffects,
  membershipSentence,
  parseMembershipConflicts,
  previewBusy,
  previewWithRetries,
  previewWanted,
  savingBlocked,
} from "./groupMembership";

/** Devices described one by one before the rest are summed up. */
const LISTED = 50;

/**
 * What saving this membership edit would change on each added or removed
 * device, from the server's dry run of the real resolver. Nothing is written.
 * `onBlocked` hears why saving has to wait, or "" when nothing blocks it.
 */
export default function GroupMembershipEffects({
  group,
  ids,
  onBlocked,
}: {
  group: Group;
  ids: ReadonlySet<string>;
  onBlocked?: (reason: string) => void;
}) {
  const [preview, setPreview] = useState<GroupMembershipPreview | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  // The edit is what differs from the saved group: that is what a new preview
  // waits for, however many devices the group holds.
  const saved = useMemo(() => new Set(group.device_ids), [group.device_ids]);
  const { key, changed, count } = useMemo(() => {
    const { added, removed } = setDifference(ids, saved);
    return {
      key: `${added.sort().join(",")}|${removed.sort().join(",")}`,
      changed: added.length > 0 || removed.length > 0,
      count: added.length + removed.length,
    };
  }, [ids, saved]);
  // A very large edit waits for a click, for this exact edit.
  const [asked, setAsked] = useState("");
  const wanted = previewWanted(count, key, asked);
  const large = count > AUTO_PREVIEW;
  useEffect(() => {
    setPreview(null);
    setError("");
    if (!wanted || group.revision === undefined) return;
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
                    device_ids: [...ids],
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
  }, [key, wanted, group.id, group.revision]);
  // What stops the save, said once the preview knows; nothing blocks an edit
  // that is gone or not yet previewed.
  const blockedReason = changed ? savingBlocked(preview) : "";
  useEffect(() => {
    onBlocked?.(blockedReason);
    return () => onBlocked?.("");
    // The parent's setter is stable; only the reason matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockedReason]);
  if (!changed) return null;
  const name = (id: string, fallback: string | null) => fallback || id;
  // A few devices read one by one; a large edit says what matters (the
  // devices that change something) and counts the ones that change nothing.
  // A blocked edit stopped the simulation, so what it would change is not
  // known: the blockers are all the preview says.
  const summary =
    preview && !preview.blockers.length
      ? membershipEffects(preview.devices, LISTED)
      : null;
  return (
    <section
      className="group-effects"
      aria-live="polite"
      aria-labelledby="group-effects-heading"
    >
      <h4 id="group-effects-heading">What changes when you save</h4>
      {large && !wanted && (
        <>
          <p className="control-muted">
            This changes {count.toLocaleString()} devices. Saving checks every
            one of them. A preview asks the server what changes on each.
          </p>
          <Button variant="secondary compact" onClick={() => setAsked(key)}>
            Preview what changes
          </Button>
        </>
      )}
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
      {preview?.blockers.flatMap((blocker) => {
        // A collision names the device and both assignments; any other
        // blocker says what the server said.
        const named = parseMembershipConflicts(
          blocker.details,
          blocker.details_total,
        );
        return (
          named ? conflictSentences(named, group.id) : [blocker.reason]
        ).map((line) => (
          <p
            key={blocker.code + line}
            className="group-effects-blocker"
            data-blocker={blocker.code}
          >
            {line}
          </p>
        ));
      })}
      {summary && (
        <>
          <ul>
            {summary.listed.map((entry) => (
              <li key={entry.device_id} data-change={entry.change}>
                {membershipSentence(
                  entry,
                  name(entry.device_id, entry.device_name),
                )}
              </li>
            ))}
          </ul>
          {summary.more > 0 && (
            <p className="control-muted">
              And {summary.more.toLocaleString()} more{" "}
              {summary.more === 1 ? "device changes" : "devices change"}.
            </p>
          )}
          {summary.quietSentence && (
            <p className="control-muted">{summary.quietSentence}</p>
          )}
        </>
      )}
    </section>
  );
}
