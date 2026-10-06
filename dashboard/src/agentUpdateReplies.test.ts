import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
// The synthetic replies are plain JavaScript, shared with the browser harness.
// @ts-expect-error There is no declaration file for a .mjs module.
import * as shared from "../tests/agent-update-replies.mjs";

// The browser harnesses answer the dashboard from these replies instead of a
// server. A harness that passes against replies the contract would refuse
// proves nothing, so the replies are held to the contract here: every body
// they build or send must be what the shared schemas describe, and every
// refusal must use a code and a status the contract lists.
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");
const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const protocol = JSON.parse(read("contracts/protocol.schema.json"));
const contractText = read("contracts/CONTRACT.md");
const repliesSource = read("dashboard/tests/agent-update-replies.mjs");
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(protocol);

// Hosts frozen on a fork are listed by newer contracts only. The replies carry
// them, so against a contract that has no such member the comparison leaves
// that one member out rather than calling every reply wrong.
const knowsFrozen = "frozen_devices" in protocol.$defs.AgentUpdates.properties;
const shaped = (name: string, value: any) => {
  const validate = ajv.getSchema(`${protocol.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`The contract has no ${name}.`);
  const body =
    name === "AgentUpdates" && !knowsFrozen
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "frozen_devices"),
        )
      : value;
  return validate(body) ? [] : validate.errors;
};
const matches = (name: string, value: unknown, label = name) =>
  expect(shaped(name, value), label).toEqual([]);

type Reply = {
  status: number;
  json?: any;
  body?: string;
  headers?: Record<string, string>;
};
const {
  agentUpdateReplies,
  onState,
  offState,
  updatesBody,
  updatesOff,
  releaseKey,
  release,
  rollout,
  detailBody,
  targetRow,
  report,
  previewBody,
  noCounts,
  id,
  nextLine,
  nextFingerprint,
  finalFingerprint,
  teamFingerprint,
  rolloverEnvelope,
  signatureFile,
  manifestText,
} = shared;
const server = (state: any) => {
  const replies = agentUpdateReplies(state);
  return (method: string, path: string, body?: unknown, raw?: string): Reply =>
    replies.handle(
      method,
      new URL(`http://synthetic.test/api/v1${path}`),
      body,
      raw,
    );
};
const code = (reply: Reply) => reply.json?.error?.code;
const enumOf = (name: string, member: string): string[] =>
  protocol.$defs[name].properties[member].enum;

const password = "correct horse";
const settings = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  custody: { kind: "server" },
  current_password: password,
  revision: 0,
  ...over,
});
const plan = {
  release_id: id(30),
  selector: { device_ids: [], group_ids: [id(50)], exclude_ids: [] },
  rollout: {
    canary_size: 1,
    batch_size: 10,
    observation_seconds: 300,
    failure_threshold: 0,
  },
};

describe("the comparison with the contract", () => {
  it("refuses what the contract refuses, so a pass means something", () => {
    expect(
      shaped("AgentUpdates", updatesBody({ custody: "cloud" })),
    ).not.toEqual([]);
    expect(
      shaped("AgentUpdateRollout", rollout({ status: "weird" })),
    ).not.toEqual([]);
    expect(
      shaped("AgentUpdateTarget", targetRow({ state: "updated" })),
    ).not.toEqual([]);
    expect(
      shaped("AgentReleaseKey", { ...releaseKey(), extra: true }),
    ).not.toEqual([]);
    // A version with a pre-release suffix is not a version.
    expect(
      shaped("AgentRelease", release({ version: "0.1.1-rc1" })),
    ).not.toEqual([]);
  });
});

