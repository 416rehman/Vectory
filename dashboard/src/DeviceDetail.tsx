import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  CircleHelp,
  CircleX,
  LoaderCircle,
  Pause,
  Play,
  Rocket,
  TriangleAlert,
  Unplug,
  WifiOff,
  X,
} from "lucide-react";
import {
  type AuditHistoryPage,
  type Configuration,
  type ConfigurationAttempt,
  type Device,
  type IssueHistoryPage,
  type Policy,
  type User,
  type Version,
} from "./api";
import { roleAllows } from "./roleAccess";
import DocLink from "./DocLink";
import ActivityGlyph from "./ActivityGlyph";
import AgentUpgrade from "./AgentUpgrade";
import TargetDialog from "./LazyTargetDialog";
import DeploymentPicker from "./DeploymentPicker";
import TelemetryPanel from "./TelemetryPanel";
import ComponentMetrics from "./ComponentMetrics";
import { agentRefusal, capabilityPhrase } from "./agentRefusals";
import { agentSettingsLine } from "./agentSettingsLine";
import DeviceSecrets from "./DeviceSecrets";
import EffectiveConfiguration from "./EffectiveConfiguration";
import DeviceRevocation from "./DeviceAccessRevocation";
import { DeviceIdentityRecovery, DeviceRetryAction } from "./RecoveryActions";
import {
  currentConfigurationAttempt,
  deviceApplicationExplanation,
} from "./deviceApplication";
import { deploymentRoute, isDeploymentId } from "./deploymentRouting";
import { auditRoute, defaultAuditQuery } from "./auditModel";
import {
  describeActivity,
  activityTone,
  type ActivityItem,
} from "./activityModel";
import { rememberRecent } from "./CommandPalette";
import {
  Button,
  Disclosure,
  EmptyState,
  InlineError,
  PageHeader,
  Skeleton,
  StatusBadge,
  TimeAgo,
  useMediaQuery,
  useResource,
} from "./ui";
import {
  connectionState,
  dataPlaneIssues,
  deviceDisplayStatus,
  statusLabel,
} from "./status";
import { exactLocal } from "./time";
import { runsDesired } from "./deviceModel";
import { reportsMetrics } from "./overviewModel";
import { pipelineRoute } from "./SelectedDevice";
import {
  applyStepTable,
  failedApplyStep,
  failureStagePhrase,
  pickupText,
  type ApplyStep,
} from "./deploymentStatus";
import "./devices.css";
import type { Notify } from "./toast";

type Navigate = (path: string) => void;
const platform = (device: Device) =>
  [device.os, device.arch].filter(Boolean).join(" / ") ||
  "Platform not reported";
const assignmentLink = (assignmentId?: string) =>
  typeof assignmentId === "string" && isDeploymentId(assignmentId)
    ? `#/${deploymentRoute(false, assignmentId, {
        search: "",
        status: "all",
        page: 1,
      })}`
    : null;

/* ---------- Apply progress ---------- */

// One table with the rollout page, so both blame the same step.
const steps = applyStepTable;
const applyStepIndex = (step: ApplyStep) =>
  steps.findIndex((entry) => entry.key === step);
