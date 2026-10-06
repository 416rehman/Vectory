import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { Check, Link2, Plus, Sparkles } from "lucide-react";
import { z } from "zod";
import { APIError, UserSchema, api, type Person, type User } from "./api";
import { normalizeAuthEmail, retryDelay } from "./authRequests";
import { useAccountAuthority, useLeaveGuard } from "./accountAuthority";
import {
  AuthField,
  CopyButton,
  PasswordField,
  Unconfirmed,
} from "./authControls";
import { NotSent, useKeyedRequest, type KeyedRequest } from "./keyedRequest";
import { generatePassword, passwordIssue } from "./passwordStrength";
import RolePicker from "./RolePicker";
import { firstName, type HeldLink } from "./AdminPasswordResetActions";
import { Button, Modal, Spinner } from "./ui";
import "./account.css";
import type { Notify } from "./toast";

type Draft = {
  name: string;
  email: string;
  role: User["role"];
  method: "invite" | "password";
};
type Created = { user: User; invite?: { code: string; expires_at: string } };
type Finished = {
  user: User;
  method: Draft["method"];
  /** Created, but the one-time response (and any invite link) was lost. */
  unseen: boolean;
};

const ReceiptSchema = z
  .object({
    request_id: z.uuid(),
    user: UserSchema,
    invite: z
      .object({
        code: z.string().regex(/^[a-f0-9]{64}$/),
        expires_at: z.string(),
      })
      .strict()
      .optional(),
  })
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

export type AddPersonHandle = { open: () => void };

const emptyDraft: Draft = {
  name: "",
  email: "",
  role: "viewer",
  method: "invite",
};

/**
 * Add a person: an invite link by default (they choose their own password),
 * or a password set now. Creation is a keyed request: the password is sent
 * once, a lost response is read back by its exact ID, and a second attempt
 * waits for a confirmed cancellation.
 */
