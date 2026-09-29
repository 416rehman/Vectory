import { useEffect, useId, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  KeyRound,
  Link2,
  MoreHorizontal,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";
import { z } from "zod";
import {
  APIError,
  UserSchema,
  api,
  setCSRF,
  withRequestDeadline,
  type Person,
  type User,
} from "./api";
import { isUncertainOutcome, retryDelay } from "./authRequests";
import { useAccountAuthority, useLeaveGuard } from "./accountAuthority";
import {
  AuthField,
  PasswordField,
  Unconfirmed,
  formatAgo,
  formatRemaining,
} from "./authControls";
import { useKeyedRequest, NotSent, type KeyedRequest } from "./keyedRequest";
import { firstName, type HeldLink } from "./AdminPasswordResetActions";
import RolePicker, { RoleMatrix } from "./RolePicker";
import { roles } from "./roles";
import { DataTable, type TableColumn, type TableSort } from "./DataTable";
import { matchesTableFilter, sortTableRows } from "./dataTableModel";
import { Button, Modal, SearchBox, Spinner } from "./ui";
import "./account.css";
import type { Notify } from "./toast";

type Status = "active" | "invited" | "disabled";
const statusOf = (person: Person): Status =>
  person.status ?? (person.enabled ? "active" : "disabled");
const statusLabels: Record<Status, string> = {
  active: "Active",
  invited: "Invited",
  disabled: "Disabled",
};

const personColumns = [
  {
    id: "name",
    value: (person: Person) => `${person.name} ${person.email}`,
    sortValue: (person: Person) => person.name,
  },
  {
    id: "role",
    value: (person: Person) => person.role,
    sortValue: (person: Person) => roles[person.role][0],
  },
  {
    id: "mfa",
    value: (person: Person) => (person.mfa_enabled ? "on" : "off"),
  },
  {
    id: "last",
    value: (person: Person) => person.last_login_at || "",
    sortValue: (person: Person) => person.last_login_at || "",
  },
  { id: "status", value: (person: Person) => statusOf(person) },
];
function matchesPerson(
  person: Person,
  search: string,
  filters: Record<string, string>,
) {
  return (
    `${person.name} ${person.email} ${roles[person.role][0]}`
      .toLowerCase()
      .includes(search.toLowerCase()) &&
    personColumns.every(
      (column) =>
        !filters[column.id] ||
        matchesTableFilter(
          column.value(person),
          filters[column.id],
          column.id !== "name",
        ),
    )
  );
}

function RoleHint({ role }: { role: User["role"] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [open, setOpen] = useState(false);
  const [label, description] = roles[role];
  function cancelClose() {
    clearTimeout(closeTimer.current);
  }
  function close() {
    cancelClose();
    if (panel.current?.matches(":popover-open")) panel.current.hidePopover();
  }
  function position() {
    if (!trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = panel.current.getBoundingClientRect();
    panel.current.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12))}px`;
    panel.current.style.top = `${Math.max(12, anchor.bottom + bounds.height + 8 <= window.innerHeight - 12 ? anchor.bottom + 8 : anchor.top - bounds.height - 8)}px`;
  }
  function show() {
    cancelClose();
    if (!panel.current?.showPopover) return;
    if (!panel.current.matches(":popover-open")) panel.current.showPopover();
    position();
  }
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", position);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  return (
    <span
      onMouseEnter={show}
      onMouseLeave={() => {
        if (document.activeElement !== trigger.current)
          closeTimer.current = setTimeout(close, 160);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="role-hint-trigger"
        aria-describedby={id}
        popoverTarget={id}
        popoverTargetAction="show"
        onFocus={show}
        onClick={show}
        title={
          typeof HTMLElement !== "undefined" &&
          !("showPopover" in HTMLElement.prototype)
            ? description
            : undefined
        }
      >
        {label}
      </button>
      <div
        ref={panel}
        id={id}
        className="role-hint-popover"
        role="tooltip"
        popover="auto"
        onMouseEnter={cancelClose}
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        {description}
      </div>
    </span>
  );
}

type Proposal = Pick<User, "name" | "role" | "enabled">;
type EditTarget = { person: Person; proposal: Proposal };
const ReceiptSchema = z
  .object({ request_id: z.uuid(), user: UserSchema })
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
      status: z.literal("cancelled"),
    })
    .strict(),
  z
    .object({
      request_id: z.uuid(),
      user_id: z.uuid(),
      status: z.literal("applied"),
      user: UserSchema,
    })
    .strict(),
]);
function appliedAsProposed(target: EditTarget, result: User) {
  const { person, proposal } = target;
  return (
    result.id === person.id &&
    result.email === person.email &&
    result.name === proposal.name &&
    result.role === proposal.role &&
    result.enabled === proposal.enabled &&
    result.revision === person.revision + 1
  );
}

/**
 * Everyone in the workspace, with their sign-in security, and the edits an
 * administrator can make: name, role and access, resets and invite links,
 * and resetting a lost second factor.
 */
export function WorkspaceAccess({
  user,
  people,
  loading = false,
  reload,
  reloadPeople,
  notify,
  onUserChanged,
  savedPerson,
  onPersonLocated,
  links = {},
  onShowLink,
  onNewLink,
  locateEmail,
  onEmailLocated,
}: {
  user: User;
  people: Person[];
  loading?: boolean;
  reload: () => void;
  reloadPeople?: () => Promise<Person[] | undefined>;
  notify: Notify;
  onUserChanged: (user: User | null) => void;
  savedPerson: User | null;
  onPersonLocated: () => void;
  links?: Record<string, HeldLink>;
  onShowLink?: (userId: string) => void;
  onNewLink?: (person: Person) => void;
  locateEmail?: string | null;
  onEmailLocated?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(
    {},
  );
  const [sort, setSort] = useState<TableSort | null>({
    column: "name",
    direction: "asc",
  });
  const [updatedPerson, setUpdatedPerson] = useState<User | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<User["role"]>("viewer");
  const [enabled, setEnabled] = useState(true);
  const [password, setPassword] = useState("");
  const [twoFactor, setTwoFactor] = useState<Person | null>(null);
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const authority = useAccountAuthority(user, () => {
    setPassword("");
    edit.authorityChanged();
  });
  const edit = useKeyedRequest<EditTarget, User>({
    authority,
    async read(request, signal) {
      const status = await api(
        `/users/${request.target.person.id}/access-requests/${request.id}`,
        { signal, headers: { "X-CSRF-Token": request.context.csrfToken } },
        StatusSchema,
      );
      return resolution(status, request);
    },
    async cancel(request, signal) {
      const status = await api(
        `/users/${request.target.person.id}/access-requests/${request.id}/cancel`,
        {
          method: "POST",
          body: "{}",
          signal,
          headers: { "X-CSRF-Token": request.context.csrfToken },
        },
        StatusSchema,
      );
      if (status.status === "not_found")
        throw Error("The server didn't confirm the cancellation.");
      return resolution(status, request);
    },
    done(request, result) {
      const { person, proposal } = request.target;
      setPassword("");
      const latest = peopleRef.current.find((entry) => entry.id === result.id);
      if (!latest || latest.revision <= result.revision)
        setUpdatedPerson(result);
      const accessChanged =
        proposal.role !== person.role || proposal.enabled !== person.enabled;
      notify(
        accessChanged
          ? `Saved. ${firstName(result.name)} was signed out of every browser.`
          : `Saved ${result.name}.`,
        { tone: "success" },
      );
      reload();
      if (result.id === request.context.userId) {
        if (accessChanged) {
          setCSRF("");
          onUserChanged(null);
        } else onUserChanged(result);
      }
    },
  });
  function resolution(
    status: z.infer<typeof StatusSchema>,
    request: KeyedRequest<EditTarget>,
  ) {
    if (
      status.request_id !== request.id ||
      status.user_id !== request.target.person.id
    )
      throw Error("The server described a different request.");
    if (status.status === "applied") {
      if (!appliedAsProposed(request.target, status.user))
        throw Error("The saved change didn't match this request.");
      return { kind: "done" as const, result: status.user };
    }
    return status.status === "cancelled"
      ? { kind: "retry" as const }
      : { kind: "pending" as const };
  }
  const request = edit.request;
  const editing = request?.target.person ?? null;
  useLeaveGuard(
    request && request.phase !== "form"
      ? "Leave before this access change is resolved? You'll need to check the account later."
      : edit.open &&
          editing &&
          (name.trim() !== editing.name ||
            role !== editing.role ||
            enabled !== editing.enabled ||
            password)
        ? "Discard your changes to this account?"
        : null,
  );

  // Show a saved or located person: clear only what hides them.
  useEffect(() => {
    const saved = savedPerson || updatedPerson;
    const wanted = saved
      ? people.find((p) => p.id === saved.id && p.revision >= saved.revision)
      : locateEmail
        ? people.find((p) => p.email === locateEmail)
        : undefined;
    if (!wanted) return;
    const keepSearch = matchesPerson(wanted, search, {});
    const nextFilters = { ...columnFilters };
    for (const column of personColumns)
      if (
        nextFilters[column.id] &&
        !matchesTableFilter(
          column.value(wanted),
          nextFilters[column.id],
          column.id !== "name",
        )
      )
        nextFilters[column.id] = "";
    const visible = sortTableRows(
      people.filter((p) =>
        matchesPerson(p, keepSearch ? search : "", nextFilters),
      ),
      personColumns,
      sort,
    );
    setPage(Math.floor(visible.findIndex((p) => p.id === wanted.id) / 12) + 1);
    if (!keepSearch) setSearch("");
    if (
      personColumns.some(
        (column) =>
          (columnFilters[column.id] || "") !== (nextFilters[column.id] || ""),
      )
    )
      setColumnFilters(nextFilters);
    setHighlight(wanted.id);
    if (saved) {
      setUpdatedPerson(null);
      onPersonLocated();
    } else onEmailLocated?.();
  }, [
    savedPerson,
    updatedPerson,
    locateEmail,
    people,
    search,
    columnFilters,
    sort,
  ]);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 2600);
    return () => clearTimeout(timer);
  }, [highlight]);

  const matches = sortTableRows(
    people.filter((person) => matchesPerson(person, search, columnFilters)),
    personColumns,
    sort,
  );
  const activeAdmins = people.filter(
    (p) => p.enabled && p.role === "admin",
  ).length;
  const lastAdmin =
    !!editing?.enabled && editing.role === "admin" && activeAdmins === 1;
  const latestEditing = editing && people.find((p) => p.id === editing.id);
  const stale =
    request?.phase === "form" &&
    !!editing &&
    (!latestEditing || latestEditing.revision !== editing.revision);
  const changes = editing
    ? {
        name: name.trim() !== editing.name,
        role: role !== editing.role,
        enabled: enabled !== editing.enabled,
      }
    : { name: false, role: false, enabled: false };
  const changed = changes.name || changes.role || changes.enabled;

  function open(person: Person) {
    const latest = peopleRef.current.find((p) => p.id === person.id) || person;
    if (!edit.begin({ person: latest, proposal: latest })) return;
    setName(latest.name);
    setRole(latest.role);
    setEnabled(latest.enabled);
    setPassword("");
  }
  function close() {
    setPassword("");
    edit.close();
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!request || request.phase !== "form" || !editing) return;
    const latest = peopleRef.current.find((p) => p.id === editing.id);
    if (!latest || latest.revision !== editing.revision) return;
    const proposal: Proposal = { name: name.trim(), role, enabled };
    const fields: Record<string, string> = {};
    if (!proposal.name) fields.name = "Enter their name.";
    else if (proposal.name.length > 100)
      fields.name = "Use 100 characters or fewer.";
    if (!password) fields.password = "Enter your password.";
    if (Object.keys(fields).length) {
      edit.edit({ fields });
      return;
    }
    if (!changed) return;
    const secret = password;
    // The password is sent once and never kept for a replay.
    setPassword("");
    edit.edit({ target: { person: latest, proposal } });
    await edit.send(
      async (attempt, signal) => {
        const path = `/users/${attempt.target.person.id}`;
        const headers = { "X-CSRF-Token": attempt.context.csrfToken };
        try {
          const preflight = await api(
            `${path}/access-requests/${attempt.id}`,
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
          path,
          {
            method: "PUT",
            body: JSON.stringify({
              ...proposal,
              revision: attempt.target.person.revision,
              current_password: secret,
              request_id: attempt.id,
            }),
            signal,
            headers,
          },
          ReceiptSchema,
        );
        if (
          receipt.request_id !== attempt.id ||
          !appliedAsProposed(attempt.target, receipt.user)
        )
          throw Error("The saved change didn't match this request.");
        return receipt.user;
      },
      (failure) => {
        const error = failure instanceof APIError ? failure : null;
        const wait = retryDelay(failure);
        if (error?.code === "WRONG_PASSWORD")
          return { password: "Your password didn't match." };
        if (error?.code === "NAME_INVALID") return { name: error.message };
        if (error?.code === "STALE_REVISION") {
          reload();
          return {
            form: "Someone else changed this account just now. Check the latest details, then save again.",
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

  const invitedCount = people.filter((p) => statusOf(p) === "invited").length;
  const signedUp = people.filter((p) => statusOf(p) === "active");
  const twoFactorCount = signedUp.filter((p) => p.mfa_enabled).length;
  const knowsTwoFactor = people.some((p) => p.mfa_enabled !== undefined);
  function menuItems(person: Person) {
    const items: {
      label: string;
      icon: LucideIcon;
      danger?: boolean;
      run: () => void;
    }[] = [];
    if (links[person.id] && onShowLink)
      items.push({
        label: "Show link",
        icon: Link2,
        run: () => onShowLink(person.id),
      });
    else if (person.id !== user.id && person.enabled && onNewLink)
      items.push({
        label:
          statusOf(person) === "invited" ? "New invite link" : "Reset password",
        icon: statusOf(person) === "invited" ? Link2 : KeyRound,
        run: () => onNewLink(person),
      });
    if (person.id !== user.id && person.mfa_enabled)
      items.push({
        label: "Reset two-factor",
        icon: ShieldOff,
        danger: true,
        run: () => setTwoFactor(person),
      });
    return items;
  }
  function actions(person: Person) {
    const items = menuItems(person);
    return (
      <span className="person-actions-inner">
        <Button
          variant="secondary compact"
          aria-label={`Edit access for ${person.name}`}
          onClick={() => open(person)}
        >
          Edit
        </Button>
        {items.length > 0 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={`More actions for ${person.name}`}
              >
                <MoreHorizontal size={17} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="person-menu"
                align="end"
                sideOffset={6}
                collisionPadding={12}
              >
                {items.map((item) => (
                  <DropdownMenu.Item
                    key={item.label}
                    className={`person-menu-item ${item.danger ? "danger" : ""}`}
                    onSelect={item.run}
                  >
                    <item.icon size={15} aria-hidden="true" />
                    {item.label}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </span>
    );
  }
  function statusCell(person: Person) {
    const status = statusOf(person);
    const expires = formatRemaining(person.invite_expires_at);
    return (
      <span className="person-status">
        <span
          className={`status-dot ${status === "active" ? "on" : status === "invited" ? "warn" : "off"}`}
        >
          {statusLabels[status]}
        </span>
        {status === "invited" && (
          <small>
            {links[person.id] && onShowLink ? (
              <button
                type="button"
                className="text-link"
                onClick={() => onShowLink(person.id)}
              >
                Show link
              </button>
            ) : person.invite_expires_at && expires !== "expired" ? (
              `Link expires ${expires}`
            ) : (
              // Expired, used up or revoked: all need the same next step.
              "Needs a new invite link"
            )}
          </small>
        )}
      </span>
    );
  }
  function twoFactorCell(person: Person) {
    if (person.mfa_enabled === undefined)
      return <span className="person-muted">—</span>;
    return person.mfa_enabled ? (
      <span className="status-dot on">On</span>
    ) : (
      <span
        className={`status-dot ${person.role === "admin" && person.enabled ? "warn" : "off"}`}
      >
        Off
      </span>
    );
  }
  function filter(id: string, placeholder?: string) {
    return {
      manual: true,
      value: columnFilters[id] || "",
      placeholder,
      onChange: (value: string) => {
        setColumnFilters((current) => ({ ...current, [id]: value }));
        setPage(1);
      },
    };
  }

  return (
    <section
      className="control-card people-card"
      aria-labelledby="people-heading"
    >
      <div className="people-head">
        <div>
          <h2 id="people-heading">Workspace access</h2>
          <p>
            {people.length} {people.length === 1 ? "person" : "people"}
            {knowsTwoFactor &&
              signedUp.length > 0 &&
              ` · ${twoFactorCount} of ${signedUp.length} use two-factor`}
            {invitedCount > 0 && ` · ${invitedCount} invited`}
          </p>
        </div>
        {people.length > 5 && (
          <SearchBox
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Find a person"
          />
        )}
      </div>
      <div className="people-table-wrap">
        <DataTable
          data={matches}
          columns={
            [
              {
                ...personColumns[0],
                header: "Name",
                filter: filter("name", "Name or email"),
                cell: (person) => (
                  <span className="person-cell">
                    <span>
                      <strong>{person.name}</strong>
                      {person.id === user.id && (
                        <span className="person-you"> (you)</span>
                      )}
                    </span>
                    <span>{person.email}</span>
                  </span>
                ),
              },
              {
                ...personColumns[1],
                header: "Role",
                filter: {
                  ...filter("role"),
                  allLabel: "All roles",
                  options: Object.entries(roles).map(([value, [label]]) => ({
                    value,
                    label,
                  })),
                },
                cell: (person) => <RoleHint role={person.role} />,
              },
              {
                ...personColumns[2],
                header: "Two-factor",
                cell: twoFactorCell,
              },
              {
                ...personColumns[3],
                header: "Last sign-in",
                cell: (person) => (
                  <span
                    className={person.last_login_at ? "" : "person-muted"}
                    title={
                      person.last_login_at
                        ? new Date(person.last_login_at).toLocaleString()
                        : undefined
                    }
                  >
                    {formatAgo(person.last_login_at)}
                  </span>
                ),
              },
              {
                ...personColumns[4],
                header: "Status",
                filter: {
                  ...filter("status"),
                  allLabel: "All people",
                  options: (["active", "invited", "disabled"] as const).map(
                    (value) => ({ value, label: statusLabels[value] }),
                  ),
                },
                cell: statusCell,
              },
              {
                id: "actions",
                header: <span className="sr-only">Actions</span>,
                label: "Actions",
                className: "person-actions",
                cell: actions,
              },
            ] satisfies TableColumn<Person>[]
          }
          rowKey={(person) => person.id}
          rowClassName={(person) =>
            person.id === highlight ? "person-highlight" : ""
          }
          label="Workspace access"
          className="people-table"
          loading={loading}
          manualSorting
          sort={sort}
          onSortChange={(next) => {
            setSort(next);
            setPage(1);
          }}
          pagination={
            matches.length > 12
              ? { page, size: 12, onPage: setPage }
              : undefined
          }
          empty="No people match your search or filters."
        />
      </div>
      <ul className="people-cards" aria-label="Workspace access">
        {matches.length === 0 ? (
          <li className="quiet-state">No people match your search.</li>
        ) : (
          matches.map((person) => (
            <li
              key={person.id}
              className={person.id === highlight ? "person-highlight" : ""}
            >
              <div className="people-card-top">
                <span className="person-cell">
                  <span>
                    <strong>{person.name}</strong>
                    {person.id === user.id && (
                      <span className="person-you"> (you)</span>
                    )}
                  </span>
                  <span>{person.email}</span>
                </span>
                <span className="role-badge">{roles[person.role][0]}</span>
              </div>
              <dl className="people-card-facts">
                <div>
                  <dt>Status</dt>
                  <dd>{statusCell(person)}</dd>
                </div>
                <div>
                  <dt>Two-factor</dt>
                  <dd>{twoFactorCell(person)}</dd>
                </div>
                <div>
                  <dt>Last sign-in</dt>
                  <dd>{formatAgo(person.last_login_at)}</dd>
                </div>
              </dl>
              <div className="people-card-actions">{actions(person)}</div>
            </li>
          ))
        )}
      </ul>
      <details className="control-disclosure role-reference">
        <summary>What each role can do</summary>
        <div className="control-disclosure-content">
          <RoleMatrix current={user.role} />
          <p className="role-capabilities-note">
            Editors change drafts and operators publish them, so every change
            gets a second pair of eyes. Administrators can do both.
          </p>
        </div>
      </details>

      <Modal
        open={edit.open && !!request}
        title={
          request?.phase === "changed"
            ? "Your sign-in changed"
            : "Edit workspace access"
        }
        description={editing ? `${editing.name} · ${editing.email}` : undefined}
        onClose={close}
      >
        <form onSubmit={(event) => void submit(event)} noValidate>
          <div className="modal-body">
            {request &&
            request.phase !== "form" &&
            request.phase !== "sending" ? (
              <EditReview request={request} />
            ) : (
              editing && (
                <fieldset disabled={request?.phase === "sending"}>
                  {request?.notice && (
                    <p className="signin-notice" role="status">
                      {request.notice}
                    </p>
                  )}
                  {request?.fields.form && (
                    <p className="signin-alert" role="alert">
                      {request.fields.form}
                    </p>
                  )}
                  {stale && latestEditing && (
                    <div className="signin-notice stale-notice" role="status">
                      <span>
                        {firstName(editing.name)}'s account changed while you
                        were editing.
                      </span>
                      <Button
                        variant="secondary compact"
                        onClick={() => {
                          edit.edit({
                            target: {
                              person: latestEditing,
                              proposal: latestEditing,
                            },
                            fields: {},
                          });
                          setName(latestEditing.name);
                          setRole(latestEditing.role);
                          setEnabled(latestEditing.enabled);
                        }}
                      >
                        Load latest
                      </Button>
                    </div>
                  )}
                  <AuthField label="Name" error={request?.fields.name}>
                    {({ id, describedBy, invalid }) => (
                      <input
                        id={id}
                        name="person-name"
                        autoComplete="off"
                        data-1p-ignore
                        maxLength={100}
                        value={name}
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                        onChange={(event) => setName(event.target.value)}
                      />
                    )}
                  </AuthField>
                  <RolePicker
                    value={role}
                    onChange={setRole}
                    disabled={lastAdmin || stale}
                    person={firstName(name.trim() || editing.name)}
                  />
                  <AuthField label="Sign-in">
                    {({ id }) => (
                      <select
                        id={id}
                        value={enabled ? "active" : "disabled"}
                        disabled={lastAdmin || stale}
                        onChange={(event) =>
                          setEnabled(event.target.value === "active")
                        }
                      >
                        <option value="active">Can sign in</option>
                        <option value="disabled">
                          Disabled, can't sign in
                        </option>
                      </select>
                    )}
                  </AuthField>
                  {lastAdmin && (
                    <p className="field-note">
                      {editing.id === user.id
                        ? "You're"
                        : `${firstName(editing.name)} is`}{" "}
                      the only active administrator. Make someone else an
                      administrator before changing this role or turning off
                      sign-in.
                    </p>
                  )}
                  {changed && (
                    <section
                      className="change-summary"
                      aria-label="What saving does"
                    >
                      <strong>Saving will</strong>
                      <ul>
                        {changes.name && (
                          <li>Rename to {name.trim() || "…"}</li>
                        )}
                        {changes.role && (
                          <li>
                            Change the role from {roles[editing.role][0]} to{" "}
                            {roles[role][0]}
                          </li>
                        )}
                        {changes.enabled && (
                          <li>
                            {enabled
                              ? "Turn sign-in back on"
                              : "Turn off sign-in"}
                          </li>
                        )}
                        {(changes.role || changes.enabled) && (
                          <li>
                            {editing.id === user.id
                              ? "End your current sign-in"
                              : `Sign ${firstName(editing.name)} out of every browser and cancel their unused links`}
                          </li>
                        )}
                      </ul>
                    </section>
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
                    label="Your password"
                    name="current-password"
                    autoComplete="current-password"
                    value={password}
                    onChange={setPassword}
                    error={request?.fields.password}
                    hint="Confirm it's you."
                  />
                </fieldset>
              )
            )}
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={close}>
              {request?.phase === "sending"
                ? "Stop waiting"
                : request?.phase === "form"
                  ? "Cancel"
                  : "Not now"}
            </Button>
            {request?.phase === "form" || request?.phase === "sending" ? (
              <Button
                type="submit"
                busy={request.phase === "sending"}
                disabled={!changed || stale}
              >
                Save changes
              </Button>
            ) : request?.phase === "unconfirmed" ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => void edit.cancelAndRetry()}
                >
                  Cancel it and try again
                </Button>
                <Button autoFocus onClick={() => void edit.check()}>
                  Check again
                </Button>
              </>
            ) : request?.phase === "pending" ? (
              <Button autoFocus onClick={() => void edit.cancelAndRetry()}>
                Cancel it and try again
              </Button>
            ) : request?.phase === "changed" ? (
              user.role === "admin" &&
              user.id === request.context.userId && (
                <Button autoFocus onClick={() => void edit.recheck()}>
                  Check again
                </Button>
              )
            ) : (
              <Button busy disabled>
                Checking
              </Button>
            )}
          </div>
        </form>
      </Modal>
      {twoFactor && (
        <TwoFactorReset
          person={twoFactor}
          user={user}
          reloadPeople={reloadPeople}
          reload={reload}
          notify={notify}
          onClose={() => setTwoFactor(null)}
        />
      )}
    </section>
  );
}

function EditReview({ request }: { request: KeyedRequest<EditTarget> }) {
  const who = firstName(request.target.person.name);
  if (request.phase === "checking" || request.phase === "cancelling")
    return (
      <p className="signin-loading" role="status">
        <Spinner />
        {request.phase === "checking"
          ? `Checking whether ${who}'s changes were saved…`
          : "Cancelling the earlier request…"}
      </p>
    );
  if (request.phase === "changed")
    return (
      <Unconfirmed title="We couldn't confirm the change">
        <p>
          Your sign-in changed while this was in progress. If you're still an
          administrator, sign in again and check. Otherwise ask another
          administrator to review {who}'s account.
        </p>
      </Unconfirmed>
    );
  return (
    <Unconfirmed
      title={
        request.phase === "pending"
          ? `We couldn't confirm ${who}'s changes were saved`
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
          ? "They might still be saved. Cancel the request first, then try again. Your changes stay filled in."
          : "Check your connection, then check again."}
      </p>
    </Unconfirmed>
  );
}

