// The rules of the "Agent updates" section of contracts/CONTRACT.md, written a
// third time. The Rust server and the Go agent each implement them; the shared
// vectors are generated with this file, with nothing but Node's own crypto, so
// neither of those two produced the answers they are held to. Every function
// here is the plainest reading of one rule of the contract.
import crypto from "node:crypto";

// ---------------------------------------------------------------- constants

export const RELEASE_PREFIX = "vectory-agent-release-v1\n";
export const ROLLOVER_PREFIX = "vectory-release-key-rollover-v1\n";
export const MAX_SAFE = 9007199254740991;
export const BUILD_LIMIT = 128 * 1024 * 1024;
export const HEX64 = /^[0-9a-f]{64}$/;

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest();
export const sha256Hex = (bytes) => sha256(bytes).toString("hex");
export const base64 = (bytes) => Buffer.from(bytes).toString("base64");
export const text = (value) => Buffer.from(value, "latin1");

// ---------------------------------------------------------------- curve

// Edwards25519 in plain BigInt arithmetic: enough to decode a point the way
// RFC 8032 section 5.1.3 does, to say whether it is canonical, and to find the
// points of small order. Slow and obvious on purpose.
const P = (1n << 255n) - 19n;
export const GROUP_ORDER =
  (1n << 252n) + 27742317777372353535851937790883648493n;
const mod = (value) => ((value % P) + P) % P;
function power(base, exponent) {
  let result = 1n;
  let square = mod(base);
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * square) % P;
    square = (square * square) % P;
  }
  return result;
}
const inverse = (value) => power(value, P - 2n);
const D = mod(-121665n * inverse(121666n));
const SQRT_MINUS_ONE = power(2n, (P - 1n) / 4n);

export const littleEndian = (bytes) =>
  BigInt(`0x${Buffer.from(bytes).reverse().toString("hex") || "0"}`);
export const toLittleEndian = (value, length) =>
  Buffer.from(value.toString(16).padStart(length * 2, "0"), "hex").reverse();

function squareRoot(square) {
  let root = power(square, (P + 3n) / 8n);
  if (mod(root * root) !== mod(square)) root = mod(root * SQRT_MINUS_ONE);
  return mod(root * root) === mod(square) ? root : null;
}

// Decodes an encoding as RFC 8032 does, after one more check: the point must
// be written in its canonical form. Returns {x, y}, or null for an encoding
// that is not canonical (y not below the field prime, the sign bit set on a
// point whose x is 0) or is not on the curve.
export function decodePoint(bytes) {
  if (bytes.length !== 32) return null;
  const sign = bytes[31] >> 7;
  const masked = Buffer.from(bytes);
  masked[31] &= 0x7f;
  const y = littleEndian(masked);
  if (y >= P) return null;
  const y2 = mod(y * y);
  const x2 = mod((y2 - 1n) * inverse(mod(D * y2 + 1n)));
  let x = squareRoot(x2);
  if (x === null) return null;
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = mod(-x);
  return { x, y };
}

function addPoints(left, right) {
  const product = mod(D * left.x * right.x * left.y * right.y);
  return {
    x: mod((left.x * right.y + right.x * left.y) * inverse(mod(1n + product))),
    y: mod((left.y * right.y + left.x * right.x) * inverse(mod(1n - product))),
  };
}

// A point of small order is one of the eight whose order divides 8: eight
// times it is the identity.
export function isSmallOrder(point) {
  let result = point;
  for (let index = 0; index < 3; index++) result = addPoints(result, result);
  return result.x === 0n && result.y === 1n;
}

const encodePoint = ({ x, y }) => {
  const bytes = toLittleEndian(y, 32);
  bytes[31] |= Number(x & 1n) << 7;
  return bytes;
};

// The eight canonical encodings of the points of order 1, 2, 4 and 8, derived
// from the curve equation: the points whose double has y = 0 are the order 8
// points (with the two order 4 points, whose y is 0, and the two of order 1
// and 2, whose x is 0).
export const SMALL_ORDER_ENCODINGS = (() => {
  const found = new Map();
  const consider = (y) => {
    for (const sign of [0, 1]) {
      const bytes = toLittleEndian(mod(y), 32);
      bytes[31] |= sign << 7;
      const point = decodePoint(bytes);
      if (point && isSmallOrder(point)) found.set(bytes.toString("hex"), bytes);
    }
  };
  consider(0n);
  consider(1n);
  consider(P - 1n);
  const root = squareRoot(mod(1n + D));
  for (const sign of [1n, -1n]) {
    const ySquared = mod((-1n + sign * root) * inverse(D));
    const y = squareRoot(ySquared);
    if (y !== null) {
      consider(y);
      consider(P - y);
    }
  }
  const list = [...found.values()];
  if (list.length !== 8)
    throw new Error(`expected eight small-order points, found ${list.length}`);
  return list.sort(Buffer.compare);
})();

