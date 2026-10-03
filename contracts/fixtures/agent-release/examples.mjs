// The normative examples of the update formats: one file each, quoted word for
// word in the "Agent updates" section of contracts/CONTRACT.md. They tell one
// story. A host called edge-02 pins the team key on 3 October, is offered
// agent 0.1.1 (counter 7) on the 4th, and takes it in its window on Monday the
// 5th at 02:14 UTC. The files are written from the same keys and rules as the
// shared vectors, and each is checked against the reference rules before it is
// returned, so an example cannot show something the contract refuses.
import {
  KEYS,
  BASE,
  BASE_BYTES,
  artifact,
  envelopeFor,
  signedBy,
  statementText,
} from "./cases.mjs";
import {
  base64,
  decide,
  keyLine,
  parseEnvelope,
  parseKeyLine,
  parseManifest,
  parseSignatureFile,
  pinFromBundle,
  sha256Hex,
  text,
  validateLast,
  validateReport,
} from "./rules.mjs";

const json = (value) => JSON.stringify(value);
const ids = {
  rollout: "c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4",
  release: "7d2b9c40-1e35-4f6a-8b17-0c9e4d3a5f21",
};
const WINDOW = "Mon-Fri 02:00-04:00 UTC";

export function buildExamples() {
  const team = KEYS.team;
  const next = KEYS["team-next"];

  // The server writes release.json as one line with no final line feed; the
  // digest a host reports is the SHA-256 of exactly these bytes.
  const manifestBytes = BASE_BYTES;
  const manifestDigest = sha256Hex(manifestBytes);
  const signatureBytes = signedBy(["team"], manifestBytes);
  const linux = artifact("linux", "amd64");
  const oldBuild = sha256Hex("vectory 0.1.0 linux amd64 test build");
  const previousRelease = sha256Hex("release.json of 0.1.0");

  // The statement and its wrapper: the team key hands over to its successor.
  const statement = text(
    statementText("team", "team-next", "2026-11-02T09:00:00Z"),
  );
  const vectorEnvelope = envelopeFor("team", statement);
  const wireEnvelope = {
    statement: vectorEnvelope.statement_b64,
    signature: vectorEnvelope.signature_b64,
  };

  const last = {
    release: previousRelease,
    outcome: "committed",
    code: null,
    at: "2026-08-12T02:09:41Z",
    from_version: "0.0.9",
    to_version: "0.1.0",
    first_check_in_ms: 1900,
  };
  const statusLast = { ...last };

  const files = {};
  files["release.json"] = manifestBytes.toString("latin1");
  files["release.json.sig"] = signatureBytes.toString("latin1");
  files["rollover.json"] = statement.toString("latin1");
  files["rollover-envelope.json"] = json(wireEnvelope);
  files["rollovers.json"] = json({
    schema: "vectory.update-rollovers.v1",
    rollovers: [wireEnvelope],
  });
  files["team.pub"] = team.line;
  files["team.key"] =
    `vectory-release-private-key ed25519 ${base64(team.seed)}`;
  files["release-keys.json"] = json({
    schema: "vectory.release-keys.v1",
    keys: [
      {
        public_key: next.line,
        fingerprint: next.fingerprint,
        state: "current",
      },
      {
        public_key: team.line,
        fingerprint: team.fingerprint,
        state: "retired",
      },
    ],
    rollovers: [wireEnvelope],
  });
  files["policy.json"] = json({
    schema: "vectory.update-policy.v1",
    consent: "auto",
    track: "patch",
    windows: [WINDOW],
    paused: false,
    keys: [{ public_key: team.line, pinned_at: "2026-10-03T12:30:00Z" }],
    updated_at: "2026-10-03T12:30:00Z",
  });
  files["request.json"] = json({
    schema: "vectory.update-request.v1",
    manifest_sha256: manifestDigest,
    artifact_sha256: linux.sha256,
    rollout_id: ids.rollout,
    offered_at: "2026-10-04T01:58:10Z",
  });
  files["health.json"] = json({
    schema: "vectory.update-health.v1",
    agent_sha256: linux.sha256,
    agent_version: "0.1.1",
    boot_id: sha256Hex("boot of the new agent process"),
    checked_in_at: "2026-10-05T02:14:11.382Z",
    vector: "running",
    offer: manifestDigest,
  });
  files["counters.json"] = json({
    schema: "vectory.update-counters.v1",
    highest_counters: { [team.fingerprint]: 7 },
    rollover_conflict: null,
  });
  files["installed.json"] = json({
    schema: "vectory.update-installed.v1",
    version: "0.1.0",
    sha256: oldBuild,
    release: null,
    recorded_at: "2026-10-03T12:31:02Z",
  });
  files["status.json"] = json({
    schema: "vectory.update-status.v1",
    run_at: "2026-10-05T02:14:12Z",
    stage: "trial",
    eligibility: "eligible",
    service_definition: 1,
    highest_counters: { [team.fingerprint]: 7 },
    rollover_conflict: null,
    release: manifestDigest,
    from_version: "0.1.0",
    to_version: "0.1.1",
    deadline: "2026-10-05T02:19:09Z",
    last: statusLast,
  });
  files["journal.json"] = json({
    schema: "vectory.update-journal.v1",
    stage: "trial",
    release: manifestDigest,
    signers: [team.fingerprint],
    counter: 7,
    from: { version: "0.1.0", sha256: oldBuild },
    to: { version: "0.1.1", sha256: linux.sha256 },
    started_at: "2026-10-05T02:14:00Z",
    deadline: "2026-10-05T02:19:09Z",
    boot_id_before: sha256Hex("boot of the old agent process"),
    interruptions: 0,
    swap: {
      style: "rename",
      staged: ".vectory-update-7",
      previous: ".vectory-previous",
    },
    code: null,
    finished_at: null,
  });
  files["manifest-member.json"] = json({
    rollout_id: ids.rollout,
    release_id: ids.release,
    manifest: base64(manifestBytes),
    signatures: base64(signatureBytes),
    rollovers: [],
    artifact: {
      sha256: linux.sha256,
      size: linux.size,
      path: `/agent/v1/agent-releases/${linux.sha256}`,
    },
  });
  files["heartbeat-member.json"] = json({
    consent: "auto",
    paused: false,
    track: "patch",
    windows: [WINDOW],
    window_open: false,
    next_window_at: "2026-10-05T02:00:00Z",
    keys: [team.fingerprint],
    highest_counter: 6,
    eligibility: "eligible",
    service_definition: 1,
    state: "waiting_for_window",
    release: manifestDigest,
    code: null,
    rollover_conflict: null,
    last,
  });

  // Each example must be what the reference rules accept.
  const verdict = decide(
    {
      manifest_b64: base64(manifestBytes),
      signatures_b64: base64(signatureBytes),
      rollovers: [],
      pins: [team.fingerprint],
      floors: { [team.fingerprint]: 6 },
      running_version: "0.1.0",
      os: "linux",
      arch: "amd64",
      track: "patch",
      now: "2026-10-04T01:58:00Z",
      service_definition: 1,
      last: null,
    },
    (fingerprint) =>
      [team, next].find((key) => key.fingerprint === fingerprint),
  );
  if (verdict.result !== "valid" || verdict.signer !== team.fingerprint)
    throw new Error(`the example release is not valid: ${json(verdict)}`);
  const manifest = parseManifest(manifestBytes);
  if (
    !manifest ||
    manifest.counter !== 7 ||
    manifest.version.join(".") !== "0.1.1"
  )
    throw new Error("the example manifest is not 0.1.1 with counter 7");
  if (BASE.service_definition !== 1)
    throw new Error("the example manifest names service definition 1");
  if (!parseSignatureFile(signatureBytes))
    throw new Error("the example signature file does not parse");
  if (!parseEnvelope(vectorEnvelope))
    throw new Error("the example rollover does not parse");
  if (!parseKeyLine(files["team.pub"]))
    throw new Error("the example key line does not parse");
  if (keyLine(team.publicRaw, "team") !== files["team.pub"])
    throw new Error("the example key line is not the team key's");
  if (
    pinFromBundle(text(files["release-keys.json"]), team.fingerprint).result !==
    "valid"
  )
    throw new Error("the example bundle does not pin the retired key");
  const problem = validateReport(JSON.parse(files["heartbeat-member.json"]));
  if (problem) throw new Error(`the example heartbeat member: ${problem}`);
  const lastProblem = validateLast(statusLast);
  if (lastProblem) throw new Error(`the example last result: ${lastProblem}`);

  return files;
}
