import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Monitor, Smartphone, SquareTerminal } from "lucide-react";
import { z } from "zod";
import {
  APIError,
  api,
  getCSRFToken,
  getCSRFVersion,
  getSessionEpoch,
  isSessionValid,
  SessionSchema,
  setCSRF,
  withRequestDeadline,
  type SessionSummary,
  type User,
} from "./api";
import { isUncertainOutcome, retryDelay } from "./authRequests";
import {
  canUseAccountActionContext,
  matchesPasswordChangeReceipt,
  sameAccountActionContext,
  type AccountActionContext,
} from "./accountActionSession";
import {
  PasswordField,
  Unconfirmed,
  formatAgo,
  formatExpiry,
} from "./authControls";
import { passwordIssue } from "./passwordStrength";
import { describeAgent } from "./userAgent";
import { Button, Modal, Spinner, useResource } from "./ui";
import "./account.css";

type Action = "password" | "sessions";
type Fields = Partial<Record<"current" | "next" | "confirm" | "form", string>>;
type Review = {
  context: AccountActionContext;
  phase: "form" | "sending" | "unknown" | "changed";
  /** The last request's outcome was never confirmed. */
  uncertain: boolean;
  /** A new sign-out request after an unconfirmed one. */
  repeat: boolean;
  fields: Fields;
};
type Wait = { action: Action; review: Review; controller: AbortController };

/**
 * Password and browser sessions for the signed-in account. Rows render through
 * `children` so the page can place two-factor authentication between them.
 */
