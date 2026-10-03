import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  custodyChoices,
  custodyName,
  otherCustodyWarning,
  readReason,
  readRolloverFile,
  readSignatureFile,
  stalePins,
  turnOnBody,
  turnOnEffect,
  turnOnReady,
} from "./agentUpdateSettings";
import {
  nextFingerprint,
  nextLine,
  releaseKey,
  teamFingerprint,
  teamLine,
  updates,
} from "./agentUpdateFixtures.test-support";

const example = (name: string) =>
  readFileSync(
    new URL(
      `../../contracts/fixtures/agent-release/examples/${name}`,
      import.meta.url,
    ),
  );

describe("the two ways to hold the release key", () => {
  it("are described as the design words them, and neither is chosen for anyone", () => {
    expect(custodyChoices.map((choice) => choice.label)).toEqual([
      "This server signs",
      "A key kept offline",
    ]);
    expect(custodyChoices[0].summary).toBe(
      "The server creates and keeps a release key. Anyone who administers this server, or holds a backup of it, can approve builds that every opted-in host installs. Simplest.",
    );
    expect(custodyChoices[1].summary).toBe(
      "You create the key on another machine and sign each release there. The server never holds it. Each release waits for your signature.",
    );
    expect(custodyName(null)).toBe("Not chosen yet");
    expect(custodyName("offline")).toBe("A key kept offline");
  });

  it("say what turning on again does to the hosts that pin the current key", () => {
    expect(otherCustodyWarning).toBe(
      "Hosts enrolled with the current key keep it. Each takes the new key only when you run its Upgrade agent command again.",
    );
    const none = { current_key: null, custody: null } as const;
    const kept = { current_key: releaseKey(), custody: "offline" } as const;
    expect(turnOnEffect(none, "server")).toBe("new");
    expect(turnOnEffect(kept, "offline")).toBe("keep");
    expect(turnOnEffect(kept, "server")).toBe("replace");
  });
});

describe("the request that turns updates on", () => {
  const off = updates({ enabled: false, revision: 4 });
  it("asks the server to make a key when none exists, or to register the pasted one", () => {
    const fresh = { current_key: null, custody: null, revision: 0 };
    expect(turnOnBody(fresh, "server", "", "pw")).toEqual({
      enabled: true,
      custody: { kind: "server" },
      current_password: "pw",
      revision: 0,
    });
    expect(turnOnBody(fresh, "offline", `  ${teamLine}  `, "pw")).toEqual({
      enabled: true,
      custody: { kind: "offline", public_key: teamLine },
      current_password: "pw",
      revision: 0,
    });
  });

  it("keeps the current key, without naming a custody, when the way is the same", () => {
    expect(turnOnBody(off, "offline", "", "pw")).toEqual({
      enabled: true,
      current_password: "pw",
      revision: 4,
    });
  });

  it("names the other way when it changes, so the server retires the old key", () => {
    expect(turnOnBody(off, "server", "", "pw").custody).toEqual({
      kind: "server",
    });
  });

  it("is ready only with a choice, a key that reads as one when a new offline key is needed, and a password", () => {
    const fresh = { current_key: null, custody: null } as const;
    expect(turnOnReady(fresh, "", "", "")).toEqual({
      ok: false,
      why: "choice",
    });
    expect(turnOnReady(fresh, "server", "", "")).toEqual({
      ok: false,
      why: "password",
    });
    expect(turnOnReady(fresh, "server", "", "pw")).toEqual({ ok: true });
    expect(turnOnReady(fresh, "offline", "not a key", "pw")).toEqual({
      ok: false,
      why: "key",
    });
    expect(turnOnReady(fresh, "offline", teamLine, "pw")).toEqual({ ok: true });
    // The registered key is kept: no line to paste.
    expect(
      turnOnReady(
        { current_key: releaseKey(), custody: "offline" },
        "offline",
        "",
        "pw",
      ),
    ).toEqual({ ok: true });
  });
});

