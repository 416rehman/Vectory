import { useEffect, useRef, useState } from "react";
import {
  Check,
  Eye,
  Pencil,
  Rocket,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Person, User } from "./api";
import { ErrorBox, IconButton, PageHeader, useResource, Button } from "./ui";
import { AccountActions } from "./AccountActions";
import { WorkspaceAccess } from "./AccountAccess";
import MfaActions, { type MfaActionsHandle } from "./MfaActions";
import AddPersonActions, { type AddPersonHandle } from "./AddPersonActions";
import AdminPasswordResetActions, {
  type AdminPasswordResetHandle,
  type HeldLink,
} from "./AdminPasswordResetActions";
import { RoleMatrix } from "./RolePicker";
import { roles } from "./roles";
import type { MfaStatus } from "./mfaActionModel";
import "./control.css";
import "./account.css";
import type { Notify } from "./toast";

const roleIcons: Record<User["role"], LucideIcon> = {
  viewer: Eye,
  editor: Pencil,
  operator: Rocket,
  admin: ShieldCheck,
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] || "") + (parts.length > 1 ? parts.at(-1)![0] : "")
  ).toUpperCase();
}

/** What the page was opened to do: `#/users?setup=two-factor` or `?add=person`. */
function readIntent() {
  const query = new URLSearchParams(location.hash.split("?")[1] || "");
  return query.get("setup") === "two-factor"
    ? "two-factor"
    : query.get("add") === "person"
      ? "add-person"
      : null;
}

export function UsersSecurity({
  user,
  notify,
  onUserChanged,
  onSignIn,
  onReload,
}: {
  user: User;
  notify: Notify;
  onUserChanged: (user: User | null) => void;
  onSignIn: () => void;
  onReload: () => void;
}) {
  // The account's role, not the live session: while a re-sign-in dialog is
  // open, forms and unresolved requests on this page must stay mounted.
  const admin = user.role === "admin";
  const people = useResource<Person[]>(admin ? "/users" : null, []);
  const mfa = useResource<MfaStatus>("/mfa", { enabled: false });
  const [links, setLinks] = useState<Record<string, HeldLink>>({});
  const [savedPerson, setSavedPerson] = useState<User | null>(null);
  const [locateEmail, setLocateEmail] = useState<string | null>(null);
  const [intent, setIntent] = useState(readIntent);
  const mfaActions = useRef<MfaActionsHandle>(null);
  const addPerson = useRef<AddPersonHandle>(null);
  const resets = useRef<AdminPasswordResetHandle>(null);
  const reloadPeople = people.reloadResult;
  // Turning two-factor on or off ends other sessions and changes the table.
  const [security, setSecurity] = useState(0);
  const lastTwoFactor = useRef<boolean | null>(null);
  useEffect(() => {
    if (mfa.loading || mfa.error) return;
    if (
      lastTwoFactor.current !== null &&
      lastTwoFactor.current !== mfa.data.enabled
    ) {
      setSecurity((value) => value + 1);
      if (admin) void people.reload();
    }
    lastTwoFactor.current = mfa.data.enabled;
  }, [mfa.data.enabled, mfa.loading, mfa.error]);

  // Links from the first-run checklist open the step they name, once.
  useEffect(() => {
    const changed = () => setIntent(readIntent());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    if (!intent) return;
    if (intent === "two-factor") {
      if (mfa.loading) return;
      if (!mfa.data.enabled && !mfa.error) mfaActions.current?.setup();
    } else if (admin) addPerson.current?.open();
    setIntent(null);
    history.replaceState(null, "", "#/users");
  }, [intent, mfa.loading, mfa.data.enabled, mfa.error, admin]);

  const RoleIcon = roleIcons[user.role];
  return (
    <div className="control-page account-page">
      <PageHeader
        title="People & security"
        description={
          admin
            ? "Your sign-in security, and who can use this workspace."
            : "Your sign-in security. Administrators manage who can use this workspace."
        }
        help={{ topic: "administer" }}
      >
        {admin && (
          <AddPersonActions
            ref={addPerson}
            user={user}
            notify={notify}
            onCreated={(person) => {
              setSavedPerson(person);
              void people.reload();
            }}
            onInvite={(link) => {
              setLinks((current) => ({ ...current, [link.userId]: link }));
              resets.current?.show(link.userId);
            }}
            onNewLink={(person) => resets.current?.open(person)}
            onLocate={setLocateEmail}
          />
        )}
      </PageHeader>

      {admin && (
        <SecureChecklist
          user={user}
          twoFactor={mfa.loading || !!mfa.error ? null : mfa.data.enabled}
          people={people.loading || !!people.error ? null : people.data.length}
          onTwoFactor={() => mfaActions.current?.setup()}
          onInvite={() => addPerson.current?.open()}
        />
      )}

      <section
        className="control-card account-card"
        aria-labelledby="account-heading"
      >
        <div className="account-identity">
          <span className="account-avatar" aria-hidden="true">
            {initials(user.name)}
          </span>
          <div>
            <h2 id="account-heading">{user.name}</h2>
            <p>{user.email}</p>
          </div>
          <span className="role-badge" title={roles[user.role][1]}>
            <RoleIcon size={14} aria-hidden="true" />
            {roles[user.role][0]}
          </span>
        </div>
        {!admin && (
          <div className="account-row account-role">
            <div className="account-row-copy">
              <h3>Your role</h3>
              <p>
                <strong>{roles[user.role][0]}.</strong> {roles[user.role][1]} To
                change it, ask an administrator.
              </p>
              <details className="role-reference compact">
                <summary>What each role can do</summary>
                <RoleMatrix current={user.role} />
              </details>
            </div>
          </div>
        )}
        <AccountActions
          key={`account:${user.id}`}
          user={user}
          notify={notify}
          onUserChanged={onUserChanged}
          onChanged={() => void (admin && people.reload())}
          onSignIn={onSignIn}
          onReload={onReload}
          refresh={security}
        >
          {({ password, sessions }) => (
            <>
              {password}
              <MfaActions
                key={`mfa:${user.id}`}
                ref={mfaActions}
                user={user}
                status={mfa}
                notify={notify}
              />
              {sessions}
            </>
          )}
        </AccountActions>
      </section>

      {admin &&
        (people.error && !people.data.length ? (
          <ErrorBox message={people.error} retry={() => void people.reload()} />
        ) : (
          <WorkspaceAccess
            user={user}
            people={people.data}
            loading={people.loading}
            reload={() => void people.reload()}
            reloadPeople={reloadPeople}
            notify={notify}
            onUserChanged={onUserChanged}
            savedPerson={savedPerson}
            onPersonLocated={() => setSavedPerson(null)}
            links={links}
            onShowLink={(id) => resets.current?.show(id)}
            onNewLink={(person) => resets.current?.open(person)}
            locateEmail={locateEmail}
            onEmailLocated={() => setLocateEmail(null)}
          />
        ))}
      {admin && (
        <AdminPasswordResetActions
          ref={resets}
          user={user}
          people={people.data}
          reloadPeople={reloadPeople}
          links={links}
          onLinksChange={setLinks}
          notify={notify}
        />
      )}
    </div>
  );
}

