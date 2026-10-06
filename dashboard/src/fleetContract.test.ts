import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  DeviceInventoryIdsSchema,
  DeviceInventoryPageSchema,
  GroupMemberPageSchema,
  GroupSummarySchema,
  OverviewFleetSchema,
} from "./api";

afterEach(() => vi.unstubAllGlobals());
const reply = (...values: unknown[]) => {
  const fetch = vi.fn();
  for (const value of values)
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(value)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const device = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "edge-1",
  status: "verified",
  apply_state: "verified_applied",
  desired_generation: 1,
  reported_generation: 1,
  configuration_mode: "restricted",
};
const counts = {
  status: {
    applied: 1,
    degraded: 0,
    held: 0,
    updating: 0,
    check: 0,
    failed: 0,
    offline: 0,
    paused: 0,
    unmanaged: 0,
    revoked: 2,
  },
  views: {
    failing: 0,
    not_on_desired: 0,
    offline: 0,
    paused: 0,
    no_telemetry: 1,
  },
};
const page = {
  items: [device],
  total: 1,
  page: 1,
  page_size: 50,
  counts,
  device_groups: {
    [device.id]: {
      total: 1,
      items: [{ id: "00000000-0000-4000-8000-0000000000a1", name: "Edge" }],
    },
  },
};

describe("fleet-scale responses", () => {
  it("reads the inventory as a list, not as the device called inventory", async () => {
    reply(page, { ...page, items: [{ ...device, id: "someone-else" }] });
    expect(await api("/devices/inventory?q=edge&page=1")).toEqual(page);
    // Rows keep the device fields the dashboard doesn't name yet.
    expect(
      await api<typeof page>("/devices/inventory?q=edge&page=1"),
    ).toMatchObject({ items: [{ id: "someone-else" }] });
    // A device read is still bound to the requested device.
    reply({ ...device, id: "00000000-0000-4000-8000-000000000002" });
    await expect(api(`/devices/${device.id}`)).rejects.toMatchObject({
      code: "IDENTITY_MISMATCH",
    });
  });
  it("rejects pages that break the envelope's bounds", () => {
    expect(DeviceInventoryPageSchema.safeParse(page).success).toBe(true);
    for (const broken of [
      { ...page, page_size: 101 },
      { ...page, items: Array(101).fill(device) },
      { ...page, counts: { ...counts, status: { applied: 1 } } },
      {
        ...page,
        device_groups: {
          [device.id]: {
            total: 11,
            items: Array(11).fill({ id: "g", name: "Group" }),
          },
        },
      },
    ])
      expect(DeviceInventoryPageSchema.safeParse(broken).success).toBe(false);
    expect(
      DeviceInventoryIdsSchema.safeParse({
        ids: Array(10001).fill(device.id),
        total: 10001,
        truncated: true,
      }).success,
    ).toBe(false);
  });
  it("validates ids, members and member-free group rows by route", async () => {
    const ids = { ids: [device.id], total: 1, truncated: false };
    const members = {
      items: [
        { id: device.id, name: "edge-1", status: "degraded" },
        {
          id: "00000000-0000-4000-8000-000000000009",
          name: null,
          status: "unavailable",
        },
      ],
      total: 2,
      page: 1,
      page_size: 50,
    };
    const summary = {
      id: "00000000-0000-4000-8000-0000000000a1",
      name: "Edge",
      description: "",
      revision: 3,
      member_count: 4,
    };
    reply(ids, members, [summary], [summary]);
    expect(await api("/devices/inventory/ids?view=failing")).toEqual(ids);
    expect(await api(`/groups/${summary.id}/members?page=1&q=edge`)).toEqual(
      members,
    );
    expect(await api("/groups?slim=1")).toEqual([summary]);
    // Without slim, a group row still needs its members.
    await expect(api("/groups")).rejects.toMatchObject({
      code: "CONTRACT_MISMATCH",
    });
    expect(
      GroupSummarySchema.safeParse({ ...summary, member_count: -1 }).success,
    ).toBe(false);
    expect(
      GroupMemberPageSchema.safeParse({ ...members, page_size: 0 }).success,
    ).toBe(false);
  });
  it("describes the Overview's fleet numbers without inventing zeros", () => {
    const fleet = {
      counts: {
        total: 3,
        health: {
          applied: 1,
          degraded: 1,
          held: 0,
          updating: 0,
          check: 0,
          failed: 0,
          offline: 1,
          paused: 0,
          unmanaged: 0,
        },
        connection: { online: 2, offline: 0, never: 1 },
        checked_in: 2,
        waiting_device: {
          id: "00000000-0000-4000-8000-000000000003",
          name: "new-1",
        },
        telemetry: {
          eligible: 3,
          reporting: 0,
          stale: 0,
          disabled: 0,
          events_in_per_second: null,
          events_in_devices: 0,
          events_out_per_second: null,
          events_out_devices: 0,
          errors: null,
          errors_per_minute: null,
          newest_sample_at: null,
        },
      },
      attention_devices: [
        {
          id: device.id,
          name: "edge-1",
          cause: "degraded",
          status: "degraded",
          reason: "The http sink out is failing about 12 requests a minute.",
          title: "out can't deliver events",
          fix: "Check the destination.",
          code: "DATA_PLANE_SINK_ERRORS",
          component_id: "out",
          since: "2026-09-29T00:00:00Z",
          version_id: "00000000-0000-4000-8000-0000000000b1",
          version_number: 3,
          configuration_id: "00000000-0000-4000-8000-0000000000c1",
          configuration_name: "Edge syslog",
        },
      ],
      attention_devices_total: 1,
      busiest: [],
      running: [
        {
          configuration_id: "00000000-0000-4000-8000-0000000000c1",
          configuration_name: "Edge syslog",
          version_id: "00000000-0000-4000-8000-0000000000b1",
          version: 3,
          device_count: 2,
          devices_reporting: 0,
          groups: [{ id: "g", name: "Edge", device_count: 2 }],
          more_groups: 0,
          events_in_per_second: null,
          events_out_per_second: null,
          state: "canary",
          not_delivering: 0,
          canary: {
            deployment_id: "00000000-0000-4000-8000-0000000000d1",
            phase: "measuring",
            device_count: 1,
            device_names: ["edge-1"],
          },
        },
      ],
      running_total: 1,
    };
    expect(OverviewFleetSchema.parse(fleet)).toEqual(fleet);
    const held = { ...fleet.running[0], state: "held" };
    expect(
      OverviewFleetSchema.safeParse({ ...fleet, running: [held] }).success,
    ).toBe(false);
  });
});
