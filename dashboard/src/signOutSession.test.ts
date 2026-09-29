import { describe, expect, it } from "vitest";
import {
  matchesSignOutContext,
  matchesSignOutSession,
  type SignOutContext,
  type SignOutIntent,
} from "./signOutSession";

const intent: SignOutIntent = {
  userId: "11111111-1111-4111-8111-111111111111",
  csrfToken: "synthetic-original-csrf",
  csrfVersion: 7,
  epoch: 3,
};
const context: SignOutContext = {
  ...intent,
  enabled: true,
  valid: true,
};
const session = {
  user: { id: intent.userId, enabled: true },
  csrf_token: intent.csrfToken,
};

describe("original sign-out session binding", () => {
  it("accepts the unchanged enabled local context and exact current-session snapshot", () => {
    expect(matchesSignOutContext(intent, context)).toBe(true);
    expect(matchesSignOutSession(intent, session)).toBe(true);
  });

  it("rejects another sign-in by the same account even if other metadata matches", () => {
    expect(
      matchesSignOutSession(intent, {
        ...session,
        csrf_token: "synthetic-new-sign-in",
      }),
    ).toBe(false);
    expect(
      matchesSignOutContext(intent, {
        ...context,
        csrfToken: "synthetic-new-sign-in",
      }),
    ).toBe(false);
  });

  it("rejects a different account even when a response repeats the original CSRF", () => {
    const userId = "22222222-2222-4222-8222-222222222222";
    expect(matchesSignOutContext(intent, { ...context, userId })).toBe(false);
    expect(
      matchesSignOutSession(intent, {
        ...session,
        user: { ...session.user, id: userId },
      }),
    ).toBe(false);
  });

  it("does not revive an old intent after session invalidation and restoration", () => {
    expect(
      matchesSignOutContext(intent, { ...context, valid: false, epoch: 4 }),
    ).toBe(false);
    expect(matchesSignOutContext(intent, { ...context, epoch: 5 })).toBe(false);
    const renewed = { ...intent, epoch: 5 };
    expect(matchesSignOutContext(renewed, { ...context, epoch: 5 })).toBe(true);
  });

  it("rejects local CSRF rotation and return to the same value", () => {
    expect(
      matchesSignOutContext(intent, {
        ...context,
        csrfToken: "synthetic-intermediate",
        csrfVersion: 8,
      }),
    ).toBe(false);
    expect(matchesSignOutContext(intent, { ...context, csrfVersion: 9 })).toBe(
      false,
    );
  });

  it("requires a nonempty original CSRF instead of accepting two missing values", () => {
    const missing = { ...intent, csrfToken: "" };
    expect(matchesSignOutContext(missing, { ...context, csrfToken: "" })).toBe(
      false,
    );
    expect(matchesSignOutSession(missing, { ...session, csrf_token: "" })).toBe(
      false,
    );
  });

  it("refuses a disabled account or locally invalid session", () => {
    expect(matchesSignOutContext(intent, { ...context, enabled: false })).toBe(
      false,
    );
    expect(matchesSignOutContext(intent, { ...context, valid: false })).toBe(
      false,
    );
    expect(
      matchesSignOutSession(intent, {
        ...session,
        user: { ...session.user, enabled: false },
      }),
    ).toBe(false);
  });

  it("keeps sign-out available across role-label changes while the same session remains valid", () => {
    // This models compatible local metadata only. Native role changes can revoke
    // the session; the invalid/epoch cases above reject that changed authority.
    const previous = { ...context, role: "admin" };
    const current = { ...context, role: "viewer" };
    expect(matchesSignOutContext(intent, previous)).toBe(true);
    expect(matchesSignOutContext(intent, current)).toBe(true);
  });

  it("does not let a matching status snapshot override a changed local context", () => {
    expect(matchesSignOutSession(intent, session)).toBe(true);
    expect(matchesSignOutContext(intent, { ...context, csrfVersion: 8 })).toBe(
      false,
    );
  });

  it("compares opaque identity and CSRF fields without trimming or case folding", () => {
    for (const csrf_token of [
      ` ${intent.csrfToken}`,
      `${intent.csrfToken} `,
      intent.csrfToken.toUpperCase(),
    ]) {
      expect(matchesSignOutSession(intent, { ...session, csrf_token })).toBe(
        false,
      );
    }
    expect(
      matchesSignOutSession(intent, {
        ...session,
        user: { ...session.user, id: ` ${intent.userId}` },
      }),
    ).toBe(false);
  });
});