export default function AddPersonActions({
  ref,
  user,
  notify,
  onCreated,
  onInvite,
  onNewLink,
  onLocate,
}: {
  ref?: Ref<AddPersonHandle>;
  user: User;
  notify: Notify;
  onCreated: (person: User) => void;
  onInvite: (link: HeldLink) => void;
  onNewLink: (person: Person) => void;
  onLocate: (email: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [password, setPassword] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [finished, setFinished] = useState<Finished | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const authority = useAccountAuthority(user, () => {
    setPassword("");
    setAdminPassword("");
    creation.authorityChanged();
    setFinished(null);
  });
  const creation = useKeyedRequest<Draft, Created>({
    authority,
    async read(request, signal) {
      const status = await api(
        `/users/requests/${request.id}`,
        { signal, headers: { "X-CSRF-Token": request.context.csrfToken } },
        StatusSchema,
      );
      if (status.request_id !== request.id)
        throw Error("The server described a different request.");
      return status.status === "created"
        ? { kind: "done", result: { user: status.user } }
        : status.status === "cancelled"
          ? { kind: "retry" }
          : { kind: "pending" };
    },
    async cancel(request, signal) {
      const status = await api(
        `/users/requests/${request.id}/cancel`,
        {
          method: "POST",
          body: "{}",
          signal,
          headers: { "X-CSRF-Token": request.context.csrfToken },
        },
        StatusSchema,
      );
      if (status.request_id !== request.id || status.status === "not_found")
        throw Error("The server didn't confirm the cancellation.");
      return status.status === "created"
        ? { kind: "done", result: { user: status.user } }
        : { kind: "retry" };
    },
    done(request, result, via) {
      const person = result.user;
      const expected = request.target;
      setPassword("");
      setAdminPassword("");
      onCreated(person);
      if (
        normalizeAuthEmail(person.email) !== expected.email ||
        person.name !== expected.name ||
        person.role !== expected.role
      ) {
        notify(
          `An account for ${person.email} exists, but its details changed. Review it in Workspace access.`,
          { tone: "info" },
        );
        return;
      }
      if (via === "receipt" && result.invite) {
        onInvite({
          userId: person.id,
          name: person.name,
          email: person.email,
          code: result.invite.code,
          purpose: "invite",
          expiresAt: result.invite.expires_at,
          owner: request.context,
          requestId: null,
          verifiedRevision: person.revision,
          doubt: "",
        });
        return;
      }
      setFinished({
        user: person,
        method: expected.method,
        unseen: via === "status",
      });
    },
  });
  useImperativeHandle(ref, () => ({ open }));
  const request = creation.request;
  useLeaveGuard(
    request && request.phase !== "form"
      ? "Leave before this account request is resolved? You'll need to check Workspace access later."
      : creation.open &&
          (draft.name || draft.email || password || adminPassword)
        ? "Discard this new person?"
        : null,
  );

  function open() {
    if (user.role !== "admin") return;
    setFinished(null);
    if (creation.begin(emptyDraft)) {
      setDraft(emptyDraft);
      setPassword("");
      setAdminPassword("");
      setRevealed(false);
    }
  }
  function change(next: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...next }));
    const fields = { ...request?.fields };
    for (const key of Object.keys(next)) delete fields[key];
    if (next.method) delete fields.password;
    delete fields.form;
    creation.edit({ fields });
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!request || request.phase !== "form") return;
    const target: Draft = {
      ...draft,
      name: draft.name.trim(),
      email: normalizeAuthEmail(draft.email),
    };
    const fields: Record<string, string> = {};
    if (!target.name) fields.name = "Enter their name.";
    else if (target.name.length > 100)
      fields.name = "Use 100 characters or fewer.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.email))
      fields.email = "Enter an email address like jane@example.com.";
    if (target.method === "password") {
      const weak = passwordIssue(password, [target.email, target.name]);
      if (weak) fields.password = weak;
    }
    if (!adminPassword)
      fields.adminPassword = "Enter your password to add a person.";
    if (Object.keys(fields).length) {
      creation.edit({ fields });
      return;
    }
    const secret = password;
    const currentPassword = adminPassword;
    // The password is sent once and never kept for a replay.
    setPassword("");
    setAdminPassword("");
    creation.edit({ target });
    await creation.send(
      async (attempt, signal) => {
        const headers = { "X-CSRF-Token": attempt.context.csrfToken };
        try {
          const preflight = await api(
            `/users/requests/${attempt.id}`,
            { signal, headers },
            StatusSchema,
          );
          if (
            preflight.request_id !== attempt.id ||
            preflight.status !== "not_found"
          )
            throw Error();
        } catch {
          throw new NotSent(
            "We couldn't reach Vectory, so nothing was sent. Try again.",
          );
        }
        const receipt = await api(
          "/users",
          {
            method: "POST",
            body: JSON.stringify({
              request_id: attempt.id,
              name: target.name,
              email: target.email,
              role: target.role,
              current_password: currentPassword,
              ...(target.method === "invite"
                ? { invite: true }
                : { password: secret }),
            }),
            signal,
            headers,
          },
          ReceiptSchema,
        );
        if (
          receipt.request_id !== attempt.id ||
          (target.method === "invite") !== !!receipt.invite
        )
          throw Error("The account receipt didn't match this request.");
        return { user: receipt.user, invite: receipt.invite };
      },
      (failure) => {
        const error = failure instanceof APIError ? failure : null;
        const wait = retryDelay(failure);
        if (error?.code === "EMAIL_TAKEN")
          return { email: `Someone already uses ${target.email}.` };
        if (error?.code === "EMAIL_INVALID") return { email: error.message };
        if (error?.code === "NAME_INVALID") return { name: error.message };
        if (error?.code === "PASSWORD_TOO_WEAK")
          return {
            password: `${error.message} Enter a password again.`,
          };
        if (error?.code === "WRONG_PASSWORD")
          return {
            adminPassword: "Your password didn't match.",
            ...(target.method === "password"
              ? { password: "Enter their password again." }
              : {}),
          };
        return {
          form: wait
            ? `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`
            : (failure as Error).message,
        };
      },
    );
  }
  function close() {
    setPassword("");
    setAdminPassword("");
    if (finished) {
      setFinished(null);
      return;
    }
    creation.close();
  }

  const name = firstName(finished?.user.name || draft.name.trim());
  const origin = `${location.origin}${location.pathname}`;
  const instructions = finished
    ? `Sign in to Vectory at ${origin} as ${finished.user.email}. I'll send your password separately.`
    : "";
  const phase = request?.phase;

  return (
    <>
      {user.role === "admin" && (
        <Button ref={opener} icon={Plus} onClick={open}>
          Add person
        </Button>
      )}
      <Modal
        open={creation.open || !!finished}
        title={
          finished
            ? finished.unseen && finished.method === "invite"
              ? `${finished.user.name}'s account is ready`
              : `${finished.user.name} can sign in now`
            : phase === "changed"
              ? "Your sign-in changed"
              : "Add a person"
        }
        description={
          finished
            ? finished.user.email
            : phase === "form" || phase === "sending"
              ? "Everyone gets their own sign-in. There's no public sign-up."
              : request?.target.email
        }
        onClose={close}
        returnFocusRef={opener}
        className="add-person-dialog"
      >
        {finished ? (
          <>
            <div className="modal-body link-result">
              {finished.unseen && finished.method === "invite" ? (
                <p>
                  We couldn't show the invite link. Create a new one to send to{" "}
                  {name}.
                </p>
              ) : finished.unseen ? (
                <p>
                  {name} signs in with the password you chose. If you no longer
                  have it, create a reset link instead.
                </p>
              ) : (
                <>
                  <p>
                    Send {name} the sign-in details, then the password through a
                    separate channel only they can read.
                  </p>
                  <div className="instructions">
                    <p>{instructions}</p>
                    <CopyButton
                      text={instructions}
                      label="Copy sign-in instructions"
                      copiedLabel="Instructions copied"
                    />
                  </div>
                  <p>
                    {name} can turn on two-factor authentication after signing
                    in.
                  </p>
                </>
              )}
            </div>
            <div className="modal-footer">
              {finished.unseen && (
                <Button
                  variant="secondary"
                  icon={Link2}
                  onClick={() => {
                    const person = finished.user;
                    setFinished(null);
                    onNewLink({
                      ...person,
                      status:
                        finished.method === "invite" ? "invited" : "active",
                    });
                  }}
                >
                  {finished.method === "invite"
                    ? "Create invite link"
                    : "Create reset link"}
                </Button>
              )}
              <Button icon={Check} onClick={() => setFinished(null)}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} noValidate>
            <div className="modal-body">
              <CreationBody
                request={request}
                draft={draft}
                userEmail={user.email}
                change={change}
                password={password}
                setPassword={setPassword}
                adminPassword={adminPassword}
                setAdminPassword={(value) => {
                  setAdminPassword(value);
                  if (request?.fields.adminPassword) {
                    const fields = { ...request.fields };
                    delete fields.adminPassword;
                    creation.edit({ fields });
                  }
                }}
                revealed={revealed}
                setRevealed={setRevealed}
                onLocate={(email) => {
                  creation.forget();
                  onLocate(email);
                }}
              />
            </div>
            <div className="modal-footer">
              <Button variant="secondary" onClick={close}>
                {phase === "sending"
                  ? "Stop waiting"
                  : phase === "form"
                    ? "Cancel"
                    : "Not now"}
              </Button>
              {phase === "form" || phase === "sending" ? (
                <Button type="submit" busy={phase === "sending"}>
                  {draft.method === "invite"
                    ? "Create invite link"
                    : "Add person"}
                </Button>
              ) : phase === "unconfirmed" ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => void creation.cancelAndRetry()}
                  >
                    Cancel it and try again
                  </Button>
                  <Button autoFocus onClick={() => void creation.check()}>
                    Check again
                  </Button>
                </>
              ) : phase === "pending" ? (
                <Button
                  autoFocus
                  onClick={() => void creation.cancelAndRetry()}
                >
                  Cancel it and try again
                </Button>
              ) : phase === "changed" ? (
                <Button autoFocus onClick={() => void creation.recheck()}>
                  Check again
                </Button>
              ) : (
                <Button busy disabled>
                  Checking
                </Button>
              )}
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