export const isSmallOrderEncoding = (bytes) =>
  SMALL_ORDER_ENCODINGS.some((encoding) => encoding.equals(bytes));

// ---------------------------------------------------------------- keys

// Test keys come from a seed: the PKCS#8 prefix of an Ed25519 private key and
// the 32 seed bytes.
export function keyFromSeed(name, seed) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicRaw = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  return {
    name,
    seed,
    privateKey,
    publicRaw,
    publicKey: publicKeyFromRaw(publicRaw),
    line: keyLine(publicRaw, name),
    fingerprint: sha256Hex(publicRaw),
  };
}

export function publicKeyFromRaw(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export const keyLine = (raw, name) =>
  `vectory-release-key ed25519 ${base64(raw)} ${name}`;

// Canonical base64 (RFC 4648 section 4): standard alphabet, padded, no
// whitespace, unused bits zero. Returns the bytes, or null.
export function strictBase64(value, length) {
  if (typeof value !== "string" || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return null;
  if (length !== undefined && bytes.length !== length) return null;
  return bytes;
}

// A public key line: `vectory-release-key ed25519 <base64 of 32 bytes> <name>`,
// single spaces, a name of 1 to 64 printable ASCII characters without a
// quotation mark or a backslash that neither starts nor ends with a space. The
// 32 bytes must be the canonical encoding of a curve point that is not of
// small order. Returns {raw, name, fingerprint}, or null.
export function parseKeyLine(line) {
  if (typeof line !== "string") return null;
  const match =
    /^vectory-release-key ed25519 ([A-Za-z0-9+/=]+) ([\x20-\x7e]+)$/.exec(line);
  if (!match) return null;
  const raw = strictBase64(match[1], 32);
  const name = match[2];
  if (!raw || name.length > 64 || /[\\"]/.test(name)) return null;
  if (name.startsWith(" ") || name.endsWith(" ")) return null;
  const point = decodePoint(raw);
  if (!point || isSmallOrder(point)) return null;
  return { raw, name, fingerprint: sha256Hex(raw) };
}

// ---------------------------------------------------------------- signatures

const verifyRaw = (publicKey, bytes, signature) => {
  try {
    return crypto.verify(null, bytes, publicKey, signature);
  } catch {
    return false;
  }
};

// Verification as every host does it: S below the group order, R a canonical
// encoding of a point that is not of small order, and the cofactorless
// equation (Go's ed25519.Verify with the R check, Rust's verify_strict).
export function strictVerify(publicKey, message, signature) {
  if (signature.length !== 64) return false;
  if (littleEndian(signature.subarray(32)) >= GROUP_ORDER) return false;
  const point = decodePoint(signature.subarray(0, 32));
  if (!point || isSmallOrder(point)) return false;
  return verifyRaw(publicKey, message, signature);
}

export const signWith = (key, prefix, bytes) =>
  crypto.sign(null, Buffer.concat([text(prefix), bytes]), key.privateKey);

// ---------------------------------------------------------------- JSON profile

// The profile of release.json, release.json.sig and rollover statements:
// printable ASCII and at most one final line feed, one object with no byte
// before it, spaces as the only whitespace, no backslash anywhere, no member
// twice, strings, whole numbers up to 2^53-1, arrays and objects, nothing else.
// Returns the value, or null.
export function parseProfile(bytes, maxBytes) {
  if (bytes.length === 0 || bytes.length > maxBytes) return null;
  let end = bytes.length;
  if (bytes[end - 1] === 0x0a) end--;
  for (let index = 0; index < end; index++)
    if (bytes[index] < 0x20 || bytes[index] > 0x7e) return null;
  if (end === 0 || bytes[0] !== 0x7b) return null;
  const source = bytes.subarray(0, end).toString("latin1");
  let at = 0;
  const fail = () => {
    throw new Error("profile");
  };
  const spaces = () => {
    while (source[at] === " ") at++;
  };
  const string = () => {
    if (source[at] !== '"') fail();
    const start = ++at;
    while (at < source.length && source[at] !== '"') {
      if (source[at] === "\\") fail();
      at++;
    }
    if (at >= source.length) fail();
    return source.slice(start, at++);
  };
  const number = () => {
    const digits = /^(0|[1-9][0-9]*)/.exec(source.slice(at));
    if (!digits) fail();
    const written = digits[1];
    if (
      written.length > 16 ||
      (written.length === 16 && written > String(MAX_SAFE))
    )
      fail();
    at += written.length;
    return Number(written);
  };
  const value = () => {
    spaces();
    const first = source[at];
    if (first === '"') return string();
    if (first === "{") return object();
    if (first === "[") return array();
    if (first >= "0" && first <= "9") return number();
    return fail();
  };
  const object = () => {
    at++;
    const result = Object.create(null);
    spaces();
    if (source[at] === "}") {
      at++;
      return result;
    }
    for (;;) {
      spaces();
      const key = string();
      if (key in result) fail();
      spaces();
      if (source[at++] !== ":") fail();
      result[key] = value();
      spaces();
      if (source[at] === ",") {
        at++;
        continue;
      }
      if (source[at] === "}") {
        at++;
        return result;
      }
      return fail();
    }
  };
  const array = () => {
    at++;
    const result = [];
    spaces();
    if (source[at] === "]") {
      at++;
      return result;
    }
    for (;;) {
      result.push(value());
      spaces();
      if (source[at] === ",") {
        at++;
        continue;
      }
      if (source[at] === "]") {
        at++;
        return result;
      }
      return fail();
    }
  };
  try {
    const parsed = object();
    return at === source.length ? parsed : null;
  } catch {
    return null;
  }
}

export const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const hasExactly = (object, required, optional = []) => {
  const names = Object.keys(object);
  return (
    required.every((name) => names.includes(name)) &&
    names.every((name) => required.includes(name) || optional.includes(name))
  );
};

// ---------------------------------------------------------------- scalars

const NUMBER = "(0|[1-9][0-9]{0,8})";
const VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
export const parseVersion = (value) => {
  const match = typeof value === "string" ? VERSION.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};
export const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index])
      return left[index] < right[index] ? -1 : 1;
  return 0;
};

// A UTC instant as whole seconds since 1970 (years 1970 to 9999), or null.
export function parseInstant(value) {
  const match =
    typeof value === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value)
      : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1] || hour > 23 || minute > 59 || second > 59)
    return null;
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

