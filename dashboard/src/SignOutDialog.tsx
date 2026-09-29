import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LogOut, X } from "lucide-react";
import { z } from "zod";
import {
  api,
  getCSRFToken,
  getCSRFVersion,
  getSessionEpoch,
  invalidateSession,
  isSessionValid,
  SessionSchema,
  withRequestDeadline,
  type User,
} from "./api";
import { isDefinitiveAuthRejection, isMissingSession } from "./authRequests";
import {
  matchesSignOutContext,
  matchesSignOutSession,
  type SignOutContext,
  type SignOutIntent,
} from "./signOutSession";
import { Button, ErrorBox, IconButton } from "./ui";

type Phase =
  | "confirm"
  | "sending"
  | "review"
  | "checking"
  | "retry"
  | "signed-out"
  | "changed";
type Wait = { controller: AbortController; context: SignOutContext };

/** Remains mounted when hidden so an uncertain request keeps its original session. */
export default function SignOutDialog({
  user,
  open,
  onClose,
  onBeforeSignOut,
  onSignedOut,
  onReload,
  onReviewChange,
  returnFocusRef,
}: {
  user: User;
  open: boolean;
  onClose: () => void;
  onBeforeSignOut: () => boolean;
  onSignedOut: () => void;
  onReload: () => void;
  onReviewChange: (pending: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [error, setError] = useState("");
  const intent = useRef<SignOutIntent | null>(null);
  const absentSession = useRef<{ csrfVersion: number; epoch: number } | null>(
    null,
  );
  const active = useRef<Wait | null>(null);
  const visible = useRef(open);
  const currentUser = useRef(user);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const busy = phase === "sending" || phase === "checking";

  function context(): SignOutContext {
    return {
      userId: currentUser.current.id,
      enabled: currentUser.current.enabled,
      csrfToken: getCSRFToken(),
      csrfVersion: getCSRFVersion(),
      epoch: getSessionEpoch(),
      valid: isSessionValid(),
    };
  }
  function retireWait() {
    const request = active.current;
    if (!request) return;
    active.current = null;
    request.controller.abort();
    setPhase("review");
    setError("");
  }
  useLayoutEffect(() => {
    currentUser.current = user;
    visible.current = open;
    if (!open) retireWait();
  }, [open, user]);
  useLayoutEffect(
    () => () => {
      const request = active.current;
      active.current = null;
      request?.controller.abort();
    },
    [],
  );
  useEffect(() => onReviewChange(phase !== "confirm"), [phase, onReviewChange]);
  useEffect(() => {
    if (open && !busy && phase !== "confirm") actionRef.current?.focus();
  }, [open, busy, phase]);

  function claim() {
    if (active.current || !visible.current) return null;
    const request = { controller: new AbortController(), context: context() };
    active.current = request;
    return request;
  }
  function owns(request: Wait) {
    return (
      active.current === request &&
      visible.current &&
      !request.controller.signal.aborted
    );
  }
  function dismiss() {
    visible.current = false;
    retireWait();
    onClose();
  }
  async function send() {
    if (phase !== "confirm" && phase !== "retry") return;
    const request = claim();
    if (!request) return;
    const original = intent.current || request.context;
    if (!matchesSignOutContext(original, context())) {
      intent.current = original;
      active.current = null;
      setPhase("review");
      setError(
        "Your sign-in state changed. Check the current session before continuing.",
      );
      return;
    }
    // Consent is evaluated against the currently visible editor before every send.
    if (!onBeforeSignOut()) {
      active.current = null;
      dismiss();
      return;
    }
    intent.current = original;
    if (!matchesSignOutContext(original, context())) {
      active.current = null;
      setPhase("review");
      setError(
        "Your sign-in state changed. Check the current session before continuing.",
      );
      return;
    }
    setPhase("sending");
    setError("");
    try {
      await withRequestDeadline(
        (signal) =>
          api(
            "/logout",
            {
              method: "POST",
              body: "{}",
              signal,
              // A cookie rotated after a status read must not widen this old intent.
              headers: { "X-CSRF-Token": original.csrfToken },
            },
            z.object({ ok: z.literal(true) }),
          ),
        30000,
        request.controller.signal,
      );
      if (!owns(request)) return;
      if (!matchesSignOutContext(original, context())) {
        setPhase("review");
        setError(
          "Your sign-in state changed while waiting. Check the current session.",
        );
        return;
      }
      // The same modal still owns focus, so its initial draft consent remains valid.
      onSignedOut();
    } catch (failure) {
      if (!owns(request)) return;
      setPhase("review");
      setError(
        isDefinitiveAuthRejection(failure)
          ? `The server rejected this sign-out request. ${(failure as Error).message}`
          : "The response did not confirm sign-out. The server may already have ended the session.",
      );
    } finally {
      if (active.current === request) active.current = null;
    }
  }
  async function check() {
    const original = intent.current;
    if (!original) return;
    const request = claim();
    if (!request) return;
    setPhase("checking");
    setError("");
    try {
      const session = await withRequestDeadline(
        (signal) => api("/session", { signal }, SessionSchema),
        30000,
        request.controller.signal,
      );
      if (!owns(request)) return;
      setPhase(
        matchesSignOutContext(original, context()) &&
          matchesSignOutContext(request.context, context()) &&
          matchesSignOutSession(original, session)
          ? "retry"
          : "changed",
      );
    } catch (failure) {
      if (!owns(request)) return;
      // This read can itself invalidate the old epoch on401. A new credential
      // version still makes its result obsolete; do not clear that newer sign-in.
      if (
        isMissingSession(failure) &&
        request.context.csrfVersion === getCSRFVersion()
      ) {
        invalidateSession();
        absentSession.current = {
          csrfVersion: getCSRFVersion(),
          epoch: getSessionEpoch(),
        };
        setPhase("signed-out");
      } else {
        setPhase("review");
        setError(
          `Could not check sign-out status. ${(failure as Error).message}`,
        );
      }
    } finally {
      if (active.current === request) active.current = null;
    }
  }
  function leave(action: () => void) {
    if (
      phase === "signed-out" &&
      (absentSession.current?.csrfVersion !== getCSRFVersion() ||
        absentSession.current?.epoch !== getSessionEpoch())
    ) {
      setPhase("changed");
      return;
    }
    if (onBeforeSignOut()) action();
    else dismiss();
  }
  const title =
    phase === "confirm" || phase === "sending"
      ? "Sign out of Vectory?"
      : phase === "signed-out"
        ? "No active session found"
        : phase === "changed"
          ? "Your sign-in changed"
          : phase === "retry"
            ? "This session is still active"
            : "Sign-out not confirmed";
  const description =
    phase === "confirm"
      ? "You’ll need to sign in again to access this workspace."
      : phase === "sending"
        ? "Waiting for the server. Stopping this wait will not undo sign-out."
        : phase === "signed-out"
          ? "The last check found no active session. Your local work is still here; go to sign in when you’re ready."
          : phase === "changed"
            ? "A different sign-in or account state is active. Reload the workspace to review it before starting a new sign-out."
            : phase === "retry"
              ? "The last check found the original session. You can retry sign-out. The earlier request may still finish."
              : "Check the current session before trying again. This only reads status; it does not send another sign-out request.";

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && dismiss()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal account-signout-dialog"
          role="alertdialog"
          aria-busy={busy || undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (phase === "confirm" ? cancelRef : actionRef).current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            [
              returnFocusRef.current,
              document.querySelector<HTMLButtonElement>(
                '.mobile-header button[aria-controls="main-navigation"]',
              ),
              document.getElementById("main-content"),
              document.querySelector<HTMLInputElement>(
                '.auth-card input[autocomplete="username"]',
              ),
            ]
              .find(
                (target) =>
                  target?.isConnected &&
                  target.getClientRects().length &&
                  !target.closest("[inert]") &&
                  !target.matches(":disabled"),
              )
              ?.focus();
          }}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <div className="modal-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <IconButton icon={X} label="Close dialog" onClick={dismiss} />
          </div>
          {error && (
            <div className="modal-body">
              <ErrorBox message={error} />
            </div>
          )}
          <div className="modal-footer">
            <button
              ref={cancelRef}
              type="button"
              className="button secondary"
              onClick={dismiss}
            >
              {phase === "confirm"
                ? "Cancel"
                : busy
                  ? "Stop waiting"
                  : "Back to workspace"}
            </button>
            {phase === "confirm" || phase === "sending" || phase === "retry" ? (
              <Button
                ref={actionRef}
                variant="danger"
                busy={busy}
                icon={LogOut}
                onClick={() => void send()}
              >
                {phase === "sending"
                  ? "Signing out…"
                  : phase === "retry"
                    ? "Retry sign out"
                    : "Sign out"}
              </Button>
            ) : phase === "signed-out" ? (
              <Button ref={actionRef} onClick={() => leave(onSignedOut)}>
                Go to sign in
              </Button>
            ) : phase === "changed" ? (
              <Button ref={actionRef} onClick={() => leave(onReload)}>
                Reload workspace
              </Button>
            ) : (
              <Button ref={actionRef} busy={busy} onClick={() => void check()}>
                Check sign-out status
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
