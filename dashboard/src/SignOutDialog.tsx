import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
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
import {
  isDefinitiveAuthRejection,
  isMissingSession,
  noteSignedOut,
} from "./authRequests";
import {
  matchesSignOutContext,
  matchesSignOutSession,
  setSigningOut,
  type SignOutContext,
  type SignOutIntent,
} from "./signOutSession";
import { Button, IconButton, Spinner } from "./ui";
import "./auth.css";

type Phase =
  | "idle"
  | "sending"
  | "checking"
  | "retry"
  | "signed-out"
  | "changed"
  | "unknown";
type Wait = { controller: AbortController; context: SignOutContext };
/** Sign-out is usually instant; only a slow one shows its progress. */
const QUIET_MS = 450;

/**
 * Sign-out without a confirmation step: the page's own unsaved-work guard is
 * the consent. A failure checks the session once before offering a retry.
 */
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
  const [phase, setPhase] = useState<Phase>("idle");
  const [slow, setSlow] = useState(false);
  const intent = useRef<SignOutIntent | null>(null);
  const absent = useRef<{ csrfVersion: number; epoch: number } | null>(null);
  const active = useRef<Wait | null>(null);
  const visible = useRef(open);
  const currentUser = useRef(user);
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
  function retire() {
    const request = active.current;
    active.current = null;
    request?.controller.abort();
  }
  useLayoutEffect(() => {
    currentUser.current = user;
  }, [user]);
  useLayoutEffect(
    () => () => {
      retire();
      setSigningOut(false);
    },
    [],
  );
  // The account menu keeps its plain "Sign out" label: every outcome here is
  // either resolved or offered again from this dialog.
  useEffect(() => onReviewChange(false), [onReviewChange]);
  useEffect(() => {
    visible.current = open;
    if (!open) {
      retire();
      setSigningOut(false);
      setPhase("idle");
      setSlow(false);
      return;
    }
    void start();
  }, [open]);
  useEffect(() => {
    if (phase !== "sending" && phase !== "checking") return;
    const timer = setTimeout(() => setSlow(true), QUIET_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  useEffect(() => {
    if (!busy && phase !== "idle") actionRef.current?.focus();
  }, [busy, phase]);

  function dismiss() {
    retire();
    onClose();
  }
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
  async function start() {
    // The page asks about unsaved work; declining keeps everything as it was.
    if (!onBeforeSignOut()) {
      onClose();
      return;
    }
    setSigningOut(true);
    intent.current = context();
    await send();
  }
  async function send() {
    const original = intent.current;
    const request = claim();
    if (!original || !request) return;
    if (!matchesSignOutContext(original, context())) {
      active.current = null;
      setPhase("changed");
      return;
    }
    setSlow(false);
    setPhase("sending");
    try {
      await withRequestDeadline(
        (signal) =>
          api(
            "/logout",
            {
              method: "POST",
              body: "{}",
              signal,
              // A later sign-in in another tab must never be the target.
              headers: { "X-CSRF-Token": original.csrfToken },
            },
            z.object({ ok: z.literal(true) }),
          ),
        30000,
        request.controller.signal,
      );
      if (!owns(request)) return;
      if (!matchesSignOutContext(original, context())) {
        active.current = null;
        setPhase("changed");
        return;
      }
      active.current = null;
      noteSignedOut();
      onSignedOut();
    } catch (failure) {
      if (!owns(request)) return;
      active.current = null;
      if (
        isDefinitiveAuthRejection(failure) &&
        !isMissingSession(failure) &&
        (failure as { status: number }).status !== 403
      ) {
        setPhase("retry");
        return;
      }
      await check();
    }
  }
  /** One read of the current session. It never restores local authority. */
  async function check() {
    const original = intent.current;
    const request = claim();
    if (!original || !request) return;
    setSlow(false);
    setPhase("checking");
    try {
      const session = await withRequestDeadline(
        (signal) => api("/session", { signal }, SessionSchema),
        30000,
        request.controller.signal,
      );
      if (!owns(request)) return;
      setPhase(
        matchesSignOutContext(original, context()) &&
          matchesSignOutSession(original, session)
          ? "retry"
          : "changed",
      );
    } catch (failure) {
      if (!owns(request)) return;
      if (
        isMissingSession(failure) &&
        request.context.csrfVersion === getCSRFVersion()
      ) {
        invalidateSession();
        noteSignedOut();
        absent.current = {
          csrfVersion: getCSRFVersion(),
          epoch: getSessionEpoch(),
        };
        setPhase("signed-out");
        // The session is gone, as asked. Leaving still consults the page's
        // unsaved-work guard; without unsaved work this is immediate.
        leave(onSignedOut, "signed-out");
      } else setPhase("unknown");
    } finally {
      if (active.current === request) active.current = null;
    }
  }
  function leave(action: () => void, current: Phase = phase) {
    // A later sign-in invalidates this exit; review it again instead.
    if (
      current === "signed-out" &&
      (absent.current?.csrfVersion !== getCSRFVersion() ||
        absent.current?.epoch !== getSessionEpoch())
    ) {
      setPhase("changed");
      return;
    }
    if (onBeforeSignOut()) action();
    else dismiss();
  }

  const shown = open && phase !== "idle" && (!busy || slow);
  const title = busy
    ? "Signing out…"
    : phase === "signed-out"
      ? "You're signed out"
      : phase === "changed"
        ? "Your sign-in changed"
        : phase === "unknown"
          ? "We couldn't reach Vectory"
          : "Couldn't sign out";
  const description = busy
    ? "This usually takes a moment."
    : phase === "signed-out"
      ? "Go to the sign-in page when you're ready. Your unsaved work stays here until then."
      : phase === "changed"
        ? "This browser is now signed in differently. Reload to see the current account."
        : phase === "unknown"
          ? "We couldn't confirm whether you're signed out. Check again when your connection is back."
          : "Your session is still active. Try again, or close this and keep working.";

  return (
    <Dialog.Root open={shown} onOpenChange={(next) => !next && dismiss()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal account-signout-dialog"
          role="alertdialog"
          aria-busy={busy || undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            actionRef.current?.focus();
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
                '.signin-card input[autocomplete="username"]',
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
          {busy && (
            <div className="modal-body signout-progress" role="status">
              <Spinner />
              {phase === "checking"
                ? "Checking your session…"
                : "Ending this session…"}
            </div>
          )}
          <div className="modal-footer">
            <Button
              ref={busy ? actionRef : undefined}
              variant="secondary"
              onClick={dismiss}
            >
              {busy ? "Stop waiting" : "Keep working"}
            </Button>
            {phase === "retry" && (
              <Button ref={actionRef} onClick={() => void send()}>
                Try again
              </Button>
            )}
            {phase === "unknown" && (
              <Button ref={actionRef} onClick={() => void check()}>
                Check again
              </Button>
            )}
            {phase === "signed-out" && (
              <Button ref={actionRef} onClick={() => leave(onSignedOut)}>
                Go to sign in
              </Button>
            )}
            {phase === "changed" && (
              <Button ref={actionRef} onClick={() => leave(onReload)}>
                Reload
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
