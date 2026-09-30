import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  APIError,
  can,
  GroupCreateReceiptSchema,
  withRequestDeadline,
  type Device,
  type Group,
  type GroupRequestLookup,
  type GroupSummary,
  type User,
} from "./api";
import {
  Button,
  ErrorBox,
  Field,
  Modal,
  SearchBox,
  useResource,
} from "./ui";
import { deploymentRoute } from "./deploymentRouting";
import DevicePicker from "./DevicePicker";
import GroupOverview from "./GroupOverview";
import GroupMembershipEffects from "./GroupMembershipEffects";
import {
  beginGroupOperation,
  finishGroupOperation,
  groupOperationAvailable,
  useGroupOperations,
  type GroupOperation,
} from "./groupRequests";
import { setDifference, toggled, withIds } from "./deviceInventory";
import "./group-editor.css";

/** A group holds this many devices at most; the server refuses more. */
const MAX_MEMBERS = 10000;
/** Names listed in a comparison before "and N more". */
const LISTED = 25;

export default function GroupEditor({
  group,
  user,
  onClose,
  onSaved,
  onRefresh,
}: {
  /** A list row, which carries a member count; or a full group. */
  group: Group | GroupSummary | null;
  user: User;
  onClose: () => void;
  onSaved: (group: Group) => void;
  onRefresh: () => void;
}) {
  // A list row has a member count; only a full group has its members.
  const full =
    group && Array.isArray((group as Group).device_ids)
      ? (group as Group)
      : null;
  // Lists carry counts, not members: an existing group's members are read
  // when its editor opens.
  const detail = useResource<Group | null>(
    group && !full ? `/groups/${encodeURIComponent(group.id)}` : null,
    null,
    0,
    { interval: 0 },
  );
  const [base, setBase] = useState<Group | null>(full);
  // An existing group opens on what it is for; editing is one tab away.
  const [tab, setTab] = useState<"overview" | "members">(
    group ? "overview" : "members",
  );
  const [name, setName] = useState(full?.name || "");
  const [description, setDescription] = useState(full?.description || "");
  const [ids, setIds] = useState<ReadonlySet<string>>(
    () => new Set(full?.device_ids),
  );
  const [search, setSearch] = useState("");
  // Names of the devices seen while choosing, for the comparison lists.
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blockedByCanary, setBlockedByCanary] = useState(false);
  const [review, setReview] = useState<"conflict" | "uncertain" | null>(null);
  const [latest, setLatest] = useState<Group | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [confirmedCreate, setConfirmedCreate] = useState(false);
  const [missing, setMissing] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const notice = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const allowed = can(user, "operate");
  const recovery = useGroupOperations(user.id);
  const pendingCreate =
    !base && !group && (recovery.operations.length > 0 || recovery.errors.length > 0);
  const compatible = !base || base.revision !== undefined;
  // What is saved, as a set: every comparison below is one pass, never a scan
  // of one list per member of the other.
  const savedIds = useMemo(() => new Set(base?.device_ids), [base]);
  const { added: addedIds, removed: removedIds } = useMemo(
    () => setDifference(ids, savedIds),
    [ids, savedIds],
  );
  const changed =
    name !== (base?.name || "") ||
    description !== (base?.description || "") ||
    addedIds.length > 0 ||
    removedIds.length > 0;
  const loadingMembers = !!group && !base && !detail.error;
  const tooMany = ids.size > MAX_MEMBERS;
  const dirty = useRef(false);
  dirty.current = (changed || !!review) && !(!base && review === "uncertain");
  // The read finished: start editing what the server holds now.
  useEffect(() => {
    if (base || !detail.data) return;
    setBase(detail.data);
    setName(detail.data.name);
    setDescription(detail.data.description);
    setIds(new Set(detail.data.device_ids));
  }, [base, detail.data]);
  useEffect(() => {
    mounted.current = true;
    const navigate = (event: Event) => {
      if (
        active.current ||
        (dirty.current && !window.confirm("Discard your unsaved group edits?"))
      )
        event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!active.current && !dirty.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("vectory:before-navigate", navigate);
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      active.current?.abort();
      window.removeEventListener("vectory:before-navigate", navigate);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  useEffect(() => {
    if (review) notice.current?.focus();
  }, [review]);
  function close() {
    if (
      !active.current &&
      (!dirty.current || window.confirm("Discard your unsaved group edits?"))
    )
      onClose();
  }
  async function request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      return await withRequestDeadline(
        (signal) => api<T>(path, { ...options, signal }),
        30000,
        controller.signal,
      );
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  async function loadLatest() {
    if (!base || active.current) return;
    setLatest(null);
    setReviewError("");
    setMissing(false);
    try {
      const saved = await request<Group>(`/groups/${base.id}`);
      if (!mounted.current) return;
      if (saved.id !== base.id || saved.revision === undefined) {
        setReviewError(
          "This server cannot provide a version for safe review. Update the server before editing groups.",
        );
        return;
      }
      setLatest(saved);
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof APIError && failure.status === 404) {
        setMissing(true);
        setReviewError(
          "This group is no longer available. Your edits are still here, but they cannot be saved to it.",
        );
      } else setReviewError((failure as Error).message);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (
      !allowed ||
      !compatible ||
      active.current ||
      review ||
      pendingCreate ||
      !name.trim() ||
      loadingMembers ||
      tooMany
    )
      return;
    setError("");
    setBlockedByCanary(false);
    let operation: GroupOperation | null = null;
    try {
      let saved: Group;
      if (base) {
        saved = await request<Group>(`/groups/${base.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: name.trim(),
            description,
            device_ids: [...ids],
            revision: base.revision,
          }),
        });
      } else {
        operation = beginGroupOperation(user.id, {
          name: name.trim(),
          description,
          device_ids: [...ids],
        });
        // A compatible, exact-key lookup proves the server supports recovery.
        // Never send a keyed request to an old server that could ignore its key.
        let lookup: GroupRequestLookup;
        try {
          lookup = await request<GroupRequestLookup>(
            `/groups/requests/${operation.id}`,
          );
        } catch (failure) {
          if (
            failure instanceof APIError &&
            [404, 405].includes(failure.status)
          ) {
            throw Error(
              "Update the server to enable recoverable group creation. Review the saved request before trying again.",
            );
          }
          throw failure;
        }
        if (lookup.request_id !== operation.id)
          throw Error(
            "The server could not confirm recovery support. Review the saved request before trying again.",
          );
        if (!mounted.current) return;
        if (!groupOperationAvailable(operation)) {
          throw Error(
            "The saved request changed in another tab. Review the request before continuing.",
          );
        }
        // Even if this fresh key already exists, POST must verify its payload
        // binding. A lookup alone never proves that it was this form's request.
        saved = await request<Group>("/groups", {
          method: "POST",
          body: JSON.stringify(operation.request),
        });
        const receipt = GroupCreateReceiptSchema.safeParse(saved);
        if (!receipt.success || receipt.data.request_id !== operation.id) {
          throw new APIError(
            "UNCONFIRMED_SAVE",
            "The server did not confirm this group request. Review its status before trying again.",
            502,
          );
        }
        saved = receipt.data;
      }
      if (
        base &&
        (saved.id !== base.id || saved.revision !== base.revision! + 1)
      ) {
        throw new APIError(
          "UNCONFIRMED_SAVE",
          "The save receipt did not identify the expected group version.",
          502,
        );
      }
      if (operation) {
        try {
          finishGroupOperation(operation);
        } catch {
          if (mounted.current) {
            setConfirmedCreate(true);
            setReview("uncertain");
            setReviewError(
              "This browser could not clear its request reminder. Enable browser storage and review the request from Groups to clear it.",
            );
            onRefresh();
          }
          return;
        }
      }
      if (mounted.current) onSaved(saved);
    } catch (failure) {
      if (!mounted.current) return;
      if (!base) {
        // Another tab can send this durable request while this tab is waiting.
        // Neither a failed preflight nor a rejected send proves it was not saved.
        if (operation) {
          setReview("uncertain");
          setReviewError((failure as Error).message);
          return;
        }
        setError((failure as Error).message);
        return;
      }
      if (
        failure instanceof APIError &&
        failure.code === "STALE_REVISION" &&
        failure.serverRejection
      ) {
        setReview("conflict");
        void loadLatest();
      } else if (
        failure instanceof APIError &&
        failure.serverRejection &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.status !== 408
      ) {
        setError(failure.message);
        setBlockedByCanary(failure.code === "ACTIVE_CANARY_OVERLAP");
      } else setReview("uncertain");
    }
  }
  const deviceName = (id: string) =>
    names.get(id) || `Device ${id.slice(0, 8)}…`;
  // Against the latest saved group, when its edits collide with yours.
  const latestIds = useMemo(() => new Set(latest?.device_ids), [latest]);
  const { added, removed } = useMemo(
    () =>
      latest
        ? setDifference(ids, latestIds)
        : { added: [] as string[], removed: [] as string[] },
    [latest, ids, latestIds],
  );
  const editable =
    allowed && compatible && !busy && !loadingMembers && !(!base && !!review);
  const listed = (list: string[]) => (
    <ul>
      {list.slice(0, LISTED).map((id) => (
        <li key={id}>{deviceName(id)}</li>
      ))}
      {list.length > LISTED && (
        <li>and {(list.length - LISTED).toLocaleString()} more</li>
      )}
    </ul>
  );
  function keepNames(rows: Device[]) {
    setNames((previous) => {
      const next = new Map(previous);
      for (const row of rows) next.set(row.id, row.name);
      return next;
    });
  }
  return (
    <Modal
      open
      wide={!!group}
      className="group-editor-modal"
      onClose={close}
      title={(base ?? group)?.name || "Create group"}
      description={
        group && tab === "overview"
          ? (base ?? group).description ||
            "Its members, what is assigned to them and recent rollouts."
          : "Membership changes can update the pipelines and agent settings on these devices."
      }
    >
      {group && (
        <div className="group-tabs" role="tablist" aria-label="Group views">
          <button
            type="button"
            role="tab"
            id="group-tab-overview"
            aria-selected={tab === "overview"}
            aria-controls="group-panel"
            onClick={() => setTab("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            role="tab"
            id="group-tab-members"
            aria-selected={tab === "members"}
            aria-controls="group-panel"
            onClick={() => setTab("members")}
          >
            {allowed ? "Edit members" : "Members"}
          </button>
        </div>
      )}
      {group && tab === "overview" ? (
        <div
          className="group-editor-form"
          id="group-panel"
          role="tabpanel"
          aria-labelledby="group-tab-overview"
        >
          <div className="modal-body">
            <GroupOverview
              group={base ?? group}
              memberCount={
                base
                  ? base.device_ids.length
                  : ((group as GroupSummary).member_count ?? null)
              }
            />
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
            {allowed && (
              <Button onClick={() => setTab("members")}>Edit members</Button>
            )}
          </div>
        </div>
      ) : loadingMembers ? (
        <div
          className="group-editor-form"
          id="group-panel"
          role="tabpanel"
          aria-labelledby="group-tab-members"
        >
          <div className="modal-body">
            <p role="status">Loading members…</p>
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          </div>
        </div>
      ) : group && !base ? (
        <div
          className="group-editor-form"
          id="group-panel"
          role="tabpanel"
          aria-labelledby="group-tab-members"
        >
          <div className="modal-body">
            <ErrorBox
              message={detail.error || "The group's members couldn't load."}
              retry={() => void detail.reload()}
            />
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <div
          className="group-editor-form"
          id={group ? "group-panel" : undefined}
          role={group ? "tabpanel" : undefined}
          aria-labelledby={group ? "group-tab-members" : undefined}
        >
          <form className="group-editor-form" onSubmit={save}>
            <div className="modal-body fleet-group-form">
              {!compatible && (
                <ErrorBox message="Update the server to enable safe group editing. You can still view this group." />
              )}
              {pendingCreate && !review && !busy && (
                <ErrorBox message="Review the pending group request on the Groups page before creating another group. Your existing group edits are still available." />
              )}
              {error && <ErrorBox message={error} />}
              {tooMany && (
                <ErrorBox
                  message={`A group holds up to ${MAX_MEMBERS.toLocaleString()} devices. Remove ${(ids.size - MAX_MEMBERS).toLocaleString()} to save.`}
                />
              )}
              {blockedByCanary && (
                <p className="group-blocked-help">
                  <a
                    href={`#/${deploymentRoute(false, null, { search: "", status: "active", page: 1 })}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Review active deployments
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <span>Your edits stay here while you review.</span>
                </p>
              )}
              {review && (
                <section
                  className="group-review"
                  ref={notice}
                  tabIndex={-1}
                  aria-label="Review group changes"
                >
                  <h3>
                    {confirmedCreate
                      ? "Group saved"
                      : review === "conflict"
                        ? "This group changed"
                        : "Save could not be confirmed"}
                  </h3>
                  <p>
                    {confirmedCreate
                      ? "This group was created successfully. You can close this form and open it from the saved request."
                      : review === "conflict"
                        ? "Your edits are still here. Compare them with the latest saved group before saving again."
                        : !base
                          ? "The server may have created this group. Its exact request is saved in this browser and stays available after closing or reloading. Review it from Groups before trying again."
                          : "The request may have saved. Your edits are still here; check the saved group before trying again."}
                  </p>
                  {reviewError && <ErrorBox message={reviewError} />}
                  {!base ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        onRefresh();
                        onClose();
                      }}
                    >
                      Close and review request
                    </Button>
                  ) : !latest ? (
                    <Button
                      variant="secondary"
                      onClick={loadLatest}
                      busy={busy}
                      disabled={missing}
                    >
                      Review saved group
                    </Button>
                  ) : (
                    <>
                      {latest.name !== name && (
                        <div className="group-review-value">
                          <span>Latest saved name</span>
                          <strong>{latest.name}</strong>
                          <Button
                            variant="ghost"
                            onClick={() => setName(latest.name)}
                          >
                            Use latest name
                          </Button>
                        </div>
                      )}
                      {latest.description !== description && (
                        <div className="group-review-value">
                          <span>Latest saved description</span>
                          <p>{latest.description || "No description"}</p>
                          <Button
                            variant="ghost"
                            onClick={() => setDescription(latest.description)}
                          >
                            Use latest description
                          </Button>
                        </div>
                      )}
                      <div className="group-review-members">
                        <strong>
                          Membership compared with the saved group
                        </strong>
                        {added.length > 0 && (
                          <div>
                            <span>
                              Your edits would add {added.length}{" "}
                              {added.length === 1 ? "device" : "devices"}
                            </span>
                            {listed(added)}
                          </div>
                        )}
                        {removed.length > 0 && (
                          <div>
                            <span>
                              Your edits would remove {removed.length}{" "}
                              {removed.length === 1 ? "device" : "devices"}
                            </span>
                            {listed(removed)}
                          </div>
                        )}
                        {!added.length && !removed.length ? (
                          <p>Your selection matches the saved membership.</p>
                        ) : (
                          <Button
                            variant="secondary"
                            onClick={() => setIds(new Set(latest.device_ids))}
                          >
                            Use latest members
                          </Button>
                        )}
                      </div>
                      <p>
                        Keep the edits shown below or use saved values above.
                        Continuing does not save anything.
                      </p>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setBase(latest);
                          setLatest(null);
                          setReview(null);
                          setError("");
                          nameInput.current?.focus();
                        }}
                      >
                        Continue editing
                      </Button>
                    </>
                  )}
                </section>
              )}
              <Field label="Group name">
                <input
                  ref={nameInput}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={120}
                  required
                  readOnly={!allowed || !compatible || (!base && !!review)}
                  disabled={busy}
                  placeholder="e.g. Production"
                />
              </Field>
              <Field label="Description (optional)">
                <textarea
                  rows={2}
                  value={description}
                  maxLength={2000}
                  readOnly={!allowed || !compatible || (!base && !!review)}
                  disabled={busy}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              <div className="fleet-members-heading">
                <h3>Devices</h3>
                <span>{ids.size.toLocaleString()} selected</span>
              </div>
              {base && (addedIds.length > 0 || removedIds.length > 0) && (
                <p className="group-changes" aria-live="polite">
                  <span>
                    <strong>{addedIds.length.toLocaleString()}</strong> added ·{" "}
                    <strong>{removedIds.length.toLocaleString()}</strong>{" "}
                    removed since it was saved
                  </span>
                  <Button
                    variant="ghost compact"
                    disabled={!editable}
                    onClick={() => setIds(new Set(base.device_ids))}
                  >
                    Undo device changes
                  </Button>
                </p>
              )}
              <SearchBox
                value={search}
                onChange={setSearch}
                placeholder="Find a device"
              />
              <DevicePicker
                label="Group devices"
                search={search}
                isChecked={(device) => ids.has(device.id)}
                disabled={!editable}
                onToggle={(device) =>
                  setIds((previous) => toggled(previous, device.id))
                }
                onRows={keepNames}
                onMatching={(found, rows) => {
                  keepNames(rows);
                  setIds((previous) => withIds(previous, found.ids));
                }}
                actions={
                  <Button
                    variant="ghost compact"
                    disabled={!editable || ids.size === 0}
                    onClick={() => setIds(new Set())}
                  >
                    Remove all
                  </Button>
                }
              />
              {base && allowed && compatible && !review && (
                <GroupMembershipEffects group={base} ids={ids} />
              )}
            </div>
            <div className="modal-footer">
              <Button variant="secondary" onClick={close} disabled={busy}>
                {allowed && !(review === "uncertain" && !base)
                  ? "Cancel"
                  : "Close"}
              </Button>
              {allowed && (
                <Button
                  type="submit"
                  busy={busy}
                  disabled={
                    !compatible ||
                    pendingCreate ||
                    !!review ||
                    !name.trim() ||
                    (base !== null && !changed) ||
                    loadingMembers ||
                    tooMany
                  }
                >
                  {base ? "Save changes" : "Create group"}
                </Button>
              )}
            </div>
          </form>
        </div>
      )}
    </Modal>
  );
}
