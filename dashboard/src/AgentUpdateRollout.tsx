// One update rollout: how many devices updated, the stages with their
// observation, why devices rolled back or failed, and each device's own state.
// A device counts as updated only once it checked in on the new build after
// the restart; a download, a staged file or a swap is never an update.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  CircleCheck,
  Clock,
  Clock3,
  Layers,
  Pause,
  Play,
  Users,
} from "lucide-react";
import { can, type User } from "./api";
import {
  isLiveRollout,
  rolloutEnding,
  rolloutTitle,
  stageTitle,
  strategyText,
  targetDetail,
  targetStateNames,
  thresholdText,
  observationText,
  updateCounts,
  updateSegments,
  type UpdateRolloutDetail,
  type UpdateStage,
  type UpdateTarget,
  type UpdateTargetPage,
} from "./agentUpdateModel";
import { rolloutAction } from "./agentUpdateApi";
import { describeFailure, isDefiniteRefusal } from "./agentUpdateRequests";
import { codeText } from "./agentUpdateCodes";
import { NextAdmission, ProgressBar } from "./DeploymentRollout";
import { exactTime } from "./deploymentStatus";
import { DataTable } from "./DataTable";
import { deviceDisplay } from "./deviceName";
import { RetiredName } from "./RetiredBadge";
import {
  Button,
  DateCell,
  ErrorBox,
  InlineError,
  Modal,
  PageHeader,
  Pagination,
  SearchBox,
  Skeleton,
  StatusBadge,
  useNow,
  useResource,
  DEFAULT_POLL_INTERVAL,
} from "./ui";
import { statusOf } from "./status";
import { relativeTime } from "./time";
import type { Notify } from "./toast";
import "./control.css";
import "./deployments.css";
import "./deployment-rollout.css";
import "./agent-updates.css";

const LIVE_POLL = 4000;
type Verb = "pause" | "resume" | "cancel";

const verbs: Record<
  Verb,
  {
    title: string;
    label: string;
    description: string;
    body: string;
    done: string;
  }
> = {
  pause: {
    title: "Pause rollout",
    label: "Pause rollout",
    description: "Stop releasing to more devices.",
    body: "Offers that haven't started applying are withdrawn: those devices go back to pending, and their agents discard what they staged. Devices already applying finish. Resuming restarts the observation of the current stage.",
    done: "Rollout paused. Devices already applying finish.",
  },
  resume: {
    title: "Resume rollout",
    label: "Resume rollout",
    description: "Release again to the devices still waiting.",
    body: "The observation of the current stage starts again, and releasing continues through the same checks as before.",
    done: "Rollout resumed.",
  },
  cancel: {
    title: "Cancel rollout",
    label: "Cancel rollout",
    description: "End this rollout.",
    body: "Offers that haven't started are withdrawn, and those devices are cancelled. Devices already applying finish. A cancelled rollout is never resumed: review a new one to update the rest.",
    done: "Rollout cancelled. Devices already applying finish.",
  },
};

type TargetQuery = {
  search: string;
  state: string;
  page: number;
  sort: "device_name" | "state" | "updated_at";
  direction: "asc" | "desc";
};

