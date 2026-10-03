// The cases of the shared vectors. Each case states the answer the contract
// gives, and the reference rules in rules.mjs compute it again from the
// inputs: the script stops when the two disagree, so a case cannot say
// something the rules do not.
import crypto from "node:crypto";
import {
  AGENT_CODES,
  BUILD_LIMIT,
  GROUP_ORDER,
  MAX_SAFE,
  PLATFORMS,
  RELEASE_PREFIX,
  REPORT_BOUNDS,
  ROLLOVER_PREFIX,
  SMALL_ORDER_ENCODINGS,
  base64,
  decide,
  decodePoint,
  isSmallOrder,
  keyFromSeed,
  keyLine,
  littleEndian,
  parseKeyLine,
  pinFromBundle,
  refuse,
  sha256,
  sha256Hex,
  signWith,
  strictVerify,
  text,
  toLittleEndian,
  validateReport,
} from "./rules.mjs";

// The source of this file holds no unicode escapes; these build what a case
// needs from character codes.
const BACKSLASH = String.fromCharCode(0x5c);
const E_ACUTE = String.fromCharCode(0xe9);
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

// ---------------------------------------------------------------- keys

export const KEY_NAMES = [
  "team",
  "team-next",
  "team-final",
  "project",
  "outsider",
  "outsider-next",
  ...Array.from({ length: 10 }, (_, index) => `chain-${index}`),
];
export const KEYS = Object.fromEntries(
  KEY_NAMES.map((name) => [
    name,
    keyFromSeed(name, sha256(`vectory agent-release test key: ${name}`)),
  ]),
);
const BY_FINGERPRINT = Object.fromEntries(
  Object.values(KEYS).map((key) => [key.fingerprint, key]),
);
const resolveKey = (fingerprint) => BY_FINGERPRINT[fingerprint];

// ---------------------------------------------------------------- builders

const ARTIFACT_DIGESTS = {
  "linux/amd64": sha256Hex("vectory 0.1.1 linux amd64 test build"),
  "linux/arm64": sha256Hex("vectory 0.1.1 linux arm64 test build"),
  "darwin/arm64": sha256Hex("vectory 0.1.1 darwin arm64 test build"),
  "windows/amd64": sha256Hex("vectory 0.1.1 windows amd64 test build"),
};
export const artifact = (os, arch, version = "0.1.1", size = 15204352) => ({
  os,
  arch,
  format: "executable",
  file: `vectory-${version}-${os}-${arch}${os === "windows" ? ".exe" : ""}`,
  size,
  sha256: ARTIFACT_DIGESTS[`${os}/${arch}`] ?? sha256Hex(`${os}/${arch}`),
});

export const BASE = {
  schema: "vectory.agent-release.v1",
  version: "0.1.1",
  counter: 7,
  issued_at: "2026-10-03T12:00:00Z",
  expires_at: "2027-04-01T12:00:00Z",
  min_from: "0.1.0",
  service_definition: 1,
  artifacts: [
    artifact("linux", "amd64"),
    artifact("windows", "amd64", "0.1.1", 15892480),
  ],
};
export const manifestText = (overrides = {}) =>
  JSON.stringify({ ...BASE, ...overrides });
export const BASE_TEXT = manifestText();
export const BASE_BYTES = text(BASE_TEXT);
const releaseOf = (version, extra = {}) =>
  text(
    manifestText({
      version,
      min_from: undefined,
      artifacts: [artifact("linux", "amd64", version)],
      ...extra,
    }),
  );

export const signatureFile = (entries) =>
  text(
    JSON.stringify({
      schema: "vectory.agent-release-signatures.v1",
      signatures: entries.map(([key, signature]) => ({
        key,
        signature: base64(signature),
      })),
    }),
  );
const releaseSignature = (keyName, bytes, prefix = RELEASE_PREFIX) =>
  signWith(KEYS[keyName], prefix, bytes);
export const signedBy = (keyNames, bytes) =>
  signatureFile(
    keyNames.map((name) => [
      KEYS[name].fingerprint,
      releaseSignature(name, bytes),
    ]),
  );

const statementJson = (from, toLine, issuedAt = "2026-10-03T12:00:00Z") =>
  JSON.stringify({
    schema: "vectory.release-key-rollover.v1",
    from,
    to: toLine,
    issued_at: issuedAt,
  });
export const statementText = (fromName, toName, issuedAt) =>
  statementJson(KEYS[fromName].fingerprint, KEYS[toName].line, issuedAt);
export const envelopeFor = (
  signerName,
  statementBytes,
  prefix = ROLLOVER_PREFIX,
) => ({
  statement_b64: base64(statementBytes),
  signature_b64: base64(signWith(KEYS[signerName], prefix, statementBytes)),
});
export const rollover = (fromName, toName, issuedAt) =>
  envelopeFor(fromName, text(statementText(fromName, toName, issuedAt)));

// The same file written another way: every object's members in the opposite
// order, and a space on each side of every token that is not inside a string.
// A signed file keeps its meaning under both, and a reader that accepts one
// must accept the other.
const reverseMembers = (value) =>
  Array.isArray(value)
    ? value.map(reverseMembers)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([name, member]) => [name, reverseMembers(member)]),
        )
      : value;
const spaced = (json) => {
  let inString = false;
  let out = "";
  for (const character of json) {
    if (character === '"') inString = !inString;
    out += !inString && "{}[]:,".includes(character) ? ` ${character} ` : character;
  }
  return out.trim();
};

// A signature that a verifier without the small-order check accepts for any
// message: R is the identity point and S is k times the secret scalar, the
// value that makes the verification equation hold (RFC 8032 section 5.1.7).
function identitySignature(key, message) {
  const identity = Buffer.alloc(32);
  identity[0] = 1;
  const hash = crypto.createHash("sha512").update(key.seed).digest();
  const clamped = Buffer.from(hash.subarray(0, 32));
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;
  const challenge =
    littleEndian(
      crypto
        .createHash("sha512")
        .update(identity)
        .update(key.publicRaw)
        .update(message)
        .digest(),
    ) % GROUP_ORDER;
  const s = (challenge * littleEndian(clamped)) % GROUP_ORDER;
  return Buffer.concat([identity, toLittleEndian(s, 32)]);
}

// ---------------------------------------------------------------- cases

const HOST = {
  running_version: "0.1.0",
  os: "linux",
  arch: "amd64",
  track: "patch",
  now: "2026-10-10T00:00:00Z",
  service_definition: 1,
  last: null,
};
export const cases = [];
const names = new Set();

