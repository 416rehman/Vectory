// A few devices' own records, read one by one: what a host command is made
// from (where it keeps its state, what keeps it running, what it reported
// about updates). Nothing is read until `enabled`, a few at a time, and a
// device that can't be read is said so rather than guessed.
import { useEffect, useRef, useState } from "react";
import { api, type Device } from "./api";

type Details = {
  devices: Record<string, Device>;
  failed: Record<string, string>;
  loading: boolean;
};
const CONCURRENT = 4;

export function useDeviceDetails(ids: readonly string[], enabled: boolean) {
  const [state, setState] = useState<Details>({
    devices: {},
    failed: {},
    loading: false,
  });
  const key = ids.join(",");
  const known = useRef<Details>(state);
  known.current = state;
  useEffect(() => {
    if (!enabled) return;
    const wanted = ids.filter(
      (id) => !known.current.devices[id] && !known.current.failed[id],
    );
    if (!wanted.length) return;
    const controller = new AbortController();
    setState((old) => ({ ...old, loading: true }));
    let next = 0;
    const readNext = async () => {
      while (next < wanted.length && !controller.signal.aborted) {
        const id = wanted[next++];
        try {
          const device = await api<Device>(
            `/devices/${encodeURIComponent(id)}`,
            { signal: controller.signal },
          );
          if (!controller.signal.aborted)
            setState((old) => ({
              ...old,
              devices: { ...old.devices, [id]: device },
            }));
        } catch (error) {
          if (!controller.signal.aborted)
            setState((old) => ({
              ...old,
              failed: { ...old.failed, [id]: (error as Error).message },
            }));
        }
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(CONCURRENT, wanted.length) }, readNext),
    ).then(() => {
      if (!controller.signal.aborted)
        setState((old) => ({ ...old, loading: false }));
    });
    return () => controller.abort();
    // The ids are named by `key`; a new list of the same devices reads nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return state;
}