type StepState = "done" | "current" | "failed" | "unknown" | "todo" | "paused";
export function applySteps(device: Device, version?: Version | null) {
  const attempt = currentConfigurationAttempt(device, version);
  const state =
    attempt?.state ??
    (device.reported_generation >= device.desired_generation
      ? device.apply_state
      : "desired");
  let reached = steps.findIndex((step) => step.state === state);
  let failedAt = -1;
  let outcome: StepState | null = null;
  if (state === "verified_applied" || device.status === "verified") {
    reached = steps.length - 1;
    outcome = "done";
  } else if (state === "failed" || state === "rolled_back") {
    const step = failedApplyStep(attempt?.error?.stage);
    failedAt = applyStepIndex(
      step ?? (state === "rolled_back" ? "reloaded" : "validated"),
    );
    reached = failedAt;
  } else if (state === "verification_unknown") {
    reached = steps.length - 1;
    outcome = "unknown";
  } else if (state === "paused" || device.sync_paused || device.local_paused) {
    reached = Math.max(0, reached);
    outcome = "paused";
  }
  if (reached < 0) reached = 0;
  return steps.map((step, index): { label: string; state: StepState } => {
    if (failedAt === index) return { label: step.label, state: "failed" };
    if (index < reached) return { label: step.label, state: "done" };
    if (index === reached)
      return {
        label: step.label,
        state:
          outcome === "done"
            ? "done"
            : outcome === "unknown"
              ? "unknown"
              : outcome === "paused"
                ? "paused"
                : "current",
      };
    return { label: step.label, state: "todo" };
  });
}
function ApplyProgress({
  device,
  version,
}: {
  device: Device;
  version: Version | null;
}) {
  const list = applySteps(device, version);
  const current = list.find((step) => step.state !== "done") ?? list.at(-1)!;
  return (
    <div className="device-apply-progress">
      <p className="device-apply-progress-title">
        Apply progress
        <span className="sr-only">
          : {current.label}{" "}
          {current.state === "done" ? "complete" : current.state}
        </span>
      </p>
      <ol>
        {list.map((step) => (
          <li key={step.label} data-state={step.state}>
            <span className="device-apply-step-marker" aria-hidden="true">
              {step.state === "done" ? (
                <Check size={11} strokeWidth={3} />
              ) : step.state === "failed" ? (
                <X size={11} strokeWidth={3} />
              ) : step.state === "unknown" ? (
                <CircleHelp size={12} />
              ) : step.state === "paused" ? (
                <Pause size={10} />
              ) : step.state === "current" ? (
                <LoaderCircle size={11} className="spin" />
              ) : null}
            </span>
            <span className="device-apply-step-label">
              {step.label}
              <span className="sr-only">
                {" "}
                (
                {step.state === "todo"
                  ? "not reached"
                  : step.state === "current"
                    ? "in progress"
                    : step.state}
                )
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------- Running vs desired ---------- */

/**
 * The last verified managed version, named with its pipeline when that
 * differs from the desired one. Null when the device runs no managed version.
 */
export function runningVersionText(device: Device) {
  const running = device.running_version;
  if (!running) return null;
  const number = running.number ? `v${running.number}` : "a managed version";
  const samePipeline =
    !!running.configuration_id &&
    running.configuration_id === device.desired_version?.configuration_id;
  return samePipeline || !running.configuration_name
    ? number
    : `${running.configuration_name} ${number}`;
}
/**
 * A local configuration the agent adopted at setup: the digest it reports
 * when no managed version ever ran. Only Vector's reported state says
 * whether it runs; older agents don't report it.
 */
function adoptedConfiguration(device: Device, untilDeploy: boolean) {
  const sha = device.actual_sha256 || "";
  const adopted = `A local configuration adopted at setup (SHA-256 ${sha.slice(0, 8)}…)`;
  if (device.vector_running === false)
    return `${adopted} is in place, but Vector isn't running`;
  const verb = device.vector_running ? "keeps running" : "stays in place";
  return untilDeploy
    ? `${adopted} ${verb} until you deploy`
    : `${adopted} ${verb}`;
}
/** What runs on a device that has no pipeline assigned. */
export function unmanagedRunningText(device: Device) {
  return device.actual_sha256
    ? `${adoptedConfiguration(device, true)}.`
    : "Nothing yet. Vector starts when you deploy a pipeline.";
}
/**
 * What runs after the assigned version failed, when no managed version was
 * ever verified here: nothing (a first version that couldn't start stops
 * Vector, and an agent that withdrew it reports no digest), or the local
 * configuration adopted at setup.
 */
export function failedRunningText(
  device: Device,
  v: string,
): { text: string; note: string | null } {
  if (device.configuration_attempt?.error?.code === "ROLLBACK_UNAVAILABLE")
    return {
      text: `Nothing running: Vector stopped after ${v} failed to start.`,
      note: null,
    };
  const note =
    device.status === "rolled_back"
      ? `${v} was rolled back`
      : `${v} failed to apply`;
  // Older agents keep reporting the failed version's own digest.
  const adopted =
    !!device.actual_sha256 &&
    device.actual_sha256 !== device.desired_sha256 &&
    device.actual_sha256 !== device.configuration_attempt?.sha256;
  return {
    text: adopted ? adoptedConfiguration(device, false) : "Nothing running yet",
    note,
  };
}
/**
 * While a released version waits for the agent (no attempt for this
 * generation yet) and the agent holds a wait open, it arrives within
 * seconds: say so. Null otherwise, and the application explanation stands.
 */
export function pickupExplanation(device: Device, version?: Version | null) {
  const waiting =
    device.status === "applying" &&
    device.reported_generation < device.desired_generation &&
    !currentConfigurationAttempt(device, version);
  return waiting && device.wake?.listening
    ? `${pickupText(device)} Its last applied configuration is tracked separately.`
    : null;
}
function RunningLine({ device, number }: { device: Device; number?: number }) {
  const v = number ? `v${number}` : "the assigned version";
  const attempt = device.configuration_attempt;
  const running = runningVersionText(device);
  if (device.status === "revoked")
    return (
      <span className="device-muted">
        {/* What the agent last verified is known; what runs now isn't. */}
        {running
          ? `Revoked · last verified running ${running}`
          : "Unknown. Device access is revoked."}
      </span>
    );
  if (!device.desired_version_id)
    return <span className="device-muted">{unmanagedRunningText(device)}</span>;
  if (device.status === "verified")
    return (
      <span className="device-running-value" data-tone="success">
        <Check size={14} aria-hidden="true" />
        {v}, verified running by the agent
      </span>
    );
  if (runsDesired(device))
    return (
      <span className="device-running-value">
        <Check size={14} aria-hidden="true" />
        <span>
          {v} at the last report
          {device.last_seen && (
            <>
              {" "}
              (<TimeAgo value={device.last_seen} />)
            </>
          )}
        </span>
      </span>
    );
  if (device.status === "failed" || device.status === "rolled_back") {
    const after =
      device.status === "rolled_back"
        ? `restored after ${v} failed`
        : `kept after ${v} failed to apply`;
    if (running)
      return (
        <span className="device-running-value" data-tone="success">
          <Check size={14} aria-hidden="true" />
          {running}
          <span className="device-muted">· {after}</span>
        </span>
      );
    const { text, note } = failedRunningText(device, v);
    return (
      <span className="device-running-value">
        <CircleX size={14} aria-hidden="true" />
        {text}
        {note && <span className="device-muted">· {note}</span>}
      </span>
    );
  }
  if (device.status === "verification_unknown")
    return (
      <span className="device-running-value" data-tone="warning">
        <CircleHelp size={14} aria-hidden="true" />
        {v} was written, but Vector wasn't confirmed running
      </span>
    );
  if (device.sync_paused || device.local_paused || device.status === "paused")
    return (
      <span className="device-running-value">
        <Pause size={14} aria-hidden="true" />
        Unchanged while sync is paused
      </span>
    );
  if (device.status === "offline")
    return (
      <span className="device-running-value" data-tone="warning">
        <WifiOff size={14} aria-hidden="true" />
        Unknown while the device is offline
      </span>
    );
  return (
    <span className="device-running-value" data-tone="info">
      <LoaderCircle size={14} className="spin" aria-hidden="true" />
      {running ? running : "Its previous configuration"} while {v} is{" "}
      {attempt && attempt.version_id === device.desired_version_id
        ? statusLabel("apply", attempt.state).toLowerCase()
        : "on its way"}
    </span>
  );
}
/**
 * Why a failure happened, in the headline's words. A refusal the agent decides
 * itself, before Vector sees the version, names its own cause (an api block,
 * a component ID that names a path); any other capability refusal is the
 * host's policy, which depends on the host's mode. Anything else is the
 * apply step that failed.
 */
export function failurePhrase(device: Device, attempt: ConfigurationAttempt) {
  const error = attempt.error;
  if (!error) return "";
  if (error.code !== "CAPABILITY_DENIED")
    return failureStagePhrase(error.stage);
  return (
    agentRefusal(error.diagnostics)?.phrase ??
    capabilityPhrase(device.configuration_mode)
  );
}
function FailureDetails({
  device,
  version,
}: {
  device: Device;
  version: Version | null;
}) {
  const attempt = currentConfigurationAttempt(device, version);
  if (!attempt?.error || !["failed", "rolled_back"].includes(attempt.state))
    return null;
  const phrase = failurePhrase(device, attempt);
  const refusal =
    attempt.error.code === "CAPABILITY_DENIED"
      ? agentRefusal(attempt.error.diagnostics)
      : null;
  return (
    <div className="device-failure-details" role="note">
      <div className="device-failure-details-head">
        <CircleAlert size={15} aria-hidden="true" />
        <strong>
          {attempt.state === "rolled_back" ? "Rolled back" : "Apply failed"}
          {phrase ? ` ${phrase}` : ""}
        </strong>
        <small className="device-muted">
          Agent code <code>{attempt.error.code}</code>
          {refusal && (
            <>
              {" · finding "}
              <code>{refusal.code}</code>
            </>
          )}
        </small>
      </div>
      {/* The reason is explained from the code above; agent messages are
          never shown, even the server's substituted ones. */}
      <DocLink
        topic="troubleshooting"
        section="a-pipeline-is-rejected-or-rolled-back"
      >
        Troubleshoot a rejected pipeline
      </DocLink>
    </div>
  );
}

/* ---------- Delivery health (data-plane issues from telemetry) ---------- */

/**
 * Applied but not delivering: each open delivery problem the server found in
 * this device's telemetry, naming the component, with the measured reason and
 * the fix. Apply state stays "Applied"; this is the separate health signal.
 */
function DeliveryHealth({ device }: { device: Device }) {
  const issues = dataPlaneIssues(device);
  if (!issues.length) return null;
  const since = issues
    .map((issue) => issue.since)
    .filter((at): at is string => !!at)
    .sort()[0];
  return (
    <div
      className="device-banner device-delivery"
      data-tone="warning"
      role="note"
      aria-labelledby="device-delivery-title"
    >
      <Unplug size={16} aria-hidden="true" />
      <div>
        <strong id="device-delivery-title">Applied, but not delivering</strong>
        <ul className="device-delivery-list">
          {issues.map((issue) => (
            <li key={`${issue.code}:${issue.component_id || ""}`}>
              <span className="device-delivery-issue">{issue.title}</span>
              {issue.message && <p>{issue.message}</p>}
              {issue.hint && (
                <p className="device-delivery-fix">
                  <span>Fix</span> {issue.hint}
                </p>
              )}
            </li>
          ))}
        </ul>
        <p className="device-delivery-foot">
          {since && (
            <>
              Started <TimeAgo value={since} />.{" "}
            </>
          )}
          Clears by itself after three clean checks.{" "}
          <a href={`#/issues?device=${encodeURIComponent(device.id)}`}>
            Open issues
          </a>
          {" · "}
          <DocLink
            topic="troubleshooting"
            section="a-pipeline-applies-but-delivers-nothing"
          >
            Troubleshoot delivery
          </DocLink>
        </p>
      </div>
    </div>
  );
}

/**
 * Why "Applied" says nothing about delivery on this device, if it doesn't:
 * no fresh metrics sample, so only Vector's log could show a failing sink.
 * "none": the running pipeline has no exporter the agent reads (or the agent
 * doesn't say); "waiting": it has one and the first sample is due;
 * "disabled": agent settings turn metrics off. Null when measured, or when
 * the device isn't applied or already shows a delivery problem.
 */
export function deliveryMeasurement(
  device: Device,
  now = Date.now(),
): "none" | "waiting" | "disabled" | null {
  if (
    device.status !== "verified" ||
    dataPlaneIssues(device).length ||
    reportsMetrics(device, now)
  )
    return null;
  if (device.effective_policy?.telemetry_enabled === false) return "disabled";
  const source = device.host_runtime?.metrics_source;
  return source === "explicit" || source === "discovered" ? "waiting" : "none";
}
function DeliveryMeasurement({
  device,
  pipelineId,
}: {
  device: Device;
  pipelineId: string | null;
}) {
  const state = deliveryMeasurement(device);
  if (!state) return null;
  return (
    <p className="device-delivery-unmeasured">
      <CircleHelp size={14} aria-hidden="true" />
      <span>
        {state === "waiting" ? (
          "Delivery health: not measured yet. The first metrics sample arrives with the next check-in."
        ) : state === "disabled" ? (
          <>
            Delivery health: not measured. Metrics are turned off in{" "}
            <a href="#/policies">Agent settings</a>.
          </>
        ) : (
          <>
            Delivery health: not measured.{" "}
            {pipelineId ? (
              <a
                href={`#/${pipelineRoute(pipelineId, undefined, { panel: "tools" })}`}
              >
                Add monitoring
              </a>
            ) : (
              "Add monitoring to its pipeline."
            )}
          </>
        )}
      </span>
    </p>
  );
}

/* ---------- Vector log summary (reported by newer agents) ---------- */

type LogItem = {
  key: string;
  level: string;
  message: string;
  component: string | null;
  count: number | null;
  last: string | null;
};
function logItems(value: unknown): {
  items: LogItem[];
  reportedAt: string | null;
} {
  const raw = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const list = Array.isArray(raw.items)
    ? raw.items
    : Array.isArray(value)
      ? value
      : [];
  const items = list.slice(0, 20).flatMap((entry, index): LogItem[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.message !== "string" || !item.message) return [];
    return [
      {
        key:
          typeof item.fingerprint === "string"
            ? item.fingerprint
            : String(index),
        level: typeof item.level === "string" ? item.level : "error",
        message: item.message.slice(0, 500),
        component:
          typeof item.component_id === "string" ? item.component_id : null,
        count:
          typeof item.count === "number" && Number.isSafeInteger(item.count)
            ? item.count
            : null,
        last: typeof item.last_seen === "string" ? item.last_seen : null,
      },
    ];
  });
  return {
    items,
    reportedAt: typeof raw.reported_at === "string" ? raw.reported_at : null,
  };
}
function VectorLogs({ device }: { device: Device }) {
  const { items, reportedAt } = logItems(
    (device as Device & { vector_log_summary?: unknown }).vector_log_summary,
  );
  if (!items.length) return null;
  return (
    <section className="device-card" aria-labelledby="device-logs-title">
      <div className="device-card-head">
        <div>
          <h2 id="device-logs-title">Recent Vector errors</h2>
          {reportedAt && (
            <p className="device-card-subtitle">
              Reported <TimeAgo value={reportedAt} />. Messages are redacted on
              the host.
            </p>
          )}
        </div>
      </div>
      <ul className="device-vector-logs">
        {items.map((item) => (
          <li key={item.key} data-level={item.level}>
            {item.level === "warn" || item.level === "warning" ? (
              <TriangleAlert size={14} aria-hidden="true" />
            ) : (
              <CircleX size={14} aria-hidden="true" />
            )}
            <div>
              <p>{item.message}</p>
              <small>
                {[
                  item.component && `Component ${item.component}`,
                  item.count &&
                    item.count > 1 &&
                    `${item.count.toLocaleString()} times`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {item.last && (
                  <>
                    {item.component || (item.count && item.count > 1)
                      ? " · last "
                      : "Last "}
                    <TimeAgo value={item.last} />
                  </>
                )}
              </small>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- Activity ---------- */

/** "APPLY_ROLLED_BACK" as "Apply rolled back", for servers without issue titles. */
function codeSentence(code: string) {
  const words = code.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function DeviceActivity({
  device,
  outage,
}: {
  device: Device;
  /** The device itself couldn't be refreshed; that error already shows. */
  outage: boolean;
}) {
  const id = device.id;
  const issues = useResource<IssueHistoryPage>(
    `/issues/history?state=open&device_id=${encodeURIComponent(id)}&page_size=5`,
    { items: [], total: 0, page: 1, page_size: 5 },
  );
  const audit = useResource<AuditHistoryPage>(
    `/audit/history?device_id=${encodeURIComponent(id)}&page_size=12`,
    { items: [], total: 0, page: 1, page_size: 12 },
  );
  const reports = issues.data.items;
  // Name this device in its own events; the history rows carry only its ID.
  const entries = (audit.data.items as unknown as ActivityItem[]).map(
    (entry) =>
      entry.device_id && entry.device_id.toLowerCase() === id.toLowerCase()
        ? { ...entry, device_names: [device.name] }
        : entry,
  );
  return (
    <section className="device-card" aria-labelledby="device-activity-title">
      <div className="device-card-head">
        <div>
          <h2 id="device-activity-title">Activity</h2>
          <p className="device-card-subtitle">
            Open issues and recent changes for this device
          </p>
        </div>
        <a
          className="device-card-link"
          href={`#/${auditRoute(null, { ...defaultAuditQuery, device_id: id })}`}
        >
          All device activity <ArrowRight size={14} aria-hidden="true" />
        </a>
      </div>
      {(issues.error || audit.error) && !outage && (
        <InlineError
          title="Couldn't load all device activity."
          error={issues.error || audit.error}
          retry={() => {
            void issues.reload();
            void audit.reload();
          }}
        />
      )}
      {issues.loading && !issues.updatedAt ? (
        <Skeleton width="60%" height={12} />
      ) : reports.length ? (
        <div className="device-issues">
          <p className="device-subheading">
            Open issues
            {issues.data.total > reports.length
              ? ` · latest ${reports.length} of ${issues.data.total}`
              : ""}
          </p>
          <ul>
            {reports.map((issue) => (
              <li key={issue.id}>
                <a href={`#/issues/${encodeURIComponent(issue.id)}`}>
                  {issue.title || codeSentence(issue.code)}
                </a>
                <p>{issue.message}</p>
                <small>
                  Last reported{" "}
                  {issue.last_seen ? (
                    <TimeAgo value={issue.last_seen} />
                  ) : (
                    "at an unavailable time"
                  )}
                  {issue.count > 1 ? ` · ${issue.count} reports` : ""}
                </small>
              </li>
            ))}
          </ul>
        </div>
      ) : issues.error ? null : (
        <p className="device-quiet">No open issues for this device.</p>
      )}
      <p className="device-subheading">Recent changes</p>
      {audit.loading && !audit.updatedAt ? (
        <div className="device-skeleton-lines" aria-hidden="true">
          <Skeleton width="80%" height={12} />
          <Skeleton width="65%" height={12} />
          <Skeleton width="72%" height={12} />
        </div>
      ) : entries.length ? (
        <ol className="device-activity-list">
          {entries.map((entry) => (
            <li key={entry.id} data-tone={activityTone(entry)}>
              <ActivityGlyph item={entry} />
              <p>
                {describeActivity(entry).map((part, index) =>
                  part.href ? (
                    <a key={index} href={part.href}>
                      {part.text}
                    </a>
                  ) : part.strong ? (
                    <strong key={index}>{part.text}</strong>
                  ) : (
                    <span key={index}>{part.text}</span>
                  ),
                )}
              </p>
              {entry.created_at ? (
                <a
                  className="device-activity-time"
                  href={`#/${auditRoute(entry.id, { ...defaultAuditQuery, device_id: id })}`}
                  title={`${exactLocal(entry.created_at)} · Open in the audit log`}
                >
                  <TimeAgo value={entry.created_at} />
                </a>
              ) : (
                <span className="device-activity-time">Time unavailable</span>
              )}
            </li>
          ))}
        </ol>
      ) : audit.error ? null : (
        <p className="device-quiet">
          No events have been recorded for this device identity.
        </p>
      )}
    </section>
  );
}

/* ---------- Page ---------- */

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function DeviceDetail({
  id,
  user,
  notify,
  navigate,
}: {
  id: string;
  user: User;
  notify: Notify;
  navigate: Navigate;
}) {
  // Poll faster while a version is applying; the pace follows the last read.
  // Each read is this one device with its group names, never the fleet.
  const [fast, setFast] = useState(false);
  const resource = useResource<Device | null>(
    `/devices/${encodeURIComponent(id)}?include=groups`,
    null,
    0,
    { interval: fast ? 5000 : 15000 },
  );
  const device = resource.data;
  const applying = device?.status === "applying";
  if (applying !== fast) setFast(applying);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  // Where the layout is two columns, the Components table has a full-width
  // card of its own below them; in one column it follows the charts.
  const wide = useMediaQuery("(min-width: 1100px)");
  const canReviewPolicy =
    roleAllows(user, "operate") && device?.status !== "revoked";
  useEffect(() => {
    if (!device || !canReviewPolicy) setPolicy(null);
  }, [device, canReviewPolicy]);
  const version = useResource<Version | null>(
    device?.desired_version_id
      ? `/versions/${device.desired_version_id}`
      : null,
    null,
  );
  const configuration = useResource<Configuration | null>(
    version.data?.configuration_id
      ? `/configurations/${version.data.configuration_id}`
      : null,
    null,
  );
  useEffect(() => {
    if (device?.id && device.name)
      rememberRecent(user.id, {
        key: `device:${device.id}`,
        kind: "device",
        title: device.name,
        href: `#/devices/${device.id}`,
      });
  }, [device?.id, device?.name, user.id]);
  const afterAction = (message: string) => {
    notify(message, { tone: "success" });
    void resource.reload();
  };
  const refresh = async () => {
    await resource.reload();
  };
  const pipelineAssignment = assignmentLink(device?.assignment?.id);
  const settingsAssignment = assignmentLink(device?.policy_assignment?.id);
  const settingsLine = device ? agentSettingsLine(device) : "";
  const breadcrumb = [{ label: "Devices", href: "#/devices" }];
  const live = {
    updatedAt: resource.updatedAt,
    error: resource.error,
    loading: resource.loading,
    refreshing: resource.refreshing,
    onRefresh: () => {
      void resource.reload();
      void version.reload();
      void configuration.reload();
    },
  };
  if (!device)
    return (
      <div className="device-page">
        <PageHeader
          title={resource.loading ? "Device" : "Device unavailable"}
          breadcrumb={breadcrumb}
          live={live}
          help={{
            topic: "troubleshooting",
            section: "a-device-page-shows-mismatched-details",
            label: "Help loading this device",
          }}
          description={
            resource.loading
              ? undefined
              : "Try again to load this device, or return to the device list."
          }
        />
        {resource.loading ? (
          <div className="device-layout" aria-busy="true">
            <div className="device-main">
              <div
                className="device-card device-card-skeleton"
                aria-hidden="true"
              >
                <Skeleton width={140} height={14} />
                <Skeleton width="70%" height={12} />
                <Skeleton width="55%" height={12} />
              </div>
            </div>
            <aside className="device-side">
              <div
                className="device-card device-card-skeleton"
                aria-hidden="true"
              >
                <Skeleton width={100} height={14} />
                <Skeleton width="80%" height={12} />
              </div>
            </aside>
          </div>
        ) : (
          // No stale device to keep, so the failure itself is the alert.
          <div role="alert">
            <EmptyState
              variant="error"
              title="This device couldn't be loaded"
              action={
                <Button
                  variant="secondary"
                  onClick={() => void resource.reload()}
                >
                  Try again
                </Button>
              }
              secondaryAction={
                <Button variant="ghost" onClick={() => navigate("devices")}>
                  Back to devices
                </Button>
              }
            >
              {resource.error || "The device may have been removed."}
            </EmptyState>
          </div>
        )}
      </div>
    );
  const display = deviceDisplayStatus(device);
  const connection = connectionState(device);
  const memberOf = device.groups?.items ?? [];
  const moreGroups = Math.max(0, (device.groups?.total ?? 0) - memberOf.length);
  const number =
    version.data?.number ?? device.desired_version?.number ?? undefined;
  const pipelineName =
    configuration.data?.name ||
    device.desired_version?.configuration_name ||
    null;
  const pipelineId =
    configuration.data?.id ||
    version.data?.configuration_id ||
    device.desired_version?.configuration_id ||
    null;
  const operate = roleAllows(user, "operate");
  const labels = Object.entries(device.labels || {});
  return (
    <div className="device-page">
      <PageHeader
        title={device.name}
        breadcrumb={breadcrumb}
        live={live}
        description={[
          platform(device),
          device.vector_version ? `Vector ${device.vector_version}` : null,
          device.agent_version ? `Agent ${device.agent_version}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        help={{
          topic: "telemetry",
          section: "investigate-a-change",
          label: "Help for this device",
        }}
        meta={
          <>
            <StatusBadge domain="device" value={display} />
            {resource.error ? (
              // A stale "Online" would claim a check-in nobody can see now.
              <span className="device-meta-note">Connection unknown</span>
            ) : (
              <StatusBadge
                domain="connection"
                value={connection}
                appearance="text"
                label={
                  connection === "online"
                    ? "Online"
                    : connection === "never"
                      ? "Never connected"
                      : connection === "revoked"
                        ? "Access revoked"
                        : "Offline"
                }
              />
            )}
            {device.last_seen && (
              <span className="device-meta-note">
                Last check-in <TimeAgo value={device.last_seen} />
              </span>
            )}
          </>
        }
      >
        {pipelineAssignment && (
          <a className="button secondary" href={pipelineAssignment}>
            Open rollout
          </a>
        )}
        {operate && device.status !== "revoked" && (
          <Button
            icon={Rocket}
            variant={device.desired_version_id ? "secondary" : ""}
            onClick={() => setDeployOpen(true)}
          >
            Deploy a pipeline
          </Button>
        )}
      </PageHeader>
      {resource.error && (
        <InlineError
          title={
            /fetch|network|timed out|deadline/i.test(resource.error)
              ? "Can't reach the Vectory server. Retrying."
              : "Couldn't refresh this device."
          }
          error={resource.error}
          updatedAt={resource.updatedAt}
          retry={() => void resource.reload()}
          retrying={resource.refreshing}
        />
      )}
      {(device.sync_paused || device.local_paused) && (
        <div className="device-banner" data-tone="neutral" role="note">
          <Pause size={16} aria-hidden="true" />
          <div>
            <strong>
              {device.local_paused
                ? "Sync paused on this host"
                : device.pause_acknowledged
                  ? "Sync paused by agent settings"
                  : "Waiting for the agent to confirm the pause"}
            </strong>
            <p>
              {device.local_paused ? (
                "A host operator paused sync locally. Remote changes can't remove this pause; run vectory resume on the host."
              ) : (
                <>
                  The current workload keeps running. New versions wait until
                  sync resumes.
                  {device.policy_assignment && settingsAssignment && (
                    <>
                      {" "}
                      The pause comes from a{" "}
                      <a href={settingsAssignment}>settings assignment</a> with
                      priority {device.policy_assignment.priority}.
                    </>
                  )}
                </>
              )}
            </p>
            {!device.local_paused &&
              device.sync_paused &&
              canReviewPolicy &&
              device.effective_policy && (
                <Button
                  variant="secondary compact"
                  icon={Play}
                  className="device-banner-action"
                  onClick={() =>
                    device.effective_policy &&
                    setPolicy({
                      ...device.effective_policy,
                      sync_paused: false,
                    })
                  }
                >
                  Resume sync
                </Button>
              )}
          </div>
        </div>
      )}
      {device.status === "offline" && (
        <div className="device-banner" data-tone="warning" role="note">
          <WifiOff size={16} aria-hidden="true" />
          <div>
            <strong>This device is offline</strong>
            <p>
              No check-in for three heartbeat intervals. What it runs now can't
              be confirmed.{" "}
              {device.service_manager === "none" && (
                <>
                  No service manager keeps its agent running, so start it again
                  on the host with <code>vectory run</code>, under your own
                  supervisor.{" "}
                </>
              )}
              <DocLink
                topic="troubleshooting"
                section="a-device-is-offline-or-never-connects"
              >
                Troubleshoot a device that is offline
              </DocLink>
            </p>
          </div>
        </div>
      )}
      <DeliveryHealth device={device} />
      <div className="device-layout">
        <div className="device-main">
          <section
            className="device-card device-pipeline"
            aria-labelledby="device-running-title"
          >
            <div className="device-card-head">
              <h2 id="device-running-title">Running vs desired</h2>
              {device.desired_version_id && (
                <StatusBadge domain="device" value={display} />
              )}
            </div>
            {(version.error || configuration.error) && !resource.error && (
              <InlineError
                title="Pipeline details couldn't be loaded."
                error={version.error || configuration.error}
                retry={() => {
                  void version.reload();
                  void configuration.reload();
                }}
              />
            )}
            <dl className="device-running-lines">
              <div>
                <dt>Desired</dt>
                <dd>
                  {device.desired_version_id ? (
                    <span className="device-running-value">
                      {pipelineId ? (
                        <a
                          href={`#/configurations/${encodeURIComponent(pipelineId)}`}
                        >
                          {pipelineName || "Assigned pipeline"}
                        </a>
                      ) : (
                        <span>
                          {pipelineName ||
                            (version.loading || configuration.loading
                              ? "Loading pipeline…"
                              : "Assigned pipeline")}
                        </span>
                      )}
                      {number !== undefined && (
                        <span className="device-running-version">
                          v{number}
                        </span>
                      )}
                      {(device.status === "failed" ||
                        device.status === "rolled_back") && (
                        <span className="device-running-flag">
                          <CircleX size={13} aria-hidden="true" />
                          {device.status === "rolled_back"
                            ? "Rolled back on this device"
                            : "Failed on this device"}
                        </span>
                      )}
                      {version.data?.created_at && (
                        <span className="device-muted">
                          published <TimeAgo value={version.data.created_at} />
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="device-muted">No pipeline assigned</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Running</dt>
                <dd>
                  <RunningLine device={device} number={number} />
                </dd>
              </div>
            </dl>
            {version.data?.message && (
              <p className="device-running-note">“{version.data.message}”</p>
            )}
            <DeliveryMeasurement device={device} pipelineId={pipelineId} />
            <p className="device-explanation">
              {device.desired_version_id
                ? (pickupExplanation(device, version.data) ??
                  deviceApplicationExplanation(device, version.data))
                : device.actual_sha256
                  ? "No published pipeline is assigned. The configuration adopted at setup stays in place until you deploy one."
                  : "No published pipeline is assigned. The agent checks in and waits; Vector starts with the first version you deploy."}
            </p>
            <FailureDetails device={device} version={version.data} />
            <DeviceRetryAction
              device={device}
              user={user}
              onDone={afterAction}
              onRefresh={refresh}
            />
            {device.desired_version_id && device.status !== "revoked" && (
              <ApplyProgress device={device} version={version.data} />
            )}
            <div className="device-card-actions">
              {pipelineAssignment && (
                <a className="device-card-link" href={pipelineAssignment}>
                  View pipeline assignment{" "}
                  <ArrowRight size={14} aria-hidden="true" />
                </a>
              )}
              {device.assignment && !pipelineAssignment && (
                <span className="device-muted">
                  Pipeline assignment link unavailable.
                </span>
              )}
            </div>
          </section>
          <DeviceSecrets
            device={device}
            version={version.data}
            loading={version.loading}
            failed={!!version.error}
          />
          <EffectiveConfiguration key={device.id} device={device} />
          {/* Vector's warnings and errors have their own card below. */}
          <TelemetryPanel device={device} logs={false} components={!wide} />
          <VectorLogs device={device} />
          <DeviceActivity device={device} outage={!!resource.error} />
        </div>
        <aside className="device-side">
          <section className="device-card" aria-labelledby="device-about-title">
            <div className="device-card-head">
              <h2 id="device-about-title">About this device</h2>
            </div>
            <dl className="device-facts">
              <Fact label="Platform">{platform(device)}</Fact>
              <Fact label="Vector">
                {device.vector_version || "Not reported"}
              </Fact>
              <Fact label="Agent">
                <span className="device-fact-stack">
                  {device.agent_version || "Not reported"}
                  <AgentUpgrade key={device.id} device={device} />
                </span>
              </Fact>
              <Fact label="Configuration">
                {device.configuration_mode === "full"
                  ? "Full Vector configuration"
                  : "Restricted components"}
              </Fact>
              <Fact label="Enrolled">
                {device.created_at ? (
                  <TimeAgo value={device.created_at} />
                ) : (
                  "Unknown"
                )}
              </Fact>
              <Fact label="Groups">
                {memberOf.length ? (
                  <span className="device-groups">
                    {memberOf.map((group) => (
                      <a
                        key={group.id}
                        className="device-group-chip"
                        href={`#/devices?group=${encodeURIComponent(group.id)}`}
                      >
                        {group.name}
                      </a>
                    ))}
                    {moreGroups > 0 && (
                      <span className="device-muted">
                        and {moreGroups.toLocaleString()} more
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="device-muted">
                    {device.groups ? "None" : "Not reported"}
                  </span>
                )}
              </Fact>
              {labels.length > 0 && (
                <Fact label="Labels">
                  <span className="device-groups">
                    {labels.map(([key, value]) => (
                      <span key={key} className="device-label-chip">
                        {key}: {value}
                      </span>
                    ))}
                  </span>
                </Fact>
              )}
            </dl>
          </section>
          <section
            className="device-card"
            aria-labelledby="device-agent-settings-heading"
          >
            <div className="device-card-head">
              <h2 id="device-agent-settings-heading">Agent settings</h2>
            </div>
            {settingsLine && (
              <p
                className="device-card-text"
                title={
                  device.policy_assignment?.created_at
                    ? exactLocal(device.policy_assignment.created_at)
                    : undefined
                }
              >
                {settingsLine}
              </p>
            )}
            {device.effective_policy ? (
              <dl className="control-summary-list">
                <div>
                  <dt>Metrics</dt>
                  <dd>
                    {device.effective_policy.telemetry_enabled
                      ? "Enabled"
                      : "Disabled"}
                  </dd>
                </div>
                <div>
                  <dt>Server sync policy</dt>
                  <dd>
                    {device.effective_policy.sync_paused ? "Paused" : "Enabled"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="device-card-text">
                Current agent settings have not been reported.
              </p>
            )}
            {settingsAssignment ? (
              <a className="device-card-link" href={settingsAssignment}>
                View settings assignment{" "}
                <ArrowRight size={14} aria-hidden="true" />
              </a>
            ) : device.policy_assignment ? (
              <p className="device-card-text">
                Settings assignment link unavailable.
              </p>
            ) : null}
          </section>
          {(operate || roleAllows(user, "admin")) && (
            <Disclosure
              summary="Sync, recovery and access"
              className="device-disclosure device-manage"
            >
              <div className="device-management">
                <h3>Configuration sync</h3>
                <p>
                  Pause incoming configuration changes while you work on this
                  host. Its check-in interval and metrics settings stay as they
                  are.
                </p>
                {operate && device.status !== "revoked" && (
                  <Button
                    variant="secondary"
                    disabled={!device.effective_policy}
                    onClick={() =>
                      device.effective_policy &&
                      setPolicy({
                        ...device.effective_policy,
                        sync_paused: !device.sync_paused,
                      })
                    }
                  >
                    {device.sync_paused
                      ? "Review resume policy…"
                      : "Review pause policy…"}
                  </Button>
                )}
                {!device.effective_policy && (
                  <p>
                    Refresh this device to load its current agent settings
                    before pausing or resuming sync.
                  </p>
                )}
                <DeviceIdentityRecovery
                  device={device}
                  user={user}
                  onDone={afterAction}
                  onRefresh={refresh}
                />
                <DeviceRevocation
                  key={`${user.id}:${user.role}:${device.id}`}
                  device={device}
                  user={user}
                  onRefresh={refresh}
                />
              </div>
            </Disclosure>
          )}
          <Disclosure summary="Technical details" className="device-disclosure">
            <dl className="device-technical">
              <div>
                <dt>Device ID</dt>
                <dd>{device.id}</dd>
              </div>
              <div>
                <dt>Last heartbeat</dt>
                <dd>
                  {device.last_seen ? exactLocal(device.last_seen) : "Never"}
                </dd>
              </div>
              <div>
                <dt>Desired generation</dt>
                <dd>{device.desired_generation}</dd>
              </div>
              <div>
                <dt>Last verified generation</dt>
                <dd>{device.reported_generation}</dd>
              </div>
              <div>
                <dt>Assignment progress</dt>
                <dd>{statusLabel("apply", device.apply_state)}</dd>
              </div>
              {device.reported_apply_state && (
                <div>
                  <dt>Reported workload state</dt>
                  <dd>{statusLabel("apply", device.reported_apply_state)}</dd>
                </div>
              )}
              <div>
                <dt>Current assignment attempt</dt>
                <dd>
                  {currentConfigurationAttempt(device, version.data)
                    ? `Generation ${device.configuration_attempt!.generation} · ${statusLabel("apply", device.configuration_attempt!.state)}`
                    : "Not reported"}
                </dd>
              </div>
              <div>
                <dt>Desired version ID</dt>
                <dd>{device.desired_version_id || "None"}</dd>
              </div>
              {device.desired_sha256 !== undefined && (
                <div>
                  <dt>Desired artifact SHA-256</dt>
                  <dd>{device.desired_sha256 || "None"}</dd>
                </div>
              )}
              <div>
                <dt>Actual file SHA-256</dt>
                <dd>{device.actual_sha256 || "Not reported"}</dd>
              </div>
              {device.uses_local_secrets && (
                <>
                  <div>
                    <dt>Applied template SHA-256</dt>
                    <dd>{device.applied_template_sha256 || "Not reported"}</dd>
                  </div>
                  <div>
                    <dt>Local secret attempt revision</dt>
                    <dd>{device.secret_revision ?? "Not reported"}</dd>
                  </div>
                </>
              )}
              {device.assignment && (
                <>
                  <div>
                    <dt>Assignment</dt>
                    <dd>{device.assignment.id}</dd>
                  </div>
                  <div>
                    <dt>Priority</dt>
                    <dd>{device.assignment.priority}</dd>
                  </div>
                  <div>
                    <dt>Selection reason</dt>
                    <dd>{device.assignment.reason}</dd>
                  </div>
                </>
              )}
              {device.policy_assignment && (
                <>
                  <div>
                    <dt>Settings assignment</dt>
                    <dd>{device.policy_assignment.id}</dd>
                  </div>
                  <div>
                    <dt>Settings priority</dt>
                    <dd>{device.policy_assignment.priority}</dd>
                  </div>
                  <div>
                    <dt>Settings selection reason</dt>
                    <dd>{device.policy_assignment.reason}</dd>
                  </div>
                </>
              )}
            </dl>
          </Disclosure>
        </aside>
      </div>
      {wide && (device.telemetry?.components?.length ?? 0) > 0 && (
        <div className="device-card device-components">
          <ComponentMetrics
            components={device.telemetry!.components!}
            sampledAt={device.telemetry!.sampled_at}
            level={2}
          />
        </div>
      )}
      {deployOpen && operate && (
        <DeploymentPicker
          user={user}
          scheduled={false}
          initialDeviceIds={[device.id]}
          deviceName={device.name}
          onClose={() => setDeployOpen(false)}
          onDone={afterAction}
        />
      )}
      {policy && canReviewPolicy && (
        <TargetDialog
          key={user.id}
          open
          userId={user.id}
          onClose={() => setPolicy(null)}
          policy={policy}
          preserveExistingSettings
          initialDeviceIds={[device.id]}
          initialDevices={[device]}
          onDone={afterAction}
        />
      )}
    </div>
  );
}