// ---------------------------------------------------------------- the files

export const PLATFORMS = {
  os: ["linux", "darwin", "windows"],
  arch: ["amd64", "arm64"],
};
export const FUTURE_ISSUE_SECONDS = 24 * 60 * 60;
export const LONGEST_VALIDITY_SECONDS = 400 * 24 * 60 * 60;

export function parseManifest(bytes) {
  const value = parseProfile(bytes, 16384);
  if (!value) return null;
  const members = [
    "schema",
    "version",
    "counter",
    "issued_at",
    "expires_at",
    "service_definition",
    "artifacts",
  ];
  if (!hasExactly(value, members, ["min_from"])) return null;
  if (value.schema !== "vectory.agent-release.v1") return null;
  const version = parseVersion(value.version);
  if (!version) return null;
  if (
    !Number.isInteger(value.counter) ||
    value.counter < 1 ||
    value.counter > MAX_SAFE
  )
    return null;
  const issued = parseInstant(value.issued_at);
  const expires = parseInstant(value.expires_at);
  if (issued === null || expires === null) return null;
  if (expires <= issued || expires - issued > LONGEST_VALIDITY_SECONDS)
    return null;
  let minFrom = null;
  if ("min_from" in value) {
    minFrom = parseVersion(value.min_from);
    if (!minFrom) return null;
  }
  if (
    !Number.isInteger(value.service_definition) ||
    value.service_definition < 1
  )
    return null;
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > 8
  )
    return null;
  const seen = new Set();
  const artifacts = [];
  for (const artifact of value.artifacts) {
    if (
      !isObject(artifact) ||
      !hasExactly(artifact, ["os", "arch", "format", "file", "size", "sha256"])
    )
      return null;
    if (
      !PLATFORMS.os.includes(artifact.os) ||
      !PLATFORMS.arch.includes(artifact.arch) ||
      artifact.format !== "executable"
    )
      return null;
    const platform = `${artifact.os}/${artifact.arch}`;
    if (seen.has(platform)) return null;
    seen.add(platform);
    const file = `vectory-${value.version}-${artifact.os}-${artifact.arch}${
      artifact.os === "windows" ? ".exe" : ""
    }`;
    if (artifact.file !== file) return null;
    if (
      !Number.isInteger(artifact.size) ||
      artifact.size < 1 ||
      artifact.size > BUILD_LIMIT
    )
      return null;
    if (typeof artifact.sha256 !== "string" || !HEX64.test(artifact.sha256))
      return null;
    artifacts.push(artifact);
  }
  return {
    version,
    counter: value.counter,
    issued,
    expires,
    minFrom,
    serviceDefinition: value.service_definition,
    artifacts,
  };
}