describe("a reason", () => {
  it("is one line of 1 to 500 characters, trimmed", () => {
    expect(readReason("  A bad build  ")).toEqual({
      ok: true,
      reason: "A bad build",
    });
    expect(readReason("   ")).toEqual({ ok: false, message: "Give a reason." });
    expect(readReason("x".repeat(500)).ok).toBe(true);
    expect(readReason("x".repeat(501))).toMatchObject({ ok: false });
    // Characters count as the server counts them, not as UTF-16 units.
    expect(readReason("😀".repeat(500)).ok).toBe(true);
    expect(readReason("😀".repeat(501)).ok).toBe(false);
    expect(readReason("one\ntwo")).toMatchObject({ ok: false });
    expect(readReason("tab\there")).toMatchObject({ ok: false });
  });
});

describe("hosts that pin a key that is no longer current", () => {
  const envelope = JSON.parse(
    example("rollover-envelope.json").toString("utf8"),
  ) as { statement: string; signature: string };
  const rolled = {
    statement: envelope.statement,
    signature: envelope.signature,
  };

  it("lists retired and revoked keys with hosts, those that need a command first, and how many are not named", () => {
    const keys = [
      releaseKey({
        fingerprint: nextFingerprint,
        state: "current",
        devices_pinning: 9,
        introduced_by: rolled,
      }),
      releaseKey({
        fingerprint: "a".repeat(64),
        state: "retired",
        devices_pinning: 25,
        device_names: Array.from({ length: 20 }, (_, i) => `edge-${i}`),
      }),
      releaseKey({
        fingerprint: "b".repeat(64),
        state: "revoked",
        devices_pinning: 2,
        device_names: ["edge-01", "edge-02"],
      }),
      releaseKey({
        fingerprint: "c".repeat(64),
        state: "retired",
        devices_pinning: 0,
      }),
      releaseKey({
        fingerprint: teamFingerprint,
        state: "retired",
        devices_pinning: 12,
      }),
    ];
    const stale = stalePins(keys);
    expect(
      stale.map((entry) => [
        entry.key.fingerprint[0],
        entry.hosts,
        entry.more,
        entry.follows,
      ]),
    ).toEqual([
      ["b", 2, 0, false],
      ["a", 25, 5, false],
      ["0", 12, 10, true],
    ]);
  });

  it("knows a host follows the rollover only while the statements still lead to the current key", () => {
    const next = releaseKey({
      fingerprint: nextFingerprint,
      state: "current",
      introduced_by: rolled,
    });
    const old = (state: "retired" | "revoked") =>
      releaseKey({ fingerprint: teamFingerprint, state, devices_pinning: 3 });
    expect(stalePins([next, old("retired")])[0].follows).toBe(true);
    // Revoking the key drops the statements it signed.
    expect(stalePins([next, old("revoked")])[0].follows).toBe(false);
    // The current key was not made by a statement: nothing leads to it.
    expect(
      stalePins([
        releaseKey({ fingerprint: nextFingerprint }),
        old("retired"),
      ])[0].follows,
    ).toBe(false);
    // A chain through a revoked key is cut.
    const middle = releaseKey({
      fingerprint: nextFingerprint,
      state: "revoked",
      introduced_by: rolled,
    });
    const last = releaseKey({
      fingerprint: "d".repeat(64),
      state: "current",
      introduced_by: {
        statement: Buffer.from(
          JSON.stringify({
            schema: "vectory.release-key-rollover.v1",
            from: nextFingerprint,
            to: nextLine,
            issued_at: "2026-12-01T09:00:00Z",
          }),
        ).toString("base64"),
        signature: envelope.signature,
      },
    });
    expect(stalePins([last, middle, old("retired")])[0].follows).toBe(false);
  });

  it("is empty when every host pins the current key", () => {
    expect(stalePins([releaseKey()])).toEqual([]);
  });
});

