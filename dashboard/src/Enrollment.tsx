// Add device: choose the host, run one verified command, watch it connect.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Laptop,
  Monitor,
  RotateCcw,
  Server,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { DataTable } from "./DataTable";
import {
  APIError,
  AgentInstallSchema,
  EnrollmentActivitySchema,
  api,
  can,
  withRequestDeadline,
  type Device,
  type EnrollmentEvent,
  type Token,
  type User,
} from "./api";
import {
  Button,
  CopyButton,
  DateCell,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  Spinner,
  useResource,
} from "./ui";
import TabLabel from "./TabLabel";
import DocLink from "./DocLink";
import {
  ModeCards,
  SecurityReceipt,
  TrustChoices,
  isAbsoluteLocalFilePath,
} from "./EnrollmentConnection";
import EnrollmentTokenFlow, {
  type EnrollmentTokenFlowHandle,
  type ReadyToken,
} from "./EnrollmentTokenFlow";
import {
  accountPatterns,
  detectOS,
  deviceNamePattern,
  effectiveTrust,
  installerCommand,
  platformDefaults,
  releaseFor,
  runCommand,
  setupCommand,
  windowsCommand,
  type HostOS,
  type Mode,
  type ServiceChoice,
  type SetupChoices,
  type TrustChoice,
} from "./enrollmentCommands";
import {
  describeAgent,
  mergeAttempts,
  progress,
  refusal,
  supervision,
  unsupervisedLine,
} from "./enrollmentActivity";
import {
  deviceName,
  parseLabels,
  parsePreapprovedNames,
  scopeText,
  usesBelowNames,
} from "./enrollmentScope";
import {
  resolveTokenRequests,
  useTokenRequests,
} from "./enrollmentTokenRequests";
import "./control.css";
import "./enrollment-page.css";
import type { Notify } from "./toast";

const platforms: { value: HostOS; label: string; icon: typeof Server }[] = [
  { value: "linux", label: "Linux", icon: Server },
  { value: "darwin", label: "macOS", icon: Laptop },
  { value: "windows", label: "Windows", icon: Monitor },
];

function tokenStatus(token: Token) {
  return token.revoked
    ? "Revoked"
    : Date.parse(token.expires_at) < Date.now()
      ? "Expired"
      : token.max_uses && token.uses >= token.max_uses
        ? "Used up"
        : "Available";
}
/** The installer's --install-dir: a directory, so a trailing slash is fine. */
function directoryPath(value: string) {
  return value.trim().replace(/(.)\/+$/, "$1");
}
function clock(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

type Command = {
  tokenId: string;
  since: string;
  expiresAt: string;
  maxUses: number | null;
};
type Watch = {
  events: EnrollmentEvent[];
  devices: Device[] | null;
  error: string;
  unsupported: boolean;
};
const idle: Watch = {
  events: [],
  devices: null,
  error: "",
  unsupported: false,
};

/**
 * Polls enrollment activity and the inventory every two seconds while a
 * command waits for its device (more slowly while a connected agent waits to
 * be started). A poll never overlaps a slower one.
 */
function useEnrollmentWatch(
  command: Command | null,
  active: boolean,
  interval = 2000,
) {
  const [watch, setWatch] = useState<Watch>(idle);
  const tokenId = command?.tokenId,
    since = command?.since;
  useEffect(() => setWatch(idle), [tokenId]);
  useEffect(() => {
    if (!tokenId || !since || !active) return;
    let stopped = false,
      unsupported = false;
    let running: AbortController | null = null;
    const tick = async () => {
      if (stopped || running) return;
      const controller = new AbortController();
      running = controller;
      try {
        const [activity, devices] = await Promise.all([
          unsupported
            ? Promise.resolve(null)
            : withRequestDeadline(
                (signal) =>
                  api(
                    `/agent-install/activity?since=${encodeURIComponent(since)}`,
                    { signal },
                    EnrollmentActivitySchema,
                  ),
                30000,
                controller.signal,
              ).catch((error) => {
                // An older server has no activity feed; the inventory still works.
                if (error instanceof APIError && error.status === 404) {
                  unsupported = true;
                  return null;
                }
                throw error;
              }),
          withRequestDeadline(
            (signal) => api<Device[]>("/devices", { signal }),
            30000,
            controller.signal,
          ),
        ]);
        if (!stopped)
          setWatch((previous) => ({
            events: activity ? activity.events : previous.events,
            devices,
            error: "",
            unsupported,
          }));
      } catch (error) {
        if (!stopped && !controller.signal.aborted)
          setWatch((previous) => ({
            ...previous,
            error: (error as Error).message,
          }));
      } finally {
        if (running === controller) running = null;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), interval);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      running?.abort();
    };
  }, [tokenId, since, active, interval]);
  return watch;
}

/**
 * Every enrollment attempt of the last day, refused ones with their reason,
 * so a refusal is still explained after a reload.
 */
