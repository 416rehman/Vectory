// What the Add device watch reads while it waits for a host to connect.
import {
  APIError,
  api,
  withRequestDeadline,
  type Device,
  type EnrollmentEvent,
} from "./api";
import { eventsFor } from "./enrollmentActivity";

/** The device this command enrolled, once the activity feed names it. */
export function enrolledDeviceId(events: EnrollmentEvent[], tokenId: string) {
  return (
    eventsFor(events, tokenId)
      .filter((event) => event.outcome === "success" && event.device_id)
      .at(-1)?.device_id ?? null
  );
}

const DEADLINE_MS = 30000;

/**
 * The devices to follow on one poll. The activity feed names the device the
 * command enrolled, so only that device is read: one small record, not the
 * fleet, every two seconds. A server without the feed can't say which device
 * is new and still lists them all. Null while there is nothing to follow.
 */
export async function readWatchedDevices({
  events,
  tokenId,
  listAll,
  signal,
}: {
  /** The activity feed's events; null when this server has no feed. */
  events: EnrollmentEvent[] | null;
  tokenId: string;
  listAll: boolean;
  signal: AbortSignal;
}): Promise<Device[] | null> {
  if (listAll)
    return withRequestDeadline(
      (inner) => api<Device[]>("/devices", { signal: inner }),
      DEADLINE_MS,
      signal,
    );
  const id = events ? enrolledDeviceId(events, tokenId) : null;
  if (!id) return null;
  try {
    return [
      await withRequestDeadline(
        (inner) =>
          api<Device>(`/devices/${encodeURIComponent(id)}`, { signal: inner }),
        DEADLINE_MS,
        signal,
      ),
    ];
  } catch (error) {
    // A device that is gone is not there to follow; that is not a failure.
    if (error instanceof APIError && error.status === 404) return [];
    throw error;
  }
}