describe("the rollover file an offline key writes", () => {
  it("reads the published example and says what it replaces", () => {
    const text = example("rollover-envelope.json").toString("utf8");
    const read = readRolloverFile(text);
    expect(read).toMatchObject({
      ok: true,
      from: teamFingerprint,
      to: { fingerprint: nextFingerprint, name: "team-next", line: nextLine },
      issuedAt: "2026-11-02T09:00:00Z",
    });
    // A final line feed, as a tool may write, changes nothing.
    expect(readRolloverFile(`${text}\n`).ok).toBe(true);
  });

  it("refuses what isn't one", () => {
    const good = JSON.parse(example("rollover-envelope.json").toString("utf8"));
    const bad: [string, string][] = [
      ["", "This isn't a rollover file"],
      ["[]", "This isn't a rollover file"],
      [
        JSON.stringify({ statement: good.statement }),
        "This isn't a rollover file",
      ],
      [JSON.stringify({ ...good, extra: 1 }), "This isn't a rollover file"],
      [
        JSON.stringify({ ...good, statement: "AAAA" }),
        "statement in this file isn't readable",
      ],
      [
        JSON.stringify({
          ...good,
          statement: Buffer.from('{"a":1}').toString("base64"),
        }),
        "isn't a release key rollover",
      ],
      [JSON.stringify({ ...good, statement: "not base64!" }), "isn't readable"],
      [
        JSON.stringify({ ...good, signature: "AAAA" }),
        "signature in this file isn't readable",
      ],
      ["x".repeat(5000), "too large"],
    ];
    for (const [text, message] of bad)
      expect(readRolloverFile(text), text.slice(0, 30)).toMatchObject({
        ok: false,
        message: expect.stringContaining(message),
      });
  });

  it("refuses a statement that replaces a key with itself, or names a key that isn't one", () => {
    const statement = (members: Record<string, string>) =>
      JSON.stringify({
        statement: Buffer.from(
          JSON.stringify({
            schema: "vectory.release-key-rollover.v1",
            from: teamFingerprint,
            to: nextLine,
            issued_at: "2026-11-02T09:00:00Z",
            ...members,
          }),
        ).toString("base64"),
        signature: Buffer.alloc(64, 1).toString("base64"),
      });
    expect(readRolloverFile(statement({ to: teamLine }))).toMatchObject({
      ok: false,
      message: "This statement replaces a key with itself.",
    });
    expect(
      readRolloverFile(statement({ to: "vectory-release-key ed25519 AAAA x" })),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("The new key in this statement"),
    });
    expect(readRolloverFile(statement({ from: "05cc" }))).toMatchObject({
      ok: false,
      message: "The statement doesn't name the key it replaces.",
    });
    expect(
      readRolloverFile(statement({ issued_at: "yesterday" })),
    ).toMatchObject({
      ok: false,
      message: "The statement's time isn't readable.",
    });
  });
});

describe("the signature file a release's signer writes", () => {
  it("reads the published example and knows it names the current key", () => {
    const bytes = new Uint8Array(example("release.json.sig"));
    expect(readSignatureFile(bytes, teamFingerprint)).toEqual({
      ok: true,
      keys: [teamFingerprint],
      namesCurrent: true,
    });
    expect(readSignatureFile(bytes, nextFingerprint)).toEqual({
      ok: true,
      keys: [teamFingerprint],
      namesCurrent: false,
    });
    expect(readSignatureFile(bytes, null)).toMatchObject({
      namesCurrent: false,
    });
  });

  it("refuses the manifest itself, a file that is too long and anything unreadable", () => {
    const manifest = new Uint8Array(example("release.json"));
    expect(readSignatureFile(manifest, teamFingerprint)).toMatchObject({
      ok: false,
      message: expect.stringContaining("This isn't a signature file"),
    });
    expect(
      readSignatureFile(new Uint8Array(4097), teamFingerprint),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("too large"),
    });
    expect(
      readSignatureFile(new Uint8Array([0xff, 0xfe]), teamFingerprint),
    ).toMatchObject({
      ok: false,
    });
    const entry = (key: string, signature: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          schema: "vectory.agent-release-signatures.v1",
          signatures: [{ key, signature }],
        }),
      );
    expect(
      readSignatureFile(entry("short", "AAAA"), teamFingerprint),
    ).toMatchObject({
      ok: false,
      message: "An entry of this signature file isn't readable.",
    });
    expect(
      readSignatureFile(
        new TextEncoder().encode(
          JSON.stringify({
            schema: "vectory.agent-release-signatures.v1",
            signatures: [],
          }),
        ),
        teamFingerprint,
      ),
    ).toMatchObject({ ok: false });
  });
});
