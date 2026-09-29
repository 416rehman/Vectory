import { afterEach, describe, expect, it, vi } from "vitest";
import { APIError, api, isSessionInterruption, setCSRF } from "./api";
import {
  isRequestAlreadyUsed,
  isUncertainOutcome,
  noteSignedOut,
  retryDelay,
  signedOutRecently,
} from "./authRequests";
import {
  formatAgo,
  formatCountdown,
  formatExpiry,
  formatRemaining,
} from "./authControls";
import { setupCommand } from "./AuthScreen";

afterEach(() => {
  vi.unstubAllGlobals();
  setCSRF("");
});

const rejection = (code: string, status: number) =>
  new APIError(code, "message", status, true);

describe("which failures are uncertain", () => {
  it("routes only transport failures and reused request identities to review", () => {
    expect(isUncertainOutcome(new TypeError("Failed to fetch"))).toBe(true);
    expect(isUncertainOutcome(new APIError("REQUEST_TIMEOUT", "slow", 0))).toBe(
      true,
    );
    expect(isUncertainOutcome(rejection("INTERNAL", 500))).toBe(true);
    expect(isUncertainOutcome(rejection("TIMEOUT", 408))).toBe(true);
    expect(isUncertainOutcome(rejection("REQUEST_ALREADY_USED", 409))).toBe(
      true,
    );
    for (const [code, status] of [
      ["EMAIL_TAKEN", 409],
      ["STALE_REVISION", 409],
      ["LAST_ADMIN", 409],
      ["MFA_SETUP_EXPIRED", 409],
      ["WRONG_PASSWORD", 403],
      ["PASSWORD_TOO_WEAK", 400],
      ["SIGNIN_THROTTLED", 429],
    ] as const)
      expect(isUncertainOutcome(rejection(code, status)), code).toBe(false);
    expect(isRequestAlreadyUsed(rejection("REQUEST_ALREADY_USED", 409))).toBe(
      true,
    );
  });
  it("reads the throttle wait from Retry-After", () => {
    expect(
      retryDelay(new APIError("SIGNIN_THROTTLED", "m", 429, true, 252)),
    ).toBe(252);
    expect(retryDelay(rejection("RATE_LIMITED", 429))).toBe(60);
    expect(retryDelay(rejection("EMAIL_TAKEN", 409))).toBe(0);
  });
});

describe("api error details", () => {
  it("keeps Retry-After and the session-ending reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.endsWith("/login")
          ? new Response(
              JSON.stringify({
                error: { code: "SIGNIN_THROTTLED", message: "Wait" },
              }),
              { status: 429, headers: { "retry-after": "185" } },
            )
          : new Response(
              JSON.stringify({
                error: {
                  code: "UNAUTHENTICATED",
                  message: "Your session expired.",
                  reason: "expired",
                },
              }),
              { status: 401 },
            ),
      ),
    );
    await expect(
      api("/login", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ code: "SIGNIN_THROTTLED", retryAfter: 185 });
    const ended = await api("/session").catch((error) => error);
    expect(ended).toMatchObject({ status: 401, reason: "expired" });
    expect(isSessionInterruption(ended)).toBe(true);
    expect(isSessionInterruption(new APIError("SESSION_ENDED", "m", 0))).toBe(
      true,
    );
    expect(isSessionInterruption(rejection("FORBIDDEN", 403))).toBe(false);
  });
});

describe("cross-tab sign-out note", () => {
  it("is recent for ten minutes and never fails without storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    expect(signedOutRecently()).toBe(false);
    noteSignedOut();
    expect(signedOutRecently()).toBe(true);
    expect(signedOutRecently(Date.now() + 11 * 60 * 1000)).toBe(false);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => noteSignedOut()).not.toThrow();
    expect(signedOutRecently()).toBe(false);
  });
});

describe("time formatting", () => {
  it("formats countdowns, expiries and remaining time", () => {
    expect(formatCountdown(252)).toBe("4:12");
    expect(formatCountdown(9)).toBe("0:09");
    const now = new Date(2026, 8, 29, 9, 0);
    expect(
      formatExpiry(new Date(2026, 8, 29, 15, 15).toISOString(), now),
    ).toMatch(/3:15/);
    expect(
      formatExpiry(new Date(2026, 8, 30, 15, 15).toISOString(), now),
    ).toMatch(/^tomorrow at /);
    expect(formatExpiry("not a date", now)).toBe("");
    const base = Date.parse("2026-09-29T00:00:00Z");
    expect(formatRemaining("2026-09-29T23:00:00Z", base)).toBe("in 23 h");
    expect(formatRemaining("2026-09-29T00:45:00Z", base)).toBe("in 45 min");
    expect(formatRemaining("2026-09-28T23:00:00Z", base)).toBe("expired");
    expect(formatRemaining(null, base)).toBe("");
  });
  it("says how long ago someone signed in, and Never without a time", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(formatAgo("2026-09-29T11:59:40Z", now)).toBe("just now");
    expect(formatAgo("2026-09-29T11:55:00Z", now)).toBe("5 min ago");
    expect(formatAgo("2026-09-29T09:00:00Z", now)).toBe("3 h ago");
    expect(formatAgo("2026-09-28T11:00:00Z", now)).toBe("1 day ago");
    expect(formatAgo("2026-09-26T12:00:00Z", now)).toBe("3 days ago");
    expect(formatAgo("2026-08-01T12:00:00Z", now)).toMatch(/Aug/);
    expect(formatAgo("2025-08-01T12:00:00Z", now)).toMatch(/2025/);
    // A clock slightly ahead of this browser still reads as recent.
    expect(formatAgo("2026-09-29T12:00:30Z", now)).toBe("just now");
    expect(formatAgo(null, now)).toBe("Never");
    expect(formatAgo("not a date", now)).toBe("Never");
  });
});

describe("setup secret command", () => {
  it("prints a read command for the file, never a value", () => {
    expect(
      setupCommand({
        source: "file",
        variable: "VECTORY_BOOTSTRAP_SECRET_FILE",
        container: true,
        path: "/run/secrets/bootstrap",
      })?.command,
    ).toBe("docker compose exec server cat /run/secrets/bootstrap");
    expect(
      setupCommand({
        source: "file",
        variable: "VECTORY_BOOTSTRAP_SECRET_FILE",
        container: false,
        path: "/srv/vectory/bootstrap",
      })?.command,
    ).toBe("sudo cat /srv/vectory/bootstrap");
    expect(
      setupCommand({
        source: "file",
        variable: "VECTORY_BOOTSTRAP_SECRET_FILE",
        container: false,
        path: "C:\\ProgramData\\Vectory\\bootstrap",
      })?.command,
    ).toBe('Get-Content "C:\\ProgramData\\Vectory\\bootstrap"');
    expect(
      setupCommand({
        source: "environment",
        variable: "VECTORY_BOOTSTRAP_SECRET",
        container: false,
        path: null,
      }),
    ).toBeNull();
    expect(setupCommand(undefined)).toBeNull();
  });
});
