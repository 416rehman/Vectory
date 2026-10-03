import { useEffect, useRef, useState } from "react";
import { api, withRequestDeadline, type Version } from "./api";
import { hostApprovals, type HostApprovals } from "./hostRequirements";

/** Versions read for one review. A fleet runs few distinct ones. */
const MAX_VERSIONS = 12;

/**
 * What the versions that restricted devices verifiably run use: destinations,
 * listeners and file roots, by version id. A version whose addresses differ by
 * device, or one that could not be read, maps to null: it proves nothing.
 * Each id is read once. `pending` is true while any read is still out, so the
 * review never shows a claim that the answer would take back.
 */
export function useRunningApprovals(ids: readonly string[]): {
  held: ReadonlyMap<string, HostApprovals | null>;
  pending: boolean;
} {
  const [held, setHeld] = useState<ReadonlyMap<string, HostApprovals | null>>(
    () => new Map(),
  );
  const asked = useRef(new Set<string>());
  const wanted = [...new Set(ids)].sort().slice(0, MAX_VERSIONS);
  const key = wanted.join(",");
  useEffect(() => {
    const controller = new AbortController();
    const out = new Set<string>();
    for (const id of key ? key.split(",") : []) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      out.add(id);
      const settle = (version: Version | null) => {
        if (controller.signal.aborted) return;
        out.delete(id);
        setHeld((previous) =>
          new Map(previous).set(
            id,
            version?.config && !version.variables?.length
              ? hostApprovals(version.config)
              : null,
          ),
        );
      };
      withRequestDeadline(
        (signal) =>
          api<Version>(`/versions/${encodeURIComponent(id)}`, { signal }),
        15000,
        controller.signal,
      ).then(settle, () => settle(null));
    }
    return () => {
      controller.abort();
      // A read cut off by a change of selection is asked again when it returns.
      for (const id of out) asked.current.delete(id);
    };
  }, [key]);
  return { held, pending: wanted.some((id) => !held.has(id)) };
}
