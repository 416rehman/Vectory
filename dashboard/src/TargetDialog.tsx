import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Clock3,
  Layers,
  Rocket,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  post,
  type Device,
  type Group,
  type Policy,
  type Version,
} from "./api";
import { Badge, Button, ErrorBox, Field, Modal, useResource } from "./ui";
export default function TargetDialog({
  open,
  onClose,
  version,
  policy,
  onDone,
  initialDeviceIds = [],
}: {
  open: boolean;
  onClose: () => void;
  version?: Version;
  policy?: Policy;
  onDone: (message: string) => void;
  initialDeviceIds?: string[];
}) {
  const devices = useResource<Device[]>("/devices", []),
    groups = useResource<Group[]>("/groups", []);
  const [selected, setSelected] = useState<string[]>(initialDeviceIds),
    [groupIds, setGroupIds] = useState<string[]>([]),
    [exclude, setExclude] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [priority, setPriority] = useState(100),
    [mode, setMode] = useState("snapshot"),
    [schedule, setSchedule] = useState(""),
    [rollout, setRollout] = useState("all"),
    [canary, setCanary] = useState(1),
    [batch, setBatch] = useState(10),
    [observe, setObserve] = useState(60),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<any>(null);
  const body = useMemo(
    () => ({
      ...(version ? { version_id: version.id } : { policy }),
      selector: {
        device_ids: selected,
        group_ids: groupIds,
        exclude_ids: exclude,
      },
      priority,
      target_mode: schedule ? "snapshot" : mode,
      scheduled_at: schedule ? new Date(schedule).toISOString() : null,
      rollout: {
        kind: rollout,
        canary_size: canary,
        batch_size: batch,
        observation_seconds: observe,
        failure_threshold: 0,
      },
    }),
    [
      version,
      policy,
      selected,
      groupIds,
      exclude,
      priority,
      mode,
      schedule,
      rollout,
      canary,
      batch,
      observe,
    ],
  );
  const effective = useMemo(
    () =>
      new Set(
        [
          ...selected,
          ...groups.data
            .filter((g) => groupIds.includes(g.id))
            .flatMap((g) => g.device_ids),
        ].filter((id) => !exclude.includes(id)),
      ),
    [selected, groupIds, exclude, groups.data],
  );
  const currentBody = useRef("");
  currentBody.current = JSON.stringify(body);
  function change<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setPreview(null);
  }
  function toggle(
    value: string,
    list: string[],
    setter: (v: string[]) => void,
  ) {
    change(
      setter,
      list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
    );
  }
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (!preview) {
        const request = structuredClone(body),
          key = JSON.stringify(request);
        const result = await post<any>("/deployments/preview", request);
        if (currentBody.current === key)
          setPreview({ ...result, request, key });
        else
          setError(
            "Targets changed during preview. Review the current selection again.",
          );
      } else {
        if (preview.key !== currentBody.current) {
          setPreview(null);
          throw Error(
            "The selection changed. Preview it again before deploying.",
          );
        }
        await post("/deployments", {
          ...preview.request,
          expected_device_ids: preview.devices.map((d: Device) => d.id),
        });
        onDone(
          schedule
            ? "Deployment scheduled. Target membership is frozen."
            : "Deployment created. Waiting for agents to acknowledge.",
        );
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={policy ? "Deploy agent policy" : "Deploy configuration"}
      description="Choose targets, review the effective assignment, then release a new generation."
    >
      <div className="modal-body">
        <div className="deployment-summary">
          <div className="square-icon">
            <Rocket size={20} />
          </div>
          <div>
            <strong>
              {version ? `Version ${version.number}` : "Agent policy"}
            </strong>
            <small>
              {version
                ? version.sha256.slice(0, 20) + "…"
                : `${policy?.heartbeat_seconds}s heartbeat · sync ${policy?.sync_paused ? "paused" : "enabled"}`}
            </small>
          </div>
          <Badge status="desired">Ready to assign</Badge>
        </div>
        {(error || devices.error || groups.error) && (
          <ErrorBox message={error || devices.error || groups.error} />
        )}
        <fieldset className="target-grid" disabled={busy}>
          <div>
            <h3>1. Select your targets</h3>
            <p className="muted">
              Devices and group members are combined. Exclusions always win.
            </p>
            <div className="search-field">
              <Search size={16} />
              <input
                aria-label="Find targets"
                placeholder="Find a device or group…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="target-list">
              <div className="list-eyebrow">Groups</div>
              {groups.data
                .filter((g) =>
                  g.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((g) => (
                  <label className="target-row" key={g.id}>
                    <input
                      type="checkbox"
                      checked={groupIds.includes(g.id)}
                      onChange={() => toggle(g.id, groupIds, setGroupIds)}
                    />
                    <Layers size={17} />
                    <span>
                      {g.name}
                      <small>{g.device_ids.length} members</small>
                    </span>
                  </label>
                ))}
              {!groups.data.length && (
                <p className="muted small-pad">No groups yet.</p>
              )}
              <div className="list-eyebrow">Devices</div>
              {devices.data
                .filter((d) =>
                  d.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((d) => (
                  <div className="target-row" key={d.id}>
                    <input
                      aria-label={`Select ${d.name}`}
                      type="checkbox"
                      checked={selected.includes(d.id)}
                      onChange={() => toggle(d.id, selected, setSelected)}
                    />
                    <span>
                      {d.name}
                      <small>
                        {d.os} · {d.status}
                      </small>
                    </span>
                    <label className="exclude">
                      <input
                        type="checkbox"
                        checked={exclude.includes(d.id)}
                        onChange={() => toggle(d.id, exclude, setExclude)}
                      />
                      Exclude
                    </label>
                  </div>
                ))}
              {!devices.data.length && (
                <p className="muted small-pad">
                  Enroll a device before deploying.
                </p>
              )}
            </div>
            <div className="selection-total">
              <Check size={15} />
              {effective.size} unique devices selected
            </div>
          </div>
          <div>
            <h3>2. Configure the rollout</h3>
            <Field
              label="Assignment priority"
              hint="Higher numbers win. Conflicting equal priorities are rejected."
            >
              <input
                type="number"
                value={priority}
                min={0}
                max={1000000}
                onChange={(e) => change(setPriority, +e.target.value)}
              />
            </Field>
            <Field label="Target membership">
              <select
                value={schedule ? "snapshot" : mode}
                disabled={!!schedule}
                onChange={(e) => change(setMode, e.target.value)}
              >
                <option value="snapshot">
                  Snapshot — selected devices only
                </option>
                <option value="persistent">
                  Persistent — follow group membership
                </option>
              </select>
            </Field>
            <Field label="Release strategy">
              <select
                value={rollout}
                onChange={(e) => change(setRollout, e.target.value)}
              >
                <option value="all">All at once</option>
                <option value="canary">Canary, then batches</option>
              </select>
            </Field>
            {rollout === "canary" && (
              <div className="form-row">
                <Field label="Canary devices">
                  <input
                    min={1}
                    type="number"
                    value={canary}
                    onChange={(e) => change(setCanary, +e.target.value)}
                  />
                </Field>
                <Field label="Batch size">
                  <input
                    min={1}
                    type="number"
                    value={batch}
                    onChange={(e) => change(setBatch, +e.target.value)}
                  />
                </Field>
                <Field label="Observe (seconds)">
                  <input
                    min={10}
                    max={86400}
                    type="number"
                    value={observe}
                    onChange={(e) => change(setObserve, +e.target.value)}
                  />
                </Field>
              </div>
            )}
            <Field
              label="Schedule (optional)"
              hint={`Your timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Schedules freeze membership at creation.`}
            >
              <input
                type="datetime-local"
                value={schedule}
                min={new Date(
                  Date.now() + 60000 - new Date().getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 16)}
                onChange={(e) => change(setSchedule, e.target.value)}
              />
            </Field>
          </div>
        </fieldset>
        {preview && (
          <div
            className={`preview-box ${preview.conflicts?.length ? "has-conflict" : ""}`}
          >
            <h3>
              {preview.conflicts?.length ? (
                <AlertTriangle size={18} />
              ) : (
                <ShieldCheck size={18} />
              )}
              Assignment preview
            </h3>
            <p>
              {preview.devices?.length ?? effective.size} devices evaluated.{" "}
              {preview.conflicts?.length
                ? `${preview.conflicts.length} conflicts need resolution.`
                : "No assignment conflicts detected."}
            </p>
            {preview.conflicts?.map((c: any, i: number) => (
              <p key={i}>{typeof c === "string" ? c : JSON.stringify(c)}</p>
            ))}
            {preview.warnings?.map((w: string) => (
              <p key={w}>{w}</p>
            ))}
            <div className="preview-devices">
              {preview.devices?.map((d: Device) => (
                <span key={d.id}>{d.name}</span>
              ))}
            </div>
            <small>
              Offline and unverified devices remain pending. Cancelling a
              rollout does not undo configurations already released.
            </small>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          icon={preview ? (schedule ? Clock3 : Rocket) : ArrowRight}
          busy={busy}
          disabled={
            !effective.size ||
            devices.loading ||
            groups.loading ||
            !!preview?.conflicts?.length
          }
          onClick={submit}
        >
          {preview
            ? schedule
              ? "Schedule deployment"
              : "Deploy to devices"
            : "Preview assignment"}
        </Button>
      </div>
    </Modal>
  );
}