function CreationBody({
  request,
  draft,
  userEmail,
  change,
  password,
  setPassword,
  adminPassword,
  setAdminPassword,
  revealed,
  setRevealed,
  onLocate,
}: {
  request: KeyedRequest<Draft> | null;
  draft: Draft;
  userEmail: string;
  change: (next: Partial<Draft>) => void;
  password: string;
  setPassword: (value: string) => void;
  adminPassword: string;
  setAdminPassword: (value: string) => void;
  revealed: boolean;
  setRevealed: (value: boolean) => void;
  onLocate: (email: string) => void;
}) {
  if (!request) return null;
  const who = request.target.name || request.target.email;
  if (request.phase === "checking" || request.phase === "cancelling")
    return (
      <p className="signin-loading" role="status">
        <Spinner />
        {request.phase === "checking"
          ? `Checking whether ${who}'s account was created…`
          : "Cancelling the earlier request…"}
      </p>
    );
  if (request.phase === "changed")
    return (
      <Unconfirmed title="We couldn't confirm the new account">
        <p>
          Your sign-in changed while this was in progress. Sign in again as the
          same administrator, then check again.
        </p>
      </Unconfirmed>
    );
  if (request.phase === "unconfirmed" || request.phase === "pending")
    return (
      <Unconfirmed
        title={
          request.phase === "pending"
            ? `We couldn't confirm ${who}'s account was created`
            : "We couldn't confirm that"
        }
        details={
          <>
            Request <code>{request.id}</code>
          </>
        }
      >
        <p>
          {request.phase === "pending"
            ? "It might still go through. Cancel it first, then try again. Your entries stay filled in."
            : "Check your connection, then check again."}
        </p>
      </Unconfirmed>
    );
  const first = firstName(draft.name.trim());
  return (
    <fieldset disabled={request.phase === "sending"}>
      {request.notice && (
        <p className="signin-notice" role="status">
          {request.notice}
        </p>
      )}
      {request.fields.form && (
        <p className="signin-alert" role="alert">
          {request.fields.form}
        </p>
      )}
      <AuthField label="Name" error={request.fields.name}>
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            name="person-name"
            autoComplete="off"
            data-1p-ignore
            maxLength={100}
            autoFocus
            value={draft.name}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => change({ name: event.target.value })}
          />
        )}
      </AuthField>
      <AuthField
        label="Email"
        error={request.fields.email}
        labelAction={
          request.fields.email?.startsWith("Someone already uses") ? (
            <button
              type="button"
              className="text-link"
              onClick={() => onLocate(normalizeAuthEmail(draft.email))}
            >
              Show in Workspace access
            </button>
          ) : undefined
        }
      >
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            name="person-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            data-1p-ignore
            autoCapitalize="none"
            spellCheck={false}
            value={draft.email}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => change({ email: event.target.value })}
          />
        )}
      </AuthField>
      <RolePicker
        value={draft.role}
        onChange={(role) => change({ role })}
        person={first || undefined}
      />
      <fieldset className="choice-group">
        <legend>How they'll sign in</legend>
        <label className="choice">
          <input
            type="radio"
            name="sign-in-method"
            checked={draft.method === "invite"}
            onChange={() => change({ method: "invite" })}
          />
          <span>
            <strong>Send an invite link</strong>
            <small>
              They choose their own password. The link works once, for 24 hours.
            </small>
          </span>
        </label>
        <label className="choice">
          <input
            type="radio"
            name="sign-in-method"
            checked={draft.method === "password"}
            onChange={() => change({ method: "password" })}
          />
          <span>
            <strong>Set a password now</strong>
            <small>You choose it and share it with them privately.</small>
          </span>
        </label>
      </fieldset>
      {draft.method === "password" && (
        <>
          <PasswordField
            label={first ? `Password for ${first}` : "Password"}
            name="person-password"
            autoComplete="off"
            value={password}
            onChange={setPassword}
            error={request.fields.password}
            showStrength
            identity={[draft.email, draft.name]}
            revealed={revealed}
            onReveal={setRevealed}
          />
          <div className="password-tools">
            <Button
              variant="secondary compact"
              icon={Sparkles}
              onClick={() => {
                setPassword(generatePassword());
                setRevealed(true);
              }}
            >
              Generate
            </Button>
            {password && <CopyButton text={password} label="Copy password" />}
          </div>
        </>
      )}
      <p className="control-note">
        Confirm your password before giving someone access to this workspace.
      </p>
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={userEmail}
        readOnly
        hidden
      />
      <PasswordField
        label="Your password"
        name="admin-current-password"
        autoComplete="current-password"
        value={adminPassword}
        onChange={setAdminPassword}
        error={request.fields.adminPassword}
      />
    </fieldset>
  );
}
