import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyStates,
  auditOutcomes,
  connectionState,
  dataPlaneCodes,
  dataPlaneIssues,
  deploymentStatuses,
  deviceDisplayStatus,
  deviceStatuses,
  gateStates,
  issueDispositions,
  statusDomains,
  statusOf,
  targetStates,
} from "./status";
import {
  deploymentLifecycle,
  describeDeployment,
  progressSegments,
  statusFilters,
  targetLabel,
} from "./deploymentStatus";
import { auditOutcomeLabel } from "./auditModel";
import { IssueSchema } from "./api";

const repository = new URL("../../", import.meta.url);
const protocol = JSON.parse(
  readFileSync(new URL("contracts/protocol.schema.json", repository), "utf8"),
);
const definitions = protocol.$defs as Record<string, any>;
const enumOf = (definition: string, property: string): string[] =>
  definitions[definition].properties[property].enum;
const rust = (file: string) =>
  readFileSync(new URL(`server/src/${file}`, repository), "utf8");

describe("status language", () => {
  it("labels every contract state exactly once in its domain", () => {
    const cases: [string, string[], Record<string, unknown>][] = [
      [
        "heartbeat apply_state",
        enumOf("HeartbeatRequest", "apply_state"),
        applyStates,
      ],
      [
        "configuration attempt state",
        enumOf("ConfigurationAttempt", "state"),
        applyStates,
      ],
      ["deployment status", enumOf("Deployment", "status"), deploymentStatuses],
      ["issue disposition", enumOf("Issue", "disposition"), issueDispositions],
      ["canary gate state", enumOf("CanaryGate", "state"), gateStates],
    ];
    for (const [name, values, domain] of cases) {
      expect(values.length, name).toBeGreaterThan(0);
      for (const value of values)
        expect(Object.hasOwn(domain, value), `${name}: ${value}`).toBe(true);
    }
  });

  it("reads every issue resolution reason in the contract", () => {
    const reasons: string[] =
      definitions.Issue.properties.resolved_reason.anyOf[0].enum;
    expect(reasons).toContain("revoked");
    for (const reason of reasons)
      expect(
        IssueSchema.shape.resolved_reason.safeParse(reason).success,
        reason,
      ).toBe(true);
  });

  it("covers every device status the server derives", () => {
    const source = rust("rollout.rs");
    const block = source.match(/d\["status"\] = json!\(([\s\S]*?)\}\);/)?.[1];
    expect(block, "device status derivation in rollout.rs").toBeTruthy();
    // Results are branch bodies (`{ "offline" }`) and match arms (`=> "verified"`);
    // the first match pattern (`"verified_applied" if …`) is an input, not a result.
    const derived = [...block!.matchAll(/(?:=>\s*|\{\s*)"([a-z_]+)"/g)]
      .map((match) => match[1])
      .filter((value) => value !== "verified_applied");
    expect(derived.length).toBeGreaterThan(5);
    for (const value of derived)
      expect(Object.hasOwn(deviceStatuses, value), value).toBe(true);
  });

  it("covers every deployment target state the server writes", () => {
    const written = new Set<string>();
    for (const file of ["rollout.rs", "device.rs"])
      for (const match of rust(file).matchAll(
        /deployment_targets SET state='([a-z_]+)'/g,
      ))
        written.add(match[1]);
    for (const match of rust("rollout.rs").matchAll(
      /\{ "(incompatible)" \} else \{ "(blocked)" \}/g,
    )) {
      written.add(match[1]);
      written.add(match[2]);
    }
    expect(written.size).toBeGreaterThan(3);
    for (const value of written)
      expect(Object.hasOwn(targetStates, value), value).toBe(true);
    // Targets also carry the agent's reported apply progress.
    for (const value of enumOf("HeartbeatRequest", "apply_state"))
      expect(Object.hasOwn(targetStates, value), value).toBe(true);
  });

  it("knows every data-plane issue code the server opens", () => {
    const codes = [
      ...rust("data_plane.rs").matchAll(/"(DATA_PLANE_[A-Z_]+)"/g),
    ].map((match) => match[1]);
    expect(new Set(codes)).toEqual(new Set(dataPlaneCodes));
  });

  it("shows an applied device that isn't delivering as degraded", () => {
    const issue = { code: "DATA_PLANE_STALLED", title: "Stopped" };
    const device = {
      status: "verified",
      desired_version_id: "v2",
      data_plane: { version_id: "v2", issues: [issue] },
    };
    expect(deviceDisplayStatus(device)).toBe("degraded");
    expect(deviceStatuses.degraded.label).toBe("Degraded");
    expect(dataPlaneIssues(device)).toEqual([issue]);
    // Old measurements, other states and missing summaries never degrade.
    expect(
      deviceDisplayStatus({
        ...device,
        data_plane: { version_id: "v1", issues: [issue] },
      }),
    ).toBe("verified");
    expect(deviceDisplayStatus({ ...device, status: "offline" })).toBe(
      "offline",
    );
    expect(deviceDisplayStatus({ ...device, data_plane: null })).toBe(
      "verified",
    );
  });

  it("reads list rows, which carry only the first delivery issue", () => {
    const first = { code: "DATA_PLANE_SINK_ERRORS", title: "Can't deliver" };
    const listed = {
      status: "verified",
      desired_version_id: "v2",
      data_plane: { version_id: "v2", issues: [first], issue_count: 3 },
    };
    expect(deviceDisplayStatus(listed)).toBe("degraded");
    expect(dataPlaneIssues(listed)).toEqual([first]);
    // The contract's list row keeps exactly what list pages read.
    const row = definitions.DeviceListItem.properties;
    for (const heavy of ["host_runtime", "vector_log_summary"])
      expect(Object.hasOwn(row, heavy), heavy).toBe(false);
    expect(row.data_plane.properties.issues.maxItems).toBe(1);
    expect(row.data_plane.properties.issue_count.type).toBe("integer");
  });

  it("gives every entry a label, tone, icon and one-line description", () => {
    for (const [domain, entries] of Object.entries(statusDomains))
      for (const [value, entry] of Object.entries(entries)) {
        const where = `${domain}.${value}`;
        expect(entry.label.trim(), where).not.toBe("");
        expect(entry.label, where).not.toMatch(/_/);
        expect(entry.description.trim(), where).not.toBe("");
        expect(entry.description, where).not.toContain("\n");
        expect(entry.description.length, where).toBeLessThanOrEqual(90);
      }
  });

  it("never gives two different states in one domain the same label", () => {
    // `failure` (request) and `failed` (action) are the same outcome in audit.
    const synonyms = new Set(["audit:failure"]);
    for (const [domain, entries] of Object.entries(statusDomains)) {
      const seen = new Map<string, string>();
      for (const [value, entry] of Object.entries(entries)) {
        if (synonyms.has(`${domain}:${value}`)) continue;
        const other = seen.get(entry.label);
        expect(other, `${domain}: ${value} and ${other} share a label`).toBe(
          undefined,
        );
        seen.set(entry.label, value);
      }
    }
  });

  it("uses the same words for the same state in every domain", () => {
    const shared = new Map<string, string>();
    for (const domain of ["apply", "target", "audit"] as const)
      for (const [value, entry] of Object.entries(statusDomains[domain])) {
        const label = shared.get(value);
        if (label) expect(entry.label, `${domain}.${value}`).toBe(label);
        else shared.set(value, entry.label);
      }
    expect(statusOf("device", "verified").label).toBe(
      statusOf("target", "verified_applied").label,
    );
    expect(statusOf("audit", "reload_requested").label).toBe(
      "Restarting Vector",
    );
    // Audit outcomes never borrow device wording such as "Apply failed".
    expect(auditOutcomes.failed.label).toBe("Failed");
  });

  it("falls back to a neutral, readable label for a new backend state", () => {
    const unknown = statusOf("device", "adopted_elsewhere");
    expect(unknown).toMatchObject({
      label: "Adopted elsewhere",
      tone: "neutral",
    });
    // Prototype keys are never mistaken for known states.
    expect(statusOf("deployment", "__proto__").label).toBe("Proto");
    expect(statusOf("deployment", "constructor").tone).toBe("neutral");
  });

  it("shows a dashboard pause as requested until the agent acknowledges it", () => {
    const base = { status: "paused", last_seen: new Date().toISOString() };
    expect(
      deviceDisplayStatus({
        ...base,
        sync_paused: true,
        pause_acknowledged: false,
      }),
    ).toBe("pause_requested");
    expect(
      deviceDisplayStatus({
        ...base,
        sync_paused: true,
        pause_acknowledged: true,
      }),
    ).toBe("paused");
    expect(
      deviceDisplayStatus({
        ...base,
        local_paused: true,
        pause_acknowledged: false,
      }),
    ).toBe("paused");
    expect(deviceDisplayStatus({ status: "verified" })).toBe("verified");
  });

  it("derives connection state without inventing a check-in", () => {
    expect(connectionState({ status: "revoked", last_seen: "x" })).toBe(
      "revoked",
    );
    expect(connectionState({ status: "offline" })).toBe("never");
    expect(connectionState({ status: "offline", last_seen: "x" })).toBe(
      "offline",
    );
    expect(connectionState({ status: "verified", last_seen: "x" })).toBe(
      "online",
    );
  });
});