describe("the builders of the synthetic replies", () => {
  it("describe agent updates, on and off, as the contract does", () => {
    matches("AgentUpdates", updatesBody());
    matches("AgentUpdates", updatesOff());
    matches(
      "AgentUpdates",
      updatesBody({
        stopped: {
          reason: "A bad build",
          by_name: "Maria Costa",
          at: "2026-10-03T13:00:00Z",
        },
        active_rollouts: 0,
      }),
    );
    // A key that is not the current one, and the list of hosts on a fork.
    matches(
      "AgentUpdates",
      updatesBody({
        frozen_devices: {
          total: 1,
          items: [
            {
              device_id: id(5),
              device_name: "edge-05",
              rollover_conflict: {
                from: teamFingerprint,
                to: [nextFingerprint, finalFingerprint],
              },
            },
          ],
        },
      }),
    );
  });

  it("describe keys in each state, with the rollover that made them current", () => {
    matches("AgentReleaseKey", releaseKey());
    matches(
      "AgentReleaseKey",
      releaseKey({
        state: "retired",
        retired_at: "2026-10-04T09:00:00Z",
        introduced_by: rolloverEnvelope,
      }),
    );
    matches(
      "AgentReleaseKey",
      releaseKey({
        state: "revoked",
        revoked_at: "2026-10-04T09:00:00Z",
        revoked_reason: "The laptop holding it was lost.",
      }),
    );
    matches("KeyRolloverEnvelope", rolloverEnvelope);
  });

  it("describe a release in each state", () => {
    matches("AgentRelease", release());
    matches(
      "AgentRelease",
      release({ state: "awaiting_signature", signer: null }),
    );
    matches(
      "AgentRelease",
      release({
        state: "withdrawn",
        withdrawn_at: "2026-10-04T09:00:00Z",
        withdrawn_reason: "It broke the pipeline on one host.",
      }),
    );
    matches("AgentRelease", release({ expired: true }));
  });

  it("describe a rollout in each status, and its stages and failures", () => {
    for (const status of enumOf("AgentUpdateRollout", "status")) {
      matches("AgentUpdateRollout", rollout({ status }), `rollout ${status}`);
      matches(
        "AgentUpdateRolloutDetail",
        detailBody({ status }),
        `detail ${status}`,
      );
    }
    matches("AgentUpdateRolloutPage", {
      items: [rollout()],
      total: 1,
      page: 1,
      page_size: 12,
    });
    matches(
      "AgentUpdateRolloutDetail",
      detailBody({
        failures: [
          {
            state: "rolled_back",
            code: "UNHEALTHY",
            message: null,
            count: 1,
            device_ids: [id(1)],
            devices: [{ device_id: id(1), device_name: "edge-01" }],
          },
        ],
      }),
    );
  });

  it("count a target in every one of the contract's states", () => {
    const states = enumOf("AgentUpdateTarget", "state");
    expect(Object.keys(noCounts).sort()).toEqual([...states].sort());
    for (const state of states)
      matches("AgentUpdateTarget", targetRow({ state }), `target ${state}`);
    matches("AgentUpdateTargetPage", {
      items: [targetRow()],
      total: 1,
      page: 1,
      page_size: 12,
    });
  });

  it("describe a device's report in every state and eligibility", () => {
    for (const state of enumOf("DeviceAgentUpdate", "state"))
      matches("DeviceAgentUpdate", report({ state }), `state ${state}`);
    for (const eligibility of enumOf("DeviceAgentUpdate", "eligibility"))
      matches(
        "DeviceAgentUpdate",
        report({ eligibility }),
        `eligibility ${eligibility}`,
      );
    for (const consent of enumOf("DeviceAgentUpdate", "consent"))
      matches("DeviceAgentUpdate", report({ consent }), `consent ${consent}`);
  });

  it("describe a review, with the reasons a host will not update", () => {
    matches("AgentUpdatePreview", previewBody());
  });

  it("publish the manifest the shared release example signs", () => {
    // The harness serves these bytes as the download; the digest of what it
    // serves is the digest the release lists.
    expect(JSON.parse(manifestText).schema).toBe("vectory.agent-release.v1");
    expect(release().manifest_sha256).toBe(shared.manifestSha256);
  });
});

