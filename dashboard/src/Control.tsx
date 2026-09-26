import { useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  Copy,
  Download,
  FileText,
  History,
  KeyRound,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Rocket,
  RotateCcw,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
  Workflow,
  X,
} from "lucide-react";
import {
  api,
  can,
  download,
  post,
  when,
  type Audit,
  type Deployment,
  type Device,
  type Issue,
  type Policy,
  type Release,
  type Token,
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
  useResource,
} from "./ui";
import TargetDialog from "./TargetDialog";
import { AssignmentActions } from "./RecoveryActions";

export function Deployments({
  scheduled = false,
  user,
  notify,
  navigate,
}: {
  scheduled?: boolean;
  user: User;
  notify: (m: string) => void;
  navigate: (p: string) => void;
}) {
  const { data, error, loading, reload } = useResource<Deployment[]>(
    "/deployments",
    [],
  );
  const devices = useResource<Device[]>("/devices", []);
  const [search, setSearch] = useState(""),
    [detail, setDetail] = useState<Deployment | null>(null),
    [action, setAction] = useState<{
      deployment: Deployment;
      name: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const list = data.filter(
    (d) =>
      (!scheduled || d.scheduled_at) &&
      (d.name || d.version_id || d.id)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const activeDetail = detail
    ? data.find((d) => d.id === detail.id) || detail
    : null;
  async function perform() {
    if (!action) return;
    setBusy(true);
    setActionError("");
    try {
      await post(`/deployments/${action.deployment.id}/${action.name}`);
      setAction(null);
      notify(`Deployment ${action.name} requested.`);
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
        eyebrow="RELEASE & OBSERVE"
        title={scheduled ? "Schedules" : "Deployments"}
        description={
          scheduled
            ? "Release at the right time. Scheduled targets are frozen when you create the deployment."
            : "Follow each version from desired state to verified application."
        }
      >
        <Button icon={Plus} onClick={() => navigate("configurations")}>
          Deploy a version
        </Button>
      </PageHeader>
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder={scheduled ? "Search schedules…" : "Search deployments…"}
        />
        <Button variant="secondary" icon={RefreshCw} onClick={reload}>
          Refresh
        </Button>
      </div>
      {scheduled && (
        <div className="hint-box">
          <Clock3 size={19} />
          <span>
            Times are displayed in{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}. Offline devices
            remain pending; a scheduled activation does not mean they have
            applied it.
          </span>
        </div>
      )}
      {loading ? (
        <div className="loading">
          <Spinner />
          Loading deployments
        </div>
      ) : list.length ? (
        <div className="deployment-list">
          {list.map((d) => {
            const verified = (d.targets || []).filter(
                (t) => t.state === "verified_applied",
              ).length,
              total = d.targets?.length || 0;
            return (
              <button
                className="deployment-card"
                key={d.id}
                onClick={() => setDetail(d)}
              >
                <span className="square-icon">
                  {d.scheduled_at ? (
                    <CalendarDays size={22} />
                  ) : (
                    <Rocket size={22} />
                  )}
                </span>
                <div className="deployment-card-main">
                  <div>
                    <h3>
                      {d.name ||
                        (d.policy
                          ? "Agent policy"
                          : "Configuration deployment")}
                    </h3>
                    <Badge status={d.status} />
                  </div>
                  <p>
                    {d.version_id
                      ? `Version ${d.version_id.slice(0, 8)}`
                      : "Complete agent policy"}{" "}
                    <span>·</span>{" "}
                    {d.rollout?.kind === "canary"
                      ? "Canary + batches"
                      : "All at once"}{" "}
                    <span>·</span> Priority {d.priority}
                  </p>
                  <div className="rollout-progress">
                    <span
                      style={{
                        width: `${total ? (verified / total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <small>
                    {verified} of {total} verified <span>·</span>{" "}
                    {d.scheduled_at
                      ? `Scheduled ${when(d.scheduled_at)}`
                      : `Created ${when(d.created_at)}`}
                  </small>
                </div>
                <ArrowRight size={18} />
              </button>
            );
          })}
        </div>
      ) : (
        <Empty
          icon={scheduled ? CalendarDays : Rocket}
          title={
            scheduled
              ? "A thoughtful release has good timing"
              : "Ready when you are"
          }
          action={
            <Button icon={Workflow} onClick={() => navigate("configurations")}>
              Open configurations
            </Button>
          }
        >
          {scheduled
            ? "Publish a version, choose your targets, and set an activation time from the deploy dialog."
            : "Publish a configuration and preview its targets. Track every device through validation, activation, and verification here."}
        </Empty>
      )}
      <Modal
        open={!!activeDetail}
        onClose={() => setDetail(null)}
        title="Deployment progress"
        description="Only verified application counts toward rollout success."
        wide
      >
        {activeDetail && (
          <div className="modal-body">
            <div className="deployment-detail-top">
              <Badge status={activeDetail.status} />
              <span className="mono">{activeDetail.id}</span>
            </div>
            <dl className="detail-list">
              <div>
                <dt>Target mode</dt>
                <dd>{activeDetail.target_mode}</dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>{activeDetail.priority}</dd>
              </div>
              <div>
                <dt>Strategy</dt>
                <dd>{activeDetail.rollout?.kind}</dd>
              </div>
              <div>
                <dt>Scheduled activation</dt>
                <dd>{when(activeDetail.scheduled_at)}</dd>
              </div>
            </dl>
            <h3>Original target snapshot</h3>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>State</th>
                    <th>Generation</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {activeDetail.targets?.map((t) => (
                    <tr key={t.device_id}>
                      <td>
                        {devices.data.find((d) => d.id === t.device_id)?.name ||
                          t.device_id}
                      </td>
                      <td>
                        <Badge status={t.state} />
                      </td>
                      <td>{t.generation}</td>
                      <td>{t.error || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {can(user, "operate") && (
              <div className="action-row">
                {["active", "paused"].includes(activeDetail.status) && (
                  <>
                    <Button
                      icon={activeDetail.status === "paused" ? Play : Pause}
                      variant="secondary"
                      onClick={() => {
                        setActionError("");
                        setAction({
                          deployment: activeDetail,
                          name:
                            activeDetail.status === "paused"
                              ? "resume"
                              : "pause",
                        });
                      }}
                    >
                      {activeDetail.status === "paused" ? "Resume" : "Pause"}{" "}
                      rollout
                    </Button>
                  </>
                )}
                {["active", "paused", "scheduled"].includes(
                  activeDetail.status,
                ) && (
                  <Button
                    icon={X}
                    variant="danger-ghost"
                    onClick={() => {
                      setActionError("");
                      setAction({ deployment: activeDetail, name: "cancel" });
                    }}
                  >
                    Cancel rollout
                  </Button>
                )}
                {activeDetail.status !== "unassigned" && (
                  <Button
                    icon={RotateCcw}
                    variant="secondary"
                    onClick={() => {
                      setActionError("");
                      setAction({ deployment: activeDetail, name: "rollback" });
                    }}
                  >
                    Roll back
                  </Button>
                )}
              </div>
            )}
            {can(user, "operate") && (
              <AssignmentActions
                deployment={activeDetail}
                onDone={(message) => {
                  notify(message);
                  void reload();
                }}
              />
            )}
          </div>
        )}
      </Modal>
      <Modal
        open={!!action}
        onClose={() => setAction(null)}
        title={`${action?.name || "Change"} deployment`}
        description={
          action?.name === "rollback"
            ? "Rollback releases an older immutable artifact under a new generation. Agents will validate and apply it."
            : "Stopping admissions does not undo already released generations. Agents may apply them until they receive a superseding generation."
        }
      >
        <div className="modal-body">
          {actionError && <ErrorBox message={actionError} />}
          <p>
            Apply this action to deployment <code>{action?.deployment.id}</code>{" "}
            and its {action?.deployment.targets?.length || 0} original targets?
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setAction(null)}>
            Keep current state
          </Button>
          <Button busy={busy} onClick={perform}>
            Confirm {action?.name}
          </Button>
        </div>
      </Modal>
    </>
  );
}

export function Policies({
  user,
  notify,
}: {
  user: User;
  notify: (m: string) => void;
}) {
  const { data, error, reload } = useResource<
    { id: string; name: string; policy: Policy; created_at: string }[]
  >("/policies", []);
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [heartbeat, setHeartbeat] = useState(60),
    [paused, setPaused] = useState(false),
    [telemetry, setTelemetry] = useState(true),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState(""),
    [deploy, setDeploy] = useState<Policy | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      await post("/policies", {
        name,
        policy: {
          heartbeat_seconds: heartbeat,
          sync_paused: paused,
          telemetry_enabled: telemetry,
        },
      });
      setOpen(false);
      notify("Policy saved. Deploy it to apply changes.");
      void reload();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="FLEET MANAGEMENT"
        title="Agent policies"
        description="Set bounded agent behavior with the same targeting used for your pipelines."
      >
        {can(user, "operate") && (
          <Button icon={Plus} onClick={() => setOpen(true)}>
            Create policy
          </Button>
        )}
      </PageHeader>
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="hint-box">
        <Shield size={19} />
        <span>
          Policies cannot disable authentication, select executables, or
          override a local emergency pause. Remote pause is effective only after
          an agent acknowledges it.
        </span>
      </div>
      {data.length ? (
        <div className="config-grid">
          {data.map((p) => (
            <section className="config-card policy-card" key={p.id}>
              <div className="config-card-top">
                <span className="square-icon">
                  <Settings2 size={21} />
                </span>
                <Badge status={p.policy.sync_paused ? "paused" : "active"}>
                  {p.policy.sync_paused ? "Pause requested" : "Sync enabled"}
                </Badge>
              </div>
              <h3>{p.name}</h3>
              <dl className="detail-list">
                <div>
                  <dt>Heartbeat</dt>
                  <dd>{p.policy.heartbeat_seconds}s</dd>
                </div>
                <div>
                  <dt>Telemetry</dt>
                  <dd>{p.policy.telemetry_enabled ? "Enabled" : "Disabled"}</dd>
                </div>
              </dl>
              {can(user, "operate") && (
                <Button
                  variant="secondary"
                  icon={Rocket}
                  onClick={() => setDeploy(p.policy)}
                >
                  Select targets & deploy
                </Button>
              )}
            </section>
          ))}
        </div>
      ) : (
        <Empty
          icon={Settings2}
          title="A consistent rhythm for your fleet"
          action={
            can(user, "operate") ? (
              <Button icon={Plus} onClick={() => setOpen(true)}>
                Create your first policy
              </Button>
            ) : undefined
          }
        >
          Set heartbeat frequency, telemetry collection, and sync pause. The
          default heartbeat is 60 seconds, with jitter.
        </Empty>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create an agent policy"
        description="A policy is complete and versioned. The highest-priority applicable policy wins."
      >
        <form onSubmit={save}>
          <div className="modal-body">
            {formError && <ErrorBox message={formError} />}
            <Field label="Policy name">
              <input
                value={name}
                required
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Standard production agents"
              />
            </Field>
            <Field
              label="Heartbeat interval (seconds)"
              hint="Allowed range: 10–3,600 seconds. Jitter prevents synchronized requests."
            >
              <input
                type="number"
                min={10}
                max={3600}
                value={heartbeat}
                onChange={(e) => setHeartbeat(+e.target.value)}
              />
            </Field>
            <label className="toggle-row">
              <span>
                <strong>Pause configuration sync</strong>
                <small>Heartbeats and policy retrieval continue.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
              />
            </label>
            <label className="toggle-row">
              <span>
                <strong>Operational telemetry</strong>
                <small>Bounded health metrics; no pipeline payloads.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={telemetry}
                onChange={(e) => setTelemetry(e.target.checked)}
              />
            </label>
            {!paused && (
              <p className="muted">
                Resuming managed sync can replace local edits with the latest
                assigned configuration. Local emergency pause remains in effect.
              </p>
            )}
          </div>
          <div className="modal-footer">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              Save policy
            </Button>
          </div>
        </form>
      </Modal>
      {deploy && (
        <TargetDialog
          open
          onClose={() => setDeploy(null)}
          policy={deploy}
          onDone={notify}
        />
      )}
    </>
  );
}

export function Enrollment({
  user,
  notify,
  navigate,
}: {
  user: User;
  notify: (m: string) => void;
  navigate: (p: string) => void;
}) {
  const tokens = useResource<Token[]>("/tokens", []),
    releases = useResource<Release[]>("/releases", []);
  const [os, setOs] = useState("linux"),
    [arch, setArch] = useState("amd64"),
    [server, setServer] = useState(`https://${location.hostname}:8443`),
    [machine, setMachine] = useState("edge-01"),
    [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [hours, setHours] = useState(24),
    [prefix, setPrefix] = useState(""),
    [limit, setLimit] = useState(""),
    [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revoking, setRevoking] = useState<Token | null>(null);
  const release = releases.data.find((r) => r.os === os && r.arch === arch);
  const command = `vectory enroll --server ${/^https:\/\/[^\s"'`]+$/.test(server) ? server : "https://vectory.example.com:8443"} --id ${/^[a-zA-Z0-9_-]+$/.test(machine) ? machine : "edge-01"} --token-stdin`;
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await post<{ token: string; record: Token }>("/tokens", {
        name,
        expires_hours: hours,
        name_prefix: prefix || null,
        max_uses: limit ? Number(limit) : null,
      });
      setSecret(result.token);
      setOpen(false);
      notify("Enrollment token created. Copy it now; it is shown once.");
      void tokens.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify("Copied to clipboard.");
    } catch {
      notify("Clipboard unavailable. Select and copy the text manually.");
    }
  }
  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    setError("");
    try {
      await post(`/tokens/${revoking.id}/revoke`);
      setRevoking(null);
      notify("Token revoked. Existing device identities are unchanged.");
      void tokens.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="CONNECT YOUR INFRASTRUCTURE"
        title="Agents & enrollment"
        description="A lightweight agent. An outbound connection. Your next managed device."
      >
        <Button
          variant="secondary"
          icon={Server}
          onClick={() => navigate("devices")}
        >
          View enrolled devices
        </Button>
      </PageHeader>
      {(tokens.error || releases.error) && (
        <ErrorBox message={tokens.error || releases.error} />
      )}
      <div className="enrollment-grid">
        <Panel title="01 · Get the agent" aside={<Download size={17} />}>
          <div className="panel-body">
            <p className="muted">
              Choose your platform. Downloads are served from this instance’s
              local release catalog.
            </p>
            <div className="os-options">
              {["linux", "darwin", "windows"].map((value) => (
                <button
                  className={os === value ? "selected" : ""}
                  onClick={() => setOs(value)}
                  key={value}
                >
                  {value === "darwin"
                    ? "macOS"
                    : value === "linux"
                      ? "Linux"
                      : "Windows"}
                </button>
              ))}
            </div>
            <Field label="Architecture">
              <select value={arch} onChange={(e) => setArch(e.target.value)}>
                <option value="amd64">x86-64 / Intel</option>
                <option value="arm64">ARM64 / Apple Silicon</option>
              </select>
            </Field>
            {release ? (
              <>
                <a className="button full-width" href={release.url}>
                  <ArrowDownToLine size={16} />
                  Download {release.name}
                </a>
                <div className="download-meta">
                  <Badge status={release.signed ? "valid" : "warning"}>
                    {release.signed
                      ? "Signed release"
                      : "Unsigned development build"}
                  </Badge>
                  <small>
                    v{release.version} · {(release.size / 1048576).toFixed(1)}{" "}
                    MB
                  </small>
                </div>
                <details>
                  <summary>Verify SHA-256 checksum</summary>
                  <code className="block-code wrap">{release.sha256}</code>
                </details>
              </>
            ) : (
              <div className="download-unavailable">
                <Download size={23} />
                <strong>No verified download available</strong>
                <p>
                  Publish a tested {os}/{arch} agent artifact into this
                  instance’s release catalog. The dashboard never invents
                  download links.
                </p>
              </div>
            )}
          </div>
        </Panel>
        <Panel title="02 · Enroll your device" aside={<Terminal size={17} />}>
          <div className="panel-body">
            <p className="muted">
              Vector must already be installed. Generate a token, then run the
              enrollment command on your device.
            </p>
            <div className="form-row">
              <Field label="Server URL">
                <input
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  placeholder="https://vectory.example.com:8443"
                />
              </Field>
              <Field label="Machine name">
                <input
                  value={machine}
                  onChange={(e) => setMachine(e.target.value)}
                  placeholder="edge-01"
                />
              </Field>
            </div>
            <div className="command-block">
              <code>{command}</code>
              <button
                aria-label="Copy enrollment command"
                title="Copy command"
                onClick={() => void copy(command)}
              >
                <Copy size={17} />
              </button>
            </div>
            <p className="muted">
              For a private CA, add{" "}
              <code>--ca-file /path/to/trusted-ca.pem</code>. Obtain that file
              through a separately trusted channel. HTTPS verification is always
              required.
            </p>
            <div className="hint-box">
              <LockKeyhole size={18} />
              <span>
                Paste the token through standard input. Tokens passed as command
                arguments may appear in shell history or process listings.
              </span>
            </div>
            {can(user, "admin") && (
              <Button
                icon={KeyRound}
                onClick={() => {
                  setError("");
                  setOpen(true);
                }}
              >
                Create enrollment token
              </Button>
            )}
          </div>
        </Panel>
      </div>
      <Panel
        title="Enrollment tokens"
        aside={<span className="panel-label">REUSABLE UNTIL EXPIRY</span>}
      >
        {tokens.data.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Uses</th>
                  <th>Name scope</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens.data.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.name}</strong>
                    </td>
                    <td>
                      <Badge
                        status={
                          t.revoked
                            ? "revoked"
                            : new Date(t.expires_at).valueOf() < Date.now()
                              ? "offline"
                              : "active"
                        }
                      >
                        {t.revoked
                          ? "Revoked"
                          : new Date(t.expires_at).valueOf() < Date.now()
                            ? "Expired"
                            : "Active"}
                      </Badge>
                    </td>
                    <td>
                      {t.uses}
                      {t.max_uses ? ` / ${t.max_uses}` : ""}
                    </td>
                    <td className="mono">
                      {t.name_prefix || "Any unique name"}
                    </td>
                    <td>
                      <DateCell value={t.expires_at} />
                    </td>
                    <td>
                      {!t.revoked && can(user, "admin") && (
                        <Button
                          variant="danger-ghost compact"
                          onClick={() => setRevoking(t)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="quiet-state">
            <KeyRound size={25} />
            <h3>No enrollment tokens yet</h3>
            <p>
              Create a token when you are ready to connect devices. New
              enrollments begin unmanaged.
            </p>
          </div>
        )}
      </Panel>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create an enrollment token"
        description="Enrollment-only, reusable, and time limited. This token will be displayed once."
      >
        <form onSubmit={create}>
          <div className="modal-body">
            {error && <ErrorBox message={error} />}
            <Field label="Token name">
              <input
                value={name}
                required
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Edmonton edge rollout"
              />
            </Field>
            <div className="form-row">
              <Field label="Expires in (hours)">
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={hours}
                  onChange={(e) => setHours(+e.target.value)}
                />
              </Field>
              <Field label="Maximum uses (optional)">
                <input
                  type="number"
                  min={1}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  placeholder="Unlimited"
                />
              </Field>
            </div>
            <Field label="Allowed machine name prefix (optional)">
              <input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="e.g. edge-"
              />
            </Field>
            <div className="hint-box">
              <ShieldCheck size={19} />
              <span>
                Enrollment never grants group membership or production
                assignments. Anyone holding this token may enroll within its
                scope until it expires or is revoked.
              </span>
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
            <Button type="submit" busy={busy} icon={KeyRound}>
              Create token
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={!!secret}
        onClose={() => setSecret("")}
        title="Copy your enrollment token"
        description="This is the only time this token will be shown. Store it in a secure place."
      >
        <div className="modal-body">
          <div className="secret-display">
            <code>{secret}</code>
            <Button
              icon={Copy}
              variant="secondary"
              onClick={() => void copy(secret)}
            >
              Copy token
            </Button>
          </div>
          <p className="muted">
            This token is kept only in this dialog’s memory. Closing it clears
            the display. If lost, revoke it and create a new token.
          </p>
        </div>
        <div className="modal-footer">
          <Button onClick={() => setSecret("")}>I’ve saved the token</Button>
        </div>
      </Modal>
      <Modal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title="Revoke enrollment token"
        description="This prevents future enrollments. It does not revoke already enrolled devices."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <p>
            Revoke <strong>{revoking?.name}</strong>?
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setRevoking(null)}>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} onClick={revoke}>
            Revoke token
          </Button>
        </div>
      </Modal>
    </>
  );
}

export function Issues({ navigate }: { navigate: (p: string) => void }) {
  const { data, error, reload } = useResource<Issue[]>("/issues", []),
    devices = useResource<Device[]>("/devices", []);
  const [search, setSearch] = useState(""),
    [resolved, setResolved] = useState(false);
  const list = data.filter(
    (i) =>
      (resolved || !i.resolved) &&
      (i.message + " " + i.code + " " + i.stage)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="OBSERVE & RESOLVE"
        title="Issues"
        description="Actionable signals from enrollment, validation, deployment, and reconciliation."
      >
        <Button variant="secondary" icon={RefreshCw} onClick={reload}>
          Refresh
        </Button>
      </PageHeader>
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search issue codes or messages…"
        />
        <label className="inline-check">
          <input
            type="checkbox"
            checked={resolved}
            onChange={(e) => setResolved(e.target.checked)}
          />
          Include resolved
        </label>
      </div>
      {list.length ? (
        <div className="issues-list">
          {list.map((i) => (
            <article className="issue-card" key={i.id}>
              <span className="issue-symbol">
                <AlertTriangle size={21} />
              </span>
              <div>
                <div className="issue-heading">
                  <h3>{i.code.replaceAll("_", " ")}</h3>
                  <Badge status={i.resolved ? "completed" : "failed"}>
                    {i.resolved ? "Resolved" : i.stage}
                  </Badge>
                </div>
                <p>{i.message}</p>
                <div className="issue-meta">
                  <button
                    className="text-link"
                    onClick={() => navigate(`devices/${i.device_id}`)}
                  >
                    {devices.data.find((d) => d.id === i.device_id)?.name ||
                      i.device_id}
                  </button>
                  <span>{i.count} occurrences</span>
                  <span>First {when(i.first_seen)}</span>
                  <span>Last {when(i.last_seen)}</span>
                </div>
                <details>
                  <summary>Remediation guidance</summary>
                  <p>
                    Run <code>vectory doctor</code> on the affected device.
                    Check the reported stage, local capability policy, installed
                    Vector version, available disk, and trusted CA. Correct the
                    underlying problem and publish a new version when
                    configuration changes are needed. A healthy old process is
                    not proof a new configuration was applied.
                  </p>
                </details>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty icon={CheckCircle2} title="Nothing needs your attention">
          {data.length
            ? "No issues match the current filters."
            : "No issues have been reported. Telemetry availability and device connectivity are shown separately on the Devices page."}
        </Empty>
      )}
    </>
  );
}

export function AuditLog() {
  const { data, error, reload } = useResource<Audit[]>("/audit", []);
  const [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const list = data.filter((a) =>
    (a.action + " " + a.actor + " " + a.target)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE"
        title="Audit log"
        description="A durable record of who changed what, when, and with which result."
      >
        <Button
          variant="secondary"
          icon={Download}
          onClick={() =>
            download(
              "vectory-audit.json",
              JSON.stringify(list, null, 2),
              "application/json",
            )
          }
        >
          Export results
        </Button>
      </PageHeader>
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search actor, action, or target…"
        />
        <span className="muted">{list.length} events</span>
      </div>
      {list.length ? (
        <div className="table-panel">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Outcome</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {list.slice((page - 1) * 12, page * 12).map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.action.replaceAll("_", " ")}</strong>
                    </td>
                    <td>{a.actor}</td>
                    <td className="mono ellipsis" title={a.target}>
                      {a.target || "—"}
                    </td>
                    <td>
                      <Badge status={a.outcome} />
                    </td>
                    <td>
                      <DateCell value={a.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination count={list.length} page={page} onPage={setPage} />
        </div>
      ) : (
        <Empty icon={History} title="Your workspace history lives here">
          Enrollment, publishing, targeting, policies, and security changes
          leave an audit trail. Credentials and configuration secrets do not.
        </Empty>
      )}
    </>
  );
}

export function UsersSecurity({
  user,
  notify,
}: {
  user: User;
  notify: (m: string) => void;
}) {
  const { data, error, reload } = useResource<User[]>(
    can(user, "admin") ? "/users" : null,
    [],
  );
  const mfaStatus = useResource<{ enabled: boolean }>("/mfa", {
    enabled: false,
  });
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [role, setRole] = useState("viewer"),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState(""),
    [mfa, setMfa] = useState<any>(null),
    [code, setCode] = useState(""),
    [mfaPassword, setMfaPassword] = useState(""),
    [mfaAction, setMfaAction] = useState<"setup" | "disable" | null>(null),
    [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      await post("/users", { name, email, password, role });
      setPassword("");
      setOpen(false);
      notify("Workspace user created.");
      void reload();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function setupMfa() {
    setBusy(true);
    setFormError("");
    try {
      if (mfaAction === "disable") {
        await post("/mfa/disable", { password: mfaPassword, code });
        notify(
          "Multi-factor authentication disabled. Other browser sessions were revoked.",
        );
      } else setMfa(await post("/mfa/setup", { password: mfaPassword }));
      setMfaAction(null);
      setMfaPassword("");
      setCode("");
      void mfaStatus.reload();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirmMfa() {
    setBusy(true);
    setFormError("");
    try {
      const result = await post<{ recovery_codes: string[] }>("/mfa/confirm", {
        code,
      });
      setRecoveryCodes(result.recovery_codes);
      setMfa(null);
      setCode("");
      notify("Multi-factor authentication enabled.");
      void mfaStatus.reload();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE"
        title="Users & security"
        description="Give each person the access they need. Keep privileged actions explicit."
      >
        {can(user, "admin") && (
          <Button icon={Plus} onClick={() => setOpen(true)}>
            Add user
          </Button>
        )}
      </PageHeader>
      {(error || formError) && <ErrorBox message={error || formError} />}
      <div className="table-panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="user-cell">
                      <span className="user-avatar">
                        {u.name?.slice(0, 2).toUpperCase()}
                      </span>
                      <strong>{u.name}</strong>
                      {u.id === user.id && <span className="muted">(you)</span>}
                    </div>
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <Badge status="neutral">{u.role}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="security-grid">
        <Panel title="Permissions, by role">
          <div className="panel-body role-list">
            <p>
              <strong>Viewer</strong>
              <span>Read fleet state, versions, and deployments.</span>
            </p>
            <p>
              <strong>Editor</strong>
              <span>Create and save configuration drafts.</span>
            </p>
            <p>
              <strong>Operator</strong>
              <span>Publish, deploy, schedule, and manage groups.</span>
            </p>
            <p>
              <strong>Administrator</strong>
              <span>Manage users, enrollment, and device identities.</span>
            </p>
          </div>
        </Panel>
        <Panel title="Multi-factor authentication">
          <div className="panel-body">
            <ShieldCheck size={28} />
            <h3>Protect your account</h3>
            <p className="muted">
              Add a time-based authenticator code to your local login. Keep your
              recovery material in an operator-controlled secure location.
            </p>
            <Button
              variant="secondary"
              icon={Shield}
              busy={busy}
              onClick={() => {
                setFormError("");
                setMfaAction(mfaStatus.data.enabled ? "disable" : "setup");
              }}
            >
              {mfaStatus.data.enabled
                ? "Disable authenticator"
                : "Set up authenticator"}
            </Button>
          </div>
        </Panel>
      </div>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setPassword("");
        }}
        title="Add a workspace user"
        description="There is no public signup. Administrators create local accounts."
      >
        <form onSubmit={create}>
          <div className="modal-body">
            {formError && <ErrorBox message={formError} />}
            <Field label="Full name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Email">
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="Role">
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {["viewer", "editor", "operator", "admin"].map((r) => (
                  <option value={r} key={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="modal-footer">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button busy={busy} type="submit">
              Create user
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={!!mfa}
        onClose={() => setMfa(null)}
        title="Connect your authenticator"
        description="Add this secret to your authenticator, then confirm with the current six-digit code."
      >
        <div className="modal-body">
          {formError && <ErrorBox message={formError} />}
          <code className="block-code wrap">
            {mfa?.secret || mfa?.otpauth_url}
          </code>
          <Field label="Authenticator code">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
            />
          </Field>
        </div>
        <div className="modal-footer">
          <Button busy={busy} disabled={code.length !== 6} onClick={confirmMfa}>
            Enable multi-factor authentication
          </Button>
        </div>
      </Modal>
      <Modal
        open={!!mfaAction}
        onClose={() => {
          setMfaAction(null);
          setMfaPassword("");
          setCode("");
        }}
        title={
          mfaAction === "disable"
            ? "Disable multi-factor authentication"
            : "Verify your password"
        }
        description="Re-enter your current password to change account authentication."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void setupMfa();
          }}
        >
          <div className="modal-body">
            {formError && <ErrorBox message={formError} />}
            <Field label="Current password">
              <input
                type="password"
                autoComplete="current-password"
                required
                value={mfaPassword}
                onChange={(e) => setMfaPassword(e.target.value)}
              />
            </Field>
            {mfaAction === "disable" && (
              <Field label="Current authenticator code">
                <input
                  inputMode="numeric"
                  required
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
            )}
          </div>
          <div className="modal-footer">
            <Button type="submit" busy={busy}>
              Continue
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={recoveryCodes.length > 0}
        onClose={() => setRecoveryCodes([])}
        title="Save your recovery codes"
        description="These single-use codes are shown once. Keep them outside this server in a secure place."
      >
        <div className="modal-body">
          <pre className="block-code">{recoveryCodes.join("\n")}</pre>
          <Button
            variant="secondary"
            icon={Download}
            onClick={() =>
              download("vectory-recovery-codes.txt", recoveryCodes.join("\n"))
            }
          >
            Download recovery codes
          </Button>
        </div>
        <div className="modal-footer">
          <Button onClick={() => setRecoveryCodes([])}>
            I’ve saved my recovery codes
          </Button>
        </div>
      </Modal>
    </>
  );
}

export function Settings() {
  const { data, error } = useResource<any>("/settings", null);
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE"
        title="Instance settings"
        description="The operational boundaries of your self-hosted control plane."
      />
      {error && <ErrorBox message={error} />}
      <div className="settings-grid">
        <Panel title="Instance">
          <div className="panel-body">
            <dl className="detail-list">
              <div>
                <dt>Name</dt>
                <dd>{data?.instance_name || "Vectory"}</dd>
              </div>
              <div>
                <dt>Server version</dt>
                <dd>{data?.version || "Unavailable"}</dd>
              </div>
              <div>
                <dt>Vector catalog</dt>
                <dd>{data?.vector_version || "0.58.0"}</dd>
              </div>
              <div>
                <dt>Default heartbeat</dt>
                <dd>
                  {data?.heartbeat_seconds
                    ? `${data.heartbeat_seconds} seconds`
                    : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt>Telemetry retention</dt>
                <dd>
                  {data?.telemetry_retention_days
                    ? `${data.telemetry_retention_days} days`
                    : "Unavailable"}
                </dd>
              </div>
            </dl>
          </div>
        </Panel>
        <Panel title="Your data stays yours">
          <div className="panel-body">
            <ShieldCheck size={30} />
            <h3>Independent by design</h3>
            <p className="muted">
              Vectory is an open-source, self-hosted configuration manager. No
              cloud account, license server, or phone-home analytics is
              required.
            </p>
            <p className="muted">
              Runtime settings, TLS material, and retention are configured by
              the host operator. Agent policies provide bounded fleet controls.
            </p>
            <p className="small">
              Vectory is independent of, and not affiliated with, Datadog.
              Vector is a Datadog project.
            </p>
          </div>
        </Panel>
      </div>
      <Panel title="Safe operations">
        <div className="panel-body operational-notes">
          <div>
            <DatabaseIcon />
            <h3>Back up consistently</h3>
            <p>
              Use the included online SQLite backup procedure and preserve
              required trust keys separately. Copying a live database file alone
              does not capture its WAL.
            </p>
          </div>
          <div>
            <Clock3 size={23} />
            <h3>Respect generations</h3>
            <p>
              Restoring an older backup cannot silently reset device
              anti-rollback protection. Follow the documented recovery
              procedure.
            </p>
          </div>
          <div>
            <LockKeyhole size={23} />
            <h3>One active instance</h3>
            <p>
              Keep SQLite on local persistent storage. This release is designed
              for one active control-plane process.
            </p>
          </div>
        </div>
      </Panel>
    </>
  );
}
function DatabaseIcon() {
  return <Server size={23} />;
}
