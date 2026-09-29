import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ChartNoAxesCombined,
  Check,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CircleX,
  LoaderCircle,
  Pause,
  Plus,
  Rocket,
  Server,
  ShieldCheck,
  Unplug,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { api, APIError, type Audit, type Device, type User } from "./api";
import { roleAllows } from "./roleAccess";
import DocLink from "./DocLink";
import ActivityGlyph from "./ActivityGlyph";
import { runCommand } from "./commands";
import {
  Button,
  InlineError,
  PageHeader,
  Skeleton,
  StatusBadge,
  TimeAgo,
  Tooltip,
  useResource,
} from "./ui";
import {
  checklist,
  countLabel,
  deliveryUnmeasured,
  fleetTelemetry,
  formatRate,
  healthCounts,
  healthLabels,
  completeSeries,
  healthOrder,
  monitoringTarget,
  niceCeiling,
  present,
  quietSummary,
  rolloutProgress,
  unmanagedDetail,
  type ChecklistStep,
  type FleetDeviceRate,
  type HealthBucket,
  type RolloutProgress,
} from "./overviewModel";
import { pipelineRoute } from "./SelectedDevice";
import {
  activityTone,
  describeActivity,
  isSecurityAction,
  nameList,
  type ActivityItem,
  type Part,
} from "./activityModel";
import { connectionState } from "./status";
import { duration, exactLocal, shortLocal } from "./time";
import { StoppedRolloutItems, useStoppedRollouts } from "./StoppedRollouts";
import type { StoppedRollout } from "./stoppedRollouts";
import NotificationsHint from "./NotificationsHint";
import "./overview.css";

type Navigate = (path: string) => void;

export type AttentionGroup = {
  cause:
    | "failed"
    | "degraded"
    | "check_required"
    | "stuck"
    | "offline"
    | "paused"
    | "unmanaged";
  severity: "danger" | "warning" | "neutral";
  count: number;
  device_ids: string[];
  device_names: string[];
  version_id: string | null;
  version_number: number | null;
  configuration_id: string | null;
  configuration_name: string | null;
  state: string | null;
  since: string | null;
  reason: string | null;
  requested?: number;
  local?: number;
  /** Degraded groups: the leading delivery issue's title, code and fix. */
  title?: string | null;
  fix?: string | null;
  code?: string | null;
  component_id?: string | null;
};
export type RolloutSummary = {
  id: string;
  name: string | null;
  configuration_id: string | null;
  configuration_name: string | null;
  version_id: string | null;
  version_number: number | null;
  policy: boolean;
  status: string;
  scheduled_at: string | null;
  created_at: string;
  priority: number | null;
  rollout_kind: string | null;
  canary_size: number | null;
  batch_size: number | null;
  target_count: number;
  state_counts: Record<string, number>;
};
export type OverviewData = {
  devices_total: number;
  devices_online: number;
  configurations_total: number;
  deployments_active: number;
  issues_open: number;
  devices: Device[];
  recent_activity: Audit[];
  devices_managed?: number;
  devices_on_desired?: number;
  /** Applied devices with an open data-plane issue (newer servers). */
  devices_degraded?: number;
  versions_total?: number;
  rollouts?: RolloutSummary[];
  attention?: AttentionGroup[];
  fleet_activity?: ActivityItem[];
  security_events_hidden?: number;
};

/* ---------- Fleet telemetry summary (newer servers) ---------- */

type SummaryPoint = {
  at: string;
  devices: number | null;
  in: number | null;
  out: number | null;
};
type TelemetrySummary = {
  stepSeconds: number | null;
  devicesTotal: number;
  devicesReporting: number;
  metricsDisabled: number | null;
  withoutEndpoint: number | null;
  newest: string | null;
  eventsIn: number | null;
  eventsOut: number | null;
  errorsPerMinute: number | null;
  series: SummaryPoint[];
};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const metric = (value: unknown) =>
  present(value) && value >= 0 ? value : null;
/** Accept only the documented fields; anything malformed reads as missing. */
function parseSummary(value: unknown): TelemetrySummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const devicesTotal = count(raw.devices_total);
  const devicesReporting = count(raw.devices_reporting);
  if (devicesTotal === null || devicesReporting === null) return null;
  const series = Array.isArray(raw.series)
    ? raw.series.flatMap((point): SummaryPoint[] => {
        if (!point || typeof point !== "object") return [];
        const item = point as Record<string, unknown>;
        if (
          typeof item.at !== "string" ||
          !Number.isFinite(Date.parse(item.at))
        )
          return [];
        return [
          {
            at: item.at,
            devices: count(item.devices_reporting),
            in: metric(item.events_in_per_second),
            out: metric(item.events_out_per_second),
          },
        ];
      })
    : [];
  return {
    stepSeconds: count(raw.step_seconds),
    devicesTotal,
    devicesReporting,
    metricsDisabled: count(raw.devices_metrics_disabled),
    withoutEndpoint: count(raw.devices_without_metrics_endpoint),
    newest:
      typeof raw.newest_sample_at === "string" ? raw.newest_sample_at : null,
    eventsIn: metric(raw.events_in_per_second),
    eventsOut: metric(raw.events_out_per_second),
    errorsPerMinute: metric(raw.errors_per_minute),
    series: series.slice(-360),
  };
}
// Probe once per session: servers without the endpoint answer 404.
let summaryUnavailable = false;
function useTelemetrySummary(enabled: boolean, interval: number) {
  const [summary, setSummary] = useState<TelemetrySummary | null>(null);
  useEffect(() => {
    if (!enabled || summaryUnavailable) return;
    let stopped = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      try {
        const value = await api<unknown>("/telemetry/summary?range=1h", {
          signal: controller.signal,
        });
        if (!stopped) setSummary(parseSummary(value));
      } catch (error) {
        if (
          error instanceof APIError &&
          (error.status === 404 || error.status === 405)
        ) {
          summaryUnavailable = true;
          clearInterval(timer);
          if (!stopped) setSummary(null);
        }
        // Other failures keep the last summary; device samples still show.
      }
    };
    void load();
    const timer = setInterval(load, interval);
    return () => {
      stopped = true;
      controller?.abort();
      clearInterval(timer);
    };
  }, [enabled, interval]);
  return summaryUnavailable ? null : summary;
}