export function parseSignatureFile(bytes) {
  const value = parseProfile(bytes, 4096);
  if (!value || !hasExactly(value, ["schema", "signatures"])) return null;
  if (value.schema !== "vectory.agent-release-signatures.v1") return null;
  if (
    !Array.isArray(value.signatures) ||
    value.signatures.length < 1 ||
    value.signatures.length > 4
  )
    return null;
  const keys = new Set();
  const entries = [];
  for (const entry of value.signatures) {
    if (!isObject(entry) || !hasExactly(entry, ["key", "signature"]))
      return null;
    if (typeof entry.key !== "string" || !HEX64.test(entry.key)) return null;
    if (keys.has(entry.key)) return null;
    keys.add(entry.key);
    const signature = strictBase64(entry.signature, 64);
    if (!signature) return null;
    entries.push({ key: entry.key, signature });
  }
  return entries;
}

export function parseStatement(bytes) {
  const value = parseProfile(bytes, 1024);
  if (!value || !hasExactly(value, ["schema", "from", "to", "issued_at"]))
    return null;
  if (value.schema !== "vectory.release-key-rollover.v1") return null;
  if (typeof value.from !== "string" || !HEX64.test(value.from)) return null;
  const to = parseKeyLine(value.to);
  if (!to || to.fingerprint === value.from) return null;
  if (parseInstant(value.issued_at) === null) return null;
  return { from: value.from, to };
}

// A rollover envelope, `{"statement":"<base64>","signature":"<base64>"}`.
export function parseEnvelope(envelope) {
  const statement = strictBase64(envelope.statement_b64);
  const signature = strictBase64(envelope.signature_b64, 64);
  if (!statement || !signature || statement.length > 1024) return null;
  const parsed = parseStatement(statement);
  return parsed ? { ...parsed, bytes: statement, signature } : null;
}

// ---------------------------------------------------------------- the decision

export const refuse = (code, extra = {}) => ({
  result: "refused",
  code,
  ...extra,
});

