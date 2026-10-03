// A release key as someone pastes it: one line, `vectory-release-key ed25519
// <base64 of the 32 key bytes> <name>`. The fingerprint is computed here from
// the key's own bytes, as the server, the agent and `vectory release` compute
// it, so a pasted key can be compared with what the host will pin. The key rule
// is the contract's (a canonical encoding of a curve point of large order); the
// shared vectors run through this file in its test, and the server still
// decides: nothing here makes a key valid, it only refuses early what the
// server would refuse.

/** SHA-256 in plain code: `crypto.subtle` exists only in a secure context, and a
 * dashboard served over plain HTTP on a private network still shows fingerprints. */
const roundConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotateRight = (value: number, bits: number) =>
  (value >>> bits) | (value << (32 - bits));

export function sha256(message: Uint8Array): Uint8Array {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  // The message, a 1 bit, zeros, and its length in bits as 64 big-endian bits.
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(message.length / 0x20000000));
  view.setUint32(padded.length - 4, (message.length << 3) >>> 0);
  const schedule = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) schedule[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = schedule[i - 15];
      const b = schedule[i - 2];
      const low = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const high = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      schedule[i] = (schedule[i - 16] + low + schedule[i - 7] + high) | 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + sum1 + choose + roundConstants[i] + schedule[i]) | 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) | 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) | 0;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }
  const out = new Uint8Array(32);
  const result = new DataView(out.buffer);
  state.forEach((word, i) => result.setUint32(i * 4, word));
  return out;
}

export function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Standard base64 with padding, canonical: the unused bits are zero, so one
 * byte string has one spelling. Null for anything else.
 */
export function decodeBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
    return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let again = "";
  for (const byte of bytes) again += String.fromCharCode(byte);
  return btoa(again) === text ? bytes : null;
}

/* ---------- The key rule ---------- */

const P = (1n << 255n) - 19n;
// The curve's d: -121665 / 121666 modulo P.
const D =
  37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function power(base: bigint, exponent: bigint) {
  let result = 1n;
  let square = base % P;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = (result * square) % P;
    square = (square * square) % P;
  }
  return result;
}

/** The eight encodings of the points of order 1, 2, 4 and 8. */
const smallOrder = new Set([
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
]);

/**
 * Whether 32 bytes are the canonical encoding of a point of the Ed25519 curve
 * that is not of small order: `y` below the field prime, an `x` that exists
 * (and, when it is 0, a clear sign bit), and not one of the eight points
 * that verify any message.
 */
export function isUsablePoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 32 || smallOrder.has(hex(bytes))) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  const negative = y >> 255n === 1n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  // x^2 = (y^2 - 1) / (d y^2 + 1) must be a square: Euler's criterion.
  const squared = (y * y) % P;
  const numerator = (squared - 1n + P) % P;
  const denominator = (D * squared + 1n) % P;
  const quotient = (numerator * power(denominator, P - 2n)) % P;
  if (quotient === 0n) return !negative;
  return power(quotient, (P - 1n) / 2n) === 1n;
}

/* ---------- The key line ---------- */

export type KeyLine =
  | {
      ok: true;
      /** The lowercase SHA-256 of the 32 key bytes. */
      fingerprint: string;
      name: string;
    }
  | { ok: false; message: string };

const prefix = "vectory-release-key ed25519 ";
const namePattern =
  /^[\x21\x23-\x5b\x5d-\x7e](?:[\x20\x21\x23-\x5b\x5d-\x7e]{0,62}[\x21\x23-\x5b\x5d-\x7e])?$/;

/**
 * What a pasted line is: a valid key with its fingerprint, or the first thing
 * wrong with it, in words for the person who pasted it. An empty line is not
 * a refusal yet: the caller shows nothing until something is typed.
 */
export function readKeyLine(line: string): KeyLine {
  if (!line.startsWith(prefix))
    return {
      ok: false,
      message:
        "This isn't a release key line. It reads: vectory-release-key ed25519, the key, then a name.",
    };
  const rest = line.slice(prefix.length);
  const space = rest.indexOf(" ");
  const encoded = space < 0 ? rest : rest.slice(0, space);
  const name = space < 0 ? "" : rest.slice(space + 1);
  const bytes = decodeBase64(encoded);
  if (!bytes || bytes.length !== 32)
    return {
      ok: false,
      message: "The key must be 32 bytes in standard base64, with its padding.",
    };
  if (!namePattern.test(name))
    return {
      ok: false,
      message:
        "The name is 1 to 64 printable characters, with no quotation mark or backslash, and no space at either end.",
    };
  if (!isUsablePoint(bytes))
    return {
      ok: false,
      message:
        "This isn't a valid Ed25519 public key: it is not a point that can verify a signature.",
    };
  return { ok: true, fingerprint: hex(sha256(bytes)), name };
}

/** The first 16 characters of a fingerprint: the short ID printed everywhere. */
export const shortKeyId = (fingerprint: string) => fingerprint.slice(0, 16);

/** The whole fingerprint in groups of eight, for comparing by eye. */
export function fingerprintGroups(fingerprint: string) {
  return fingerprint.match(/.{1,8}/g) ?? [];
}