export default function UpdateRolloutPage({
  id,
  user,
  notify,
  navigate,
}: {
  id: string;
  user: User;
  notify: Notify;
  navigate(path: string): void;
}) {
  const [polling, setPolling] = useState(false);
  const interval = polling ? LIVE_POLL : DEFAULT_POLL_INTERVAL;
  const rollout = useResource<UpdateRolloutDetail | null>(
    `/agent-update-rollouts/${encodeURIComponent(id)}`,
    null,
    0,
    { interval },
  );
  const detail = rollout.data;
  const live = !!detail && isLiveRollout(detail.status);
  useEffect(() => setPolling(live), [live]);
  const operate = can(user, "operate");
  const [action, setAction] = useState<Verb | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [revision, setRevision] = useState(0);
  const busyRef = useRef(false);
  const uncertainRef = useRef(false);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  useEffect(() => {
    if (detail) setClockOffset(Date.parse(detail.evaluated_at) - Date.now());
  }, [detail]);
  useEffect(() => {
    mounted.current = true;
    const guard = (event: Event) => {
      if (!busyRef.current) return;
      event.preventDefault();
      notify("Wait for the current action to finish before leaving.", {
        tone: "info",
      });
    };
    window.addEventListener("vectory:before-navigate", guard);
    return () => {
      mounted.current = false;
      window.removeEventListener("vectory:before-navigate", guard);
    };
  }, [notify]);
  useEffect(() => {
    if (!rollout.loading && detail)
      heading.current?.focus({ preventScroll: true });
    // Focus the title once, when the rollout first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rollout.loading && !detail]);

  function begin(verb: Verb, opener: HTMLElement | null) {
    if (busyRef.current || uncertainRef.current || checking) return;
    returnFocus.current = opener;
    setProblem("");
    setAction(verb);
  }
  async function perform() {
    if (!action || busyRef.current || uncertainRef.current || !operate) return;
    busyRef.current = true;
    setBusy(true);
    setProblem("");
    try {
      const result = await rolloutAction(id, action);
      if (result.id !== id)
        throw new Error("The response did not identify this rollout.");
      if (!mounted.current) return;
      setAction(null);
      notify(verbs[action].done, { tone: "success" });
      setRevision((old) => old + 1);
      await rollout.reload();
    } catch (error) {
      if (!mounted.current) return;
      const found = describeFailure(error);
      if (isDefiniteRefusal(error)) setProblem(found.message);
      else {
        // The server may have applied it: nothing is sent again by itself.
        uncertainRef.current = true;
        setUncertain(true);
        setProblem(
          "The response couldn't be confirmed. Check the rollout's current status before trying this action again.",
        );
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const checkStatus = useCallback(async () => {
    if (checking || busyRef.current) return;
    setAction(null);
    setChecking(true);
    setCheckError("");
    try {
      const current = await rollout.reloadResult();
      if (!mounted.current) return;
      if (!current || current.id !== id) {
        setCheckError(
          "The current status couldn't be confirmed. Check again before making another change.",
        );
        return;
      }
      uncertainRef.current = false;
      setUncertain(false);
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, [checking, id, rollout]);

  const back = () => navigate("agent-updates");
  const locked = busy || uncertain || checking;
  const counts = detail ? updateCounts(detail) : null;
  const ending = detail ? rolloutEnding(detail) : null;
  const title = detail ? rolloutTitle(detail) : "Update rollout";

  return (
    <div
      className="control-page rollout-page update-rollout"
      role="region"
      aria-label="Update rollout details"
    >
      {rollout.loading && !detail ? (
        <>
          <PageHeader
            title="Loading update rollout"
            loadingTitle
            documentTitle="Update rollout"
            breadcrumb={[
              {
                label: "Agent updates",
                href: "#/agent-updates",
                onClick: back,
              },
            ]}
          />
          <div
            className="rollout-skeleton"
            role="status"
            aria-label="Loading rollout"
          >
            <Skeleton width="min(560px, 90%)" height={14} />
            <div className="rollout-card rollout-skeleton-card">
              <Skeleton width={180} height={14} />
              <Skeleton height={10} radius={999} />
            </div>
          </div>
        </>
      ) : !detail ? (
        rollout.error && (
          <>
            <PageHeader
              title="Update rollout"
              breadcrumb={[
                {
                  label: "Agent updates",
                  href: "#/agent-updates",
                  onClick: back,
                },
              ]}
            />
            <InlineError
              title={
                rollout.errorStatus === 404 || rollout.errorStatus === 403
                  ? "This update rollout could not be opened. It may be missing, or agent updates may be off."
                  : "Vectory couldn't load this rollout right now."
              }
              error={rollout.error}
              retry={
                rollout.errorStatus === 404 || rollout.errorStatus === 403
                  ? undefined
                  : () => void rollout.reload()
              }
              retrying={rollout.refreshing}
            />
            <Button variant="secondary" onClick={back}>
              Return to agent updates
            </Button>
          </>
        )
      ) : (
        <>
          <PageHeader
            title={title}
            documentTitle={`${title} · Agent ${detail.release.version}`}
            headingRef={heading}
            breadcrumb={[
              {
                label: "Agent updates",
                href: "#/agent-updates",
                onClick: back,
              },
            ]}
            titleAside={
              <span
                className="rollout-version"
                aria-label={`Agent ${detail.release.version}`}
              >
                {detail.release.version}
              </span>
            }
            live={{
              updatedAt: rollout.updatedAt,
              error: rollout.error || undefined,
              refreshing: rollout.refreshing,
              onRefresh: () => {
                void rollout.reload();
                setRevision((old) => old + 1);
              },
            }}
            meta={
              <ul className="rollout-meta" aria-label="Rollout settings">
                <li className="rollout-meta-status">
                  <StatusBadge domain="updateRollout" value={detail.status} />
                  {ending && (
                    <span className="rollout-status-note">{ending}</span>
                  )}
                </li>
                <li>
                  <Layers size={14} aria-hidden="true" />
                  {strategyText(detail.rollout, canaryNames(detail))}
                </li>
                <li>
                  <Users size={14} aria-hidden="true" />
                  Agent {detail.release.version} · counter{" "}
                  {detail.release.counter}
                </li>
                <li>
                  <Clock size={14} aria-hidden="true" />
                  Created {exactTime(detail.created_at)}
                  {detail.created_by_name
                    ? ` by ${detail.created_by_name}`
                    : ""}
                </li>
              </ul>
            }
          >
            {operate &&
              (detail.status === "active" || detail.status === "paused") && (
                <div className="rollout-action-row">
                  {detail.status === "paused" && (
                    <Button
                      icon={Play}
                      disabled={locked}
                      onClick={(event) => begin("resume", event.currentTarget)}
                    >
                      Resume
                    </Button>
                  )}
                  {detail.status === "active" && (
                    <Button
                      variant="secondary"
                      icon={Pause}
                      disabled={locked}
                      onClick={(event) => begin("pause", event.currentTarget)}
                    >
                      Pause
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    icon={Ban}
                    disabled={locked}
                    onClick={(event) => begin("cancel", event.currentTarget)}
                  >
                    Cancel rollout
                  </Button>
                </div>
              )}
          </PageHeader>
          {rollout.error && (
            <InlineError
              title="Couldn't refresh this rollout."
              error={rollout.error}
              updatedAt={rollout.updatedAt}
              retry={() => void rollout.reload()}
            />
          )}
          {uncertain && (
            <div className="deployment-status-review" role="status">
              <p>
                {checkError ||
                  "The previous action may have completed. Check its current status before making another change."}
              </p>
              <Button
                variant="secondary"
                busy={checking}
                disabled={checking}
                onClick={() => void checkStatus()}
              >
                Check current status
              </Button>
            </div>
          )}
          <section
            className="rollout-card rollout-summary"
            aria-label="Rollout progress"
          >
            <div className="rollout-summary-head">
              <p>
                {counts?.figure && <strong>{counts.figure} </strong>}
                {counts?.base}
                {counts?.notes.map((note) => (
                  <span
                    key={note.key}
                    className={
                      ["rolled_back", "failed", "not_delivering"].includes(
                        note.key,
                      )
                        ? "rollout-count-note deployment-failed-count"
                        : "rollout-count-note"
                    }
                  >
                    {" · "}
                    {note.text}
                  </span>
                ))}
              </p>
              <span className="control-muted">
                {detail.status === "failed"
                  ? "Stopped"
                  : thresholdText(detail.rollout.failure_threshold)}
              </span>
            </div>
            <ProgressBar
              segments={updateSegments(
                detail.state_counts,
                detail.degraded,
                !live,
              )}
              always={["update-updated", "update-failed"]}
              label="Device progress"
            />
            <p className="control-muted update-timing">
              A device is updated when it checks in on the new build after the
              restart and its host reports it healthy.
              {detail.check_in_seconds
                ? ` Devices check in about every ${detail.check_in_seconds} s, so each step can take that long to show.`
                : ""}
            </p>
          </section>
          {detail.stages.length > 0 && (
            <section
              className="rollout-section"
              aria-labelledby="update-stages"
            >
              <div className="rollout-section-head">
                <h2 id="update-stages">Stages</h2>
                <span className="control-muted">
                  Each stage waits for every released device to finish, then
                  watches them for{" "}
                  {observationText(detail.rollout.observation_seconds)}.
                </span>
              </div>
              <UpdateLanes
                detail={detail}
                clockOffset={clockOffset}
                navigate={navigate}
              />
            </section>
          )}
          {detail.failures.length > 0 && (
            <section
              className="rollout-failures"
              aria-labelledby="update-failures"
            >
              <h2 id="update-failures">Why devices rolled back or failed</h2>
              <ul>
                {detail.failures.map((failure) => {
                  const text = failure.code ? codeText(failure.code) : null;
                  return (
                    <li key={`${failure.state}-${failure.code ?? ""}`}>
                      <div className="rollout-failure-head">
                        <StatusBadge
                          domain="updateTarget"
                          value={failure.state}
                          label={`${statusOf("updateTarget", failure.state).label} on ${failure.count} ${failure.count === 1 ? "device" : "devices"}`}
                        />
                      </div>
                      <p className="rollout-failure-reason">
                        {text?.reason ||
                          failure.message ||
                          "The agent did not report a reason."}
                      </p>
                      {failure.state === "rolled_back" && (
                        <p className="rollout-failure-detail">
                          A device that rolled back never tries this release
                          again. It takes the next one.
                        </p>
                      )}
                      {text?.fix && (
                        <p className="rollout-failure-fix">
                          <strong>Fix</strong> {text.fix}
                        </p>
                      )}
                      {failure.code && (
                        <p className="rollout-failure-detail rollout-failure-origin">
                          <span>
                            Agent code <code>{failure.code}</code>
                          </span>
                        </p>
                      )}
                      <p className="rollout-failure-devices">
                        {failure.devices.map((device, position) => (
                          <span key={device.device_id}>
                            {position > 0 && ", "}
                            <a
                              href={`#/devices/${encodeURIComponent(device.device_id)}`}
                            >
                              {device.device_name || device.device_id}
                            </a>
                          </span>
                        ))}
                        {failure.count > failure.devices.length &&
                          ` and ${failure.count - failure.devices.length} more`}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <Targets
            id={id}
            detail={detail}
            live={live}
            revision={revision}
            navigate={navigate}
          />
          <details className="control-disclosure">
            <summary>Technical details</summary>
            <dl className="control-summary-list">
              <div>
                <dt>Rollout ID</dt>
                <dd className="control-wrap-code">{id}</dd>
              </div>
              <div>
                <dt>Release ID</dt>
                <dd className="control-wrap-code">{detail.release.id}</dd>
              </div>
              <div>
                <dt>Manifest SHA-256</dt>
                <dd className="control-wrap-code">
                  {detail.release.manifest_sha256}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  <DateCell value={detail.created_at} />
                </dd>
              </div>
            </dl>
          </details>
        </>
      )}
      {action && (
        <Modal
          open
          title={verbs[action].title}
          description={verbs[action].description}
          returnFocusRef={returnFocus}
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <div className="modal-body">
            {problem && <ErrorBox message={problem} />}
            <p>
              <strong>{detail ? rolloutTitle(detail) : "This rollout"}</strong>
              {detail && ` · Agent ${detail.release.version}`}
            </p>
            <p className="modal-copy">{verbs[action].body}</p>
          </div>
          <div className="modal-footer">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setAction(null);
                if (uncertainRef.current) void checkStatus();
              }}
            >
              {uncertain ? "Close" : "Keep current state"}
            </Button>
            <Button
              variant={action === "cancel" ? "danger" : ""}
              busy={busy}
              disabled={busy || (!uncertain && !operate)}
              onClick={
                uncertain ? () => void checkStatus() : () => void perform()
              }
            >
              {uncertain ? "Check current status" : verbs[action].label}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** The canary's devices by name, once the stage says who they are. */
function canaryNames(detail: UpdateRolloutDetail) {
  const canary = detail.stages.find((stage) => stage.kind === "canary");
  const names = canary?.devices
    .map((device) => device.device_name)
    .filter((name): name is string => !!name);
  if (!canary || !names?.length) return null;
  return names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, 2).join(", ")} and ${canary.size - 2} more`;
}

/* ---------- Stages as lanes ---------- */

function UpdateLanes({
  detail,
  clockOffset,
  navigate,
}: {
  detail: UpdateRolloutDetail;
  clockOffset: number;
  navigate(path: string): void;
}) {
  const stages = detail.stages;
  const current = stages.findIndex(
    (stage) => stage.state === "in_progress" || stage.state === "failed",
  );
  const observingIndex = stages.findIndex(
    (stage) => stage.state === "observing",
  );
  const due =
    detail.observation_started_at && observingIndex >= 0
      ? new Date(
          Date.parse(detail.observation_started_at) +
            detail.rollout.observation_seconds * 1000,
        ).toISOString()
      : null;
  return (
    <ol className="rollout-lanes" aria-label="Release stages">
      {stages.map((stage, index) => (
        <UpdateLane
          key={`${stage.kind}-${stage.index}`}
          stage={stage}
          active={index === current}
          countdown={
            index === observingIndex && due
              ? {
                  due,
                  seconds: detail.rollout.observation_seconds,
                  last: index === stages.length - 1,
                }
              : null
          }
          clockOffset={clockOffset}
          navigate={navigate}
        />
      ))}
    </ol>
  );
}

function UpdateLane({
  stage,
  active,
  countdown,
  clockOffset,
  navigate,
}: {
  stage: UpdateStage;
  active: boolean;
  countdown: { due: string; seconds: number; last: boolean } | null;
  clockOffset: number;
  navigate(path: string): void;
}) {
  const verified = stage.counts.verified || 0;
  return (
    <li
      className="rollout-lane"
      data-state={stage.state}
      aria-current={active ? "step" : undefined}
    >
      <header>
        <strong>{stageTitle(stage)}</strong>
        <StatusBadge domain="updateStage" value={stage.state} />
      </header>
      <p className="rollout-lane-count">
        <span>
          {verified} of {stage.size}
        </span>{" "}
        updated
      </p>
      <ul className="rollout-dots" aria-label={`${stageTitle(stage)} devices`}>
        {stage.devices.map((device) => {
          const entry = statusOf("updateTarget", device.state);
          return (
            <li key={device.device_id}>
              <a
                href={`#/devices/${encodeURIComponent(device.device_id)}`}
                className="rollout-dot"
                data-tone={entry.tone}
                aria-label={`${device.device_name || device.device_id}: ${entry.label}`}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey)
                    return;
                  event.preventDefault();
                  navigate(`devices/${encodeURIComponent(device.device_id)}`);
                }}
              >
                <span className="rollout-tip" role="presentation">
                  <strong>{device.device_name || "Unnamed device"}</strong>
                  <small>{entry.label}</small>
                </span>
              </a>
            </li>
          );
        })}
        {stage.more > 0 && <li className="rollout-dots-more">+{stage.more}</li>}
      </ul>
      <footer>
        {countdown ? (
          <NextAdmission
            due={countdown.due}
            totalSeconds={countdown.seconds}
            clockOffset={clockOffset}
            last={countdown.last}
          />
        ) : stage.state === "passed" ? (
          <span>
            <CircleCheck size={13} aria-hidden="true" /> Passed
            {stage.released_at
              ? `, released ${exactTime(stage.released_at)}`
              : ""}
          </span>
        ) : stage.released_at ? (
          <span>
            <Clock3 size={13} aria-hidden="true" /> Released{" "}
            {exactTime(stage.released_at)}
          </span>
        ) : stage.state === "stopped" ? (
          <span>The rollout ended before these devices.</span>
        ) : (
          <span>
            Waits for {stage.index === 0 ? "release" : "the stage before"}.
          </span>
        )}
      </footer>
    </li>
  );
}

/* ---------- Each device ---------- */

function Targets({
  id,
  detail,
  live,
  revision,
  navigate,
}: {
  id: string;
  detail: UpdateRolloutDetail;
  live: boolean;
  revision: number;
  navigate(path: string): void;
}) {
  const [query, setQuery] = useState<TargetQuery>({
    search: "",
    state: "all",
    page: 1,
    sort: "device_name",
    direction: "asc",
  });
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (query.search === search.trim()) return;
    const timer = setTimeout(
      () => setQuery((old) => ({ ...old, search: search.trim(), page: 1 })),
      250,
    );
    return () => clearTimeout(timer);
  }, [search, query.search]);
  const params = new URLSearchParams({
    page: String(query.page),
    page_size: "12",
    sort: query.sort,
    direction: query.direction,
  });
  if (query.search) params.set("search", query.search);
  if (query.state !== "all") params.set("state", query.state);
  const targets = useResource<UpdateTargetPage>(
    `/agent-update-rollouts/${encodeURIComponent(id)}/targets?${params}`,
    { items: [], total: 0, page: query.page, page_size: 12 },
    revision,
    { interval: live ? LIVE_POLL : DEFAULT_POLL_INTERVAL },
  );
  const now = useNow(null, { every: 5000 });
  const stopped = !isLiveRollout(detail.status);
  const states = targetStateNames.filter(
    (state) => (detail.state_counts[state] || 0) > 0 || query.state === state,
  );
  const link = (target: UpdateTarget) => {
    const shown = target.device_name ? deviceDisplay(target.device_name) : null;
    const anchor = (
      <a
        className="control-row-title"
        href={`#/devices/${encodeURIComponent(target.device_id)}`}
        onClick={(event) => {
          if (
            event.button === 0 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            navigate(`devices/${encodeURIComponent(target.device_id)}`);
          }
        }}
      >
        {shown?.name || target.device_id}
      </a>
    );
    return shown?.retired ? <RetiredName>{anchor}</RetiredName> : anchor;
  };
  const stateLabel = (state: string) => {
    const base = statusOf("updateTarget", state).label;
    return state === "pending" && stopped ? "Not released" : base;
  };
  const detailText = (target: UpdateTarget) => (
    <span className="rollout-diagnostic">
      <span>{targetDetail(target, { stopped })}</span>
      {target.code && (
        <small>
          Agent code <code className="rollout-code">{target.code}</code>
        </small>
      )}
    </span>
  );
  const versions = (target: UpdateTarget) =>
    `${target.from_version ?? "—"} → ${target.to_version}`;
  return (
    <section aria-label="Device results" className="deployment-device-results">
      <div className="rollout-section-head">
        <h2>Devices</h2>
        <SearchBox
          value={search}
          onChange={setSearch}
          maxLength={200}
          placeholder="Search rollout devices"
        />
        <label className="deployment-mobile-filter">
          <span className="sr-only">Progress</span>
          <select
            value={query.state}
            onChange={(event) =>
              setQuery((old) => ({
                ...old,
                state: event.target.value,
                page: 1,
              }))
            }
          >
            <option value="all">All devices</option>
            {states.map((state) => (
              <option key={state} value={state}>
                {`${stateLabel(state)} (${detail.state_counts[state] || 0})`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="control-table">
        <DataTable<UpdateTarget>
          label="Device results"
          className="deployment-targets update-targets"
          data={targets.data.items}
          rowKey={(row) => row.device_id}
          loading={targets.loading}
          error={
            targets.error
              ? {
                  title: targets.updatedAt
                    ? "Couldn't refresh device results."
                    : "Couldn't load device results.",
                  message: targets.error,
                  updatedAt: targets.updatedAt,
                  retry: () => void targets.reload(),
                  retrying: targets.refreshing,
                }
              : null
          }
          manualSorting
          sort={{ column: query.sort, direction: query.direction }}
          onSortChange={(sort) =>
            setQuery((old) => ({
              ...old,
              page: 1,
              sort: (sort?.column as TargetQuery["sort"]) || "device_name",
              direction: sort?.direction || "asc",
            }))
          }
          mobileCard={(target) => ({
            title: (
              <span className="rollout-card-title">
                {link(target)}
                <StatusBadge
                  domain="updateTarget"
                  value={target.state}
                  label={stateLabel(target.state)}
                />
              </span>
            ),
            meta: [
              versions(target),
              `Updated ${relativeTime(target.updated_at, now)}`,
              detailText(target),
            ],
          })}
          columns={[
            {
              id: "device_name",
              header: "Device",
              sortable: true,
              cell: (target) => (
                <>
                  {link(target)}
                  <small>
                    {target.stage === null
                      ? "Not released"
                      : target.stage === 0
                        ? "Canary"
                        : `Batch ${target.stage}`}
                    {" · "}
                    {versions(target)}
                  </small>
                </>
              ),
            },
            {
              id: "state",
              header: "Progress",
              sortable: true,
              cell: (target) => (
                <StatusBadge
                  domain="updateTarget"
                  value={target.state}
                  label={stateLabel(target.state)}
                />
              ),
              filter: {
                value: query.state,
                emptyValue: "all",
                allLabel: "All devices",
                manual: true,
                options: states.map((state) => ({
                  value: state,
                  label: `${stateLabel(state)} (${detail.state_counts[state] || 0})`,
                })),
                onChange: (state) =>
                  setQuery((old) => ({ ...old, state, page: 1 })),
              },
            },
            {
              id: "message",
              header: "Details",
              cell: detailText,
            },
            {
              id: "updated_at",
              header: "Updated",
              sortable: true,
              defaultDirection: "desc",
              cell: (target) => <DateCell value={target.updated_at} />,
            },
          ]}
          empty={
            query.search || query.state !== "all"
              ? "No devices match these filters."
              : "No devices were targeted."
          }
        />
        {!targets.loading && !targets.error && (
          <Pagination
            count={targets.data.total}
            page={query.page}
            size={targets.data.page_size}
            onPage={(page) => setQuery((old) => ({ ...old, page }))}
          />
        )}
      </div>
    </section>
  );
}