// What a host does with an offered release, in the order of the contract: the
// offer's shape, the signature file, the rollover chain, the pins, the
// signatures, the manifest, the clock, the platform, the counter, the version
// (a running version that is not major.minor.patch included) and track, the
// minimum version, the service definition.
//
// `input` holds the manifest, the signature file and the statements as
// delivered, the host's pins, floors (the highest counter attempted per key),
// running version, platform, track, service definition and last result, and
// the time. `resolveKey(fingerprint)` returns {publicKey} of a pinned key.
export function decide(input, resolveKey) {
  const manifestBytes = Buffer.from(input.manifest_b64, "base64");
  const signatureBytes = Buffer.from(input.signatures_b64, "base64");
  if (input.rollovers.length > 8) return refuse("MANIFEST_INVALID");
  const entries = parseSignatureFile(signatureBytes);
  if (!entries) return refuse("SIGNATURE_INVALID");

  const pins = new Set(input.pins);
  const publicKeys = new Map(
    input.pins.map((fingerprint) => [
      fingerprint,
      resolveKey(fingerprint).publicKey,
    ]),
  );
  const floors = { ...input.floors };
  const statements = input.rollovers.map(parseEnvelope);
  const signedBy = (publicKey, statement) =>
    strictVerify(
      publicKey,
      Buffer.concat([text(ROLLOVER_PREFIX), statement.bytes]),
      statement.signature,
    );
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index];
    if (!statement || !pins.has(statement.from)) continue;
    const publicKey = publicKeys.get(statement.from);
    if (!signedBy(publicKey, statement)) continue;
    for (const other of statements.slice(index + 1))
      if (
        other &&
        other.from === statement.from &&
        other.to.fingerprint !== statement.to.fingerprint &&
        signedBy(publicKey, other)
      )
        return refuse("KEY_ROLLOVER_CONFLICT", {
          rollover_conflict: {
            from: statement.from,
            to: [statement.to.fingerprint, other.to.fingerprint].sort(),
          },
        });
    pins.delete(statement.from);
    pins.add(statement.to.fingerprint);
    publicKeys.set(
      statement.to.fingerprint,
      publicKeyFromRaw(statement.to.raw),
    );
    floors[statement.to.fingerprint] = Math.max(
      floors[statement.to.fingerprint] ?? 0,
      floors[statement.from] ?? 0,
    );
    delete floors[statement.from];
  }

  const named = entries.filter((entry) => pins.has(entry.key));
  if (!named.length) return refuse("KEY_NOT_PINNED");
  const message = Buffer.concat([text(RELEASE_PREFIX), manifestBytes]);
  const signers = named.filter((entry) =>
    strictVerify(publicKeys.get(entry.key), message, entry.signature),
  );
  if (!signers.length) return refuse("SIGNATURE_INVALID");

  const manifest = parseManifest(manifestBytes);
  if (!manifest) return refuse("MANIFEST_INVALID");
  const now = parseInstant(input.now);
  if (manifest.issued - now > FUTURE_ISSUE_SECONDS)
    return refuse("MANIFEST_INVALID");
  if (now >= manifest.expires) return refuse("MANIFEST_EXPIRED");
  if (
    !manifest.artifacts.some(
      (artifact) => artifact.os === input.os && artifact.arch === input.arch,
    )
  )
    return refuse("PLATFORM_NOT_IN_RELEASE");
  if (signers.some((entry) => (floors[entry.key] ?? 0) >= manifest.counter))
    return refuse(
      input.last &&
        input.last.release === sha256Hex(manifestBytes) &&
        input.last.outcome === "rolled_back"
        ? "RELEASE_ALREADY_TRIED"
        : "COUNTER_REPLAYED",
    );
  const running = parseVersion(input.running_version);
  // A running version that is not major.minor.patch cannot be compared with the
  // release's: it is refused as a downgrade is, and never guessed.
  if (!running) return refuse("DOWNGRADE_REFUSED");
  const order = compareVersions(manifest.version, running);
  if (order === 0) return refuse("ALREADY_RUNNING");
  if (order < 0) return refuse("DOWNGRADE_REFUSED");
  const sameMajor = manifest.version[0] === running[0];
  const sameMinor = sameMajor && manifest.version[1] === running[1];
  if (
    (input.track === "patch" && !sameMinor) ||
    (input.track === "minor" && !sameMajor)
  )
    return refuse("VERSION_NOT_ON_TRACK");
  if (manifest.minFrom && compareVersions(running, manifest.minFrom) < 0)
    return refuse("AGENT_TOO_OLD");
  if (manifest.serviceDefinition > input.service_definition)
    return refuse("SERVICE_DEFINITION_OUTDATED");

  for (const entry of signers) floors[entry.key] = manifest.counter;
  const pinsAfter = [...pins].sort();
  const floorsAfter = {};
  for (const fingerprint of pinsAfter)
    if (floors[fingerprint] > 0) floorsAfter[fingerprint] = floors[fingerprint];
  return {
    result: "valid",
    signer: signers[0].key,
    pins_after: pinsAfter,
    floors_after: floorsAfter,
  };
}

// ---------------------------------------------------------------- the key bundle

// What setup does with GET /agent/v1/release-keys and the fingerprint the
// operator typed: every entry's key must be a valid key line, and its
// `fingerprint` must equal the SHA-256 of its decoded bytes, or the whole
// bundle is malformed and nothing is pinned. The entry found is the one whose
// computed fingerprint equals the operator's value; members it does not know
// are ignored.
export function pinFromBundle(bytes, wanted) {
  let bundle;
  try {
    bundle = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return refuse("RELEASE_KEY_INVALID");
  }
  if (
    !isObject(bundle) ||
    bundle.schema !== "vectory.release-keys.v1" ||
    !Array.isArray(bundle.keys)
  )
    return refuse("RELEASE_KEY_INVALID");
  let found = null;
  for (const entry of bundle.keys) {
    if (!isObject(entry) || !["current", "retired"].includes(entry.state))
      return refuse("RELEASE_KEY_INVALID");
    const key = parseKeyLine(entry.public_key);
    if (!key || entry.fingerprint !== key.fingerprint)
      return refuse("RELEASE_KEY_INVALID");
    if (key.fingerprint === wanted && !found) found = entry.public_key;
  }
  return found ? { result: "valid", public_key: found } : { result: "absent" };
}

