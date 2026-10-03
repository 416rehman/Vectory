// Roll out an agent build: choose a release and the devices, then read the
// server's review of exactly who will and won't update, and start the rollout
// on that review. Nothing starts without it, and a review that went stale (a
// device, a release or a key changed) is asked for again, never overridden.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search } from "lucide-react";
import {
  AgentInstallSchema,
  type AgentInstall,
  type Device,
  type GroupSummary,
  type User,
} from "./api";
import {
  observationText,
  reviewView,
  type AgentRelease,
  type AgentUpdates,
  type ReviewGroup,
  type UpdatePreview,
  type UpdateRollout,
} from "./agentUpdateModel";
import { startRollout, previewRollout } from "./agentUpdateApi";
import { describeFailure, type Failure } from "./agentUpdateRequests";
import {
  canaryWhy,
  defaultSettings,
  forkText,
  fixIsHostCommand,
  groupNeedsChoice,
  hostFixBlocks,
  hostFixCommand,
  levelLine,
  nameProblem,
  previewRequest,
  reviewSentence,
  rolloutSettings,
  settingsErrors,
  startRequest,
  windowLine,
  type ReviewForm,
} from "./agentUpdateReviewModel";
import {
  emptyConsent,
  readConsent,
  type ConsentForm,
} from "./agentUpdateConsent";
import { shortKeyId } from "./releaseKey";
import { UpdateConsentFields } from "./UpdateConsentFields";
import { CommandBlock } from "./CommandBlock";
import { CanaryChoice } from "./CanaryPicker";
import { NumberField } from "./DeploymentReview";
import DevicePicker from "./DevicePicker";
import DocLink from "./DocLink";
import { DataTable } from "./DataTable";
import { Unconfirmed } from "./authControls";
import { useDeviceDetails } from "./useDeviceDetails";
import { withIds } from "./deviceInventory";
import { devicesText } from "./deploymentReviewModel";
import { Button, ErrorBox, Field, Modal, Spinner, useResource } from "./ui";
import "./control.css";
import "./target-dialog.css";
import "./agent-updates.css";

/** Devices named in a card before "and N more". */
const NAMED = 8;
/** Devices a card makes host commands for; the rest read theirs on their own page. */
const COMMANDED = 50;
/** Groups listed at once; a search narrows the rest. */
const GROUPS_SHOWN = 50;

