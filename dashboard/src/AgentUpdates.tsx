// Devices, Agent updates: what the fleet runs and how its hosts take updates,
// the builds this server could roll out, the releases prepared from them, and
// the update rollouts. Every count is the server's, from what each agent
// reported; a device that sent nothing is "not reported", never a zero.
import { lazy, Suspense, useRef, useState } from "react";
import { ArrowRight, CircleArrowUp, OctagonX, Rocket } from "lucide-react";
import { can, type User } from "./api";
import {
  catalogAction,
  fleetView,
  isLiveRollout,
  levelHints,
  levelHref,
  platformName,
  releaseStartable,
  rolloutEnding,
  rolloutTitle,
  strategyText,
  updateCounts,
  updateSegments,
  versionHref,
  type AgentRelease,
  type CatalogEntry,
  type UpdateRollout,
  type UpdateRolloutPage,
} from "./agentUpdateModel";
import {
  PrepareDialog,
  ReleaseCard,
  WithdrawDialog,
} from "./AgentUpdateReleases";
import { StopAllDialog } from "./AgentUpdateSettingsDialogs";
import { ProgressBar } from "./DeploymentRollout";
import { DataTable, TableCard } from "./DataTable";
import {
  Button,
  DateCell,
  EmptyState,
  InlineError,
  PageHeader,
  PageToolbar,
  SearchBox,
  Skeleton,
  StatusBadge,
  useResource,
} from "./ui";
import { updateRolloutStatuses } from "./status";
import { useAgentUpdates } from "./useAgentUpdates";
import type { Notify } from "./toast";
import "./control.css";
import "./agent-updates.css";

const ReviewDialog = lazy(() => import("./AgentUpdateReview"));
const RolloutPage = lazy(() => import("./AgentUpdateRollout"));

const LIVE_POLL = 5000;
const POLL = 15000;
const devices = (count: number) => (count === 1 ? "device" : "devices");

export default function AgentUpdatesPage({
  user,
  notify,
  navigate,
  rolloutId,
}: {
  user: User;
  notify: Notify;
  navigate(path: string): void;
  rolloutId?: string;
}) {
  return rolloutId ? (
    <Suspense fallback={null}>
      <RolloutPage
        key={`${user.id}:${rolloutId}`}
        id={rolloutId}
        user={user}
        notify={notify}
        navigate={navigate}
      />
    </Suspense>
  ) : (
    <AgentUpdatesList user={user} notify={notify} navigate={navigate} />
  );
}

type Query = { search: string; status: string; page: number };