export function AccountActions({
  user,
  notify,
  onUserChanged,
  onChanged,
  onSignIn,
  onReload,
  refresh = 0,
  children,
}: {
  user: User;
  notify: (message: string) => void;
  onUserChanged: (user: User | null) => void;
  onChanged: () => void;
  onSignIn: () => void;
  onReload: () => void;
  /** Changes when something else ended sessions, such as a two-factor change. */
  refresh?: number;
  children: (rows: { password: ReactNode; sessions: ReactNode }) => ReactNode;
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
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revealed, setRevealed] = useState(false);
  const sessions = useResource<{ sessions: SessionSummary[] }>(
    "/account/sessions",
    { sessions: [] },
    refresh,
  );
  const [revoking, setRevoking] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [allSessions, setAllSessions] = useState(false);
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
  function remember(kind: Action, value: Review | null) {
    retained.current = { ...retained.current, [kind]: value };
    setReviews(retained.current);
  }
  function clearSecrets() {
    setCurrent("");
    setNext("");
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
      fields: {},
    });
    request.controller.abort();
    clearSecrets();
  }
  function changed(kind: Action, previous: Review) {
    remember(kind, { ...previous, phase: "changed", fields: {} });
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
    setRevealed(false);
    const previous = retained.current[kind];
    const nextReview: Review = previous || {
      context: context(),
      phase: "form",
      uncertain: false,
      repeat: false,
      fields: {},
    };
    remember(
      kind,
      canUseAccountActionContext(nextReview.context, context())
        ? nextReview
        : { ...nextReview, phase: "changed", fields: {} },
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
      // A closed form is forgotten unless its last request is unconfirmed.
      if (previous?.phase === "form")
        remember(
          kind,
          previous.uncertain
            ? { ...previous, phase: "unknown", fields: {} }
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
  function validate(kind: Action): Fields {
    if (!current) return { current: "Enter your current password." };
    if (kind === "sessions") return {};
    const weak = passwordIssue(next, [user.email, user.name]);
    if (weak) return { next: weak };
    if (next === current)
      return {
        next: "Choose a password that's different from your current one.",
      };
    if (next !== confirm) return { confirm: "The passwords don't match." };
    return {};
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
    const problems = validate(kind);
    if (Object.keys(problems).length) {
      remember(kind, { ...original, fields: problems });
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
      ...(kind === "password" ? { new_password: next } : {}),
    });
    // Submitted passwords are never kept for a replay.
    clearSecrets();
    remember(kind, { ...original, phase: "sending", fields: {} });
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
          fields: {},
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
          ? "Password changed. Other browsers were signed out."
          : "Signed out of every other browser. This one stays signed in.",
      );
      void sessions.reload();
      onChanged();
    } catch (failure) {
      if (!owns(request)) return;
      if (!canUseAccountActionContext(original.context, context())) {
        changed(kind, { ...original, uncertain: true });
        return;
      }
      if (isUncertainOutcome(failure)) {
        if (kind === "sessions") {
          // The list shows the result either way; nothing is resent.
          const list = await sessions.reloadResult();
          if (!owns(request)) return;
          if (list && list.sessions.every((session) => session.current)) {
            active.current = null;
            visible.current = null;
            remember(kind, null);
            setAction(null);
            notify(
              "Signed out of every other browser. This one stays signed in.",
            );
            return;
          }
        }
        remember(kind, {
          ...original,
          phase: "unknown",
          uncertain: true,
          fields: {},
        });
        return;
      }
      const code = failure instanceof APIError ? failure.code : "";
      const wait = retryDelay(failure);
      remember(kind, {
        ...original,
        phase: "form",
        fields:
          code === "WRONG_PASSWORD"
            ? {
                current:
                  "Your current password didn't match. For your security, enter your passwords again.",
              }
            : code === "PASSWORD_TOO_WEAK" || code === "PASSWORD_UNCHANGED"
              ? { next: (failure as Error).message }
              : {
                  form: wait
                    ? `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`
                    : (failure as Error).message,
                },
      });
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
      fields: {},
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
  async function revokeOne(session: SessionSummary) {
    if (revoking) return;
    const label = describeAgent(session.user_agent).label;
    setRevoking(session.id);
    setRowErrors((errors) => ({ ...errors, [session.id]: "" }));
    try {
      await withRequestDeadline(
        (signal) =>
          api(
            `/account/sessions/${session.id}/revoke`,
            { method: "POST", body: "{}", signal },
            z.object({ ok: z.literal(true) }),
          ),
        30000,
      );
      notify(`Signed out ${label}.`);
    } catch (failure) {
      if (failure instanceof APIError && failure.code === "SESSION_NOT_FOUND")
        notify(`${label} was already signed out.`);
      else if (isUncertainOutcome(failure)) {
        const list = await sessions.reloadResult();
        if (list && !list.sessions.some((entry) => entry.id === session.id))
          notify(`Signed out ${label}.`);
        else
          setRowErrors((errors) => ({
            ...errors,
            [session.id]: "We couldn't confirm that. Try again.",
          }));
      } else
        setRowErrors((errors) => ({
          ...errors,
          [session.id]: (failure as Error).message,
        }));
    } finally {
      setRevoking(null);
      void sessions.reload();
    }
  }

  const list = sessions.data.sessions;
  const others = list.filter((session) => !session.current).length;
  const shown = allSessions ? list : list.slice(0, 5);
  const title =
    review?.phase === "changed"
      ? "Your sign-in changed"
      : review?.phase === "unknown"
        ? action === "password"
          ? "We couldn't confirm your password change"
          : "We couldn't confirm the sign-out"
        : action === "password"
          ? "Change your password"
          : "Sign out other sessions";
  const password = (
    <div className="account-row">
      <div className="account-row-copy">
        <h3>Password</h3>
        <p>Changing it signs out your other browsers.</p>
        {reviews.password?.uncertain && (
          <p className="account-row-warning" role="status">
            We couldn't confirm your last password change.
          </p>
        )}
      </div>
      <div className="account-row-actions">
        <Button
          variant="secondary"
          onClick={(event) => open("password", event.currentTarget)}
        >
          {reviews.password?.uncertain ? "Review" : "Change password"}
        </Button>
      </div>
    </div>
  );
  const sessionRows = (
    <div className="account-sessions">
      <div className="account-sessions-head">
        <div>
          <h3>Sessions</h3>
          <p>Where you're signed in. Each sign-in lasts 12 hours.</p>
          {reviews.sessions?.uncertain && (
            <p className="account-row-warning" role="status">
              We couldn't confirm your last sign-out of other sessions.
            </p>
          )}
        </div>
        {(others > 0 || reviews.sessions) && (
          <Button
            variant="secondary"
            onClick={(event) => open("sessions", event.currentTarget)}
          >
            {reviews.sessions?.uncertain ? "Review" : "Sign out other sessions"}
          </Button>
        )}
      </div>
      <ul className="session-list" aria-label="Your sessions">
        {sessions.loading && !list.length ? (
          <li className="quiet-state">
            <Spinner /> Loading sessions…
          </li>
        ) : sessions.error && !list.length ? (
          <li className="quiet-state">{sessions.error}</li>
        ) : (
          shown.map((session) => {
            const agent = describeAgent(session.user_agent);
            const Icon =
              agent.kind === "mobile"
                ? Smartphone
                : agent.kind === "tool"
                  ? SquareTerminal
                  : Monitor;
            return (
              <li key={session.id}>
                <span className="session-icon" aria-hidden="true">
                  <Icon size={17} />
                </span>
                <span className="session-copy">
                  <strong>
                    {agent.label}
                    {session.current && (
                      <span className="this-browser">This browser</span>
                    )}
                  </strong>
                  <span>
                    {[
                      session.current
                        ? `Signed in until ${formatExpiry(session.expires_at)}`
                        : session.last_seen_at
                          ? `Active ${formatAgo(session.last_seen_at)}`
                          : null,
                      session.client_address &&
                      session.client_address !== "unknown"
                        ? session.client_address
                        : null,
                      !session.current && session.created_at
                        ? `signed in ${formatAgo(session.created_at)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {rowErrors[session.id] && (
                    <span className="account-row-warning" role="status">
                      {rowErrors[session.id]}
                    </span>
                  )}
                </span>
                {!session.current && (
                  <Button
                    variant="ghost compact"
                    busy={revoking === session.id}
                    disabled={!!revoking}
                    aria-label={`Sign out ${agent.label}${session.last_seen_at ? `, active ${formatAgo(session.last_seen_at)}` : ""}`}
                    onClick={() => void revokeOne(session)}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            );
          })
        )}
      </ul>
      {list.length > shown.length && (
        <button
          type="button"
          className="text-link session-more"
          onClick={() => setAllSessions(true)}
        >
          Show {list.length - shown.length} more
        </button>
      )}
    </div>
  );
  const form = review?.phase === "form";
  return (
    <>
      {children({ password, sessions: sessionRows })}
      <Modal
        open={!!action}
        title={title}
        description={
          review?.phase === "form"
            ? action === "password"
              ? "You'll stay signed in here. Other browsers are signed out."
              : "Every other browser signed in to your account is signed out. This one stays signed in."
            : undefined
        }
        onClose={close}
        returnFocusRef={opener}
        className="account-actions-dialog"
      >
        <form onSubmit={submit} noValidate>
          <div className="modal-body">
            {busy ? (
              <p className="signin-loading" role="status">
                <Spinner />
                {action === "password"
                  ? "Changing your password…"
                  : "Signing out other sessions…"}
              </p>
            ) : review?.phase === "changed" ? (
              <p>
                This browser's sign-in changed. Reload to continue with the
                current account.
              </p>
            ) : review?.phase === "unknown" ? (
              action === "password" ? (
                <Unconfirmed title="Your new password may already be active">
                  <p>
                    Sign in with your new password to be sure. If it doesn't
                    work, use your previous password.
                  </p>
                </Unconfirmed>
              ) : (
                <Unconfirmed title="Some sessions may still be signed in">
                  <p>
                    Try again with your current password. It also signs out
                    sessions started since your last try.
                  </p>
                </Unconfirmed>
              )
            ) : (
              <>
                {review?.fields.form && (
                  <p className="signin-alert" role="alert">
                    {review.fields.form}
                  </p>
                )}
                {review?.repeat && (
                  <p className="signin-notice">
                    This new request also signs out sessions started since your
                    last try.
                  </p>
                )}
                <input
                  type="text"
                  name="username"
                  autoComplete="username"
                  value={user.email}
                  readOnly
                  hidden
                />
                <PasswordField
                  label="Current password"
                  name="current-password"
                  autoComplete="current-password"
                  value={current}
                  onChange={setCurrent}
                  error={review?.fields.current}
                  autoFocus
                />
                {action === "password" && (
                  <>
                    <PasswordField
                      label="New password"
                      name="new-password"
                      autoComplete="new-password"
                      value={next}
                      onChange={setNext}
                      error={review?.fields.next}
                      showStrength
                      identity={[user.email, user.name]}
                      revealed={revealed}
                      onReveal={setRevealed}
                    />
                    <PasswordField
                      label="Confirm new password"
                      name="confirm-password"
                      autoComplete="new-password"
                      value={confirm}
                      onChange={setConfirm}
                      error={review?.fields.confirm}
                      revealed={revealed}
                      onReveal={setRevealed}
                    />
                  </>
                )}
              </>
            )}
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={close}>
              {busy ? "Stop waiting" : form ? "Cancel" : "Close"}
            </Button>
            {form && (
              <Button type="submit">
                {action === "password"
                  ? "Change password"
                  : review?.repeat
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
                {action === "password" ? "Sign in again" : "Try again"}
              </Button>
            )}
            {review?.phase === "changed" && (
              <Button ref={recoveryAction} onClick={() => leave("reload")}>
                Reload
              </Button>
            )}
          </div>
        </form>
      </Modal>
    </>
  );
}
