import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ChevronDown,
  Copy,
  CopyPlus,
  Download,
  Pencil,
  Plus,
} from "lucide-react";
import { DataTable } from "./DataTable";
import {
  api,
  can,
  when,
  type Device,
  type Release,
  type SavedPolicy,
  type SavedPolicyListItem,
  type Token,
  type User,
} from "./api";
import {
  Button,
  DateCell,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  RefreshButton,
  SearchBox,
  Spinner,
  useResource,
} from "./ui";
import TargetDialog from "./TargetDialog";
import AgentSettingsCreation, {
  type AgentSettingsCreationHandle,
} from "./AgentSettingsCreation";
import AgentSettingsEditor from "./AgentSettingsEditor";
import DocLink from "./DocLink";
import {
  ConfigurationModePicker,
  RestrictedPolicyFile,
  ServerCertificateTrust,
  isAbsoluteLocalFilePath,
  type ConfigurationMode,
} from "./EnrollmentConnection";
import EnrollmentTokenFlow, {
  type EnrollmentTokenFlowHandle,
} from "./EnrollmentTokenFlow";
import "./control.css";

const words = (value: string) =>
  value.replaceAll("_", " ").replaceAll(".", " ");
const stateText: Record<string, string> = {
  active: "In progress",
  completed: "Complete",
  scheduled: "Scheduled",
  paused: "Paused",
  failed: "Needs attention",
  cancelled: "Cancelled",
  unassigned: "Removed",
  missed: "Schedule missed",
  verified_applied: "Applied and verified",
  desired: "Waiting for agent",
  pending: "Waiting",
  downloaded: "Downloaded",
  validated: "Validated",
  written: "Applying",
  reload_requested: "Restarting Vector",
  verification_unknown: "Verification needed",
  rolled_back: "Rolled back",
  incompatible: "Incompatible",
  removed: "No longer targeted",
  revoked: "Revoked",
};
function Status({ state }: { state: string }) {
  return (
    <span className="control-status" data-state={state}>
      {stateText[state] || words(state)}
    </span>
  );
}
function Quiet({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="control-empty">
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Policies({
  user,
  notify,
}: {
  user: User;
  notify: (message: string) => void;
}) {
  const { data, error, loading, reload } = useResource<SavedPolicyListItem[]>(
    "/policies",
    [],
  );
  const creation = useRef<AgentSettingsCreationHandle>(null);
  const editOpener = useRef<HTMLElement | null>(null);
  const [deploy, setDeploy] = useState<{
    setting: SavedPolicy;
    deviceIds: string[];
  } | null>(null);
  const [editing, setEditing] = useState<SavedPolicyListItem | null>(null);
  const operate = can(user, "operate");
  return (
    <div className="control-page agent-settings-page">
      <PageHeader
        title="Agent settings"
        help={{
          topic: "glossary",
          section: "devices-permissions-and-credentials",
        }}
        description="Reusable check-in, sync and metrics settings. Devices change only when you apply them."
      >
        {operate && (
          <Button
            icon={Plus}
            onClick={(event) =>
              creation.current?.openCreate(event.currentTarget)
            }
          >
            New settings
          </Button>
        )}
      </PageHeader>
      <AgentSettingsCreation
        key={`${user.id}:${user.role}`}
        ref={creation}
        user={user}
        onCreated={() => {
          notify("Saved. No devices change until you apply these settings.");
          void reload();
        }}
        onApply={(setting) => {
          setDeploy({ setting, deviceIds: [] });
          return true;
        }}
      />
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="control-table">
        <DataTable<SavedPolicyListItem>
          data={error ? [] : data}
          rowKey={(setting) => setting.id}
          label="Agent settings"
          loading={loading}
          columns={[
            {
              id: "name",
              header: "Settings",
              value: (setting) => setting.name,
              filter: { placeholder: "Filter settings names" },
              cell: (setting) => <strong>{setting.name}</strong>,
            },
            {
              id: "interval",
              header: "Check-in interval",
              value: (setting) => setting.policy.heartbeat_seconds,
              filter: { placeholder: "Filter seconds" },
              cell: (setting) => `${setting.policy.heartbeat_seconds} seconds`,
            },
            {
              id: "sync",
              header: "Configuration sync",
              value: (setting) =>
                setting.policy.sync_paused ? "Paused" : "Enabled",
              filter: {
                options: [
                  { value: "Paused", label: "Paused" },
                  { value: "Enabled", label: "Enabled" },
                ],
              },
              cell: (setting) =>
                setting.policy.sync_paused ? "Paused" : "Enabled",
            },
            {
              id: "metrics",
              header: "Metrics",
              value: (setting) =>
                setting.policy.telemetry_enabled ? "Collected" : "Off",
              filter: {
                options: [
                  { value: "Collected", label: "Collected" },
                  { value: "Off", label: "Off" },
                ],
              },
              cell: (setting) =>
                setting.policy.telemetry_enabled ? "Collected" : "Off",
            },
            {
              id: "applied",
              header: "Applied to",
              value: (setting) => setting.applied_device_count ?? -1,
              cell: (setting) => <AppliedDevices setting={setting} />,
            },
            {
              id: "updated",
              header: "Updated",
              value: (setting) => setting.updated_at || setting.created_at,
              cell: (setting) => (
                <DateCell value={setting.updated_at || setting.created_at} />
              ),
            },
            {
              id: "actions",
              header: <span className="sr-only">Actions</span>,
              label: "Actions",
              cell: (setting) =>
                operate && (
                  <div className="agent-settings-actions">
                    <Button
                      variant="secondary compact"
                      onClick={() => setDeploy({ setting, deviceIds: [] })}
                    >
                      Apply to devices
                    </Button>
                    {setting.revision !== undefined && (
                      <Button
                        variant="ghost compact"
                        icon={Pencil}
                        aria-label={`Edit ${setting.name}`}
                        onClick={(event) => {
                          editOpener.current = event.currentTarget;
                          setEditing(setting);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                    <Button
                      variant="ghost compact"
                      icon={CopyPlus}
                      aria-label={`Duplicate ${setting.name}`}
                      onClick={(event) =>
                        creation.current?.openCreate(event.currentTarget, {
                          name: `${setting.name} copy`.slice(0, 120),
                          policy: setting.policy,
                        })
                      }
                    >
                      Duplicate
                    </Button>
                  </div>
                ),
            },
          ]}
          empty={
            error ? (
              "Agent settings could not be loaded."
            ) : data.length ? (
              "No settings match these filters."
            ) : (
              <Quiet
                title="No saved agent settings"
                action={
                  operate ? (
                    <Button
                      onClick={(event) =>
                        creation.current?.openCreate(event.currentTarget)
                      }
                    >
                      Create settings
                    </Button>
                  ) : undefined
                }
              >
                Control how often agents check in, collect metrics, and sync
                pipeline changes.
              </Quiet>
            )
          }
        />
      </div>
      <p className="control-muted">
        Devices pick up applied settings on their next check-in. A pause set on
        the device itself stays until someone clears it there.
      </p>
      {editing && operate && (
        <AgentSettingsEditor
          key={editing.id}
          setting={editing}
          returnFocusRef={editOpener}
          onClose={() => setEditing(null)}
          onSaved={() => {
            notify("Saved. No devices change until you apply these settings.");
            void reload();
          }}
          onApply={(setting, deviceIds) => {
            setEditing(null);
            setDeploy({ setting, deviceIds });
          }}
        />
      )}
      {deploy && operate && (
        <TargetDialog
          key={user.id}
          userId={user.id}
          open
          onClose={() => {
            setDeploy(null);
            void reload();
          }}
          policy={deploy.setting.policy}
          policyId={deploy.setting.id}
          policyName={deploy.setting.name}
          initialDeviceIds={deploy.deviceIds}
          onDone={(message) => {
            notify(message);
            void reload();
          }}
        />
      )}
    </div>
  );
}

/** "3 devices", opening the list of devices that follow these settings. */
function AppliedDevices({ setting }: { setting: SavedPolicyListItem }) {
  const count = setting.applied_device_count;
  const devices = setting.applied_devices || [];
  const outdated = setting.outdated_device_count || 0;
  if (count === undefined)
    return <span className="control-muted">Unknown</span>;
  if (!count) return <span className="control-muted">Not applied</span>;
  return (
    <span className="agent-settings-applied">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button type="button" className="agent-settings-applied-trigger">
            {count === 1 ? "1 device" : `${count} devices`}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="agent-settings-applied-menu"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            aria-label={`Devices using ${setting.name}`}
          >
            <ul>
              {devices.map((device) => (
                <li key={device.id}>
                  <a href={`#/devices/${encodeURIComponent(device.id)}`}>
                    {device.name || device.id}
                  </a>
                </li>
              ))}
            </ul>
            {count > devices.length && <p>and {count - devices.length} more</p>}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {outdated > 0 && (
        <small className="agent-settings-outdated">
          {outdated === count
            ? "On earlier values"
            : `${outdated} on earlier values`}
        </small>
      )}
    </span>
  );
}

function tokenStatus(token: Token) {
  return token.revoked
    ? "Revoked"
    : Date.parse(token.expires_at) < Date.now()
      ? "Expired"
      : token.max_uses && token.uses >= token.max_uses
        ? "Used up"
        : "Available";
}

function localPaths(os: string) {
  return os === "windows"
    ? {
        state: "C:\\ProgramData\\Vectory",
        vector: "C:\\Program Files\\Vector\\bin\\vector.exe",
        config: "C:\\ProgramData\\VectoryConfig\\managed.json",
      }
    : os === "darwin"
      ? {
          state: "/Library/Application Support/Vectory",
          vector: "/opt/homebrew/bin/vector",
          config: "/Library/Application Support/VectoryConfig/managed.json",
        }
      : {
          state: "/var/lib/vectory",
          vector: "/usr/bin/vector",
          config: "/etc/vector/vectory-managed/managed.json",
        };
}
export function Enrollment({
  user,
  notify,
  navigate,
}: {
  user: User;
  notify: (message: string) => void;
  navigate: (path: string) => void;
}) {
  const tokens = useResource<Token[]>("/tokens", []),
    releases = useResource<Release[]>("/releases", []),
    devices = useResource<Device[]>("/devices", []);
  const [os, setOs] = useState(() =>
      navigator.platform.toLowerCase().includes("win")
        ? "windows"
        : navigator.platform.toLowerCase().includes("mac")
          ? "darwin"
          : "linux",
    ),
    [arch, setArch] = useState(() =>
      navigator.platform.toLowerCase().includes("mac") ? "arm64" : "amd64",
    ),
    [step, setStep] = useState(1),
    [workload, setWorkload] = useState("existing"),
    [runMode, setRunMode] = useState<"foreground" | "service">("foreground"),
    [serviceUser, setServiceUser] = useState(""),
    [configurationMode, setConfigurationMode] = useState<
      ConfigurationMode | ""
    >(""),
    [policyFile, setPolicyFile] = useState(""),
    [server, setServer] = useState(`https://${location.hostname}:8443`),
    [machine, setMachine] = useState("edge-01"),
    [privateCA, setPrivateCA] = useState(false),
    [caFile, setCaFile] = useState(""),
    [paths, setPaths] = useState(() =>
      localPaths(
        navigator.platform.toLowerCase().includes("win")
          ? "windows"
          : navigator.platform.toLowerCase().includes("mac")
            ? "darwin"
            : "linux",
      ),
    ),
    [name, setName] = useState(""),
    [hours, setHours] = useState(24),
    [prefix, setPrefix] = useState(""),
    [limit, setLimit] = useState("1"),
    [issuedToken, setIssuedToken] = useState<{
      record: Token;
      settings: string;
    } | null>(null),
    [tokenOpen, setTokenOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tokenBlocked, setTokenBlocked] = useState(false),
    [initialDeviceIds, setInitialDeviceIds] = useState<Set<string> | null>(
      null,
    );
  const tokenFlow = useRef<EnrollmentTokenFlowHandle>(null);
  useEffect(() => {
    // Establish the baseline only after a successful inventory request. Browser
    // and server clocks need not agree, and a failed request is not an empty fleet.
    if (initialDeviceIds === null && !devices.loading && !devices.error)
      setInitialDeviceIds(new Set(devices.data.map((device) => device.id)));
  }, [initialDeviceIds, devices.loading, devices.error, devices.data]);
  const release = releases.data.find((r) => r.os === os && r.arch === arch),
    unsupported = os === "darwin" && arch === "amd64";
  let origin = "";
  try {
    const url = new URL(server);
    if (
      url.protocol === "https:" &&
      url.port !== "0" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    )
      origin = url.origin;
  } catch {}
  const loopbackServer =
    !!origin &&
    /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(new URL(origin).hostname);
  const validName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(machine),
    matched = devices.data.find(
      (d) => d.name.toLowerCase() === machine.trim().toLowerCase(),
    ),
    freshMatch =
      matched &&
      initialDeviceIds !== null &&
      !initialDeviceIds.has(matched.id) &&
      matched.status !== "revoked";
  const quote = (value: string) =>
    "'" + value.replaceAll("'", os === "windows" ? "''" : "'\"'\"'") + "'";
  const managedConfigIsLocal = isAbsoluteLocalFilePath(paths.config, os);
  const managedConfigIsValid =
    managedConfigIsLocal && paths.config.endsWith(".json");
  const vectorBinaryIsValid = isAbsoluteLocalFilePath(paths.vector, os);
  const stateDirectoryIsValid = isAbsoluteLocalFilePath(paths.state, os);
  const installPathsValid =
    managedConfigIsValid && vectorBinaryIsValid && stateDirectoryIsValid;
  const absolutePathHint =
    os === "windows"
      ? "Use an absolute path on a local drive, not a network share or relative path."
      : "Use an absolute path on this device, not a relative path.";
  const executable = os === "windows" ? ".\\vectory.exe" : "./vectory";
  const install = `${executable} install --state-dir ${quote(paths.state)} --vector-binary ${quote(paths.vector)} --managed-config ${quote(paths.config)} --adopt --allow-full-vector-config=${configurationMode === "full" ? "true" : "false"}${configurationMode === "restricted" && policyFile ? ` --capability-policy ${quote(policyFile)}` : ""}`;
  const enroll = `${executable} enroll --state-dir ${quote(paths.state)} --server ${quote(origin)} --id ${quote(machine)}${privateCA ? ` --ca-file ${quote(caFile)}` : " --ca-file="}`;
  const run = `${executable} run --state-dir ${quote(paths.state)}`;
  const serviceUserValid =
    os === "windows" ||
    ((os === "linux"
      ? /^[a-z_][a-z0-9_-]{0,31}$/.test(serviceUser)
      : /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(serviceUser)) &&
      serviceUser !== "root");
  const servicePrefix = os === "windows" ? "" : "sudo ";
  const serviceInstall = `${servicePrefix}${executable} service-install --state-dir ${quote(paths.state)}${os === "windows" ? "" : ` --service-user ${quote(serviceUser)}`}`;
  const serviceStart = `${servicePrefix}${executable} service-start`;
  const prefixMatches = !prefix || machine.toLowerCase().startsWith(prefix);
  const tokenSettings = JSON.stringify({ hours, prefix, limit });
  const currentToken =
    issuedToken &&
    tokens.data.find((token) => token.id === issuedToken.record.id);
  const reusableToken =
    !tokens.error &&
    !tokens.loading &&
    !!currentToken &&
    issuedToken?.settings === tokenSettings &&
    !currentToken.revoked &&
    Date.parse(currentToken.expires_at) > Date.now() &&
    (currentToken.max_uses == null ||
      currentToken.uses < currentToken.max_uses);
  const validConnection =
    initialDeviceIds !== null &&
    !devices.error &&
    !!origin &&
    !!configurationMode &&
    validName &&
    prefixMatches &&
    (!privateCA || isAbsoluteLocalFilePath(caFile, os)) &&
    (configurationMode !== "restricted" ||
      !policyFile ||
      isAbsoluteLocalFilePath(policyFile, os)) &&
    (!matched || freshMatch);
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify("Copied.");
    } catch {
      notify(
        "Select and copy the command manually; clipboard access is unavailable.",
      );
    }
  }
  async function create(event: React.FormEvent, replaceToken = false) {
    event.preventDefault();
    const wizard = step === 2 && !tokenOpen;
    if (wizard && !validConnection) {
      setError(
        prefixMatches
          ? "Complete the connection settings before continuing."
          : "The token's name prefix must match this machine name.",
      );
      return;
    }
    if (wizard && reusableToken && !replaceToken) {
      setError("");
      setStep(3);
      return;
    }
    const result = await tokenFlow.current?.create({
      name: name.trim() || `${machine} enrollment`,
      expires_hours: hours,
      name_prefix: prefix || null,
      max_uses: limit ? Number(limit) : null,
    });
    setTokenOpen(false);
    if (result && wizard) {
      setIssuedToken({ record: result, settings: tokenSettings });
      setStep(3);
    }
  }
  function tokenFields() {
    return (
      <fieldset disabled={busy}>
        <Field label="Token name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder={`${machine} enrollment`}
          />
        </Field>
        <div className="control-two-col">
          <Field label="Expires in (hours)">
            <input
              type="number"
              min={1}
              max={720}
              required
              value={hours}
              onChange={(e) => setHours(+e.target.value)}
            />
          </Field>
          <Field
            label="Maximum uses"
            hint="Leave blank for reusable enrollment until expiry."
          >
            <input
              type="number"
              min={1}
              max={100000}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="Unlimited"
            />
          </Field>
        </div>
        <Field
          label="Allowed machine name prefix (optional)"
          hint="Use lowercase letters, numbers or hyphens, up to 80 characters."
        >
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            maxLength={80}
            pattern={"[a-z0-9\\-]*"}
            placeholder="For example, edge-"
          />
        </Field>
      </fieldset>
    );
  }
  function commandBlock(command: string, label: string) {
    if (!installPathsValid)
      return (
        <p className="control-muted">
          Correct the local paths above to show this command.
        </p>
      );
    return (
      <div className="control-command">
        <code>{command}</code>
        <Button
          variant="secondary compact"
          icon={Copy}
          onClick={() => void copy(command)}
          aria-label={`Copy ${label}`}
        >
          Copy command
        </Button>
      </div>
    );
  }
  return (
    <div className="control-page">
      <PageHeader
        title="Add device"
        help={{ topic: "installation", section: "install-and-enroll" }}
        description="Connect a Vector installation and choose whether to keep its current workload."
      >
        <Button variant="secondary" onClick={() => navigate("devices")}>
          Back to devices
        </Button>
      </PageHeader>
      <div className="enroll-layout">
        <EnrollmentTokenFlow
          key={`${user.id}:${user.role}`}
          ref={tokenFlow}
          user={user}
          notify={notify}
          onChange={() => void tokens.reload()}
          onState={(waiting, blocked) => {
            setBusy(waiting);
            setTokenBlocked(blocked);
          }}
        />
        {(tokens.error || releases.error || devices.error) && (
          <ErrorBox
            message={tokens.error || releases.error || devices.error}
            retry={() => {
              void tokens.reload();
              void releases.reload();
              void devices.reload();
            }}
          />
        )}
        <div className="control-card enroll-wizard">
          <ol className="control-steps" aria-label="Add device steps">
            {["Download", "Connection", "Install", "Verify"].map(
              (label, index) => (
                <li
                  key={label}
                  aria-current={step === index + 1 ? "step" : undefined}
                >
                  <span>{index + 1}</span>
                  {label}
                </li>
              ),
            )}
          </ol>
          {error && !tokenOpen && <ErrorBox message={error} />}
          {step === 1 && (
            <>
              <h2>Get the agent</h2>
              <p className="control-muted">
                Choose the operating system of the device you want to connect.
                Vector 0.58.0 must already be installed.
              </p>
              <fieldset
                className="enroll-platforms"
                aria-label="Operating system"
              >
                {[
                  ["windows", "Windows"],
                  ["linux", "Linux"],
                  ["darwin", "macOS"],
                ].map(([value, label]) => (
                  <label className="enroll-platform" key={value}>
                    <input
                      type="radio"
                      name="agent-os"
                      value={value}
                      checked={os === value}
                      onChange={() => {
                        setOs(value);
                        setPaths(localPaths(value));
                        setServiceUser("");
                        setArch(value === "darwin" ? "arm64" : "amd64");
                      }}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <Field label="Architecture">
                <select value={arch} onChange={(e) => setArch(e.target.value)}>
                  <option value="amd64">x86-64 / Intel</option>
                  <option value="arm64">ARM64 / Apple Silicon</option>
                </select>
              </Field>
              {releases.loading ? (
                <p className="control-muted" role="status">
                  Checking available downloads...
                </p>
              ) : unsupported ? (
                <p className="control-note">
                  Vector 0.58.0 is not distributed for Intel Macs. The available
                  agent binary is build-only and is not a supported setup.
                </p>
              ) : release ? (
                <>
                  <div className="enroll-download">
                    <div>
                      <strong>Vectory {release.version}</strong>
                      <small>
                        {(release.size / 1048576).toFixed(1)} MB,{" "}
                        {release.signed
                          ? "Signed release"
                          : "Unsigned development build"}
                      </small>
                    </div>
                    <a
                      className="button"
                      href={release.url}
                      download={os === "windows" ? "vectory.exe" : "vectory"}
                    >
                      <Download size={16} />
                      Download agent
                    </a>
                  </div>
                  <p className="control-muted">
                    Rename the downloaded file to{" "}
                    <code>{os === "windows" ? "vectory.exe" : "vectory"}</code>.
                    Keep it in a dedicated folder and open a terminal there.
                  </p>
                  <details className="control-disclosure">
                    <summary>Checksum and compatibility</summary>
                    <p className="control-muted">
                      Verify the downloaded bytes against a trusted copy of this
                      SHA-256 checksum before running.{" "}
                      {os === "windows"
                        ? "Native foreground operation was tested on Windows 11. Service installation and other Windows versions remain unverified."
                        : "This artifact is cross-compiled; native installation and service operation are not yet verified."}
                    </p>
                    <code className="control-wrap-code">{release.sha256}</code>
                  </details>
                </>
              ) : (
                <p className="control-note">
                  No release is available for this platform. Ask the host
                  administrator to add a verified artifact to the release
                  catalog.
                </p>
              )}
              <div className="enroll-footer">
                <span className="control-muted">
                  Download the agent before continuing.
                </span>
                <Button
                  variant="secondary"
                  disabled={!release || unsupported || releases.loading}
                  onClick={() => setStep(2)}
                >
                  Continue
                </Button>
              </div>
            </>
          )}
          {step === 2 && (
            <form onSubmit={create}>
              <fieldset disabled={busy}>
                <h2>Set up the connection</h2>
                <p className="control-muted">
                  Use a unique device name and the trusted HTTPS address of this
                  instance's agent listener.
                </p>
                <Field
                  label="Machine name"
                  hint={
                    !validName
                      ? "Use up to 100 letters, numbers, dots, hyphens or underscores. Start with a letter or number."
                      : undefined
                  }
                >
                  <input
                    value={machine}
                    maxLength={100}
                    aria-invalid={!validName}
                    onChange={(e) => setMachine(e.target.value)}
                    required
                    autoComplete="off"
                  />
                </Field>
                {initialDeviceIds === null && !devices.error && (
                  <p className="control-muted" role="status">
                    Checking existing device names before creating a token...
                  </p>
                )}
                {matched && !freshMatch && (
                  <div className="control-note">
                    <p>
                      {matched.status === "revoked"
                        ? "This device's access is revoked. A regular enrollment token cannot restore its identity."
                        : "A device with this name already exists. Open it to continue setup or review its connection."}{" "}
                      For replacement credentials,{" "}
                      {can(user, "admin")
                        ? "authorize recovery from its device page"
                        : "ask an administrator to authorize recovery from its device page"}
                      . Use a different name to add another device.
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() => navigate(`devices/${matched.id}`)}
                    >
                      Open existing device
                    </Button>
                  </div>
                )}
                <Field
                  label="Server URL"
                  hint={
                    !origin
                      ? "Enter an HTTPS address with a valid port (1–65535), no path, username or password."
                      : loopbackServer
                        ? "This address works only when the agent runs on this server. For another device, use a reachable listener hostname that matches the HTTPS certificate."
                        : undefined
                  }
                >
                  <input
                    value={server}
                    onChange={(e) => setServer(e.target.value)}
                    type="url"
                    aria-invalid={!origin}
                    required
                    placeholder="https://vectory.example.com:8443"
                  />
                </Field>
                <ServerCertificateTrust
                  privateCA={privateCA}
                  onPrivateCAChange={setPrivateCA}
                  caFile={caFile}
                  onCaFileChange={setCaFile}
                  os={os}
                  disabled={busy}
                />
                <ConfigurationModePicker
                  value={configurationMode}
                  onChange={setConfigurationMode}
                  disabled={busy}
                />
                {configurationMode === "restricted" && (
                  <RestrictedPolicyFile
                    value={policyFile}
                    onChange={setPolicyFile}
                    os={os}
                    disabled={busy}
                  />
                )}
                <p className="control-muted">
                  <DocLink
                    topic="installation"
                    section="choose-configuration-capabilities"
                  >
                    Understand configuration modes and device permissions
                  </DocLink>
                </p>
                <details className="control-disclosure">
                  <summary>Token settings</summary>
                  <div className="control-disclosure-content">
                    {tokenFields()}
                  </div>
                </details>
                {!prefixMatches && (
                  <ErrorBox
                    message={`The token prefix "${prefix}" does not match "${machine}". Change the prefix or machine name before continuing.`}
                  />
                )}
                <p className="control-muted">
                  The default token permits one enrollment and expires in 24
                  hours. You will see it once. New devices have no pipeline
                  assignment.
                </p>
                {reusableToken && (
                  <p className="control-muted">
                    Your saved token is still valid. Continue with it, or create
                    a new token if you no longer have it.
                  </p>
                )}
                <div className="enroll-footer">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setStep(1)}
                  >
                    Back
                  </Button>
                  {reusableToken && (
                    <Button
                      variant="secondary"
                      disabled={
                        busy ||
                        tokenBlocked ||
                        !validConnection ||
                        !can(user, "operate")
                      }
                      onClick={(event) => void create(event, true)}
                    >
                      Create a new token
                    </Button>
                  )}
                  <Button
                    type="submit"
                    busy={busy}
                    disabled={
                      tokenBlocked || !validConnection || !can(user, "operate")
                    }
                  >
                    {reusableToken
                      ? "Continue with saved token"
                      : "Create enrollment token"}
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
          {step === 3 && (
            <>
              <h2>Run the agent on {machine}</h2>
              <p className="control-muted">
                Run the install and enrollment commands on the device under an
                authorized host account. If you choose a service below, give its
                separate service identity access to the managed workload.
              </p>
              <Field label="Starting workload">
                <select
                  value={workload}
                  onChange={(event) => setWorkload(event.target.value)}
                >
                  <option value="existing">
                    Keep an existing Vector workload
                  </option>
                  <option value="new">Start without a workload</option>
                </select>
              </Field>
              <Field
                label="Managed configuration file"
                hint={
                  !managedConfigIsLocal
                    ? absolutePathHint
                    : !managedConfigIsValid
                      ? "The managed configuration file must end in .json."
                      : "One JSON document in a dedicated directory containing no unrelated files."
                }
              >
                <input
                  value={paths.config}
                  onChange={(e) =>
                    setPaths({ ...paths, config: e.target.value })
                  }
                  aria-invalid={!managedConfigIsValid}
                  required
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <details className="control-disclosure">
                <summary>
                  Other local paths
                  {(!vectorBinaryIsValid || !stateDirectoryIsValid) && (
                    <span className="enroll-path-summary-error">
                      Fix invalid paths
                    </span>
                  )}
                </summary>
                <div className="control-disclosure-content">
                  <Field
                    label="Existing Vector executable"
                    hint={vectorBinaryIsValid ? undefined : absolutePathHint}
                  >
                    <input
                      value={paths.vector}
                      onChange={(e) =>
                        setPaths({ ...paths, vector: e.target.value })
                      }
                      aria-invalid={!vectorBinaryIsValid}
                      required
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field
                    label="Agent state directory"
                    hint={stateDirectoryIsValid ? undefined : absolutePathHint}
                  >
                    <input
                      value={paths.state}
                      onChange={(e) =>
                        setPaths({ ...paths, state: e.target.value })
                      }
                      aria-invalid={!stateDirectoryIsValid}
                      required
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                </div>
              </details>
              {!installPathsValid && (
                <p className="enroll-path-warning">
                  Correct the device paths before copying commands or checking
                  the connection. This form checks their syntax; the agent
                  checks the files and directories on the device during install.
                </p>
              )}
              <div
                className="enroll-command-step"
                data-enrollment-preparation={workload}
              >
                {workload === "existing" ? (
                  <>
                    <h3>1. Prepare the workload before stopping Vector</h3>
                    {configurationMode === "restricted" && !policyFile && (
                      <div className="control-note">
                        No local allowance file was selected. Restricted mode
                        supports a limited component set and denies file,
                        network, and listener access unless the host has
                        approved those resources. Check the existing
                        configuration before stopping Vector. If it needs these
                        resources, go back and provide an approved allowance
                        file on the device. An allowance file cannot enable an
                        unsupported component; choosing full mode requires a
                        separate host decision.
                      </div>
                    )}
                    <ol className="control-muted">
                      <li>
                        Back up the current configuration and service definition
                        outside the managed directory.
                      </li>
                      <li>
                        While Vector is still running, copy or combine all its
                        configuration files into the managed JSON file above.
                        Include configuration-directory files and check access
                        to data, credentials and other local dependencies.
                      </li>
                      <li>
                        Only after that file is ready, stop and disable the old
                        supervisor for this Vector instance.
                      </li>
                    </ol>
                    <p>
                      The agent does not discover or copy the old configuration.
                      It starts only the selected file. Review the{" "}
                      <DocLink
                        topic="installation"
                        section="keep-an-existing-workload"
                      >
                        adoption preparation steps
                      </DocLink>
                      , including local permissions for restricted mode.
                    </p>
                  </>
                ) : (
                  <>
                    <h3>1. Choose an empty managed path</h3>
                    <p>
                      Use a new path that does not contain an existing workload.
                      The managed file may be absent: the agent can enroll and
                      check in without starting Vector. It waits for you to
                      explicitly deploy a pipeline.
                    </p>
                    <p>
                      No pipeline is assigned automatically. To retain a running
                      workload, choose{" "}
                      <strong>Keep an existing Vector workload</strong> instead.
                      See{" "}
                      <DocLink
                        topic="installation"
                        section="start-without-a-workload"
                      >
                        preparing a new device
                      </DocLink>
                      .
                    </p>
                  </>
                )}
              </div>
              {os !== "windows" && (
                <p className="control-muted">
                  First make the downloaded agent executable:{" "}
                  <code>chmod +x ./vectory</code>.
                </p>
              )}
              <div className="enroll-command-step">
                <h3>2. Install the agent</h3>
                {commandBlock(install, "installation command")}
                <p>
                  Installation records the managed paths; it does not start
                  Vector.
                </p>
              </div>
              <div className="enroll-command-step">
                <h3>3. Enroll this device</h3>
                <p>
                  Paste the saved token into the terminal's hidden prompt. The
                  token stays out of the command and shell history.
                </p>
                {commandBlock(enroll, "enrollment command")}
              </div>
              <div className="enroll-command-step">
                <h3>4. Keep the agent running</h3>
                <fieldset className="enroll-run-modes">
                  <legend>How should the agent run?</legend>
                  <label className="enroll-run-mode">
                    <input
                      type="radio"
                      name="agent-run-mode"
                      value="foreground"
                      checked={runMode === "foreground"}
                      onChange={() => setRunMode("foreground")}
                    />
                    <span>
                      <strong>In this terminal</strong>
                      <small>For setup or testing; stops when it closes.</small>
                    </span>
                  </label>
                  <label className="enroll-run-mode">
                    <input
                      type="radio"
                      name="agent-run-mode"
                      value="service"
                      checked={runMode === "service"}
                      onChange={() => setRunMode("service")}
                    />
                    <span>
                      <strong>As an OS service</strong>
                      <small>For unattended operation after host setup.</small>
                    </span>
                  </label>
                </fieldset>
                {runMode === "foreground" ? (
                  <>
                    {commandBlock(run, "run command")}
                    <p>
                      Keep this terminal open. Closing it stops the agent and
                      its supervised Vector process.
                    </p>
                  </>
                ) : (
                  <>
                    {os !== "windows" ? (
                      <Field
                        label="Existing service account"
                        hint={
                          serviceUserValid
                            ? "This account must be able to run Vector and access its local data and credentials."
                            : "Enter an existing, unprivileged, non-root account name before copying service commands."
                        }
                      >
                        <input
                          value={serviceUser}
                          onChange={(event) =>
                            setServiceUser(event.target.value)
                          }
                          aria-invalid={!serviceUserValid}
                          autoComplete="off"
                          placeholder={os === "darwin" ? "_vectory" : "vectory"}
                        />
                      </Field>
                    ) : (
                      <p>
                        Run these commands from an elevated PowerShell. The
                        service uses the dedicated{" "}
                        <code>NT SERVICE\Vectory</code> account; grant it access
                        to the agent executable, Vector and required local
                        resources.
                      </p>
                    )}
                    {os !== "windows" && (
                      <p>
                        Run these commands with administrator privileges. Keep
                        the agent executable at a stable path accessible by the
                        service account; registration records that path and
                        updates ownership of the agent state and managed file.{" "}
                        {os === "linux"
                          ? "This service uses systemd; use an existing supervisor if systemd is unavailable."
                          : "This service uses launchd."}
                      </p>
                    )}
                    {serviceUserValid && (
                      <>
                        {commandBlock(
                          serviceInstall,
                          "service installation command",
                        )}
                        {commandBlock(serviceStart, "service start command")}
                      </>
                    )}
                    <p>
                      Registration does not prove the service started or Vector
                      applied a configuration. Check the local service status,
                      then a fresh device check-in and the reported apply state.{" "}
                      <DocLink
                        topic="installation"
                        section="keep-the-agent-running"
                      >
                        Service setup guide
                      </DocLink>
                    </p>
                  </>
                )}
                <p>
                  {workload === "existing"
                    ? "Once running, the agent validates the prepared configuration before attempting to start Vector. A missing file starts no Vector process."
                    : "Once running without a managed file, the agent checks in and waits for an assignment."}
                </p>
              </div>
              <div className="enroll-footer">
                <Button variant="secondary" onClick={() => setStep(2)}>
                  Back
                </Button>
                <Button
                  disabled={
                    !installPathsValid ||
                    (runMode === "service" && !serviceUserValid)
                  }
                  onClick={() => {
                    setStep(4);
                    void devices.reload();
                  }}
                >
                  Check connection
                </Button>
              </div>
            </>
          )}
          {step === 4 && (
            <>
              <h2>Verify the device</h2>
              <div className="enroll-proof">
                {freshMatch ? (
                  <>
                    <h3>{machine} is enrolled</h3>
                    <p className="control-muted">
                      {matched.last_seen
                        ? `Last check-in ${when(matched.last_seen)}.`
                        : "Waiting for the first agent check-in. Keep the agent running."}{" "}
                      No pipeline is assigned automatically.
                    </p>
                    <dl className="control-summary-list">
                      <div>
                        <dt>Connection</dt>
                        <dd>
                          {matched.last_seen
                            ? matched.status === "offline"
                              ? "Offline"
                              : "Agent has checked in"
                            : "Enrollment confirmed"}
                        </dd>
                      </div>
                      <div>
                        <dt>Platform</dt>
                        <dd>
                          {matched.os} / {matched.arch}
                        </dd>
                      </div>
                      <div>
                        <dt>Reported configuration mode</dt>
                        <dd>
                          {matched.configuration_mode === "full"
                            ? "Full Vector mode"
                            : "Restricted mode"}
                        </dd>
                      </div>
                    </dl>
                    {(matched.configuration_mode || "restricted") !==
                      configurationMode && (
                      <ErrorBox
                        message={`The device reports ${matched.configuration_mode === "full" ? "full" : "restricted"} mode, but you selected ${configurationMode}. Check the local installation command and wait for a new agent check-in. The dashboard cannot change this permission.`}
                      />
                    )}
                  </>
                ) : matched?.status === "revoked" ? (
                  <>
                    <h3>{machine} access is revoked</h3>
                    <p className="control-muted">
                      This identity cannot connect. Open the device to review
                      its access and{" "}
                      {can(user, "admin")
                        ? "authorize recovery"
                        : "ask an administrator to authorize recovery"}
                      ; a regular enrollment token cannot restore it.
                    </p>
                  </>
                ) : (
                  <>
                    <h3>Waiting for {machine}</h3>
                    <p className="control-muted">
                      Run the enrollment and agent commands on the device. This
                      page checks for enrollment every 15 seconds.
                    </p>
                    <details className="control-disclosure">
                      <summary>Connection troubleshooting</summary>
                      <p className="control-muted">
                        Check the server address, certificate trust, token
                        expiry and device name. Keep the agent running and
                        inspect its terminal for a sanitized error. Do not
                        bypass TLS verification.
                      </p>
                    </details>
                  </>
                )}
              </div>
              <div className="enroll-footer">
                <Button variant="secondary" onClick={() => setStep(3)}>
                  Back to commands
                </Button>
                {freshMatch || matched?.status === "revoked" ? (
                  <Button onClick={() => navigate(`devices/${matched.id}`)}>
                    Open device
                  </Button>
                ) : (
                  <RefreshButton
                    busy={devices.loading}
                    onClick={devices.reload}
                  >
                    Check again
                  </RefreshButton>
                )}
              </div>
            </>
          )}
        </div>
        <details className="enroll-token-management">
          <summary>Manage enrollment tokens ({tokens.data.length})</summary>
          <div className="control-card">
            <div className="control-section-head">
              <div>
                <h3>Enrollment tokens</h3>
                <p>
                  Revoking a token prevents new enrollments. Existing devices
                  stay connected.
                </p>
              </div>
              {can(user, "operate") && (
                <Button
                  variant="secondary"
                  disabled={busy || tokenBlocked}
                  onClick={() => {
                    setError("");
                    setTokenOpen(true);
                  }}
                >
                  Create token
                </Button>
              )}
            </div>
            {tokens.error && (
              <ErrorBox message={tokens.error} retry={tokens.reload} />
            )}
            <DataTable
              data={tokens.error ? [] : tokens.data}
              rowKey={(token) => token.id}
              label="Enrollment tokens"
              loading={tokens.loading}
              columns={[
                {
                  id: "name",
                  header: "Name",
                  value: (token) => token.name,
                  filter: { placeholder: "Filter token names" },
                  cell: (token) => (
                    <>
                      <strong>{token.name}</strong>
                      <small>
                        {token.name_prefix
                          ? `Names starting with ${token.name_prefix}`
                          : "Any unique device name"}
                      </small>
                    </>
                  ),
                },
                {
                  id: "status",
                  header: "Status",
                  value: tokenStatus,
                  filter: {
                    options: ["Available", "Revoked", "Expired", "Used up"].map(
                      (value) => ({ value, label: value }),
                    ),
                  },
                  cell: tokenStatus,
                },
                {
                  id: "uses",
                  header: "Uses",
                  value: (token) => token.uses,
                  cell: (token) => (
                    <>
                      {token.uses}
                      {token.max_uses ? ` / ${token.max_uses}` : ""}
                    </>
                  ),
                },
                {
                  id: "expires",
                  header: "Expires",
                  value: (token) => token.expires_at,
                  sortValue: (token) => Date.parse(token.expires_at),
                  cell: (token) => <DateCell value={token.expires_at} />,
                },
                {
                  id: "actions",
                  header: <span className="sr-only">Token actions</span>,
                  cell: (token) =>
                    !token.revoked &&
                    can(user, "operate") && (
                      <Button
                        variant="secondary compact"
                        onClick={() => {
                          tokenFlow.current?.openRevoke(token);
                        }}
                      >
                        Revoke
                      </Button>
                    ),
                },
              ]}
              empty={
                tokens.error
                  ? "Enrollment tokens could not be loaded."
                  : tokens.data.length
                    ? "No tokens match these filters."
                    : "No tokens have been created."
              }
            />
          </div>
        </details>
      </div>
      <Modal
        open={tokenOpen}
        onClose={() => !busy && setTokenOpen(false)}
        title="Create enrollment token"
        description="This token is shown once and can only enroll new devices."
      >
        <form onSubmit={create}>
          <div className="modal-body">
            {error && <ErrorBox message={error} />} {tokenFields()}
          </div>
          <div className="modal-footer">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setTokenOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={tokenBlocked}>
              Create token
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export { default as AuditLog } from "./AuditLog";

export function Settings() {
  const { data, error, loading } = useResource<any>("/settings", null);
  return (
    <div className="control-page">
      <PageHeader
        title="General"
        help={{ topic: "administer", section: "monitor-the-instance" }}
        description="Instance information and host-managed defaults."
      />
      {error && <ErrorBox message={error} />}
      <section className="control-card">
        <h2>Instance</h2>
        {loading ? (
          <Spinner />
        ) : (
          <dl className="control-summary-list">
            <div>
              <dt>Name</dt>
              <dd>{data?.instance_name || "Unavailable"}</dd>
            </div>
            <div>
              <dt>Vectory version</dt>
              <dd>{data?.version || "Unavailable"}</dd>
            </div>
            <div>
              <dt>Vector version</dt>
              <dd>{data?.vector_version || "Unavailable"}</dd>
            </div>
          </dl>
        )}
      </section>
      <section className="control-card">
        <h2>Defaults</h2>
        <dl className="control-summary-list">
          <div>
            <dt>Check-in interval</dt>
            <dd>
              {data?.heartbeat_seconds
                ? `${data.heartbeat_seconds} seconds`
                : "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>Metric retention</dt>
            <dd>
              {data?.telemetry_retention_days
                ? `${data.telemetry_retention_days} days`
                : "Unavailable"}
            </dd>
          </div>
        </dl>
        <p className="control-muted">
          The host administrator configures this instance. Apply device-specific
          behavior under Devices, Agent settings.
        </p>
        <details className="control-disclosure">
          <summary>Hosting and recovery</summary>
          <div className="control-disclosure-content">
            <p className="control-muted">
              Run one control-plane instance on local persistent storage. Use
              the included backup tool to preserve the database and its trust
              keys together.
            </p>
            <p className="control-muted">
              After restoring an older backup, follow the reviewed
              generation-recovery procedure before resuming deployments. Agent
              counters must not be reset.
            </p>
          </div>
        </details>
      </section>
    </div>
  );
}
