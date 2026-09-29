import { describe, expect, it } from "vitest";
import {
  generatePassword,
  passwordIssue,
  passwordStrength,
} from "./passwordStrength";

const identity = ["jane@example.test", "Jane Doe"];

describe("password floor mirrors the server", () => {
  it("rejects short, common, patterned and identity passwords", () => {
    for (const password of [
      "short-one",
      "password1234",
      "Password 1234",
      "aaaaaaaaaaaa",
      "abababababab",
      "abcabcabcabc",
      "abcdefghijklm",
      "987654321098",
      "qwertyuiopas",
      "jane@example.test",
      "janedoe12345",
      "jane doe 2026!",
    ])
      expect(passwordIssue(password, identity), password).not.toBeNull();
    expect(passwordIssue("é".repeat(129))).toBe("Use at most 256 characters.");
  });
  it("accepts ordinary strong choices, including a phrase with the name", () => {
    for (const password of [
      "correct horse battery",
      "original-test-password",
      "Tidal-Lantern-42-Orbit",
      "janedoe hikes often",
    ])
      expect(passwordIssue(password, identity), password).toBeNull();
  });
});

describe("strength meter", () => {
  it("labels each band and marks what the server accepts", () => {
    expect(passwordStrength("")).toMatchObject({ score: 0, acceptable: false });
    expect(passwordStrength("short")).toMatchObject({
      score: 0,
      label: "Too short",
    });
    expect(passwordStrength("password1234")).toMatchObject({
      score: 1,
      label: "Easy to guess",
      acceptable: false,
    });
    expect(passwordStrength("hikingboots1")).toMatchObject({
      score: 3,
      acceptable: true,
    });
    expect(passwordStrength("tidal lantern orbit ferry")).toMatchObject({
      score: 4,
      label: "Strong",
    });
    expect(passwordStrength("zzzzzzzzzzzy").acceptable).toBe(true);
    expect(passwordStrength("zzzzzzzzzzzy").score).toBe(2);
  });
});

describe("generated passwords", () => {
  it("are grouped, unambiguous and strong", () => {
    const generated = generatePassword();
    expect(generated).toMatch(/^([a-zA-Z2-9]{5}-){3}[a-zA-Z2-9]{5}$/);
    expect(generated).not.toMatch(/[01lIoO]/);
    expect(passwordStrength(generated).score).toBe(4);
  });
  it("rejects biased bytes instead of wrapping them", () => {
    let calls = 0;
    const value = generatePassword((bytes) => {
      calls++;
      bytes.fill(calls === 1 ? 255 : 0);
      return bytes;
    });
    expect(calls).toBe(2);
    expect(value).toBe("aaaaa-aaaaa-aaaaa-aaaaa");
  });
});