const HIDDEN_KEY = "vectory-secure-checklist-hidden";

/**
 * The first-run steps that make a workspace safe to share, from real state:
 * two-factor on this account, a teammate invited, and a first device. Gone
 * once done, or when this administrator hides it.
 */
function SecureChecklist({
  user,
  twoFactor,
  people,
  onTwoFactor,
  onInvite,
}: {
  user: User;
  twoFactor: boolean | null;
  people: number | null;
  onTwoFactor: () => void;
  onInvite: () => void;
}) {
  const key = `${HIDDEN_KEY}:${user.id}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const [hasDevice, setHasDevice] = useState(false);
  const pending = !hidden && twoFactor !== null && people !== null;
  const devices = useResource<unknown[]>(
    pending && !hasDevice ? "/devices" : null,
    [],
  );
  useEffect(() => {
    if (devices.data.length) setHasDevice(true);
  }, [devices.data.length]);
  if (!pending || devices.loading) return null;
  const steps = [
    {
      id: "two-factor",
      done: !!twoFactor,
      title: "Turn on two-factor authentication",
      body: "A code from your phone keeps the administrator account safe, even if your password leaks.",
      action: "Set up",
      run: onTwoFactor,
    },
    {
      id: "invite",
      done: (people ?? 0) > 1,
      title: "Invite a teammate",
      body: "Send a single-use link. They choose their own password.",
      action: "Invite",
      run: onInvite,
    },
    {
      id: "device",
      done: hasDevice,
      title: "Add your first device",
      body: "Install the agent on a machine that runs Vector.",
      action: "Add device",
      run: () => {
        location.hash = "#/enrollment";
      },
    },
  ];
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) return null;
  return (
    <section
      className="control-card secure-card"
      aria-labelledby="secure-heading"
    >
      <div className="secure-card-head">
        <div>
          <h2 id="secure-heading">Secure your workspace</h2>
          <p>
            {done} of {steps.length} done
          </p>
        </div>
        <IconButton
          icon={X}
          label="Hide this checklist"
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem(key, "1");
            } catch {
              /* It stays hidden until this page reloads. */
            }
          }}
        />
      </div>
      <div
        className="secure-progress"
        role="progressbar"
        aria-label="Workspace security steps done"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
      >
        <span style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="checklist">
        {steps.map((step, index) => (
          <li key={step.id} className={step.done ? "done" : ""}>
            <span className="checklist-mark" aria-hidden="true">
              {step.done ? <Check size={14} /> : index + 1}
            </span>
            <span className="checklist-copy">
              <strong>
                {step.title}
                {step.done && <span className="sr-only"> (done)</span>}
              </strong>
              <span>{step.body}</span>
            </span>
            {!step.done && (
              <Button variant="secondary compact" onClick={step.run}>
                {step.action}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