// ---------------------------------------------------------------- the heartbeat member

export const AGENT_CODES = [
  "UPDATES_OFF",
  "UPDATES_PAUSED",
  "KEY_NOT_PINNED",
  "SIGNATURE_INVALID",
  "MANIFEST_INVALID",
  "MANIFEST_EXPIRED",
  "KEY_ROLLOVER_CONFLICT",
  "RELEASE_ALREADY_TRIED",
  "COUNTER_REPLAYED",
  "DOWNGRADE_REFUSED",
  "VERSION_NOT_ON_TRACK",
  "AGENT_TOO_OLD",
  "ALREADY_RUNNING",
  "PLATFORM_NOT_IN_RELEASE",
  "PACKAGE_MANAGED",
  "NO_SERVICE",
  "UNTRUSTED_LOCATION",
  "READ_ONLY",
  "HELPER_NOT_RUNNING",
  "SERVICE_DEFINITION_OUTDATED",
  "DOWNLOAD_FAILED",
  "ARTIFACT_MISMATCH",
  "DISK_FULL",
  "PROBE_FAILED",
  "START_FAILED",
  "NO_CHECK_IN",
  "UNHEALTHY",
  "INTERRUPTED",
  "BINARY_CHANGED",
  "ROLLBACK_UNHEALTHY",
];
export const ELIGIBILITY = [
  "eligible",
  "PACKAGE_MANAGED",
  "NO_SERVICE",
  "UNTRUSTED_LOCATION",
  "READ_ONLY",
  "HELPER_NOT_RUNNING",
  "SERVICE_DEFINITION_OUTDATED",
  "PLATFORM_NOT_IN_RELEASE",
];
export const REPORT_STATES = [
  "idle",
  "downloading",
  "staged",
  "waiting_for_host",
  "waiting_for_window",
  "applying",
  "trial",
  "refused",
  "failed",
];
export const OUTCOMES = ["committed", "rolled_back", "failed", "refused"];
export const REPORT_BOUNDS = {
  keys: 4,
  windows: 7,
  window_characters: 40,
  fingerprint_characters: 64,
  highest_counter: MAX_SAFE,
  service_definition: 1000,
  first_check_in_ms: 86400000,
  version_bytes: 128,
};

