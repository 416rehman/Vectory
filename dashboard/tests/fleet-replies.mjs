// Synthetic replies to the server's fleet-scale reads, for browser harnesses
// that isolate the dashboard from a server: the paged device inventory and its
// ids, one device with its groups, groups without their member lists, and a
// group's members a page at a time. They follow the server's rules (filters,
// natural name order, chip counts that follow the search, revoked devices only
// on request, unknown or repeated parameters refused) over whatever devices and
// groups the harness holds, so a harness edits its own lists and the replies
// follow. Test data only; nothing here says a device runs anything.
const BUCKETS = [
  "applied",
  "degraded",
  "held",
  "updating",
  "check",
  "failed",
  "offline",
  "paused",
  "unmanaged",
];
const VIEWS = [
  "failing",
  "not_on_desired",
  "offline",
  "paused",
  "no_telemetry",
];
const RANK = {
  failed: 0,
  degraded: 1,
  check: 2,
  held: 3,
  offline: 4,
  updating: 5,
  paused: 6,
  unmanaged: 7,
  applied: 8,
};
const FRESH_MS = 180_000;
const MAX_IDS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVENTORY = [
  "page",
  "page_size",
  "q",
  "status",
  "view",
  "group",
  "version",
  "desired_version",
  "running_version",
  "sort",
  "dir",
];
const IDS = INVENTORY.filter((key) => !key.startsWith("page"));

const reply = (json, status = 200) => ({ status, json });
const refuse = (message) =>
  reply({ error: { code: "INVALID_REQUEST", message } }, 400);
