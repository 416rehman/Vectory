import { describe, expect, it } from "vitest";
import {
  assertResetStatusIdentity,
  markCurrentHeldLinksDoubt,
  type HeldLink,
} from "./AdminPasswordResetActions";

const request = {
  id: "11111111-1111-4111-8111-111111111111",
  target: { id: "22222222-2222-4222-8222-222222222222" },
};

describe("administrator reset-link status identity", () => {
  it("accepts only a status for the exact issue and account", () => {
    expect(() =>
      assertResetStatusIdentity(
        { request_id: request.id, user_id: request.target.id },
        request,
      ),
    ).not.toThrow();
    expect(() =>
      assertResetStatusIdentity(
        {
          request_id: "33333333-3333-4333-8333-333333333333",
          user_id: request.target.id,
        },
        request,
      ),
    ).toThrow("different request");
    expect(() =>
      assertResetStatusIdentity(
        {
          request_id: request.id,
          user_id: "44444444-4444-4444-8444-444444444444",
        },
        request,
      ),
    ).toThrow("different request");
  });
});

describe("held link ownership after an acting sign-in changes", () => {
  const link: HeldLink = {
    userId: request.target.id,
    name: "Alex",
    email: "alex@example.test",
    code: "a".repeat(64),
    purpose: "reset",
    expiresAt: "2026-10-06T00:00:00Z",
    owner: {
      userId: "33333333-3333-4333-8333-333333333333",
      role: "admin",
      enabled: true,
      csrfToken: "old",
      csrfVersion: 1,
      epoch: 1,
      valid: true,
    },
    requestId: request.id,
    verifiedRevision: 2,
    doubt: "",
  };

  it("never restores a link that a new sign-in cleared", () => {
    const cleared = {};
    expect(
      markCurrentHeldLinksDoubt(cleared, {
        [link.userId]: { ...link, doubt: "The account changed." },
      }),
    ).toBe(cleared);
  });

  it("cannot mark or replace a different link now held for the same person", () => {
    const newLink = { ...link, code: "b".repeat(64) };
    const current = { [link.userId]: newLink };
    expect(
      markCurrentHeldLinksDoubt(current, {
        [link.userId]: { ...link, doubt: "The account changed." },
      }),
    ).toBe(current);
  });

  it("marks only the same currently held link for a fresh check", () => {
    const current = { [link.userId]: link };
    expect(
      markCurrentHeldLinksDoubt(current, {
        [link.userId]: { ...link, doubt: "The account changed." },
      })[link.userId].doubt,
    ).toBe("The account changed.");
  });
});