function AgentUpdatesList({
  user,
  notify,
  navigate,
}: {
  user: User;
  notify: Notify;
  navigate(path: string): void;
}) {
  const operate = can(user, "operate");
  const admin = can(user, "admin");
  const [query, setQuery] = useState<Query>({
    search: "",
    status: "all",
    page: 1,
  });
  const [search, setSearch] = useState("");
  const state = useAgentUpdates(0, POLL);
  const updates = state.updates;
  const on = updates?.enabled === true;
  const live = (updates?.active_rollouts ?? 0) > 0;
  const releases = useResource<AgentRelease[]>(
    on ? "/agent-releases" : null,
    [],
    0,
    { interval: live ? LIVE_POLL : POLL },
  );
  const params = new URLSearchParams({
    page: String(query.page),
    page_size: "12",
  });
  if (query.search) params.set("search", query.search);
  if (query.status !== "all") params.set("status", query.status);
  const rollouts = useResource<UpdateRolloutPage>(
    on ? `/agent-update-rollouts?${params}` : null,
    { items: [], total: 0, page: query.page, page_size: 12 },
    0,
    { interval: live ? LIVE_POLL : POLL },
  );
  const [review, setReview] = useState<{
    releaseId: string;
  } | null>(null);
  const [prepare, setPrepare] = useState<string | null>(null);
  const [withdraw, setWithdraw] = useState<AgentRelease | null>(null);
  const [stopping, setStopping] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const remember = (element: HTMLElement | null) => {
    opener.current = element;
  };

  function reloadAll() {
    void state.reload();
    void releases.reload();
    void rollouts.reload();
  }
  const fleet = fleetView(updates?.fleet);
  const stopped = updates?.stopped ?? null;
  const startable = releases.data.filter(releaseStartable);
  const waiting = releases.data.filter(
    (release) => release.state === "awaiting_signature",
  );
  const earlier = releases.data.filter(
    (release) => release.state === "withdrawn" || release.expired,
  );
  const current = releases.data.filter(
    (release) => release.state !== "withdrawn" && !release.expired,
  );

  function open(release: AgentRelease, element?: HTMLElement | null) {
    remember(element ?? null);
    setReview({ releaseId: release.id });
  }

  return (
    <div className="control-page update-page">
      <PageHeader
        title="Agent updates"
        help={{ topic: "agent-updates" }}
        description="Roll out a signed agent build to hosts that agreed to it. A device counts as updated only when it checks in on the new build."
        live={{
          updatedAt: state.updatedAt,
          error: state.error || undefined,
          loading: state.loading,
          refreshing: state.refreshing,
          onRefresh: reloadAll,
        }}
      >
        {on && operate && !stopped && (
          <Button
            variant="danger-ghost"
            icon={OctagonX}
            onClick={(event) => {
              remember(event.currentTarget);
              setStopping(true);
            }}
          >
            Stop all updates
          </Button>
        )}
      </PageHeader>
      {state.error && (
        <InlineError
          title={
            updates
              ? "Couldn't refresh agent updates."
              : "Couldn't load agent updates."
          }
          error={state.error}
          updatedAt={state.updatedAt}
          retry={() => void state.reload()}
          retrying={state.refreshing}
        />
      )}
      {state.loading && !updates ? (
        <section
          className="control-card update-card"
          aria-busy="true"
          aria-label="Loading agent updates"
        >
          <Skeleton width={220} height={18} />
          <Skeleton width="70%" height={12} />
        </section>
      ) : updates && !on ? (
        <TableCard>
          <EmptyState
            icon={CircleArrowUp}
            title="Agent updates are off"
            action={
              admin ? (
                <Button
                  icon={ArrowRight}
                  onClick={() => navigate("agent-updates-settings")}
                >
                  Turn on agent updates…
                </Button>
              ) : undefined
            }
          >
            Devices run the agent they have until someone upgrades it on the
            host.{" "}
            {admin
              ? "Turn updates on in Settings, choose who holds the release key, and add or upgrade hosts with their consent."
              : "An administrator turns them on in Settings."}
          </EmptyState>
        </TableCard>
      ) : (
        updates && (
          <>
            {stopped && (
              <div className="update-stop" role="status">
                <div>
                  <strong>All agent updates are stopped</strong>
                  <p>
                    {stopped.by_name ? `${stopped.by_name}, ` : ""}
                    <DateCell value={stopped.at} />: “{stopped.reason}”. No
                    update rollout can start until an administrator clears the
                    stop.
                  </p>
                </div>
                {admin && (
                  <a
                    className="button secondary"
                    href="#/agent-updates-settings"
                    onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey)
                        return;
                      event.preventDefault();
                      navigate("agent-updates-settings");
                    }}
                  >
                    Clear the stop in Settings
                  </a>
                )}
              </div>
            )}

            <section
              className="control-card update-card"
              aria-labelledby="update-fleet"
            >
              <div className="update-card-head">
                <div>
                  <h2 id="update-fleet">Your fleet</h2>
                  <p>
                    {fleet
                      ? `${fleet.total.toLocaleString()} ${devices(fleet.total)}, as their agents last reported. Choose a count to see those devices.`
                      : "The server didn't send fleet counts."}
                  </p>
                </div>
              </div>
              {fleet && (
                <div className="update-fleet">
                  <div>
                    <h3>Agent versions</h3>
                    <ul className="update-versions" aria-label="Agent versions">
                      {fleet.versions.map((entry) => (
                        <li key={entry.version}>
                          <a href={versionHref(entry.version)}>
                            <strong>
                              {entry.known ? entry.version : "Unknown version"}
                            </strong>
                            <span>
                              {entry.devices.toLocaleString()}{" "}
                              {devices(entry.devices)}
                            </span>
                          </a>
                        </li>
                      ))}
                      {fleet.versions.length === 0 && (
                        <li className="control-muted">
                          No agent has reported a version yet.
                        </li>
                      )}
                    </ul>
                  </div>
                  <div>
                    <h3>How hosts take updates</h3>
                    <ul
                      className="update-levels"
                      aria-label="How hosts take updates"
                    >
                      {fleet.levels.map((level) => (
                        <li key={level.key}>
                          <a
                            href={levelHref(level.key)}
                            title={levelHints[level.key]}
                          >
                            <strong>{level.devices.toLocaleString()}</strong>
                            <span>{level.label}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </section>

            <section
              className="control-card update-card"
              aria-labelledby="update-builds"
            >
              <div className="update-card-head">
                <div>
                  <h2 id="update-builds">Newer builds</h2>
                  <p>
                    Builds in this server&apos;s catalog that some device
                    doesn&apos;t run yet. Rolling one out prepares a release,
                    which hosts verify against the key they pin.
                  </p>
                </div>
              </div>
              {updates.catalog && updates.catalog.length > 0 ? (
                <ul className="update-catalog">
                  {updates.catalog.map((entry) => (
                    <CatalogRow
                      key={entry.version}
                      entry={entry}
                      admin={admin}
                      operate={operate}
                      stopped={!!stopped}
                      onPrepare={(element) => {
                        remember(element);
                        setPrepare(entry.version);
                      }}
                      onRollOut={(releaseId, element) => {
                        remember(element);
                        setReview({ releaseId });
                      }}
                      onSign={(releaseId) =>
                        document
                          .getElementById(`release-${releaseId}`)
                          ?.scrollIntoView({ block: "start" })
                      }
                    />
                  ))}
                </ul>
              ) : (
                <p className="control-muted">
                  No build in this server&apos;s catalog is newer than the
                  agents the fleet reports.
                </p>
              )}
            </section>

            <section
              className="update-section"
              aria-labelledby="update-releases"
            >
              <div className="control-section-head">
                <div>
                  <h2 id="update-releases">Releases</h2>
                  <p>
                    A release is a build with its counter, its expiry and the
                    signature hosts verify. Only a signed, unexpired one can
                    start a rollout.
                  </p>
                </div>
              </div>
              {releases.error && (
                <InlineError
                  title="Couldn't load the releases."
                  error={releases.error}
                  updatedAt={releases.updatedAt}
                  retry={() => void releases.reload()}
                  retrying={releases.refreshing}
                />
              )}
              {releases.loading && releases.data.length === 0 ? (
                <Skeleton height={90} />
              ) : releases.data.length === 0 && !releases.error ? (
                <p className="control-muted">
                  No release has been prepared yet. Roll out a build above to
                  prepare one.
                </p>
              ) : (
                <div className="update-releases">
                  {[
                    ...waiting,
                    ...current.filter((r) => r.state !== "awaiting_signature"),
                  ].map((release) => (
                    <ReleaseCard
                      key={release.id}
                      release={release}
                      updates={updates}
                      admin={admin}
                      operate={operate && !stopped}
                      onReview={(item) => open(item)}
                      onWithdraw={(item, element) => {
                        remember(element);
                        setWithdraw(item);
                      }}
                      onChanged={(message) => {
                        notify(message, { tone: "success" });
                        reloadAll();
                      }}
                      reload={() => releases.reloadResult()}
                    />
                  ))}
                  {earlier.length > 0 && (
                    <details className="control-disclosure">
                      <summary>
                        Withdrawn and expired releases ({earlier.length})
                      </summary>
                      <div className="update-releases">
                        {earlier.map((release) => (
                          <ReleaseCard
                            key={release.id}
                            release={release}
                            updates={updates}
                            admin={admin}
                            operate={false}
                            onReview={() => undefined}
                            onWithdraw={(item, element) => {
                              remember(element);
                              setWithdraw(item);
                            }}
                            onChanged={() => reloadAll()}
                            reload={() => releases.reloadResult()}
                          />
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </section>

            <section
              className="update-section"
              aria-labelledby="update-rollouts"
            >
              <div className="control-section-head">
                <div>
                  <h2 id="update-rollouts">Update rollouts</h2>
                  <p>
                    Each starts with a canary, releases the rest in batches and
                    counts a device as updated only from what it reports after
                    the restart.
                  </p>
                </div>
                {operate && !stopped && startable.length > 0 && (
                  <Button
                    icon={Rocket}
                    onClick={(event) => open(startable[0], event.currentTarget)}
                  >
                    New update rollout
                  </Button>
                )}
              </div>
              <PageToolbar
                search={
                  <SearchBox
                    value={search}
                    onChange={(value) => {
                      setSearch(value);
                      setQuery((old) => ({
                        ...old,
                        search: value.trim(),
                        page: 1,
                      }));
                    }}
                    maxLength={200}
                    placeholder="Search update rollouts"
                  />
                }
                count={
                  rollouts.updatedAt
                    ? `${rollouts.data.total.toLocaleString()} ${rollouts.data.total === 1 ? "rollout" : "rollouts"}`
                    : undefined
                }
                filters={
                  <label className="deployment-mobile-filter">
                    <span className="sr-only">Status</span>
                    <select
                      value={query.status}
                      onChange={(event) =>
                        setQuery((old) => ({
                          ...old,
                          status: event.target.value,
                          page: 1,
                        }))
                      }
                    >
                      <option value="all">All statuses</option>
                      {Object.entries(updateRolloutStatuses).map(
                        ([value, entry]) => (
                          <option key={value} value={value}>
                            {entry.label}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                }
              />
              <TableCard className="control-table">
                <DataTable<UpdateRollout>
                  label="Update rollouts"
                  className="update-rollout-table"
                  data={rollouts.data.items}
                  rowKey={(row) => row.id}
                  loading={rollouts.loading}
                  error={
                    rollouts.error
                      ? {
                          title: rollouts.updatedAt
                            ? "Couldn't refresh update rollouts."
                            : "Couldn't load update rollouts.",
                          message: rollouts.error,
                          updatedAt: rollouts.updatedAt,
                          retry: () => void rollouts.reload(),
                          retrying: rollouts.refreshing,
                        }
                      : null
                  }
                  manualSorting
                  pagination={{
                    page: query.page,
                    size: rollouts.data.page_size,
                    total: rollouts.data.total,
                    onPage: (page) => setQuery((old) => ({ ...old, page })),
                    noun: "rollouts",
                  }}
                  mobileCard={(row) => {
                    const counts = updateCounts(row);
                    return {
                      title: (
                        <a
                          className="control-row-title"
                          href={`#/agent-updates/${encodeURIComponent(row.id)}`}
                        >
                          {rolloutTitle(row)}
                        </a>
                      ),
                      status: (
                        <StatusBadge
                          domain="updateRollout"
                          value={row.status}
                        />
                      ),
                      meta: [
                        `Agent ${row.release.version}`,
                        counts.sentence,
                        rolloutEnding(row),
                      ],
                    };
                  }}
                  columns={[
                    {
                      id: "name",
                      header: "Rollout",
                      cell: (row) => (
                        <>
                          <a
                            className="control-row-title"
                            href={`#/agent-updates/${encodeURIComponent(row.id)}`}
                            onClick={(event) => {
                              if (
                                event.button !== 0 ||
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey
                              )
                                return;
                              event.preventDefault();
                              navigate(`agent-updates/${row.id}`);
                            }}
                          >
                            {rolloutTitle(row)}
                          </a>
                          <small>
                            Agent {row.release.version} ·{" "}
                            {strategyText(row.rollout)}
                          </small>
                        </>
                      ),
                    },
                    {
                      id: "status",
                      header: "Status",
                      cell: (row) => (
                        <span className="deployment-status-cell">
                          <StatusBadge
                            domain="updateRollout"
                            value={row.status}
                          />
                          {rolloutEnding(row) && (
                            <small>{rolloutEnding(row)}</small>
                          )}
                        </span>
                      ),
                    },
                    {
                      id: "devices",
                      header: "Devices",
                      cell: (row) => (
                        <div className="deployment-devices-cell">
                          <span>{updateCounts(row).sentence}</span>
                          {row.target_count > 0 && (
                            <ProgressBar
                              segments={updateSegments(
                                row.state_counts,
                                row.degraded,
                                !isLiveRollout(row.status),
                              )}
                              variant="mini"
                              label="Device progress"
                            />
                          )}
                        </div>
                      ),
                    },
                    {
                      id: "created",
                      header: "Created",
                      cell: (row) => <DateCell value={row.created_at} />,
                    },
                  ]}
                  empty={
                    <EmptyState
                      variant={
                        query.search || query.status !== "all"
                          ? "filtered"
                          : "first-run"
                      }
                      title={
                        query.search || query.status !== "all"
                          ? "No matching update rollouts"
                          : "No update rollouts yet"
                      }
                    >
                      {query.search || query.status !== "all"
                        ? "Try another search or status."
                        : "Roll out a newer build above, or start one from a release."}
                    </EmptyState>
                  }
                />
              </TableCard>
            </section>
          </>
        )
      )}

      {stopping && updates && (
        <StopAllDialog
          updates={updates}
          reload={() =>
            state.reloadResult() as Promise<typeof updates | undefined>
          }
          onDone={(message) => {
            setStopping(false);
            notify(message, { tone: "success" });
            reloadAll();
          }}
          onClose={() => setStopping(false)}
          returnFocusRef={opener}
        />
      )}
      {prepare && updates && (
        <PrepareDialog
          version={prepare}
          updates={updates}
          readReleases={() => releases.reloadResult()}
          onDone={(release) => {
            setPrepare(null);
            notify(
              release.state === "ready"
                ? `Agent ${release.version} is prepared and signed. Choose the devices to update.`
                : `Agent ${release.version} is prepared. It waits for your signature below.`,
              { tone: "success" },
            );
            reloadAll();
            if (releaseStartable(release)) setReview({ releaseId: release.id });
            else
              requestAnimationFrame(() =>
                document
                  .getElementById(`release-${release.id}`)
                  ?.scrollIntoView({ block: "start" }),
              );
          }}
          onClose={() => setPrepare(null)}
          returnFocusRef={opener}
        />
      )}
      {withdraw && (
        <WithdrawDialog
          release={withdraw}
          readReleases={() => releases.reloadResult()}
          onDone={() => {
            notify(`Agent ${withdraw.version} was withdrawn.`, {
              tone: "success",
            });
            setWithdraw(null);
            reloadAll();
          }}
          onClose={() => setWithdraw(null)}
          returnFocusRef={opener}
        />
      )}
      {review && updates && startable.length > 0 && (
        <Suspense fallback={null}>
          <ReviewDialog
            user={user}
            releases={startable}
            initialReleaseId={
              startable.some((item) => item.id === review.releaseId)
                ? review.releaseId
                : startable[0].id
            }
            updates={updates}
            returnFocusRef={opener}
            onClose={() => setReview(null)}
            onStarted={(rollout) => {
              setReview(null);
              notify("Update rollout started. Its canary is released first.", {
                tone: "success",
              });
              navigate(`agent-updates/${rollout.id}`);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

/* ---------- Builds the catalog has and some devices don't run ---------- */

function CatalogRow({
  entry,
  admin,
  operate,
  stopped,
  onPrepare,
  onRollOut,
  onSign,
}: {
  entry: CatalogEntry;
  admin: boolean;
  operate: boolean;
  stopped: boolean;
  onPrepare(element: HTMLElement): void;
  onRollOut(releaseId: string, element: HTMLElement): void;
  onSign(releaseId: string): void;
}) {
  const action = catalogAction(entry);
  const label = `Roll out agent ${entry.version}`;
  return (
    <li>
      <div>
        <strong>Agent {entry.version}</strong>
        <small>
          {entry.platforms.map(platformName).join(", ")} ·{" "}
          {entry.devices_behind.toLocaleString()}{" "}
          {devices(entry.devices_behind)} run an older version
        </small>
      </div>
      <div className="update-catalog-state">
        {action.kind === "sign" ? (
          <StatusBadge domain="updateRelease" value="awaiting_signature" />
        ) : action.kind === "start" ? (
          <StatusBadge domain="updateRelease" value="ready" />
        ) : (
          <span className="control-muted">No release yet</span>
        )}
        {action.kind === "sign" && (
          <Button
            variant="secondary compact"
            onClick={() => onSign(action.releaseId)}
          >
            Sign it
          </Button>
        )}
        {action.kind === "prepare" &&
          (admin ? (
            <Button
              variant="secondary compact"
              onClick={(event) => onPrepare(event.currentTarget)}
            >
              {label}
            </Button>
          ) : (
            <small className="control-muted">
              An administrator prepares it first.
            </small>
          ))}
        {action.kind === "start" && operate && !stopped && (
          <Button
            variant="secondary compact"
            onClick={(event) =>
              onRollOut(action.releaseId, event.currentTarget)
            }
          >
            {label}
          </Button>
        )}
        {action.kind === "start" && stopped && (
          <small className="control-muted">Updates are stopped.</small>
        )}
      </div>
    </li>
  );
}
