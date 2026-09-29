import { useLayoutEffect, useRef } from "react";
import { APIError, getCSRFVersion, getSessionEpoch, type User } from "./api";

export type AuthRequest = {
  controller: AbortController;
  epoch: number;
  csrfVersion: number;
};

/** A synchronous claim also blocks two submits before React rerenders. */
export function useAuthRequest() {
  const active = useRef<AuthRequest | null>(null);
  useLayoutEffect(
    () => () => {
      active.current?.controller.abort();
      active.current = null;
    },
    [],
  );
  return {
    claim() {
      if (active.current) return null;
      const request = {
        controller: new AbortController(),
        epoch: getSessionEpoch(),
        csrfVersion: getCSRFVersion(),
      };
      active.current = request;
      return request;
    },
    current(request: AuthRequest) {
      return active.current === request && !request.controller.signal.aborted;
    },
    finish(request: AuthRequest) {
      if (active.current !== request) return false;
      active.current = null;
      return true;
    },
  };
}

export function authAuthorityUnchanged(request: AuthRequest) {
  return (
    request.epoch === getSessionEpoch() &&
    request.csrfVersion === getCSRFVersion()
  );
}

export function normalizeAuthEmail(email: string) {
  // The server normalizes ASCII only; Unicode case folding changes identities.
  return email
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function authUserMatches(user: User, email: string) {
  return (
    user.enabled && normalizeAuthEmail(user.email) === normalizeAuthEmail(email)
  );
}

export function isMissingSession(error: unknown) {
  return (
    error instanceof APIError &&
    error.serverRejection &&
    error.status === 401 &&
    error.code === "UNAUTHENTICATED"
  );
}

export function isDefinitiveAuthRejection(error: unknown) {
  return (
    error instanceof APIError &&
    error.serverRejection &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408
  );
}

/** The server says this exact request identity already finished: read its status. */
export function isRequestAlreadyUsed(error: unknown) {
  return error instanceof APIError && error.code === "REQUEST_ALREADY_USED";
}

/**
 * Whether a failed request may still have taken effect: transport failures,
 * timeouts, unreadable or 5xx responses, and reused request identities. Every
 * other rejection is definitive and belongs next to the form.
 */
export function isUncertainOutcome(error: unknown) {
  return !isDefinitiveAuthRejection(error) || isRequestAlreadyUsed(error);
}

/** Seconds to wait after a 429, from Retry-After, defaulting to a minute. */
export function retryDelay(error: unknown) {
  return error instanceof APIError && error.status === 429
    ? error.retryAfter || 60
    : 0;
}

let lastSignInEmail = "";
/**
 * The account this tab last left, so the sign-in page can offer it again.
 * Kept in memory only: a reload or another person's session starts empty.
 */
export function rememberSignInEmail(email: string) {
  lastSignInEmail = email;
}
export function rememberedSignInEmail() {
  return lastSignInEmail;
}

const SIGNED_OUT_KEY = "vectory-signed-out";
/**
 * Leave a nonsecret timestamp when this browser signs out. Signing out deletes
 * the shared cookie, so other tabs can't ask the server why their session ended.
 */
export function noteSignedOut() {
  try {
    localStorage.setItem(SIGNED_OUT_KEY, String(Date.now()));
  } catch {
    /* Other tabs fall back to the generic explanation. */
  }
}
export function signedOutRecently(now = Date.now()) {
  try {
    const at = Number(localStorage.getItem(SIGNED_OUT_KEY));
    return at > 0 && now - at >= 0 && now - at < 10 * 60 * 1000;
  } catch {
    return false;
  }
}
