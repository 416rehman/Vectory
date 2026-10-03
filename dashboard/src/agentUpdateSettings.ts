// What the Settings page for agent updates decides without a server: the words
// of the two ways to hold the release key, the request that turns updates on,
// the hosts that still trust a key that is no longer current, and the two
// files a person brings from the machine that holds an offline key (a rollover
// statement and a release's signatures). The server stays the authority: it
// checks every key and every signature, and these readers only keep a wrong
// file from being sent.
import type { AgentUpdates, ReleaseKey } from "./agentUpdateModel";
import { decodeBase64, readKeyLine } from "./releaseKey";

export type Custody = "server" | "offline";

export const custodyChoices: {
  value: Custody;
  label: string;
  summary: string;
}[] = [
  {
    value: "server",
    label: "This server signs",
    summary:
      "The server creates and keeps a release key. Anyone who administers this server, or holds a backup of it, can approve builds that every opted-in host installs. Simplest.",
  },
  {
    value: "offline",
    label: "A key kept offline",
    summary:
      "You create the key on another machine and sign each release there. The server never holds it. Each release waits for your signature.",
  },
];

export const custodyName = (custody: Custody | null | undefined) =>
  custody === "server"
    ? "This server signs"
    : custody === "offline"
      ? "A key kept offline"
      : "Not chosen yet";

/** Said under a turned-off page's key: what turning on again does with it. */
export const otherCustodyWarning =
  "Hosts enrolled with the current key keep it. Each takes the new key only when you run its Upgrade agent command again.";

/**
 * What choosing a way to hold the key does, given the key that is there: it
 * keeps the current key (the same way, updates only turned off), or it makes a
 * new one, which hosts take only through their Upgrade agent command. With no
 * key (never turned on, or revoked) there is nothing to keep or replace.
 */
export function turnOnEffect(
  updates: Pick<AgentUpdates, "current_key" | "custody">,
  choice: Custody,
): "new" | "keep" | "replace" {
  if (!updates.current_key) return "new";
  return updates.custody === choice ? "keep" : "replace";
}

export type TurnOnBody = {
  enabled: true;
  custody?: { kind: Custody; public_key?: string };
  current_password: string;
  revision: number;
};
/**
 * The body that turns updates on. The same way as the current key is sent
 * without a custody (the server keeps that key; nothing is re-pinned); the
 * other way names its kind, and for a key kept offline carries its line.
 */
export function turnOnBody(
  updates: Pick<AgentUpdates, "current_key" | "custody" | "revision">,
  choice: Custody,
  keyLine: string,
  password: string,
): TurnOnBody {
  const effect = turnOnEffect(updates, choice);
  const base = {
    enabled: true as const,
    current_password: password,
    revision: updates.revision,
  };
  if (effect === "keep") return base;
  return {
    ...base,
    custody:
      choice === "offline"
        ? { kind: "offline", public_key: keyLine.trim() }
        : { kind: "server" },
  };
}

export type TurnOnReadiness =
  { ok: true } | { ok: false; why: "choice" | "key" | "password" };
/** Whether the dialog may send: a choice, a key that reads as one (when a new offline key is needed), a password. */
export function turnOnReady(
  updates: Pick<AgentUpdates, "current_key" | "custody">,
  choice: Custody | "",
  keyLine: string,
  password: string,
): TurnOnReadiness {
  if (!choice) return { ok: false, why: "choice" };
  if (
    choice === "offline" &&
    turnOnEffect(updates, choice) !== "keep" &&
    !readKeyLine(keyLine.trim()).ok
  )
    return { ok: false, why: "key" };
  if (!password) return { ok: false, why: "password" };
  return { ok: true };
}

/* ---------- A reason for a stop, a withdrawal or a revocation ---------- */

export const REASON_LIMIT = 500;
/**
 * A reason: 1 to 500 characters once trimmed, with no control character (so
 * one line). The server counts Unicode scalar values, as `[...text]` does.
 */
