// What the platform checks ask of one installation of the agent as a service:
// its status from the agent itself, its device record from the server, and the
// wait until it is back after a restart, a kill, a stop or a unit swap.
import { adapterFor, agentProcesses, describeProcesses } from "./adapters.mjs";
import { checkedIn } from "./instance.mjs";
import { run, until } from "./lib.mjs";

/** `vectory status --json`, read as an administrator. */
export const readStatus = (context) =>
  JSON.parse(
    run(context.agent, ["status", "--state-dir", context.stateDir, "--json"], {
      elevated: true,
      quiet: true,
    }).stdout,
  );

/**
 * The same, or null with the reason printed when the administrator cannot read
 * it: on Windows the service writes its files for itself and SYSTEM only. What
 * the server reports about the device then stands in for it.
 */
const said = new Set();
export function tryStatus(context) {
  try {
    return readStatus(context);
  } catch (error) {
    const reason = String(error.message).split("\n")[0];
    if (!said.has(reason)) {
      said.add(reason);
      console.log(`  The agent's local status is not readable here: ${reason}`);
    }
    return null;
  }
}

export function bind(context, api) {
  const adapter = adapterFor(context);
  const status = () => readStatus(context);
  /** The server's record of the device. */
  const device = () => api(`/devices/${context.deviceId}`);

  // The apply phase removes its assignments at the end, so the device is
  // unmanaged and keeps running the pipeline it last verified.
  const runsItsPipeline = (row) =>
    ["verified_applied", "unmanaged"].includes(row.apply_state) &&
    Boolean(row.actual_sha256);
  /**
   * Waits until the service is back: the manager reports it running, the server
   * saw a check-in at or after `sinceMs` and shows the pipeline verified (or kept after its
   * assignments were removed) with its last known good digest (the managed file as the agent reports it), is
   * not told Vector stopped, exactly one supervisor and one Vector run and none
   * is among `oldVectors`. When the agent's local status is readable it must
   * agree: the same last known good, and no drift.
   */
  async function settled(what, sinceMs, { lastGood, oldVectors = [] }) {
    await until(
      `${what}: the device is online again, Vector runs, and the last known good is intact`,
      async () => {
        if (!adapter.state().running) return false;
        const row = await device();
        const { vectors, supervisors } = agentProcesses();
        if (!(
          checkedIn(row, sinceMs) &&
          runsItsPipeline(row) &&
          row.actual_sha256 === lastGood &&
          row.vector_running !== false &&
          vectors.length === 1 &&
          supervisors.length === 1 &&
          !vectors.some((v) => oldVectors.includes(v.pid))
        ))
          return false;
        const local = tryStatus(context);
        return (
          !local ||
          (local.state?.last_good_sha256 === lastGood && local.drift === false)
        );
      },
      {
        timeoutMs: 150000,
        intervalMs: 2000,
        describe: async () => {
          const row = await device();
          return `${adapter.describe()}\ndevice: status=${row.status} apply_state=${row.apply_state} actual=${row.actual_sha256} last_seen=${row.last_seen} vector_running=${row.vector_running}\nexpected last known good: ${lastGood}\n${describeProcesses()}`;
        },
      },
    );
  }
  return { adapter, status, device, settled };
}
