import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnrollmentEvent } from "./api";
import { enrolledDeviceId, readWatchedDevices } from "./enrollmentWatch";

afterEach(() => vi.unstubAllGlobals());

const TOKEN = "token-1";
const DEVICE = "00000000-0000-4000-8000-000000000001";
const event = (extra: Partial<EnrollmentEvent> = {}): EnrollmentEvent => ({
  id: "e1",
  created_at: "2026-09-29T10:00:00.000Z",
  outcome: "success",
  reason_code: "",
  device_id: DEVICE,
  device_name: "edge-1",
  token_id: TOKEN,
  agent_os: "linux",
  agent_arch: "amd64",
  agent_version: "0.1.0",
  configuration_mode: "restricted",
  client_address: "203.0.113.5",
  ...extra,
});
const device = {
  id: DEVICE,
  name: "edge-1",
  status: "verified",
  apply_state: "verified_applied",
  desired_generation: 1,
  reported_generation: 1,
  configuration_mode: "restricted",
};
function serve(handler: (path: string) => Response) {
  const fetch = vi.fn(async (input: RequestInfo | URL) =>
    handler(String(input).replace(/^.*\/api\/v1/, "")),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const paths = (fetch: ReturnType<typeof serve>) =>
  fetch.mock.calls.map(([input]) => String(input).replace(/^.*\/api\/v1/, ""));
const read = (
  events: EnrollmentEvent[] | null,
  listAll = false,
): ReturnType<typeof readWatchedDevices> =>
  readWatchedDevices({
    events,
    tokenId: TOKEN,
    listAll,
    signal: new AbortController().signal,
  });

describe("the device an install command enrolled", () => {
  it("is named by the activity feed once the command's device enrolled", () => {
    expect(enrolledDeviceId([], TOKEN)).toBeNull();
    expect(enrolledDeviceId([event()], TOKEN)).toBe(DEVICE);
    // Other commands' devices and refusals do not count.
    expect(
      enrolledDeviceId(
        [
          event({ token_id: "other-token" }),
          event({ outcome: "failure", device_id: "" }),
        ],
        TOKEN,
      ),
    ).toBeNull();
  });
});

describe("what the Add device watch reads", () => {
  it("reads nothing about devices before the feed names one", async () => {
    const fetch = serve(() => new Response("[]"));
    expect(await read([])).toBeNull();
    expect(
      await read([event({ outcome: "failure", device_id: "" })]),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the one device the feed names, never the list", async () => {
    const fetch = serve(() => new Response(JSON.stringify(device)));
    expect(await read([event()])).toEqual([device]);
    expect(paths(fetch)).toEqual([`/devices/${DEVICE}`]);
  });

  it("lists the devices only on a server without the feed", async () => {
    const fetch = serve(() => new Response(JSON.stringify([device])));
    expect(await read(null, true)).toEqual([device]);
    expect(paths(fetch)).toEqual(["/devices"]);
  });

  it("treats a device that is gone as nothing to follow", async () => {
    serve(
      () =>
        new Response(JSON.stringify({ code: "NOT_FOUND", message: "gone" }), {
          status: 404,
        }),
    );
    expect(await read([event()])).toEqual([]);
  });

  it("reports other failures so the watch can say so", async () => {
    serve(
      () =>
        new Response(JSON.stringify({ code: "INTERNAL", message: "broken" }), {
          status: 500,
        }),
    );
    await expect(read([event()])).rejects.toMatchObject({ status: 500 });
  });
});
