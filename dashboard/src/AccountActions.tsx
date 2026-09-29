import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  api,
  getCSRFToken,
  getCSRFVersion,
  getSessionEpoch,
  isSessionValid,
  SessionSchema,
  setCSRF,
  withRequestDeadline,
  type User,
} from "./api";
import { isDefinitiveAuthRejection } from "./authRequests";
import {
  canUseAccountActionContext,
  matchesPasswordChangeReceipt,
  sameAccountActionContext,
  type AccountActionContext,
} from "./accountActionSession";
import { CurrentPassword, NewPassword } from "./AccountPasswordFields";
import { Button, ErrorBox, Modal } from "./ui";

type Action = "password" | "sessions";
type Review = {
  context: AccountActionContext;
  phase: "form" | "sending" | "unknown" | "changed";
  uncertain: boolean;
  repeat: boolean;
  error: string;
};
type Wait = { action: Action; review: Review; controller: AbortController };

export function AccountActions({
  user,
  notify,
  onUserChanged,
  onChanged,
  onSignIn,
  onReload,
}: {
  user: User;
  notify: (message: string) => void;
  onUserChanged: (user: User | null) => void;
  onChanged: () => void;
  onSignIn: () => void;
  onReload: () => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [reviews, setReviews] = useState<Record<Action, Review | null>>({
    password: null,
    sessions: null,
  });
  const retained = useRef(reviews);
  const visible = useRef<Action | null>(null);
  const active = useRef<Wait | null>(null);
  const currentUser = useRef(user);
  const opener = useRef<HTMLButtonElement | null>(null);
  const recoveryAction = useRef<HTMLButtonElement>(null);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const review = action ? reviews[action] : null;
  const busy = review?.phase === "sending";

  function context(): AccountActionContext {
    return {
      userId: currentUser.current.id,
      enabled: currentUser.current.enabled,
      csrfToken: getCSRFToken(),
      csrfVersion: getCSRFVersion(),
      epoch: getSessionEpoch(),
      valid: isSessionValid(),
    };
  }
  function remember(kind: Action, next: Review | null) {
    retained.current = { ...retained.current, [kind]: next };
    setReviews(retained.current);
  }
  function clearSecrets() {
    setCurrent("");
    setPassword("");
    setConfirm("");
  }
  function retire() {
    const request = active.current;
    if (!request) return;
    active.current = null;
    remember(request.action, {
      ...request.review,
      phase: "unknown",
      uncertain: true,
      error: "",
    });
    request.controller.abort();
    clearSecrets();
  }
  function changed(kind: Action, previous: Review) {
    remember(kind, { ...previous, phase: "changed", error: "" });
    clearSecrets();
  }
  useLayoutEffect(() => {
    currentUser.current = user;
    const request = active.current;
    if (
      request &&
      !canUseAccountActionContext(request.review.context, context())
    ) {
      retire();
      changed(request.action, { ...request.review, uncertain: true });
    } else if (visible.current) {
      const previous = retained.current[visible.current];
      if (previous && !canUseAccountActionContext(previous.context, context()))
        changed(visible.current, previous);
    }
  }, [user]);
  useLayoutEffect(
    () => () => {
      visible.current = null;
      const request = active.current;
      active.current = null;
      request?.controller.abort();
    },
    [],
  );
  useEffect(() => {
    const ended = () => {
      retire();
      const kind = visible.current;
      if (kind && retained.current[kind])
        changed(kind, retained.current[kind]!);
    };
    window.addEventListener("vectory:session-ended", ended);
    return () => window.removeEventListener("vectory:session-ended", ended);
  }, []);
  useEffect(() => {
    if (review?.phase === "unknown" || review?.phase === "changed")
      recoveryAction.current?.focus();
  }, [action, review?.phase]);

  function open(kind: Action, button: HTMLButtonElement) {
    if (active.current) return;
    opener.current = button;
    clearSecrets();
    const previous = retained.current[kind];
    const next: Review = previous || {
      context: context(),
      phase: "form",
      uncertain: false,
      repeat: false,
      error: "",
    };
    remember(
      kind,
      canUseAccountActionContext(next.context, context())
        ? next
        : { ...next, phase: "changed", error: "" },
    );
    visible.current = kind;
    setAction(kind);
  }
  function close() {
    const kind = visible.current;
    visible.current = null;
    retire();
    if (kind) {
      const previous = retained.current[kind];
      if (previous?.phase === "form")
        remember(
          kind,
          previous.uncertain
            ? { ...previous, phase: "unknown", error: "" }
            : null,
        );
    }
    clearSecrets();
    setAction(null);
  }
  function owns(request: Wait) {
    return (
      active.current === request &&
      visible.current === request.action &&
      !request.controller.signal.aborted
    );
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const kind = visible.current;
    if (!kind || active.current) return;
    const original = retained.current[kind];
    if (!original || original.phase !== "form") return;
    if (!canUseAccountActionContext(original.context, context())) {
      changed(kind, original);
      return;
    }
    if (kind === "password" && password !== confirm) {
      remember(kind, { ...original, error: "The new passwords don’t match." });
      return;
    }
    const request: Wait = {
      action: kind,
      review: original,
      controller: new AbortController(),
    };
    active.current = request;
    const body = JSON.stringify({
      current_password: current,
      ...(kind === "password" ? { new_password: password } : {}),
    });
    clearSecrets();
    remember(kind, { ...original, phase: "sending", error: "" });
    try {
      const options = (signal: AbortSignal) => ({
        method: "POST",
        body,
        signal,
        headers: { "X-CSRF-Token": original.context.csrfToken },
      });
      const session =
        kind === "password"
          ? await withRequestDeadline(
              (signal) =>
                api("/account/password", options(signal), SessionSchema),
              30000,
              request.controller.signal,
            )
          : await withRequestDeadline(
              (signal) =>
                api(
                  "/account/revoke-sessions",
                  options(signal),
                  z.object({ ok: z.literal(true) }),
                ),
              30000,
              request.controller.signal,
            ).then(() => null);
      if (!owns(request)) return;
      if (!canUseAccountActionContext(original.context, context())) {
        changed(kind, { ...original, uncertain: true });
        return;
      }
      if (session && !matchesPasswordChangeReceipt(original.context, session)) {
        remember(kind, {
          ...original,
          phase: "unknown",
          uncertain: true,
          error: "The response did not confirm a new session for your account.",
        });
        return;
      }
      active.current = null;
      visible.current = null;
      remember(kind, null);
      setAction(null);
      if (session) {
        setCSRF(session.csrf_token);
        onUserChanged(session.user);
      }
      notify(
        session
          ? "Password changed. Your other browser sessions were signed out."
          : "Your other browser sessions were signed out. This browser is still signed in.",
      );
      onChanged();
    } catch (failure) {
      if (!owns(request)) return;
      if (!canUseAccountActionContext(original.context, context())) {
        changed(kind, { ...original, uncertain: true });
        return;
      }
      remember(
        kind,
        isDefinitiveAuthRejection(failure)
          ? { ...original, phase: "form", error: (failure as Error).message }
          : { ...original, phase: "unknown", uncertain: true, error: "" },
      );
    } finally {
      if (active.current === request) active.current = null;
    }
  }
  function reviewAnother() {
    const previous = retained.current.sessions;
    if (
      visible.current !== "sessions" ||
      !previous ||
      previous.phase !== "unknown" ||
      active.current
    )
      return;
    if (!canUseAccountActionContext(previous.context, context())) {
      changed("sessions", previous);
      return;
    }
    clearSecrets();
    remember("sessions", {
      ...previous,
      phase: "form",
      repeat: true,
      error: "",
    });
  }
  function leave(mode: "signin" | "reload") {
    const kind = visible.current;
    const previous = kind && retained.current[kind];
    if (!kind || !previous || active.current) return;
    if (
      mode === "signin" &&
      !canUseAccountActionContext(previous.context, context())
    ) {
      changed(kind, previous);
      return;
    }
    const before = context();
    if (
      !window.dispatchEvent(
        new Event("vectory:before-navigate", { cancelable: true }),
      )
    )
      return;
    if (!sameAccountActionContext(before, context())) {
      changed(kind, previous);
      return;
    }
    visible.current = null;
    clearSecrets();
    if (mode === "signin") onSignIn();
    else onReload();
  }
  const title =
    review?.phase === "changed"
      ? "Your sign-in changed"
      : review?.phase === "unknown"
        ? action === "password"
          ? "Password change not confirmed"
          : "Session sign-out not confirmed"
        : action === "password"
          ? "Change your password"
          : "Sign out other sessions";
  return (
    <section
      className="control-card account-security-list"
      aria-label="Password and sessions"
    >
      <div className="account-security-row">
        <div>
          <h2>Password</h2>
          <p>Update the password for {user.email}.</p>
          {reviews.password?.uncertain && (
            <p role="status">Password change not confirmed.</p>
          )}
        </div>
        <Button
          variant="secondary"
          onClick={(event) => open("password", event.currentTarget)}
        >
          {reviews.password?.uncertain
            ? "Review password change"
            : "Change password"}
        </Button>
      </div>
      <div className="account-security-row">
        <div>
          <h2>Other browser sessions</h2>
          <p>Sign out other browsers and devices using your account.</p>
          {reviews.sessions?.uncertain && (
            <p role="status">Session sign-out not confirmed.</p>
          )}
        </div>
        <Button
          variant="secondary"
          onClick={(event) => open("sessions", event.currentTarget)}
        >
          {reviews.sessions?.uncertain
            ? "Review session sign-out"
            : "Sign out other sessions"}
        </Button>
      </div>
      <Modal
        open={!!action}
        title={title}
        description={
          review?.phase === "form" || busy
            ? "A successful request keeps this browser signed in and ends your other browser sessions."
            : `Review this request for ${user.email} before continuing.`
        }
        onClose={close}
        returnFocusRef={opener}
        className="account-actions-dialog"
      >
        <form onSubmit={submit}>
          <div className="modal-body">
            {review?.error && <ErrorBox message={review.error} />}
            {busy ? (
              <p role="status">
                {action === "password"
                  ? "Changing your password…"
                  : "Signing out other sessions…"}{" "}
                You can stop waiting. The server may still complete the request.
              </p>
            ) : review?.phase === "changed" ? (
              <p>
                Your sign-in state changed. Reload the workspace to use the
                current account and session.
                {review.uncertain &&
                  " The earlier request may already have completed; reloading does not confirm its outcome."}
              </p>
            ) : review?.phase === "unknown" ? (
              action === "password" ? (
                <>
                  <p>
                    The response did not confirm the change. Your new password
                    may already be in use, or the earlier request may still
                    finish.
                  </p>
                  <p>
                    Go to sign in and try the new password you chose, then
                    complete two-factor verification if enabled. If it does not
                    work, try your previous password or ask an administrator for
                    a reset code.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    The response did not confirm whether your other sessions
                    ended. Checking this browser’s session cannot confirm that
                    result.
                  </p>
                  <p>
                    You can review a new sign-out with your current password. It
                    will also end any other sessions created since the earlier
                    request.
                  </p>
                </>
              )
            ) : (
              <>
                {review?.repeat && (
                  <p className="control-note">
                    This is a new request. It also signs out other sessions
                    created since your earlier attempt. Enter your current
                    password again to continue.
                  </p>
                )}
                <CurrentPassword
                  value={current}
                  onChange={setCurrent}
                  autoFocus
                />
                {action === "password" && (
                  <NewPassword
                    password={password}
                    confirm={confirm}
                    setPassword={setPassword}
                    setConfirm={setConfirm}
                  />
                )}
              </>
            )}
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={close}>
              {busy
                ? "Stop waiting"
                : review?.phase === "form"
                  ? "Cancel"
                  : "Back to account"}
            </Button>
            {review?.phase === "form" && (
              <Button type="submit">
                {action === "password"
                  ? "Change password"
                  : review.repeat
                    ? "Sign out other sessions again"
                    : "Sign out other sessions"}
              </Button>
            )}
            {review?.phase === "unknown" && (
              <Button
                ref={recoveryAction}
                onClick={() =>
                  action === "password" ? leave("signin") : reviewAnother()
                }
              >
                {action === "password"
                  ? "Go to sign in"
                  : "Review another sign-out"}
              </Button>
            )}
            {review?.phase === "changed" && (
              <Button ref={recoveryAction} onClick={() => leave("reload")}>
                Reload workspace
              </Button>
            )}
          </div>
        </form>
      </Modal>
    </section>
  );
}