export function readReason(
  text: string,
): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = text.trim();
  if (!reason) return { ok: false, message: "Give a reason." };
  if ([...reason].length > REASON_LIMIT)
    return {
      ok: false,
      message: `A reason is at most ${REASON_LIMIT} characters.`,
    };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(reason))
    return {
      ok: false,
      message: "A reason is one line, without control characters.",
    };
  return { ok: true, reason };
}

/* ---------- Keys that hosts still pin ---------- */

export type PinnedKey = {
  key: ReleaseKey;
  hosts: number;
  names: string[];
  more: number;
  /**
   * The hosts take the current key by themselves: a retired key whose rollover
   * statements lead to it within the eight a host will follow. A revoked key
   * has none (its statements left the key bundle with it), so its hosts need
   * their Upgrade agent command.
   */
  follows: boolean;
};

/** The key a rollover statement replaced, read from the envelope that made a key current. */
export function replacedKey(key: Pick<ReleaseKey, "introduced_by">) {
  if (!key.introduced_by) return null;
  const bytes = decodeBase64(key.introduced_by.statement);
  if (!bytes) return null;
  try {
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as { from?: unknown };
    return typeof body.from === "string" && /^[a-f0-9]{64}$/.test(body.from)
      ? body.from
      : null;
  } catch {
    return null;
  }
}

/** How many statements a host follows from a key it pins to the signer. */
export const ROLLOVER_HOPS = 8;

/**
 * Keys that are no longer current and that hosts still pin, those that need a
 * command first, then most hosts first: those hosts trust a key that signs
 * nothing new.
 */
export function stalePins(keys: readonly ReleaseKey[]): PinnedKey[] {
  const current = keys.find((key) => key.state === "current");
  // Which key each key replaced, for the keys a statement made current. A
  // revoked key's statements left the key bundle with it: hosts can't follow them.
  const successor = new Map<string, string>();
  for (const key of keys) {
    const from = replacedKey(key);
    if (!from) continue;
    if (keys.find((other) => other.fingerprint === from)?.state === "revoked")
      continue;
    successor.set(from, key.fingerprint);
  }
  const reaches = (start: string) => {
    let at = start;
    for (let hops = 0; hops < ROLLOVER_HOPS; hops++) {
      const next = successor.get(at);
      if (!next) return false;
      if (current && next === current.fingerprint) return true;
      at = next;
    }
    return false;
  };
  return keys
    .filter((key) => key.state !== "current" && key.devices_pinning > 0)
    .map((key) => ({
      key,
      hosts: key.devices_pinning,
      names: key.device_names,
      more: Math.max(0, key.devices_pinning - key.device_names.length),
      follows: key.state === "retired" && reaches(key.fingerprint),
    }))
    .sort(
      (a, b) =>
        Number(a.follows) - Number(b.follows) ||
        Number(b.key.state === "revoked") - Number(a.key.state === "revoked") ||
        b.hosts - a.hosts,
    );
}

/* ---------- The rollover statement an offline key writes ---------- */

export type RolloverFile =
  | {
      ok: true;
      statement: string;
      signature: string;
      from: string;
      to: { fingerprint: string; name: string; line: string };
      issuedAt: string;
    }
  | { ok: false; message: string };

const ROLLOVER_SCHEMA = "vectory.release-key-rollover.v1";
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const refuse = (message: string): { ok: false; message: string } => ({
  ok: false,
  message,
});

/**
 * Reads the file `vectory release rollover` wrote: `{"statement","signature"}`,
 * both base64. It shows what the statement says (which key it replaces, which
 * it makes current) and refuses a file that isn't one; whether the signature
 * is the current key's is for the server to say.
 */