const missing = () =>
  reply({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);

/** Names in the order people expect: edge-2 before edge-10. */
export function natural(a, b) {
  const x =
    String(a)
      .toLowerCase()
      .match(/\d+|\D+/g) ?? [];
  const y =
    String(b)
      .toLowerCase()
      .match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (/^\d/.test(x[i]) && /^\d/.test(y[i])) {
      const m = x[i].replace(/^0+/, ""),
        n = y[i].replace(/^0+/, "");
      if (m.length !== n.length) return m.length - n.length;
      if (m !== n) return m < n ? -1 : 1;
    } else if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

const versionLabel = (row) => {
  if (!row.desired_version_id) return null;
  const version = row.desired_version || {};
  const label = [
    version.configuration_name,
    typeof version.number === "number" ? `v${version.number}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return label || "Assigned version";
};
const deliveryIssue = (row) => {
  const summary = row.data_plane;
  if (!summary?.version_id) return null;
  if (
    row.status !== "verified" ||
    row.desired_version_id !== summary.version_id
  )
    return null;
  return (summary.issues || []).find(
    (issue) => typeof issue.title === "string",
  );
};
/** The state a device's badge shows. */
export function displayStatus(row) {
  if (deliveryIssue(row)) return "degraded";
  // A failed newest version on a device that keeps running an earlier one.
  if (
    row.held_on_previous_version &&
    ["failed", "rolled_back"].includes(row.status)
  )
    return "held";
  if (
    row.status === "paused" &&
    !row.local_paused &&
    row.sync_paused &&
    !row.pause_acknowledged
  )
    return "pause_requested";
  return row.status;
}
export function bucketOf(display) {
  switch (display) {
    case "revoked":
      return null;
    case "verified":
      return "applied";
    case "degraded":
      return "degraded";
    case "held":
      return "held";
    case "verification_unknown":
      return "check";
    case "failed":
    case "rolled_back":
    case "conflict":
      return "failed";
    case "offline":
    case "awaiting_first_check_in":
      return "offline";
    case "paused":
    case "pause_requested":
      return "paused";
    case "unmanaged":
      return "unmanaged";
    default:
      return "updating";
  }
}
const runsDesired = (row) =>
  !!row.desired_version_id &&
  row.status !== "revoked" &&
  (row.status === "verified" ||
    (row.apply_state === "verified_applied" &&
      row.reported_generation === row.desired_generation &&
      ["offline", "paused"].includes(row.status)));

/**
 * @param {object} source
 * @param {object[] | (() => object[])} source.devices Device rows as the list shows them.
 * @param {object[] | (() => object[])} source.groups Full groups (with `device_ids`).
 * @param {() => number} [source.now]
 * @param {boolean} [source.groupById] Answer `GET /groups/{id}` too. A harness
 *   that scripts that read itself (failures, holds) turns it off.
 */
export function fleetReplies({
  devices,
  groups,
  now = () => Date.now(),
  groupById = true,
}) {
  const deviceRows = () =>
    typeof devices === "function" ? devices() : devices;
  const groupRows = () => (typeof groups === "function" ? groups() : groups);

  function project() {
    const at = now();
    const byGroup = new Map();
    const members = new Map();
    for (const group of groupRows())
      for (const id of new Set(group.device_ids || [])) {
        if (!members.has(id)) members.set(id, []);
        members.get(id).push(group);
      }
    const entries = deviceRows().map((row) => {
      const display = displayStatus(row);
      const bucket = bucketOf(display);
      const connection = !row.last_seen
        ? "never"
        : row.status === "offline"
          ? "offline"
          : "online";
      const sampled = Date.parse(row.telemetry?.sampled_at || "");
      const fresh = Number.isFinite(sampled) && at - sampled <= FRESH_MS;
      const revoked = row.status === "revoked";
      const views = new Set();
      if (!revoked) {
        if (
          [
            "failed",
            "rolled_back",
            "conflict",
            "verification_unknown",
          ].includes(row.status) ||
          bucket === "degraded"
        )
          views.add("failing");
        if (row.desired_version_id && !runsDesired(row))
          views.add("not_on_desired");
        if (connection !== "online") views.add("offline");
        if (row.status === "paused" || row.sync_paused || row.local_paused)
          views.add("paused");
        if (!fresh) views.add("no_telemetry");
      }
      const pipeline = versionLabel(row);
      const own = [
        row.name,
        row.os,
        row.arch,
        pipeline,
        row.vector_version,
        row.agent_version,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/[A-Z]/g, (c) => c.toLowerCase());
      const groupsOf = (members.get(row.id) || [])
        .slice()
        .sort((a, b) => natural(a.name, b.name) || (a.id < b.id ? -1 : 1));
      byGroup.set(row.id, groupsOf);
      return {
        row,
        revoked,
        display,
        bucket,
        views,
        pipeline,
        own,
        groups: groupsOf,
        search: [own, ...groupsOf.map((g) => String(g.name).toLowerCase())]
          .filter(Boolean)
          .join(" "),
        lastSeen: row.last_seen ? Date.parse(row.last_seen) : null,
        eventsIn: fresh ? (row.telemetry?.events_per_second ?? null) : null,
        running:
          row.running_version_id ??
          (runsDesired(row) ? row.desired_version_id : null),
      };
    });
    return { entries, byGroup };
  }

  /** Parse a query string the way the server does: known names, once each. */
  function options(params, allowed) {
    const seen = new Map();
    for (const [key, value] of params) {
      if (!allowed.includes(key) || seen.has(key))
        return { error: refuse("Invalid query parameters") };
      seen.set(key, value);
    }
    return { values: Object.fromEntries(seen) };
  }

  function filter(values) {
    const given = (key) => values[key] || "";
    const status = given("status");
    if (status && status !== "revoked" && !BUCKETS.includes(status))
      return {
        error: refuse(
          "status must be applied, degraded, held, updating, check, failed, offline, paused, unmanaged or revoked",
        ),
      };
    const view = given("view");
    if (view && !VIEWS.includes(view))
      return {
        error: refuse(
          "view must be failing, not_on_desired, offline, paused or no_telemetry",
        ),
      };
    const sort = given("sort") || "name";
    if (
      ![
        "name",
        "status",
        "last_seen",
        "pipeline",
        "version",
        "events_in",
      ].includes(sort)
    )
      return {
        error: refuse(
          "sort must be name, status, last_seen, pipeline, version or events_in",
        ),
      };
    const dir = given("dir");
    if (dir && dir !== "asc" && dir !== "desc")
      return { error: refuse("dir must be asc or desc") };
    for (const key of ["group", "desired_version", "running_version"])
      if (given(key) && !UUID.test(given(key)))
        return { error: refuse(`${key} must be a lowercase UUID`) };
    const q = given("q").trim();
    if ([...q].length > 100)
      return { error: refuse("Search must be at most 100 characters") };
    if ([...given("version")].length > 64)
      return { error: refuse("version must be at most 64 characters") };
    return {
      filter: {
        q: q.replace(/[A-Z]/g, (c) => c.toLowerCase()),
        status,
        view,
        group: given("group"),
        version: given("version"),
        desired: given("desired_version"),
        running: given("running_version"),
        sort,
        descending: dir
          ? dir === "desc"
          : sort === "last_seen" || sort === "events_in",
      },
    };
  }

  function select(entries, f) {
    const health = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    let revoked = 0;
    const views = Object.fromEntries(VIEWS.map((v) => [v, 0]));
    const matching = [];
    const groupOf = f.group
      ? groupRows().find((group) => group.id === f.group)
      : null;
    const inGroup = groupOf ? new Set(groupOf.device_ids || []) : null;
    for (const entry of entries) {
      const { row } = entry;
      if (f.q && !entry.search.includes(f.q)) continue;
      if (f.group && !inGroup?.has(row.id)) continue;
      if (f.version && row.vector_version !== f.version) continue;
      if (f.desired && row.desired_version_id !== f.desired) continue;
      if (f.running && entry.running !== f.running) continue;
      if (entry.bucket === null) revoked += 1;
      else health[entry.bucket] += 1;
      for (const view of entry.views) views[view] += 1;
      const chip =
        f.status === ""
          ? !entry.revoked
          : f.status === "revoked"
            ? entry.revoked
            : entry.bucket === f.status;
      if (chip && (!f.view || entry.views.has(f.view))) matching.push(entry);
    }
    // Missing values stay last in both directions.
    const present = (a, b, order) => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      const result = order(a, b);
      return f.descending ? -result : result;
    };
    const compare = (a, b) =>
      (f.sort === "name"
        ? present(a.row.name, b.row.name, natural)
        : f.sort === "status"
          ? present(
              a.bucket === null ? 9 : RANK[a.bucket],
              b.bucket === null ? 9 : RANK[b.bucket],
              (x, y) => x - y,
            )
          : f.sort === "last_seen"
            ? present(a.lastSeen, b.lastSeen, (x, y) => x - y)
            : f.sort === "pipeline"
              ? present(a.pipeline, b.pipeline, natural)
              : f.sort === "version"
                ? present(a.row.vector_version, b.row.vector_version, natural)
                : present(a.eventsIn, b.eventsIn, (x, y) => x - y)) ||
      natural(a.row.name, b.row.name) ||
      (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0);
    matching.sort(compare);
    return {
      matching,
      counts: { status: { ...health, revoked }, views },
    };
  }

  const pageBounds = (values) => {
    const page = values.page === undefined ? 1 : Number(values.page);
    const size = values.page_size === undefined ? 50 : Number(values.page_size);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 100
    )
      return {
        error: refuse(
          "page must be a positive safe integer and page_size must be 1..100",
        ),
      };
    return { page, size };
  };
  const refs = (list, limit) => ({
    total: list.length,
    items: list.slice(0, limit).map(({ id, name }) => ({ id, name })),
  });

  return {
    /**
     * The reply to a fleet read, or null when the request isn't one. `url` is a
     * WHATWG URL of the request.
     */
    handle(method, url) {
      if (method !== "GET") return null;
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const params = [...url.searchParams];
      if (path === "/devices/inventory") {
        const { values, error } = options(params, INVENTORY);
        if (error) return error;
        const bounds = pageBounds(values);
        if (bounds.error) return bounds.error;
        const parsed = filter(values);
        if (parsed.error) return parsed.error;
        const { entries } = project();
        const { matching, counts } = select(entries, parsed.filter);
        const shown = matching.slice(
          (bounds.page - 1) * bounds.size,
          bounds.page * bounds.size,
        );
        return reply({
          items: shown.map((entry) => entry.row),
          total: matching.length,
          page: bounds.page,
          page_size: bounds.size,
          counts,
          device_groups: Object.fromEntries(
            shown.map((entry) => [entry.row.id, refs(entry.groups, 10)]),
          ),
        });
      }
      if (path === "/devices/inventory/ids") {
        const { values, error } = options(params, IDS);
        if (error) return error;
        const parsed = filter(values);
        if (parsed.error) return parsed.error;
        const { matching } = select(project().entries, parsed.filter);
        return reply({
          ids: matching.slice(0, MAX_IDS).map((entry) => entry.row.id),
          total: matching.length,
          truncated: matching.length > MAX_IDS,
        });
      }
      let found = path.match(/^\/devices\/([^/]+)$/);
      if (found) {
        const { values, error } = options(params, ["include"]);
        if (error) return error;
        if (values.include !== undefined && values.include !== "groups")
          return refuse("include must be groups");
        const { entries } = project();
        const entry = entries.find(
          (candidate) => candidate.row.id === decodeURIComponent(found[1]),
        );
        if (!entry) return missing();
        return reply(
          values.include
            ? { ...entry.row, groups: refs(entry.groups, 100) }
            : entry.row,
        );
      }
      if (path === "/groups") {
        const { values, error } = options(params, ["slim", "include"]);
        if (error) return error;
        if (!["1", "true"].includes(values.slim)) return null;
        return reply(
          groupRows().map(({ device_ids, ...group }) => ({
            ...group,
            member_count: (device_ids || []).length,
          })),
        );
      }
      found = path.match(/^\/groups\/([^/]+)\/members$/);
      if (found) {
        const { values, error } = options(params, ["page", "page_size", "q"]);
        if (error) return error;
        const bounds = pageBounds(values);
        if (bounds.error) return bounds.error;
        const group = groupRows().find(
          (candidate) => candidate.id === decodeURIComponent(found[1]),
        );
        if (!group) return missing();
        const q = (values.q || "").trim().toLowerCase();
        const { entries } = project();
        const byId = new Map(entries.map((entry) => [entry.row.id, entry]));
        const list = [...new Set(group.device_ids || [])]
          .map((id) => [id, byId.get(id)])
          .filter(([, entry]) => !q || (entry && entry.own.includes(q)))
          .sort(([a, x], [b, y]) =>
            x && y
              ? natural(x.row.name, y.row.name) || (a < b ? -1 : 1)
              : !x - !y || (a < b ? -1 : 1),
          );
        return reply({
          items: list
            .slice((bounds.page - 1) * bounds.size, bounds.page * bounds.size)
            .map(([id, entry]) =>
              entry
                ? { id, name: entry.row.name, status: entry.display }
                : { id, name: null, status: "unavailable" },
            ),
          total: list.length,
          page: bounds.page,
          page_size: bounds.size,
        });
      }
      found = path.match(/^\/groups\/([^/]+)$/);
      if (
        groupById &&
        found &&
        !["requests", "membership-preview"].includes(found[1])
      ) {
        const group = groupRows().find(
          (candidate) => candidate.id === decodeURIComponent(found[1]),
        );
        if (!group) return missing();
        return reply({ revision: 1, ...group });
      }
      return null;
    },
  };
}

/**
 * `GET /overview?slim=1` for the devices given: the fleet as numbers, with
 * nothing per device. Counts follow the same rules as the inventory. Anything
 * in `extra` replaces the computed value (an empty list of rollouts, a
 * configuration count, what runs where).
 */
export function slimOverview(deviceRows, extra = {}, at = Date.now()) {
  const live = deviceRows.filter((row) => row.status !== "revoked");
  const health = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0]));
  const connection = { online: 0, offline: 0, never: 0 };
  const telemetry = {
    eligible: 0,
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
  };
  let checkedIn = 0,
    managed = 0,
    onDesired = 0;
  let waiting = null;
  const busiest = [];
  for (const row of live) {
    const bucket = bucketOf(displayStatus(row));
    if (bucket) health[bucket] += 1;
    if (!row.last_seen) {
      connection.never += 1;
      waiting ??= { id: row.id, name: row.name };
    } else {
      checkedIn += 1;
      connection[row.status === "offline" ? "offline" : "online"] += 1;
    }
    if (row.desired_version_id) {
      managed += 1;
      if (runsDesired(row)) onDesired += 1;
    }
    if (row.effective_policy?.telemetry_enabled === false) {
      telemetry.disabled += 1;
      continue;
    }
    if (!row.last_seen) continue;
    telemetry.eligible += 1;
    const sampled = Date.parse(row.telemetry?.sampled_at || "");
    if (!Number.isFinite(sampled) || at - sampled > FRESH_MS) {
      telemetry.stale += 1;
      continue;
    }
    telemetry.reporting += 1;
    if (
      !telemetry.newest_sample_at ||
      row.telemetry.sampled_at > telemetry.newest_sample_at
    )
      telemetry.newest_sample_at = row.telemetry.sampled_at;
    if (typeof row.telemetry.events_per_second === "number") {
      telemetry.events_in_per_second =
        (telemetry.events_in_per_second ?? 0) + row.telemetry.events_per_second;
      telemetry.events_in_devices += 1;
      busiest.push({
        id: row.id,
        name: row.name,
        events_in_per_second: row.telemetry.events_per_second,
        events_out_per_second:
          typeof row.telemetry.events_out_per_second === "number"
            ? row.telemetry.events_out_per_second
            : null,
      });
    }
    if (typeof row.telemetry.events_out_per_second === "number") {
      telemetry.events_out_per_second =
        (telemetry.events_out_per_second ?? 0) +
        row.telemetry.events_out_per_second;
      telemetry.events_out_devices += 1;
    }
  }
  return {
    counts: {
      total: live.length,
      health,
      connection,
      checked_in: checkedIn,
      waiting_device: waiting,
      telemetry,
    },
    attention_devices: [],
    attention_devices_total: 0,
    busiest: busiest
      .sort((a, b) => b.events_in_per_second - a.events_in_per_second)
      .slice(0, 5),
    running: [],
    running_total: 0,
    devices_total: live.length,
    devices_online: connection.online,
    configurations_total: 0,
    deployments_active: 0,
    issues_open: 0,
    recent_activity: [],
    devices_managed: managed,
    devices_on_desired: onDesired,
    devices_degraded: health.degraded,
    devices_unmeasured: 0,
    versions_total: 0,
    rollouts: [],
    attention: [],
    fleet_activity: [],
    security_events_hidden: 0,
    ...extra,
  };
}

/**
 * Fulfil a Playwright route with the reply, when it is a fleet read.
 * Returns true when it did.
 */
export async function fulfillFleetRead(replies, route) {
  const request = route.request();
  const answer = replies.handle(request.method(), new URL(request.url()));
  if (!answer) return false;
  try {
    await route.fulfill({ status: answer.status, json: answer.json });
  } catch {
    // The page was closed while this read was pending.
  }
  return true;
}