function addCase(name, about, spec, expect) {
  if (names.has(name)) throw new Error(`duplicate case name ${name}`);
  names.add(name);
  const manifest = spec.manifest ?? BASE_BYTES;
  const input = {
    name,
    about,
    manifest_b64: base64(manifest),
    signatures_b64: base64(spec.signatures ?? signedBy(["team"], manifest)),
    rollovers: spec.rollovers ?? [],
    pins: (spec.pins ?? ["team"]).map((key) => KEYS[key].fingerprint).sort(),
    floors: Object.fromEntries(
      Object.entries(spec.floors ?? {})
        .map(([key, floor]) => [KEYS[key].fingerprint, floor])
        .sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
    running_version: spec.running_version ?? HOST.running_version,
    os: spec.os ?? HOST.os,
    arch: spec.arch ?? HOST.arch,
    track: spec.track ?? HOST.track,
    now: spec.now ?? HOST.now,
    service_definition: spec.service_definition ?? HOST.service_definition,
    last: spec.last === undefined ? HOST.last : spec.last,
  };
  const wanted =
    expect.result === "valid"
      ? {
          result: "valid",
          signer: KEYS[expect.signer].fingerprint,
          pins_after: expect.pins_after
            .map((key) => KEYS[key].fingerprint)
            .sort(),
          floors_after: Object.fromEntries(
            Object.entries(expect.floors_after)
              .map(([key, floor]) => [KEYS[key].fingerprint, floor])
              .sort(([left], [right]) => (left < right ? -1 : 1)),
          ),
        }
      : expect;
  const computed = decide(input, resolveKey);
  if (JSON.stringify(computed) !== JSON.stringify(wanted))
    throw new Error(
      `case ${name}: the reference rules give ${JSON.stringify(computed)}, the case says ${JSON.stringify(wanted)}`,
    );
  cases.push({ ...input, expect: wanted });
}

const valid = (name, about, spec, signer, pinsAfter, floorsAfter) =>
  addCase(name, about, spec, {
    result: "valid",
    signer,
    pins_after: pinsAfter,
    floors_after: floorsAfter,
  });
const refused = (code) => (name, about, spec) =>
  addCase(name, about, spec, refuse(code));
const invalidManifest = refused("MANIFEST_INVALID");
const badSignature = refused("SIGNATURE_INVALID");
const notPinned = refused("KEY_NOT_PINNED");
const conflict = (name, about, spec, from, successors) =>
  addCase(
    name,
    about,
    spec,
    refuse("KEY_ROLLOVER_CONFLICT", {
      rollover_conflict: {
        from: KEYS[from].fingerprint,
        to: successors.map((key) => KEYS[key].fingerprint).sort(),
      },
    }),
  );

// A manifest that fails one rule, signed by the pinned key so that the rule
// is the only reason to refuse it.
const manifestCase = (name, about, bytes) =>
  invalidManifest(`manifest-${name}`, about, { manifest: bytes });
const edit = (from, to) => {
  if (!BASE_TEXT.includes(from)) throw new Error(`base manifest lacks ${from}`);
  return text(BASE_TEXT.replace(from, to));
};

const TEAM_7 = { team: 7 };

// -- valid

valid(
  "valid-single-signature",
  "One signature by the pinned key. The signer's floor becomes the counter.",
  {},
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-trailing-line-feed",
  "One final line feed after the object is allowed.",
  { manifest: Buffer.concat([BASE_BYTES, text("\n")]) },
  "team",
  ["team"],
  TEAM_7,
);
{
  const bytes = Buffer.concat([BASE_BYTES, text("\n")]);
  valid(
    "valid-signature-covers-the-line-feed",
    "The signature covers every delivered byte, the final line feed included.",
    { manifest: bytes, signatures: signedBy(["team"], bytes) },
    "team",
    ["team"],
    TEAM_7,
  );
}
valid(
  "valid-double-signature-both-pinned",
  "Two entries, both keys pinned: the first verifying entry is the signer and both floors advance.",
  {
    pins: ["team", "project"],
    signatures: signedBy(["project", "team"], BASE_BYTES),
  },
  "project",
  ["project", "team"],
  { project: 7, team: 7 },
);
valid(
  "valid-entry-for-unpinned-key-is-ignored",
  "An entry for a key the host does not pin is ignored, even when it comes first and its signature is wrong.",
  {
    signatures: signatureFile([
      [KEYS.outsider.fingerprint, Buffer.alloc(64, 1)],
      [KEYS.team.fingerprint, releaseSignature("team", BASE_BYTES)],
    ]),
  },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-four-signature-entries",
  "The most entries a signature file may hold; only the pinned key's entry counts.",
  {
    signatures: signatureFile([
      [KEYS.outsider.fingerprint, releaseSignature("outsider", BASE_BYTES)],
      [
        KEYS["outsider-next"].fingerprint,
        releaseSignature("outsider-next", BASE_BYTES),
      ],
      [KEYS.project.fingerprint, releaseSignature("project", BASE_BYTES)],
      [KEYS.team.fingerprint, releaseSignature("team", BASE_BYTES)],
    ]),
  },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-other-keys-floor-is-dropped",
  "A floor kept for a key the host no longer pins does not survive.",
  { floors: { outsider: 99, team: 3 } },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-counter-one-above-the-floor",
  "A counter one above the signer's floor, the highest counter attempted, is new.",
  { floors: { team: 6 } },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-counter-at-the-largest-safe-integer",
  "2^53-1 is the largest counter.",
  { manifest: text(manifestText({ counter: MAX_SAFE })) },
  "team",
  ["team"],
  { team: MAX_SAFE },
);
valid(
  "valid-minimum-version-satisfied",
  "min_from equal to the running version is satisfied.",
  { manifest: text(manifestText({ min_from: "0.1.0" })) },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-no-minimum-version",
  "min_from is optional.",
  { manifest: text(manifestText({ min_from: undefined })) },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-version-numbers-compare-as-numbers",
  "0.1.10 is newer than 0.1.9 although it sorts before it as text.",
  { manifest: releaseOf("0.1.10"), running_version: "0.1.9" },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-nine-digit-version-numbers",
  "Each version number may have nine digits.",
  {
    manifest: releaseOf("999999999.999999999.999999999"),
    running_version: "999999999.999999999.999999998",
  },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-track-minor",
  "The minor track takes a newer minor version of the same major.",
  { manifest: releaseOf("0.2.0"), track: "minor" },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-minor-track-newer-patch",
  "The minor track takes a newer patch too.",
  { manifest: releaseOf("0.1.5"), track: "minor" },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-windows-artifact-name",
  "The windows file name ends in .exe.",
  { os: "windows" },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-all-six-platforms",
  "Every platform may appear once.",
  {
    manifest: text(
      manifestText({
        artifacts: PLATFORMS.os.flatMap((os) =>
          PLATFORMS.arch.map((arch) => artifact(os, arch)),
        ),
      }),
    ),
    os: "darwin",
    arch: "arm64",
  },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-size-of-128-mib",
  "128 MiB is the largest artifact.",
  {
    manifest: text(
      manifestText({
        artifacts: [artifact("linux", "amd64", "0.1.1", BUILD_LIMIT)],
      }),
    ),
  },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-size-of-one-byte",
  "One byte is the smallest artifact.",
  {
    manifest: text(
      manifestText({ artifacts: [artifact("linux", "amd64", "0.1.1", 1)] }),
    ),
  },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-validity-of-400-days",
  "400 days between issued_at and expires_at is the longest validity.",
  {
    manifest: text(manifestText({ expires_at: "2027-11-07T12:00:00Z" })),
  },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-one-second-before-expiry",
  "A release is usable until its expires_at.",
  { now: "2027-04-01T11:59:59Z" },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-issued-24-hours-ahead-of-the-clock",
  "A host takes a release issued up to 24 hours after its own clock.",
  { now: "2026-10-02T12:00:00Z" },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-first-second-of-1970",
  "Instants start at 1970-01-01T00:00:00Z.",
  {
    manifest: text(
      manifestText({
        issued_at: "1970-01-01T00:00:00Z",
        expires_at: "1970-02-01T00:00:00Z",
      }),
    ),
    now: "1970-01-15T00:00:00Z",
  },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-leap-day",
  "February 29 of a leap year is a date.",
  {
    manifest: text(
      manifestText({
        issued_at: "2028-02-29T00:00:00Z",
        expires_at: "2028-08-26T00:00:00Z",
      }),
    ),
    now: "2028-03-01T00:00:00Z",
  },
  "team",
  ["team"],
  TEAM_7,
);
{
  const padded = text(
    BASE_TEXT.slice(0, -1) + " ".repeat(16384 - BASE_TEXT.length) + "}",
  );
  valid(
    "valid-manifest-of-exactly-16-kib",
    "16,384 bytes is the longest manifest; spaces between tokens are allowed.",
    { manifest: padded, signatures: signedBy(["team"], padded) },
    "team",
    ["team"],
    TEAM_7,
  );
}

// The profile of the signed files says what is refused, and these cases say what
// is not: a file may list its members in any order, may put spaces between any
// two tokens, and may end in one line feed. Each is signed as written.
{
  const value = JSON.parse(BASE_TEXT);
  const reordered = text(JSON.stringify(reverseMembers(value)));
  const respaced = text(spaced(BASE_TEXT));
  const both = text(`${spaced(JSON.stringify(reverseMembers(value)))}\n`);
  for (const [name, about, manifest] of [
    [
      "valid-members-in-another-order",
      "A manifest lists its members, and each artifact its own, in any order: here the opposite of the order the contract shows.",
      reordered,
    ],
    [
      "valid-spaces-between-every-token",
      "A space may stand on each side of every brace, bracket, colon and comma that is not inside a string.",
      respaced,
    ],
    [
      "valid-another-order-spaces-and-a-final-line-feed",
      "The three together: opposite order, spaces between every token and one final line feed.",
      both,
    ],
  ])
    valid(
      name,
      about,
      { manifest, signatures: signedBy(["team"], manifest) },
      "team",
      ["team"],
      TEAM_7,
    );
  if (reordered.equals(BASE_BYTES) || respaced.equals(BASE_BYTES))
    throw new Error("the written-another-way manifests must differ");
}

// -- rollovers

valid(
  "valid-rollover-to-a-successor",
  "The host pins the old key; the release is signed by its successor. The floor moves to the successor.",
  {
    rollovers: [rollover("team", "team-next")],
    signatures: signedBy(["team-next"], BASE_BYTES),
    floors: { team: 3 },
  },
  "team-next",
  ["team-next"],
  { "team-next": 7 },
);
valid(
  "valid-chain-of-two-rollovers",
  "Statements are followed in the order given.",
  {
    rollovers: [
      rollover("team", "team-next"),
      rollover("team-next", "team-final"),
    ],
    signatures: signedBy(["team-final"], BASE_BYTES),
  },
  "team-final",
  ["team-final"],
  { "team-final": 7 },
);
valid(
  "valid-chain-of-eight-rollovers",
  "Eight statements is the longest chain.",
  {
    pins: ["chain-0"],
    rollovers: Array.from({ length: 8 }, (_, index) =>
      rollover(`chain-${index}`, `chain-${index + 1}`),
    ),
    signatures: signedBy(["chain-8"], BASE_BYTES),
  },
  "chain-8",
  ["chain-8"],
  { "chain-8": 7 },
);
valid(
  "valid-rollover-for-a-key-that-is-not-pinned-is-ignored",
  "A statement from a key the host does not pin changes nothing; the release is signed by the pinned key.",
  { rollovers: [rollover("outsider", "outsider-next")] },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-identical-statement-twice",
  "The same statement twice is not a conflict: the first is followed and the second, from a key no longer pinned, is ignored.",
  {
    rollovers: [rollover("team", "team-next"), rollover("team", "team-next")],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
  "team-next",
  ["team-next"],
  { "team-next": 7 },
);
valid(
  "valid-two-statements-naming-the-same-successor",
  "Two statements that differ only in their time name one successor: no fork.",
  {
    rollovers: [
      rollover("team", "team-next", "2026-10-03T12:00:00Z"),
      rollover("team", "team-next", "2026-10-04T12:00:00Z"),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
  "team-next",
  ["team-next"],
  { "team-next": 7 },
);
valid(
  "valid-statements-from-a-replaced-key-are-ignored",
  "The host already followed team to team-next; later statements from team, even naming another key, are ignored.",
  {
    pins: ["team-next"],
    rollovers: [rollover("team", "team-next"), rollover("team", "outsider")],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
  "team-next",
  ["team-next"],
  { "team-next": 7 },
);
valid(
  "valid-rollover-to-a-key-already-pinned",
  "The replaced key leaves the set; the successor was already in it.",
  {
    pins: ["team", "team-next"],
    rollovers: [rollover("team", "team-next")],
    signatures: signedBy(["team-next"], BASE_BYTES),
    floors: { team: 2, "team-next": 1 },
  },
  "team-next",
  ["team-next"],
  { "team-next": 7 },
);
{
  // The floors of a chain. Neither key signs the release (project does), so the
  // floors the host holds afterwards show what the chain did to them.
  const throughChain = {
    pins: ["team", "team-next", "project"],
    rollovers: [rollover("team", "team-next")],
    signatures: signedBy(["project"], BASE_BYTES),
  };
  valid(
    "valid-pinned-successor-keeps-the-higher-floor-it-had",
    "The host pins team and team-next and follows team to team-next. The successor's own floor, 9, is higher than the replaced key's, 3, and stays 9.",
    { ...throughChain, floors: { team: 3, "team-next": 9 } },
    "project",
    ["project", "team-next"],
    { project: 7, "team-next": 9 },
  );
  valid(
    "valid-pinned-successor-takes-the-higher-floor-of-the-replaced-key",
    "The replaced key's floor, 9, is higher than the successor's own, 3: the successor holds 9.",
    { ...throughChain, floors: { team: 9, "team-next": 3 } },
    "project",
    ["project", "team-next"],
    { project: 7, "team-next": 9 },
  );
  valid(
    "valid-successor-that-inherits-no-floor-has-none-after",
    "Neither team nor its successor has attempted anything: the successor holds no floor, and a floor of 0 is not listed.",
    { ...throughChain, pins: ["team", "project"] },
    "project",
    ["project", "team-next"],
    { project: 7 },
  );
}
valid(
  "valid-floor-of-zero-is-not-listed",
  "A pinned key whose floor is 0, nothing attempted, has no floor after the release; the signer's is the counter.",
  { pins: ["team", "project"], floors: { project: 0 } },
  "team",
  ["project", "team"],
  TEAM_7,
);
{
  const value = JSON.parse(statementText("team", "team-next"));
  for (const [name, about, written] of [
    [
      "valid-statement-members-in-another-order",
      "A rollover statement lists its members in any order.",
      JSON.stringify(reverseMembers(value)),
    ],
    [
      "valid-statement-spaces-between-every-token",
      "A space may stand between any two tokens of a statement.",
      spaced(JSON.stringify(value)),
    ],
    [
      "valid-statement-with-a-final-line-feed",
      "One final line feed may end a statement; the signature covers it, as it covers every delivered byte.",
      `${JSON.stringify(value)}\n`,
    ],
  ])
    valid(
      name,
      about,
      {
        rollovers: [envelopeFor("team", text(written))],
        signatures: signedBy(["team-next"], BASE_BYTES),
      },
      "team-next",
      ["team-next"],
      { "team-next": 7 },
    );
}
notPinned(
  "refused-rollover-from-an-unpinned-key",
  "The release is signed by the successor in a statement the host cannot accept.",
  {
    rollovers: [rollover("outsider", "team-next")],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollovers-out-of-order",
  "A statement whose from key is not yet pinned when its turn comes is ignored.",
  {
    rollovers: [
      rollover("team-next", "team-final"),
      rollover("team", "team-next"),
    ],
    signatures: signedBy(["team-final"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-with-a-wrong-signature",
  "The statement is signed by another key than its from key.",
  {
    rollovers: [
      envelopeFor("outsider", text(statementText("team", "team-next"))),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-signed-by-another-pinned-key",
  "team's statement is signed by project, which the host pins too. The signature verifies under project and not under team, the key the statement says it replaces, so the statement is ignored and the release signed by the successor finds no pinned key.",
  {
    pins: ["team", "project"],
    rollovers: [
      envelopeFor("project", text(statementText("team", "team-next"))),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-from-the-second-pin-signed-by-the-first",
  "project's statement is signed by team, which the host pins too: a statement is judged by the key it names as from, whichever pinned key signed it.",
  {
    pins: ["team", "project"],
    rollovers: [envelopeFor("team", text(statementText("project", "outsider")))],
    signatures: signedBy(["outsider"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-signed-by-its-own-successor",
  "The new key vouches for itself: the statement is signed by team-next, not by team, so it is ignored.",
  {
    rollovers: [
      envelopeFor("team-next", text(statementText("team", "team-next"))),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-with-the-release-prefix",
  "A statement signed over the release prefix is not a statement.",
  {
    rollovers: [
      envelopeFor(
        "team",
        text(statementText("team", "team-next")),
        RELEASE_PREFIX,
      ),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-without-the-prefix",
  "A statement signed over its bytes alone is not a statement.",
  {
    rollovers: [
      envelopeFor("team", text(statementText("team", "team-next")), ""),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-statement-with-another-schema",
  "The statement's schema must be exact.",
  {
    rollovers: [
      envelopeFor(
        "team",
        text(
          statementText("team", "team-next").replace(
            "rollover.v1",
            "rollover.v2",
          ),
        ),
      ),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-to-a-malformed-key-line",
  "The to member must be a valid public key line.",
  {
    rollovers: [
      envelopeFor(
        "team",
        text(
          statementText("team", "team-next").replace(
            KEYS["team-next"].line.split(" ")[2],
            "AAAA",
          ),
        ),
      ),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-from-uppercase-fingerprint",
  "The from member is lowercase hexadecimal.",
  {
    rollovers: [
      envelopeFor(
        "team",
        text(
          statementText("team", "team-next").replace(
            KEYS.team.fingerprint,
            KEYS.team.fingerprint.toUpperCase(),
          ),
        ),
      ),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-to-itself",
  "A statement that replaces a key with itself is not a statement.",
  {
    rollovers: [
      envelopeFor(
        "team",
        text(statementJson(KEYS.team.fingerprint, KEYS.team.line)),
      ),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-statement-as-an-array",
  "A statement is one object. The four values in an array are not a statement, though they are in the order of its members.",
  {
    rollovers: [
      envelopeFor(
        "team",
        text(
          JSON.stringify(Object.values(JSON.parse(statementText("team", "team-next")))),
        ),
      ),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-statement-member-name-in-another-case",
  "Member names are matched exactly: From is not from, so from is missing and From is an unknown member.",
  {
    rollovers: [
      envelopeFor(
        "team",
        text(statementText("team", "team-next").replace('"from":', '"From":')),
      ),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
notPinned(
  "refused-rollover-with-a-bad-envelope",
  "The statement's base64 holds no whitespace.",
  {
    rollovers: [
      {
        ...rollover("team", "team-next"),
        statement_b64: `${rollover("team", "team-next").statement_b64.slice(0, 8)}\n${rollover("team", "team-next").statement_b64.slice(8)}`,
      },
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
);
{
  const identityKey = Buffer.alloc(32);
  identityKey[0] = 1;
  const toIdentity = envelopeFor(
    "team",
    text(
      statementJson(KEYS.team.fingerprint, keyLine(identityKey, "identity")),
    ),
  );
  notPinned(
    "refused-rollover-to-a-small-order-key",
    "The to key is the identity point, which accepts a universal signature. The statement is ignored, so the release it would have vouched for finds no pinned key.",
    {
      rollovers: [toIdentity],
      signatures: signatureFile([
        [
          sha256Hex(identityKey),
          Buffer.concat([identityKey, Buffer.alloc(32)]),
        ],
      ]),
    },
  );
}
conflict(
  "refused-two-statements-naming-different-successors",
  "Two statements from one pinned key naming different successors: someone else holds the key. The host reports both successors.",
  {
    rollovers: [rollover("team", "team-next"), rollover("team", "outsider")],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
  "team",
  ["team-next", "outsider"],
);
conflict(
  "refused-conflict-in-the-other-order",
  "The order of the two statements does not matter.",
  {
    rollovers: [rollover("team", "outsider"), rollover("team", "team-next")],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
  "team",
  ["team-next", "outsider"],
);
conflict(
  "refused-conflict-even-when-the-release-is-signed-by-the-pinned-key",
  "The conflict is evidence against the key, whoever signed the release.",
  { rollovers: [rollover("team", "team-next"), rollover("team", "outsider")] },
  "team",
  ["team-next", "outsider"],
);
conflict(
  "refused-conflict-reports-the-first-two-successors",
  "With three successors the host reports the first statement's and the first that differs from it.",
  {
    rollovers: [
      rollover("team", "team-next"),
      rollover("team", "outsider"),
      rollover("team", "outsider-next"),
    ],
    signatures: signedBy(["team-next"], BASE_BYTES),
  },
  "team",
  ["team-next", "outsider"],
);
conflict(
  "refused-conflict-deeper-in-the-chain",
  "A key that joined the pins through the chain can fork too.",
  {
    rollovers: [
      rollover("team", "team-next"),
      rollover("team-next", "team-final"),
      rollover("team-next", "outsider"),
    ],
    signatures: signedBy(["team-final"], BASE_BYTES),
  },
  "team-next",
  ["team-final", "outsider"],
);
notPinned(
  "refused-a-fork-signed-by-the-wrong-key-is-no-fork",
  "The second statement's signature is not the from key's, so it is ignored: the first is followed, and the release signed by the thief's key finds no pinned key.",
  {
    rollovers: [
      rollover("team", "team-next"),
      envelopeFor("outsider", text(statementText("team", "outsider-next"))),
    ],
    signatures: signedBy(["outsider-next"], BASE_BYTES),
  },
);
invalidManifest(
  "refused-nine-rollovers",
  "An offer carries at most eight statements.",
  {
    pins: ["chain-0"],
    rollovers: Array.from({ length: 9 }, (_, index) =>
      rollover(`chain-${index}`, `chain-${index + 1}`),
    ),
    signatures: signedBy(["chain-8"], BASE_BYTES),
  },
);

// -- keys and signatures

notPinned(
  "refused-key-not-pinned",
  "The only entry names a key the host does not pin.",
  { signatures: signedBy(["outsider"], BASE_BYTES) },
);
notPinned("refused-no-pinned-keys", "A host with no pins accepts nothing.", {
  pins: [],
});
notPinned(
  "refused-entry-for-an-unknown-fingerprint",
  "A fingerprint that names no known key is just an unpinned key.",
  {
    signatures: signatureFile([
      [sha256Hex("no such key"), releaseSignature("team", BASE_BYTES)],
    ]),
  },
);
notPinned(
  "refused-successor-signature-without-a-statement",
  "A release signed by the successor needs the statement that replaces the pinned key.",
  { signatures: signedBy(["team-next"], BASE_BYTES) },
);
badSignature(
  "refused-flipped-manifest-byte",
  "One byte of the manifest changed after signing.",
  {
    manifest: text(BASE_TEXT.replace('"counter":7', '"counter":8')),
    signatures: signedBy(["team"], BASE_BYTES),
  },
);
badSignature(
  "refused-flipped-signature-byte",
  "One bit of the signature changed.",
  {
    signatures: signatureFile([
      [
        KEYS.team.fingerprint,
        (() => {
          const copy = Buffer.from(releaseSignature("team", BASE_BYTES));
          copy[10] ^= 1;
          return copy;
        })(),
      ],
    ]),
  },
);
badSignature(
  "refused-signature-without-the-prefix",
  "The signature covers the manifest alone, without the prefix.",
  {
    signatures: signatureFile([
      [KEYS.team.fingerprint, releaseSignature("team", BASE_BYTES, "")],
    ]),
  },
);
badSignature(
  "refused-prefix-of-the-rollover-statement",
  "The signature covers the manifest under the rollover prefix.",
  {
    signatures: signatureFile([
      [
        KEYS.team.fingerprint,
        releaseSignature("team", BASE_BYTES, ROLLOVER_PREFIX),
      ],
    ]),
  },
);
badSignature(
  "refused-prefix-without-its-line-feed",
  "The prefix ends in a line feed.",
  {
    signatures: signatureFile([
      [
        KEYS.team.fingerprint,
        releaseSignature("team", BASE_BYTES, "vectory-agent-release-v1"),
      ],
    ]),
  },
);
badSignature(
  "refused-prefix-of-another-version",
  "A v2 prefix is another message.",
  {
    signatures: signatureFile([
      [
        KEYS.team.fingerprint,
        releaseSignature("team", BASE_BYTES, "vectory-agent-release-v2\n"),
      ],
    ]),
  },
);
badSignature(
  "refused-entry-claims-the-pinned-key-with-another-keys-signature",
  "The entry names the pinned key; the signature is by another. The key field only selects which pinned key to try.",
  {
    signatures: signatureFile([
      [KEYS.team.fingerprint, releaseSignature("outsider", BASE_BYTES)],
    ]),
  },
);
badSignature(
  "refused-only-the-unverifying-entry-is-pinned",
  "The pinned key's entry is wrong; a valid entry for an unpinned key does not help.",
  {
    signatures: signatureFile([
      [KEYS.team.fingerprint, Buffer.alloc(64, 7)],
      [KEYS.outsider.fingerprint, releaseSignature("outsider", BASE_BYTES)],
    ]),
  },
);
{
  const good = releaseSignature("team", BASE_BYTES);
  const malleable = Buffer.concat([
    good.subarray(0, 32),
    toLittleEndian(littleEndian(good.subarray(32)) + GROUP_ORDER, 32),
  ]);
  badSignature(
    "refused-signature-with-s-not-below-the-group-order",
    "S plus the group order is the same point and another encoding; a verifier refuses it (RFC 8032, 5.1.7).",
    { signatures: signatureFile([[KEYS.team.fingerprint, malleable]]) },
  );
}
{
  const message = Buffer.concat([text(RELEASE_PREFIX), BASE_BYTES]);
  const forged = identitySignature(KEYS.team, message);
  if (
    !crypto.verify(null, message, KEYS.team.publicKey, forged) ||
    strictVerify(KEYS.team.publicKey, message, forged)
  )
    throw new Error(
      "the identity-R signature must satisfy the equation and still be refused",
    );
  badSignature(
    "refused-signature-whose-r-is-the-identity-point",
    "R is the identity point and S is made from the key's own scalar, so the verification equation holds; a host refuses a small-order R.",
    { signatures: signatureFile([[KEYS.team.fingerprint, forged]]) },
  );
}
{
  const entryOf = (name, signature) => ({
    key: KEYS[name].fingerprint,
    signature: base64(signature),
  });
  const file = (value) => text(JSON.stringify(value));
  const goodSignature = releaseSignature("team", BASE_BYTES);
  const goodFile = signedBy(["team"], BASE_BYTES).toString("latin1");
  const mutated = (mutate) => text(mutate(goodFile));
  const withSignature = (replacement) =>
    file({
      schema: "vectory.agent-release-signatures.v1",
      signatures: [{ key: KEYS.team.fingerprint, signature: replacement }],
    });
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const nonZeroPaddingBits = (() => {
    const encoded = base64(goodSignature);
    const last = encoded[encoded.length - 3];
    return (
      encoded.slice(0, -3) + alphabet[(alphabet.indexOf(last) + 1) % 64] + "=="
    );
  })();
  const signatureFileCases = [
    ["empty", "An empty file.", Buffer.alloc(0)],
    ["not-json", "Not JSON.", text("signatures")],
    [
      "leading-space",
      "No byte may precede the object.",
      mutated((good) => ` ${good}`),
    ],
    [
      "byte-order-mark",
      "A byte-order mark is not ASCII.",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), text(goodFile)]),
    ],
    [
      "trailing-data",
      "Anything after the object.",
      mutated((good) => `${good}x`),
    ],
    [
      "two-trailing-line-feeds",
      "At most one final line feed.",
      mutated((good) => `${good}\n\n`),
    ],
    [
      "duplicate-member",
      "A member twice.",
      mutated((good) =>
        good.replace('"signatures":', '"schema":"x","signatures":'),
      ),
    ],
    [
      "unknown-member",
      "A member the format does not name.",
      mutated((good) =>
        good.replace('"signatures":', '"extra":1,"signatures":'),
      ),
    ],
    [
      "wrong-schema",
      "The schema must be exact.",
      mutated((good) => good.replace("signatures.v1", "signatures.v2")),
    ],
    [
      "missing-signatures",
      "Both members are required.",
      file({ schema: "vectory.agent-release-signatures.v1" }),
    ],
    [
      "signatures-not-an-array",
      "signatures is an array.",
      file({
        schema: "vectory.agent-release-signatures.v1",
        signatures: entryOf("team", goodSignature),
      }),
    ],
    [
      "no-entries",
      "One to four entries.",
      file({ schema: "vectory.agent-release-signatures.v1", signatures: [] }),
    ],
    [
      "five-entries",
      "One to four entries.",
      file({
        schema: "vectory.agent-release-signatures.v1",
        signatures: [
          "team",
          "outsider",
          "outsider-next",
          "project",
          "team-next",
        ].map((name) => entryOf(name, goodSignature)),
      }),
    ],
    [
      "repeated-key",
      "Entries name distinct keys.",
      file({
        schema: "vectory.agent-release-signatures.v1",
        signatures: [
          entryOf("team", goodSignature),
          entryOf("team", goodSignature),
        ],
      }),
    ],
    [
      "entry-with-an-extra-member",
      "An entry has exactly key and signature.",
      mutated((good) => good.replace('"signature":', '"extra":1,"signature":')),
    ],
    [
      "entry-without-a-signature",
      "An entry has exactly key and signature.",
      file({
        schema: "vectory.agent-release-signatures.v1",
        signatures: [{ key: KEYS.team.fingerprint }],
      }),
    ],
    [
      "uppercase-key",
      "A fingerprint is lowercase hexadecimal.",
      mutated((good) =>
        good.replace(
          KEYS.team.fingerprint,
          KEYS.team.fingerprint.toUpperCase(),
        ),
      ),
    ],
    [
      "short-key",
      "A fingerprint is 64 characters.",
      mutated((good) =>
        good.replace(KEYS.team.fingerprint, KEYS.team.fingerprint.slice(1)),
      ),
    ],
    [
      "non-hex-key",
      "A fingerprint is hexadecimal.",
      mutated((good) => good.replace(KEYS.team.fingerprint, "g".repeat(64))),
    ],
    [
      "signature-of-63-bytes",
      "A signature is 64 bytes.",
      withSignature(base64(goodSignature.subarray(0, 63))),
    ],
    [
      "signature-of-65-bytes",
      "A signature is 64 bytes.",
      withSignature(base64(Buffer.concat([goodSignature, Buffer.from([0])]))),
    ],
    [
      "signature-without-padding",
      "Base64 is padded.",
      withSignature(base64(goodSignature).replace(/=+$/, "")),
    ],
    [
      "signature-in-the-url-alphabet",
      "Base64 uses the standard alphabet.",
      withSignature(
        base64(
          Buffer.concat([Buffer.from([0xfb, 0xff]), goodSignature.subarray(2)]),
        )
          .replaceAll("+", "-")
          .replaceAll("/", "_"),
      ),
    ],
    [
      "signature-with-nonzero-padding-bits",
      "Base64 is canonical: the unused bits are zero.",
      withSignature(nonZeroPaddingBits),
    ],
    [
      "signature-with-a-space",
      "Base64 holds no whitespace.",
      withSignature(
        `${base64(goodSignature).slice(0, 8)} ${base64(goodSignature).slice(8)}`,
      ),
    ],
    [
      "signature-not-a-string",
      "A signature is a string.",
      text(
        `{"schema":"vectory.agent-release-signatures.v1","signatures":[{"key":"${KEYS.team.fingerprint}","signature":7}]}`,
      ),
    ],
    [
      "escaped-character",
      "No backslash occurs in the file.",
      mutated((good) => good.replace("v1", `v${BACKSLASH}u0031`)),
    ],
    [
      "non-ascii-byte",
      "Only printable ASCII.",
      Buffer.concat([
        text(goodFile).subarray(0, 20),
        Buffer.from(E_ACUTE, "utf8"),
        text(goodFile).subarray(20),
      ]),
    ],
    [
      "entry-as-an-array",
      "An entry is an object with key and signature, not an array of the two values in that order.",
      file({
        schema: "vectory.agent-release-signatures.v1",
        signatures: [[KEYS.team.fingerprint, base64(goodSignature)]],
      }),
    ],
    [
      "member-name-in-another-case",
      "Member names are matched exactly: Schema is not schema, so schema is missing and Schema is an unknown member.",
      mutated((good) => good.replace('"schema":', '"Schema":')),
    ],
    [
      "entry-member-name-in-another-case",
      "Member names are matched exactly in an entry too: Key is not key.",
      mutated((good) => good.replace('"key":', '"Key":')),
    ],
    [
      "over-4-kib",
      "At most 4,096 bytes.",
      text(goodFile.slice(0, -1) + " ".repeat(4097 - goodFile.length) + "}"),
    ],
  ];
  for (const [name, about, bytes] of signatureFileCases)
    badSignature(`signature-file-${name}`, about, { signatures: bytes });
  valid(
    "valid-signature-file-of-exactly-4-kib",
    "4,096 bytes is the longest signature file.",
    {
      signatures: text(
        goodFile.slice(0, -1) + " ".repeat(4096 - goodFile.length) + "}",
      ),
    },
    "team",
    ["team"],
    TEAM_7,
  );
  const goodValue = JSON.parse(goodFile);
  for (const [name, about, written] of [
    [
      "valid-signature-file-members-in-another-order",
      "A signature file lists its members, and each entry its own, in any order.",
      JSON.stringify(reverseMembers(goodValue)),
    ],
    [
      "valid-signature-file-spaces-between-every-token",
      "A space may stand between any two tokens of a signature file.",
      spaced(goodFile),
    ],
    [
      "valid-signature-file-with-a-final-line-feed",
      "One final line feed may end a signature file.",
      `${goodFile}\n`,
    ],
    [
      "valid-signature-file-another-order-spaces-and-a-final-line-feed",
      "The three together.",
      `${spaced(JSON.stringify(reverseMembers(goodValue)))}\n`,
    ],
  ])
    valid(name, about, { signatures: text(written) }, "team", ["team"], TEAM_7);
}

// -- manifests

{
  const without = (member) => {
    const value = JSON.parse(BASE_TEXT);
    delete value[member];
    return text(JSON.stringify(value));
  };
  for (const member of [
    "schema",
    "version",
    "counter",
    "issued_at",
    "expires_at",
    "service_definition",
    "artifacts",
  ])
    manifestCase(
      `missing-${member}`,
      `${member} is required.`,
      without(member),
    );
  for (const member of ["os", "arch", "format", "file", "size", "sha256"]) {
    const value = JSON.parse(BASE_TEXT);
    delete value.artifacts[0][member];
    manifestCase(
      `artifact-missing-${member}`,
      `${member} is required in every artifact.`,
      text(JSON.stringify(value)),
    );
  }

  const padding = (count) =>
    text(BASE_TEXT.slice(0, -1) + " ".repeat(count) + "}");
  const escaped = (member, replacement) => edit(member, replacement);
  const syntax = [
    ["empty", "An empty file.", Buffer.alloc(0)],
    ["only-a-line-feed", "A line feed alone.", text("\n")],
    ["leading-space", "No byte may precede the object.", text(` ${BASE_TEXT}`)],
    [
      "leading-line-feed",
      "No byte may precede the object.",
      text(`\n${BASE_TEXT}`),
    ],
    [
      "byte-order-mark",
      "A byte-order mark is not ASCII.",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), BASE_BYTES]),
    ],
    ["trailing-data", "Anything after the object.", text(`${BASE_TEXT}x`)],
    ["second-object", "Anything after the object.", text(`${BASE_TEXT}{}`)],
    ["trailing-space", "Only a line feed may follow.", text(`${BASE_TEXT} `)],
    [
      "two-trailing-line-feeds",
      "At most one final line feed.",
      text(`${BASE_TEXT}\n\n`),
    ],
    [
      "trailing-carriage-return",
      "A carriage return is not printable.",
      text(`${BASE_TEXT}\r\n`),
    ],
    [
      "line-feed-inside",
      "Spaces are the only whitespace between tokens.",
      text(BASE_TEXT.replace('",', '",\n')),
    ],
    [
      "tab-inside",
      "Spaces are the only whitespace between tokens.",
      text(BASE_TEXT.replace('",', '",\t')),
    ],
    [
      "nul-byte",
      "Control bytes are refused.",
      Buffer.concat([
        BASE_BYTES.subarray(0, 30),
        Buffer.from([0]),
        BASE_BYTES.subarray(30),
      ]),
    ],
    [
      "del-byte",
      "0x7F is not printable.",
      Buffer.concat([
        BASE_BYTES.subarray(0, 30),
        Buffer.from([0x7f]),
        BASE_BYTES.subarray(30),
      ]),
    ],
    [
      "non-ascii-byte-in-a-string",
      "A raw non-ASCII byte inside a value.",
      Buffer.from(
        BASE_TEXT.replace(
          "vectory-0.1.1-linux-amd64",
          `vectory-0.1.1-linux-amd64${E_ACUTE}`,
        ),
        "utf8",
      ),
    ],
    [
      "non-ascii-byte-between-tokens",
      "A no-break space between tokens.",
      Buffer.from(BASE_TEXT.replace('",', `",${NO_BREAK_SPACE}`), "utf8"),
    ],
    ["array", "The file is one object.", text(`[${BASE_TEXT}]`)],
    ["not-json", "Not JSON.", text("vectory")],
    [
      "single-quotes",
      "Strings use double quotes.",
      text(BASE_TEXT.replaceAll('"', "'")),
    ],
    [
      "trailing-comma",
      "No trailing comma.",
      text(BASE_TEXT.replace(/\}$/, ",}")),
    ],
    ["comment", "No comments.", text(BASE_TEXT.replace(/\}$/, "/* */}"))],
    [
      "unterminated-string",
      "A string must end.",
      text(BASE_TEXT.replace('"0.1.1"', '"0.1.1')),
    ],
    [
      "missing-closing-brace",
      "The object must end.",
      text(BASE_TEXT.slice(0, -1)),
    ],
    ["over-16-kib", "At most 16,384 bytes.", padding(16385 - BASE_TEXT.length)],
    [
      "duplicate-member",
      "A member twice.",
      edit('"version":"0.1.1",', '"version":"0.1.1","version":"0.1.2",'),
    ],
    [
      "duplicate-member-in-an-artifact",
      "A member twice in an artifact.",
      edit('"os":"linux",', '"os":"linux","os":"linux",'),
    ],
    [
      "unknown-member",
      "A member the format does not name.",
      edit('"counter":7,', '"counter":7,"channel":"stable",'),
    ],
    [
      "unknown-member-in-an-artifact",
      "A member the format does not name, in an artifact.",
      edit('"format":"executable",', '"format":"executable","mode":"0755",'),
    ],
    [
      "escape-in-a-value",
      "No backslash occurs in the file.",
      escaped('"version":"0.1.1"', `"version":"0.1.${BACKSLASH}u0031"`),
    ],
    [
      "escaped-surrogate-pair",
      "An escaped surrogate pair.",
      escaped(
        '"version":"0.1.1"',
        `"version":"0.1.${BACKSLASH}ud83d${BACKSLASH}ude00"`,
      ),
    ],
    [
      "escaped-lone-surrogate",
      "An unpaired escaped surrogate.",
      escaped('"version":"0.1.1"', `"version":"0.1.${BACKSLASH}ud800"`),
    ],
    [
      "escape-in-a-key",
      "An escaped key could repeat another.",
      escaped('"version":', `"vers${BACKSLASH}u0069on":`),
    ],
    [
      "escaped-quote",
      "No backslash occurs in the file.",
      escaped('"version":"0.1.1"', `"version":"0.1.${BACKSLASH}"1"`),
    ],
    ["null-value", "No null.", edit('"min_from":"0.1.0"', '"min_from":null')],
    [
      "boolean-value",
      "No boolean.",
      edit('"service_definition":1', '"service_definition":true'),
    ],
    [
      "member-name-in-another-case",
      "Member names are matched exactly: Schema is not schema, so schema is missing and Schema is an unknown member.",
      edit('"schema":', '"Schema":'),
    ],
    [
      "member-name-in-another-case-in-an-artifact",
      "Member names are matched exactly in an artifact too: OS is not os.",
      edit('"os":', '"OS":'),
    ],
  ];
  for (const [name, about, bytes] of syntax)
    manifestCase(`syntax-${name}`, about, bytes);

  const numbers = [
    ["counter-exponent", '"counter":7', '"counter":1e2'],
    ["counter-capital-exponent", '"counter":7', '"counter":1E2'],
    ["counter-signed-exponent", '"counter":7', '"counter":1e+2'],
    ["counter-fraction", '"counter":7', '"counter":7.0'],
    ["counter-trailing-point", '"counter":7', '"counter":7.'],
    ["counter-leading-point", '"counter":7', '"counter":.7'],
    ["counter-negative-zero", '"counter":7', '"counter":-0'],
    ["counter-negative", '"counter":7', '"counter":-7'],
    ["counter-plus-sign", '"counter":7', '"counter":+7'],
    ["counter-leading-zero", '"counter":7', '"counter":07'],
    ["counter-double-zero", '"counter":7', '"counter":00'],
    ["counter-hexadecimal", '"counter":7', '"counter":0x7'],
    ["counter-zero", '"counter":7', '"counter":0'],
    ["counter-2-to-the-53", '"counter":7', '"counter":9007199254740992'],
    ["counter-20-digits", '"counter":7', '"counter":99999999999999999999'],
    ["counter-as-a-string", '"counter":7', '"counter":"7"'],
    ["size-exponent", '"size":15204352', '"size":1e7'],
    ["size-zero", '"size":15204352', '"size":0'],
    ["size-above-128-mib", '"size":15204352', '"size":134217729'],
    ["size-negative", '"size":15204352', '"size":-1'],
    ["size-as-a-string", '"size":15204352', '"size":"15204352"'],
    [
      "service-definition-zero",
      '"service_definition":1',
      '"service_definition":0',
    ],
    [
      "service-definition-leading-zero",
      '"service_definition":1',
      '"service_definition":01',
    ],
    [
      "service-definition-fraction",
      '"service_definition":1',
      '"service_definition":1.0',
    ],
    [
      "service-definition-2-to-the-53",
      '"service_definition":1',
      '"service_definition":9007199254740992',
    ],
    [
      "service-definition-20-digits",
      '"service_definition":1',
      '"service_definition":99999999999999999999',
    ],
    [
      "service-definition-as-a-string",
      '"service_definition":1',
      '"service_definition":"1"',
    ],
  ];
  for (const [name, from, to] of numbers)
    manifestCase(
      `number-${name}`,
      "A whole number written as 0 or 1-9 then digits, up to 2^53-1.",
      edit(from, to),
    );

  const linuxDigest = ARTIFACT_DIGESTS["linux/amd64"];
  const issued = '"issued_at":"2026-10-03T12:00:00Z"';
  const fields = [
    ["schema-v2", '"vectory.agent-release.v1"', '"vectory.agent-release.v2"'],
    [
      "schema-uppercase",
      '"vectory.agent-release.v1"',
      '"VECTORY.AGENT-RELEASE.V1"',
    ],
    [
      "schema-trailing-space",
      '"vectory.agent-release.v1"',
      '"vectory.agent-release.v1 "',
    ],
    ["schema-empty", '"vectory.agent-release.v1"', '""'],
    ["schema-not-a-string", '"vectory.agent-release.v1"', "1"],
    ["version-two-numbers", '"version":"0.1.1"', '"version":"0.1"'],
    ["version-four-numbers", '"version":"0.1.1"', '"version":"0.1.1.1"'],
    ["version-leading-zero", '"version":"0.1.1"', '"version":"0.01.1"'],
    ["version-pre-release", '"version":"0.1.1"', '"version":"0.1.1-rc.1"'],
    [
      "version-build-metadata",
      '"version":"0.1.1"',
      '"version":"0.1.1+build.5"',
    ],
    ["version-leading-v", '"version":"0.1.1"', '"version":"v0.1.1"'],
    ["version-leading-space", '"version":"0.1.1"', '"version":" 0.1.1"'],
    ["version-not-numeric", '"version":"0.1.1"', '"version":"0.1.x"'],
    ["version-empty", '"version":"0.1.1"', '"version":""'],
    [
      "version-ten-digit-number",
      '"version":"0.1.1"',
      '"version":"0.1.1234567890"',
    ],
    ["version-as-a-number", '"version":"0.1.1"', '"version":1'],
    ["min-from-pre-release", '"min_from":"0.1.0"', '"min_from":"0.1.0-dev"'],
    ["min-from-two-numbers", '"min_from":"0.1.0"', '"min_from":"0.1"'],
    ["issued-at-lowercase-t", issued, '"issued_at":"2026-10-03t12:00:00Z"'],
    ["issued-at-lowercase-z", issued, '"issued_at":"2026-10-03T12:00:00z"'],
    ["issued-at-offset", issued, '"issued_at":"2026-10-03T12:00:00+00:00"'],
    ["issued-at-fraction", issued, '"issued_at":"2026-10-03T12:00:00.5Z"'],
    ["issued-at-without-seconds", issued, '"issued_at":"2026-10-03T12:00Z"'],
    ["issued-at-a-date", issued, '"issued_at":"2026-10-03"'],
    ["issued-at-with-a-space", issued, '"issued_at":"2026-10-03 12:00:00Z"'],
    ["issued-at-february-30", issued, '"issued_at":"2026-02-30T12:00:00Z"'],
    [
      "issued-at-february-29-in-a-common-year",
      issued,
      '"issued_at":"2027-02-29T12:00:00Z"',
    ],
    ["issued-at-month-13", issued, '"issued_at":"2026-13-03T12:00:00Z"'],
    ["issued-at-day-0", issued, '"issued_at":"2026-10-00T12:00:00Z"'],
    ["issued-at-hour-24", issued, '"issued_at":"2026-10-03T24:00:00Z"'],
    ["issued-at-minute-60", issued, '"issued_at":"2026-10-03T12:60:00Z"'],
    ["issued-at-leap-second", issued, '"issued_at":"2026-10-03T12:00:60Z"'],
    ["issued-at-before-1970", issued, '"issued_at":"1969-12-31T23:59:59Z"'],
    ["issued-at-year-10000", issued, '"issued_at":"10000-01-01T00:00:00Z"'],
    [
      "expires-at-equal-to-issued-at",
      '"expires_at":"2027-04-01T12:00:00Z"',
      '"expires_at":"2026-10-03T12:00:00Z"',
    ],
    [
      "expires-at-before-issued-at",
      '"expires_at":"2027-04-01T12:00:00Z"',
      '"expires_at":"2026-10-02T12:00:00Z"',
    ],
    [
      "expires-at-after-400-days",
      '"expires_at":"2027-04-01T12:00:00Z"',
      '"expires_at":"2027-11-07T12:00:01Z"',
    ],
    ["artifact-unknown-os", '"os":"linux"', '"os":"freebsd"'],
    ["artifact-uppercase-os", '"os":"linux"', '"os":"Linux"'],
    ["artifact-unknown-arch", '"arch":"amd64"', '"arch":"386"'],
    ["artifact-x86-64-arch", '"arch":"amd64"', '"arch":"x86_64"'],
    ["artifact-archive-format", '"format":"executable"', '"format":"tar.gz"'],
    [
      "artifact-file-for-another-version",
      '"file":"vectory-0.1.1-linux-amd64"',
      '"file":"vectory-0.1.0-linux-amd64"',
    ],
    [
      "artifact-file-for-another-os",
      '"file":"vectory-0.1.1-linux-amd64"',
      '"file":"vectory-0.1.1-darwin-amd64"',
    ],
    [
      "artifact-file-for-another-arch",
      '"file":"vectory-0.1.1-linux-amd64"',
      '"file":"vectory-0.1.1-linux-arm64"',
    ],
    [
      "artifact-file-with-a-directory",
      '"file":"vectory-0.1.1-linux-amd64"',
      '"file":"../vectory-0.1.1-linux-amd64"',
    ],
    [
      "artifact-linux-file-ending-in-exe",
      '"file":"vectory-0.1.1-linux-amd64"',
      '"file":"vectory-0.1.1-linux-amd64.exe"',
    ],
    [
      "artifact-windows-file-without-exe",
      '"file":"vectory-0.1.1-windows-amd64.exe"',
      '"file":"vectory-0.1.1-windows-amd64"',
    ],
    ["artifact-file-empty", '"file":"vectory-0.1.1-linux-amd64"', '"file":""'],
    ["artifact-digest-uppercase", linuxDigest, linuxDigest.toUpperCase()],
    ["artifact-digest-63-characters", linuxDigest, linuxDigest.slice(1)],
    ["artifact-digest-65-characters", linuxDigest, `${linuxDigest}0`],
    ["artifact-digest-not-hex", linuxDigest, "z".repeat(64)],
  ];
  for (const [name, from, to] of fields)
    manifestCase(
      `field-${name}`,
      "A field rule of the manifest.",
      edit(from, to),
    );
  const artifacts = (name, about, list) =>
    manifestCase(
      `field-${name}`,
      about,
      text(manifestText({ artifacts: list })),
    );
  artifacts(
    "artifact-entry-as-an-array",
    "An artifact is an object. Its six values in an array, in the order of its members, are not an artifact.",
    [Object.values(BASE.artifacts[0])],
  );
  artifacts("artifacts-empty", "At least one artifact.", []);
  artifacts("artifacts-two-for-one-platform", "One artifact per platform.", [
    BASE.artifacts[0],
    { ...BASE.artifacts[0], sha256: sha256Hex("another") },
  ]);
  artifacts(
    "nine-artifacts",
    "At most eight artifacts.",
    Array.from({ length: 9 }, (_, index) => ({
      ...BASE.artifacts[0],
      sha256: sha256Hex(`artifact ${index}`),
    })),
  );
  manifestCase(
    "field-artifacts-an-object",
    "artifacts is an array.",
    text(
      BASE_TEXT.replace(
        /"artifacts":\[.*\]\}$/s,
        `"artifacts":${JSON.stringify(BASE.artifacts[0])}}`,
      ),
    ),
  );
  addCase(
    "refused-platform-missing",
    "The release has no build for this host.",
    {
      manifest: text(
        manifestText({ artifacts: [artifact("darwin", "arm64")] }),
      ),
    },
    refuse("PLATFORM_NOT_IN_RELEASE"),
  );
}

// -- the clock

refused("MANIFEST_EXPIRED")(
  "refused-expired",
  "The host's clock is past expires_at.",
  { now: "2027-04-02T00:00:00Z" },
);
refused("MANIFEST_EXPIRED")(
  "refused-at-the-moment-of-expiry",
  "A release is expired at expires_at itself.",
  { now: "2027-04-01T12:00:00Z" },
);
invalidManifest(
  "refused-issued-more-than-24-hours-ahead-of-the-clock",
  "A release issued 25 hours after the host's clock is refused as invalid, the direction the signed envelope already guards.",
  { now: "2026-10-02T11:00:00Z" },
);
invalidManifest(
  "refused-issued-one-second-over-24-hours-ahead",
  "24 hours and one second ahead is refused; exactly 24 hours is not.",
  { now: "2026-10-02T11:59:59Z" },
);

// -- the host's policy

const DIGEST = sha256Hex(BASE_BYTES);
refused("COUNTER_REPLAYED")(
  "refused-counter-at-the-attempted-floor",
  "A counter equal to the signer's floor, the highest counter attempted, was attempted already.",
  { floors: { team: 7 } },
);
refused("COUNTER_REPLAYED")(
  "refused-counter-below-the-floor",
  "A counter below the floor is an old release.",
  { floors: { team: 12 } },
);
refused("RELEASE_ALREADY_TRIED")(
  "refused-release-already-tried",
  "The counter is at the floor and the host's last result names this manifest as rolled back.",
  { floors: { team: 7 }, last: { release: DIGEST, outcome: "rolled_back" } },
);
refused("RELEASE_ALREADY_TRIED")(
  "refused-rolled-back-release-after-a-newer-attempt",
  "The floor moved on; the last result still names this manifest as rolled back.",
  { floors: { team: 9 }, last: { release: DIGEST, outcome: "rolled_back" } },
);
refused("COUNTER_REPLAYED")(
  "refused-counter-at-the-floor-after-a-commit",
  "The last result names this manifest, but it was committed, not rolled back.",
  { floors: { team: 7 }, last: { release: DIGEST, outcome: "committed" } },
);
refused("COUNTER_REPLAYED")(
  "refused-counter-at-the-floor-another-release-rolled-back",
  "The last result names another manifest.",
  {
    floors: { team: 7 },
    last: { release: sha256Hex("another manifest"), outcome: "rolled_back" },
  },
);
valid(
  "valid-last-result-names-this-manifest-but-the-counter-is-new",
  "The floor decides, not the last result: a counter above it is new.",
  { floors: { team: 6 }, last: { release: DIGEST, outcome: "rolled_back" } },
  "team",
  ["team"],
  TEAM_7,
);
refused("COUNTER_REPLAYED")(
  "refused-floor-carried-over-a-rollover",
  "The old key's floor guards its successor.",
  {
    rollovers: [rollover("team", "team-next")],
    signatures: signedBy(["team-next"], BASE_BYTES),
    floors: { team: 7 },
  },
);
refused("COUNTER_REPLAYED")(
  "refused-when-one-of-two-signers-has-attempted-it",
  "Every verifying pinned signer must find the counter new.",
  {
    pins: ["team", "project"],
    signatures: signedBy(["team", "project"], BASE_BYTES),
    floors: { team: 7, project: 3 },
  },
);
{
  // Two signers, listed project first. The floor that refuses the release is
  // the first signer's in one case and the second's in the other, and a host
  // that looks at only one of them passes one case and fails the other.
  const twoSigners = {
    pins: ["team", "project"],
    signatures: signedBy(["project", "team"], BASE_BYTES),
  };
  refused("COUNTER_REPLAYED")(
    "refused-when-the-first-signer-in-the-file-has-attempted-it",
    "project signs first and its floor is the counter; team's is below it. Every verifying pinned signer is checked.",
    { ...twoSigners, floors: { project: 7, team: 3 } },
  );
  refused("COUNTER_REPLAYED")(
    "refused-when-the-second-signer-in-the-file-has-attempted-it",
    "project signs first and its floor is below the counter; the second signer, team, has attempted it. Checking only the first signer would take this release.",
    { ...twoSigners, floors: { project: 3, team: 7 } },
  );
  valid(
    "valid-the-floor-of-a-pinned-key-whose-signature-fails-is-not-checked",
    "project's entry does not verify, so project is not a signer: its floor, 9, does not refuse the release, and it keeps that floor. team signs.",
    {
      pins: ["team", "project"],
      signatures: signatureFile([
        [KEYS.team.fingerprint, releaseSignature("team", BASE_BYTES)],
        [KEYS.project.fingerprint, Buffer.alloc(64, 7)],
      ]),
      floors: { project: 9 },
    },
    "team",
    ["project", "team"],
    { project: 9, team: 7 },
  );
}
refused("COUNTER_REPLAYED")(
  "refused-pinned-successor-keeps-the-floor-it-had",
  "The host pins team and team-next and follows team to team-next, which signs the release. The successor's own floor, 9, is above the counter although the replaced key's, 3, is not.",
  {
    pins: ["team", "team-next"],
    rollovers: [rollover("team", "team-next")],
    signatures: signedBy(["team-next"], BASE_BYTES),
    floors: { team: 3, "team-next": 9 },
  },
);
refused("COUNTER_REPLAYED")(
  "refused-pinned-successor-takes-the-floor-of-the-replaced-key",
  "The replaced key's floor, 9, is above the counter and the successor's own, 3, is not: the successor holds 9.",
  {
    pins: ["team", "team-next"],
    rollovers: [rollover("team", "team-next")],
    signatures: signedBy(["team-next"], BASE_BYTES),
    floors: { team: 9, "team-next": 3 },
  },
);
refused("ALREADY_RUNNING")(
  "refused-same-version-as-running",
  "The release is the running version.",
  { running_version: "0.1.1" },
);
refused("DOWNGRADE_REFUSED")(
  "refused-older-patch",
  "The running version is newer.",
  { running_version: "0.1.2" },
);
refused("DOWNGRADE_REFUSED")(
  "refused-older-minor",
  "The running version is newer. The release is also off the patch track; the version check comes first.",
  { running_version: "0.2.0" },
);
refused("DOWNGRADE_REFUSED")(
  "refused-older-major",
  "The running version is newer.",
  { running_version: "1.0.0" },
);
refused("DOWNGRADE_REFUSED")(
  "refused-version-numbers-compare-as-numbers",
  "0.1.9 is older than 0.1.10 although it sorts after it as text.",
  { manifest: releaseOf("0.1.9"), running_version: "0.1.10" },
);
{
  // A running version that is not major.minor.patch cannot be compared with the
  // release's, so the host refuses it as it refuses a downgrade and never
  // guesses which of the two is newer. Read leniently, most of these are 0.1.0:
  // older than the release 0.1.1 and on the patch track, so a host that guesses
  // takes the release.
  const unreadable = [
    [
      "refused-running-version-with-a-pre-release-suffix",
      "0.1.0-dev, the version of a development build, has a suffix.",
      "0.1.0-dev",
    ],
    [
      "refused-running-version-with-build-metadata",
      "0.1.0+5 carries build metadata.",
      "0.1.0+5",
    ],
    [
      "refused-running-version-with-a-leading-v",
      "v0.1.0 is a tag, not a version.",
      "v0.1.0",
    ],
    [
      "refused-running-version-that-is-empty",
      "An empty string is not a version.",
      "",
    ],
    [
      "refused-running-version-that-is-a-word",
      "dev is not a version.",
      "dev",
    ],
    [
      "refused-running-version-with-two-numbers",
      "0.1 has two numbers.",
      "0.1",
    ],
    [
      "refused-running-version-with-four-numbers",
      "0.1.0.0 has four numbers.",
      "0.1.0.0",
    ],
    [
      "refused-running-version-with-an-empty-number",
      "0.1. has no patch number.",
      "0.1.",
    ],
    [
      "refused-running-version-with-a-leading-zero",
      "0.01.0 writes the number 1 with a leading zero.",
      "0.01.0",
    ],
    [
      "refused-running-version-with-a-plus-sign",
      "0.1.+0 puts a sign on a number, which a function that parses integers takes.",
      "0.1.+0",
    ],
    [
      "refused-running-version-with-a-minus-sign",
      "0.1.-0 puts a sign on a number, which a function that parses integers takes.",
      "0.1.-0",
    ],
    [
      "refused-running-version-with-a-letter-after-a-number",
      "0.1.0a: a reader that stops at the first character that is not a digit takes 0.1.0.",
      "0.1.0a",
    ],
    [
      "refused-running-version-with-a-letter-for-a-number",
      "0.1.x has no patch number.",
      "0.1.x",
    ],
    [
      "refused-running-version-with-a-leading-space",
      "A space before 0.1.0 is not trimmed.",
      " 0.1.0",
    ],
    [
      "refused-running-version-with-a-trailing-space",
      "A space after 0.1.0 is not trimmed.",
      "0.1.0 ",
    ],
    [
      "refused-running-version-with-a-trailing-line-feed",
      "A line feed after 0.1.0 is not trimmed.",
      "0.1.0\n",
    ],
    [
      "refused-running-version-with-digits-that-are-not-ascii",
      "The numbers are written with the full-width digits 0, 1 and 0.",
      [0, 1, 0].map((digit) => String.fromCharCode(0xff10 + digit)).join("."),
    ],
  ];
  for (const [name, about, running] of unreadable)
    refused("DOWNGRADE_REFUSED")(
      name,
      `${about} It cannot be compared with the release's, so it is refused as a downgrade.`,
      { running_version: running },
    );
  // Ten digits is one too many. The release is newer than 0.0.1000000000 on the
  // minor track and has no minimum, so a host that reads the number takes it.
  refused("DOWNGRADE_REFUSED")(
    "refused-running-version-with-a-ten-digit-number",
    "A version number has at most nine digits, so 0.0.1000000000 cannot be compared with the release's and is refused as a downgrade.",
    {
      manifest: releaseOf("0.1.1"),
      running_version: "0.0.1000000000",
      track: "minor",
    },
  );
}
refused("VERSION_NOT_ON_TRACK")(
  "refused-patch-track-newer-minor",
  "The patch track keeps the running major and minor.",
  { manifest: releaseOf("0.2.0") },
);
refused("VERSION_NOT_ON_TRACK")(
  "refused-patch-track-newer-major",
  "The patch track keeps the running major and minor.",
  { manifest: releaseOf("1.0.0") },
);
refused("VERSION_NOT_ON_TRACK")(
  "refused-minor-track-newer-major",
  "The minor track keeps the running major: a major jump is never remote.",
  { manifest: releaseOf("1.0.0"), track: "minor" },
);
refused("AGENT_TOO_OLD")(
  "refused-running-version-below-the-minimum",
  "min_from is newer than the running version.",
  {
    manifest: releaseOf("0.3.0", { min_from: "0.2.0" }),
    track: "minor",
  },
);
refused("PLATFORM_NOT_IN_RELEASE")(
  "refused-other-architecture",
  "The release has no linux/arm64 build.",
  { arch: "arm64" },
);
refused("PLATFORM_NOT_IN_RELEASE")(
  "refused-other-operating-system",
  "The release has no darwin/amd64 build.",
  { os: "darwin" },
);
refused("SERVICE_DEFINITION_OUTDATED")(
  "refused-newer-service-definition",
  "The release needs a service definition newer than the host's.",
  { manifest: text(manifestText({ service_definition: 2 })) },
);
valid(
  "valid-service-definition-the-host-has",
  "The host's definition is as new as the release needs.",
  {
    manifest: text(manifestText({ service_definition: 2 })),
    service_definition: 2,
  },
  "team",
  ["team"],
  TEAM_7,
);
valid(
  "valid-a-host-with-a-newer-service-definition",
  "The host's definition, 2, is ahead of the 1 the release needs: a release is refused only when its definition is newer than the host's.",
  { service_definition: 2 },
  "team",
  ["team"],
  TEAM_7,
);
refused("SERVICE_DEFINITION_OUTDATED")(
  "refused-service-definition-at-the-largest-safe-integer",
  "2^53-1 is the largest service definition a manifest may need: the manifest is valid, and the host's 1 is older.",
  { manifest: text(manifestText({ service_definition: MAX_SAFE })) },
);

// -- the order the rules apply in: each case breaks two rules, and the first
// of the two in the contract's order is the answer.

const brokenManifest = text(BASE_TEXT.replace('"counter":7', '"counter":07'));
refused("SIGNATURE_INVALID")(
  "order-signature-before-manifest",
  "A flipped manifest that is also invalid: the signature is judged first.",
  { manifest: brokenManifest, signatures: signedBy(["team"], BASE_BYTES) },
);
refused("KEY_NOT_PINNED")(
  "order-pins-before-manifest",
  "An unpinned signer and an invalid manifest: the pins are judged first.",
  {
    manifest: brokenManifest,
    signatures: signedBy(["outsider"], brokenManifest),
  },
);
refused("SIGNATURE_INVALID")(
  "order-signature-file-before-conflict",
  "A malformed signature file and conflicting statements: the file is judged first.",
  {
    rollovers: [rollover("team", "team-next"), rollover("team", "outsider")],
    signatures: text("not json"),
  },
);
conflict(
  "order-conflict-before-pins",
  "Conflicting statements and an unpinned signer: the conflict is judged first.",
  {
    rollovers: [
      rollover("team", "team-next"),
      rollover("team", "outsider-next"),
    ],
    signatures: signedBy(["outsider"], BASE_BYTES),
  },
  "team",
  ["team-next", "outsider-next"],
);
refused("MANIFEST_INVALID")(
  "order-manifest-before-expiry",
  "An invalid and expired manifest: validity is judged first.",
  {
    manifest: brokenManifest,
    signatures: signedBy(["team"], brokenManifest),
    now: "2028-01-01T00:00:00Z",
  },
);
refused("MANIFEST_EXPIRED")(
  "order-expiry-before-platform",
  "An expired release without this platform: the clock is judged first.",
  { arch: "arm64", now: "2028-01-01T00:00:00Z" },
);
refused("PLATFORM_NOT_IN_RELEASE")(
  "order-platform-before-counter",
  "A replayed counter for another platform: the platform is judged first.",
  { arch: "arm64", floors: { team: 9 } },
);
refused("COUNTER_REPLAYED")(
  "order-counter-before-version",
  "A replayed counter and an older version: the counter is judged first.",
  { floors: { team: 9 }, running_version: "0.1.2" },
);
refused("VERSION_NOT_ON_TRACK")(
  "order-track-before-minimum",
  "Off track and below the minimum: the track is judged first.",
  { manifest: releaseOf("0.3.0", { min_from: "0.2.0" }) },
);
refused("AGENT_TOO_OLD")(
  "order-minimum-before-service-definition",
  "Below the minimum and an outdated service definition: the minimum is judged first.",
  {
    manifest: releaseOf("0.3.0", { min_from: "0.2.0", service_definition: 2 }),
    track: "minor",
  },
);

// An unreadable running version is judged where the versions are compared, no
// earlier and no later.
refused("SIGNATURE_INVALID")(
  "order-signature-before-an-unreadable-running-version",
  "A signature that does not cover the manifest and an unreadable running version: the signature is judged first.",
  {
    signatures: signedBy(["team"], brokenManifest),
    running_version: "0.1.0-dev",
  },
);
refused("PLATFORM_NOT_IN_RELEASE")(
  "order-platform-before-an-unreadable-running-version",
  "A release without this platform and an unreadable running version: the platform is judged first.",
  { arch: "arm64", running_version: "0.1.0-dev" },
);
refused("COUNTER_REPLAYED")(
  "order-counter-before-an-unreadable-running-version",
  "A replayed counter and an unreadable running version: the counter is judged first.",
  { floors: { team: 9 }, running_version: "dev" },
);
refused("DOWNGRADE_REFUSED")(
  "order-an-unreadable-running-version-before-the-track",
  "Off the patch track and an unreadable running version: the version is judged first.",
  { manifest: releaseOf("0.2.0"), running_version: "0.1.0-dev" },
);
refused("DOWNGRADE_REFUSED")(
  "order-an-unreadable-running-version-before-the-minimum",
  "Below the minimum and an unreadable running version: the version is judged first, and the running version is not guessed to be 0.0.0.",
  {
    manifest: releaseOf("0.3.0", { min_from: "0.2.0" }),
    track: "minor",
    running_version: "dev",
  },
);
refused("DOWNGRADE_REFUSED")(
  "order-an-unreadable-running-version-before-the-service-definition",
  "An outdated service definition and an unreadable running version: the version is judged first.",
  {
    manifest: releaseOf("0.1.1", { service_definition: 2 }),
    running_version: "0.1.0-dev",
  },
);

// ---------------------------------------------------------------- key lines

export const keyLines = [];
function addKeyLine(name, about, line, expect) {
  const parsed = parseKeyLine(line);
  const computed = parsed
    ? { result: "valid", fingerprint: parsed.fingerprint, name: parsed.name }
    : { result: "refused", code: "RELEASE_KEY_INVALID" };
  if (JSON.stringify(computed) !== JSON.stringify(expect(parsed)))
    throw new Error(
      `key line ${name}: the reference rules give ${JSON.stringify(computed)}`,
    );
  keyLines.push({ name, about, line, expect: computed });
}
const validLine = (name, about, line) =>
  addKeyLine(name, about, line, (parsed) => ({
    result: "valid",
    fingerprint: parsed?.fingerprint,
    name: parsed?.name,
  }));
const refusedLine = (name, about, line) =>
  addKeyLine(name, about, line, () => ({
    result: "refused",
    code: "RELEASE_KEY_INVALID",
  }));
const goodLine = KEYS.team.line;
const teamBase64 = goodLine.split(" ")[2];
const lineFor = (raw, name = "test") => keyLine(raw, name);

validLine(
  "valid-team-key",
  "The fingerprint is the SHA-256 of the 32 raw bytes, in lowercase hexadecimal.",
  goodLine,
);
validLine(
  "valid-name-with-spaces",
  "A name may hold spaces inside.",
  `vectory-release-key ed25519 ${teamBase64} Acme release key 2026`,
);
validLine(
  "valid-name-of-64-characters",
  "64 characters is the longest name.",
  `vectory-release-key ed25519 ${teamBase64} ${"n".repeat(64)}`,
);
validLine(
  "valid-name-of-one-character",
  "One character is the shortest name.",
  `vectory-release-key ed25519 ${teamBase64} t`,
);
validLine(
  "valid-name-with-punctuation",
  "Printable ASCII other than a quotation mark and a backslash.",
  `vectory-release-key ed25519 ${teamBase64} ops/release #1 (2026) [a-z]~!`,
);
{
  const withPlusAndSlash = KEY_NAMES.find((name) =>
    /[+/]/.test(KEYS[name].line.split(" ")[2]),
  );
  validLine(
    "valid-key-with-plus-and-slash-in-base64",
    "Base64 uses + and /.",
    KEYS[withPlusAndSlash].line,
  );
}
validLine(
  "valid-base-point",
  "The curve's base point is a canonical encoding of a point of large order.",
  lineFor(
    Buffer.from(
      "5866666666666666666666666666666666666666666666666666666666666666",
      "hex",
    ),
  ),
);
refusedLine(
  "bad-base64-characters",
  "Not base64.",
  "vectory-release-key ed25519 !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! team",
);
refusedLine(
  "key-of-31-bytes",
  "A key is 32 bytes.",
  `vectory-release-key ed25519 ${base64(KEYS.team.publicRaw.subarray(0, 31))} team`,
);
refusedLine(
  "key-of-33-bytes",
  "A key is 32 bytes.",
  `vectory-release-key ed25519 ${base64(Buffer.concat([KEYS.team.publicRaw, Buffer.from([0])]))} team`,
);
refusedLine(
  "key-without-padding",
  "Base64 is padded.",
  `vectory-release-key ed25519 ${teamBase64.replace(/=+$/, "")} team`,
);
refusedLine(
  "key-in-the-url-alphabet",
  "Base64 uses the standard alphabet.",
  `vectory-release-key ed25519 ${base64(Buffer.alloc(32, 0xfb)).replaceAll("+", "-").replaceAll("/", "_")} team`,
);
{
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = teamBase64[teamBase64.length - 2];
  refusedLine(
    "key-with-nonzero-padding-bits",
    "Base64 is canonical.",
    `vectory-release-key ed25519 ${teamBase64.slice(0, -2)}${alphabet[(alphabet.indexOf(last) + 1) % 64]}= team`,
  );
}
refusedLine(
  "another-algorithm",
  "Only ed25519.",
  `vectory-release-key ed448 ${teamBase64} team`,
);
refusedLine(
  "another-prefix",
  "The line starts with vectory-release-key.",
  `ssh-ed25519 ${teamBase64} team`,
);
refusedLine(
  "uppercase-algorithm",
  "The algorithm is lowercase.",
  `vectory-release-key ED25519 ${teamBase64} team`,
);
refusedLine(
  "missing-name",
  "A name is required.",
  `vectory-release-key ed25519 ${teamBase64}`,
);
refusedLine(
  "empty-name",
  "A name is required.",
  `vectory-release-key ed25519 ${teamBase64} `,
);
refusedLine(
  "two-spaces-between-fields",
  "Single spaces.",
  `vectory-release-key ed25519  ${teamBase64} team`,
);
refusedLine(
  "name-starting-with-a-space",
  "A name does not start with a space.",
  `vectory-release-key ed25519 ${teamBase64}  team`,
);
refusedLine(
  "name-ending-with-a-space",
  "A name does not end with a space.",
  `vectory-release-key ed25519 ${teamBase64} team `,
);
refusedLine(
  "newline-in-the-name",
  "A line feed in the name.",
  `vectory-release-key ed25519 ${teamBase64} te\nam`,
);
refusedLine(
  "trailing-newline",
  "The line carries no line terminator.",
  `${goodLine}\n`,
);
refusedLine(
  "carriage-return-in-the-name",
  "A carriage return in the name.",
  `vectory-release-key ed25519 ${teamBase64} te\ram`,
);
refusedLine(
  "tab-in-the-name",
  "A tab in the name.",
  `vectory-release-key ed25519 ${teamBase64} te\tam`,
);
refusedLine(
  "name-of-65-characters",
  "At most 64 characters.",
  `vectory-release-key ed25519 ${teamBase64} ${"n".repeat(65)}`,
);
refusedLine(
  "non-ascii-name",
  "Printable ASCII only.",
  `vectory-release-key ed25519 ${teamBase64} t${E_ACUTE}am`,
);
refusedLine(
  "quotation-mark-in-the-name",
  "A name has no quotation mark.",
  `vectory-release-key ed25519 ${teamBase64} te"am`,
);
refusedLine(
  "backslash-in-the-name",
  "A name has no backslash.",
  `vectory-release-key ed25519 ${teamBase64} te${BACKSLASH}am`,
);
refusedLine("empty-line", "An empty line.", "");

// The eight points of order 1, 2, 4 and 8, as canonical encodings.
const SMALL_ORDER_NAMES = new Map([
  [
    "0100000000000000000000000000000000000000000000000000000000000000",
    "order 1 (the identity point)",
  ],
  [
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "order 2 (y is -1)",
  ],
  [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "order 4 (y is 0)",
  ],
  [
    "0000000000000000000000000000000000000000000000000000000000000080",
    "order 4 (y is 0, the other x)",
  ],
  [
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "order 8",
  ],
  [
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "order 8 (the other x)",
  ],
  [
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "order 8",
  ],
  [
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    "order 8 (the other x)",
  ],
]);
for (const encoding of SMALL_ORDER_ENCODINGS) {
  const hex = encoding.toString("hex");
  const kind = SMALL_ORDER_NAMES.get(hex);
  if (!kind) throw new Error(`unexpected small-order encoding ${hex}`);
  refusedLine(
    `small-order-${hex.slice(0, 8)}${hex.slice(-2)}`,
    `A point of ${kind}: a signature by it verifies for any message.`,
    lineFor(encoding, "small"),
  );
}
// Non-canonical encodings of the same points: y equal to the field prime or one
// more, and the sign bit set on a point whose x is 0.
const fieldPrime = (1n << 255n) - 19n;
const noncanonical = (y, signBit = 0) => {
  const bytes = toLittleEndian(y, 32);
  bytes[31] |= signBit << 7;
  return bytes;
};
refusedLine(
  "non-canonical-y-equal-to-the-field-prime",
  "y = p encodes the same point as y = 0.",
  lineFor(noncanonical(fieldPrime), "alias"),
);
refusedLine(
  "non-canonical-y-equal-to-the-field-prime-with-the-sign-bit",
  "y = p with the sign bit set encodes the other point of y = 0.",
  lineFor(noncanonical(fieldPrime, 1), "alias"),
);
refusedLine(
  "non-canonical-y-one-more-than-the-field-prime",
  "y = p + 1 encodes the same point as y = 1, the identity.",
  lineFor(noncanonical(fieldPrime + 1n), "alias"),
);
refusedLine(
  "non-canonical-y-one-more-than-the-field-prime-with-the-sign-bit",
  "y = p + 1 with the sign bit set.",
  lineFor(noncanonical(fieldPrime + 1n, 1), "alias"),
);
refusedLine(
  "sign-bit-set-on-the-identity-point",
  "x is 0, so the sign bit must be clear.",
  lineFor(noncanonical(1n, 1), "alias"),
);
refusedLine(
  "sign-bit-set-on-the-point-of-order-2",
  "x is 0, so the sign bit must be clear.",
  lineFor(noncanonical(fieldPrime - 1n, 1), "alias"),
);
refusedLine(
  "every-bit-set",
  "y is above the field prime.",
  lineFor(Buffer.alloc(32, 0xff), "alias"),
);
{
  // A canonical y below 19 that is on the curve has a non-canonical twin,
  // y + p, which a decoder that reduces y accepts as the same point.
  let found = null;
  for (let y = 2n; y < 19n && !found; y++) {
    const point = decodePoint(noncanonical(y));
    if (point && !isSmallOrder(point)) found = y;
  }
  if (found === null) throw new Error("no small y of large order on the curve");
  validLine(
    `valid-canonical-point-with-y-${found}`,
    "A canonical encoding of a point of large order whose y is small.",
    lineFor(noncanonical(found), "small-y"),
  );
  refusedLine(
    `non-canonical-point-of-large-order-y-${found}-plus-the-field-prime`,
    "The same point written with y + p: refused although it decodes if y is reduced.",
    lineFor(noncanonical(found + fieldPrime), "alias"),
  );
}
{
  // A y for which no x exists is not on the curve.
  let off = null;
  for (let y = 2n; y < 200n && off === null; y++)
    if (!decodePoint(noncanonical(y))) off = y;
  refusedLine(
    "point-not-on-the-curve",
    "No x satisfies the curve equation for this y.",
    lineFor(noncanonical(off), "off"),
  );
}

// ---------------------------------------------------------------- key bundles

export const bundles = [];
function addBundle(name, about, bytes, wanted, expect) {
  const computed = pinFromBundle(bytes, wanted);
  if (JSON.stringify(computed) !== JSON.stringify(expect))
    throw new Error(
      `bundle ${name}: the reference rules give ${JSON.stringify(computed)}`,
    );
  bundles.push({
    name,
    about,
    bundle_b64: base64(bytes),
    fingerprint: wanted,
    expect,
  });
}
const entry = (keyName, state = "current", over = {}) => ({
  public_key: KEYS[keyName].line,
  fingerprint: KEYS[keyName].fingerprint,
  state,
  ...over,
});
const bundleOf = (keys, over = {}) =>
  text(
    JSON.stringify({
      schema: "vectory.release-keys.v1",
      keys,
      rollovers: [],
      ...over,
    }),
  );
const FINGERPRINT = (name) => KEYS[name].fingerprint;
addBundle(
  "valid-the-current-key",
  "The operator's fingerprint equals the computed fingerprint of an entry: that key is pinned.",
  bundleOf([entry("team-next"), entry("team", "retired")]),
  FINGERPRINT("team-next"),
  { result: "valid", public_key: KEYS["team-next"].line },
);
addBundle(
  "valid-a-retired-key",
  "A retired key can be pinned; the statements in an offer lead the host to the current one.",
  bundleOf([entry("team-next"), entry("team", "retired")]),
  FINGERPRINT("team"),
  { result: "valid", public_key: KEYS.team.line },
);
addBundle(
  "absent-fingerprint",
  "No entry has the operator's fingerprint: nothing is pinned.",
  bundleOf([entry("team-next"), entry("team", "retired")]),
  FINGERPRINT("outsider"),
  { result: "absent" },
);
addBundle(
  "valid-unknown-members-are-ignored",
  "Members setup does not know, such as a custody label a server should not send, change nothing.",
  bundleOf([entry("team", "current", { custody: "server", note: "x" })], {
    extra: true,
  }),
  FINGERPRINT("team"),
  { result: "valid", public_key: KEYS.team.line },
);
addBundle(
  "refused-fingerprint-member-disagrees-with-its-key",
  "The entry claims the operator's fingerprint but holds another key: a match on the member would pin the wrong key.",
  bundleOf([
    entry("team", "current", { fingerprint: FINGERPRINT("outsider") }),
  ]),
  FINGERPRINT("outsider"),
  refuse("RELEASE_KEY_INVALID"),
);
addBundle(
  "refused-fingerprint-member-disagrees-in-another-entry",
  "One entry is right and matches, another disagrees with its key: the whole bundle is malformed.",
  bundleOf([
    entry("team"),
    entry("team-next", "retired", { fingerprint: FINGERPRINT("outsider") }),
  ]),
  FINGERPRINT("team"),
  refuse("RELEASE_KEY_INVALID"),
);
addBundle(
  "refused-fingerprint-member-absent",
  "An entry without its fingerprint member is malformed: the server always writes it, and a bundle that leaves it out is not one this contract describes.",
  bundleOf([{ public_key: KEYS.team.line, state: "current" }]),
  FINGERPRINT("team"),
  refuse("RELEASE_KEY_INVALID"),
);
addBundle(
  "refused-fingerprint-member-in-uppercase",
  "The fingerprint member is lowercase hexadecimal.",
  bundleOf([
    entry("team", "current", {
      fingerprint: FINGERPRINT("team").toUpperCase(),
    }),
  ]),
  FINGERPRINT("team"),
  refuse("RELEASE_KEY_INVALID"),
);
{
  const small = SMALL_ORDER_ENCODINGS[0];
  addBundle(
    "refused-small-order-key",
    "An entry whose key is a point of small order is refused, even though its fingerprint member is right.",
    bundleOf([
      {
        public_key: lineFor(small, "small"),
        fingerprint: sha256Hex(small),
        state: "current",
      },
    ]),
    sha256Hex(small),
    refuse("RELEASE_KEY_INVALID"),
  );
}
addBundle(
  "refused-malformed-key-line",
  "An entry whose public_key is not a key line.",
  bundleOf([entry("team", "current", { public_key: "not a key" })]),
  FINGERPRINT("team"),
  refuse("RELEASE_KEY_INVALID"),
);
addBundle(
  "refused-unknown-state",
  "A state is current or retired.",
  bundleOf([entry("team", "revoked")]),
  FINGERPRINT("team"),
  refuse("RELEASE_KEY_INVALID"),
);
addBundle(
  "refused-wrong-schema",
  "The schema must be exact.",
  bundleOf([entry("team")], { schema: "vectory.release-keys.v2" }),
  FINGERPRINT("team"),
  refuse("RELEASE_KEY_INVALID"),
);
addBundle(
  "refused-keys-missing",
  "A bundle without keys is malformed.",
  text(JSON.stringify({ schema: "vectory.release-keys.v1", rollovers: [] })),
  FINGERPRINT("team"),
  refuse("RELEASE_KEY_INVALID"),
);
addBundle(
  "refused-not-json",
  "Not JSON.",
  text("<html>"),
  FINGERPRINT("team"),
  refuse("RELEASE_KEY_INVALID"),
);

// ---------------------------------------------------------------- the heartbeat member

export const reportMembers = [];
function addReport(name, member, accepted, why) {
  const problem = validateReport(member);
  if ((problem === null) !== accepted)
    throw new Error(
      `report ${name}: the reference rules say ${problem ?? "accepted"}, the case says ${accepted ? "accepted" : "refused"}`,
    );
  reportMembers.push({
    name,
    member,
    accepted,
    ...(accepted ? {} : { why }),
  });
}
const OFF = {
  consent: "off",
  paused: false,
  track: "patch",
  windows: [],
  window_open: false,
  keys: [],
  highest_counter: 0,
  eligibility: "eligible",
  state: "idle",
  code: "UPDATES_OFF",
};
const AUTO = {
  consent: "auto",
  paused: false,
  track: "patch",
  windows: ["Mon-Fri 02:00-04:00"],
  window_open: false,
  next_window_at: "2026-10-05T01:00:00Z",
  keys: [KEYS.team.fingerprint],
  highest_counter: 6,
  eligibility: "eligible",
  service_definition: 1,
  state: "idle",
};
const manifestDigest = sha256Hex(BASE_BYTES);
const LAST = {
  release: sha256Hex("release.json of 0.1.0"),
  outcome: "committed",
  code: null,
  at: "2026-08-12T02:09:41Z",
  from_version: "0.0.9",
  to_version: "0.1.0",
  first_check_in_ms: 1900,
};
const accepted = (name, member) => addReport(name, member, true);
const rejected = (name, member, why) => addReport(name, member, false, why);

accepted("a host with updates off", OFF);
accepted("a host that cannot take updates and has not consented", {
  ...OFF,
  eligibility: "PACKAGE_MANAGED",
});
accepted("an automatic host with nothing to do", AUTO);
accepted("an automatic host waiting for its window", {
  ...AUTO,
  state: "waiting_for_window",
  release: manifestDigest,
  last: LAST,
});
accepted("an ask host waiting for someone", {
  ...AUTO,
  consent: "ask",
  state: "waiting_for_host",
  release: manifestDigest,
});
accepted("a download", {
  ...AUTO,
  state: "downloading",
  release: manifestDigest,
});
accepted("a staged build", {
  ...AUTO,
  state: "staged",
  release: manifestDigest,
});
accepted("an update being applied", {
  ...AUTO,
  state: "applying",
  release: manifestDigest,
});
accepted("a build on trial", {
  ...AUTO,
  state: "trial",
  release: manifestDigest,
});
accepted("a refused offer", {
  ...AUTO,
  state: "refused",
  release: manifestDigest,
  code: "KEY_NOT_PINNED",
});
accepted("a failed download", {
  ...AUTO,
  state: "failed",
  release: manifestDigest,
  code: "DOWNLOAD_FAILED",
});
accepted("a failed probe", {
  ...AUTO,
  state: "failed",
  release: manifestDigest,
  code: "PROBE_FAILED",
});
accepted("a fork in the rollover chain", {
  ...AUTO,
  state: "refused",
  code: "KEY_ROLLOVER_CONFLICT",
  rollover_conflict: {
    from: KEYS.team.fingerprint,
    to: [KEYS["team-next"].fingerprint, KEYS.outsider.fingerprint],
  },
});
accepted("a paused host", {
  ...AUTO,
  paused: true,
  code: "UPDATES_PAUSED",
});
accepted("a rolled back update", {
  ...AUTO,
  last: {
    release: manifestDigest,
    outcome: "rolled_back",
    code: "NO_CHECK_IN",
    at: "2026-10-04T02:19:09Z",
    from_version: "0.1.0",
    to_version: "0.1.1",
  },
});
accepted("a refusal by the privileged step", {
  ...AUTO,
  last: {
    release: manifestDigest,
    outcome: "refused",
    code: "UNTRUSTED_LOCATION",
    at: "2026-10-04T02:14:09Z",
    from_version: "0.1.0",
    to_version: null,
  },
});
accepted(
  "a host that has to be upgraded by hand to take a service definition",
  {
    ...AUTO,
    eligibility: "SERVICE_DEFINITION_OUTDATED",
    service_definition: 1,
  },
);
accepted("the longest lists", {
  ...AUTO,
  windows: Array.from(
    { length: REPORT_BOUNDS.windows },
    (_, index) =>
      `${"Mon,Tue,Wed,Thu,Fri,Sat 02:00-04:00".padEnd(REPORT_BOUNDS.window_characters - 1, " ")}${index}`,
  ),
  keys: ["team", "team-next", "team-final", "project"].map(
    (name) => KEYS[name].fingerprint,
  ),
});
accepted("null counts as absent for an optional member", {
  ...AUTO,
  next_window_at: null,
  service_definition: null,
  release: null,
  code: null,
  rollover_conflict: null,
  last: null,
});
accepted("the largest counter", { ...AUTO, highest_counter: MAX_SAFE });
accepted("the longest result", {
  ...AUTO,
  last: { ...LAST, first_check_in_ms: REPORT_BOUNDS.first_check_in_ms },
});

rejected(
  "an unknown member",
  { ...AUTO, channel: "stable" },
  "Members are allowlisted.",
);
for (const member of [
  "consent",
  "paused",
  "track",
  "windows",
  "window_open",
  "keys",
  "highest_counter",
  "eligibility",
  "state",
]) {
  const copy = { ...AUTO };
  delete copy[member];
  rejected(`${member} missing`, copy, `${member} is required.`);
}
rejected(
  "an unknown consent level",
  { ...AUTO, consent: "manual" },
  "consent is off, auto or ask.",
);
rejected(
  "the major track",
  { ...AUTO, track: "major" },
  "A major track is refused in 0.1.",
);
rejected(
  "paused as a string",
  { ...AUTO, paused: "false" },
  "paused is a boolean.",
);
rejected(
  "eight windows",
  { ...AUTO, windows: Array.from({ length: 8 }, () => "daily 02:00-04:00") },
  "At most 7 windows.",
);
rejected(
  "a window of 41 characters",
  { ...AUTO, windows: ["x".repeat(41)] },
  "At most 40 characters.",
);
rejected(
  "an empty window",
  { ...AUTO, windows: [""] },
  "A window has 1 to 40 characters.",
);
rejected(
  "a window with a tab",
  { ...AUTO, windows: ["Mon\t02:00-04:00"] },
  "Printable ASCII only.",
);
rejected(
  "a window with a non-ASCII character",
  { ...AUTO, windows: [`Mon 02:00-04:00 ${E_ACUTE}`] },
  "Printable ASCII only.",
);
rejected(
  "a window that is not a string",
  { ...AUTO, windows: [7] },
  "A window is a string.",
);
rejected(
  "five keys",
  {
    ...AUTO,
    keys: ["team", "team-next", "team-final", "project", "outsider"].map(
      (name) => KEYS[name].fingerprint,
    ),
  },
  "At most 4 keys.",
);
rejected(
  "a key in uppercase",
  { ...AUTO, keys: [KEYS.team.fingerprint.toUpperCase()] },
  "A fingerprint is lowercase hexadecimal.",
);
rejected(
  "a key of 63 characters",
  { ...AUTO, keys: [KEYS.team.fingerprint.slice(1)] },
  "A fingerprint is 64 characters.",
);
rejected(
  "the same key twice",
  { ...AUTO, keys: [KEYS.team.fingerprint, KEYS.team.fingerprint] },
  "Keys are distinct.",
);
rejected(
  "a negative counter",
  { ...AUTO, highest_counter: -1 },
  "A counter is 0 to 2^53-1.",
);
rejected(
  "a counter above 2^53-1",
  { ...AUTO, highest_counter: MAX_SAFE + 1 },
  "A counter is 0 to 2^53-1.",
);
rejected(
  "a fractional counter",
  { ...AUTO, highest_counter: 1.5 },
  "A counter is a whole number.",
);
rejected(
  "an unknown eligibility",
  { ...AUTO, eligibility: "MAYBE" },
  "eligibility is a known code.",
);
rejected(
  "UPDATES_OFF as an eligibility",
  { ...AUTO, eligibility: "UPDATES_OFF" },
  "eligibility is eligible or a reason a host cannot be updated.",
);
rejected(
  "a service definition of 0",
  { ...AUTO, service_definition: 0 },
  "service_definition is 1 to 1,000.",
);
rejected(
  "a service definition of 1,001",
  { ...AUTO, service_definition: 1001 },
  "service_definition is 1 to 1,000.",
);
rejected(
  "an unknown state",
  { ...AUTO, state: "installing" },
  "state is a known state.",
);
rejected(
  "a staged build without its release",
  { ...AUTO, state: "staged" },
  "A state about a release names it.",
);
rejected(
  "a refusal without a code",
  { ...AUTO, state: "refused", release: manifestDigest },
  "A refusal or a failure has a code.",
);
rejected(
  "an unknown code",
  { ...AUTO, code: "SOMETHING" },
  "code is a known code.",
);
rejected(
  "a release digest in uppercase",
  { ...AUTO, release: manifestDigest.toUpperCase() },
  "A digest is lowercase hexadecimal.",
);
rejected(
  "a host that is off but staged",
  { ...OFF, state: "staged", release: manifestDigest },
  "A host that is off reports idle.",
);
rejected(
  "a conflict without its code",
  {
    ...AUTO,
    rollover_conflict: {
      from: KEYS.team.fingerprint,
      to: [KEYS["team-next"].fingerprint, KEYS.outsider.fingerprint],
    },
  },
  "rollover_conflict and KEY_ROLLOVER_CONFLICT go together.",
);
rejected(
  "the conflict code without its successors",
  { ...AUTO, state: "refused", code: "KEY_ROLLOVER_CONFLICT" },
  "rollover_conflict and KEY_ROLLOVER_CONFLICT go together.",
);
rejected(
  "a conflict naming one successor twice",
  {
    ...AUTO,
    state: "refused",
    code: "KEY_ROLLOVER_CONFLICT",
    rollover_conflict: {
      from: KEYS.team.fingerprint,
      to: [KEYS.outsider.fingerprint, KEYS.outsider.fingerprint],
    },
  },
  "The two successors differ.",
);
rejected(
  "a conflict whose successor is the key itself",
  {
    ...AUTO,
    state: "refused",
    code: "KEY_ROLLOVER_CONFLICT",
    rollover_conflict: {
      from: KEYS.team.fingerprint,
      to: [KEYS.team.fingerprint, KEYS.outsider.fingerprint],
    },
  },
  "A key is never its own successor.",
);
rejected(
  "a conflict naming three successors",
  {
    ...AUTO,
    state: "refused",
    code: "KEY_ROLLOVER_CONFLICT",
    rollover_conflict: {
      from: KEYS.team.fingerprint,
      to: [
        KEYS.outsider.fingerprint,
        KEYS["team-next"].fingerprint,
        KEYS["team-final"].fingerprint,
      ],
    },
  },
  "Exactly two successors.",
);
rejected(
  "a next window that is not an instant",
  { ...AUTO, next_window_at: "tomorrow" },
  "next_window_at is a UTC instant.",
);
rejected(
  "a result with an unknown member",
  { ...AUTO, last: { ...LAST, note: "x" } },
  "A result has exactly its members.",
);
rejected(
  "a result with an unknown outcome",
  { ...AUTO, last: { ...LAST, outcome: "unknown" } },
  "outcome is committed, rolled_back, failed or refused.",
);
rejected(
  "a committed result with a code",
  { ...AUTO, last: { ...LAST, code: "UNHEALTHY" } },
  "A committed result has no code.",
);
rejected(
  "a rolled back result without a code",
  { ...AUTO, last: { ...LAST, outcome: "rolled_back", code: null } },
  "A result that is not committed has a code.",
);
rejected(
  "a result whose time is not an instant",
  { ...AUTO, last: { ...LAST, at: "yesterday" } },
  "at is a UTC instant.",
);
rejected(
  "a result with a negative first check-in",
  { ...AUTO, last: { ...LAST, first_check_in_ms: -1 } },
  "first_check_in_ms is 0 to 86,400,000.",
);
rejected(
  "a result with a first check-in above a day",
  { ...AUTO, last: { ...LAST, first_check_in_ms: 86400001 } },
  "first_check_in_ms is 0 to 86,400,000.",
);
rejected(
  "a result with a version of 129 bytes",
  { ...AUTO, last: { ...LAST, from_version: "1".repeat(129) } },
  "from_version is 1 to 128 bytes.",
);
accepted("a result with a version of 128 bytes", {
  ...AUTO,
  last: { ...LAST, from_version: "1".repeat(128) },
});
rejected(
  "a result with a version holding a line break",
  { ...AUTO, last: { ...LAST, from_version: "0.1.0\n" } },
  "from_version holds no control character.",
);
rejected(
  "a result without the version it went to",
  (() => {
    const { to_version: omitted, ...rest } = LAST;
    return { ...AUTO, last: rest };
  })(),
  "to_version is a version or null.",
);
rejected(
  "a result whose to_version is a pre-release",
  { ...AUTO, last: { ...LAST, to_version: "0.1.1-rc.1" } },
  "to_version is a version or null.",
);
rejected("not an object", [AUTO], "The member is an object.");

export { AGENT_CODES };