export function readRolloverFile(text: string): RolloverFile {
  if (text.length > 4096)
    return refuse("That file is too large to be a rollover statement.");
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return refuse(
      "This isn't a rollover file. Choose the file vectory release rollover wrote.",
    );
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.keys(envelope).sort().join() !== "signature,statement" ||
    typeof (envelope as Record<string, unknown>).statement !== "string" ||
    typeof (envelope as Record<string, unknown>).signature !== "string"
  )
    return refuse(
      "This isn't a rollover file. It should hold a statement and its signature, nothing else.",
    );
  const { statement, signature } = envelope as {
    statement: string;
    signature: string;
  };
  const statementBytes = decodeBase64(statement);
  const signatureBytes = decodeBase64(signature);
  if (!statementBytes || statementBytes.length > 1024)
    return refuse("The statement in this file isn't readable.");
  if (!signatureBytes || signatureBytes.length !== 64)
    return refuse("The signature in this file isn't readable.");
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(statementBytes),
    );
  } catch {
    return refuse("The statement in this file isn't readable.");
  }
  const fields = body as Record<string, unknown> | null;
  if (
    !fields ||
    typeof fields !== "object" ||
    Array.isArray(fields) ||
    Object.keys(fields).sort().join() !== "from,issued_at,schema,to" ||
    fields.schema !== ROLLOVER_SCHEMA ||
    typeof fields.from !== "string" ||
    typeof fields.to !== "string" ||
    typeof fields.issued_at !== "string"
  )
    return refuse("This statement isn't a release key rollover.");
  if (!/^[a-f0-9]{64}$/.test(fields.from))
    return refuse("The statement doesn't name the key it replaces.");
  const to = readKeyLine(fields.to);
  if (!to.ok) return refuse(`The new key in this statement: ${to.message}`);
  if (to.fingerprint === fields.from)
    return refuse("This statement replaces a key with itself.");
  if (!instant.test(fields.issued_at))
    return refuse("The statement's time isn't readable.");
  return {
    ok: true,
    statement,
    signature,
    from: fields.from,
    to: { fingerprint: to.fingerprint, name: to.name, line: fields.to },
    issuedAt: fields.issued_at,
  };
}

/* ---------- The signatures a release's signer wrote ---------- */

export type SignatureFile =
  | {
      ok: true;
      /** The fingerprints its entries name. */
      keys: string[];
      namesCurrent: boolean;
    }
  | { ok: false; message: string };

export const SIGNATURE_LIMIT = 4096;
const SIGNATURE_SCHEMA = "vectory.agent-release-signatures.v1";

/**
 * Reads a release.json.sig well enough to say whether it is one and whether it
 * names the current key; the server verifies the signature itself. The bytes
 * are sent exactly as they were chosen, never re-written from this reading.
 */
export function readSignatureFile(
  bytes: Uint8Array,
  currentFingerprint: string | null,
): SignatureFile {
  if (bytes.length > SIGNATURE_LIMIT)
    return refuse(
      "That file is too large to be a signature file. A release.json.sig is under 4 KiB.",
    );
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refuse(
      "This isn't a signature file. Choose the release.json.sig that vectory release sign wrote.",
    );
  }
  const fields = body as Record<string, unknown> | null;
  if (
    !fields ||
    typeof fields !== "object" ||
    Array.isArray(fields) ||
    fields.schema !== SIGNATURE_SCHEMA ||
    !Array.isArray(fields.signatures) ||
    fields.signatures.length < 1 ||
    fields.signatures.length > 4
  )
    return refuse(
      "This isn't a signature file. Choose the release.json.sig that vectory release sign wrote.",
    );
  const keys: string[] = [];
  for (const entry of fields.signatures as unknown[]) {
    const item = entry as Record<string, unknown> | null;
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.key !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.key) ||
      typeof item.signature !== "string" ||
      decodeBase64(item.signature)?.length !== 64
    )
      return refuse("An entry of this signature file isn't readable.");
    keys.push(item.key);
  }
  return {
    ok: true,
    keys,
    namesCurrent:
      currentFingerprint !== null && keys.includes(currentFingerprint),
  };
}
