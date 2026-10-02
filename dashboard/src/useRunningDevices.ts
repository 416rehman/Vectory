import { useEffect, useState } from "react";
import { readRunningDevices, type RunningDevices } from "./runningDevices";

export type RunningRead =
  /** Nothing to look for: another kind of deployment, or devices were named. */
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; data: RunningDevices }
  /** The read did not finish; the choice of devices is made by hand. */
  | { state: "failed" };

/**
 * The devices that run a pipeline, read once while `enabled`. Opening a
 * deployment never waits for it: the person can choose devices meanwhile.
 */
export function useRunningDevices(
  configurationId: string | null | undefined,
  enabled: boolean,
): RunningRead {
  const [read, setRead] = useState<RunningRead>({
    state: enabled && configurationId ? "loading" : "idle",
  });
  useEffect(() => {
    if (!enabled || !configurationId) {
      setRead({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    setRead({ state: "loading" });
    readRunningDevices(configurationId, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setRead({ state: "ready", data });
      },
      () => {
        if (!controller.signal.aborted) setRead({ state: "failed" });
      },
    );
    return () => controller.abort();
  }, [configurationId, enabled]);
  return read;
}