/**
 * Remove someone's authenticator and recovery codes after they lost both.
 * Their revision fences a resend: a repeated request after success is stale.
 */
function TwoFactorReset({
  person,
  user,
  reloadPeople,
  reload,
  notify,
  onClose,
}: {
  person: Person;
  user: User;
  reloadPeople?: () => Promise<Person[] | undefined>;
  reload: () => void;
  notify: Notify;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<
    "form" | "sending" | "checking" | "unconfirmed" | "still-on"
  >("form");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [target, setTarget] = useState(person);
  const active = useRef<AbortController | null>(null);
  const authority = useAccountAuthority(user, () => {
    active.current?.abort();
    active.current = null;
    onClose();
  });
  const name = firstName(target.name);
  useLeaveGuard(
    phase === "sending" || phase === "checking"
      ? `Leave before ${name}'s two-factor reset is confirmed?`
      : null,
  );
  useEffect(() => () => active.current?.abort(), []);

  function finished() {
    notify(
      `Two-factor is off for ${target.name}. They can sign in with their password and set it up again.`,
      { tone: "success" },
    );
    reload();
    onClose();
  }
  async function check() {
    setPhase("checking");
    const latest = (await reloadPeople?.())?.find((p) => p.id === target.id);
    if (!latest) {
      setPhase("unconfirmed");
      return;
    }
    setTarget(latest);
    if (!latest.mfa_enabled) finished();
    else setPhase("still-on");
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (phase !== "form" && phase !== "still-on") return;
    const original = authority.context();
    if (!authority.usable(original, true)) return;
    if (!password) {
      setFields({ password: "Enter your password." });
      return;
    }
    const secret = password;
    setPassword("");
    setFields({});
    setPhase("sending");
    const controller = new AbortController();
    active.current = controller;
    try {
      await withRequestDeadline(
        (signal) =>
          api(
            `/users/${target.id}/two-factor-reset`,
            {
              method: "POST",
              body: JSON.stringify({
                current_password: secret,
                revision: target.revision,
              }),
              signal,
              headers: { "X-CSRF-Token": original.csrfToken },
            },
            z.object({ user: UserSchema }).strict(),
          ),
        30000,
        controller.signal,
      );
      if (active.current !== controller) return;
      active.current = null;
      finished();
    } catch (failure) {
      if (active.current !== controller) return;
      active.current = null;
      if (!authority.usable(original, true)) return;
      if (isUncertainOutcome(failure)) {
        void check();
        return;
      }
      const error = failure instanceof APIError ? failure : null;
      const wait = retryDelay(failure);
      if (error?.code === "MFA_NOT_ENABLED") {
        notify(`Two-factor is already off for ${target.name}.`, {
          tone: "info",
        });
        reload();
        onClose();
        return;
      }
      if (error?.code === "STALE_REVISION") {
        const latest = (await reloadPeople?.())?.find(
          (p) => p.id === target.id,
        );
        if (latest) setTarget(latest);
      }
      setPhase("form");
      setFields(
        error?.code === "WRONG_PASSWORD"
          ? { password: "Your password didn't match." }
          : error?.code === "STALE_REVISION"
            ? {
                form: `${name}'s account just changed. Enter your password again to continue.`,
              }
            : {
                form: wait
                  ? `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`
                  : (failure as Error).message,
              },
      );
    }
  }
  function close() {
    if (active.current) {
      active.current.abort();
      active.current = null;
      void check();
      return;
    }
    onClose();
  }
  const review = phase === "unconfirmed" || phase === "still-on";
  return (
    <Modal
      open
      title={`Reset two-factor for ${target.name}`}
      description={target.email}
      onClose={close}
    >
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="modal-body">
          {phase === "checking" ? (
            <p className="signin-loading" role="status">
              <Spinner /> Checking {name}'s two-factor authentication…
            </p>
          ) : review ? (
            <Unconfirmed
              title={
                phase === "still-on"
                  ? `Two-factor is still on for ${name}`
                  : "We couldn't confirm that"
              }
            >
              <p>
                {phase === "still-on"
                  ? "We couldn't confirm the reset. Enter your password to try again."
                  : "Check your connection, then check again."}
              </p>
            </Unconfirmed>
          ) : (
            <>
              <p className="modal-copy">
                {name}'s authenticator and recovery codes stop working, and{" "}
                {name} is signed out everywhere. They can sign in with their
                password and set up two-factor again.
              </p>
              {fields.form && (
                <p className="signin-alert" role="alert">
                  {fields.form}
                </p>
              )}
            </>
          )}
          {(phase === "form" ||
            phase === "sending" ||
            phase === "still-on") && (
            <fieldset disabled={phase === "sending"}>
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={user.email}
                readOnly
                hidden
              />
              <PasswordField
                label="Your password"
                name="current-password"
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
                error={fields.password}
                hint="Confirm it's you."
                autoFocus
              />
            </fieldset>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={close}>
            {phase === "sending" ? "Stop waiting" : "Cancel"}
          </Button>
          {phase === "unconfirmed" ? (
            <Button autoFocus onClick={() => void check()}>
              Check again
            </Button>
          ) : phase === "checking" ? (
            <Button busy disabled>
              Checking
            </Button>
          ) : (
            <Button type="submit" variant="danger" busy={phase === "sending"}>
              Reset two-factor
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
