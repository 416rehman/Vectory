import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { Copy, KeyRound } from "lucide-react";
import { z } from "zod";
import {
  api,
  getCSRFToken,
  getCSRFVersion,
  getSessionEpoch,
  isSessionValid,
  when,
  withRequestDeadline,
  type User,
} from "./api";
import { isDefinitiveAuthRejection } from "./authRequests";
import {
  canUseAccountActionContext,
  sameAccountActionContext,
  type AccountActionContext,
} from "./accountActionSession";
import { Button, ErrorBox, Modal } from "./ui";
import { CurrentPassword } from "./AccountPasswordFields";

const ReceiptSchema = z
  .object({
    request_id: z.uuid(),
    user_id: z.uuid(),
    code: z.string().regex(/^[a-fA-F0-9]{64}$/),
    expires_at: z.string(),
  })
  .strict();
const StatusSchema = z.discriminatedUnion("status", [
  z
    .object({
      request_id: z.uuid(),
      user_id: z.uuid(),
      status: z.literal("not_found"),
    })
    .strict(),
  z
    .object({
      request_id: z.uuid(),
      user_id: z.uuid(),
      status: z.literal("issued"),
      active: z.boolean(),
      expires_at: z.string(),
    })
    .strict(),
  z
    .object({
      request_id: z.uuid(),
      user_id: z.uuid(),
      status: z.literal("cancelled"),
      was_issued: z.boolean(),
    })
    .strict(),
]);
type Status = z.infer<typeof StatusSchema>;
type Context = AccountActionContext & { role: User["role"] };
type Review = {
  context: Context;
  target: User;
  requestId: string;
  phase: "sending" | "unknown" | "changed";
  status: Status | null;
  error: string;
};
type Wait = { review: Review; controller: AbortController };
type Secret = {
  review: Review;
  code: string;
  expiresAt: string;
  verifiedRevision: number;
  verificationRequired: boolean;
  localExpiryNoticed: boolean;
  verificationMessage: string;
};

export type AdminPasswordResetHandle = { open: (person: User) => void };

