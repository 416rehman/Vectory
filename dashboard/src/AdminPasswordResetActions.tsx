import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { Link2 } from "lucide-react";
import { z } from "zod";
import { APIError, api, type Person, type User } from "./api";
import { retryDelay } from "./authRequests";
import {
  useAccountAuthority,
  useLeaveGuard,
  type AccountContext,
} from "./accountAuthority";
import {
  CopyButton,
  CopyLine,
  PasswordField,
  Unconfirmed,
  formatExpiry,
} from "./authControls";
import {
  NotSent,
  useKeyedRequest,
  type KeyedRequest,
  type Resolution,
} from "./keyedRequest";
import { Button, Modal, Spinner } from "./ui";
import "./account.css";
import type { Notify } from "./toast";

/** A single-use sign-in link held only in this page's memory. */
export type HeldLink = {
  userId: string;
  name: string;
  email: string;
  code: string;
  purpose: "invite" | "reset";
  expiresAt: string;
  owner: AccountContext;
  /** The reset request that issued it; invitations from Add person have none. */
  requestId: string | null;
  /** The account revision this link was last known to be valid for. */
  verifiedRevision: number;
  /** Why validity is uncertain: check with the server before sharing. */
  doubt: string;
};

export function linkUrl(link: Pick<HeldLink, "code" | "purpose">) {
  return `${location.origin}${location.pathname}#/${link.purpose}?code=${link.code}`;
}
export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

