import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { z } from "zod";
import {
  api,
  getCSRFToken,
  getCSRFVersion,
  getSessionEpoch,
  isSessionValid,
  UserSchema,
  withRequestDeadline,
  type User,
} from "./api";
import { isDefinitiveAuthRejection } from "./authRequests";
import {
  canUseAccountActionContext,
  sameAccountActionContext,
  type AccountActionContext,
} from "./accountActionSession";
import { Button, ErrorBox, Field, Modal } from "./ui";
import RolePicker from "./RolePicker";

const ReceiptSchema = z
  .object({ request_id: z.uuid(), user: UserSchema })
  .strict();
const StatusSchema = z.discriminatedUnion("status", [
  z.object({ request_id: z.uuid(), status: z.literal("not_found") }).strict(),
  z.object({ request_id: z.uuid(), status: z.literal("cancelled") }).strict(),
  z
    .object({
      request_id: z.uuid(),
      status: z.literal("created"),
      user: UserSchema,
    })
    .strict(),
]);
type Status = z.infer<typeof StatusSchema>;
type Context = AccountActionContext & { role: User["role"] };
type Review = {
  context: Context;
  requestId: string;
  email: string;
  name: string;
  role: User["role"];
  phase: "sending" | "unknown" | "changed";
  status: Status | null;
  error: string;
};
type Wait = { review: Review; controller: AbortController };

