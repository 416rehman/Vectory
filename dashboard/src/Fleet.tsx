import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Database,
  GitBranch,
  Layers,
  Monitor,
  Pause,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react";
import {
  ago,
  can,
  post,
  put,
  when,
  type Audit,
  type Device,
  type Group,
  type Policy,
  type User,
} from "./api";
import {
  Badge,
  Button,
  DateCell,
  Empty,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  SearchBox,
  Spinner,
  Stat,
  Step,
  useResource,
} from "./ui";
import TargetDialog from "./TargetDialog";
import { DeviceRecoveryActions } from "./RecoveryActions";
import TelemetryPanel from "./TelemetryPanel";

export function Overview({
  navigate,
  user,
}: {
  navigate: (p: string) => void;
  user: User;
}) {
  const { data, loading, error, reload } = useResource<any>("/overview", null);
  return (
    <>
      <PageHeader
        eyebrow="YOUR CONTROL PLANE"
        title="Overview"
        description="A clear view of your pipelines and the devices that run them."
      >
        <Button variant="secondary" icon={RefreshCw} onClick={reload}>
          Refresh
        </Button>
        {can(user, "admin") && (
          <Button icon={Plus} onClick={() => navigate("enrollment")}>
            Connect a device
          </Button>
        )}
      </PageHeader>
      {error && <ErrorBox message={error} retry={reload} />}
      <section className="overview-banner">
        <div>
          <span className="banner-kicker">
            <span className="live-dot" />
            SELF-HOSTED. FULLY YOURS.
          </span>
          <h2>
            Your pipelines,
            <br />
            <em>in sync.</em>
          </h2>
          <p>
            One place to build, deploy, and manage Vector.
            <br />
            Your infrastructure. Your data. Your control.
          </p>
          <button
            className="banner-link"
            onClick={() => navigate("configurations")}
          >
            Explore your configurations <ArrowRight size={16} />
          </button>
        </div>
        <div
          className="banner-diagram"
          aria-label="Sources connect to transforms, then sinks"
        >
          <div className="diagram-column">
            <div className="diagram-node">
              <Database size={17} />
              <span>Collect</span>
              <small>SOURCES</small>
            </div>
          </div>
          <span className="diagram-line">
            <i />
          </span>
          <div className="diagram-column">
            <div className="diagram-node featured">
              <GitBranch size={20} />
              <span>Transform</span>
              <small>YOUR PIPELINE</small>
            </div>
          </div>
          <span className="diagram-line">
            <i />
          </span>
          <div className="diagram-column">
            <div className="diagram-node">
              <ArrowDownToLine size={18} />
              <span>Deliver</span>
              <small>SINKS</small>
            </div>
          </div>
        </div>
        <span className="banner-version">POWERED BY VECTOR</span>
      </section>
      <div className="stats-grid">
        <Stat
          icon={Server}
          label="Connected devices"
          value={data?.devices_total ?? "—"}
          caption={
            data
              ? `${data.devices_online} currently online`
              : "Waiting for the control plane"
          }
        />
        <Stat
          icon={Workflow}
          label="Configurations"
          value={data?.configurations_total ?? "—"}
          caption="Independent, versioned pipelines"
        />
        <Stat
          icon={Radio}
          label="Active deployments"
          value={data?.deployments_active ?? "—"}
          caption="Converging to desired state"
        />
        <Stat
          icon={AlertTriangle}
          label="Open issues"
          value={data?.issues_open ?? "—"}
          caption={
            data?.issues_open
              ? "Ready for your attention"
              : "Reported by enrolled devices"
          }
        />
      </div>
      {loading ? (
        <div className="loading">
          <Spinner />
          Loading workspace activity
        </div>
      ) : (
        <div className="overview-grid">
          <Panel
            title={
              data?.devices_total
                ? "Fleet at a glance"
                : "Make yourself at home"
            }
            aside={
              <span className="panel-label">
                {data?.devices_total ? "LIVE FLEET" : "GETTING STARTED"}
              </span>
            }
          >
            {data?.devices_total ? (
              <>
                <div className="compact-devices">
                  {(data.devices || []).slice(0, 5).map((d: Device) => (
                    <button
                      key={d.id}
                      onClick={() => navigate(`devices/${d.id}`)}
                    >
                      <span className="device-avatar">
                        <Server size={18} />
                      </span>
                      <span>
                        <strong>{d.name}</strong>
                        <small>
                          {d.os} ·{" "}
                          {d.vector_version || "Vector version unavailable"}
                        </small>
                      </span>
                      <Badge status={d.status} />
                      <ArrowRight size={15} />
                    </button>
                  ))}
                </div>
                <button
                  className="panel-link"
                  onClick={() => navigate("devices")}
                >
                  View all devices <ArrowRight size={15} />
                </button>
              </>
            ) : (
              <div className="getting-started">
                <p>
                  Three steps from a blank slate to your first managed pipeline.
                </p>
                <Step
                  number={1}
                  title="Connect your first device"
                  description="Download an agent and create an enrollment token."
                  action={() => navigate("enrollment")}
                />
                <Step
                  number={2}
                  title="Build a configuration"
                  description="Start with a template or bring your existing pipeline."
                  done={data?.configurations_total > 0}
                  action={() => navigate("configurations")}
                />
                <Step
                  number={3}
                  title="Publish and deploy"
                  description="Review targets, release a version, and watch it converge."
                  action={() => navigate("deployments")}
                />
              </div>
            )}
          </Panel>
          <Panel
            title="Recent activity"
            aside={
              <button className="text-link" onClick={() => navigate("audit")}>
                View audit log <ArrowRight size={13} />
              </button>
            }
          >
            {data?.recent_activity?.length ? (
              <div className="activity-list">
                {data.recent_activity.slice(0, 6).map((a: Audit) => (
                  <div className="activity-item" key={a.id}>
                    <span className="activity-icon">
                      <CheckCircle2 size={15} />
                    </span>
                    <div>
                      <strong>{a.action.replaceAll("_", " ")}</strong>
                      <p>
                        {a.actor} <span>· {ago(a.created_at)}</span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="quiet-state">
                <Activity size={25} />
                <h3>A fresh start</h3>
                <p>
                  Your workspace activity will appear here as you connect
                  devices and build pipelines.
                </p>
              </div>
            )}
          </Panel>
        </div>
      )}
      <div className="overview-footer">
        <ShieldCheck size={16} />
        <span>
          Outbound-only agents. No inbound ports. No phone-home analytics.
        </span>
        <span className="footer-dot">·</span>
        <span>Open source, by design.</span>
      </div>
    </>
  );
}
function RocketIcon(props: any) {
  return <Radio {...props} />;
}

export function Devices({
  user,
  notify,
  navigate,
  deviceId,
}: {
  user: User;
  notify: (m: string) => void;
  navigate: (p: string) => void;
  deviceId?: string;
}) {
  const { data, loading, error, reload } = useResource<Device[]>(
    "/devices",
    [],
  );
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<Device | null>(null),
    [policy, setPolicy] = useState<Policy | null>(null),
    [revoke, setRevoke] = useState<Device | null>(null),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const selectedDetail = detail
    ? data.find((d) => d.id === detail.id) || detail
    : deviceId
      ? data.find((d) => d.id === deviceId) || null
      : null;
  const filtered = data.filter(
    (d) =>
      (d.name + " " + d.os + " " + Object.values(d.labels || {}).join(" "))
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" ||
        (filter === "online" &&
          !!d.last_seen &&
          !["offline", "revoked"].includes(d.status)) ||
        d.status === filter ||
        d.apply_state === filter),
  );
  function toggle(id: string) {
    setSelected((v) =>
      v.includes(id) ? v.filter((x) => x !== id) : [...v, id],
    );
  }
  async function revokeDevice() {
    if (!revoke) return;
    setBusy(true);
    setActionError("");
    try {
      await post(`/devices/${revoke.id}/revoke`);
      setRevoke(null);
      notify("Device identity revoked. Its local workload remains in place.");
      void reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="FLEET MANAGEMENT"
        title="Devices"
        description="Every Vector instance, with its desired and reported state in one place."
      >
        {can(user, "admin") && (
          <Button icon={Plus} onClick={() => navigate("enrollment")}>
            Connect a device
          </Button>
        )}
      </PageHeader>
      <div className="fleet-summary">
        <span>
          <i className="status-dot green" />
          {
            data.filter(
              (d) =>
                !!d.last_seen && !["offline", "revoked"].includes(d.status),
            ).length
          }{" "}
          online
        </span>
        <span>
          <i className="status-dot gray" />
          {data.filter((d) => d.status === "offline").length} offline
        </span>
        <span>
          <i className="status-dot amber" />
          {data.filter((d) => d.sync_paused).length} sync paused
        </span>
        <span>{data.length} total devices</span>
      </div>
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search by name, platform, or label…"
        />
        <div className="toolbar-right">
          <select
            aria-label="Filter device status"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">All statuses</option>
            {[
              "online",
              "offline",
              "unmanaged",
              "paused",
              "failed",
              "verified_applied",
            ].map((s) => (
              <option key={s} value={s}>
                {s.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          <Button variant="secondary" icon={RefreshCw} onClick={reload}>
            Refresh
          </Button>
        </div>
      </div>
      {selected.length > 0 && (
        <div className="bulk-bar">
          <strong>{selected.length} selected</strong>
          <span>
            {selected
              .map((id) => data.find((d) => d.id === id)?.name)
              .join(", ")}
          </span>
          {can(user, "operate") && (
            <>
              <Button
                variant="secondary compact"
                icon={Pause}
                onClick={() =>
                  setPolicy({
                    heartbeat_seconds: 60,
                    sync_paused: true,
                    telemetry_enabled: true,
                  })
                }
              >
                Request sync pause
              </Button>
              <Button
                variant="secondary compact"
                onClick={() =>
                  setPolicy({
                    heartbeat_seconds: 60,
                    sync_paused: false,
                    telemetry_enabled: true,
                  })
                }
              >
                Resume sync
              </Button>
            </>
          )}
          <button onClick={() => setSelected([])}>Clear</button>
        </div>
      )}
      {loading ? (
        <div className="loading">
          <Spinner />
          Loading devices
        </div>
      ) : filtered.length ? (
        <div className="table-panel">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="checkbox-cell">
                    <input
                      aria-label="Select visible devices"
                      type="checkbox"
                      checked={filtered
                        .slice((page - 1) * 12, page * 12)
                        .every((d) => selected.includes(d.id))}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [
                                ...new Set([
                                  ...selected,
                                  ...filtered
                                    .slice((page - 1) * 12, page * 12)
                                    .map((d) => d.id),
                                ]),
                              ]
                            : selected.filter(
                                (id) =>
                                  !filtered
                                    .slice((page - 1) * 12, page * 12)
                                    .some((d) => d.id === id),
                              ),
                        )
                      }
                    />
                  </th>
                  <th>Device</th>
                  <th>Status</th>
                  <th>Configuration state</th>
                  <th>Generation</th>
                  <th>Last seen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.slice((page - 1) * 12, page * 12).map((d) => (
                  <tr key={d.id}>
                    <td>
                      <input
                        aria-label={`Select ${d.name}`}
                        type="checkbox"
                        checked={selected.includes(d.id)}
                        onChange={() => toggle(d.id)}
                      />
                    </td>
                    <td>
                      <button
                        className="device-name"
                        onClick={() => setDetail(d)}
                      >
                        <span className="device-avatar">
                          <Monitor size={18} />
                        </span>
                        <span>
                          <strong>{d.name}</strong>
                          <small>
                            {d.os || "Unknown OS"} /{" "}
                            {d.arch || "Unknown architecture"}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <Badge status={d.status} />
                    </td>
                    <td>
                      <Badge status={d.apply_state} />
                    </td>
                    <td>
                      <span className="mono">
                        {d.reported_generation}{" "}
                        <span className="muted">/ {d.desired_generation}</span>
                      </span>
                    </td>
                    <td title={d.last_seen}>{ago(d.last_seen)}</td>
                    <td>
                      <button
                        className="text-link"
                        onClick={() => setDetail(d)}
                      >
                        Details <ArrowRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination count={filtered.length} page={page} onPage={setPage} />
        </div>
      ) : (
        <Empty
          icon={Server}
          title={
            search || filter !== "all"
              ? "No matching devices"
              : "Your fleet starts with one device"
          }
          action={
            can(user, "admin") ? (
              <Button icon={Plus} onClick={() => navigate("enrollment")}>
                Connect your first device
              </Button>
            ) : undefined
          }
        >
          {search || filter !== "all"
            ? "Change your search or status filter."
            : "Install the lightweight agent alongside Vector. It connects outbound, keeping your devices in control of their network."}
        </Empty>
      )}
      <Modal
        open={!!selectedDetail}
        onClose={() => {
          setDetail(null);
          if (deviceId) navigate("devices");
        }}
        title={selectedDetail?.name || "Device detail"}
        description="Reported state comes from the most recent authenticated heartbeat."
        wide
      >
        {selectedDetail && (
          <div className="modal-body">
            <div className="device-detail-heading">
              <span className="device-avatar large">
                <Server size={27} />
              </span>
              <div>
                <Badge status={selectedDetail.status} />
                <p className="muted">
                  {selectedDetail.os} / {selectedDetail.arch} · Last seen{" "}
                  {ago(selectedDetail.last_seen)}
                </p>
              </div>
            </div>
            <div className="detail-two-col">
              <Panel title="Configuration state">
                <dl className="detail-list">
                  <div>
                    <dt>Apply state</dt>
                    <dd>
                      <Badge status={selectedDetail.apply_state} />
                    </dd>
                  </div>
                  <div>
                    <dt>Desired generation</dt>
                    <dd>{selectedDetail.desired_generation}</dd>
                  </div>
                  <div>
                    <dt>Reported generation</dt>
                    <dd>{selectedDetail.reported_generation}</dd>
                  </div>
                  <div>
                    <dt>Desired version</dt>
                    <dd className="mono">
                      {selectedDetail.desired_version_id || "Unmanaged"}
                    </dd>
                  </div>
                  <div>
                    <dt>Actual file digest</dt>
                    <dd className="mono wrap">
                      {selectedDetail.actual_sha256 || "Not reported"}
                    </dd>
                  </div>
                  {selectedDetail.uses_local_secrets && (
                    <>
                      <div>
                        <dt>Applied template digest</dt>
                        <dd className="mono wrap">
                          {selectedDetail.applied_template_sha256 ||
                            "Not reported"}
                        </dd>
                      </div>
                      <div>
                        <dt>Local secret revision</dt>
                        <dd>
                          {selectedDetail.secret_revision ?? "Not reported"}
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
              </Panel>
              <Panel title="Agent & telemetry">
                <dl className="detail-list">
                  <div>
                    <dt>Vector</dt>
                    <dd>{selectedDetail.vector_version || "Unavailable"}</dd>
                  </div>
                  <div>
                    <dt>Agent</dt>
                    <dd>{selectedDetail.agent_version || "Unavailable"}</dd>
                  </div>
                  <div>
                    <dt>Sync pause</dt>
                    <dd>
                      {selectedDetail.sync_paused
                        ? selectedDetail.pause_acknowledged
                          ? "Acknowledged"
                          : "Requested — awaiting agent"
                        : "Not remotely paused"}
                    </dd>
                  </div>
                  <div>
                    <dt>Events / second</dt>
                    <dd>
                      {selectedDetail.telemetry?.events_per_second ??
                        "Unavailable"}
                    </dd>
                  </div>
                  <div>
                    <dt>Local emergency pause</dt>
                    <dd>
                      {selectedDetail.local_paused
                        ? "Active — resume on this device"
                        : "Not reported active"}
                    </dd>
                  </div>
                  <div>
                    <dt>Errors</dt>
                    <dd>{selectedDetail.telemetry?.errors ?? "Unavailable"}</dd>
                  </div>
                  <div>
                    <dt>Telemetry sampled</dt>
                    <dd>
                      {selectedDetail.telemetry?.sampled_at ? (
                        <>
                          {when(selectedDetail.telemetry.sampled_at)}
                          {Date.now() -
                            new Date(
                              selectedDetail.telemetry.sampled_at,
                            ).getTime() >
                            180000 && <Badge status="warning">Stale</Badge>}
                        </>
                      ) : (
                        "Unavailable"
                      )}
                    </dd>
                  </div>
                </dl>
              </Panel>
            </div>
            <div className="assignment-explainer">
              <ShieldCheck size={20} />
              <div>
                <h3>Why this configuration applies</h3>
                <p>
                  {selectedDetail.assignment
                    ? `${selectedDetail.assignment.reason} · Priority ${selectedDetail.assignment.priority} · Assignment ${selectedDetail.assignment.id}`
                    : "No effective assignment. The agent retains the existing Vector configuration until an operator explicitly deploys a version."}
                </p>
              </div>
            </div>
            <TelemetryPanel device={selectedDetail} />
            {["failed", "verification_unknown", "offline"].includes(
              selectedDetail.apply_state,
            ) || selectedDetail.status === "offline" ? (
              <div className="hint-box">
                <AlertTriangle size={19} />
                <span>
                  Check the device’s Issues, then run{" "}
                  <code>vectory doctor</code> locally. An offline device cannot
                  acknowledge policy changes until it reconnects.
                </span>
              </div>
            ) : null}
            {can(user, "admin") && (
              <Button
                variant="danger-ghost"
                onClick={() => setRevoke(selectedDetail)}
              >
                Revoke device identity
              </Button>
            )}
            <DeviceRecoveryActions
              device={selectedDetail}
              user={user}
              onDone={(message) => {
                notify(message);
                void reload();
              }}
            />
          </div>
        )}
      </Modal>
      <Modal
        open={!!revoke}
        onClose={() => setRevoke(null)}
        title="Revoke this device?"
        description="Future authenticated access will be denied. Delivered configuration and the local Vector workload remain on the host."
      >
        <div className="modal-body">
          {actionError && <ErrorBox message={actionError} />}
          <p>
            Revoke <strong>{revoke?.name}</strong>? A host operator must use the
            authorized recovery flow to enroll it again.
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setRevoke(null)}>
            Keep device
          </Button>
          <Button variant="danger" busy={busy} onClick={revokeDevice}>
            Revoke identity
          </Button>
        </div>
      </Modal>
      {policy && (
        <TargetDialog
          open
          onClose={() => setPolicy(null)}
          policy={policy}
          initialDeviceIds={selected}
          onDone={notify}
        />
      )}
    </>
  );
}

export function Groups({
  user,
  notify,
}: {
  user: User;
  notify: (m: string) => void;
}) {
  const groups = useResource<Group[]>("/groups", []),
    devices = useResource<Device[]>("/devices", []);
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Group | null>(null),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [ids, setIds] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function edit(group?: Group) {
    setEditing(group || null);
    setName(group?.name || "");
    setDescription(group?.description || "");
    setIds(group?.device_ids || []);
    setError("");
    setOpen(true);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { name, description, device_ids: ids };
      if (editing) await put(`/groups/${editing.id}`, body);
      else await post("/groups", body);
      setOpen(false);
      notify("Group saved. Effective assignments were checked for conflicts.");
      void groups.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="FLEET MANAGEMENT"
        title="Device groups"
        description="Organize your infrastructure. Target a group with one shared selector."
      >
        {can(user, "operate") && (
          <Button icon={Plus} onClick={() => edit()}>
            Create group
          </Button>
        )}
      </PageHeader>
      {groups.error && (
        <ErrorBox message={groups.error} retry={groups.reload} />
      )}
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search groups…"
        />
        <span className="muted">{groups.data.length} groups</span>
      </div>
      {groups.data.length ? (
        <div className="config-grid">
          {groups.data
            .filter((g) => g.name.toLowerCase().includes(search.toLowerCase()))
            .map((g) => (
              <button
                className="config-card group-card"
                key={g.id}
                onClick={() => edit(g)}
              >
                <div className="config-card-top">
                  <span className="square-icon">
                    <Layers size={23} />
                  </span>
                  <Badge status="neutral">Static group</Badge>
                </div>
                <h3>{g.name}</h3>
                <p>{g.description || "No description"}</p>
                <div className="group-members">
                  <Server size={16} />
                  {g.device_ids.length} devices
                </div>
                <div className="config-card-footer">
                  <span>View membership</span>
                  <ArrowRight size={16} />
                </div>
              </button>
            ))}
        </div>
      ) : (
        <Empty
          icon={Layers}
          title="Give your fleet some structure"
          action={
            can(user, "operate") ? (
              <Button icon={Plus} onClick={() => edit()}>
                Create a group
              </Button>
            ) : undefined
          }
        >
          Group devices by environment, region, or purpose. Membership is
          operator controlled and checked against existing assignments.
        </Empty>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit device group" : "Create a device group"}
        description="Changing membership can change deployed configuration. Conflicting assignments are rejected transactionally."
      >
        <form onSubmit={save}>
          <div className="modal-body">
            {(error || devices.error) && (
              <ErrorBox message={error || devices.error} />
            )}
            <Field label="Group name">
              <input
                value={name}
                maxLength={120}
                required
                readOnly={!can(user, "operate")}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Production · us-east"
              />
            </Field>
            <Field label="Description">
              <textarea
                rows={2}
                value={description}
                readOnly={!can(user, "operate")}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <h4>Membership · {ids.length} devices</h4>
            <div className="target-list">
              {devices.data.map((d) => (
                <label className="target-row" key={d.id}>
                  <input
                    type="checkbox"
                    disabled={!can(user, "operate")}
                    checked={ids.includes(d.id)}
                    onChange={() =>
                      setIds((v) =>
                        v.includes(d.id)
                          ? v.filter((i) => i !== d.id)
                          : [...v, d.id],
                      )
                    }
                  />
                  <Server size={16} />
                  <span>
                    {d.name}
                    <small>{d.status}</small>
                  </span>
                </label>
              ))}
              {!devices.data.length && (
                <p className="muted small-pad">
                  No devices are enrolled yet. You can create an empty group.
                </p>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            {can(user, "operate") && (
              <Button type="submit" busy={busy}>
                Save group
              </Button>
            )}
          </div>
        </form>
      </Modal>
    </>
  );
}