const ReceiptSchema = z
  .object({
    request_id: z.uuid(),
    user_id: z.uuid(),
    code: z.string().regex(/^[a-f0-9]{64}$/),
    expires_at: z.string(),
    purpose: z.enum(["invite", "reset"]).optional(),
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
type Receipt = z.infer<typeof ReceiptSchema>;

export type AdminPasswordResetHandle = {
  /** Create a new reset link (or invite link, for someone never signed in). */
  open: (person: Person) => void;
  /** Show a link this page still holds. */
  show: (userId: string) => void;
};

/**
 * Reset and invitation links for other people. Each issue is a keyed request:
 * the administrator's password is sent once, a lost response is read back by
 * its exact ID, and a second link needs the first one cancelled. Links stay
 * in memory until marked done, and are checked with the server before sharing
 * whenever they might have stopped working.
 */
export default function AdminPasswordResetActions({
  ref,
  user,
  people,
  reloadPeople,
  links,
  onLinksChange,
  notify,
}: {
  ref?: Ref<AdminPasswordResetHandle>;
  user: User;
  people: Person[];
  reloadPeople: () => Promise<Person[] | undefined>;
  links: Record<string, HeldLink>;
  onLinksChange: (
    update: (links: Record<string, HeldLink>) => Record<string, HeldLink>,
  ) => void;
  notify: Notify;
}) {
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [ended, setEnded] = useState<{
    person: Person;
    message: string;
  } | null>(null);
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const linksRef = useRef(links);
  linksRef.current = links;
  const authority = useAccountAuthority(user, () => {
    issue.authorityChanged();
    setPassword("");
    // A link belongs to the sign-in that created it.
    if (Object.keys(linksRef.current).length) {
      onLinksChange(() => ({}));
      setShown(null);
      notify("Held sign-in links were hidden because your sign-in changed.", {
        tone: "info",
      });
    }
  });
  const statusPath = (request: { target: { id: string }; id: string }) =>
    `/users/${request.target.id}/password-reset/requests/${request.id}`;
  const issue = useKeyedRequest<Person, Receipt>({
    authority,
    async read(request, signal) {
      const status = await api(
        statusPath(request),
        { signal, headers: { "X-CSRF-Token": request.context.csrfToken } },
        StatusSchema,
      );
      matches(status, request);
      return status.status === "not_found"
        ? { kind: "pending" }
        : status.status === "issued" && status.active
          ? { kind: "unseen" }
          : {
              kind: "retry",
              notice:
                status.status === "issued"
                  ? "A link was created but no longer works. Create a new one."
                  : "",
            };
    },
    async cancel(request, signal) {
      const status = await api(
        `${statusPath(request)}/cancel`,
        {
          method: "POST",
          body: "{}",
          signal,
          headers: { "X-CSRF-Token": request.context.csrfToken },
        },
        StatusSchema,
      );
      matches(status, request);
      if (status.status !== "cancelled")
        throw Error("The link request wasn't cancelled.");
      return { kind: "retry" } satisfies Resolution<Receipt>;
    },
    done(request, receipt, via) {
      if (via !== "receipt") return;
      const person = request.target;
      onLinksChange((current) => ({
        ...current,
        [person.id]: {
          userId: person.id,
          name: person.name,
          email: person.email,
          code: receipt.code,
          purpose:
            receipt.purpose ??
            (person.status === "invited" ? "invite" : "reset"),
          expiresAt: receipt.expires_at,
          owner: request.context,
          requestId: request.id,
          verifiedRevision: person.revision + 1,
          doubt: "",
        },
      }));
      setShown(person.id);
      void reloadPeople();
    },
  });
  function matches(
    status: { request_id: string; user_id: string },
    request: { id: string; target: Person },
  ) {
    if (
      status.request_id !== request.id ||
      status.user_id !== request.target.id
    )
      throw Error("The server described a different request.");
  }

  useImperativeHandle(ref, () => ({
    open(person) {
      if (linksRef.current[person.id]) {
        setShown(person.id);
        return;
      }
      setEnded(null);
      setPassword("");
      issue.begin(person);
    },
    show(userId) {
      // A just-created invitation may reach `links` in the same update.
      setShown(userId);
    },
  }));

  // Doubt a held link when the account changed or the clock says it expired.
  useEffect(() => {
    const now = Date.now();
    let changed = false;
    const next = { ...links };
    for (const link of Object.values(links)) {
      if (link.doubt) continue;
      const person = people.find((entry) => entry.id === link.userId);
      // A person missing from the list is only a list that hasn't caught up.
      const doubt =
        person && !person.enabled
          ? `${firstName(link.name)}'s access changed since this link was created.`
          : person && person.revision > link.verifiedRevision
            ? `${firstName(link.name)}'s account changed since this link was created.`
            : Date.parse(link.expiresAt) <= now
              ? "This link may have expired."
              : "";
      if (doubt) {
        next[link.userId] = { ...link, doubt };
        changed = true;
      }
    }
    if (changed) onLinksChange(() => next);
    const soonest = Math.min(
      ...Object.values(links)
        .filter((link) => !link.doubt)
        .map((link) => Date.parse(link.expiresAt)),
    );
    if (!Number.isFinite(soonest)) return;
    const timer = setTimeout(
      () => onLinksChange((current) => ({ ...current })),
      Math.max(0, soonest - now) + 500,
    );
    return () => clearTimeout(timer);
  }, [links, people]);

  const held = Object.values(links);
  useLeaveGuard(
    held.length
      ? `Leave without sharing ${held.length === 1 ? `the link for ${firstName(held[0].name)}` : "the sign-in links"}? You can create new ones later.`
      : issue.request && issue.request.phase !== "form"
        ? "Leave before this link request is resolved? You'll need to check the person's account later."
        : null,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const request = issue.request;
    if (!request || request.phase !== "form") return;
    if (!password) {
      issue.edit({ fields: { password: "Enter your password." } });
      return;
    }
    const latest = peopleRef.current.find(
      (person) => person.id === request.target.id,
    );
    if (!latest || !latest.enabled) {
      issue.edit({
        fields: {
          form: `Turn ${firstName(request.target.name)}'s access back on before creating a link.`,
        },
      });
      return;
    }
    const secret = password;
    // The password is sent once and never kept for a replay.
    setPassword("");
    issue.edit({ target: latest });
    await issue.send(
      async (attempt, signal) => {
        const headers = { "X-CSRF-Token": attempt.context.csrfToken };
        try {
          const preflight = await api(
            statusPath(attempt),
            { signal, headers },
            StatusSchema,
          );
          matches(preflight, attempt);
          if (preflight.status !== "not_found") throw Error();
        } catch {
          throw new NotSent(
            "We couldn't reach Vectory, so nothing was sent. Try again.",
          );
        }
        const receipt = await api(
          `/users/${attempt.target.id}/password-reset`,
          {
            method: "POST",
            body: JSON.stringify({
              request_id: attempt.id,
              current_password: secret,
              revision: latest.revision,
            }),
            signal,
            headers,
          },
          ReceiptSchema,
        );
        if (
          receipt.request_id !== attempt.id ||
          receipt.user_id !== attempt.target.id ||
          !Number.isFinite(Date.parse(receipt.expires_at))
        )
          throw Error("The link receipt didn't match this request.");
        return receipt;
      },
      (failure) => {
        const code = failure instanceof APIError ? failure.code : "";
        const wait = retryDelay(failure);
        if (code === "WRONG_PASSWORD")
          return { password: "Your password didn't match." };
        if (code === "STALE_REVISION") {
          void reloadPeople();
          return {
            form: `${firstName(request.target.name)}'s account just changed. Enter your password again to use the latest details.`,
          };
        }
        return {
          form: wait
            ? `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`
            : (failure as Error).message,
        };
      },
    );
  }

  async function verify(link: HeldLink) {
    if (checking) return false;
    if (!authority.usable(link.owner, true)) return false;
    setChecking(link.userId);
    try {
      let valid = false;
      let revision = link.verifiedRevision;
      if (link.requestId) {
        const status = await api(
          statusPath({ id: link.requestId, target: { id: link.userId } }),
          { headers: { "X-CSRF-Token": link.owner.csrfToken } },
          StatusSchema,
        );
        valid =
          status.status === "issued" &&
          status.active &&
          status.expires_at === link.expiresAt;
        const latest = (await reloadPeople())?.find(
          (person) => person.id === link.userId,
        );
        revision = latest?.revision ?? revision;
      } else {
        const latest = (await reloadPeople())?.find(
          (person) => person.id === link.userId,
        );
        valid =
          !!latest &&
          latest.enabled &&
          latest.status === "invited" &&
          latest.invite_expires_at === link.expiresAt;
        revision = latest?.revision ?? revision;
      }
      if (!authority.usable(link.owner, true) || !linksRef.current[link.userId])
        return false;
      if (valid) {
        onLinksChange((current) => ({
          ...current,
          [link.userId]: { ...link, verifiedRevision: revision, doubt: "" },
        }));
        return true;
      }
      discard(link.userId);
      const person = peopleRef.current.find(
        (entry) => entry.id === link.userId,
      );
      if (person)
        setEnded({
          person,
          message: `This link no longer works. It may have been used, replaced or expired.`,
        });
      return false;
    } catch {
      if (linksRef.current[link.userId])
        onLinksChange((current) => ({
          ...current,
          [link.userId]: {
            ...link,
            doubt:
              "We couldn't check this link. Check your connection and try again.",
          },
        }));
      return false;
    } finally {
      setChecking(null);
    }
  }
  function discard(userId: string) {
    onLinksChange((current) => {
      const next = { ...current };
      delete next[userId];
      return next;
    });
    setShown((value) => (value === userId ? null : value));
  }
  async function revoke(link: HeldLink) {
    if (!link.requestId || checking) return;
    if (!authority.usable(link.owner, true)) return;
    setChecking(link.userId);
    try {
      const status = await api(
        `${statusPath({ id: link.requestId, target: { id: link.userId } })}/cancel`,
        {
          method: "POST",
          body: "{}",
          headers: { "X-CSRF-Token": link.owner.csrfToken },
        },
        StatusSchema,
      );
      if (status.status !== "cancelled") throw Error();
      discard(link.userId);
      notify(`Link for ${firstName(link.name)} revoked.`, { tone: "success" });
      void reloadPeople();
    } catch {
      onLinksChange((current) =>
        current[link.userId]
          ? {
              ...current,
              [link.userId]: {
                ...link,
                doubt:
                  "We couldn't revoke this link. Check your connection and try again.",
              },
            }
          : current,
      );
    } finally {
      setChecking(null);
    }
  }

  const request = issue.request;
  const target = request?.target;
  const invite = target?.status === "invited";
  const name = target ? firstName(target.name) : "";
  const link = shown ? links[shown] : null;

  return (
    <>
      <Modal
        open={issue.open && !!request}
        title={
          request?.phase === "changed"
            ? "Your sign-in changed"
            : invite
              ? `New invite link for ${name}`
              : `Reset ${name}'s password`
        }
        description={
          request?.phase === "form"
            ? invite
              ? `${name} gets a new single-use link to choose a password. It works for 24 hours, and earlier links stop working.`
              : `${name} gets a single-use link to choose a new password. It works for 15 minutes, and earlier links stop working.${target?.mfa_enabled ? " Two-factor stays on." : ""}`
            : target?.email
        }
        onClose={() => {
          setPassword("");
          issue.close();
        }}
      >
        <form onSubmit={(event) => void submit(event)} noValidate>
          <div className="modal-body">
            <IssueBody
              request={request}
              person={name}
              password={password}
              setPassword={setPassword}
              email={user.email}
            />
          </div>
          <div className="modal-footer">
            <Button
              variant="secondary"
              onClick={() => {
                setPassword("");
                issue.close();
              }}
            >
              {request?.phase === "sending"
                ? "Stop waiting"
                : request?.phase === "form"
                  ? "Cancel"
                  : "Not now"}
            </Button>
            {request?.phase === "form" || request?.phase === "sending" ? (
              <Button type="submit" busy={request.phase === "sending"}>
                Create {invite ? "invite" : "reset"} link
              </Button>
            ) : request?.phase === "unconfirmed" ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => void issue.cancelAndRetry()}
                >
                  Cancel it and try again
                </Button>
                <Button autoFocus onClick={() => void issue.check()}>
                  Check again
                </Button>
              </>
            ) : request?.phase === "pending" || request?.phase === "unseen" ? (
              <Button autoFocus onClick={() => void issue.cancelAndRetry()}>
                {request.phase === "unseen"
                  ? "Cancel it and create a new link"
                  : "Cancel it and try again"}
              </Button>
            ) : request?.phase === "changed" ? (
              <Button autoFocus onClick={() => void issue.recheck()}>
                Check again
              </Button>
            ) : (
              <Button busy disabled>
                Checking
              </Button>
            )}
          </div>
        </form>
      </Modal>

      {link && (
        <LinkDialog
          link={link}
          checking={checking === link.userId}
          onClose={() => setShown(null)}
          onDone={() => discard(link.userId)}
          onCheck={() => void verify(link)}
          onRevoke={link.requestId ? () => void revoke(link) : undefined}
        />
      )}

      <Modal
        open={!!ended}
        title="This link no longer works"
        description={ended?.person.email}
        onClose={() => setEnded(null)}
      >
        <div className="modal-body">
          <p className="modal-copy">{ended?.message}</p>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setEnded(null)}>
            Close
          </Button>
          <Button
            autoFocus
            icon={Link2}
            onClick={() => {
              const person = ended?.person;
              setEnded(null);
              if (person) {
                setPassword("");
                issue.begin(
                  peopleRef.current.find((entry) => entry.id === person.id) ||
                    person,
                );
              }
            }}
          >
            Create a new link
          </Button>
        </div>
      </Modal>
    </>
  );
}

