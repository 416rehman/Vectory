import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeBase64,
  fingerprintGroups,
  hex,
  isUsablePoint,
  readKeyLine,
  sha256,
  shortKeyId,
} from "./releaseKey";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/fixtures/agent-release/vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  keys: { name: string; fingerprint: string; public_key_line: string }[];
  key_lines: {
    name: string;
    line: string;
    expect:
      | { result: "valid"; fingerprint: string; name: string }
      | { result: "refused"; code: string };
  }[];
};

describe("the fingerprint is computed in the browser", () => {
  it("hashes like the platform does, at every length around a block", () => {
    for (let length = 0; length <= 200; length++) {
      const bytes = randomBytes(length);
      expect(hex(sha256(bytes)), `${length} bytes`).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
    expect(hex(sha256(new TextEncoder().encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("gives the published fingerprint of every published test key", () => {
    expect(vectors.keys.length).toBeGreaterThan(5);
    for (const key of vectors.keys) {
      const read = readKeyLine(key.public_key_line);
      expect(read, key.name).toMatchObject({
        ok: true,
        fingerprint: key.fingerprint,
      });
    }
  });

  it("shows a fingerprint in groups of eight and a short ID of sixteen", () => {
    const fingerprint =
      "05cc6c02351af0cb1be9877e7cdcd326c68310018746cb7bbbf6beb29392618b";
    expect(fingerprintGroups(fingerprint)).toEqual([
      "05cc6c02",
      "351af0cb",
      "1be9877e",
      "7cdcd326",
      "c6831001",
      "8746cb7b",
      "bbf6beb2",
      "9392618b",
    ]);
    expect(shortKeyId(fingerprint)).toBe("05cc6c02351af0cb");
  });
});

describe("a pasted key line, against the shared vectors", () => {
  it("agrees with every case of the key rule", () => {
    expect(vectors.key_lines.length).toBeGreaterThanOrEqual(48);
    for (const entry of vectors.key_lines) {
      const read = readKeyLine(entry.line);
      if (entry.expect.result === "valid")
        expect(read, entry.name).toEqual({
          ok: true,
          fingerprint: entry.expect.fingerprint,
          name: entry.expect.name,
        });
      else expect(read.ok, entry.name).toBe(false);
    }
  });

  it("says what is wrong in words, first thing first", () => {
    const [valid] = vectors.key_lines;
    const bad = (line: string) => {
      const read = readKeyLine(line);
      return read.ok ? "" : read.message;
    };
    expect(bad("ssh-ed25519 AAAA team")).toMatch(/isn't a release key line/);
    expect(bad(valid.line.replace("7o=", "7o"))).toMatch(/32 bytes/);
    expect(bad(`${valid.line} `)).toMatch(/name is 1 to 64/);
    expect(bad(valid.line.replace("team", 'te"am'))).toMatch(/quotation mark/);
    expect(
      bad(
        "vectory-release-key ed25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= small",
      ),
    ).toMatch(/valid Ed25519 public key/);
  });

  it("refuses the eight points that verify any message", () => {
    const refused = vectors.key_lines.filter((entry) =>
      entry.name.startsWith("small-order-"),
    );
    expect(refused).toHaveLength(8);
    for (const entry of refused) {
      const encoded = entry.line.split(" ")[2];
      const bytes = decodeBase64(encoded)!;
      expect(isUsablePoint(bytes), entry.name).toBe(false);
    }
  });
});

describe("base64 as the contract writes it", () => {
  it("accepts one spelling of a byte string and no other", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const text = Buffer.from(bytes).toString("base64");
    expect(decodeBase64(text)).toEqual(bytes);
    // Not padded, in the URL alphabet, spaced out, or with stray bits set.
    expect(decodeBase64(text.replace(/=+$/, ""))).toBeNull();
    expect(decodeBase64(text.replaceAll("+", "-"))).toBeNull();
    expect(decodeBase64(`${text.slice(0, 4)} ${text.slice(4)}`)).toBeNull();
    expect(decodeBase64("AB==")).toBeNull();
    expect(decodeBase64("AA==")).toEqual(Uint8Array.of(0));
  });
});
