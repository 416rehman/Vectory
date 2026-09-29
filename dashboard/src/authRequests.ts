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
