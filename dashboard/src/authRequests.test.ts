import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APIError,
  getCSRFVersion,
  getSessionEpoch,
  invalidateSession,
  setCSRF,
  type User,
} from "./api";
import {
  authAuthorityUnchanged,
  authUserMatches,
  isDefinitiveAuthRejection,
  isMissingSession,
  normalizeAuthEmail,
  type AuthRequest,
} from "./authRequests";

const user: User = {
  id: "reviewed-account",
  name: "Reviewed account",
  email: "Operator@example.test",
  role: "operator",
  enabled: true,
  revision: 1,
};

describe("authentication account identity", () => {
  it("matches server trimming and ASCII case normalization", () => {
    expect(normalizeAuthEmail(" \tOperator@EXAMPLE.test\n")).toBe(
      "operator@example.test",
    );
    expect(authUserMatches(user, " OPERATOR@example.test ")).toBe(true);
  });

  it("uses Unicode White_Space without erasing a distinct byte-order-mark character", () => {
    expect(normalizeAuthEmail("\u0085Operator@example.test\u0085")).toBe(
      "operator@example.test",
    );
    expect(authUserMatches(user, "\u0085Operator@example.test\u0085")).toBe(
      true,
    );
    expect(normalizeAuthEmail("\ufeffOperator@example.test")).toBe(
      "\ufeffoperator@example.test",
    );
    expect(
      authUserMatches(
        { ...user, email: "\ufeffoperator@example.test" },
        user.email,
      ),
    ).toBe(false);
  });

  it("preserves Unicode case distinctions instead of changing the account", () => {
    const unicode = { ...user, email: "\u0130@example.test" };
    expect(normalizeAuthEmail(unicode.email)).toBe("\u0130@example.test");
    expect(authUserMatches(unicode, "i\u0307@example.test")).toBe(false);
    expect(
      authUserMatches(
        { ...user, email: "\u00c4@example.test" },
        "\u00e4@example.test",
      ),
    ).toBe(false);
  });

  it("does not equate distinct Unicode spellings or different accounts", () => {
    expect(
      authUserMatches(
        { ...user, email: "caf\u00e9@example.test" },
        "cafe\u0301@example.test",
      ),
    ).toBe(false);
    expect(authUserMatches(user, "another@example.test")).toBe(false);
  });

  it("never accepts a disabled account as a recovered sign-in", () => {
    expect(authUserMatches({ ...user, enabled: false }, user.email)).toBe(
      false,
    );
  });
});

describe("authoritative authentication outcomes", () => {
  it("requires an explicit server unauthenticated response to establish no session", () => {
    expect(
      isMissingSession(new APIError("UNAUTHENTICATED", "Sign in", 401, true)),
    ).toBe(true);
    for (const failure of [
      new APIError("UNAUTHENTICATED", "Unconfirmed", 401),
      new APIError("REQUEST_FAILED", "Unconfirmed", 401, true),
      new APIError("UNAUTHENTICATED", "Unconfirmed", 403, true),
      new APIError("SESSION_ENDED", "Local context ended", 0),
      new Error("Unauthorized"),
      { code: "UNAUTHENTICATED", status: 401, serverRejection: true },
    ])
      expect(isMissingSession(failure)).toBe(false);
  });

  it("keeps explicit validation, factor and rate-limit rejections actionable", () => {
    for (const [code, status] of [
      ["INVALID_INPUT", 400],
      ["UNAUTHENTICATED", 401],
      ["FORBIDDEN", 403],
      ["MFA_CHALLENGE_EXPIRED", 409],
      ["INVALID_MFA_CODE", 422],
      ["RATE_LIMITED", 429],
    ] as const) {
      expect(
        isDefinitiveAuthRejection(new APIError(code, "Rejected", status, true)),
      ).toBe(true);
    }
  });

  it("does not turn a request timeout or server failure into a known rejection", () => {
    for (const failure of [
      new APIError("REQUEST_TIMEOUT", "Unknown", 0),
      new APIError("REQUEST_TIMEOUT", "Unknown", 408, true),
      new APIError("INTERNAL_ERROR", "Unknown", 500, true),
      new APIError("REQUEST_FAILED", "Unknown", 503, true),
      new APIError("CONTRACT_MISMATCH", "Unknown", 502),
      new APIError("INVALID_RESPONSE", "Unknown", 200),
      new TypeError("Failed to fetch"),
      new DOMException("Aborted", "AbortError"),
    ])
      expect(isDefinitiveAuthRejection(failure)).toBe(false);
  });

  it("rejects local or unstructured lookalikes even when their status is 4xx", () => {
    expect(
      isDefinitiveAuthRejection(new APIError("UNAUTHENTICATED", "Local", 401)),
    ).toBe(false);
    expect(
      isDefinitiveAuthRejection({
        code: "INVALID_INPUT",
        status: 400,
        serverRejection: true,
      }),
    ).toBe(false);
    expect(isDefinitiveAuthRejection(null)).toBe(false);
    expect(
      isDefinitiveAuthRejection(
        new APIError("UNEXPECTED", "Unknown", 302, true),
      ),
    ).toBe(false);
  });
});

describe("authentication request authority", () => {
  beforeEach(() => setCSRF("synthetic-auth-context"));
  afterEach(() => setCSRF(""));
  function request(): AuthRequest {
    return {
      controller: new AbortController(),
      epoch: getSessionEpoch(),
      csrfVersion: getCSRFVersion(),
    };
  }

  it("accepts an unchanged context, including an unchanged token announcement", () => {
    const original = request();
    setCSRF("synthetic-auth-context");
    expect(authAuthorityUnchanged(original)).toBe(true);
  });

  it("detects credential rotation even when the session epoch stays valid", () => {
    const original = request();
    setCSRF("synthetic-rotated-context");
    expect(getSessionEpoch()).toBe(original.epoch);
    expect(authAuthorityUnchanged(original)).toBe(false);
  });

  it("does not resurrect a held request after invalidation and reauthentication", () => {
    const original = request();
    invalidateSession();
    expect(authAuthorityUnchanged(original)).toBe(false);
    setCSRF("synthetic-auth-context");
    expect(authAuthorityUnchanged(original)).toBe(false);
    expect(authAuthorityUnchanged(request())).toBe(true);
  });
});