export default function AdminPasswordResetActions({
  ref,
  user,
  people,
  reload,
}: {
  ref?: Ref<AdminPasswordResetHandle>;
  user: User;
  people: User[];
  reload: () => void;
}) {
  const [target, setTarget] = useState<User | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const retained = useRef<Review | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const secretRef = useRef<Secret | null>(null);
  const [secretOpen, setSecretOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [blockedTarget, setBlockedTarget] = useState<User | null>(null);
  const active = useRef<Wait | null>(null);
  const statusRead = useRef<AbortController | null>(null);
  const currentUser = useRef(user);
  const currentPeople = useRef(people);
  const owner = useRef<Context | null>(null);
  const reminderButton = useRef<HTMLButtonElement>(null);
  const reviewAction = useRef<HTMLButtonElement>(null);

  function context(): Context {
    return {
      userId: currentUser.current.id,
      role: currentUser.current.role,
      enabled: currentUser.current.enabled,
      csrfToken: getCSRFToken(),
      csrfVersion: getCSRFVersion(),
      epoch: getSessionEpoch(),
      valid: isSessionValid(),
    };
  }
  function sameContext(original: Context) {
    const now = context();
    return (
      original.role === "admin" &&
      now.role === "admin" &&
      canUseAccountActionContext(original, now)
    );
  }
  function remember(next: Review | null) {
    retained.current = next;
    setReview(next);
  }
  function keepSecret(next: Secret | null) {
    secretRef.current = next;
    setSecret(next);
    if (!next) {
      setCopied(false);
      setCopyError("");
    }
  }
  function clearPassword() {
    setPassword("");
  }
  function stopWaiting(hide = false) {
    const request = active.current;
    if (request) {
      active.current = null;
      request.controller.abort();
      remember({ ...request.review, phase: "unknown", error: "" });
      clearPassword();
    }
    statusRead.current?.abort();
    statusRead.current = null;
    setChecking(false);
    if (hide) setReviewOpen(false);
  }
  function authorityChanged() {
    const shown = secretRef.current;
    if (shown) {
      keepSecret(null);
      setSecretOpen(false);
      remember({
        ...shown.review,
        phase: "changed",
        status: null,
        error: "The reset code was hidden because your sign-in changed.",
      });
    }
    stopWaiting();
    if (retained.current)
      remember({ ...retained.current, phase: "changed", status: null });
    setFormOpen(false);
    clearPassword();
    setFormError("");
    setReviewOpen(false);
    setBlockedTarget(null);
  }
  useLayoutEffect(() => {
    currentUser.current = user;
    const now = context();
    if (
      owner.current &&
      (owner.current.role !== now.role ||
        !sameAccountActionContext(owner.current, now))
    )
      authorityChanged();
    owner.current = now;
  }, [user]);
  useLayoutEffect(() => {
    currentPeople.current = people;
    const shown = secretRef.current;
    if (!shown) return;
    const latest = people.find(
      (person) => person.id === shown.review.target.id,
    );
    if (
      !latest ||
      (latest.enabled && latest.revision <= shown.verifiedRevision)
    )
      return;
    if (shown.verificationRequired) return;
    keepSecret({
      ...shown,
      verificationRequired: true,
      verificationMessage:
        "This account changed after the code was issued. Check this exact request before sharing it.",
    });
  }, [people]);
  useEffect(() => {
    const changed = () => {
      const now = context();
      if (
        owner.current &&
        (owner.current.role !== now.role ||
          !sameAccountActionContext(owner.current, now))
      )
        authorityChanged();
      owner.current = now;
    };
    window.addEventListener("vectory:session-ended", changed);
    window.addEventListener("vectory:session-changed", changed);
    return () => {
      window.removeEventListener("vectory:session-ended", changed);
      window.removeEventListener("vectory:session-changed", changed);
    };
  }, []);
  useLayoutEffect(
    () => () => {
      active.current?.controller.abort();
      active.current = null;
      statusRead.current?.abort();
      statusRead.current = null;
      secretRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!review && !secret && !formOpen) return;
    const leave = (event: Event) => {
      const message = secret
        ? "Leave and discard this browser's only copy of the reset code? The code may remain valid."
        : review
          ? "Leave this reset request review? You may lose its exact ID before the outcome is known."
          : "Leave this reset form and discard its entered password?";
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
  }, [review, secret, formOpen]);
  useEffect(() => {
    if (reviewOpen && review?.phase === "unknown")
      reviewAction.current?.focus();
  }, [reviewOpen, review?.phase]);
  useEffect(() => {
    if (!secret || secret.localExpiryNoticed) return;
    const expires = Date.parse(secret.expiresAt);
    const checkExpiry = () => {
      if (secretRef.current !== secret) return;
      keepSecret({
        ...secret,
        localExpiryNoticed: true,
        verificationRequired: true,
        verificationMessage:
          "This browser's clock says the code may have expired. Check its status with the server before sharing it.",
      });
    };
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      checkExpiry();
      return;
    }
    const timer = setTimeout(checkExpiry, expires - Date.now());
    return () => clearTimeout(timer);
  }, [secret]);

  function open(person: User) {
    const prior = secretRef.current?.review || retained.current;
    if (prior && prior.target.id !== person.id) {
      setBlockedTarget(person);
      return;
    }
    if (secretRef.current) {
      setSecretOpen(true);
      return;
    }
    if (retained.current) {
      setReviewOpen(true);
      return;
    }
    const now = context();
    if (
      now.role !== "admin" ||
      !sameContext(now) ||
      person.id === now.userId ||
      !person.enabled
    )
      return;
    const latest = currentPeople.current.find(
      (entry) => entry.id === person.id,
    );
    if (!latest || latest.revision !== person.revision) return;
    setTarget(person);
    setBlockedTarget(null);
    clearPassword();
    setFormError("");
    setFormOpen(true);
  }
  useImperativeHandle(ref, () => ({ open }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (active.current || retained.current || secretRef.current || !formOpen)
      return;
    const person = target;
    const original = context();
    if (!person || !sameContext(original) || person.id === original.userId)
      return;
    const latest = currentPeople.current.find(
      (entry) => entry.id === person.id,
    );
    if (!latest || latest.revision !== person.revision || !latest.enabled) {
      setFormError(
        "This account changed. Load the latest details before continuing.",
      );
      return;
    }
    const requestId = crypto.randomUUID();
    const secret = password;
    const next: Review = {
      context: original,
      target: person,
      requestId,
      phase: "sending",
      status: null,
      error: "",
    };
    const wait = { review: next, controller: new AbortController() };
    active.current = wait;
    clearPassword();
    setFormOpen(false);
    setFormError("");
    remember(next);
    setReviewOpen(true);
    let sent = false;
    const path = `/users/${person.id}/password-reset`;
    try {
      const preflight = await withRequestDeadline(
        (signal) =>
          api(
            `${path}/requests/${requestId}`,
            { signal, headers: { "X-CSRF-Token": original.csrfToken } },
            StatusSchema,
          ),
        30000,
        wait.controller.signal,
      );
      if (active.current !== wait || !sameContext(original)) return;
      if (
        preflight.request_id !== requestId ||
        preflight.user_id !== person.id ||
        preflight.status !== "not_found"
      )
        throw Error("The server did not confirm this reset request ID.");
      sent = true;
      const receipt = await withRequestDeadline(
        (signal) =>
          api(
            path,
            {
              method: "POST",
              body: JSON.stringify({
                request_id: requestId,
                current_password: secret,
                revision: person.revision,
              }),
              headers: { "X-CSRF-Token": original.csrfToken },
              signal,
            },
            ReceiptSchema,
          ),
        30000,
        wait.controller.signal,
      );
      if (active.current !== wait || !sameContext(original)) return;
      if (
        receipt.request_id !== requestId ||
        receipt.user_id !== person.id ||
        !Number.isFinite(Date.parse(receipt.expires_at))
      )
        throw Error("The reset-code receipt did not match this request.");
      active.current = null;
      remember(null);
      setReviewOpen(false);
      keepSecret({
        review: next,
        code: receipt.code,
        expiresAt: receipt.expires_at,
        verifiedRevision: person.revision + 1,
        verificationRequired: false,
        localExpiryNoticed: false,
        verificationMessage: "",
      });
      setCopied(false);
      setCopyError("");
      setSecretOpen(true);
      reload();
    } catch (failure) {
      if (active.current !== wait) return;
      active.current = null;
      if (!sameContext(original)) {
        authorityChanged();
        return;
      }
      if (!sent) {
        remember(null);
        setReviewOpen(false);
        setFormError(
          "The reset request was not sent. This server did not confirm support for tracked reset codes. " +
            (failure as Error).message,
        );
        setFormOpen(true);
      } else if (
        isDefinitiveAuthRejection(failure) &&
        (failure as { status: number }).status !== 409
      ) {
        remember(null);
        setReviewOpen(false);
        setFormError((failure as Error).message);
        setFormOpen(true);
        reload();
      } else {
        remember({
          ...next,
          phase: "unknown",
          error: isDefinitiveAuthRejection(failure)
            ? (failure as Error).message
            : "The response did not confirm a reset code. Check this exact request before issuing another.",
        });
      }
    }
  }
  async function observe(cancel: boolean) {
    const previous = retained.current;
    if (
      !previous ||
      previous.phase !== "unknown" ||
      active.current ||
      statusRead.current ||
      (cancel && previous.status?.status === "cancelled")
    )
      return;
    if (!sameContext(previous.context)) {
      authorityChanged();
      return;
    }
    const controller = new AbortController();
    statusRead.current = controller;
    setChecking(true);
    remember({ ...previous, error: "" });
    const path = `/users/${previous.target.id}/password-reset/requests/${previous.requestId}`;
    try {
      const status = await withRequestDeadline(
        (signal) =>
          api(
            `${path}${cancel ? "/cancel" : ""}`,
            {
              ...(cancel ? { method: "POST", body: "{}" } : {}),
              headers: { "X-CSRF-Token": previous.context.csrfToken },
              signal,
            },
            StatusSchema,
          ),
        30000,
        controller.signal,
      );
      if (statusRead.current !== controller || !retained.current) return;
      if (!sameContext(previous.context)) {
        authorityChanged();
        return;
      }
      if (
        status.request_id !== previous.requestId ||
        status.user_id !== previous.target.id ||
        (cancel && status.status !== "cancelled")
      )
        throw Error("The reset request status did not match this request.");
      remember({ ...retained.current, status, error: "" });
      if (status.status !== "not_found") reload();
    } catch (failure) {
      if (statusRead.current !== controller || !retained.current) return;
      remember({
        ...retained.current,
        status: null,
        error: (failure as Error).message,
      });
    } finally {
      if (statusRead.current === controller) {
        statusRead.current = null;
        setChecking(false);
      }
    }
  }
  async function verifyHeldCode(): Promise<boolean> {
    const held = secretRef.current;
    if (!held || statusRead.current) return false;
    if (!sameContext(held.review.context)) {
      authorityChanged();
      return false;
    }
    const controller = new AbortController();
    statusRead.current = controller;
    setChecking(true);
    try {
      const status = await withRequestDeadline(
        (signal) =>
          api(
            `/users/${held.review.target.id}/password-reset/requests/${held.review.requestId}`,
            {
              signal,
              headers: { "X-CSRF-Token": held.review.context.csrfToken },
            },
            StatusSchema,
          ),
        30000,
        controller.signal,
      );
      if (statusRead.current !== controller || secretRef.current !== held)
        return false;
      if (!sameContext(held.review.context)) {
        authorityChanged();
        return false;
      }
      if (
        status.request_id !== held.review.requestId ||
        status.user_id !== held.review.target.id
      )
        throw Error("The server returned a different reset request.");
      if (status.status === "issued" && status.expires_at !== held.expiresAt)
        throw Error("The server returned a different reset-code expiry.");
      if (status.status === "issued" && status.active) {
        const latest = currentPeople.current.find(
          (person) => person.id === held.review.target.id,
        );
        keepSecret({
          ...held,
          verifiedRevision: latest?.revision ?? held.verifiedRevision,
          localExpiryNoticed:
            held.localExpiryNoticed || Date.parse(held.expiresAt) <= Date.now(),
          verificationRequired: false,
          verificationMessage: "",
        });
        return true;
      }
      if (status.status === "not_found")
        throw Error(
          "The server cannot find this previously confirmed request. Keep this code private and ask an administrator to investigate.",
        );
      keepSecret(null);
      setSecretOpen(false);
      remember({
        ...held.review,
        phase: "unknown",
        status,
        error:
          status.status === "cancelled"
            ? "This reset code has been cancelled."
            : "This reset code is no longer active.",
      });
      setReviewOpen(true);
      reload();
      return false;
    } catch (failure) {
      if (statusRead.current === controller && secretRef.current === held)
        keepSecret({
          ...held,
          verificationRequired: true,
          verificationMessage:
            "Could not confirm this code is still active. " +
            (failure as Error).message,
        });
      return false;
    } finally {
      if (statusRead.current === controller) {
        statusRead.current = null;
        setChecking(false);
      }
    }
  }
  function finishReview() {
    const previous = retained.current;
    if (
      !previous ||
      previous.phase !== "unknown" ||
      !previous.status ||
      (previous.status.status !== "cancelled" &&
        !(previous.status.status === "issued" && !previous.status.active)) ||
      checking
    )
      return;
    remember(null);
    setReviewOpen(false);
    reload();
  }
  function restoreReview() {
    const previous = retained.current;
    const now = context();
    if (
      !previous ||
      previous.phase !== "changed" ||
      previous.context.userId !== now.userId ||
      now.role !== "admin" ||
      !canUseAccountActionContext(now, now)
    )
      return;
    remember({ ...previous, context: now, phase: "unknown", status: null });
  }
  function revokeCode() {
    const shown = secretRef.current;
    if (!shown) return;
    statusRead.current?.abort();
    statusRead.current = null;
    setChecking(false);
    keepSecret(null);
    setSecretOpen(false);
    remember({
      ...shown.review,
      phase: "unknown",
      status: null,
      error:
        "The visible copy was discarded. Confirm cancellation of this exact request before issuing another code.",
    });
    setReviewOpen(true);
    void observe(true);
  }
  const currentTarget =
    target && currentPeople.current.find((p) => p.id === target.id);
  const staleTarget =
    !!target &&
    (!currentTarget ||
      currentTarget.revision !== target.revision ||
      !currentTarget.enabled);

  return (
    <>
      {user.role === "admin" && (review || secret) && (
        <Button
          ref={reminderButton}
          variant="secondary"
          icon={KeyRound}
          onClick={() => {
            if (secretRef.current) setSecretOpen(true);
            else setReviewOpen(true);
          }}
        >
          {secret ? "Show reset code" : "Review reset request"}
        </Button>
      )}
      <Modal
        open={!!blockedTarget}
        onClose={() => setBlockedTarget(null)}
        title="Finish the earlier reset first"
        description={blockedTarget?.email}
      >
        <div className="modal-body">
          <p>
            A reset for {secret?.review.target.name || review?.target.name} is
            still open. Finish sharing its code or resolve that exact request
            before creating one for {blockedTarget?.name}.
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setBlockedTarget(null)}>
            Back to people
          </Button>
          <Button
            onClick={() => {
              setBlockedTarget(null);
              if (secretRef.current) setSecretOpen(true);
              else setReviewOpen(true);
            }}
          >
            Review earlier reset
          </Button>
        </div>
      </Modal>
      <Modal
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          clearPassword();
        }}
        title="Create a password reset code"
        description={target?.email}
      >
        <form onSubmit={(event) => void submit(event)}>
          <div className="modal-body">
            {formError && <ErrorBox message={formError} />}
            {staleTarget && (
              <div className="account-notice" role="status">
                This account changed after you opened it. Load its latest
                details before continuing.
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (!currentTarget?.enabled) return;
                    setTarget(currentTarget);
                    clearPassword();
                    setFormError("");
                  }}
                >
                  Load latest details
                </Button>
              </div>
            )}
            <p className="account-notice">
              Create a code for {target?.name} to choose a new password. It
              expires after 15 minutes and replaces any previous code. Their
              password stays unchanged until they use it; their authenticator
              remains required.
            </p>
            <CurrentPassword
              value={password}
              onChange={setPassword}
              hint="Confirm it’s you before creating a reset code."
            />
          </div>
          <div className="modal-footer">
            <Button
              variant="secondary"
              onClick={() => {
                setFormOpen(false);
                clearPassword();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={staleTarget}>
              Create reset code
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={reviewOpen && !!review}
        onClose={() => stopWaiting(true)}
        title={
          review?.phase === "sending"
            ? "Waiting for reset code"
            : review?.phase === "changed"
              ? "Your access changed"
              : "Reset code result unknown"
        }
        description="Review this exact request before issuing another reset code."
        returnFocusRef={reminderButton}
      >
        <div className="modal-body">
          {review?.error && <ErrorBox message={review.error} />}
          {review?.phase === "sending" ? (
            <p role="status">
              Waiting for the server. You can stop waiting, but the code may
              still be issued.
            </p>
          ) : review?.phase === "changed" ? (
            <p>
              Your sign-in or role changed. The previous request may have
              completed. Restore administrator access with the same account to
              review its exact status.
            </p>
          ) : (
            review && (
              <>
                <p>
                  The response did not confirm a usable code for{" "}
                  {review.target.email}. The submitted password was cleared. The
                  request ID remains available only on this page.
                </p>
                <p>
                  <code className="account-request-id">{review.requestId}</code>
                </p>
                {review.status?.status === "not_found" && (
                  <p role="status">
                    No committed result is visible yet. The earlier request may
                    still arrive. Cancel this exact request before starting
                    another.
                  </p>
                )}
                {review.status?.status === "issued" && (
                  <p role="status">
                    A code was issued for this request, but the server cannot
                    show it again.{" "}
                    {review.status.active
                      ? "It may still be usable. Cancel it before issuing a replacement."
                      : "It is no longer active; it may have been used, expired or replaced. Review the account before another reset."}
                  </p>
                )}
                {review.status?.status === "cancelled" && (
                  <p role="status">
                    This request cannot issue or retain a usable code.
                    {review.status.was_issued &&
                      " If the code was already used, cancelling it does not undo that password change."}
                  </p>
                )}
              </>
            )
          )}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => stopWaiting(true)}>
            {review?.phase === "sending" ? "Stop waiting" : "Back to people"}
          </Button>
          {review?.phase === "unknown" && (
            <Button
              ref={reviewAction}
              busy={checking}
              onClick={() => void observe(false)}
            >
              Check request status
            </Button>
          )}
          {review?.phase === "unknown" &&
            review.status?.status !== "cancelled" && (
              <Button
                variant="secondary"
                busy={checking}
                onClick={() => void observe(true)}
              >
                Cancel this request
              </Button>
            )}
          {review?.phase === "unknown" &&
            (review.status?.status === "cancelled" ||
              (review.status?.status === "issued" &&
                !review.status.active)) && (
              <Button onClick={finishReview}>Finish review</Button>
            )}
          {review?.phase === "changed" &&
            review.context.userId === user.id &&
            user.role === "admin" && (
              <Button onClick={restoreReview}>Review original request</Button>
            )}
        </div>
      </Modal>
      <Modal
        open={secretOpen && !!secret}
        onClose={() => setSecretOpen(false)}
        title={`Password reset for ${secret?.review.target.name || "account"}`}
        description="This code is shown once by the server. Share it through a protected channel."
        returnFocusRef={reminderButton}
      >
        <div className="modal-body">
          <p>
            Ask the person to select <strong>Reset password</strong> on the
            Vectory sign-in page. This code can be used once, until{" "}
            {when(secret?.expiresAt)}. Hiding it keeps this browser&apos;s copy
            until you mark it shared or leave the page.
          </p>
          {secret?.verificationRequired ? (
            <p role="status">{secret.verificationMessage}</p>
          ) : (
            <code
              className="control-command control-wrap-code"
              aria-label="Password reset code"
            >
              {secret?.code}
            </code>
          )}
          <Button
            variant="secondary"
            busy={checking}
            onClick={() => void verifyHeldCode()}
          >
            Check code status
          </Button>
          {!secret?.verificationRequired && (
            <Button
              variant="secondary"
              icon={Copy}
              busy={checking}
              onClick={async () => {
                const held = secretRef.current;
                if (!held || !(await verifyHeldCode())) return;
                if (secretRef.current?.code !== held.code) return;
                try {
                  await navigator.clipboard.writeText(held.code);
                  if (secretRef.current?.code === held.code) {
                    setCopied(true);
                    setCopyError("");
                  }
                } catch {
                  if (secretRef.current?.code === held.code)
                    setCopyError(
                      "Copy was unavailable. Select the code above to copy it.",
                    );
                }
              }}
            >
              {copied ? "Copied" : "Copy reset code"}
            </Button>
          )}
          {copyError && <ErrorBox message={copyError} />}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setSecretOpen(false)}>
            Hide for now
          </Button>
          <Button variant="secondary" onClick={revokeCode}>
            Revoke code
          </Button>
          <Button
            onClick={() => {
              keepSecret(null);
              setSecretOpen(false);
            }}
          >
            I&apos;ve shared the code
          </Button>
        </div>
      </Modal>
    </>
  );
}