describe("the synthetic server", () => {
  it("answers each read with what the contract describes", () => {
    const state = onState();
    const ask = server(state);
    const settingsReply = ask("GET", "/agent-updates");
    expect(settingsReply.status).toBe(200);
    matches("AgentUpdates", settingsReply.json);
    const keys = ask("GET", "/agent-release-keys");
    expect(keys.json).toHaveLength(1);
    for (const key of keys.json) matches("AgentReleaseKey", key);
    const releases = ask("GET", "/agent-releases");
    for (const row of releases.json) matches("AgentRelease", row);
    matches("AgentRelease", ask("GET", `/agent-releases/${id(30)}`).json);
    matches(
      "AgentUpdateRolloutPage",
      ask("GET", "/agent-update-rollouts?page=1&page_size=12").json,
    );
    matches(
      "AgentUpdateRolloutDetail",
      ask("GET", `/agent-update-rollouts/${id(40)}`).json,
    );
    matches(
      "AgentUpdateTargetPage",
      ask("GET", `/agent-update-rollouts/${id(40)}/targets?page=1`).json,
    );
    // The manifest is the exact text that was signed, not JSON re-written.
    const download = ask("GET", `/agent-releases/${id(30)}/manifest`);
    expect(download.status).toBe(200);
    expect(download.body).toBe(manifestText);
  });

  it("answers the first read while updates are off and every other route as off", () => {
    const ask = server(offState());
    const first = ask("GET", "/agent-updates");
    expect(first.status).toBe(200);
    matches("AgentUpdates", first.json);
    expect(first.json.enabled).toBe(false);
    for (const [method, path] of [
      ["GET", "/agent-release-keys"],
      ["GET", "/agent-releases"],
      ["GET", "/agent-update-rollouts"],
      ["POST", "/agent-update-rollouts/preview"],
      ["POST", "/agent-updates/stop"],
    ]) {
      const refused = ask(method, path, {});
      expect([refused.status, code(refused)], `${method} ${path}`).toEqual([
        404,
        "AGENT_UPDATES_OFF",
      ]);
    }
  });

  it("turns updates on with either custody and nothing preselected", () => {
    const none = server(offState());
    expect(
      code(
        none(
          "PUT",
          "/agent-updates/settings",
          settings({ custody: undefined }),
        ),
      ),
    ).toBe("CUSTODY_REQUIRED");

    const serverState = offState();
    const kept = server(serverState);
    const on = kept("PUT", "/agent-updates/settings", settings());
    expect(on.status).toBe(200);
    matches("AgentUpdates", on.json);
    expect(on.json.custody).toBe("server");
    expect(on.json.revision).toBe(1);
    matches("AgentReleaseKey", on.json.current_key);
    expect(serverState.keys).toHaveLength(1);

    const own = server(offState());
    const offline = own(
      "PUT",
      "/agent-updates/settings",
      settings({ custody: { kind: "offline", public_key: nextLine } }),
    );
    expect(offline.status).toBe(200);
    matches("AgentUpdates", offline.json);
    expect(offline.json.current_key.public_key).toBe(nextLine);
    // The fingerprint is the SHA-256 of the 32 key bytes, not of the line.
    expect(offline.json.current_key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(offline.json.current_key.fingerprint).not.toBe(teamFingerprint);

    const refused = own(
      "PUT",
      "/agent-updates/settings",
      settings({
        revision: 1,
        custody: { kind: "offline", public_key: "not a key" },
      }),
    );
    expect([refused.status, code(refused)]).toEqual([
      422,
      "RELEASE_KEY_INVALID",
    ]);
  });

  it("fixes the custody while updates are on, and keeps a running rollout from being turned off", () => {
    const state = onState();
    const ask = server(state);
    const locked = ask(
      "PUT",
      "/agent-updates/settings",
      settings({ revision: 3, custody: { kind: "server" } }),
    );
    expect([locked.status, code(locked)]).toEqual([409, "CUSTODY_LOCKED"]);
    const active = ask(
      "PUT",
      "/agent-updates/settings",
      settings({ enabled: false, custody: undefined, revision: 3 }),
    );
    expect([active.status, code(active)]).toEqual([
      409,
      "AGENT_UPDATE_ROLLOUTS_ACTIVE",
    ]);

    // With no rollout running, off is allowed and the key stays.
    const idle = onState({ updates: updatesBody({ active_rollouts: 0 }) });
    const off = server(idle)(
      "PUT",
      "/agent-updates/settings",
      settings({ enabled: false, custody: undefined, revision: 3 }),
    );
    expect(off.status).toBe(200);
    matches("AgentUpdates", off.json);
    expect(off.json.enabled).toBe(false);
  });

  it("asks for the password and the revision of every settings change", () => {
    const ask = server(offState());
    const wrong = ask(
      "PUT",
      "/agent-updates/settings",
      settings({ current_password: "wrong" }),
    );
    expect([wrong.status, code(wrong)]).toEqual([403, "WRONG_PASSWORD"]);
    const stale = ask(
      "PUT",
      "/agent-updates/settings",
      settings({ revision: 9 }),
    );
    expect([stale.status, code(stale)]).toEqual([409, "STALE_REVISION"]);
  });

  it("lets only the roles the contract names change anything", () => {
    for (const role of ["viewer", "editor"]) {
      const ask = server(onState({ role }));
      for (const [method, path] of [
        ["PUT", "/agent-updates/settings"],
        ["POST", "/agent-updates/stop"],
        ["POST", "/agent-update-rollouts/preview"],
        ["POST", "/agent-update-rollouts"],
        ["POST", `/agent-update-rollouts/${id(40)}/pause`],
        ["POST", "/agent-releases"],
        ["POST", "/agent-release-keys/rotate"],
      ]) {
        const refused = ask(method, path, settings());
        expect(
          [refused.status, code(refused)],
          `${role} ${method} ${path}`,
        ).toEqual([403, "FORBIDDEN"]);
      }
      // Reading is open to every signed-in role.
      expect(ask("GET", "/agent-update-rollouts").status).toBe(200);
    }
    // An operator may run a rollout, not change keys or settings.
    const operator = server(onState({ role: "operator" }));
    expect(
      operator("POST", "/agent-updates/stop", { reason: "Bad" }).status,
    ).toBe(200);
    expect(code(operator("PUT", "/agent-updates/settings", settings()))).toBe(
      "FORBIDDEN",
    );
    expect(
      code(operator("POST", "/agent-releases", { version: "0.1.2" })),
    ).toBe("FORBIDDEN");
  });

  it("reviews a rollout and creates it from that review, once", () => {
    const state = onState({
      releases: [release()],
      rollouts: [],
      details: {},
      targets: {},
    });
    const ask = server(state);
    const review = ask("POST", "/agent-update-rollouts/preview", plan);
    expect(review.status).toBe(200);
    matches("AgentUpdatePreview", review.json);

    const body = {
      ...plan,
      name: "October patch",
      review_token: review.json.review_token,
      request_id: "11111111-2222-4333-8444-555555555555",
    };
    const made = ask("POST", "/agent-update-rollouts", body);
    expect(made.status).toBe(200);
    matches("AgentUpdateRollout", made.json);
    expect(made.json.status).toBe("active");
    // Nothing starts as updated: every device is waiting.
    expect(made.json.state_counts.verified).toBe(0);

    // The same request again is the same rollout; another body is a conflict.
    const again = ask("POST", "/agent-update-rollouts", body);
    expect(again.json.id).toBe(made.json.id);
    expect(state.rollouts).toHaveLength(1);
    const different = ask("POST", "/agent-update-rollouts", {
      ...body,
      rollout: { ...plan.rollout, batch_size: 20 },
    });
    expect([different.status, code(different)]).toEqual([
      409,
      "IDEMPOTENCY_CONFLICT",
    ]);

    // A review that changed since it was made creates nothing.
    const stale = ask("POST", "/agent-update-rollouts", {
      ...plan,
      review_token: "0".repeat(64),
    });
    expect([stale.status, code(stale)]).toEqual([409, "UPDATE_REVIEW_CHANGED"]);
    expect(state.rollouts).toHaveLength(1);

    matches(
      "AgentUpdateRolloutDetail",
      ask("GET", `/agent-update-rollouts/${made.json.id}`).json,
    );
    matches(
      "AgentUpdateTargetPage",
      ask("GET", `/agent-update-rollouts/${made.json.id}/targets`).json,
    );
  });

  it("pauses, resumes and cancels a rollout, each only where it applies", () => {
    const state = onState();
    const ask = server(state);
    const row = `/agent-update-rollouts/${id(40)}`;
    const resumed = ask("POST", `${row}/resume`);
    expect([resumed.status, code(resumed)]).toEqual([409, "CONFLICT"]);
    const paused = ask("POST", `${row}/pause`);
    expect(paused.status).toBe(200);
    matches("AgentUpdateRollout", paused.json);
    expect(paused.json.status).toBe("paused");
    const resumedNow = ask("POST", `${row}/resume`);
    expect(resumedNow.json.status).toBe("active");
    const cancelled = ask("POST", `${row}/cancel`);
    expect(cancelled.status).toBe(200);
    matches("AgentUpdateRollout", cancelled.json);
    expect(cancelled.json.status).toBe("cancelled");
    expect(code(ask("POST", `${row}/cancel`))).toBe("CONFLICT");
    expect(code(ask("POST", `/agent-update-rollouts/${id(99)}/pause`))).toBe(
      "NOT_FOUND",
    );
  });

  it("stops every update and clears the stop, as an administrator", () => {
    const state = onState();
    const ask = server(state);
    const stopped = ask("POST", "/agent-updates/stop", { reason: "Bad build" });
    expect(stopped.status).toBe(200);
    matches("AgentUpdates", stopped.json);
    expect(stopped.json.stopped.reason).toBe("Bad build");
    // No new rollout starts while updates are stopped.
    const review = ask("POST", "/agent-update-rollouts/preview", plan);
    const blocked = ask("POST", "/agent-update-rollouts", {
      ...plan,
      review_token: review.json.review_token,
    });
    expect([blocked.status, code(blocked)]).toEqual([
      409,
      "AGENT_UPDATES_STOPPED",
    ]);
    const stale = ask("POST", "/agent-updates/stop/clear", { revision: 0 });
    expect(code(stale)).toBe("STALE_REVISION");
    const cleared = ask("POST", "/agent-updates/stop/clear", {
      revision: stopped.json.revision,
    });
    expect(cleared.status).toBe(200);
    matches("AgentUpdates", cleared.json);
    expect(cleared.json.stopped).toBeNull();
  });

  it("rotates a server key and takes an offline rollover, never the other way", () => {
    const offline = server(onState());
    expect(
      code(
        offline("POST", "/agent-release-keys/rotate", {
          current_password: password,
        }),
      ),
    ).toBe("CONFLICT");
    const rolled = offline("POST", "/agent-release-keys/rollover", {
      ...rolloverEnvelope,
      current_password: password,
    });
    expect(rolled.status).toBe(200);
    matches("AgentReleaseKey", rolled.json);
    expect(rolled.json.state).toBe("current");
    expect(rolled.json.introduced_by).toEqual(rolloverEnvelope);
    const forged = server(onState())("POST", "/agent-release-keys/rollover", {
      statement: "AAAA",
      signature: rolloverEnvelope.signature,
      current_password: password,
    });
    expect([forged.status, code(forged)]).toEqual([
      422,
      "RELEASE_SIGNATURE_INVALID",
    ]);

    const custody = onState({
      updates: updatesBody({
        custody: "server",
        current_key: releaseKey({ custody: "server" }),
      }),
      keys: [releaseKey({ custody: "server" })],
    });
    const rotated = server(custody)("POST", "/agent-release-keys/rotate", {
      current_password: password,
    });
    expect(rotated.status).toBe(200);
    matches("AgentReleaseKey", rotated.json);
    expect(custody.keys.map((key: any) => key.state)).toEqual([
      "current",
      "retired",
    ]);
    const wrong = server(onState())("POST", "/agent-release-keys/rotate", {
      current_password: "wrong",
    });
    expect(code(wrong)).toBe("WRONG_PASSWORD");
  });

  it("revokes a key and says why", () => {
    const state = onState();
    const ask = server(state);
    const revoked = ask(
      "POST",
      `/agent-release-keys/${teamFingerprint}/revoke`,
      { reason: "The laptop was lost.", current_password: password },
    );
    expect(revoked.status).toBe(200);
    matches("AgentReleaseKey", revoked.json);
    expect(revoked.json.state).toBe("revoked");
    expect(revoked.json.revoked_reason).toBe("The laptop was lost.");
    // The settings then have no current key.
    expect(ask("GET", "/agent-updates").json.current_key).toBeNull();
    const twice = ask("POST", `/agent-release-keys/${teamFingerprint}/revoke`, {
      reason: "Again",
      current_password: password,
    });
    expect(code(twice)).toBe("CONFLICT");
  });

  it("prepares a release, takes its signature, and withdraws it", () => {
    const state = onState({ releases: [] });
    state.updates.catalog[0].release = null;
    const ask = server(state);
    const prepared = ask("POST", "/agent-releases", { version: "0.1.1" });
    expect(prepared.status).toBe(200);
    matches("AgentRelease", prepared.json);
    // Offline custody: the server cannot sign, so the release waits.
    expect(prepared.json.state).toBe("awaiting_signature");
    expect(prepared.json.signer).toBeNull();
    const twice = ask("POST", "/agent-releases", { version: "0.1.1" });
    expect(code(twice)).toBe("RELEASE_EXISTS");
    const missing = ask("POST", "/agent-releases", { version: "9.9.9" });
    expect(code(missing)).toBe("RELEASE_NOT_IN_CATALOG");

    const badSignature = ask(
      "PUT",
      `/agent-releases/${prepared.json.id}/signature`,
      undefined,
      "{}",
    );
    expect([badSignature.status, code(badSignature)]).toEqual([
      422,
      "RELEASE_SIGNATURE_INVALID",
    ]);
    const signed = ask(
      "PUT",
      `/agent-releases/${prepared.json.id}/signature`,
      undefined,
      signatureFile,
    );
    expect(signed.status).toBe(200);
    matches("AgentRelease", signed.json);
    expect(signed.json.state).toBe("ready");
    expect(signed.json.signer.fingerprint).toBe(teamFingerprint);

    const withdrawn = ask(
      "POST",
      `/agent-releases/${prepared.json.id}/withdraw`,
      { reason: "It broke a host." },
    );
    expect(withdrawn.status).toBe(200);
    matches("AgentRelease", withdrawn.json);
    expect(withdrawn.json.state).toBe("withdrawn");
    expect(withdrawn.json.withdrawn_reason).toBe("It broke a host.");
  });

  it("signs a release itself only in server custody", () => {
    const state = onState({
      releases: [],
      updates: updatesBody({
        custody: "server",
        current_key: releaseKey({ custody: "server" }),
      }),
      keys: [releaseKey({ custody: "server" })],
    });
    state.updates.catalog[0].release = null;
    const prepared = server(state)("POST", "/agent-releases", {
      version: "0.1.1",
    });
    expect(prepared.status).toBe(200);
    matches("AgentRelease", prepared.json);
    expect(prepared.json.state).toBe("ready");
    expect(prepared.json.signer.custody).toBe("server");
  });
});

describe("the refusals of the synthetic replies", () => {
  // The codes the contract's table gives with a status of their own.
  const table = new Map<string, number>();
  for (const row of contractText.matchAll(/^\| `([A-Z_]+)` \| (\d{3}) \|/gm))
    table.set(row[1], Number(row[2]));

  it("use only codes the contract lists, and the status it gives them", () => {
    const used = [
      ...repliesSource.matchAll(/refuse\(\s*(\d{3}),\s*"([A-Z_]+)"/g),
    ].map((match) => [match[2], Number(match[1])] as const);
    expect(used.length).toBeGreaterThan(20);
    for (const [name, status] of used) {
      expect(
        new RegExp(`\\b${name}\\b`).test(contractText),
        `${name} is not in the contract`,
      ).toBe(true);
      if (table.has(name))
        expect(status, `${name} answers ${table.get(name)}`).toBe(
          table.get(name),
        );
    }
    // The table is read as written: the codes a harness leans on are in it.
    for (const name of [
      "AGENT_UPDATES_OFF",
      "CUSTODY_LOCKED",
      "UPDATE_REVIEW_CHANGED",
      "RELEASE_NOT_READY",
    ])
      expect(table.get(name), name).toBeDefined();
  });

  it("refuse with the error body every route of the API uses", () => {
    const ask = server(offState());
    const refused = ask("GET", "/agent-releases");
    expect(Object.keys(refused.json)).toEqual(["error"]);
    expect(Object.keys(refused.json.error).sort()).toEqual(["code", "message"]);
    expect(typeof refused.json.error.message).toBe("string");
  });

  it("do not know a route the contract does not have", () => {
    const ask = server(onState());
    expect(code(ask("GET", "/agent-update-rollouts/not-a-route/nowhere"))).toBe(
      "NOT_FOUND",
    );
    // Anything else on the API is not this module's to answer.
    expect(ask("GET", "/devices")).toBeNull();
  });
});