export default function AddPersonActions({
  user,
  notify,
  onCreated,
  onObserved,
  onReviewNeeded,
}: {
  user: User;
  notify: (message: string) => void;
  onCreated: (person: User) => void;
  onObserved: (person: User) => void;
  onReviewNeeded: () => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<User["role"]>("viewer");
  const [formError, setFormError] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const retained = useRef<Review | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const active = useRef<Wait | null>(null);
  const observation = useRef<AbortController | null>(null);
  const currentUser = useRef(user);
  const owner = useRef<Context | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
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
      original.role === now.role &&
      canUseAccountActionContext(original, now)
    );
  }
  function matchesPerson(
    person: User,
    expected: Pick<Review, "email" | "name" | "role">,
  ) {
    return (
      person.email === expected.email &&
      person.name === expected.name &&
      person.role === expected.role &&
      person.enabled
    );
  }
  function remember(next: Review | null) {
    retained.current = next;
    setReview(next);
  }
  function clearPassword() {
    setPassword("");
  }
  function stopWaiting(hide = false) {
    const request = active.current;
    if (request) {
      active.current = null;
      request.controller.abort();
      remember({ ...request.review, phase: "unknown" });
      clearPassword();
    }
    observation.current?.abort();
    observation.current = null;
    setChecking(false);
    if (hide) setReviewOpen(false);
  }
  function authorityChanged() {
    stopWaiting();
    clearPassword();
    setFormOpen(false);
    setFormError("");
    if (retained.current)
      remember({
        ...retained.current,
        phase: "changed",
        status: null,
        error: "",
      });
    setReviewOpen(false);
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
      observation.current?.abort();
      observation.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!review && !formOpen) return;
    const leave = (event: Event) => {
      if (
        !window.confirm(
          review
            ? "Leave this account creation review? The request may still finish, and its result will no longer be available here."
            : "Leave this account form and discard the entered details?",
        )
      )
        event.preventDefault();
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
  }, [review, formOpen]);
  useEffect(() => {
    if (reviewOpen && review?.phase === "unknown")
      reviewAction.current?.focus();
  }, [reviewOpen, review?.phase]);

  function open() {
    if (retained.current) {
      setReviewOpen(true);
      return;
    }
    if (currentUser.current.role !== "admin" || !sameContext(context())) return;
    setName("");
    setEmail("");
    clearPassword();
    setRole("viewer");
    setFormError("");
    setFormOpen(true);
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (active.current || retained.current || !formOpen) return;
    const original = context();
    if (original.role !== "admin" || !sameContext(original)) return;
    const requestId = crypto.randomUUID();
    const targetEmail = email
      .trim()
      .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    const targetName = name.trim();
    if (!targetName) {
      setFormError("Enter a name for this account.");
      return;
    }
    const targetRole = role;
    const secret = password;
    const next: Review = {
      context: original,
      requestId,
      email: targetEmail,
      name: targetName,
      role: targetRole,
      phase: "sending",
      status: null,
      error: "",
    };
    const wait = { review: next, controller: new AbortController() };
    active.current = wait;
    clearPassword();
    setFormError("");
    setFormOpen(false);
    remember(next);
    setReviewOpen(true);
    let sent = false;
    try {
      const preflight = await withRequestDeadline(
        (signal) =>
          api(
            `/users/requests/${requestId}`,
            { signal, headers: { "X-CSRF-Token": original.csrfToken } },
            StatusSchema,
          ),
        30000,
        wait.controller.signal,
      );
      if (active.current !== wait || !sameContext(original)) return;
      if (
        preflight.request_id !== requestId ||
        preflight.status !== "not_found"
      )
        throw Error("The server did not confirm this new account request ID.");
      sent = true;
      const receipt = await withRequestDeadline(
        (signal) =>
          api(
            "/users",
            {
              method: "POST",
              body: JSON.stringify({
                request_id: requestId,
                name: targetName,
                email: targetEmail,
                password: secret,
                role: targetRole,
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
        !matchesPerson(receipt.user, next)
      )
        throw Error("The account receipt did not match this request.");
      active.current = null;
      remember(null);
      setReviewOpen(false);
      onCreated(receipt.user);
      notify("Workspace user created.");
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
          "Account creation was not sent. The server did not confirm support for safe account requests. " +
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
      } else {
        remember({
          ...next,
          phase: "unknown",
          error: isDefinitiveAuthRejection(failure)
            ? (failure as Error).message
            : "The result was not confirmed. Check this exact request before starting another account.",
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
      observation.current ||
      (cancel &&
        (previous.status?.status === "created" ||
          previous.status?.status === "cancelled"))
    )
      return;
    if (!sameContext(previous.context)) {
      authorityChanged();
      return;
    }
    const controller = new AbortController();
    observation.current = controller;
    setChecking(true);
    remember({ ...previous, error: "" });
    try {
      const result = await withRequestDeadline(
        (signal) =>
          api(
            `/users/requests/${previous.requestId}${cancel ? "/cancel" : ""}`,
            {
              ...(cancel ? { method: "POST", body: "{}" } : {}),
              signal,
              headers: { "X-CSRF-Token": previous.context.csrfToken },
            },
            StatusSchema,
          ),
        30000,
        controller.signal,
      );
      if (observation.current !== controller || !retained.current) return;
      if (!sameContext(previous.context)) {
        authorityChanged();
        return;
      }
      if (result.request_id !== previous.requestId)
        throw Error("The account request status did not match this request.");
      const changedDetails =
        result.status === "created" && !matchesPerson(result.user, previous);
      remember({
        ...retained.current,
        status: result,
        error: changedDetails
          ? "The account currently returned for this request has different details. Review Workspace access before taking another action; this page has not selected that account."
          : "",
      });
      if (result.status === "created" && !changedDetails)
        onObserved(result.user);
      if (changedDetails) onReviewNeeded();
    } catch (failure) {
      if (observation.current !== controller || !retained.current) return;
      remember({
        ...retained.current,
        status: null,
        error: (failure as Error).message,
      });
    } finally {
      if (observation.current === controller) {
        observation.current = null;
        setChecking(false);
      }
    }
  }
  function closeReview() {
    stopWaiting(true);
  }
  function finishReview() {
    const previous = retained.current;
    if (
      !previous ||
      previous.phase === "sending" ||
      !previous.status ||
      previous.status.status === "not_found" ||
      checking
    )
      return;
    remember(null);
    setReviewOpen(false);
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
    remember({
      ...previous,
      context: now,
      phase: "unknown",
      status: null,
      error: "",
    });
  }

  return (
    <>
      {user.role === "admin" && (
        <Button ref={opener} icon={Plus} onClick={open}>
          {review ? "Review account creation" : "Add person"}
        </Button>
      )}
      <Modal
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          clearPassword();
        }}
        title="Add a workspace user"
        description="There is no public signup. Administrators create local accounts."
        returnFocusRef={opener}
      >
        <form onSubmit={(event) => void create(event)}>
          <div className="modal-body">
            {formError && <ErrorBox message={formError} />}
            <Field label="Full name">
              <input
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Email">
              <input
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field
              label="Initial password"
              hint="At least 12 characters. Share through a protected channel."
            >
              <input
                required
                minLength={12}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <RolePicker value={role} onChange={setRole} />
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
            <Button type="submit">Create user</Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={reviewOpen && !!review}
        onClose={closeReview}
        title={
          review?.phase === "sending"
            ? "Waiting for account creation"
            : review?.phase === "changed"
              ? "Your access changed"
              : "Account creation not confirmed"
        }
        description="Review this exact creation request before another attempt."
        returnFocusRef={opener}
      >
        <div className="modal-body">
          {review?.error && <ErrorBox message={review.error} />}
          {review?.phase === "sending" ? (
            <p role="status">
              Waiting for the server. You can stop waiting; the account may
              still be created.
            </p>
          ) : review?.phase === "changed" ? (
            <p>
              Your sign-in or role changed. This request may have completed.
              Sign in with administrator access to review workspace accounts.
            </p>
          ) : (
            review && (
              <>
                <p>
                  The response did not confirm creation of {review.email}. The
                  request ID is kept in this page so you can check or cancel
                  that exact attempt. Your submitted password is not retained.
                </p>
                <p>
                  <code className="account-request-id">{review.requestId}</code>
                </p>
                {review.status?.status === "created" &&
                  matchesPerson(review.status.user, review) && (
                    <p role="status">
                      This request created {review.status.user.name} (
                      {review.status.user.email}). Find the account under
                      Workspace access. If the initial password is unknown,
                      issue a password reset code.
                    </p>
                  )}
                {review.status?.status === "created" &&
                  !matchesPerson(review.status.user, review) && (
                    <p role="status">
                      The server reports that this request created an account,
                      but its current details differ from the original entry.
                      Review Workspace access before creating another person.
                    </p>
                  )}
                {review.status?.status === "cancelled" && (
                  <p role="status">
                    This request was cancelled. Its ID cannot create an account,
                    even if the earlier request arrives later.
                  </p>
                )}
                {review.status?.status === "not_found" && (
                  <p role="status">
                    This request has no committed result yet. An earlier send
                    could still finish. Cancel this request before starting a
                    separate account creation.
                  </p>
                )}
              </>
            )
          )}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={closeReview}>
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
            review.status?.status !== "created" &&
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
            (review.status?.status === "created" ||
              review.status?.status === "cancelled") && (
              <Button onClick={finishReview}>Finish review</Button>
            )}
          {review?.phase === "changed" &&
            review.context.userId === user.id &&
            user.role === "admin" && (
              <Button onClick={restoreReview}>Review original request</Button>
            )}
          {review?.phase === "changed" && (
            <Button
              onClick={() => {
                remember(null);
                setReviewOpen(false);
              }}
            >
              Dismiss old review
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}
