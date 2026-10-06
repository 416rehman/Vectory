import { useEffect, useLayoutEffect, useRef } from "react";
import {
  getCSRFToken,
  getCSRFVersion,
  getSessionEpoch,
  isSessionValid,
  type User,
} from "./api";
import {
  canUseAccountActionContext,
  sameAccountActionContext,
  type AccountActionContext,
} from "./accountActionSession";

export type AccountContext = AccountActionContext & { role: User["role"] };

/**
 * This browser's sign-in authority for account actions. `context()` takes a
 * snapshot when a request starts; `usable(original)` says whether its result
 * may still be adopted; `onChange` runs when the account, its role, the
 * session or the CSRF token changes, so pages can drop secrets and pending
 * reviews that belong to the earlier sign-in.
 */
export function useAccountAuthority(user: User, onChange: () => void) {
  const current = useRef(user);
  const owner = useRef<AccountContext | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  function context(): AccountContext {
    return {
      userId: current.current.id,
      role: current.current.role,
      enabled: current.current.enabled,
      csrfToken: getCSRFToken(),
      csrfVersion: getCSRFVersion(),
      epoch: getSessionEpoch(),
      valid: isSessionValid(),
    };
  }
  function check() {
    const now = context();
    const before = owner.current;
    owner.current = now;
    if (
      before &&
      (before.role !== now.role || !sameAccountActionContext(before, now))
    )
      changed.current();
  }
  useLayoutEffect(() => {
    current.current = user;
    check();
  }, [user]);
  useEffect(() => {
    window.addEventListener("vectory:session-ended", check);
    window.addEventListener("vectory:session-changed", check);
    return () => {
      window.removeEventListener("vectory:session-ended", check);
      window.removeEventListener("vectory:session-changed", check);
    };
  }, []);
  return {
    context,
    /** The original sign-in is still current, usable and (optionally) an admin. */
    usable(original: AccountContext, admin = false) {
      const now = context();
      return (
        (!admin || (original.role === "admin" && now.role === "admin")) &&
        original.role === now.role &&
        canUseAccountActionContext(original, now)
      );
    },
  };
}

/**
 * Ask before leaving while `message` describes something only this page holds.
 * Navigation inside the app and closing the tab both ask.
 */
export function useLeaveGuard(message: string | null) {
  useEffect(() => {
    if (!message) return;
    const leave = (event: Event) => {
      if (!window.confirm(message)) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("vectory:before-navigate", leave);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("vectory:before-navigate", leave);
      window.removeEventListener("beforeunload", unload);
    };
  }, [message]);
}