describe("one vocabulary across views", () => {
  it("gives deployments, targets and audit results the status.ts words", () => {
    for (const status of deploymentLifecycle) {
      const known = statusOf("deployment", status);
      expect(known.description, status).not.toBe("");
      expect(describeDeployment(lineage(status)).label, status).toBe(
        known.label,
      );
    }
    for (const filter of statusFilters)
      expect(filter.label, filter.value).toBe(
        statusOf("deployment", filter.value).label,
      );
    expect(statusOf("deployment", "completed").label).toBe("Completed");
    for (const state of Object.keys(applyStates)) {
      expect(targetLabel(state), state).toBe(statusOf("apply", state).label);
      expect(auditOutcomeLabel(state), state).toBe(
        statusOf("apply", state).label,
      );
    }
    expect(progressSegments({}).map((segment) => segment.label)).toEqual([
      applyStates.verified_applied.label,
      applyStates.verification_unknown.label,
      applyStates.written.label,
      applyStates.desired.label,
      targetStates.pending.label,
      applyStates.failed.label,
    ]);
  });

  it("lists every audit result the server writes, including throttled", () => {
    const written = new Set<string>();
    for (const match of rust("auth.rs").matchAll(/"(throttled|denied)"/g))
      written.add(match[1]);
    expect(written.has("throttled")).toBe(true);
    for (const value of written)
      expect(Object.hasOwn(auditOutcomes, value), value).toBe(true);
  });
});

function lineage(status: string) {
  return {
    status,
    status_before_removal: null,
    status_before_rollback: null,
    rolled_back_by: null,
    rolled_back_to_version: null,
    replaced_by: [],
    failure_reason: null,
  };
}