function IssueBody({
  request,
  person,
  password,
  setPassword,
  email,
}: {
  request: KeyedRequest<Person> | null;
  person: string;
  password: string;
  setPassword: (value: string) => void;
  email: string;
}) {
  if (!request) return null;
  if (request.phase === "checking" || request.phase === "cancelling")
    return (
      <p className="signin-loading" role="status">
        <Spinner />
        {request.phase === "checking"
          ? "Checking whether the link was created…"
          : "Cancelling the earlier request…"}
      </p>
    );
  if (request.phase === "changed")
    return (
      <Unconfirmed title="We couldn't confirm the link">
        <p>
          Your sign-in changed while this was in progress. Sign in again as the
          same administrator, then check again.
        </p>
      </Unconfirmed>
    );
  if (request.phase === "unconfirmed")
    return (
      <Unconfirmed
        details={
          <>
            Request <code>{request.id}</code>
          </>
        }
      >
        <p>
          We couldn't tell whether a link for {person} was created. Check your
          connection, then check again.
        </p>
      </Unconfirmed>
    );
  if (request.phase === "pending" || request.phase === "unseen")
    return (
      <Unconfirmed
        title={
          request.phase === "unseen"
            ? "A link was created, but we couldn't show it"
            : "We couldn't confirm a link was created"
        }
        details={
          <>
            Request <code>{request.id}</code>
          </>
        }
      >
        <p>
          {request.phase === "unseen"
            ? `Links are shown only once. Cancel it, then create a new one for ${person}.`
            : "It might still go through. Cancel it first, then create a new one."}
        </p>
      </Unconfirmed>
    );
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
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={email}
        readOnly
        hidden
      />
      <PasswordField
        label="Your password"
        name="current-password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={request.fields.password}
        hint="Confirm it's you."
        autoFocus
      />
    </fieldset>
  );
}