const shortTime = (instant: string) =>
  new Date(instant).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function UpdateReviewDialog({
  releases,
  initialReleaseId,
  initialDeviceIds = [],
  updates,
  returnFocusRef,
  onClose,
  onStarted,
}: {
  user: User;
  /** The releases a rollout can start from now. */
  releases: AgentRelease[];
  initialReleaseId: string;
  initialDeviceIds?: string[];
  updates: AgentUpdates;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onClose(): void;
  onStarted(rollout: UpdateRollout): void;
}) {
  const [form, setForm] = useState<ReviewForm>({
    releaseId: initialReleaseId,
    groupIds: [],
    deviceIds: initialDeviceIds,
    ...defaultSettings,
    canaryDeviceIds: [],
    name: "",
  });
  const [names, setNames] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<{
    preview: UpdatePreview;
    /** The choices this review was made for. */
    form: ReviewForm;
  } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [stale, setStale] = useState(false);
  const [starting, setStarting] = useState<"idle" | "sending" | "unconfirmed">(
    "idle",
  );
  // The identity of the request that starts this rollout, kept with the exact
  // body it was sent with: the same request again can't start a second one,
  // and any other body gets its own identity.
  const attempt = useRef<{ body: string; requestId: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const groups = useResource<GroupSummary[]>("/groups?slim=1", []);
  const [groupSearch, setGroupSearch] = useState("");
  const matchingGroups = groups.data.filter((group) =>
    group.name.toLowerCase().includes(groupSearch.trim().toLowerCase()),
  );
  const shownGroups = matchingGroups.slice(0, GROUPS_SHOWN);

  const release = releases.find((item) => item.id === form.releaseId);
  const errors = settingsErrors(form);
  const nameIssue = nameProblem(form.name);
  const chosen = form.deviceIds.length + form.groupIds.length;
  const choosable = chosen > 0 && !Object.keys(errors).length && !nameIssue;
  const reviewed = picked?.preview ?? null;
  const working = reviewing || starting === "sending";

  /** Any change to the choices makes the review (and its identity) void. */
  function change(patch: Partial<ReviewForm>) {
    setForm((old) => ({ ...old, ...patch }));
    setPicked(null);
    setFailure(null);
    setStale(false);
    attempt.current = null;
    setStarting("idle");
  }
  function toggle(list: "groupIds" | "deviceIds", id: string) {
    const now = form[list];
    const next = now.includes(id)
      ? now.filter((item) => item !== id)
      : [...now, id];
    if (list === "groupIds") change({ groupIds: next, canaryDeviceIds: [] });
    else change({ deviceIds: next, canaryDeviceIds: [] });
  }
  function chooseDevice(device: Device) {
    setNames((old) => ({ ...old, [device.id]: device.name }));
    toggle("deviceIds", device.id);
  }

  async function review(next: ReviewForm = form) {
    if (reviewing) return;
    setReviewing(true);
    setFailure(null);
    setStale(false);
    try {
      const preview = await previewRollout(previewRequest(next));
      if (!mounted.current) return;
      attempt.current = null;
      setStarting("idle");
      setPicked({ preview, form: next });
    } catch (error) {
      if (!mounted.current) return;
      setFailure(describeFailure(error));
    } finally {
      if (mounted.current) setReviewing(false);
    }
  }
  /** Asks again with these canary devices named (or none: the server chooses). */
  function chooseCanary(ids: string[]) {
    const next = { ...form, canaryDeviceIds: ids };
    setForm(next);
    void review(next);
  }

  async function start() {
    if (!picked || working || stale) return;
    const { request_id: _identity, ...withoutIdentity } = startRequest(
      picked.form,
      picked.preview,
      "",
    );
    const body = JSON.stringify(withoutIdentity);
    // A second press with the same choices and the same review sends the same
    // identity; anything else is a new request.
    if (attempt.current?.body !== body)
      attempt.current = { body, requestId: crypto.randomUUID() };
    setStarting("sending");
    setFailure(null);
    try {
      const rollout = await startRollout(
        startRequest(picked.form, picked.preview, attempt.current.requestId),
      );
      if (mounted.current) onStarted(rollout);
    } catch (error) {
      if (!mounted.current) return;
      const found = describeFailure(error);
      setFailure(found);
      if (found.definite) {
        // The server refused and nothing started: the request is finished.
        attempt.current = null;
        setStarting("idle");
        if (
          ["UPDATE_REVIEW_CHANGED", "UPDATE_ROLLOUT_OVERLAP"].includes(
            found.code,
          )
        )
          setStale(true);
      } else setStarting("unconfirmed");
    }
  }

  const view = reviewed ? reviewView(reviewed) : null;
  const needsInstall = !!view?.wontUpdate.some(fixIsHostCommand);
  const installResource = useResource<unknown>(
    needsInstall ? "/agent-install" : null,
    null,
  );
  const install = useMemo<AgentInstall | null>(() => {
    const raw = installResource.data as { releases?: unknown } | null;
    if (!raw) return null;
    const parsed = AgentInstallSchema.safeParse({ ...raw, releases: [] });
    return parsed.success ? parsed.data : null;
  }, [installResource.data]);

  return (
    <Modal
      open
      onClose={() => {
        if (!working) onClose();
      }}
      returnFocusRef={returnFocusRef}
      wide
      className="target-dialog update-review"
      title={
        release ? `Roll out agent ${release.version}` : "Roll out an agent"
      }
      description={
        reviewed
          ? "Check who will and won't update, then start. Nothing starts until you do."
          : "Choose the devices and how the rollout goes, then review exactly who updates."
      }
    >
      <div className="modal-body target-flow">
        <ol className="control-steps" aria-label="Rollout steps">
          <li aria-current={!reviewed ? "step" : undefined}>
            <span>1</span>Devices and rollout
          </li>
          <li aria-current={reviewed ? "step" : undefined}>
            <span>2</span>Review and start
          </li>
        </ol>
        {failure && starting !== "unconfirmed" && (
          <ErrorBox message={failure.message} />
        )}
        {starting === "unconfirmed" && (
          <Unconfirmed
            title="We couldn't confirm the rollout started"
            details={
              attempt.current && (
                <>
                  Request <code>{attempt.current.requestId}</code>
                </>
              )
            }
          >
            <p>
              It may have started. Send the same request again: it can&apos;t
              start a second rollout, and it returns the first if there is one.
              Or check Devices, Agent updates for it.
            </p>
          </Unconfirmed>
        )}
        {!reviewed ? (
          <fieldset className="target-selection" disabled={reviewing}>
            <Field
              label="Release"
              hint="Signed, not expired, not withdrawn. Hosts install only a build their pinned key signed."
            >
              <select
                value={form.releaseId}
                onChange={(event) => change({ releaseId: event.target.value })}
              >
                {releases.map((item) => (
                  <option key={item.id} value={item.id}>
                    Agent {item.version} · counter {item.counter}
                    {item.signer
                      ? ` · key ${shortKeyId(item.signer.fingerprint)}`
                      : ""}
                  </option>
                ))}
              </select>
            </Field>
            <label className="target-search">
              <Search size={17} aria-hidden="true" />
              <input
                aria-label="Find targets"
                placeholder="Search devices or groups"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setGroupSearch(event.target.value);
                }}
              />
            </label>
            {groups.data.length > 0 && (
              <details
                className="control-disclosure target-group-list"
                open={groups.data.length <= 12}
              >
                <summary>
                  Choose groups ({groups.data.length})
                  {form.groupIds.length > 0 &&
                    `, ${form.groupIds.length} selected`}
                </summary>
                <div className="target-group-options">
                  {shownGroups.map((group) => (
                    <label className="target-option" key={group.id}>
                      <input
                        type="checkbox"
                        checked={form.groupIds.includes(group.id)}
                        onChange={() => toggle("groupIds", group.id)}
                      />
                      <span>
                        <strong>{group.name}</strong>
                        <small>{devicesText(group.member_count)}</small>
                      </span>
                    </label>
                  ))}
                  {matchingGroups.length > shownGroups.length && (
                    <p className="control-muted">
                      Showing {shownGroups.length} of{" "}
                      {matchingGroups.length.toLocaleString()} groups. Search to
                      narrow the list.
                    </p>
                  )}
                  {!matchingGroups.length && (
                    <p className="control-muted">
                      No groups match your search.
                    </p>
                  )}
                </div>
                <p className="control-muted">
                  A group sends the update to the devices it holds when you
                  start. A device that joins later isn&apos;t added.
                </p>
              </details>
            )}
            <div className="target-device-list">
              <h3>Devices</h3>
              <DevicePicker
                label="Devices to update"
                search={search}
                isChecked={(device) => form.deviceIds.includes(device.id)}
                onToggle={chooseDevice}
                onRows={(rows) =>
                  setNames((old) => ({
                    ...old,
                    ...Object.fromEntries(
                      rows.map((device) => [device.id, device.name]),
                    ),
                  }))
                }
                onMatching={(found, rows) => {
                  setNames((old) => ({
                    ...old,
                    ...Object.fromEntries(
                      rows.map((device) => [device.id, device.name]),
                    ),
                  }));
                  change({
                    deviceIds: [...withIds(new Set(form.deviceIds), found.ids)],
                    canaryDeviceIds: [],
                  });
                }}
                note={(device) => device.agent_version ?? null}
                actions={
                  <Button
                    variant="ghost compact"
                    disabled={!chosen}
                    onClick={() =>
                      change({
                        groupIds: [],
                        deviceIds: [],
                        canaryDeviceIds: [],
                      })
                    }
                  >
                    Clear selection
                  </Button>
                }
              />
            </div>
            <div className="target-selection-summary">
              {form.deviceIds.length.toLocaleString()}{" "}
              {form.deviceIds.length === 1 ? "device" : "devices"}
              {form.groupIds.length > 0 &&
                ` and ${form.groupIds.length} ${form.groupIds.length === 1 ? "group" : "groups"}`}{" "}
              chosen. The review says which of them will update.
            </div>
            <section className="release-strategy">
              <h3>Rollout</h3>
              <p className="release-plan">
                <Check size={15} aria-hidden="true" />
                <span>
                  A canary of {Number.isFinite(form.canary) ? form.canary : "?"}{" "}
                  goes first, then batches of{" "}
                  {Number.isFinite(form.batch) ? form.batch : "?"}. Each stage
                  is watched for{" "}
                  {Number.isFinite(form.observe)
                    ? observationText(form.observe)
                    : "?"}{" "}
                  after its devices are done, and the rollout stops when
                  failures pass {form.threshold} (
                  {form.threshold === 0
                    ? "the first one stops it"
                    : `${form.threshold + 1} stop it`}
                  ). There is no all-at-once.
                </span>
              </p>
              <div className="release-canary">
                <NumberField
                  label="Canary size"
                  value={form.canary}
                  min={1}
                  max={100}
                  error={errors.canary}
                  hint="Who goes first is chosen in the review."
                  onChange={(canary) => change({ canary, canaryDeviceIds: [] })}
                />
                <NumberField
                  label="Then batches of"
                  value={form.batch}
                  min={1}
                  max={50}
                  error={errors.batch}
                  onChange={(batch) => change({ batch })}
                />
                <NumberField
                  label="Watch each stage for"
                  value={form.observe}
                  min={60}
                  max={86400}
                  suffix="s"
                  error={errors.observe}
                  hint="After every device in it is done."
                  onChange={(observe) => change({ observe })}
                />
                <NumberField
                  label="Stop if more than"
                  value={form.threshold}
                  min={0}
                  max={100}
                  suffix="fail"
                  error={errors.threshold}
                  hint={
                    form.threshold === 0
                      ? "0 stops at the first rollback or failure."
                      : `Stops when ${Number.isInteger(form.threshold) ? form.threshold + 1 : "more"} devices roll back or fail.`
                  }
                  onChange={(threshold) => change({ threshold })}
                />
              </div>
              <Field
                label="Name (optional)"
                hint={nameIssue || "Shown in the list. Empty uses the release."}
              >
                <input
                  value={form.name}
                  maxLength={120}
                  autoComplete="off"
                  aria-invalid={!!nameIssue}
                  onChange={(event) => change({ name: event.target.value })}
                />
              </Field>
            </section>
          </fieldset>
        ) : (
          view &&
          picked && (
            <ReviewStep
              preview={picked.preview}
              view={view}
              form={picked.form}
              names={names}
              updates={updates}
              install={install}
              installError={
                installResource.error
                  ? "The server's install details couldn't be read, so no host command can be made."
                  : ""
              }
              busy={working}
              onChooseCanary={chooseCanary}
            />
          )
        )}
        {stale && (
          <div className="control-note" role="status">
            <p>
              The review is out of date. Review again to see what changed; no
              rollout was started.
            </p>
            <Button
              variant="secondary compact"
              busy={reviewing}
              onClick={() => picked && void review(picked.form)}
            >
              Review again
            </Button>
          </div>
        )}
      </div>
      <div className="modal-footer target-footer">
        <Button variant="secondary" disabled={working} onClick={onClose}>
          Cancel
        </Button>
        {reviewed ? (
          <>
            <Button
              variant="secondary"
              disabled={working}
              onClick={() => {
                setPicked(null);
                setFailure(null);
                setStale(false);
                attempt.current = null;
                setStarting("idle");
              }}
            >
              Change choices
            </Button>
            <Button
              busy={starting === "sending"}
              disabled={
                working || stale || !view || view.willUpdate.length === 0
              }
              onClick={() => void start()}
            >
              {starting === "unconfirmed"
                ? "Send the same request again"
                : "Start update rollout"}
            </Button>
          </>
        ) : (
          <>
            {!choosable && !reviewing && (
              <span className="control-muted" role="status">
                {chosen === 0
                  ? "Choose devices or groups first."
                  : "Check the highlighted numbers."}
              </span>
            )}
            <Button
              busy={reviewing}
              disabled={!choosable || !release || reviewing}
              onClick={() => void review()}
            >
              Review
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ---------- Step 2: who will and won't update ---------- */

function ReviewStep({
  preview,
  view,
  form,
  names,
  updates,
  install,
  installError,
  busy,
  onChooseCanary,
}: {
  preview: UpdatePreview;
  view: ReturnType<typeof reviewView>;
  form: ReviewForm;
  names: Record<string, string>;
  updates: AgentUpdates;
  install: AgentInstall | null;
  installError: string;
  busy: boolean;
  onChooseCanary(ids: string[]): void;
}) {
  const [page, setPage] = useState(1);
  const settings = rolloutSettings(form);
  const canaryIds = new Set(preview.canary.device_ids);
  const candidates = view.willUpdate.map((device) => ({
    id: device.device_id,
    name: device.device_name || "an unnamed device",
    note: `${levelLine(device)} · ${windowLine(device, shortTime)}`,
  }));
  const current = preview.canary.device_ids.map((id) => ({
    id,
    name:
      view.willUpdate.find((device) => device.device_id === id)?.device_name ||
      names[id] ||
      "an unnamed device",
  }));
  return (
    <div className="update-review-body">
      <p className="update-review-sentence" role="status">
        {reviewSentence(preview, settings)}
      </p>
      <DocLink
        topic="agent-updates"
        section="read-the-review"
        className="doc-term-link update-doc"
      >
        How to read this review
      </DocLink>
      <section aria-labelledby="update-will">
        <h3 id="update-will" className="update-review-heading">
          Will update · {view.willUpdate.length.toLocaleString()}
        </h3>
        {view.willUpdate.length > 0 ? (
          <>
            <CanaryChoice
              candidates={candidates}
              size={preview.canary.size}
              current={current}
              chosen={preview.canary.chosen_by_you ? form.canaryDeviceIds : []}
              why={canaryWhy(preview)}
              noun="update"
              busy={busy}
              onChoose={onChooseCanary}
            />
            <p className="control-muted update-canary-note">
              The canary&apos;s result is what its devices report. Naming canary
              devices your team trusts is how to rely on it.
            </p>
            <div className="control-table">
              <DataTable<UpdatePreview["will_update"][number]>
                label="Devices that will update"
                data={view.willUpdate}
                rowKey={(device) => device.device_id}
                pagination={{
                  page,
                  size: 10,
                  onPage: setPage,
                  noun: "devices",
                }}
                mobileCard={(device) => ({
                  title: (
                    <>
                      {device.device_name || "An unnamed device"}
                      {canaryIds.has(device.device_id) && (
                        <span className="update-canary-tag">Canary</span>
                      )}
                    </>
                  ),
                  meta: [levelLine(device), windowLine(device, shortTime)],
                })}
                columns={[
                  {
                    id: "name",
                    header: "Device",
                    cell: (device) => (
                      <>
                        <strong>
                          {device.device_name || "An unnamed device"}
                        </strong>
                        {canaryIds.has(device.device_id) && (
                          <span className="update-canary-tag">Canary</span>
                        )}
                      </>
                    ),
                  },
                  {
                    id: "level",
                    header: "Takes the update",
                    cell: (device) => levelLine(device),
                  },
                  {
                    id: "window",
                    header: "Starts",
                    cell: (device) => windowLine(device, shortTime),
                  },
                ]}
              />
            </div>
          </>
        ) : (
          <p className="control-muted">
            Nobody in this review will update. Fix what the groups below list,
            then review again.
          </p>
        )}
      </section>

      {view.wontCount > 0 && (
        <section aria-labelledby="update-wont">
          <h3 id="update-wont" className="update-review-heading">
            Won&apos;t update · {view.wontCount.toLocaleString()}
          </h3>
          <div className="update-wont-groups">
            {view.wontUpdate.map((group) => (
              <WontGroup
                key={group.code}
                group={group}
                install={install}
                installError={installError}
                currentKey={updates.current_key}
              />
            ))}
          </div>
        </section>
      )}

      {view.warnings.length > 0 && (
        <section aria-labelledby="update-warn">
          <h3 id="update-warn" className="update-review-heading">
            Worth knowing
          </h3>
          <ul className="update-warnings">
            {view.warnings.map((warning) => (
              <li key={warning.code}>
                <strong>{warning.message}</strong>
                <span>
                  {warning.devices
                    .slice(0, NAMED)
                    .map((device) => device.name)
                    .join(", ")}
                  {warning.devices.length > NAMED
                    ? ` and ${warning.devices.length - NAMED} more`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Devices that won't update for one reason, with what fixes it. */
function WontGroup({
  group,
  install,
  installError,
  currentKey,
}: {
  group: ReviewGroup;
  install: AgentInstall | null;
  installError: string;
  currentKey: AgentUpdates["current_key"];
}) {
  const keyFingerprint = currentKey?.fingerprint ?? null;
  return (
    <article className="update-wont" data-code={group.code}>
      <header>
        <strong>{group.title}</strong>
        <span className="control-muted">
          {devicesText(group.devices.length)}
        </span>
      </header>
      <p>{group.reason}</p>
      {group.fix && (
        <p className="update-fix">
          <strong>Fix</strong> {group.fix}
        </p>
      )}
      <p className="update-wont-names">
        {group.devices
          .slice(0, NAMED)
          .map((device) => device.name)
          .join(", ")}
        {group.devices.length > NAMED
          ? ` and ${group.devices.length - NAMED} more`
          : ""}
      </p>
      {group.code === "KEY_ROLLOVER_CONFLICT" &&
        group.devices
          .filter((device) => device.successors)
          .slice(0, NAMED)
          .map((device) => (
            <p key={device.id} className="update-fork">
              <strong>{device.name}</strong>{" "}
              {forkText(device.successors!, keyFingerprint)}
            </p>
          ))}
      {fixIsHostCommand(group) && (
        <HostFixes
          group={group}
          install={install}
          installError={installError}
          currentKey={currentKey}
        />
      )}
    </article>
  );
}

/**
 * The commands that fix a group's devices, made from what each device
 * reported. They are read only when the card is opened, a few at a time, and
 * a device that can't have a command is named with why.
 */
function HostFixes({
  group,
  install,
  installError,
  currentKey,
}: {
  group: ReviewGroup;
  install: AgentInstall | null;
  installError: string;
  currentKey: AgentUpdates["current_key"];
}) {
  const keyFingerprint = currentKey?.fingerprint ?? null;
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState<ConsentForm>(emptyConsent);
  const listed = group.devices.slice(0, COMMANDED);
  const details = useDeviceDetails(
    listed.map((device) => device.id),
    open,
  );
  const needsChoice = groupNeedsChoice(group);
  const read = readConsent(consent, keyFingerprint, {
    levels: ["auto", "ask"],
  });
  const choice =
    read.consent && read.consent.level !== "off"
      ? {
          level: read.consent.level,
          track: read.consent.track,
          windows: read.consent.windows,
        }
      : undefined;
  const inputs = listed.map((device) => {
    const record = details.devices[device.id];
    return {
      name: device.name,
      read: !!record,
      failed: details.failed[device.id],
      command:
        record && install && keyFingerprint
          ? hostFixCommand({
              group,
              device: record,
              install,
              key: keyFingerprint,
              choice,
            })
          : null,
    };
  });
  const ready = inputs.filter((item) => item.read);
  const { blocks, without } = hostFixBlocks(ready);
  const waiting = needsChoice && !choice;
  return (
    <details
      className="update-fixes"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Commands for the {group.devices.length === 1 ? "host" : "hosts"}
      </summary>
      <div className="update-fixes-body">
        <p className="control-muted">
          Each command is the Upgrade agent command for that host, with only the
          change this fix needs, such as the key to pin. The host keeps what it
          already allows. Run it on the host, as shown.
        </p>
        {!keyFingerprint && (
          <p className="control-note" role="status">
            This server has no release key, so no command can pin one.
          </p>
        )}
        {installError && <ErrorBox message={installError} />}
        {needsChoice && (
          <UpdateConsentFields
            value={consent}
            onChange={(patch) => setConsent((old) => ({ ...old, ...patch }))}
            read={read}
            signingKey={currentKey}
            levels={["auto", "ask"]}
            legend="How should these hosts take agent updates?"
            name={`fix-${group.code}`}
          />
        )}
        {open && details.loading && (
          <p className="control-muted" role="status">
            <Spinner size={14} /> Reading the hosts…
          </p>
        )}
        {open && !waiting && !!keyFingerprint && !!install && (
          <>
            {blocks.map((block) => (
              <CommandBlock
                key={block.command}
                command={block.command}
                label={`Upgrade command for ${block.devices.join(", ")}`}
                heading={
                  blocks.length === 1 && !without.length
                    ? group.devices.length === 1
                      ? `On ${block.devices[0]}`
                      : "On these hosts"
                    : `On ${block.devices.join(", ")}`
                }
              />
            ))}
            {without.length > 0 && (
              <p className="control-muted">
                No command for {without.join(", ")}: its host isn&apos;t a Linux
                or macOS host this page can make one for, or a path it reported
                can&apos;t go in a command. Open its page for the steps.
              </p>
            )}
            {inputs.some((item) => item.failed) && (
              <p className="control-muted">
                {inputs.filter((item) => item.failed).length} host
                {inputs.filter((item) => item.failed).length === 1
                  ? "'s"
                  : "s'"}{" "}
                record couldn&apos;t be read.
              </p>
            )}
          </>
        )}
        {group.devices.length > COMMANDED && (
          <p className="control-muted">
            Commands for the first {COMMANDED} hosts. Open each other host for
            its own.
          </p>
        )}
      </div>
    </details>
  );
}
