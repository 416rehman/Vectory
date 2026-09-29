// A synthetic fleet seeded directly into a disposable Vectory database, for
// measuring the dashboard's reads at fleet size. Test data only: it refuses a
// database that already holds devices, pipelines or groups, and every device
// carries the label fixture=fleet-scale. Nothing here enrolls a device, runs
// Vector or proves activation; "verified_applied" is fixture input.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const hash = (text) => createHash("sha256").update(text).digest("hex");
/** Stable UUIDv4-shaped identifiers, so two seeded copies are identical. */
export function fixtureId(kind, n) {
  const h = hash(`vectory-fleet-fixture:${kind}:${n}`);
  const variant = (8 + (parseInt(h[16], 16) & 3)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const roles = [
  "edge",
  "web",
  "db",
  "k8s-node",
  "cache",
  "gateway",
  "batch",
  "api",
];
const regions = [
  "eu-west-1",
  "eu-central-1",
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ap-south-1",
  "ap-northeast-1",
  "sa-east-1",
  "ca-central-1",
  "af-south-1",
];
/** Device names: `web-01234`. The number is the device's index. */
export const deviceName = (n) =>
  `${roles[n % roles.length]}-${String(n).padStart(5, "0")}`;

const pipelines = [
  ["syslog", "Edge syslog", 2],
  ["web", "Web access logs", 2],
  ["k8s", "Kubernetes events", 1],
  ["metrics", "Metrics relay", 1],
  ["audit", "Audit forwarder", 1],
  ["firewall", "Firewall logs", 3],
];
const config = (name, number) => ({
  sinks: {
    out: {
      encoding: { codec: "json" },
      inputs: ["parse"],
      type: "http",
      uri: "https://collector.example.test/ingest",
    },
  },
  sources: { input: { include: [`/var/log/${name}/*.log`], type: "file" } },
  transforms: {
    parse: {
      inputs: ["input"],
      source: `. = parse_json!(.message)\n.pipeline_version = ${number}`,
      type: "remap",
    },
  },
});

/** A reporting device's latest sample: ten components. */
function telemetry(at, rate) {
  const components = Array.from({ length: 10 }, (_, n) => ({
    id: `component_${n}`,
    type: n < 3 ? "file" : n < 7 ? "remap" : "http",
    kind: n < 3 ? "source" : n < 7 ? "transform" : "sink",
    events_per_second: rate,
    received_events_per_second: rate,
    received_bytes_per_second: rate * 200,
    sent_bytes_per_second: rate * 180,
    errors: 0,
    errors_per_minute: 0,
    discarded_events: 0,
    discarded_intentional: 0,
    discarded_error: 0,
    filtered_per_minute: 0,
    dropped_per_minute: 0,
    buffer_events: 0,
    buffer_bytes: 0,
    buffer_utilization: 0.01,
    utilization: 0.2,
    sent_by_output: { _default: rate },
  }));
  return {
    sampled_at: at,
    events_per_second: rate,
    events_out_per_second: rate * 0.98,
    bytes_in_per_second: rate * 200,
    bytes_out_per_second: rate * 180,
    errors: 0,
    errors_per_minute: 0,
    uptime_seconds: 86400,
    memory_bytes: 104857600,
    cpu_seconds: 1200.5,
    components,
  };
}
function logs(at, count) {
  return {
    reported_at: at,
    items: Array.from({ length: count }, (_, n) => ({
      fingerprint: n.toString(16).padStart(16, "0"),
      level: "warn",
      component_id: `component_${7 + (n % 3)}`,
      component_kind: "sink",
      component_type: "http",
      error_type: "request_failed",
      stage: "sending",
      reason: "timeout",
      count: n + 1,
      first_seen: at,
      last_seen: at,
      message: "Service call failed. No retries or retries exhausted. ".repeat(
        4,
      ),
    })),
  };
}
const runtime = {
  data_dir: "/var/lib/vector",
  data_dir_source: "pipeline",
  graceful_shutdown_seconds: 60,
  metrics_source: "explicit",
  metrics_address: "127.0.0.1:9598",
  activation: "reload",
};

/**
 * Seed `devices` devices and `groups` groups (at least 64) into the database
 * at `file`, which the server has already created and migrated. Twenty device
 * shapes repeat: healthy, not delivering, updating, offline, failed, check
 * required, paused, unmanaged, never connected and revoked, across six
 * pipelines, an all-at-once rollout, a canary, a persistent assignment and
 * finished rollouts. `actor` is the user named as the rollouts' creator.
 */
export function seedFleet(
  file,
  { devices = 5000, groups = 500, actor = null, now = new Date() } = {},
) {
  if (groups < 64) throw Error("The fixture needs at least 64 groups");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000");
  const existing = db
    .prepare(
      "SELECT (SELECT count(*) FROM devices) + (SELECT count(*) FROM records WHERE kind IN ('configuration','group','deployment')) AS n",
    )
    .get().n;
  if (existing) {
    db.close();
    throw Error(
      "Refusing to seed a database that already has devices, pipelines, groups or rollouts",
    );
  }
  const at = now.toISOString().replace(/\.\d+Z$/, "Z");
  const earlier = new Date(now.getTime() - 3 * 86400_000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const stale = new Date(now.getTime() - 2 * 86400_000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const record = db.prepare(
    "INSERT INTO records(kind,id,data,created_at) VALUES(?,?,?,?)",
  );
  const device = db.prepare(
    "INSERT INTO devices(id,name,data,revoked,desired_version_id,desired_generation,policy,policy_generation,assignment_id) VALUES(?,?,?,?,?,?,?,0,?)",
  );
  const target = db.prepare(
    "INSERT INTO deployment_targets(deployment_id,device_id,state,generation,previous_version_id,released_at,verified_at,error) VALUES(?,?,?,?,?,?,?,?)",
  );
  db.exec("BEGIN");
  try {
    const version = {};
    for (const [key, name, count] of pipelines) {
      const id = fixtureId("pipeline", key);
      record.run(
        "configuration",
        id,
        JSON.stringify({
          id,
          name,
          description: "Synthetic fleet-scale fixture",
          revision: count,
          created_at: earlier,
          updated_at: earlier,
          archived: false,
          config: config(key, count),
          graph: { nodes: [], edges: [] },
        }),
        earlier,
      );
      for (let number = 1; number <= count; number++) {
        // The published artifact the agent downloads: the configuration as
        // pretty JSON with sorted keys, as the server renders it. Stored
        // without `variables`, like a version published before pipelines had
        // variables; the server reads that as none.
        const configuration = config(key, number);
        const artifact = JSON.stringify(configuration, null, 2) + "\n";
        const v = {
          id: fixtureId("version", `${key}-${number}`),
          configuration_id: id,
          number,
          graph: { nodes: [], edges: [] },
          config: configuration,
          artifact,
          sha256: hash(artifact),
          size: artifact.length,
          created_at: earlier,
          message: `Synthetic version ${number}`,
          author: "Fleet measurement",
          author_id: actor,
          source_revision: number,
          validation: { valid: true, errors: [], warnings: [] },
          uses_local_secrets: false,
        };
        version[`${key}${number}`] = v;
        record.run("version", v.id, JSON.stringify(v), earlier);
      }
    }
    const rollout = (kind, size, observation, threshold) => ({
      kind,
      canary_size: size,
      batch_size: 50,
      observation_seconds: observation,
      failure_threshold: threshold,
    });
    const selector = (groupIds = []) => ({
      device_ids: [],
      group_ids: groupIds,
      exclude_ids: [],
    });
    const metricsGroup = fixtureId("group", 11);
    const deployments = {
      // An all-at-once rollout still converging, a canary measuring its
      // first wave, a persistent assignment following a group, finished and
      // failed rollouts.
      syslog: {
        version: version.syslog2,
        status: "active",
        priority: 100,
        target_mode: "snapshot",
        selector: selector(),
        rollout: rollout("all", 1, 0, 0),
      },
      web: {
        version: version.web1,
        status: "completed",
        priority: 100,
        target_mode: "snapshot",
        selector: selector(),
        rollout: rollout("all", 1, 0, 0),
      },
      canary: {
        version: version.web2,
        status: "active",
        priority: 200,
        target_mode: "snapshot",
        selector: selector(),
        rollout: rollout("canary", 5, 3600, 0),
      },
      k8s: {
        version: version.k8s1,
        status: "completed",
        priority: 100,
        target_mode: "snapshot",
        selector: selector(),
        rollout: rollout("all", 1, 0, 0),
      },
      metrics: {
        version: version.metrics1,
        status: "completed",
        priority: 100,
        target_mode: "persistent",
        selector: selector([metricsGroup]),
        rollout: rollout("all", 1, 0, 0),
      },
      firewall: {
        version: version.firewall3,
        status: "failed",
        priority: 100,
        target_mode: "snapshot",
        selector: selector(),
        rollout: rollout("all", 1, 0, 0),
        failure_reason: "threshold",
        failed_at: earlier,
      },
    };
    for (const [key, d] of Object.entries(deployments)) {
      d.id = fixtureId("deployment", key);
      const { version: v, ...rest } = d;
      record.run(
        "deployment",
        d.id,
        JSON.stringify({
          ...rest,
          version_id: v.id,
          created_at: earlier,
          created_by: actor,
        }),
        earlier,
      );
    }
    const issue = {
      issue_id: null,
      code: "DATA_PLANE_SINK_ERRORS",
      component_id: "component_9",
      component_kind: "sink",
      title: "component_9 can't deliver events",
      message:
        "The http sink component_9 is failing about 12 requests a minute.",
      hint: "Check the destination.",
      since: at,
    };
    const live = [];
    const metricsMembers = [];
    let canaryReleased = 0;
    for (let n = 0; n < devices; n++) {
      const id = fixtureId("device", n);
      const name = deviceName(n);
      const shape = n % 20;
      const rate = 20 + (n % 97) * 3;
      const data = {
        id,
        name,
        os: n % 25 === 3 ? "windows" : "linux",
        arch: n % 3 === 0 ? "arm64" : "amd64",
        agent_version: n % 11 === 0 ? "1.4.1" : "1.4.2",
        vector_version: n % 7 === 0 ? "0.57.1" : "0.58.0",
        labels: { fixture: "fleet-scale", region: regions[n % regions.length] },
        created_at: earlier,
        configuration_mode: "restricted",
        secret_revision: 0,
        uses_local_secrets: false,
        policy_generation: 0,
        local_paused: false,
        pause_acknowledged: false,
      };
      let desired = null,
        generation = 0,
        assignment = null,
        paused = false,
        revoked = 0;
      const targets = [];
      const report = (v, g = 1) => {
        Object.assign(data, {
          last_seen: at,
          reported_generation: g,
          actual_sha256: v.sha256,
          verified_effective_sha256: v.sha256,
          verified_secret_revision: 0,
          verified_configuration_attempt: {
            generation: g,
            version_id: v.id,
            sha256: v.sha256,
            secret_revision: 0,
          },
          configuration_attempt: {
            generation: g,
            version_id: v.id,
            sha256: v.sha256,
            state: "verified_applied",
            secret_revision: 0,
          },
          reported_apply_state: "verified_applied",
          apply_state: "verified_applied",
          telemetry: telemetry(at, rate),
          host_runtime: runtime,
          vector_log_summary: logs(at, 0),
          data_plane: { version_id: v.id, evaluations: 3, issues: [] },
        });
      };
      const assign = (key, v, state, g = 1, previous = null) => {
        desired = v.id;
        generation = g;
        assignment = deployments[key].id;
        data.desired_artifact_sha256 = v.sha256;
        targets.push([deployments[key].id, state, g, previous]);
      };
      switch (shape) {
        case 6: // applied, not delivering
          report(version.syslog2);
          data.data_plane.issues = [issue];
          data.vector_log_summary = logs(at, 5);
          assign("syslog", version.syslog2, "verified_applied");
          break;
        case 7: // updating: still runs version 1
          report(version.syslog1);
          Object.assign(data, {
            apply_state: "downloaded",
            reported_apply_state: "downloaded",
          });
          assign("syslog", version.syslog2, "desired", 2, version.syslog1.id);
          break;
        case 8:
        case 9: // Kubernetes events; shape 9 stopped checking in
          report(version.k8s1);
          if (shape === 9) {
            data.last_seen = stale;
            data.telemetry.sampled_at = stale;
          }
          assign("k8s", version.k8s1, "verified_applied");
          break;
        case 10: // metrics relays, assigned through their group
          report(version.metrics1);
          assign("metrics", version.metrics1, "verified_applied");
          metricsMembers.push(id);
          break;
        case 18: // check required on the metrics relay
          Object.assign(data, {
            last_seen: at,
            reported_generation: 1,
            actual_sha256: null,
            configuration_attempt: {
              generation: 1,
              version_id: version.metrics1.id,
              sha256: version.metrics1.sha256,
              state: "verification_unknown",
              secret_revision: 0,
            },
            reported_apply_state: "verification_unknown",
            apply_state: "verification_unknown",
            telemetry: null,
            host_runtime: runtime,
            vector_log_summary: logs(at, 2),
          });
          assign("metrics", version.metrics1, "verification_unknown");
          metricsMembers.push(id);
          break;
        case 11:
        case 12: // web access logs; five of shape 11 are the canary's first wave
          if (shape === 11 && canaryReleased < 5) {
            canaryReleased++;
            report(version.web2, 2);
            assign(
              "canary",
              version.web2,
              "verified_applied",
              2,
              version.web1.id,
            );
            targets.push([deployments.web.id, "verified_applied", 1, null]);
          } else {
            report(version.web1);
            assign("web", version.web1, "verified_applied");
            if (shape === 11)
              targets.push([deployments.canary.id, "pending", 0, null]);
          }
          break;
        case 13: // failed on the firewall rollout
          Object.assign(data, {
            last_seen: at,
            reported_generation: 0,
            configuration_attempt: {
              generation: 1,
              version_id: version.firewall3.id,
              sha256: version.firewall3.sha256,
              state: "failed",
              secret_revision: 0,
              error: {
                code: "VALIDATION_FAILED",
                stage: "validation",
                message: 'data_dir "/var/lib/vector" does not exist',
              },
            },
            reported_apply_state: "failed",
            apply_state: "failed",
            telemetry: null,
            host_runtime: runtime,
            vector_log_summary: logs(at, 3),
          });
          assign("firewall", version.firewall3, "failed");
          break;
        case 14: // applied on the failed firewall rollout
          report(version.firewall3);
          assign("firewall", version.firewall3, "verified_applied");
          break;
        case 15: // unmanaged, reporting its local Vector
          Object.assign(data, {
            last_seen: at,
            reported_generation: 0,
            apply_state: "unmanaged",
            telemetry: n % 40 === 15 ? null : telemetry(at, rate),
            host_runtime: runtime,
          });
          break;
        case 16: // enrolled, never checked in
          Object.assign(data, {
            reported_generation: 0,
            apply_state: "unmanaged",
          });
          break;
        case 17: // paused while running the syslog rollout
          report(version.syslog2);
          Object.assign(data, { pause_acknowledged: true });
          paused = true;
          assign("syslog", version.syslog2, "verified_applied");
          break;
        case 19: // revoked
          report(version.syslog2);
          revoked = 1;
          break;
        default: // 0-5: healthy on the syslog rollout
          report(version.syslog2);
          assign("syslog", version.syslog2, "verified_applied");
      }
      device.run(
        id,
        name,
        JSON.stringify(data),
        revoked,
        desired,
        generation,
        JSON.stringify({
          heartbeat_seconds: 60,
          sync_paused: paused,
          telemetry_enabled: true,
        }),
        assignment,
      );
      for (const [deployment, state, g, previous] of targets)
        target.run(
          deployment,
          id,
          state,
          g,
          previous,
          g ? earlier : null,
          state === "verified_applied" ? earlier : null,
          state === "failed" ? "Validation failed" : null,
        );
      if (!revoked) live.push(id);
    }
    // 500 groups of mixed sizes: everything, ten regions, the metrics
    // relays, 50 racks of 100 and small team groups of 1 to 30.
    const group = (g, name, ids) =>
      record.run(
        "group",
        fixtureId("group", g),
        JSON.stringify({
          id: fixtureId("group", g),
          name,
          description: "Synthetic fleet-scale fixture",
          device_ids: ids,
          created_at: earlier,
          revision: 1,
        }),
        earlier,
      );
    group(0, "All servers", live);
    for (let r = 0; r < regions.length; r++)
      group(
        1 + r,
        `Region ${regions[r]}`,
        live.filter((_, i) => i % regions.length === r),
      );
    group(11, "Metrics relays", metricsMembers);
    for (let rack = 0; rack < 50; rack++)
      group(
        12 + rack,
        `Rack ${String(rack + 1).padStart(2, "0")}`,
        live.slice(rack * 100, rack * 100 + 100),
      );
    for (let g = 62; g < groups; g++) {
      const size = 1 + ((g * 37) % 30);
      const ids = new Set();
      for (let k = 0; ids.size < size && k < size * 4; k++)
        ids.add(live[(g * 97 + k * 131) % live.length]);
      group(g, `Team ${String(g - 61).padStart(3, "0")}`, [...ids]);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const summary = db
    .prepare(
      "SELECT (SELECT count(*) FROM devices) AS devices,(SELECT count(*) FROM devices WHERE revoked=0) AS live,(SELECT count(*) FROM records WHERE kind='group') AS groups,(SELECT sum(json_array_length(data,'$.device_ids')) FROM records WHERE kind='group') AS memberships,(SELECT max(json_array_length(data,'$.device_ids')) FROM records WHERE kind='group') AS largest_group,(SELECT count(*) FROM deployment_targets) AS targets,(SELECT sum(length(data)) FROM devices) AS device_bytes",
    )
    .get();
  db.close();
  return { ...summary };
}

/**
 * Keep the fixture's reporting devices checked in: stamp `last_seen` and the
 * sample time of every device that was fresh when seeded (the offline and
 * never-connected shapes keep theirs). Returns the number of devices stamped.
 */
export function heartbeat(file, now = new Date()) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=10000");
  try {
    const at = now.toISOString().replace(/\.\d+Z$/, "Z");
    const since = new Date(now.getTime() - 86400_000).toISOString();
    return Number(
      db
        .prepare(
          "UPDATE devices SET data=CASE WHEN json_type(data,'$.telemetry')='object' THEN json_set(data,'$.last_seen',?1,'$.telemetry.sampled_at',?1) ELSE json_set(data,'$.last_seen',?1) END WHERE revoked=0 AND json_extract(data,'$.labels.fixture')='fleet-scale' AND json_extract(data,'$.last_seen')>?2",
        )
        .run(at, since).changes,
    );
  } finally {
    db.close();
  }
}