// What a member that names or identifies something refuses: control characters,
// line and paragraph separators, text-direction embeddings, overrides and
// isolates, and the byte order mark (the rule of db::refused_in_name).
const REFUSED_RANGES = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const WITHOUT_CONTROL = new RegExp(
  `^[^${REFUSED_RANGES.map(
    ([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`,
  ).join("")}]+$`,
  "u",
);
const present = (value) => value !== undefined && value !== null;

// The last result, as the privileged step's status file keeps it and the
// heartbeat repeats it. Returns null when it is well formed, else a reason.
export function validateLast(last) {
  if (!isObject(last)) return "last is an object";
  if (
    !hasExactly(
      last,
      ["release", "outcome", "code", "at", "from_version", "to_version"],
      ["first_check_in_ms"],
    )
  )
    return "last has exactly its members";
  if (typeof last.release !== "string" || !HEX64.test(last.release))
    return "last.release is a manifest digest";
  if (!OUTCOMES.includes(last.outcome)) return "last.outcome is not known";
  if (last.code !== null && !AGENT_CODES.includes(last.code))
    return "last.code is not a code";
  if (last.outcome === "committed" && last.code !== null)
    return "a committed result has no code";
  if (last.outcome !== "committed" && last.code === null)
    return "a result that is not committed has a code";
  if (parseInstant(last.at) === null) return "last.at is a UTC instant";
  if (
    typeof last.from_version !== "string" ||
    Buffer.byteLength(last.from_version) < 1 ||
    Buffer.byteLength(last.from_version) > REPORT_BOUNDS.version_bytes ||
    !WITHOUT_CONTROL.test(last.from_version)
  )
    return "last.from_version is 1 to 128 bytes without control characters";
  if (last.to_version !== null && !parseVersion(last.to_version))
    return "last.to_version is a version or null";
  if ("first_check_in_ms" in last) {
    if (
      !Number.isInteger(last.first_check_in_ms) ||
      last.first_check_in_ms < 0 ||
      last.first_check_in_ms > REPORT_BOUNDS.first_check_in_ms
    )
      return "last.first_check_in_ms is 0 to 86,400,000";
  }
  return null;
}

// The heartbeat member `agent_update`: allowlisted members, bounded lists, the
// relations between them. Returns null when it is acceptable, else a reason.
// Null counts as absent for an optional member.
export function validateReport(member) {
  if (!isObject(member)) return "the member is an object";
  const required = [
    "consent",
    "paused",
    "track",
    "windows",
    "window_open",
    "keys",
    "highest_counter",
    "eligibility",
    "state",
  ];
  const optional = [
    "next_window_at",
    "service_definition",
    "release",
    "code",
    "rollover_conflict",
    "last",
  ];
  if (!hasExactly(member, required, optional))
    return "unknown or missing member";
  if (!["off", "auto", "ask"].includes(member.consent))
    return "consent is off, auto or ask";
  if (typeof member.paused !== "boolean") return "paused is a boolean";
  if (!["patch", "minor"].includes(member.track))
    return "track is patch or minor";
  if (
    !Array.isArray(member.windows) ||
    member.windows.length > REPORT_BOUNDS.windows ||
    !member.windows.every(
      (window) =>
        typeof window === "string" &&
        window.length >= 1 &&
        window.length <= REPORT_BOUNDS.window_characters &&
        /^[\x20-\x7e]+$/.test(window),
    )
  )
    return "windows are at most 7 strings of 1 to 40 printable ASCII characters";
  if (typeof member.window_open !== "boolean")
    return "window_open is a boolean";
  if (
    present(member.next_window_at) &&
    parseInstant(member.next_window_at) === null
  )
    return "next_window_at is a UTC instant";
  if (
    !Array.isArray(member.keys) ||
    member.keys.length > REPORT_BOUNDS.keys ||
    !member.keys.every((key) => typeof key === "string" && HEX64.test(key)) ||
    new Set(member.keys).size !== member.keys.length
  )
    return "keys are at most 4 distinct fingerprints";
  if (
    !Number.isInteger(member.highest_counter) ||
    member.highest_counter < 0 ||
    member.highest_counter > MAX_SAFE
  )
    return "highest_counter is 0 to 2^53-1";
  if (!ELIGIBILITY.includes(member.eligibility))
    return "eligibility is not known";
  if (present(member.service_definition)) {
    if (
      !Number.isInteger(member.service_definition) ||
      member.service_definition < 1 ||
      member.service_definition > REPORT_BOUNDS.service_definition
    )
      return "service_definition is 1 to 1,000";
  }
  if (!REPORT_STATES.includes(member.state)) return "state is not known";
  if (present(member.release) && !HEX64.test(member.release))
    return "release is a manifest digest";
  if (present(member.code) && !AGENT_CODES.includes(member.code))
    return "code is not a code";
  if (present(member.rollover_conflict)) {
    const conflict = member.rollover_conflict;
    if (
      !isObject(conflict) ||
      !hasExactly(conflict, ["from", "to"]) ||
      typeof conflict.from !== "string" ||
      !HEX64.test(conflict.from) ||
      !Array.isArray(conflict.to) ||
      conflict.to.length !== 2 ||
      !conflict.to.every((key) => typeof key === "string" && HEX64.test(key)) ||
      conflict.to[0] === conflict.to[1] ||
      conflict.to.includes(conflict.from)
    )
      return "rollover_conflict is a fingerprint and two different successors of it";
  }
  if (present(member.last)) {
    const problem = validateLast(member.last);
    if (problem) return problem;
  }
  const inProgress = [
    "downloading",
    "staged",
    "waiting_for_host",
    "waiting_for_window",
    "applying",
    "trial",
  ];
  if (inProgress.includes(member.state) && !present(member.release))
    return "a state about a release names it";
  if (["refused", "failed"].includes(member.state) && !present(member.code))
    return "a refusal or a failure has a code";
  if (
    member.consent === "off" &&
    (member.state !== "idle" || present(member.release))
  )
    return "a host that is off reports idle";
  if (
    present(member.rollover_conflict) !==
    (member.code === "KEY_ROLLOVER_CONFLICT")
  )
    return "rollover_conflict and its code go together";
  return null;
}
