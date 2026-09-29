import { describe, expect, it } from "vitest";
import {
  canUseAccountActionContext,
  matchesPasswordChangeReceipt,
  sameAccountActionContext,
  type AccountActionContext,
} from "./accountActionSession";

const original: AccountActionContext = {
  userId: "11111111-1111-4111-8111-111111111111",
  enabled: true,
  csrfToken: "synthetic-original-session",
  csrfVersion: 7,
  epoch: 3,
  valid: true,
};
const receipt = {
  user: { id: original.userId, enabled: true },
  csrf_token: "synthetic-rotated-session",
};

describe("own-account action authority", () => {
  it("permits a mutation only in the unchanged usable context", () => {
    expect(sameAccountActionContext(original, { ...original })).toBe(true);
    expect(canUseAccountActionContext(original, { ...original })).toBe(true);
  });

  it("compares unchanged expired context for guarded departure without permitting a mutation", () => {
    const expired = { ...original, valid: false, epoch: 4 };
    expect(sameAccountActionContext(expired, { ...expired })).toBe(true);
    expect(canUseAccountActionContext(expired, { ...expired })).toBe(false);
    expect(sameAccountActionContext(original, expired)).toBe(false);
    expect(canUseAccountActionContext(original, expired)).toBe(false);
  });

  it("refuses disabled and missing-credential contexts even when both snapshots match", () => {
    for (const unusable of [
      { ...original, enabled: false },
      { ...original, csrfToken: "" },
    ]) {
      expect(sameAccountActionContext(unusable, { ...unusable })).toBe(true);
      expect(canUseAccountActionContext(unusable, { ...unusable })).toBe(false);
    }
    expect(
      canUseAccountActionContext(original, { ...original, enabled: false }),
    ).toBe(false);
  });

  it("rejects another account even if it repeats the original session token", () => {
    const another = {
      ...original,
      userId: "22222222-2222-4222-8222-222222222222",
    };
    expect(sameAccountActionContext(original, another)).toBe(false);
    expect(canUseAccountActionContext(original, another)).toBe(false);
  });

  it("does not revive an old attempt after invalidation and reauthentication", () => {
    const ended = { ...original, valid: false, epoch: 4 };
    const restored = { ...original, epoch: 5 };
    expect(canUseAccountActionContext(original, ended)).toBe(false);
    expect(canUseAccountActionContext(original, restored)).toBe(false);
    expect(sameAccountActionContext(ended, restored)).toBe(false);
    expect(canUseAccountActionContext(restored, { ...restored })).toBe(true);
  });

  it("detects same-account rotation and return to the same token without relying on epoch changes", () => {
    const rotated = {
      ...original,
      csrfToken: "synthetic-intermediate-session",
      csrfVersion: 8,
    };
    const returned = { ...original, csrfVersion: 9 };
    expect(canUseAccountActionContext(original, rotated)).toBe(false);
    expect(sameAccountActionContext(original, returned)).toBe(false);
    expect(canUseAccountActionContext(original, returned)).toBe(false);
  });

  it("does not equate different opaque identifiers by trimming or case folding", () => {
    for (const current of [
      { ...original, userId: ` ${original.userId}` },
      { ...original, csrfToken: `${original.csrfToken} ` },
      { ...original, csrfToken: original.csrfToken.toUpperCase() },
    ]) {
      expect(sameAccountActionContext(original, current)).toBe(false);
      expect(canUseAccountActionContext(original, current)).toBe(false);
    }
  });

  it("allows compatible role metadata without weakening session checks", () => {
    // Every signed-in role can manage its own account. A real role edit can
    // revoke the session; the invalidation/epoch cases above still reject it.
    const before = { ...original, role: "admin", name: "Earlier name" };
    const current = { ...original, role: "viewer", name: "Updated name" };
    expect(sameAccountActionContext(before, current)).toBe(true);
    expect(canUseAccountActionContext(before, current)).toBe(true);
  });
});

describe("password rotation receipt", () => {
  it("accepts an enabled same-account new session without attributing revision arithmetic", () => {
    const result = {
      ...receipt,
      user: {
        ...receipt.user,
        name: "Concurrently updated name",
        role: "viewer",
        revision: 93,
      },
    };
    expect(matchesPasswordChangeReceipt(original, result)).toBe(true);
  });

  it("rejects an echoed old session or a missing new credential", () => {
    for (const csrf_token of [original.csrfToken, ""])
      expect(
        matchesPasswordChangeReceipt(original, { ...receipt, csrf_token }),
      ).toBe(false);
  });

  it("rejects disabled or different-account receipts despite a rotated credential", () => {
    for (const user of [
      { ...receipt.user, enabled: false },
      { ...receipt.user, id: "22222222-2222-4222-8222-222222222222" },
      { ...receipt.user, id: `${original.userId} ` },
    ])
      expect(matchesPasswordChangeReceipt(original, { ...receipt, user })).toBe(
        false,
      );
  });

  it("does not let a matching receipt authorize adoption after local authority has changed", () => {
    expect(matchesPasswordChangeReceipt(original, receipt)).toBe(true);
    const newer = {
      ...original,
      csrfToken: "synthetic-other-sign-in",
      csrfVersion: 8,
    };
    // The controller must require both predicates before publishing setCSRF.
    expect(canUseAccountActionContext(original, newer)).toBe(false);
  });
});