function RecentAttempts({
  events,
  loading,
  error,
  currentTokenId,
}: {
  events: EnrollmentEvent[];
  loading: boolean;
  error: string;
  currentTokenId: string | null;
}) {
  // The live timeline above already shows this command's attempts.
  const shown = events.filter(
    (event) => !currentTokenId || event.token_id !== currentTokenId,
  );
  const refused = shown.filter((event) => event.outcome === "failure").length;
  return (
    <details className="enroll-attempts">
      <summary>
        Recent enrollment attempts
        {loading && !shown.length
          ? ""
          : ` (${shown.length}${refused ? `, ${refused} refused` : ""})`}
      </summary>
      <div className="control-card">
        <p className="control-muted">
          The last 24 hours. Devices only learn that enrollment was refused; the
          reason is recorded here and in the audit log.
        </p>
        {error ? (
          <p className="control-muted">
            Enrollment attempts couldn&apos;t be loaded.
          </p>
        ) : !shown.length ? (
          <p className="control-muted">
            {loading
              ? "Loading…"
              : "No enrollment attempts in the last 24 hours."}
          </p>
        ) : (
          <ol className="enroll-timeline">
            {shown.map((event, index) => (
              <li
                key={event.id || index}
                data-outcome={
                  event.outcome === "failure" ? "failure" : "success"
                }
              >
                {event.outcome === "failure" ? (
                  <XCircle size={16} aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={16} aria-hidden="true" />
                )}
                <span>
                  <strong>
                    {event.outcome === "failure"
                      ? `Refused${event.device_name ? ` "${event.device_name}"` : ""}: ${refusal(event).title}.`
                      : `Enrolled ${event.device_name || "a new device"}`}
                  </strong>
                  <small>
                    {[
                      event.created_at
                        ? new Date(event.created_at).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "",
                      event.client_address
                        ? `from ${event.client_address}`
                        : "",
                      describeAgent(event),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                  {event.outcome === "failure" && (
                    <small>{refusal(event).fix}</small>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

function CommandBlock({
  command,
  label,
  focus = false,
  onFocused,
}: {
  command: string;
  label: string;
  /** Move focus here once, after the command was created. */
  focus?: boolean;
  onFocused?: () => void;
}) {
  const block = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!focus) return;
    block.current?.focus();
    onFocused?.();
  }, [focus, onFocused]);
  return (
    <div className="enroll-command">
      <pre ref={block} tabIndex={0} aria-label={label}>
        <code>{command}</code>
      </pre>
      <CopyButton
        text={command}
        ariaLabel={`Copy ${label.toLowerCase()}`}
        copiedMessage={`${label} copied.`}
      />
    </div>
  );
}

export function Enrollment({
  user,
  notify,
  navigate,
}: {
  user: User;
  notify: Notify;
  navigate: (path: string) => void;
}) {
  const details = useResource<unknown>("/agent-install", null);
  const tokens = useResource<Token[]>("/tokens", []);
  const devices = useResource<Device[]>("/devices", []);
  const savedRequests = useTokenRequests(user.id).operations;
  const parsed = useMemo(
    () =>
      details.data === null ? null : AgentInstallSchema.safeParse(details.data),
    [details.data],
  );
  const install = parsed?.success ? parsed.data : null;
  const [os, setOs] = useState<HostOS>(detectOS);
  const [mode, setMode] = useState<Mode | "">("");
  const [name, setName] = useState("");
  const [service, setService] = useState<ServiceChoice>("auto");
  const [serviceUser, setServiceUser] = useState("");
  const [createUser, setCreateUser] = useState(true);
  const [stateDir, setStateDir] = useState("");
  const [managedConfig, setManagedConfig] = useState("");
  const [capabilityPolicy, setCapabilityPolicy] = useState("");
  const [vectorBinary, setVectorBinary] = useState("");
  // Empty: the server's default way for hosts to check it.
  const [trust, setTrust] = useState<TrustChoice | "">("");
  const [caFile, setCaFile] = useState("");
  const [installDir, setInstallDir] = useState("");
  const [revokingUnused, setRevokingUnused] = useState(false);
  // Refused and accepted enrollments of the last day, kept across reloads.
  const [historySince] = useState(() =>
    new Date(Date.now() - 86400000).toISOString(),
  );
  // The live timeline polls while a command waits; this list only needs to
  // survive a reload, so it refreshes rarely.
  // Operators and admins only: the feed names addresses and attempted names.
  const history = useResource<unknown>(
    can(user, "operate")
      ? `/agent-install/activity?since=${encodeURIComponent(historySince)}`
      : null,
    null,
    0,
    { interval: 300000 },
  );
  const [hours, setHours] = useState(1);
  const [maxUses, setMaxUses] = useState("1");
  const [prefix, setPrefix] = useState("");
  const [namesText, setNamesText] = useState("");
  const [labelsText, setLabelsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [secret, setSecret] = useState<ReadyToken | null>(null);
  const [shown, setShown] = useState(false);
  const [command, setCommand] = useState<Command | null>(null);
  const [focusCommand, setFocusCommand] = useState(false);
  const commandFocused = useCallback(() => setFocusCommand(false), []);
  const [finished, setFinished] = useState<string | null>(null);
  // When the device was first seen checked in: setup's own check-in when
  // no service keeps its agent running.
  const [firstCheckIn, setFirstCheckIn] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [baseline, setBaseline] = useState<Set<string> | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  // What earlier install commands enrolled, said once when their reminders go.
  const [notes, setNotes] = useState<string[]>([]);
  const [startingOver, setStartingOver] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [startOverError, setStartOverError] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [fleet, setFleet] = useState({
    name: "",
    hours: 24,
    limit: "",
    prefix: "",
  });
  const tokenFlow = useRef<EnrollmentTokenFlowHandle>(null);
  useEffect(() => {
    // Establish the baseline only after a successful inventory read. A failed
    // read is not an empty fleet, and browser and server clocks may differ.
    if (baseline === null && !devices.loading && !devices.error)
      setBaseline(new Set(devices.data.map((device) => device.id)));
  }, [baseline, devices.loading, devices.error, devices.data]);

  const defaults = platformDefaults(os);
  const choices: SetupChoices = {
    os,
    mode: mode || "restricted",
    name,
    service,
    serviceUser,
    createUser,
    stateDir,
    managedConfig,
    capabilityPolicy,
    vectorBinary,
    trust: trust || undefined,
    caFile,
    installDir: os === "windows" ? "" : directoryPath(installDir),
  };
  const trustChoice = install ? effectiveTrust(install, choices.trust) : null;
  const trimmedName = name.trim();
  const nameValid = !trimmedName || deviceNamePattern.test(trimmedName);
  const existing = trimmedName
    ? devices.data.find(
        (device) => device.name.toLowerCase() === trimmedName.toLowerCase(),
      )
    : undefined;
  const accountValid =
    os === "windows" ||
    service === "none" ||
    !serviceUser.trim() ||
    (accountPatterns[os].test(serviceUser.trim()) &&
      serviceUser.trim() !== "root");
  const pathProblem = (value: string, json = false) =>
    value.trim() &&
    (!isAbsoluteLocalFilePath(value.trim(), os) ||
      (json && !value.trim().endsWith(".json")))
      ? os === "windows"
        ? "Use a full path on a local drive."
        : "Use a full path on the host."
      : "";
  // A CA file is required once that choice is made; a typed path is only a
  // path until setup reads it on the host.
  const caFileProblem =
    trustChoice === "file"
      ? caFile.trim()
        ? pathProblem(caFile)
        : "Enter where the CA certificate is on the host."
      : "";
  const agentDirectory = directoryPath(installDir);
  const installDirProblem =
    os === "windows" || !agentDirectory
      ? ""
      : agentDirectory === "/"
        ? "Choose a directory of its own for the agent, not /."
        : pathProblem(agentDirectory);
  const prefixValid = /^[a-z0-9-]{0,80}$/.test(prefix);
  const prefixMatches =
    !prefix || !trimmedName || trimmedName.toLowerCase().startsWith(prefix);
  const preapproved = parsePreapprovedNames(
    namesText,
    prefixValid ? prefix : "",
  );
  const labels = parseLabels(labelsText);
  // With a list, this command's own device name must be on it.
  const nameListed =
    !preapproved.value ||
    !trimmedName ||
    preapproved.value.includes(deviceName(trimmedName) || "");
  const usesValid =
    !maxUses ||
    (Number.isInteger(Number(maxUses)) &&
      Number(maxUses) >= 1 &&
      Number(maxUses) <= 100000);
  const namesWarning = usesBelowNames(preapproved.value, maxUses);
  const hoursValid = Number.isInteger(hours) && hours >= 1 && hours <= 720;
  const ready =
    !!install?.agent_url &&
    !!mode &&
    nameValid &&
    !existing &&
    accountValid &&
    !pathProblem(stateDir) &&
    !pathProblem(managedConfig, true) &&
    !pathProblem(capabilityPolicy, true) &&
    !pathProblem(vectorBinary) &&
    !caFileProblem &&
    !installDirProblem &&
    prefixValid &&
    prefixMatches &&
    !preapproved.error &&
    nameListed &&
    !labels.error &&
    usesValid &&
    hoursValid &&
    baseline !== null &&
    !devices.error;

  const current =
    command && secret?.record.id === command.tokenId ? secret : null;
  const commandToken = command
    ? tokens.data.find((token) => token.id === command.tokenId)
    : undefined;
  const [watchSlowly, setWatchSlowly] = useState(false);
  const watching =
    !!command &&
    baseline !== null &&
    (finished !== command.tokenId || watchSlowly);
  const watch = useEnrollmentWatch(
    command,
    watching,
    watchSlowly ? 5000 : 2000,
  );
  const state =
    command && baseline
      ? progress(
          watch.events,
          watch.devices || devices.data,
          command.tokenId,
          baseline,
          trimmedName,
        )
      : null;
  // A device whose agent nothing keeps running checked in only from setup;
  // keep watching (more slowly) for the check-in that shows it runs.
  const kept =
    state?.checkedIn && state.device
      ? supervision(
          state.device,
          firstCheckIn || state.device.last_seen || null,
        )
      : null;
  useEffect(() => setWatchSlowly(kept === "unsupervised"), [kept]);
  const reloadTokens = tokens.reload;
  useEffect(() => {
    // The token did its job once the device checked in: drop the in-page copy.
    if (!command || !state?.checkedIn || finished === command.tokenId) return;
    setFinished(command.tokenId);
    setFirstCheckIn(state.device?.last_seen || null);
    tokenFlow.current?.finish();
    void reloadTokens();
  }, [command, state?.checkedIn, state?.device, finished, reloadTokens]);

  async function createCommand() {
    setError("");
    if (!ready) {
      setError(
        !mode
          ? "Choose Restricted or Full Vector first."
          : "Check the highlighted settings under Advanced.",
      );
      return;
    }
    const stamp = new Date().toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const record = await tokenFlow.current?.create(
      {
        name: trimmedName
          ? `${trimmedName} install command`
          : `Install command, ${stamp}`,
        expires_hours: hours,
        max_uses: maxUses ? Number(maxUses) : null,
        name_prefix: prefix || null,
        // The token enrolls only the typed name, so a copied command can't
        // enroll a host under another one (servers before this ignore it).
        // A list of preapproved names is the scope instead when one is given.
        ...(trimmedName && !preapproved.value
          ? { device_name: trimmedName.toLowerCase() }
          : {}),
        ...(preapproved.value ? { allowed_names: preapproved.value } : {}),
        ...(labels.value ? { labels: labels.value } : {}),
      },
      { inline: true },
    );
    if (record) {
      setShown(false);
      setFocusCommand(true);
      // Only a block created now takes focus, never one shown later.
      window.setTimeout(commandFocused, 0);
      setCommand({
        tokenId: record.id,
        since: record.created_at,
        expiresAt: record.expires_at,
        maxUses: record.max_uses ?? null,
      });
    }
  }
  /** Best effort: a revoked unused token can't enroll anything later. */
  async function revokeTokens(ids: string[]) {
    let revoked = 0;
    for (const id of ids)
      try {
        await api(`/tokens/${encodeURIComponent(id)}/revoke`, {
          method: "POST",
          body: "{}",
        });
        revoked += 1;
      } catch {
        // Left in the token list, where it can be revoked by hand.
      }
    void tokens.reload();
    return revoked;
  }
  function addAnother() {
    // A command whose token enrolled nothing is done with: don't leave its
    // token working until it expires.
    if (command && !state?.enrolled && !state?.device && operate)
      void revokeTokens([command.tokenId]);
    setCommand(null);
    setFinished(null);
    setFirstCheckIn(null);
    setShown(false);
    setName("");
    setBaseline(null);
    void devices.reload();
    void tokens.reload();
  }
  /** Revoke the displayed command's token, then offer a fresh command. */
  async function confirmStartOver() {
    setRestarting(true);
    setStartOverError("");
    try {
      await tokenFlow.current?.startOver();
      setStartingOver(false);
      setCommand(null);
      setFinished(null);
      setFirstCheckIn(null);
      setShown(false);
      setBaseline(null);
      void devices.reload();
      notify("The command's token is revoked. Create a new command.", {
        tone: "success",
      });
    } catch (failure) {
      setStartOverError((failure as Error).message);
    } finally {
      setRestarting(false);
    }
  }
  async function createFleetToken(event: React.FormEvent) {
    event.preventDefault();
    const record = await tokenFlow.current?.create({
      name: fleet.name.trim() || "Fleet enrollment",
      expires_hours: fleet.hours,
      max_uses: fleet.limit ? Number(fleet.limit) : null,
      name_prefix: fleet.prefix || null,
    });
    if (record) setTokenOpen(false);
  }

  const operate = can(user, "operate");
  const winRelease = install ? releaseFor(install, "windows", "amd64") : null;
  const installCommand =
    install && os !== "windows" ? installerCommand(install, choices) : null;
  const manualCommand = install ? setupCommand(install, choices) : null;
  const windows =
    install && winRelease ? windowsCommand(install, choices, winRelease) : null;
  const platformBuilds = install
    ? install.releases.filter((release) => release.os === os)
    : [];
  const osLabel = platforms.find((item) => item.value === os)!.label;
  // A pinned download needs the CA certificate itself (servers before it
  // offered only the fingerprint): never fall back to an unchecked download.
  const noVerifiedDownload =
    trustChoice === "pinned" && !install?.certificate?.ca_pem;
  // Without a build to download, never issue an installer that would fail on
  // the host: issue the setup command for an agent copied there instead.
  const noDownload =
    !!install &&
    (!install.downloads_enabled ||
      platformBuilds.length === 0 ||
      (os === "windows"
        ? !winRelease
        : !install.installer || noVerifiedDownload));
  // How to start an agent nothing keeps running: where this page's command
  // put it (the installer's directory, or on PATH next to a copied agent).
  const agentRun = install
    ? runCommand(install, choices, !!installCommand && !noDownload)
    : "";
  const unsupervised =
    state?.device && agentRun
      ? unsupervisedLine(
          state.device.name,
          agentRun,
          os,
          choices.service === "none",
        )
      : null;
  // Saved requests whose command was shown and whose token nobody used fold
  // into the "wasn't used" line; the token flow drops the finished ones.
  const tokenList =
    tokens.error || tokens.updatedAt === null ? null : tokens.data;
  const reminded = new Set(
    resolveTokenRequests(savedRequests, tokenList).flatMap((resolution) =>
      resolution.kind === "unused" ? [resolution.token.id] : [],
    ),
  );
  const unusedTokens = tokens.data.filter(
    (token) =>
      tokenStatus(token) === "Available" &&
      token.uses === 0 &&
      (reminded.has(token.id) ||
        (token.created_by?.id === user.id &&
          /install command/i.test(token.name))) &&
      token.id !== command?.tokenId,
  );
  const parsedHistory = EnrollmentActivitySchema.safeParse(history.data);
  // The day's history polls rarely; the live watch adds what happens on this
  // page, so the list and its count move as a device enrolls.
  const recentAttempts = mergeAttempts(
    parsedHistory.success ? parsedHistory.data.events : [],
    watch.events,
  );
  const commandExpired =
    !!commandToken &&
    (commandToken.revoked || Date.parse(commandToken.expires_at) < Date.now());
  const visibleTokens = showInactive
    ? tokens.data
    : tokens.data.filter((token) => tokenStatus(token) === "Available");
  const activeCount = tokens.data.filter(
    (token) => tokenStatus(token) === "Available",
  ).length;
  const problem = install?.certificate?.problem;

  return (
    <div className="control-page enroll-page">
      <PageHeader
        title="Add device"
        help={{ topic: "installation", section: "install-and-enroll" }}
        description="Connect a host that runs Vector 0.58. One command installs the agent, enrolls it and starts it. Any Vector already running on the host is left alone."
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
          tokens={tokenList}
          onChange={() => void tokens.reload()}
          onState={(waiting, isBlocked) => {
            setBusy(waiting);
            setBlocked(isBlocked);
          }}
          onReady={setSecret}
          onSettled={(note) =>
            setNotes((previous) =>
              previous.includes(note) ? previous : [...previous, note],
            )
          }
        />
        {(details.error || (parsed && !parsed.success)) && (
          <ErrorBox
            message={
              details.error ||
              "The server's install details are incomplete. Refresh, or ask an administrator to check the server version."
            }
            retry={details.reload}
          />
        )}
        {(tokens.error || devices.error) && (
          <ErrorBox
            message={tokens.error || devices.error}
            retry={() => {
              void tokens.reload();
              void devices.reload();
            }}
          />
        )}

        <section
          className="control-card enroll-step"
          aria-labelledby="enroll-host"
        >
          <h2 id="enroll-host">1. Choose the host</h2>
          <fieldset className="enroll-os" disabled={busy}>
            <legend className="sr-only">Host operating system</legend>
            {platforms.map(({ value, label, icon }) => (
              <label key={value} className="enroll-os-option">
                <input
                  type="radio"
                  name="enroll-os"
                  value={value}
                  checked={os === value}
                  onChange={() => setOs(value)}
                />
                <TabLabel icon={icon}>{label}</TabLabel>
              </label>
            ))}
          </fieldset>
          <ModeCards value={mode} onChange={setMode} disabled={busy} />
          <details className="enroll-advanced">
            <summary>
              Advanced
              <span className="control-muted">
                {" "}
                · device name, server certificate, Vector binary, token limits,
                service account, paths
              </span>
            </summary>
            <fieldset disabled={busy} className="enroll-advanced-fields">
              <Field
                label="Device name"
                hint={
                  !nameValid
                    ? "Use up to 100 letters, numbers, dots, hyphens or underscores, starting with a letter or number."
                    : "Leave empty to use the host's own name."
                }
              >
                <input
                  value={name}
                  maxLength={100}
                  aria-invalid={!nameValid}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="The host's name"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              {existing && (
                <div className="control-note" role="status">
                  <p>
                    {existing.status === "revoked"
                      ? `${existing.name} was revoked. A new command can't reuse its identity; `
                      : `A device named ${existing.name} already exists. Use another name, or `}
                    {can(user, "admin")
                      ? "authorize recovery from its device page to replace it."
                      : "ask an administrator to authorize recovery from its device page."}
                  </p>
                  <Button
                    variant="secondary compact"
                    onClick={() => navigate(`devices/${existing.id}`)}
                  >
                    Open existing device
                  </Button>
                </div>
              )}
              {install?.agent_url && (
                <TrustChoices
                  install={install}
                  os={os}
                  value={trust}
                  onChange={setTrust}
                  caFile={caFile}
                  onCaFile={setCaFile}
                  caFileProblem={caFile.trim() ? caFileProblem : ""}
                />
              )}
              {os !== "windows" ? (
                <div className="enroll-service">
                  <label className="enroll-check">
                    <input
                      type="checkbox"
                      checked={service === "auto"}
                      onChange={(event) =>
                        setService(event.target.checked ? "auto" : "none")
                      }
                    />
                    Run the agent as a {os === "darwin" ? "launchd" : "systemd"}{" "}
                    service
                  </label>
                  {service === "auto" && (
                    <div className="control-two-col">
                      <Field
                        label="Service account"
                        hint={
                          accountValid
                            ? "The service runs as this account. It needs to read the files Vector uses."
                            : "Use an existing or new unprivileged account name, not root."
                        }
                      >
                        <input
                          value={serviceUser}
                          aria-invalid={!accountValid}
                          onChange={(event) =>
                            setServiceUser(event.target.value)
                          }
                          placeholder={defaults.serviceUser}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </Field>
                      <label className="enroll-check enroll-check-field">
                        <input
                          type="checkbox"
                          checked={createUser}
                          onChange={(event) =>
                            setCreateUser(event.target.checked)
                          }
                        />
                        Create the account if it&apos;s missing (no login shell)
                      </label>
                    </div>
                  )}
                </div>
              ) : (
                <label className="enroll-check">
                  <input
                    type="checkbox"
                    checked={service === "auto"}
                    onChange={(event) =>
                      setService(event.target.checked ? "auto" : "none")
                    }
                  />
                  Run the agent as a Windows service (NT SERVICE\Vectory)
                </label>
              )}
              <div className="control-two-col">
                <Field
                  label="Agent state directory"
                  hint={
                    pathProblem(stateDir) ||
                    "The agent's identity and state. Keep it private."
                  }
                >
                  <input
                    value={stateDir}
                    aria-invalid={!!pathProblem(stateDir)}
                    onChange={(event) => setStateDir(event.target.value)}
                    placeholder={defaults.stateDir}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field
                  label="Managed configuration file"
                  hint={
                    pathProblem(managedConfig, true)
                      ? `${pathProblem(managedConfig, true)} It must end in .json.`
                      : "The one Vector configuration the agent manages, in its own directory."
                  }
                >
                  <input
                    value={managedConfig}
                    aria-invalid={!!pathProblem(managedConfig, true)}
                    onChange={(event) => setManagedConfig(event.target.value)}
                    placeholder={defaults.managedConfig}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              </div>
              {mode === "restricted" && (
                <Field
                  label="Restricted-mode allowances file on the host (optional)"
                  hint={
                    pathProblem(capabilityPolicy, true) ||
                    "A JSON file listing the files, destinations and listeners this host approves. The dashboard can't grant them."
                  }
                >
                  <input
                    value={capabilityPolicy}
                    aria-invalid={!!pathProblem(capabilityPolicy, true)}
                    onChange={(event) =>
                      setCapabilityPolicy(event.target.value)
                    }
                    placeholder={
                      os === "windows"
                        ? "C:\\ProgramData\\Vectory\\allowances.json"
                        : "/etc/vectory/allowances.json"
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              )}
              <div className={os === "windows" ? undefined : "control-two-col"}>
                <Field
                  label="Vector binary (optional)"
                  hint={
                    pathProblem(vectorBinary) ||
                    "Set this if Vector isn't on PATH, for example a downloaded archive."
                  }
                >
                  <input
                    value={vectorBinary}
                    aria-invalid={!!pathProblem(vectorBinary)}
                    onChange={(event) => setVectorBinary(event.target.value)}
                    placeholder="Found automatically on PATH"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                {os !== "windows" && (
                  <Field
                    label="Agent install directory"
                    hint={
                      installDirProblem ||
                      "Where the installer puts the vectory agent. A service runs it from there."
                    }
                  >
                    <input
                      value={installDir}
                      aria-invalid={!!installDirProblem}
                      onChange={(event) => setInstallDir(event.target.value)}
                      placeholder={
                        install?.default_install_dir || "/usr/local/bin"
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                )}
              </div>
              <div className="control-three-col">
                <Field
                  label="Token expires in (hours)"
                  hint={hoursValid ? undefined : "Use 1 to 720 hours."}
                >
                  <input
                    type="number"
                    min={1}
                    max={720}
                    value={hours}
                    aria-invalid={!hoursValid}
                    disabled={!!command}
                    onChange={(event) => setHours(Number(event.target.value))}
                  />
                </Field>
                <Field
                  label="Devices it can enroll"
                  hint={usesValid ? "Empty for no limit." : "Use 1 to 100000."}
                >
                  <input
                    type="number"
                    min={1}
                    max={100000}
                    value={maxUses}
                    aria-invalid={!usesValid}
                    disabled={!!command}
                    onChange={(event) => setMaxUses(event.target.value)}
                    placeholder="No limit"
                  />
                </Field>
                <Field
                  label="Only names starting with"
                  hint={
                    !prefixValid
                      ? "Lowercase letters, numbers and hyphens."
                      : !prefixMatches
                        ? "The device name must start with this."
                        : undefined
                  }
                >
                  <input
                    value={prefix}
                    maxLength={80}
                    aria-invalid={!prefixValid || !prefixMatches}
                    disabled={!!command}
                    onChange={(event) => setPrefix(event.target.value)}
                    placeholder="Any name"
                    autoComplete="off"
                  />
                </Field>
              </div>
              <div className="control-two-col">
                <Field
                  label="Only these device names (optional)"
                  hint={
                    preapproved.error ||
                    (!nameListed
                      ? "Add this device's name to the list."
                      : namesWarning ||
                        "One per line or separated by commas. Each name can enroll once.")
                  }
                >
                  <textarea
                    value={namesText}
                    rows={3}
                    aria-invalid={!!preapproved.error || !nameListed}
                    disabled={!!command}
                    onChange={(event) => setNamesText(event.target.value)}
                    placeholder={"edge-01\nedge-02"}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field
                  label="Labels for enrolled devices (optional)"
                  hint={
                    labels.error ||
                    "One key=value per line, up to 8. Labels describe a device; they don't add it to groups or deployments."
                  }
                >
                  <textarea
                    value={labelsText}
                    rows={3}
                    aria-invalid={!!labels.error}
                    disabled={!!command}
                    onChange={(event) => setLabelsText(event.target.value)}
                    placeholder={"site=berlin\nrack=a7"}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              </div>
            </fieldset>
          </details>
        </section>

        <section
          className="control-card enroll-step"
          aria-labelledby="enroll-run"
        >
          <h2 id="enroll-run">2. Run this on the host</h2>
          {details.loading && !install ? (
            <p className="control-muted" role="status">
              <Spinner /> Loading install details…
            </p>
          ) : !install ? null : !install.agent_url ? (
            <div className="control-note">
              The agent listener is off, so devices can&apos;t connect yet.
              Start the server with an agent TLS certificate and key
              (VECTORY_TLS_CERT and VECTORY_TLS_KEY).
            </div>
          ) : !command ? (
            <>
              {noDownload ? (
                <div className="control-note enroll-no-build" role="note">
                  <p>
                    <strong>
                      {!install.downloads_enabled
                        ? "Agent downloads are off on this server."
                        : noVerifiedDownload && platformBuilds.length > 0
                          ? "This server doesn't offer its CA certificate, so the installer download can't be checked against the pin."
                          : `This server has no ${osLabel} agent build yet.`}
                    </strong>{" "}
                    Copy the vectory agent to the host yourself; you&apos;ll get
                    the setup command to run next to it.{" "}
                    {install.downloads_enabled &&
                      !noVerifiedDownload &&
                      (can(user, "admin")
                        ? "To offer one here, add it to the release mirror."
                        : "An administrator can add one to the release mirror.")}{" "}
                    <DocLink topic="installation" section="install-and-enroll">
                      Installation guide
                    </DocLink>
                  </p>
                </div>
              ) : (
                <p className="control-muted">
                  {os === "windows"
                    ? "You'll download the agent, check its SHA-256 and run setup from an elevated PowerShell."
                    : "The command downloads the installer, checks it against the SHA-256 shown here and runs it with sudo. Setup then asks for the enrollment token on the terminal."}
                </p>
              )}
              {error && <ErrorBox message={error} />}
              <div className="enroll-actions">
                <Button
                  onClick={() => void createCommand()}
                  busy={busy}
                  disabled={!operate || blocked || !ready}
                >
                  {noDownload
                    ? "Create setup command"
                    : "Create install command"}
                </Button>
                {!ready && !busy && (
                  <span className="control-muted" role="status">
                    {!mode
                      ? "Choose Restricted or Full Vector first."
                      : devices.error
                        ? "The device list must load before a command is created."
                        : baseline === null
                          ? "Checking existing device names…"
                          : existing
                            ? "Choose another device name."
                            : trustChoice === "file" && !caFile.trim()
                              ? "Enter where the CA certificate is on the host, under Advanced."
                              : "Check the highlighted settings under Advanced."}
                  </span>
                )}
                {ready && blocked && !busy && operate && (
                  <span className="control-muted" role="status">
                    Check the saved token request at the top of the page first.
                  </span>
                )}
              </div>
              {operate && unusedTokens.length > 0 && (
                <p className="control-muted enroll-unused">
                  {unusedTokens.length === 1
                    ? "An install command you created earlier wasn't used. Its token still works until it expires."
                    : `${unusedTokens.length} install commands you created earlier weren't used. Their tokens still work until they expire.`}{" "}
                  <button
                    type="button"
                    className="enroll-text-button"
                    disabled={revokingUnused || busy}
                    onClick={async () => {
                      setRevokingUnused(true);
                      const count = await revokeTokens(
                        unusedTokens.map((token) => token.id),
                      );
                      setRevokingUnused(false);
                      notify(
                        count === unusedTokens.length
                          ? count === 1
                            ? "Unused token revoked."
                            : `${count} unused tokens revoked.`
                          : "Some tokens couldn't be revoked. Revoke them under Manage enrollment tokens.",
                        {
                          tone:
                            count === unusedTokens.length ? "success" : "error",
                        },
                      );
                    }}
                  >
                    {revokingUnused
                      ? "Revoking…"
                      : unusedTokens.length === 1
                        ? "Revoke it"
                        : "Revoke them"}
                  </button>
                </p>
              )}
            </>
          ) : !current ? (
            <div className="control-note">
              <p>
                {state?.checkedIn
                  ? "The device enrolled and checked in, so this page no longer keeps its token."
                  : "This page no longer holds the token for this command. If it may be exposed, revoke it under Manage enrollment tokens."}
              </p>
              {!state?.checkedIn && (
                <Button
                  variant="secondary compact"
                  disabled={blocked || busy}
                  onClick={addAnother}
                >
                  Start over
                </Button>
              )}
            </div>
          ) : (
            <>
              {os === "windows" ? (
                winRelease && windows ? (
                  <>
                    <p className="control-muted">
                      Download the agent, then run this from an elevated
                      PowerShell in the same folder.
                    </p>
                    <a
                      className="button secondary enroll-download"
                      href={winRelease.url}
                      download="vectory.exe"
                    >
                      <Download size={16} aria-hidden="true" />
                      Download vectory.exe ({winRelease.version},{" "}
                      {(winRelease.size / 1048576).toFixed(1)} MB)
                    </a>
                    <CommandBlock
                      command={windows}
                      label="Windows setup command"
                      focus={focusCommand}
                      onFocused={commandFocused}
                    />
                  </>
                ) : manualCommand ? (
                  <>
                    <p className="control-muted">
                      Copy vectory.exe to the host, then run this from an
                      elevated PowerShell in the same folder.
                    </p>
                    <CommandBlock
                      command={manualCommand}
                      label="Setup command"
                      focus={focusCommand}
                      onFocused={commandFocused}
                    />
                  </>
                ) : null
              ) : installCommand && !noDownload ? (
                <CommandBlock
                  command={installCommand}
                  label="Install command"
                  focus={focusCommand}
                  onFocused={commandFocused}
                />
              ) : manualCommand ? (
                <>
                  <p className="control-muted">
                    Copy the vectory agent to the host, then run this next to
                    it.
                  </p>
                  <CommandBlock
                    command={manualCommand}
                    label="Setup command"
                    focus={focusCommand}
                    onFocused={commandFocused}
                  />
                </>
              ) : null}
              <div className="enroll-secret">
                <span>Enrollment token</span>
                <code>
                  {shown ? (
                    current.token
                  ) : (
                    <>
                      <span aria-hidden="true">{"•".repeat(28)}</span>
                      <span className="sr-only">hidden</span>
                    </>
                  )}
                </code>
                <Button
                  variant="ghost compact"
                  icon={shown ? EyeOff : Eye}
                  onClick={() => setShown(!shown)}
                  aria-pressed={shown}
                >
                  {shown ? "Hide" : "Show"}
                </Button>
                <CopyButton
                  text={() => {
                    const flow = tokenFlow.current;
                    if (!flow)
                      throw Error("The token is no longer shown here.");
                    return flow.secret();
                  }}
                  label="Copy token"
                  failedMessage="Copy isn't available here. Show the token and select it to copy."
                />
                {operate && (
                  <Button
                    variant="ghost compact"
                    icon={RotateCcw}
                    disabled={busy}
                    onClick={() => {
                      setStartOverError("");
                      setStartingOver(true);
                    }}
                  >
                    Start over
                  </Button>
                )}
              </div>
              <p className="control-muted enroll-secret-hint">
                Paste it when setup asks. This page keeps it only until the
                device connects or you leave. Start over revokes it, so no
                device can use this command.
              </p>
              {problem && !install.certificate?.publicly_trusted && (
                <div className="control-note">{problem}</div>
              )}
              <SecurityReceipt
                install={install}
                os={os}
                agentSha256={winRelease?.sha256 || null}
                expiresAt={command.expiresAt}
                maxUses={command.maxUses}
                trust={trustChoice || "system"}
                caFile={caFile.trim()}
              />
            </>
          )}
          {install?.agent_url && manualCommand && (
            <details className="enroll-manual">
              <summary>I already have the agent</summary>
              <p className="control-muted">
                For hosts without access to this server&apos;s downloads, copy a
                verified build to the host, then run setup with the same server
                address and the same certificate check.
              </p>
              <CommandBlock command={manualCommand} label="Setup command" />
              {platformBuilds.length > 0 ? (
                <ul className="enroll-builds">
                  {platformBuilds.map((release) => (
                    <li key={release.name}>
                      <a
                        href={release.url}
                        download={
                          release.os === "windows" ? "vectory.exe" : "vectory"
                        }
                      >
                        {release.os}/{release.arch} {release.version}
                      </a>
                      <small>
                        {release.source === "mirror"
                          ? "Operator mirror"
                          : "Bundled with this server"}
                        {" · "}SHA-256 <code>{release.sha256}</code>
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="control-muted">
                  {can(user, "admin")
                    ? "This server has no agent builds for this platform. Build them with python3 packaging/build-release.py into the release mirror, or use an image with bundled agents."
                    : "Agent downloads aren't set up on this server. Ask an administrator."}
                </p>
              )}
              {can(user, "admin") && install.catalog_problems.length > 0 && (
                <ul className="enroll-problems">
                  {install.catalog_problems.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </section>

        <section
          className="control-card enroll-step"
          aria-labelledby="enroll-watch"
        >
          <h2 id="enroll-watch">3. Watch it connect</h2>
          {!command ? (
            <>
              {notes.length > 0 && (
                <ol className="enroll-timeline enroll-earlier">
                  {notes.map((note) => (
                    <li key={note} data-outcome="success">
                      <CheckCircle2 size={16} aria-hidden="true" />
                      <span>
                        <strong>{note}</strong>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="control-muted">
                {notes.length
                  ? "The next device shows up here as it enrolls and checks in."
                  : "The device shows up here as it enrolls and checks in."}
              </p>
            </>
          ) : (
            <div aria-live="polite">
              <ol className="enroll-timeline">
                {state?.events.map((event, index) =>
                  event.outcome === "failure" ? (
                    <li key={event.id || index} data-outcome="failure">
                      <XCircle size={16} aria-hidden="true" />
                      <span>
                        <strong>
                          Refused
                          {event.device_name
                            ? ` "${event.device_name}"`
                            : ""}: {refusal(event).title}.
                        </strong>
                        <small>
                          {[
                            clock(event.created_at),
                            event.client_address
                              ? `from ${event.client_address}`
                              : "",
                            describeAgent(event),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                        <small>{refusal(event).fix}</small>
                      </span>
                    </li>
                  ) : (
                    <li key={event.id || index} data-outcome="success">
                      <CheckCircle2 size={16} aria-hidden="true" />
                      <span>
                        <strong>
                          Enrolled as {event.device_name || "a new device"}
                          {event.configuration_mode
                            ? `, ${event.configuration_mode} mode`
                            : ""}
                        </strong>
                        <small>
                          {[
                            clock(event.created_at),
                            event.client_address
                              ? `from ${event.client_address}`
                              : "",
                            describeAgent(event),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </span>
                    </li>
                  ),
                )}
                {state?.device && !state.enrolled && (
                  <li data-outcome="success">
                    <CheckCircle2 size={16} aria-hidden="true" />
                    <span>
                      <strong>Enrolled as {state.device.name}</strong>
                    </span>
                  </li>
                )}
                {state?.checkedIn && state.device && (
                  <li data-outcome="success">
                    <CheckCircle2 size={16} aria-hidden="true" />
                    <span>
                      <strong>First check-in</strong>
                      <small>
                        {clock(firstCheckIn || state.device.last_seen)}
                      </small>
                    </span>
                  </li>
                )}
                {kept === "unsupervised" && unsupervised && (
                  <li data-outcome="warning">
                    <TriangleAlert size={16} aria-hidden="true" />
                    <span>
                      <strong>{unsupervised.title}</strong>
                      <small>
                        {unsupervised.before}
                        <code>{unsupervised.command}</code>
                        {unsupervised.after}
                      </small>
                    </span>
                  </li>
                )}
                {kept === "running" && state?.device && (
                  <li data-outcome="success">
                    <CheckCircle2 size={16} aria-hidden="true" />
                    <span>
                      <strong>Checked in again</strong>
                      <small>{clock(state.device.last_seen)}</small>
                    </span>
                  </li>
                )}
                {!state?.checkedIn && !state?.revoked && (
                  <li data-outcome="waiting">
                    <Spinner />
                    <span>
                      <strong>
                        {state?.device
                          ? `Waiting for ${state.device.name}'s first check-in…`
                          : "Waiting for the device to enroll…"}
                      </strong>
                      <small>
                        {commandExpired
                          ? "This command's token expired or was revoked. Create a new command."
                          : "Checking every 2 seconds."}
                      </small>
                    </span>
                  </li>
                )}
              </ol>
              {watch.error && <ErrorBox message={watch.error} />}
              {state?.device && state.revoked && (
                <div className="control-note">
                  <p>
                    {state.device.name}&apos;s access is revoked. Open the
                    device to review it;{" "}
                    {can(user, "admin")
                      ? "authorize recovery to replace its identity."
                      : "an administrator can authorize recovery."}
                  </p>
                  <Button
                    variant="secondary compact"
                    onClick={() => navigate(`devices/${state.device!.id}`)}
                  >
                    Open device
                  </Button>
                </div>
              )}
              {state?.checkedIn && state.device && kept === "unsupervised" && (
                <div className="enroll-success" data-tone="warning">
                  <h3>Start {state.device.name}&apos;s agent</h3>
                  <p>
                    Run this on the host and keep it running, for example from a
                    container&apos;s entrypoint or your process supervisor:
                  </p>
                  <CommandBlock command={agentRun} label="Run command" />
                  <p>
                    {state.device.name} shows as connected here when its agent
                    checks in again.
                  </p>
                  <div className="enroll-actions">
                    <Button
                      variant="secondary"
                      onClick={() => navigate(`devices/${state.device!.id}`)}
                    >
                      Open device
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={blocked || busy}
                      onClick={addAnother}
                    >
                      Add another device
                    </Button>
                  </div>
                </div>
              )}
              {state?.checkedIn && state.device && kept !== "unsupervised" && (
                <div className="enroll-success">
                  <h3>{state.device.name} is connected</h3>
                  <p>
                    No pipeline is assigned yet. Any Vector already running on
                    the host is left alone.
                    {kept === "running" &&
                      " No service manager runs its agent, so keep it under your own supervisor."}
                  </p>
                  {(state.device.configuration_mode || "restricted") !==
                    choices.mode && (
                    <ErrorBox
                      message={`The device reports ${state.device.configuration_mode === "full" ? "full" : "restricted"} mode, but this command chose ${choices.mode}. The mode is decided on the host; run setup there to change it.`}
                    />
                  )}
                  <div className="enroll-actions">
                    <Button
                      onClick={() =>
                        navigate(
                          `configurations?device=${encodeURIComponent(state.device!.id)}`,
                        )
                      }
                    >
                      Deploy a pipeline to {state.device.name}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => navigate(`devices/${state.device!.id}`)}
                    >
                      Open device
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={blocked || busy}
                      onClick={addAnother}
                    >
                      Add another device
                    </Button>
                  </div>
                </div>
              )}
              {!state?.checkedIn && (
                <p className="control-muted enroll-watch-help">
                  Devices only learn that enrollment was refused; the reasons
                  appear here and in{" "}
                  <DocLink
                    topic="troubleshooting"
                    section="an-enrollment-command-fails"
                  >
                    the troubleshooting guide
                  </DocLink>
                  .
                </p>
              )}
            </div>
          )}
        </section>

        {operate && (
          <RecentAttempts
            events={recentAttempts}
            loading={history.loading}
            error={history.error}
            // The live timeline shows a waiting command's attempts; once its
            // device checked in, they belong to the history again.
            currentTokenId={
              command && !state?.checkedIn ? command.tokenId : null
            }
          />
        )}

        <details className="enroll-token-management">
          <summary>Manage enrollment tokens ({activeCount} active)</summary>
          <div className="control-card">
            <div className="control-section-head">
              <div>
                <h3>Enrollment tokens</h3>
                <p>
                  Revoking a token stops new enrollments. Devices it already
                  enrolled stay connected.
                </p>
              </div>
              {operate && (
                <Button
                  variant="secondary"
                  disabled={busy || blocked}
                  onClick={() => setTokenOpen(true)}
                >
                  Create token
                </Button>
              )}
            </div>
            <label className="enroll-check enroll-inactive">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(event) => setShowInactive(event.target.checked)}
              />
              Show expired, used and revoked tokens
            </label>
            <DataTable
              data={tokens.error ? [] : visibleTokens}
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
                      <small>{scopeText(token)}</small>
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
                  id: "created",
                  header: "Created",
                  value: (token) => token.created_at || "",
                  sortValue: (token) => Date.parse(token.created_at || "") || 0,
                  cell: (token) => (
                    <>
                      <DateCell value={token.created_at} />
                      <small>
                        {token.created_by
                          ? `by ${token.created_by.name || "a removed account"}`
                          : ""}
                      </small>
                    </>
                  ),
                },
                {
                  id: "used",
                  header: "Last used",
                  value: (token) => token.last_used_at || "",
                  sortValue: (token) =>
                    Date.parse(token.last_used_at || "") || 0,
                  cell: (token) => <DateCell value={token.last_used_at} />,
                },
                {
                  id: "uses",
                  header: "Enrolled devices",
                  value: (token) => token.uses,
                  cell: (token) => (
                    <>
                      <span>
                        {token.uses}
                        {token.max_uses ? ` of ${token.max_uses}` : ""}
                      </span>
                      {!!token.devices?.length && (
                        <small className="enroll-token-devices">
                          {token.devices.slice(0, 3).map((device, index) => (
                            <span key={device.id}>
                              {index > 0 && ", "}
                              <button
                                type="button"
                                className="control-row-title"
                                onClick={() => navigate(`devices/${device.id}`)}
                              >
                                {device.name}
                              </button>
                              {device.revoked ? " (revoked)" : ""}
                            </span>
                          ))}
                          {(token.device_count || 0) > 3 &&
                            ` and ${(token.device_count || 0) - 3} more`}
                        </small>
                      )}
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
                    tokenStatus(token) === "Available" &&
                    operate && (
                      <Button
                        variant="secondary compact"
                        onClick={() => tokenFlow.current?.openRevoke(token)}
                      >
                        Revoke
                      </Button>
                    ),
                },
              ]}
              empty={
                tokens.error
                  ? "Enrollment tokens could not be loaded."
                  : visibleTokens.length || tokens.data.length
                    ? showInactive
                      ? "No tokens match these filters."
                      : "No active tokens. Show inactive tokens to see the rest."
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
        description="For automation that enrolls many devices. The token is shown once; keep it in a secret store, never in a command."
      >
        <form onSubmit={(event) => void createFleetToken(event)}>
          <fieldset className="modal-body" disabled={busy}>
            <Field label="Token name">
              <input
                value={fleet.name}
                onChange={(event) =>
                  setFleet({ ...fleet, name: event.target.value })
                }
                maxLength={120}
                placeholder="Fleet enrollment"
              />
            </Field>
            <div className="control-two-col">
              <Field label="Expires in (hours)">
                <input
                  type="number"
                  min={1}
                  max={720}
                  required
                  value={fleet.hours}
                  onChange={(event) =>
                    setFleet({ ...fleet, hours: Number(event.target.value) })
                  }
                />
              </Field>
              <Field label="Maximum uses" hint="Empty for no limit.">
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={fleet.limit}
                  onChange={(event) =>
                    setFleet({ ...fleet, limit: event.target.value })
                  }
                  placeholder="No limit"
                />
              </Field>
            </div>
            <Field
              label="Only names starting with (optional)"
              hint="Lowercase letters, numbers or hyphens, up to 80 characters."
            >
              <input
                value={fleet.prefix}
                onChange={(event) =>
                  setFleet({ ...fleet, prefix: event.target.value })
                }
                maxLength={80}
                pattern={"[a-z0-9\\-]*"}
                placeholder="For example, edge-"
              />
            </Field>
          </fieldset>
          <div className="modal-footer">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setTokenOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={blocked}>
              Create token
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={startingOver && !!current}
        onClose={() => !restarting && setStartingOver(false)}
        title="Start over?"
        description="Revokes this command's token, so no device can enroll with it."
      >
        <div className="modal-body">
          {startOverError && <ErrorBox message={startOverError} />}
          <p>
            {state?.device
              ? `${state.device.name} already enrolled with this command and stays connected. `
              : ""}
            You can create a new command right after. The revocation is recorded
            in the audit log.
          </p>
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            disabled={restarting}
            onClick={() => setStartingOver(false)}
          >
            Keep this command
          </Button>
          <Button
            variant="danger"
            busy={restarting}
            onClick={() => void confirmStartOver()}
          >
            Revoke and start over
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export default Enrollment;
