import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  APIError,
  api,
  getCSRFToken,
  getCSRFVersion,
  getSessionEpoch,
  isSessionValid,
  setCSRF,
  UserSchema,
  withRequestDeadline,
  type User,
} from "./api";
import {
  authAuthorityUnchanged,
  isDefinitiveAuthRejection,
  useAuthRequest,
} from "./authRequests";
import { Button, ErrorBox, Field, Modal, SearchBox } from "./ui";
import RolePicker from "./RolePicker";
import { CurrentPassword, NewPassword } from "./AccountPasswordFields";
export { AccountActions } from "./AccountActions";
import { roles } from "./roles";
import { DataTable, type TableColumn, type TableSort } from "./DataTable";
import { matchesTableFilter, sortTableRows } from "./dataTableModel";
import {
  canUseAccountActionContext,
  sameAccountActionContext,
  type AccountActionContext,
} from "./accountActionSession";

type AccessContext = AccountActionContext & { role: User["role"] };
type AccessProposal = Pick<User, "name" | "role" | "enabled" | "revision">;
const AccessReceiptSchema = z
  .object({
    request_id: z.uuid(),
    user: UserSchema,
  })
  .strict();
const AccessStatusSchema = z.discriminatedUnion("status", [
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
type AccessStatus = z.infer<typeof AccessStatusSchema>;
type AccessReview = {
  context: AccessContext;
  target: User;
  proposal: AccessProposal;
  requestId: string;
  phase: "sending" | "unknown" | "changed";
  status: AccessStatus | null;
  error: string;
};

const personColumns = [
  {
    id: "name",
    value: (person: User) => `${person.name} ${person.email}`,
    sortValue: (person: User) => person.name,
  },
  {
    id: "role",
    value: (person: User) => person.role,
    sortValue: (person: User) => roles[person.role][0],
  },
  {
    id: "access",
    value: (person: User) => (person.enabled ? "active" : "disabled"),
  },
];
function matchesPerson(
  person: User,
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

export function WorkspaceAccess({
  user,
  people,
  reload,
  notify,
  onUserChanged,
  savedPerson,
  onPersonLocated,
  onResetPassword,
  showTable,
  loading,
}: {
  user: User;
  people: User[];
  reload: () => void;
  notify: (m: string) => void;
  onUserChanged: (u: User | null) => void;
  savedPerson: User | null;
  onPersonLocated: () => void;
  onResetPassword: (person: User) => void;
  showTable: boolean;
  loading: boolean;
}) {
  const [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [editing, setEditing] = useState<User | null>(null);
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(
    {},
  );
  const [sort, setSort] = useState<TableSort | null>({
    column: "name",
    direction: "asc",
  });
  const [name, setName] = useState(""),
    [role, setRole] = useState<User["role"]>("viewer"),
    [enabled, setEnabled] = useState(true);
  const [current, setCurrent] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [updatedPerson, setUpdatedPerson] = useState<User | null>(null);
  const [review, setReview] = useState<AccessReview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [blockedPerson, setBlockedPerson] = useState<User | null>(null);
  const retained = useRef<AccessReview | null>(null);
  const active = useRef<{
    review: AccessReview;
    controller: AbortController;
  } | null>(null);
  const statusRead = useRef<AbortController | null>(null);
  const currentUser = useRef(user);
  const currentPeople = useRef(people);
  const owner = useRef<AccessContext | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);

  function context(): AccessContext {
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
  function sameContext(original: AccessContext) {
    const now = context();
    return (
      original.role === "admin" &&
      now.role === "admin" &&
      canUseAccountActionContext(original, now)
    );
  }
  function remember(next: AccessReview | null) {
    retained.current = next;
    setReview(next);
  }
  function stopWaiting(hide = false) {
    const wait = active.current;
    if (wait) {
      active.current = null;
      wait.controller.abort();
      remember({ ...wait.review, phase: "unknown", error: "" });
    }
    statusRead.current?.abort();
    statusRead.current = null;
    setChecking(false);
    setBusy(false);
    setCurrent("");
    if (hide) setReviewOpen(false);
  }
  function authorityChanged() {
    stopWaiting();
    if (retained.current)
      remember({ ...retained.current, phase: "changed", status: null });
    setEditing(null);
    setCurrent("");
    setError("");
    setReviewOpen(false);
    setBlockedPerson(null);
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
      const wait = active.current;
      const read = statusRead.current;
      active.current = null;
      statusRead.current = null;
      wait?.controller.abort();
      read?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!review && !editing) return;
    const leave = (event: Event) => {
      const message = review
        ? "Leave this access request review? Its exact ID is only on this page, and the change may still apply."
        : "Leave and discard the unsaved access edit?";
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
  }, [review, editing]);
  useEffect(() => {
    const saved = savedPerson || updatedPerson;
    if (!saved) return;
    const refreshed = people.find(
      (p) => p.id === saved.id && p.revision >= saved.revision,
    );
    if (!refreshed) return;
    const keepSearch = matchesPerson(refreshed, search, {});
    const nextFilters = { ...columnFilters };
    for (const column of personColumns) {
      if (
        nextFilters[column.id] &&
        !matchesTableFilter(
          column.value(refreshed),
          nextFilters[column.id],
          column.id !== "name",
        )
      )
        nextFilters[column.id] = "";
    }
    const visible = sortTableRows(
      people.filter((p) =>
        matchesPerson(p, keepSearch ? search : "", nextFilters),
      ),
      personColumns,
      sort,
    );
    setPage(Math.floor(visible.findIndex((p) => p.id === saved.id) / 12) + 1);
    if (!keepSearch) setSearch("");
    if (
      personColumns.some(
        (column) =>
          (columnFilters[column.id] || "") !== (nextFilters[column.id] || ""),
      )
    )
      setColumnFilters(nextFilters);
    setUpdatedPerson(null);
    onPersonLocated();
  }, [
    savedPerson,
    updatedPerson,
    people,
    search,
    columnFilters,
    sort,
    onPersonLocated,
  ]);
  const matches = sortTableRows(
    people.filter((person) => matchesPerson(person, search, columnFilters)),
    personColumns,
    sort,
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(matches.length / 12)),
  );
  const lastAdmin =
    editing?.enabled &&
    editing.role === "admin" &&
    people.filter((p) => p.enabled && p.role === "admin").length === 1;
  const accessChanged =
    !!editing && (role !== editing.role || enabled !== editing.enabled);
  const stale =
    !!editing &&
    !people.some((p) => p.id === editing.id && p.revision === editing.revision);
  function open(person: User) {
    const prior = retained.current;
    if (prior) {
      if (prior.target.id !== person.id) setBlockedPerson(person);
      else setReviewOpen(true);
      return;
    }
    const now = context();
    if (!sameContext(now)) return;
    if (
      !currentPeople.current.some(
        (p) => p.id === person.id && p.revision === person.revision,
      )
    )
      return;
    setEditing(person);
    setName(person.name);
    setRole(person.role);
    setEnabled(person.enabled);
    setCurrent("");
    setError("");
  }
  function close() {
    setEditing(null);
    setCurrent("");
    setError("");
  }
  function matchesApplied(
    review: AccessReview,
    receipt: { request_id: string; user: User },
  ) {
    const { target, proposal } = review;
    const result = receipt.user;
    return (
      receipt.request_id === review.requestId &&
      result.id === target.id &&
      result.email === target.email &&
      result.name === proposal.name &&
      result.role === proposal.role &&
      result.enabled === proposal.enabled &&
      result.revision === proposal.revision + 1
    );
  }
  function applied(review: AccessReview, result: User, historical = false) {
    remember(null);
    setReviewOpen(false);
    setBlockedPerson(null);
    const latest = currentPeople.current.find(
      (person) => person.id === result.id,
    );
    if (!historical || !latest || latest.revision <= result.revision)
      setUpdatedPerson(result);
    const accessWasChanged =
      review.proposal.role !== review.target.role ||
      review.proposal.enabled !== review.target.enabled;
    notify(
      historical
        ? `This access request applied for ${result.name}${latest && latest.revision > result.revision ? ", but the account changed again. Review its current access." : "."}`
        : accessWasChanged
          ? `Access updated for ${result.name}. Their browser sessions were signed out.`
          : `Saved ${result.name}.`,
    );
    reload();
    if (!historical && result.id === review.context.userId) {
      if (accessWasChanged) {
        setCSRF("");
        onUserChanged(null);
      } else onUserChanged(result);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      !editing ||
      active.current ||
      retained.current ||
      !sameContext(context())
    )
      return;
    const target = editing;
    const original = context();
    const latest = currentPeople.current.find(
      (person) => person.id === target.id,
    );
    if (!latest || latest.revision !== target.revision) {
      setError(
        "This account changed. Load its latest details before continuing.",
      );
      return;
    }
    if (
      target.enabled &&
      target.role === "admin" &&
      currentPeople.current.filter(
        (person) => person.enabled && person.role === "admin",
      ).length === 1 &&
      (role !== "admin" || !enabled)
    ) {
      setError(
        "Make another person an administrator before changing the last active administrator.",
      );
      return;
    }
    const proposal: AccessProposal = {
      name: name.trim(),
      role,
      enabled,
      revision: target.revision,
    };
    if (
      !proposal.name ||
      proposal.name.length > 100 ||
      (proposal.name === target.name &&
        proposal.role === target.role &&
        proposal.enabled === target.enabled)
    )
      return;
    const requestId = crypto.randomUUID();
    const secret = current;
    const next: AccessReview = {
      context: original,
      target,
      proposal,
      requestId,
      phase: "sending",
      status: null,
      error: "",
    };
    const wait = { review: next, controller: new AbortController() };
    active.current = wait;
    setCurrent("");
    setEditing(null);
    remember(next);
    setReviewOpen(true);
    setError("");
    setBusy(true);
    let sent = false;
    const path = `/users/${target.id}`;
    try {
      const preflight = await withRequestDeadline(
        (signal) =>
          api(
            `${path}/access-requests/${requestId}`,
            { signal, headers: { "X-CSRF-Token": original.csrfToken } },
            AccessStatusSchema,
          ),
        30000,
        wait.controller.signal,
      );
      if (active.current !== wait) return;
      if (!sameContext(original)) {
        authorityChanged();
        return;
      }
      if (
        preflight.request_id !== requestId ||
        preflight.user_id !== target.id ||
        preflight.status !== "not_found"
      )
        throw Error("The server did not confirm this access request ID.");
      sent = true;
      const receipt = await withRequestDeadline(
        (signal) =>
          api(
            path,
            {
              method: "PUT",
              body: JSON.stringify({
                ...proposal,
                current_password: secret,
                request_id: requestId,
              }),
              headers: { "X-CSRF-Token": original.csrfToken },
              signal,
            },
            AccessReceiptSchema,
          ),
        30000,
        wait.controller.signal,
      );
      if (active.current !== wait) return;
      if (!sameContext(original)) {
        authorityChanged();
        return;
      }
      if (!matchesApplied(next, receipt))
        throw Error("The access receipt did not match this exact request.");
      active.current = null;
      applied(next, receipt.user);
    } catch (failure) {
      if (active.current !== wait) return;
      active.current = null;
      if (!sameContext(original)) {
        authorityChanged();
        return;
      }
      if (
        !sent ||
        (failure instanceof APIError &&
          failure.serverRejection &&
          failure.code === "WRONG_PASSWORD")
      ) {
        remember(null);
        setReviewOpen(false);
        setError(
          sent
            ? (failure as Error).message
            : "The access change was not sent because its request ID was not confirmed. " +
                (failure as Error).message,
        );
        setEditing(target);
        if (sent) reload();
      } else {
        remember({
          ...next,
          phase: "unknown",
          error:
            "The response did not confirm this access change. Check or cancel this exact request before starting another. " +
            (failure as Error).message,
        });
      }
    } finally {
      if (active.current === wait) active.current = null;
      setBusy(false);
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
    try {
      const path = `/users/${previous.target.id}/access-requests/${previous.requestId}`;
      const status = await withRequestDeadline(
        (signal) =>
          api(
            `${path}${cancel ? "/cancel" : ""}`,
            {
              ...(cancel ? { method: "POST", body: "{}" } : {}),
              headers: { "X-CSRF-Token": previous.context.csrfToken },
              signal,
            },
            AccessStatusSchema,
          ),
        30000,
        controller.signal,
      );
      if (
        statusRead.current !== controller ||
        retained.current?.requestId !== previous.requestId
      )
        return;
      if (!sameContext(previous.context)) {
        authorityChanged();
        return;
      }
      if (
        status.request_id !== previous.requestId ||
        status.user_id !== previous.target.id ||
        (status.status === "applied" &&
          !matchesApplied(previous, {
            request_id: status.request_id,
            user: status.user,
          }))
      )
        throw Error("The access request status did not match this request.");
      remember({ ...previous, status, error: "" });
      if (status.status === "applied") reload();
    } catch (failure) {
      if (
        statusRead.current !== controller ||
        retained.current?.requestId !== previous.requestId
      )
        return;
      if (!sameContext(previous.context)) {
        authorityChanged();
        return;
      }
      remember({
        ...retained.current!,
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
  function finishReview() {
    const previous = retained.current;
    if (!previous || previous.phase !== "unknown" || checking) return;
    if (!sameContext(previous.context)) {
      authorityChanged();
      return;
    }
    if (previous.status?.status === "applied")
      applied(previous, previous.status.user, true);
    else if (previous.status?.status === "cancelled") {
      remember(null);
      setReviewOpen(false);
      reload();
    }
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
    setReviewOpen(true);
  }
  return (
    <>
      {review && review.context.userId === user.id && user.role === "admin" && (
        <Button
          ref={reviewButton}
          variant="secondary"
          onClick={() => setReviewOpen(true)}
        >
          Review access change
        </Button>
      )}
      {review?.phase === "changed" &&
        review.context.userId === user.id &&
        user.role !== "admin" && (
          <p className="account-notice" role="status">
            An access change may still be in flight. Your current role cannot
            check request <code>{review.requestId}</code>. Sign in again if
            permitted, or ask another administrator to verify the account before
            retrying.
          </p>
        )}
      {showTable && (
        <section className="control-card">
          <div className="control-section-head">
            <div>
              <h2>Workspace access</h2>
              <p>
                {people.length} {people.length === 1 ? "person" : "people"}
              </p>
            </div>
            <SearchBox
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder="Find a person"
            />
          </div>
          <DataTable
            data={matches}
            columns={
              [
                {
                  ...personColumns[0],
                  header: "Name",
                  filter: {
                    manual: true,
                    value: columnFilters.name || "",
                    placeholder: "Name or email",
                    onChange: (value) => {
                      setColumnFilters((current) => ({
                        ...current,
                        name: value,
                      }));
                      setPage(1);
                    },
                  },
                  cell: (person) => (
                    <>
                      <strong>{person.name}</strong>
                      {person.id === user.id && (
                        <span className="control-muted"> (you)</span>
                      )}
                      <span className="person-email">{person.email}</span>
                    </>
                  ),
                },
                {
                  ...personColumns[1],
                  header: "Role",
                  filter: {
                    manual: true,
                    value: columnFilters.role || "",
                    allLabel: "All roles",
                    options: Object.entries(roles).map(([value, [label]]) => ({
                      value,
                      label,
                    })),
                    onChange: (value) => {
                      setColumnFilters((current) => ({
                        ...current,
                        role: value,
                      }));
                      setPage(1);
                    },
                  },
                  cell: (person) => <RoleHint role={person.role} />,
                },
                {
                  ...personColumns[2],
                  header: "Access",
                  filter: {
                    manual: true,
                    value: columnFilters.access || "",
                    allLabel: "All access",
                    options: [
                      { value: "active", label: "Active" },
                      { value: "disabled", label: "Disabled" },
                    ],
                    onChange: (value) => {
                      setColumnFilters((current) => ({
                        ...current,
                        access: value,
                      }));
                      setPage(1);
                    },
                  },
                  cell: (person) => (person.enabled ? "Active" : "Disabled"),
                },
                {
                  id: "actions",
                  header: <span className="sr-only">Actions</span>,
                  label: "Actions",
                  className: "person-actions",
                  cell: (person) => (
                    <>
                      <Button
                        variant="secondary"
                        aria-label={`Edit access for ${person.name}`}
                        onClick={() => open(person)}
                      >
                        Edit access
                      </Button>
                      {person.id !== user.id && person.enabled && (
                        <Button
                          variant="ghost"
                          aria-label={`Reset password for ${person.name}`}
                          onClick={() => onResetPassword(person)}
                        >
                          Reset password
                        </Button>
                      )}
                    </>
                  ),
                },
              ] satisfies TableColumn<User>[]
            }
            rowKey={(person) => person.id}
            label="Workspace access"
            className="people-table"
            loading={loading}
            manualSorting
            sort={sort}
            onSortChange={(next) => {
              setSort(next);
              setPage(1);
            }}
            pagination={{ page: currentPage, size: 12, onPage: setPage }}
            empty="No people match your search or filters."
          />
          <details className="control-disclosure">
            <summary>What each role can do</summary>
            <div className="control-disclosure-content">
              <dl className="control-roles">
                {Object.entries(roles).map(([key, [title, description]]) => (
                  <div className="role-definition" key={key}>
                    <dt>{title}</dt>
                    <dd>{description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </details>
          <Modal
            open={!!editing}
            title="Edit workspace access"
            description={editing?.email}
            onClose={close}
          >
            <form onSubmit={submit}>
              <div className="modal-body">
                {error && <ErrorBox message={error} />}
                {stale && (
                  <div className="account-notice" role="status">
                    <p>
                      This account changed after you opened it. Load its latest
                      details before continuing.
                    </p>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        const latest = people.find((p) => p.id === editing?.id);
                        if (latest) open(latest);
                      }}
                    >
                      Load latest details
                    </Button>
                  </div>
                )}
                <fieldset disabled={busy || stale}>
                  <>
                    <Field label="Full name">
                      <input
                        required
                        maxLength={100}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </Field>
                    <RolePicker
                      value={role}
                      onChange={setRole}
                      disabled={busy || stale || !!lastAdmin}
                    />
                    <Field label="Workspace access">
                      <select
                        value={enabled ? "active" : "disabled"}
                        disabled={!!lastAdmin}
                        onChange={(e) =>
                          setEnabled(e.target.value === "active")
                        }
                      >
                        <option value="active">Active — can sign in</option>
                        <option value="disabled">
                          Disabled — cannot sign in
                        </option>
                      </select>
                    </Field>
                    {lastAdmin && (
                      <p className="control-muted">
                        This is the last active administrator. Make another
                        person an administrator before changing this role or
                        disabling access.
                      </p>
                    )}
                  </>
                  {editing &&
                    (name.trim() !== editing.name || accessChanged) && (
                      <section
                        className="account-notice"
                        aria-label="Review access change"
                      >
                        <strong>Review this account before saving</strong>
                        <p>{editing.email}</p>
                        <dl className="access-change-review">
                          {name.trim() !== editing.name && (
                            <div>
                              <dt>Name</dt>
                              <dd>
                                {editing.name} → {name.trim() || "(empty)"}
                              </dd>
                            </div>
                          )}
                          {role !== editing.role && (
                            <div>
                              <dt>Role</dt>
                              <dd>
                                {roles[editing.role][0]} → {roles[role][0]}
                              </dd>
                            </div>
                          )}
                          {enabled !== editing.enabled && (
                            <div>
                              <dt>Sign-in</dt>
                              <dd>
                                {editing.enabled ? "Active" : "Disabled"} →{" "}
                                {enabled ? "Active" : "Disabled"}
                              </dd>
                            </div>
                          )}
                        </dl>
                        {accessChanged && (
                          <p>
                            {editing.id === user.id
                              ? "This ends your current sign-in. If you disable yourself, another administrator must restore access."
                              : "This signs out this person, revokes their unused reset codes, and revokes unused codes they issued for others."}
                          </p>
                        )}
                      </section>
                    )}
                  <CurrentPassword value={current} onChange={setCurrent} />
                </fieldset>
              </div>
              <div className="modal-footer">
                <Button variant="secondary" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  busy={busy}
                  disabled={
                    stale || (name.trim() === editing?.name && !accessChanged)
                  }
                >
                  Save access
                </Button>
              </div>
            </form>
          </Modal>
        </section>
      )}
      <Modal
        open={!!blockedPerson}
        onClose={() => setBlockedPerson(null)}
        title="Finish the earlier access change"
        description={blockedPerson?.email}
      >
        <div className="modal-body">
          <p>
            An access request for {review?.target.email} still needs review.
            Check or cancel that exact request before editing{" "}
            {blockedPerson?.email}.
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setBlockedPerson(null)}>
            Back to people
          </Button>
          <Button
            onClick={() => {
              setBlockedPerson(null);
              setReviewOpen(true);
            }}
          >
            Review earlier request
          </Button>
        </div>
      </Modal>
      <Modal
        open={reviewOpen && !!review && review.context.userId === user.id}
        onClose={() => stopWaiting(true)}
        title={
          review?.phase === "sending"
            ? "Waiting for access change"
            : review?.phase === "changed"
              ? "Your access changed"
              : "Access change needs review"
        }
        description={review?.target.email}
        returnFocusRef={reviewButton}
      >
        <div className="modal-body">
          {review?.error && <ErrorBox message={review.error} />}
          {review && (
            <>
              <p>
                Request{" "}
                <code className="account-request-id">{review.requestId}</code>
              </p>
              <p>
                {review.target.email}: {roles[review.target.role][0]} →{" "}
                {roles[review.proposal.role][0]},{" "}
                {review.target.enabled ? "active" : "disabled"} →{" "}
                {review.proposal.enabled ? "active" : "disabled"}.
                {review.proposal.name !== review.target.name && (
                  <>
                    {" "}
                    Name: {review.target.name} → {review.proposal.name}.
                  </>
                )}
              </p>
              {review.phase === "sending" && (
                <p role="status">
                  Waiting for the server. You can stop waiting; that does not
                  cancel the change.
                </p>
              )}
              {review.phase === "changed" && (
                <p role="status">
                  Your sign-in or role changed while this request was in flight.
                  Its result is unknown. If you still have administrator access,
                  sign in again and check this exact request. Otherwise ask
                  another administrator to verify the account before retrying.
                </p>
              )}
              {review.phase === "unknown" && (
                <>
                  <p role="status">
                    The earlier response did not prove whether this change
                    applied. Do not submit another access change until this
                    request is resolved.
                  </p>
                  {review.status?.status === "not_found" && (
                    <p>
                      No committed result is visible yet. The earlier request
                      may still arrive. Cancel this exact request to prevent a
                      late edit.
                    </p>
                  )}
                  {review.status?.status === "cancelled" && (
                    <p role="status">
                      This request cannot apply now. Cancellation did not undo
                      any earlier change.
                    </p>
                  )}
                  {review.status?.status === "applied" && (
                    <section aria-label="Applied access change">
                      <p role="status">
                        This exact request applied at account revision{" "}
                        {review.status.user.revision}.
                        {people.find((person) => person.id === review.target.id)
                          ?.revision !== undefined &&
                          people.find(
                            (person) => person.id === review.target.id,
                          )!.revision > review.status.user.revision &&
                          " The account changed again afterward; review its current access."}
                      </p>
                      <p>
                        Saved: {review.status.user.name},{" "}
                        {roles[review.status.user.role][0]},{" "}
                        {review.status.user.enabled ? "active" : "disabled"}.
                      </p>
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => stopWaiting(true)}>
            {review?.phase === "sending" ? "Stop waiting" : "Back to people"}
          </Button>
          {review?.phase === "unknown" && (
            <>
              <Button busy={checking} onClick={() => void observe(false)}>
                Check request status
              </Button>
              {review.status?.status !== "cancelled" &&
                review.status?.status !== "applied" && (
                  <Button
                    variant="secondary"
                    busy={checking}
                    onClick={() => void observe(true)}
                  >
                    Cancel this request
                  </Button>
                )}
              {(review.status?.status === "cancelled" ||
                review.status?.status === "applied") && (
                <Button onClick={finishReview}>Finish review</Button>
              )}
            </>
          )}
          {review?.phase === "changed" &&
            review.context.userId === user.id &&
            user.role === "admin" && (
              <Button onClick={restoreReview}>Review original request</Button>
            )}
        </div>
      </Modal>
    </>
  );
}

export function PasswordReset({
  onBack,
}: {
  onBack: (message?: string) => void;
}) {
  const [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  const requests = useAuthRequest();
  function unconfirmed() {
    setCode("");
    setPassword("");
    setConfirm("");
    setError("");
    setUnknown(true);
  }
  if (unknown)
    return (
      <>
        <h1>Password reset result unknown</h1>
        <p role="status">
          The server may already have saved your new password. Do not submit the
          reset code again. Return to sign in and try the new password you
          chose. If you still cannot sign in, ask your administrator for a new
          reset code.
        </p>
        <Button
          autoFocus
          variant="secondary"
          className="full-width auth-submit"
          onClick={() =>
            onBack(
              "The password-reset result was not confirmed. Try signing in with the new password you chose and your authenticator, if enabled. If needed, ask an administrator for a new reset code.",
            )
          }
        >
          Back to sign in
        </Button>
      </>
    );
  return (
    <>
      <h1>Reset your password</h1>
      <p>
        Ask a workspace administrator for a reset code. Codes expire after 15
        minutes.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          if (password !== confirm) {
            setError("The new passwords don’t match.");
            return;
          }
          const request = requests.claim();
          if (!request) return;
          setBusy(true);
          try {
            await withRequestDeadline(
              (signal) =>
                api(
                  "/password-reset",
                  {
                    method: "POST",
                    body: JSON.stringify({
                      code: code.trim(),
                      new_password: password,
                    }),
                    signal,
                  },
                  z.object({ ok: z.literal(true) }),
                ),
              30000,
              request.controller.signal,
            );
            if (!requests.current(request)) return;
            if (!authAuthorityUnchanged(request)) {
              unconfirmed();
              return;
            }
            setCode("");
            setPassword("");
            setConfirm("");
            onBack(
              "Password reset. Sign in with your new password and authenticator, if enabled.",
            );
          } catch (failure) {
            if (!requests.current(request)) return;
            if (
              !authAuthorityUnchanged(request) ||
              !isDefinitiveAuthRejection(failure)
            ) {
              unconfirmed();
              return;
            }
            setError(
              failure instanceof APIError && failure.code === "UNAUTHENTICATED"
                ? "This reset code is invalid, expired or already used. Ask your administrator for a new code."
                : (failure as Error).message,
            );
          } finally {
            if (requests.finish(request)) setBusy(false);
          }
        }}
      >
        {error && <ErrorBox message={error} />}
        <fieldset disabled={busy}>
          <Field label="Password reset code">
            <input
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <NewPassword
            password={password}
            confirm={confirm}
            setPassword={setPassword}
            setConfirm={setConfirm}
          />
          <Button type="submit" busy={busy} className="full-width auth-submit">
            Set new password
          </Button>
        </fieldset>
      </form>
      <Button
        variant="ghost"
        disabled={busy}
        className="auth-reset-link"
        onClick={() => onBack()}
      >
        Back to sign in
      </Button>
    </>
  );
}