/** The link, how long it works, and the message to send with it. */
export function LinkDialog({
  link,
  checking,
  onClose,
  onDone,
  onCheck,
  onRevoke,
}: {
  link: HeldLink;
  checking: boolean;
  onClose: () => void;
  onDone: () => void;
  onCheck: () => void;
  onRevoke?: () => void;
}) {
  const url = linkUrl(link);
  const name = firstName(link.name);
  const until = formatExpiry(link.expiresAt);
  const message =
    link.purpose === "invite"
      ? `You're invited to Vectory. Open this link to choose your password and sign in as ${link.email}:\n${url}\nIt works once, until ${until}.`
      : `Here's a link to reset your Vectory password for ${link.email}:\n${url}\nIt works once, until ${until}.`;
  return (
    <Modal
      open
      title={`${link.purpose === "invite" ? "Invite" : "Reset"} link for ${link.name}`}
      description={`Send ${name} this link. It works once, until ${until}.`}
      onClose={onClose}
      className="link-dialog"
    >
      <div className="modal-body link-result">
        {link.doubt ? (
          <Unconfirmed
            title="Check this link before sharing it"
            actions={
              <Button
                variant="secondary compact"
                busy={checking}
                onClick={onCheck}
              >
                Check link
              </Button>
            }
          >
            <p>{link.doubt}</p>
          </Unconfirmed>
        ) : (
          <>
            <CopyLine
              value={url}
              label={`${link.purpose} link`}
              copyLabel="Copy link"
              wrap
            />
            <div className="link-result-actions">
              <CopyButton
                text={message}
                label="Copy message"
                copiedLabel="Message copied"
                variant="ghost compact"
              />
            </div>
          </>
        )}
        <p>
          {link.purpose === "invite"
            ? `${name} chooses a password and can then turn on two-factor authentication.`
            : `${name}'s current password keeps working until the link is used.`}{" "}
          Anyone with the link can use it, so send it privately.
        </p>
      </div>
      <div className="modal-footer dialog-footer-split">
        {onRevoke && (
          <Button
            variant="danger-ghost compact"
            disabled={checking}
            onClick={onRevoke}
          >
            Revoke link
          </Button>
        )}
        <div>
          <Button onClick={onDone} disabled={checking}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