/* ---------- Page ---------- */

export function Overview({
  navigate,
  user,
}: {
  navigate: Navigate;
  user: User;
}) {
  const [interval, setPollInterval] = useState(15000);
  const overview = useResource<OverviewData | null>("/overview", null, 0, {
    interval,
  });
  const data = overview.data;
  const rollingOut = !!data?.rollouts?.some(
    (rollout) => rollout.status === "active",
  );
  // Follow an active rollout closely; otherwise refresh at the normal pace.
  useEffect(() => setPollInterval(rollingOut ? 5000 : 15000), [rollingOut]);
  const devices = data?.devices ?? [];
  const live = devices.filter((device) => device.status !== "revoked");
  const noDevices = !!data && live.length === 0;
  const releases = useResource<unknown[] | null>(
    noDevices ? "/releases" : null,
    null,
  );
  const summary = useTelemetrySummary(!!data && live.length > 0, interval);
  // Stopped and rolled-back rollouts leave "in progress" but still need you.
  const stopped = useStoppedRollouts(!!data && live.length > 0);
  const operate = roleAllows(user, "operate");
  const now = Date.now();
  const steps = data
    ? checklist({
        releases: noDevices
          ? releases.data
            ? releases.data.length
            : null
          : null,
        devices: live.length,
        checkedIn: live.filter((device) => !!device.last_seen).length,
        pipelines: data.configurations_total,
        versions: data.versions_total ?? (data.configurations_total ? 1 : 0),
        applied:
          data.devices_on_desired ??
          live.filter((device) => device.status === "verified").length,
      })
    : [];
  const showChecklist = steps.some((step) => !step.done);
  return (
    <div className="overview">
      <PageHeader
        title="Overview"
        description="Fleet health, rollouts and what needs you."
        help={{ topic: "getting-started", label: "Help for Overview" }}
        live={{
          updatedAt: overview.updatedAt,
          error: overview.error,
          loading: overview.loading,
          refreshing: overview.refreshing,
          onRefresh: () => void overview.reload(),
        }}
      >
        {operate && !noDevices && (
          <Button icon={Plus} onClick={() => navigate("enrollment")}>
            Add device
          </Button>
        )}
      </PageHeader>
      {overview.error && (
        <InlineError
          title={
            data
              ? "Couldn't refresh the overview."
              : "Couldn't load the overview."
          }
          error={overview.error}
          updatedAt={overview.updatedAt}
          retry={() => void overview.reload()}
          retrying={overview.refreshing}
        />
      )}
      {!data ? (
        !overview.error && <OverviewSkeleton />
      ) : (
        <>
          {showChecklist && (
            <Checklist
              steps={steps}
              user={user}
              navigate={navigate}
              data={data}
              live={live}
              releasesLoading={noDevices && releases.loading}
            />
          )}
          <KpiTiles data={data} live={live} stopped={stopped.length} />
          <div className="overview-grid">
            <div className="overview-column">
              <FleetHealth live={live} />
              <NeedsYou
                data={data}
                live={live}
                user={user}
                now={now}
                stopped={stopped}
              />
              <FleetThroughput live={live} summary={summary} now={now} />
            </div>
            <div className="overview-column">
              <Rollouts rollouts={data.rollouts} user={user} now={now} />
              <RecentChanges data={data} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Loading ---------- */

function OverviewSkeleton() {
  return (
    <div
      className="overview-loading"
      role="status"
      aria-label="Loading overview"
    >
      <div className="overview-kpis" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="overview-kpi-tile overview-kpi-tile-skeleton"
          >
            <Skeleton width={96} height={12} />
            <Skeleton width={72} height={26} />
            <Skeleton width="70%" height={12} />
          </div>
        ))}
      </div>
      <div className="overview-grid" aria-hidden="true">
        <div className="overview-column">
          <div className="overview-card overview-card-skeleton">
            <Skeleton width={120} height={14} />
            <Skeleton width="100%" height={12} radius={4} />
            <Skeleton width="60%" height={12} />
          </div>
          <div className="overview-card overview-card-skeleton">
            <Skeleton width={100} height={14} />
            <Skeleton width="85%" height={12} />
            <Skeleton width="70%" height={12} />
          </div>
        </div>
        <div className="overview-column">
          <div className="overview-card overview-card-skeleton">
            <Skeleton width={90} height={14} />
            <Skeleton width="90%" height={12} />
            <Skeleton width="75%" height={12} />
            <Skeleton width="80%" height={12} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Card chrome ---------- */

function Card({
  title,
  subtitle,
  action,
  className = "",
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      className={`overview-card ${className}`.trim()}
      aria-labelledby={id}
    >
      <div className="overview-card-head">
        <div className="overview-card-titles">
          <h2 id={id}>{title}</h2>
          {subtitle && <p className="overview-card-subtitle">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="overview-card-link" href={href}>
      {children}
      <ArrowRight size={14} aria-hidden="true" />
    </a>
  );
}

/* ---------- First-run checklist ---------- */

const stepTitles: Record<ChecklistStep["id"], string> = {
  downloads: "Make agent downloads available",
  device: "Connect your first device",
  pipeline: "Create a pipeline",
  publish: "Publish a version",
  deploy: "Deploy and verify",
};
function Checklist({
  steps,
  user,
  navigate,
  data,
  live,
  releasesLoading,
}: {
  steps: ChecklistStep[];
  user: User;
  navigate: Navigate;
  data: OverviewData;
  live: Device[];
  releasesLoading: boolean;
}) {
  const done = steps.filter((step) => step.done).length;
  const current = steps.find((step) => !step.done)?.id;
  const operate = roleAllows(user, "operate"),
    edit = roleAllows(user, "edit");
  const waiting = live.find((device) => !device.last_seen);
  const checkedIn = live.filter((device) => !!device.last_seen).length;
  const applied = data.devices_on_desired ?? 0;
  const copy: Record<ChecklistStep["id"], [string, string]> = {
    downloads: [
      "Agent packages are ready to download.",
      releasesLoading
        ? "Checking the release catalog…"
        : "Add verified agent release artifacts to the server's release directory so hosts can download the agent.",
    ],
    device: [
      `${countLabel(checkedIn, "device")} checked in.`,
      waiting
        ? `${waiting.name} is enrolled but hasn't checked in yet.`
        : "Install the agent on a host running Vector and enroll it with a one-time token.",
    ],
    pipeline: [
      `${countLabel(data.configurations_total, "pipeline")} saved.`,
      "Build sources, transforms and sinks on the canvas, or import an existing Vector config.",
    ],
    publish: [
      `${countLabel(data.versions_total ?? 0, "version")} published.`,
      "Publishing validates the pipeline and saves an immutable version.",
    ],
    deploy: [
      `${countLabel(applied, "device")} verified running an assigned version.`,
      "Deploy a version. A device counts once its agent confirms Vector is running it.",
    ],
  };
  function action(step: ChecklistStep["id"]) {
    const variant = step === current ? "" : "secondary";
    switch (step) {
      case "downloads":
        return (
          <DocLink
            topic="administer"
            section="start-a-new-server"
            className="button secondary compact"
          >
            How to add releases
          </DocLink>
        );
      case "device":
        return operate ? (
          <Button
            variant={`${variant} compact`}
            onClick={() => navigate("enrollment")}
          >
            Add device
          </Button>
        ) : null;
      case "pipeline":
        return edit ? (
          <Button
            variant={`${variant} compact`}
            onClick={() => runCommand("pipeline.create", "configurations")}
          >
            Create pipeline
          </Button>
        ) : null;
      case "publish":
        return edit ? (
          <Button
            variant={`${variant} compact`}
            onClick={() => navigate("configurations")}
          >
            Open pipelines
          </Button>
        ) : null;
      case "deploy":
        return operate ? (
          <Button
            variant={`${variant} compact`}
            onClick={() => navigate("configurations")}
          >
            Deploy a pipeline
          </Button>
        ) : null;
    }
  }
  return (
    <section
      className="overview-card overview-checklist"
      aria-labelledby="overview-checklist-title"
    >
      <div className="overview-checklist-head">
        <div>
          <h2 id="overview-checklist-title">Set up your fleet</h2>
          <p>
            {done} of {steps.length} done. Each step completes on its own as
            your workspace changes.
          </p>
        </div>
        <div
          className="overview-checklist-progress"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          aria-valuetext={`${done} of ${steps.length} steps done`}
        >
          <span style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
      </div>
      <ol className="overview-checklist-steps">
        {steps.map((step, index) => {
          const state = step.done
            ? "done"
            : step.id === current
              ? "current"
              : "todo";
          const next = !step.done && action(step.id);
          return (
            <li key={step.id} data-state={state}>
              <span className="overview-checklist-marker" aria-hidden="true">
                {step.done ? <Check size={13} strokeWidth={2.6} /> : index + 1}
              </span>
              <div className="overview-checklist-copy">
                <strong>
                  {stepTitles[step.id]}
                  <span className="sr-only">{step.done ? " (done)" : ""}</span>
                </strong>
                <p>{copy[step.id][step.done ? 0 : 1]}</p>
              </div>
              {next && <div className="overview-checklist-action">{next}</div>}
            </li>
          );
        })}
      </ol>
      {!roleAllows(user, "operate") && !roleAllows(user, "edit") && (
        <p className="overview-checklist-note">
          Viewers can follow progress here. An operator or editor completes
          these steps.
        </p>
      )}
    </section>
  );
}

/* ---------- KPI tiles ---------- */

function KpiTiles({
  data,
  live,
  stopped,
}: {
  data: OverviewData;
  live: Device[];
  /** Rollouts that stopped or were rolled back in the last day. */
  stopped: number;
}) {
  const total = live.length;
  const online = live.filter(
    (device) => connectionState(device) === "online",
  ).length;
  const offline = live.filter(
    (device) => connectionState(device) === "offline",
  ).length;
  const never = live.filter(
    (device) => connectionState(device) === "never",
  ).length;
  const managed =
    data.devices_managed ??
    live.filter((device) => !!device.desired_version_id).length;
  const onDesired =
    data.devices_on_desired ??
    live.filter((device) => device.status === "verified").length;
  const unmanaged = total - managed;
  // Applied devices without metrics: nothing says their events arrive.
  const unmeasured = deliveryUnmeasured(live);
  const paused = (data.rollouts || []).filter(
    (r) => r.status === "paused",
  ).length;
  const scheduled = (data.rollouts || []).filter(
    (r) => r.status === "scheduled",
  ).length;
  const active = data.deployments_active;
  const issues = data.issues_open;
  return (
    <div className="overview-kpis">
      <a className="overview-kpi-tile" href="#/devices">
        <span className="overview-kpi-label">
          <Server size={14} aria-hidden="true" />
          Devices online
        </span>
        <span className="overview-kpi-value">
          {online.toLocaleString()}
          <span className="overview-kpi-total">
            {" "}
            / {total.toLocaleString()}
          </span>
        </span>
        <span
          className="overview-kpi-note"
          data-tone={offline ? "warning" : undefined}
        >
          {total === 0
            ? "No devices enrolled yet"
            : offline || never
              ? [
                  offline && `${offline.toLocaleString()} offline`,
                  never && `${never.toLocaleString()} never connected`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "All devices checked in"}
        </span>
      </a>
      <a
        className="overview-kpi-tile"
        href={onDesired < managed ? "#/devices?view=drift" : "#/devices"}
      >
        <span className="overview-kpi-label">
          <CircleCheck size={14} aria-hidden="true" />
          On desired version
        </span>
        <span className="overview-kpi-value">
          {onDesired.toLocaleString()}
          <span className="overview-kpi-total">
            {" "}
            / {managed.toLocaleString()}
          </span>
        </span>
        <span className="overview-kpi-note">
          {managed === 0
            ? "No device has a pipeline yet"
            : onDesired === managed
              ? "Verified running their assigned version"
              : `${(managed - onDesired).toLocaleString()} not yet verified`}
          {managed > 0 && unmanaged > 0
            ? ` · ${unmanaged.toLocaleString()} without a pipeline`
            : ""}
          {unmeasured > 0
            ? ` · Delivery health: not measured${unmeasured < onDesired ? ` on ${countLabel(unmeasured, "device")}` : ""}`
            : ""}
        </span>
      </a>
      <a className="overview-kpi-tile" href="#/deployments">
        <span className="overview-kpi-label">
          <Rocket size={14} aria-hidden="true" />
          Rollouts in progress
        </span>
        <span className="overview-kpi-value">{active.toLocaleString()}</span>
        <span className="overview-kpi-note">
          {[
            stopped && `${stopped} stopped`,
            paused && `${paused} paused`,
            scheduled && `${scheduled} scheduled in the next 24h`,
          ]
            .filter(Boolean)
            .join(" · ") ||
            (active ? "Releasing to devices" : "None right now")}
        </span>
      </a>
      <a className="overview-kpi-tile" href="#/issues">
        <span className="overview-kpi-label">
          <CircleAlert size={14} aria-hidden="true" />
          Open issues
        </span>
        <span
          className="overview-kpi-value"
          data-tone={issues ? "danger" : undefined}
        >
          {issues.toLocaleString()}
        </span>
        <span className="overview-kpi-note">
          {issues ? "Reported by devices. Review them" : "No open reports"}
        </span>
      </a>
    </div>
  );
}

/* ---------- Fleet health ---------- */

const bucketIcons: Record<HealthBucket, LucideIcon> = {
  applied: CircleCheck,
  degraded: Unplug,
  updating: LoaderCircle,
  check: CircleHelp,
  failed: CircleX,
  offline: WifiOff,
  paused: Pause,
  unmanaged: CircleMinus,
};
const bucketCopy: Record<HealthBucket, string> = {
  applied: "Running their assigned version, verified by the agent.",
  degraded: "Applied, but not delivering events.",
  updating: "Receiving or applying a new version.",
  check: "Applied, but Vector wasn't confirmed running.",
  failed: "The last apply failed or was rolled back.",
  offline: "No check-in for three heartbeat intervals.",
  paused: "Configuration sync is paused.",
  unmanaged: "No pipeline assigned. Local workloads keep running.",
};
function FleetHealth({ live }: { live: Device[] }) {
  const { counts, total } = healthCounts(live);
  const shown = healthOrder.filter((bucket) => counts[bucket] > 0);
  const percent = (value: number) =>
    total ? Math.round((value / total) * 100) : 0;
  const summary = shown
    .map((bucket) => `${counts[bucket]} ${healthLabels[bucket].toLowerCase()}`)
    .join(", ");
  return (
    <Card
      title="Fleet health"
      subtitle={
        total
          ? `${countLabel(total, "device")} by pipeline state`
          : "Devices appear here after they enroll"
      }
      action={<CardLink href="#/devices">All devices</CardLink>}
    >
      {total ? (
        <>
          <div
            className="overview-health-bar"
            role="img"
            aria-label={`${countLabel(total, "device")}: ${summary}`}
          >
            {shown.map((bucket) => (
              <Tooltip
                key={bucket}
                content={`${healthLabels[bucket]} · ${countLabel(counts[bucket], "device")} (${percent(counts[bucket])}%)`}
              >
                <span
                  className="health-bar-segment"
                  data-bucket={bucket}
                  style={{ flexGrow: counts[bucket] }}
                />
              </Tooltip>
            ))}
          </div>
          <ul className="overview-health-legend" aria-label="Devices by state">
            {healthOrder.map((bucket) => {
              const Icon = bucketIcons[bucket];
              const value = counts[bucket];
              if (!value && !["applied", "failed", "offline"].includes(bucket))
                return null;
              return (
                <li key={bucket} data-empty={value ? undefined : ""}>
                  <a
                    href={`#/devices?status=${bucket}`}
                    title={bucketCopy[bucket]}
                    data-bucket={bucket}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>{healthLabels[bucket]}</span>{" "}
                    <strong>{value.toLocaleString()}</strong>
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="overview-quiet">
          No devices yet. Health appears as soon as the first agent checks in.
        </p>
      )}
    </Card>
  );
}

/* ---------- Needs you ---------- */

const severityIcons: Record<AttentionGroup["cause"], LucideIcon> = {
  failed: CircleX,
  degraded: Unplug,
  check_required: CircleHelp,
  stuck: LoaderCircle,
  offline: WifiOff,
  paused: Pause,
  unmanaged: CircleMinus,
};
function pipelineName(group: {
  configuration_name: string | null;
  version_number: number | null;
}) {
  if (!group.configuration_name)
    return group.version_number
      ? `Version ${group.version_number}`
      : "A pipeline version";
  return group.version_number
    ? `${group.configuration_name} v${group.version_number}`
    : group.configuration_name;
}
function attentionCopy(
  group: AttentionGroup,
  now: number,
  /** What runs on devices without a pipeline (unmanagedDetail). */
  unmanaged: string,
) {
  const devices = countLabel(group.count, "device");
  const pipeline = pipelineName(group);
  const since = group.since ? Date.parse(group.since) : NaN;
  const lasting = Number.isFinite(since) ? duration(now - since) : null;
  switch (group.cause) {
    case "failed":
      return group.state === "rolled_back"
        ? {
            title: `${pipeline} rolled back on ${devices}`,
            detail:
              "The agent restored the last working version after the apply failed.",
          }
        : { title: `${pipeline} failed on ${devices}`, detail: null };
    case "degraded":
      return {
        title:
          group.count === 1 && group.device_names[0]
            ? `${group.device_names[0]} stopped delivering ${pipeline}`
            : `${pipeline} stopped delivering on ${devices}`,
        detail: [group.title, group.reason].filter(Boolean).join(". ") || null,
      };
    case "check_required":
      return {
        title: `${pipeline} needs a check on ${devices}`,
        detail:
          "Applied, but the agent couldn't confirm that Vector is running it.",
      };
    case "stuck":
      return {
        title: `${devices} still applying ${pipeline}`,
        detail: lasting
          ? `Released ${lasting} ago and not yet verified.`
          : null,
      };
    case "offline":
      return {
        title: `${devices} offline`,
        detail: lasting
          ? `Longest without a check-in: ${lasting}.`
          : "No check-in for three heartbeat intervals.",
      };
    case "paused":
      return {
        title: `${devices} paused`,
        detail:
          [
            group.local ? `${group.local} paused on the host` : "",
            group.requested
              ? `${group.requested} waiting for the agent to confirm`
              : "",
          ]
            .filter(Boolean)
            .join(" · ") || "New versions wait until sync resumes.",
      };
    case "unmanaged":
      return {
        title: `${devices} without a pipeline`,
        detail: unmanaged,
      };
  }
}
const causeBucket: Partial<Record<AttentionGroup["cause"], HealthBucket>> = {
  failed: "failed",
  degraded: "degraded",
  check_required: "check",
  stuck: "updating",
  offline: "offline",
  paused: "paused",
  unmanaged: "unmanaged",
};
function NeedsYou({
  data,
  live,
  user,
  now,
  stopped,
}: {
  data: OverviewData;
  live: Device[];
  user: User;
  now: number;
  stopped: StoppedRollout[];
}) {
  const groups = data.attention || [];
  const affected = groups
    .filter((group) => group.severity !== "neutral")
    .reduce((sum, group) => sum + group.count, 0);
  // A stopped or rolled-back rollout is listed below, so never say
  // "Nothing is failing" above it.
  const summary = [
    affected
      ? `${countLabel(affected, "device")} ${affected === 1 ? "needs" : "need"} attention`
      : "",
    stopped.length ? `${countLabel(stopped.length, "rollout")} stopped` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const unmanaged = unmanagedDetail(live);
  return (
    <Card
      title="Needs you"
      subtitle={
        summary ||
        (groups.length
          ? quietSummary(deliveryUnmeasured(live, now))
          : undefined)
      }
      className="needs-you"
      action={
        data.issues_open > 0 ? (
          <CardLink href="#/issues">Open issues</CardLink>
        ) : undefined
      }
    >
      {groups.length || stopped.length ? (
        <ul className="overview-attention-list">
          <StoppedRolloutItems items={stopped} />
          {groups.map((group) => {
            const Icon = severityIcons[group.cause];
            const { title, detail } = attentionCopy(group, now, unmanaged)!;
            const bucket = causeBucket[group.cause];
            const filter = new URLSearchParams();
            if (bucket) filter.set("status", bucket);
            if (group.version_id) filter.set("version", group.version_id);
            return (
              <li
                key={`${group.cause}:${group.state}:${group.version_id}`}
                className="overview-attention-item"
                data-severity={group.severity}
              >
                <span className="overview-attention-icon" aria-hidden="true">
                  <Icon size={16} />
                </span>
                <div className="overview-attention-copy">
                  <p className="overview-attention-title">{title}</p>
                  {group.reason && group.cause !== "degraded" && (
                    <p
                      className="overview-attention-reason"
                      title={group.reason}
                    >
                      {group.reason}
                    </p>
                  )}
                  {detail && (
                    <p className="overview-attention-detail">{detail}</p>
                  )}
                  {group.cause === "degraded" && group.fix && (
                    <p className="overview-attention-fix">
                      <strong>Fix</strong> {group.fix}
                    </p>
                  )}
                  <p className="overview-attention-devices">
                    {nameList(group.device_names, group.count)}
                  </p>
                </div>
                <div className="overview-attention-actions">
                  {group.cause === "unmanaged" &&
                  roleAllows(user, "operate") ? (
                    <a
                      className="button secondary compact"
                      href="#/configurations"
                    >
                      Deploy a pipeline
                    </a>
                  ) : (
                    <a
                      className="button secondary compact"
                      href={`#/devices?${filter}`}
                    >
                      Review devices
                    </a>
                  )}
                  {group.configuration_id &&
                    ["failed", "degraded", "check_required"].includes(
                      group.cause,
                    ) && (
                      <a
                        className="overview-inline-link"
                        href={`#/configurations/${encodeURIComponent(group.configuration_id)}`}
                      >
                        Open pipeline
                      </a>
                    )}
                  {group.cause === "offline" && (
                    <DocLink
                      topic="troubleshooting"
                      section="a-device-is-offline-or-never-connects"
                      className="overview-inline-link"
                    >
                      Troubleshoot
                    </DocLink>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="overview-all-clear">
          <span className="overview-all-clear-icon" aria-hidden="true">
            <ShieldCheck size={18} />
          </span>
          <div>
            <strong>Nothing needs you right now</strong>
            <p>
              {live.length === 1
                ? "The device is applied and checking in."
                : live.length
                  ? `All ${countLabel(live.length, "device")} are applied and checking in.`
                  : "Failures, offline devices and stuck rollouts will show up here."}
            </p>
          </div>
        </div>
      )}
      <NotificationsHint user={user} placement="card" />
    </Card>
  );
}

/* ---------- Rollouts ---------- */

const progressParts: {
  key: keyof Omit<RolloutProgress, "total">;
  label: string;
}[] = [
  { key: "verified", label: "Applied" },
  { key: "inFlight", label: "Applying" },
  { key: "attention", label: "Needs a check" },
  { key: "failed", label: "Failed" },
  { key: "waiting", label: "Waiting" },
];
export function RolloutBar({ progress }: { progress: RolloutProgress }) {
  const parts = progressParts.filter((part) => progress[part.key] > 0);
  const label = parts
    .map((part) => `${progress[part.key]} ${part.label.toLowerCase()}`)
    .join(", ");
  return (
    <div
      className="overview-rollout-bar"
      role="img"
      aria-label={
        progress.total
          ? `${progress.total} devices: ${label}`
          : "No devices targeted"
      }
    >
      {parts.map((part) => (
        <Tooltip
          key={part.key}
          content={`${part.label} · ${countLabel(progress[part.key], "device")}`}
        >
          <span
            className="overview-rollout-bar-segment"
            data-part={part.key}
            style={{ flexGrow: progress[part.key] }}
          />
        </Tooltip>
      ))}
    </div>
  );
}
function rolloutName(rollout: RolloutSummary) {
  if (rollout.policy) return "Agent settings";
  if (rollout.configuration_name)
    return rollout.version_number
      ? `${rollout.configuration_name} v${rollout.version_number}`
      : rollout.configuration_name;
  return rollout.name || "Deployment";
}
function Rollouts({
  rollouts,
  user,
  now,
}: {
  rollouts?: RolloutSummary[];
  user: User;
  now: number;
}) {
  const list = rollouts || [];
  return (
    <Card
      title="Rollouts"
      subtitle={
        list.length
          ? "In progress, paused and starting within 24 hours"
          : undefined
      }
      action={<CardLink href="#/deployments">All deployments</CardLink>}
    >
      {list.length ? (
        <ul className="overview-rollout-list">
          {list.map((rollout) => {
            const progress = rolloutProgress(rollout.state_counts);
            const starts = rollout.scheduled_at
              ? Date.parse(rollout.scheduled_at)
              : NaN;
            return (
              <li key={rollout.id}>
                <a
                  className="overview-rollout-item"
                  href={`#/deployments/${encodeURIComponent(rollout.id)}`}
                >
                  <span className="overview-rollout-top">
                    <span className="overview-rollout-name">
                      {rolloutName(rollout)}
                      {rollout.rollout_kind === "canary" && (
                        <span className="overview-rollout-kind">Canary</span>
                      )}
                    </span>
                    <StatusBadge domain="deployment" value={rollout.status} />
                  </span>
                  {rollout.status === "scheduled" ? (
                    <span className="overview-rollout-meta">
                      {Number.isFinite(starts)
                        ? starts > now
                          ? `Starts in ${duration(starts - now)}`
                          : "Starting now"
                        : "Scheduled"}
                      {rollout.target_count
                        ? ` · ${countLabel(rollout.target_count, "device")}`
                        : ""}
                      {Number.isFinite(starts) && (
                        <span className="sr-only">
                          {" "}
                          ({exactLocal(rollout.scheduled_at)})
                        </span>
                      )}
                    </span>
                  ) : (
                    <>
                      <RolloutBar progress={progress} />
                      <span className="overview-rollout-meta">
                        {progress.total
                          ? `${progress.verified.toLocaleString()} of ${countLabel(progress.total, "device")} applied`
                          : "No devices targeted yet"}
                        {progress.failed ? ` · ${progress.failed} failed` : ""}
                        {progress.attention
                          ? ` · ${progress.attention} need a check`
                          : ""}
                      </span>
                    </>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="overview-empty-row">
          <p>No rollouts in progress.</p>
          {roleAllows(user, "operate") && (
            <a className="overview-inline-link" href="#/configurations">
              Deploy a pipeline
            </a>
          )}
        </div>
      )}
    </Card>
  );
}

/* ---------- Throughput ---------- */

function FleetThroughput({
  live,
  summary,
  now,
}: {
  live: Device[];
  summary: TelemetrySummary | null;
  now: number;
}) {
  if (!live.length) return null;
  const local = fleetTelemetry(live, now);
  const reporting = summary ? summary.devicesReporting : local.reporting;
  const eligible = summary ? summary.devicesTotal : local.eligible;
  const eventsIn = summary ? summary.eventsIn : local.eventsPerSecond;
  const eventsOut = summary ? summary.eventsOut : local.eventsOutPerSecond;
  const errorsPerMinute = summary
    ? summary.errorsPerMinute
    : local.errorsPerMinute;
  const newest = summary?.newest ?? local.freshest;
  // Only complete buckets: the one still collecting would dip toward zero.
  const complete = summary
    ? completeSeries(summary.series, now, (summary.stepSeconds || 60) * 1000)
    : [];
  const series =
    complete.filter((point) => point.in !== null || point.out !== null)
      .length >= 2
      ? complete
      : null;
  const coverage = reporting
    ? `${reporting.toLocaleString()} of ${countLabel(eligible, "device")} reporting${reporting < eligible ? ". Totals cover those devices only" : ""}`
    : undefined;
  return (
    <Card
      title="Fleet throughput"
      subtitle={
        coverage && (
          <>
            {coverage}
            {newest && (
              <>
                {" · newest sample "}
                <TimeAgo value={newest} />
              </>
            )}
          </>
        )
      }
      className="throughput"
      action={
        series ? (
          <span className="overview-card-meta">Last hour</span>
        ) : undefined
      }
    >
      {!reporting ? (
        <MetricsHowTo
          stale={local.stale}
          disabled={summary?.metricsDisabled ?? local.disabled}
          withoutEndpoint={summary?.withoutEndpoint ?? null}
          target={monitoringTarget(live, now)}
        />
      ) : (
        <>
          <dl className="overview-throughput-stats">
            <div>
              <dt>
                <span
                  className="overview-series-key"
                  data-series="1"
                  aria-hidden="true"
                />
                Events in
              </dt>
              <dd data-missing={eventsIn === null ? "" : undefined}>
                {eventsIn === null ? "Not reported" : formatRate(eventsIn)}
                {eventsIn !== null && (
                  <span className="overview-throughput-unit">/s</span>
                )}
              </dd>
            </div>
            {eventsOut !== null && (
              <div>
                <dt>
                  <span
                    className="overview-series-key"
                    data-series="2"
                    aria-hidden="true"
                  />
                  Events out
                </dt>
                <dd>
                  {formatRate(eventsOut)}
                  <span className="overview-throughput-unit">/s</span>
                </dd>
              </div>
            )}
            <div>
              <dt>Errors</dt>
              <dd
                data-tone={
                  (errorsPerMinute ?? local.errors ?? 0) > 0
                    ? "danger"
                    : undefined
                }
                data-missing={
                  errorsPerMinute === null && local.errors === null
                    ? ""
                    : undefined
                }
              >
                {errorsPerMinute !== null ? (
                  <>
                    {formatRate(errorsPerMinute)}
                    <span className="overview-throughput-unit">/min</span>
                  </>
                ) : local.errors !== null ? (
                  <>
                    {local.errors.toLocaleString()}
                    <span className="overview-throughput-unit">
                      {" "}
                      since start
                    </span>
                  </>
                ) : (
                  "Not reported"
                )}
              </dd>
            </div>
          </dl>
          {series ? (
            <FleetChart series={series} showOut={eventsOut !== null} />
          ) : (
            local.top.length > 0 && (
              <BusiestDevices
                top={local.top}
                total={local.eventsPerSecond ?? 0}
              />
            )
          )}
        </>
      )}
    </Card>
  );
}
function MetricsHowTo({
  stale,
  disabled,
  withoutEndpoint,
  target,
}: {
  stale: number;
  disabled: number;
  withoutEndpoint: number | null;
  /** The pipeline most devices without metrics run. */
  target: { id: string; name: string } | null;
}) {
  const reasons = [
    stale &&
      `${countLabel(stale, "device")} last reported more than 3 minutes ago.`,
    disabled &&
      `${countLabel(disabled, "device")} ${disabled === 1 ? "has" : "have"} metrics turned off in Agent settings.`,
    withoutEndpoint &&
      `${countLabel(withoutEndpoint, "device")} ${withoutEndpoint === 1 ? "has" : "have"} no metrics exporter to read.`,
  ].filter(Boolean) as string[];
  return (
    <div className="overview-throughput-howto">
      <span className="overview-throughput-howto-icon" aria-hidden="true">
        <ChartNoAxesCombined size={18} />
      </span>
      <div className="overview-throughput-howto-copy">
        <h3>No device is reporting metrics</h3>
        <p>
          {reasons.length
            ? reasons.join(" ")
            : "Throughput comes from each device's Vector internal metrics. Nothing has been reported yet."}
        </p>
        <ol>
          <li>
            Add monitoring to the pipeline: an <code>internal_metrics</code>{" "}
            source feeding a <code>prometheus_exporter</code> on{" "}
            <code>127.0.0.1:9598</code>.
          </li>
          <li>
            Deploy the new version. The agent finds the exporter by itself;
            nothing changes on the host.
          </li>
          {disabled > 0 && (
            <li>
              Turn on <strong>Collect operational metrics</strong> in{" "}
              <a href="#/policies">Agent settings</a>.
            </li>
          )}
        </ol>
        {target && (
          <a
            className="button secondary compact"
            href={`#/${pipelineRoute(target.id, undefined, { panel: "tools" })}`}
          >
            Add monitoring to {target.name}
          </a>
        )}
        <p>
          An exporter elsewhere? Point the agent at it with{" "}
          <code>vectory configure-metrics --metrics-url URL</code>.
        </p>
        <DocLink topic="telemetry" section="enable-real-metrics">
          Enable metrics step by step
        </DocLink>
      </div>
    </div>
  );
}
function BusiestDevices({
  top,
  total,
}: {
  top: FleetDeviceRate[];
  total: number;
}) {
  const withOut = top.some((item) => item.eventsOutPerSecond !== null);
  const max = Math.max(
    ...top.flatMap((item) => [
      item.eventsPerSecond,
      item.eventsOutPerSecond ?? 0,
    ]),
    0,
  );
  const width = (value: number) =>
    `${max ? Math.max(2, (value / max) * 100) : 0}%`;
  return (
    <div className="overview-busiest" data-series={withOut ? "2" : "1"}>
      <div className="overview-busiest-head">
        <p className="overview-busiest-title">
          Busiest devices · events per second
        </p>
        {withOut && (
          <ul className="overview-chart-legend" aria-label="Series">
            <li>
              <span
                className="overview-series-key"
                data-series="1"
                aria-hidden="true"
              />
              In
            </li>
            <li>
              <span
                className="overview-series-key"
                data-series="2"
                aria-hidden="true"
              />
              Out
            </li>
          </ul>
        )}
      </div>
      <ul>
        {top.map((item) => {
          const share = total
            ? Math.round((item.eventsPerSecond / total) * 100)
            : 0;
          return (
            <li key={item.id}>
              <a href={`#/devices/${encodeURIComponent(item.id)}`}>
                {item.name}
              </a>
              <Tooltip
                content={`${item.name} · in ${formatRate(item.eventsPerSecond)}/s (${share}% of reported)${
                  item.eventsOutPerSecond !== null
                    ? ` · out ${formatRate(item.eventsOutPerSecond)}/s`
                    : ""
                }`}
              >
                <span className="overview-busiest-track" aria-hidden="true">
                  <span
                    className="overview-busiest-bar"
                    data-series="1"
                    style={{ width: width(item.eventsPerSecond) }}
                  />
                  {withOut && (
                    <span
                      className="overview-busiest-bar"
                      data-series="2"
                      style={{ width: width(item.eventsOutPerSecond ?? 0) }}
                    />
                  )}
                </span>
              </Tooltip>
              <span className="overview-busiest-value">
                {formatRate(item.eventsPerSecond)}
                {withOut && (
                  <span className="overview-busiest-out">
                    {item.eventsOutPerSecond === null
                      ? " / —"
                      : ` / ${formatRate(item.eventsOutPerSecond)}`}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const CHART_WIDTH = 600,
  CHART_HEIGHT = 140;
function FleetChart({
  series,
  showOut,
}: {
  series: SummaryPoint[];
  showOut: boolean;
}) {
  const [cursor, setCursor] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const times = series.map((point) => Date.parse(point.at));
  const start = times[0],
    end = times[times.length - 1];
  const span = Math.max(1, end - start);
  const values = series.flatMap((point) => [
    point.in ?? 0,
    showOut ? (point.out ?? 0) : 0,
  ]);
  const top = niceCeiling(Math.max(...values));
  const x = (index: number) => ((times[index] - start) / span) * CHART_WIDTH;
  const y = (value: number) => CHART_HEIGHT - (value / top) * CHART_HEIGHT;
  // Gaps stay gaps: a missing value breaks the line instead of dropping to zero.
  const path = (key: "in" | "out") => {
    let d = "";
    let open = false;
    series.forEach((point, index) => {
      const value = point[key];
      if (value === null) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      open = true;
    });
    return d;
  };
  const point = cursor === null ? null : series[cursor];
  const readout = point
    ? `${shortLocal(point.at)}: in ${point.in === null ? "not reported" : `${formatRate(point.in)}/s`}${showOut ? `, out ${point.out === null ? "not reported" : `${formatRate(point.out)}/s`}` : ""}`
    : "";
  function pick(clientX: number) {
    const box = plot.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    const at = start + ((clientX - box.left) / box.width) * span;
    let best = 0;
    times.forEach((time, index) => {
      if (Math.abs(time - at) < Math.abs(times[best] - at)) best = index;
    });
    setCursor(best);
  }
  return (
    <div className="fleet-chart">
      {showOut && (
        <ul
          className="overview-chart-legend fleet-chart-legend"
          aria-label="Series"
        >
          <li>
            <span
              className="overview-series-key"
              data-series="1"
              aria-hidden="true"
            />
            Events in
          </li>
          <li>
            <span
              className="overview-series-key"
              data-series="2"
              aria-hidden="true"
            />
            Events out
          </li>
        </ul>
      )}
      <div
        className="fleet-chart-frame"
        tabIndex={0}
        role="group"
        aria-label="Fleet throughput over the last hour. Use the arrow keys to read samples."
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          setCursor((current) => {
            const last = series.length - 1;
            if (event.key === "Home") return 0;
            if (event.key === "End") return last;
            const from = current ?? last;
            return Math.min(
              last,
              Math.max(0, from + (event.key === "ArrowRight" ? 1 : -1)),
            );
          });
        }}
        onBlur={() => setCursor(null)}
      >
        <div className="fleet-chart-axis-y" aria-hidden="true">
          <span>{formatRate(top)}</span>
          <span>{formatRate(top / 2)}</span>
          <span>0</span>
        </div>
        <div
          ref={plot}
          className="fleet-chart-plot"
          onPointerMove={(event) => pick(event.clientX)}
          onPointerLeave={() => setCursor(null)}
        >
          <svg
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {[0, 0.5, 1].map((fraction) => (
              <line
                key={fraction}
                className="fleet-chart-grid"
                x1={0}
                x2={CHART_WIDTH}
                y1={CHART_HEIGHT * fraction}
                y2={CHART_HEIGHT * fraction}
              />
            ))}
            {showOut && (
              <path
                className="fleet-chart-line"
                data-series="2"
                d={path("out")}
              />
            )}
            <path className="fleet-chart-line" data-series="1" d={path("in")} />
          </svg>
          {point && cursor !== null && (
            <>
              <span
                className="fleet-chart-cursor"
                style={{ left: `${(x(cursor) / CHART_WIDTH) * 100}%` }}
                aria-hidden="true"
              />
              {point.in !== null && (
                <span
                  className="fleet-chart-dot"
                  data-series="1"
                  style={{
                    left: `${(x(cursor) / CHART_WIDTH) * 100}%`,
                    top: `${(y(point.in) / CHART_HEIGHT) * 100}%`,
                  }}
                  aria-hidden="true"
                />
              )}
              {showOut && point.out !== null && (
                <span
                  className="fleet-chart-dot"
                  data-series="2"
                  style={{
                    left: `${(x(cursor) / CHART_WIDTH) * 100}%`,
                    top: `${(y(point.out) / CHART_HEIGHT) * 100}%`,
                  }}
                  aria-hidden="true"
                />
              )}
              <div
                className="fleet-chart-tooltip"
                data-side={x(cursor) > CHART_WIDTH / 2 ? "left" : "right"}
                style={{ left: `${(x(cursor) / CHART_WIDTH) * 100}%` }}
                aria-hidden="true"
              >
                <strong>{shortLocal(point.at)}</strong>
                <span>
                  <span className="overview-series-key" data-series="1" />
                  In {point.in === null ? "—" : `${formatRate(point.in)}/s`}
                </span>
                {showOut && (
                  <span>
                    <span className="overview-series-key" data-series="2" />
                    Out{" "}
                    {point.out === null ? "—" : `${formatRate(point.out)}/s`}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="fleet-chart-axis-x" aria-hidden="true">
        <span>{shortLocal(series[0].at).replace(/^.*,\s*/, "")}</span>
        <span>Now</span>
      </div>
      <p className="sr-only" aria-live="polite">
        {readout}
      </p>
    </div>
  );
}

/* ---------- Recent changes ---------- */

const ACTIVITY_SHOWN = 8;
function fallbackActivity(entries: Audit[]): ActivityItem[] {
  return entries
    .filter((entry) => !isSecurityAction(entry.action))
    .slice(0, 12) as unknown as ActivityItem[];
}
function PartText({ part }: { part: Part }) {
  if (part.href) return <a href={part.href}>{part.text}</a>;
  if (part.strong) return <strong>{part.text}</strong>;
  return <>{part.text}</>;
}
function RecentChanges({ data }: { data: OverviewData }) {
  const items = (
    data.fleet_activity ?? fallbackActivity(data.recent_activity || [])
  ).slice(0, ACTIVITY_SHOWN);
  const hidden = data.security_events_hidden ?? 0;
  return (
    <Card
      title="Recent changes"
      subtitle="Pipelines, deployments and device results"
      action={<CardLink href="#/audit">Audit log</CardLink>}
      className="recent-changes"
    >
      {items.length ? (
        <ol className="overview-activity-list">
          {items.map((item) => {
            const parts = describeActivity(item);
            const tone = activityTone(item);
            return (
              <li
                key={item.id}
                className="overview-activity-item"
                data-tone={tone}
              >
                <ActivityGlyph item={item} />
                <p className="overview-activity-text">
                  {parts.map((part, index) => (
                    <PartText key={index} part={part} />
                  ))}
                </p>
                {item.created_at ? (
                  <a
                    className="overview-activity-time"
                    href={`#/audit/${encodeURIComponent(item.id)}?page=1`}
                    title={`${exactLocal(item.created_at)} · Open in the audit log`}
                  >
                    <TimeAgo value={item.created_at} />
                  </a>
                ) : (
                  <span className="overview-activity-time">
                    Time unavailable
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="overview-quiet">
          Pipeline changes, deployments and device results will appear here.
        </p>
      )}
      <div className="overview-activity-footer">
        <a className="overview-inline-link" href="#/audit?scope=security">
          <ShieldCheck size={14} aria-hidden="true" />
          Security activity
        </a>
        <span>
          {hidden
            ? `Sign-ins and account changes (${hidden.toLocaleString()} recent) are kept there.`
            : "Sign-ins and account changes are kept there."}
        </span>
      </div>
    </Card>
  );
}

export default Overview;
