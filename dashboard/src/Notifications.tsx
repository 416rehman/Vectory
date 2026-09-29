import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  Bell,
  BellRing,
  Check,
  ChevronDown,
  Gauge,
  History,
  KeyRound,
  Mail,
  Plus,
  RotateCcw,
  Search,
  Send,
  Trash2,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  APIError,
  api,
  can,
  withRequestDeadline,
  type Group,
  type PipelineLibraryPage,
  type User,
} from "./api";
import { DataTable, TableCard } from "./DataTable";
import PermissionNote from "./PermissionNote";
import type { Notify } from "./toast";
import {
  Button,
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  PageToolbar,
  QuickFilters,
  Select,
  Skeleton,
  StatusBadge,
  TimeAgo,
  useResource,
  type LiveState,
} from "./ui";
import {
  attemptLabel,
  attemptOutcomes,
  attemptView,
  channelRequest,
  channelStatus,
  destination,
  draftFromChannel,
  eventLabel,
  filtersSummary,
  newDraft,
  notificationEvents,
  OFFLINE_MINUTES,
  rulesSummary,
  sameThresholds,
  thresholdErrors,
  thresholdForm,
  thresholdHint,
  thresholdUnit,
  thresholdValues,
  timeZones,
  validateDraft,
  detectionFields,
  type Attempt,
  type AttemptOutcome,
  type AttemptPage,
  type Channel,
  type ChannelDraft,
  type ChannelList,
  type Detection,
  type DraftErrors,
  type Preview,
  type SecretField,
  type TestResult,
  type ThresholdForm,
} from "./notificationsModel";
import "./control.css";
import "./notifications.css";

type View = "channels" | "delivery" | "detection";
const views: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "channels", label: "Channels", icon: BellRing },
  { id: "delivery", label: "Delivery log", icon: History },
  { id: "detection", label: "Detection", icon: Gauge },
];
const PAGE_SIZE = 25;
/** The server accepts at most this many pipelines or groups per filter. */
const MAX_FILTER_IDS = 50;

/** Settings → Notifications: channels, their delivery log and detection. */
export default function Notifications({
  user,
  notify,
  query,
}: {
  user: User;
  notify: Notify;
  /** The route's query string: view, and the delivery log's filters. */
  query: string;
}) {
  const params = new URLSearchParams(query);
  const view: View =
    (["delivery", "detection"] as const).find(
      (v) => v === params.get("view"),
    ) ?? "channels";
  const admin = can(user, "admin");
  const channels = useResource<ChannelList | null>(
    admin ? "/notifications/channels" : null,
    null,
  );
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; channel: Channel } | null
  >(null);
  const opener = useRef<HTMLElement | null>(null);
  const tests = useChannelTests(notify, () => void channels.reload());
  const items = channels.data?.items ?? [];
  const full = items.length >= (channels.data?.max_channels ?? 20);
  function openCreate(target: HTMLElement) {
    opener.current = target;
    setDialog({ mode: "create" });
  }
  const [live, setLive] = useState<LiveState | undefined>(undefined);
  const channelsLive: LiveState = {
    updatedAt: channels.updatedAt,
    error: channels.error || undefined,
    loading: channels.loading,
    refreshing: channels.refreshing,
    onRefresh: () => void channels.reload(),
  };
  const headerAction =
    admin && view === "channels" && items.length > 0 ? (
      <Button
        icon={Plus}
        disabled={full}
        title={full ? "Remove a channel to add another" : undefined}
        onClick={(event) => openCreate(event.currentTarget)}
      >
        Add channel
      </Button>
    ) : undefined;
  return (
    <div className="control-page notifications-page">
      <PageHeader
        title="Notifications"
        description="Tell people when something needs them: issues, failed rollouts and offline devices, in Slack, any webhook or email."
        help={{ topic: "notifications" }}
        live={view === "channels" ? (admin ? channelsLive : undefined) : live}
      >
        {headerAction}
      </PageHeader>
      <nav className="notifications-views" aria-label="Notification sections">
        {views.map((item) => (
          <a
            key={item.id}
            href={`#/notifications${item.id === "channels" ? "" : `?view=${item.id}`}`}
            aria-current={view === item.id ? "page" : undefined}
            onClick={(event) => {
              // Unsaved threshold edits get the same question as leaving the page.
              if (
                item.id !== view &&
                !window.dispatchEvent(
                  new Event("vectory:before-navigate", { cancelable: true }),
                )
              )
                event.preventDefault();
            }}
          >
            <span className="tab-label">
              <item.icon size={15} aria-hidden="true" />
              <span>{item.label}</span>
            </span>
          </a>
        ))}
      </nav>
      {view === "detection" ? (
        <DetectionView user={user} notify={notify} onLive={setLive} />
      ) : !admin ? (
        <PermissionNote
          user={user}
          needs="admin"
          action={
            view === "delivery"
              ? "Reading the delivery log"
              : "Managing notification channels"
          }
        />
      ) : view === "delivery" ? (
        <DeliveryView params={params} channels={items} onLive={setLive} />
      ) : (
        <ChannelsView
          list={channels}
          tests={tests}
          onCreate={openCreate}
          onEdit={(channel, target) => {
            opener.current = target;
            setDialog({ mode: "edit", channel });
          }}
        />
      )}
      {dialog && admin && (
        <ChannelDialog
          key={dialog.mode === "edit" ? dialog.channel.id : "create"}
          channel={dialog.mode === "edit" ? dialog.channel : undefined}
          tests={tests}
          returnFocusRef={opener}
          onClose={() => setDialog(null)}
          onSaved={(saved, created) => {
            setDialog(null);
            void channels.reload();
            notify(
              created
                ? `${saved.name} is set up. Send a test message to check it.`
                : `${saved.name} saved.`,
              { tone: "success" },
            );
          }}
          onRemoved={(removed) => {
            setDialog(null);
            void channels.reload();
            notify(`${removed.name} removed. It sends nothing more.`, {
              tone: "success",
            });
          }}
        />
      )}
    </div>
  );
}

/* ---------- Channels ---------- */

/** A channel that is on and whose saved secrets this server can read. */
const testable = (channel: Channel) =>
  channel.enabled && channel.secrets_readable;
type ChannelTests = ReturnType<typeof useChannelTests>;
/**
 * One test at a time per channel. The message says what the receiver did,
 * from the server's own attempt, never an assumed success.
 */
function useChannelTests(notify: Notify, onDone: () => void) {
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const running = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(channel: Channel) {
    if (running.current.has(channel.id)) return;
    running.current.add(channel.id);
    setTesting((t) => ({ ...t, [channel.id]: true }));
    try {
      // The server gives up on a receiver after 10 seconds.
      const result = await withRequestDeadline(
        (signal) =>
          api<TestResult>(
            `/notifications/channels/${encodeURIComponent(channel.id)}/test`,
            { method: "POST", body: "{}", signal },
          ),
        25000,
      );
      if (result.delivered)
        notify(
          `Test delivered to ${channel.name}: answered ${result.status_code ?? "OK"} in ${result.latency_ms.toLocaleString()} ms.`,
          { tone: "success" },
        );
      else
        notify(
          `Test to ${channel.name} failed. ${result.error || "The receiver didn't accept it."}`,
          { tone: "error" },
        );
    } catch (e) {
      notify(
        e instanceof APIError && e.code === "RATE_LIMITED"
          ? `${channel.name} sent several tests just now. ${e.message}`
          : `Couldn't send a test to ${channel.name}. ${(e as Error).message}`,
        { tone: "error" },
      );
    } finally {
      running.current.delete(channel.id);
      if (mounted.current) {
        setTesting((t) => ({ ...t, [channel.id]: false }));
        onDone();
      }
    }
  }
  return { testing, run };
}

function ChannelsView({
  list,
  tests,
  onCreate,
  onEdit,
}: {
  list: ReturnType<typeof useResource<ChannelList | null>>;
  tests: ChannelTests;
  onCreate(target: HTMLElement): void;
  onEdit(channel: Channel, target: HTMLElement): void;
}) {
  const items = list.data?.items ?? [];
  const firstRun = !list.loading && !list.error && items.length === 0;
  if (firstRun)
    return (
      <TableCard>
        <EmptyState
          icon={Bell}
          title="No notification channels yet"
          action={
            <Button
              icon={Plus}
              onClick={(event) => onCreate(event.currentTarget)}
            >
              Add channel
            </Button>
          }
          learnMore={{
            topic: "notifications",
            label: "How notifications work",
          }}
        >
          Get a message in Slack, any webhook or email when an issue opens, a
          rollout fails or a device goes offline.
        </EmptyState>
      </TableCard>
    );
  const now = Date.now();
  return (
    <TableCard className="notifications-table">
      <DataTable<Channel>
        data={items}
        rowKey={(channel) => channel.id}
        label="Notification channels"
        loading={list.loading}
        skeletonRows={3}
        error={
          list.error
            ? {
                title: list.updatedAt
                  ? "Couldn't refresh channels."
                  : "Couldn't load channels.",
                message: list.error,
                updatedAt: list.updatedAt,
                retry: () => void list.reload(),
                retrying: list.refreshing,
              }
            : null
        }
        mobileCard={(channel) => {
          const status = channelStatus(channel, now);
          return {
            leading: <KindIcon channel={channel} />,
            title: channel.name,
            meta: [
              destination(channel),
              rulesSummary(channel.rules),
              status.detail,
            ],
            status: (
              <StatusBadge
                tone={status.tone}
                label={status.label}
                description={status.detail}
              />
            ),
          };
        }}
        onRowClick={(channel, event) =>
          onEdit(channel, event.currentTarget as HTMLElement)
        }
        columns={[
          {
            id: "name",
            header: "Channel",
            value: (channel) => channel.name,
            cell: (channel) => (
              <span className="notifications-channel">
                <KindIcon channel={channel} />
                <span className="notifications-channel-copy">
                  <strong>{channel.name}</strong>
                  <small>
                    {channel.kind === "email" ? "Email" : "Webhook"} ·{" "}
                    {destination(channel)}
                  </small>
                </span>
              </span>
            ),
          },
          {
            id: "rules",
            header: "Sends",
            cell: (channel) => {
              const filters = filtersSummary(channel.rules);
              return (
                <span className="notifications-rules">
                  <span>{rulesSummary(channel.rules)}</span>
                  {filters && <small>{filters}</small>}
                </span>
              );
            },
          },
          {
            id: "status",
            header: "Status",
            value: (channel) => channelStatus(channel, now).label,
            cell: (channel) => {
              const status = channelStatus(channel, now);
              return (
                <span className="notifications-status">
                  <StatusBadge tone={status.tone} label={status.label} />
                  <small title={status.detail}>{status.detail}</small>
                </span>
              );
            },
          },
          {
            id: "actions",
            header: <span className="sr-only">Actions</span>,
            label: "Actions",
            cell: (channel) => (
              <span className="notifications-actions">
                {/* An off channel sends nothing, tests included; its status says so. */}
                {testable(channel) && (
                  <Button
                    variant="secondary compact"
                    icon={Send}
                    busy={!!tests.testing[channel.id]}
                    onClick={() => void tests.run(channel)}
                  >
                    {tests.testing[channel.id] ? "Sending…" : "Send test"}
                  </Button>
                )}
                <Button
                  variant="ghost compact"
                  aria-label={`Edit ${channel.name}`}
                  onClick={(event) => onEdit(channel, event.currentTarget)}
                >
                  Edit
                </Button>
              </span>
            ),
          },
        ]}
      />
    </TableCard>
  );
}
function KindIcon({ channel }: { channel: Channel }) {
  const Icon = channel.kind === "email" ? Mail : Webhook;
  return (
    <span
      className="notifications-kind"
      data-kind={channel.kind}
      aria-hidden="true"
    >
      <Icon size={15} />
    </span>
  );
}

/* ---------- Add and edit ---------- */

function ChannelDialog({
  channel,
  tests,
  returnFocusRef,
  onClose,
  onSaved,
  onRemoved,
}: {
  channel?: Channel;
  tests: ChannelTests;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onClose(): void;
  onSaved(channel: Channel, created: boolean): void;
  onRemoved(channel: Channel): void;
}) {
  const [initial] = useState<ChannelDraft>(() =>
    channel ? draftFromChannel(channel) : newDraft(),
  );
  const [draft, setDraft] = useState<ChannelDraft>(initial);
  // A test sends with the saved settings, so it's offered only without edits.
  const changed =
    JSON.stringify(channelRequest(draft)) !==
    JSON.stringify(channelRequest(initial));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const mounted = useRef(true);
  // Typed settings are worth a question before Escape, a click outside or
  // leaving the page throws them away. Cancel is the deliberate way out.
  const dirty = useRef(false);
  dirty.current = changed;
  const discard = () =>
    !dirty.current || window.confirm("Discard your changes to this channel?");
  useEffect(() => {
    mounted.current = true;
    const guard = (event: Event) => {
      if (!discard()) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("vectory:before-navigate", guard);
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      window.removeEventListener("vectory:before-navigate", guard);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  const errors = validateDraft(draft);
  const shown: DraftErrors = submitted ? errors : {};
  const set = <K extends keyof ChannelDraft>(key: K, value: ChannelDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const zones = useMemo(() => timeZones(), []);
  const groups = useResource<Group[]>("/groups", [], 0, { interval: 300000 });
  // Pipelines come a page at a time; a search asks the server for matches.
  const [pipelineSearch, setPipelineSearch] = useState("");
  const [pipelineQuery, setPipelineQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(
      () => setPipelineQuery(pipelineSearch.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [pipelineSearch]);
  const pipelines = useResource<PipelineLibraryPage>(
    `/configurations/library?${new URLSearchParams({
      state: "all",
      sort: "name",
      page: "1",
      page_size: "50",
      ...(pipelineQuery ? { search: pipelineQuery } : {}),
    })}`,
    { items: [], total: 0, page: 1, page_size: 50 },
    0,
    { interval: 300000 },
  );
  // Names seen in any page, so chosen pipelines keep their names while searching.
  const pipelineNames = useRef(new Map<string, string>());
  for (const pipeline of pipelines.data.items)
    pipelineNames.current.set(pipeline.id, pipeline.name);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (busy || Object.keys(errors).length) return;
    setBusy(true);
    setError("");
    try {
      const body = channelRequest(draft, channel?.revision);
      const saved = await withRequestDeadline(
        (signal) =>
          api<Channel>(
            channel
              ? `/notifications/channels/${encodeURIComponent(channel.id)}`
              : "/notifications/channels",
            {
              method: channel ? "PUT" : "POST",
              body: JSON.stringify(body),
              signal,
            },
          ),
        30000,
      );
      if (
        channel &&
        (saved.id !== channel.id || saved.revision !== channel.revision + 1)
      )
        throw Error(
          "The response didn't confirm this edit. Close the dialog and check the channel before editing again.",
        );
      if (mounted.current) onSaved(saved, !channel);
    } catch (e) {
      if (!mounted.current) return;
      setError(
        e instanceof APIError && e.code === "STALE_REVISION"
          ? "Someone changed this channel while you edited it. Close the dialog and open it again to see their changes."
          : (e as Error).message,
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function remove() {
    if (!channel || busy) return;
    setBusy(true);
    setError("");
    try {
      await withRequestDeadline(
        (signal) =>
          api(`/notifications/channels/${encodeURIComponent(channel.id)}`, {
            method: "DELETE",
            signal,
          }),
        30000,
      );
      if (mounted.current) onRemoved(channel);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const webhook = draft.kind === "webhook";
  return (
    <Modal
      open
      size="xl"
      className="notifications-dialog"
      returnFocusRef={returnFocusRef}
      onClose={() => {
        if (!busy && discard()) onClose();
      }}
      title={channel ? `Edit ${channel.name}` : "Add a notification channel"}
      description={
        channel
          ? "Saved secrets stay saved unless you replace or remove them."
          : "Choose where messages go and what they're about. Send a test once it's saved."
      }
    >
      <form onSubmit={save} noValidate>
        <div className="modal-body notifications-dialog-body">
          <div className="notifications-form">
            {error && <ErrorBox message={error} />}
            {channel && !channel.secrets_readable && (
              <p className="notifications-callout" data-tone="danger">
                This channel's saved secrets can't be read with this instance's
                keys. Enter them again to use it.
              </p>
            )}
            <section aria-labelledby="notification-destination">
              <h3 id="notification-destination">Destination</h3>
              <Field label="Name" hint={shown.name}>
                <input
                  value={draft.name}
                  maxLength={80}
                  placeholder="On-call Slack"
                  aria-invalid={!!shown.name || undefined}
                  onChange={(e) => set("name", e.target.value)}
                />
              </Field>
              {!channel && (
                <div
                  className="notifications-kind-choice"
                  role="radiogroup"
                  aria-label="Channel type"
                >
                  {(
                    [
                      [
                        "webhook",
                        Webhook,
                        "Webhook",
                        "Slack, or any HTTPS receiver that takes JSON",
                      ],
                      [
                        "email",
                        Mail,
                        "Email",
                        "Plain-text email through your SMTP server",
                      ],
                    ] as const
                  ).map(([kind, Icon, label, hint]) => (
                    <label key={kind} className="notifications-kind-option">
                      <input
                        type="radio"
                        name="kind"
                        checked={draft.kind === kind}
                        onChange={() => set("kind", kind)}
                      />
                      <Icon size={18} aria-hidden="true" />
                      <span>
                        <strong>{label}</strong>
                        <small>{hint}</small>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {webhook ? (
                <>
                  <SecretInput
                    label="Webhook URL"
                    field={draft.url}
                    savedText={channel?.webhook?.url_hint}
                    canKeep={initial.url.state === "keep"}
                    required
                    type="url"
                    placeholder="https://hooks.slack.com/services/…"
                    hint={
                      shown.url ??
                      "For Slack, create an incoming webhook and paste its URL. It's kept secret: only its host is shown after saving."
                    }
                    invalid={!!shown.url}
                    onChange={(field) => set("url", field)}
                  />
                  <SecretInput
                    label="Signing secret (optional)"
                    field={draft.signingSecret}
                    canKeep={initial.signingSecret.state === "keep"}
                    placeholder="At least 16 characters"
                    hint={
                      shown.signingSecret ??
                      "Receivers check the X-Vectory-Signature header with it. Slack doesn't need one."
                    }
                    invalid={!!shown.signingSecret}
                    onChange={(field) => set("signingSecret", field)}
                  />
                  <div className="notifications-pair">
                    <Field label="Header (optional)" hint={shown.headerName}>
                      <input
                        value={draft.headerName}
                        placeholder="Authorization"
                        maxLength={64}
                        aria-invalid={!!shown.headerName || undefined}
                        onChange={(e) => set("headerName", e.target.value)}
                      />
                    </Field>
                    <SecretInput
                      label="Header value"
                      field={draft.headerValue}
                      canKeep={initial.headerValue.state === "keep"}
                      placeholder="Bearer …"
                      disabled={!draft.headerName.trim()}
                      hint={
                        shown.headerValue ??
                        (draft.headerValue.state === "keep" &&
                        !draft.headerName.trim()
                          ? "Without a header name, the saved value goes too."
                          : undefined)
                      }
                      invalid={!!shown.headerValue}
                      onChange={(field) => set("headerValue", field)}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="notifications-pair notifications-pair-port">
                    <Field label="SMTP server" hint={shown.host}>
                      <input
                        value={draft.host}
                        placeholder="smtp.example.com"
                        aria-invalid={!!shown.host || undefined}
                        onChange={(e) => set("host", e.target.value)}
                      />
                    </Field>
                    <Field label="Port" hint={shown.port}>
                      <input
                        inputMode="numeric"
                        value={draft.port}
                        aria-invalid={!!shown.port || undefined}
                        onChange={(e) => set("port", e.target.value)}
                      />
                    </Field>
                  </div>
                  <Field
                    label="Security"
                    hint={
                      shown.security ??
                      "Vectory never sends unencrypted email to another host."
                    }
                  >
                    <Select
                      value={draft.security}
                      aria-invalid={!!shown.security || undefined}
                      onChange={(e) => {
                        const security = e.target
                          .value as ChannelDraft["security"];
                        setDraft((d) => ({
                          ...d,
                          security,
                          port: ["587", "465", "25", ""].includes(d.port)
                            ? security === "tls"
                              ? "465"
                              : security === "none"
                                ? "25"
                                : "587"
                            : d.port,
                        }));
                      }}
                    >
                      <option value="starttls">
                        STARTTLS (usually port 587)
                      </option>
                      <option value="tls">TLS (usually port 465)</option>
                      <option value="none">
                        None: a relay on this server only
                      </option>
                    </Select>
                  </Field>
                  <div className="notifications-pair">
                    <Field label="User name (optional)">
                      <input
                        value={draft.username}
                        autoComplete="off"
                        onChange={(e) => set("username", e.target.value)}
                      />
                    </Field>
                    <SecretInput
                      label="Password"
                      field={draft.password}
                      canKeep={initial.password.state === "keep"}
                      disabled={!draft.username.trim()}
                      hint={
                        shown.password ??
                        (draft.password.state === "keep" &&
                        !draft.username.trim()
                          ? "Without a user name, the saved password goes too."
                          : undefined)
                      }
                      invalid={!!shown.password}
                      onChange={(field) => set("password", field)}
                    />
                  </div>
                  <Field label="From" hint={shown.from}>
                    <input
                      value={draft.from}
                      placeholder="Vectory <alerts@example.com>"
                      aria-invalid={!!shown.from || undefined}
                      onChange={(e) => set("from", e.target.value)}
                    />
                  </Field>
                  <Field
                    label="To"
                    hint={
                      shown.to ?? "Up to 10 addresses, separated by commas."
                    }
                  >
                    <input
                      value={draft.to}
                      placeholder="oncall@example.com"
                      aria-invalid={!!shown.to || undefined}
                      onChange={(e) => set("to", e.target.value)}
                    />
                  </Field>
                </>
              )}
              <label className="notifications-check">
                <input
                  type="checkbox"
                  checked={draft.allowPrivate}
                  onChange={(e) => set("allowPrivate", e.target.checked)}
                />
                <span>
                  <strong>Allow private network addresses</strong>
                  <small>
                    For a receiver on your own network (10.x, 192.168.x,
                    localhost). Cloud metadata and link-local addresses stay
                    blocked.
                  </small>
                </span>
              </label>
            </section>
            <section aria-labelledby="notification-events">
              <h3 id="notification-events">What to send</h3>
              {shown.events && (
                <p className="notifications-field-error" role="alert">
                  {shown.events}
                </p>
              )}
              <ul className="notifications-events">
                {notificationEvents.map((event) => {
                  const checked = draft.events.includes(event.value);
                  return (
                    <li key={event.value}>
                      <label className="notifications-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            set(
                              "events",
                              e.target.checked
                                ? [...draft.events, event.value]
                                : draft.events.filter((v) => v !== event.value),
                            )
                          }
                        />
                        <span>
                          <strong>{event.label}</strong>
                          <small>{event.description}</small>
                        </span>
                      </label>
                      {event.value === "device.offline" && checked && (
                        <label className="notifications-inline-number">
                          <span>After</span>
                          <input
                            inputMode="numeric"
                            value={draft.offlineMinutes}
                            aria-label="Minutes offline before a message"
                            aria-invalid={!!shown.offlineMinutes || undefined}
                            onChange={(e) =>
                              set("offlineMinutes", e.target.value)
                            }
                          />
                          <span>minutes</span>
                          {shown.offlineMinutes && (
                            <small className="notifications-field-error">
                              {shown.offlineMinutes}
                            </small>
                          )}
                        </label>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="notifications-filters">
                <Field label="Severity">
                  <Select
                    value={draft.errorsOnly ? "error" : "warning"}
                    onChange={(e) =>
                      set("errorsOnly", e.target.value === "error")
                    }
                  >
                    <option value="warning">Errors and warnings</option>
                    <option value="error">Errors only</option>
                  </Select>
                </Field>
                <FilterPicker
                  label="Pipelines"
                  allLabel="All pipelines"
                  noun="pipeline"
                  options={pipelines.data.items.map((p) => ({
                    id: p.id,
                    name: p.name,
                  }))}
                  names={pipelineNames.current}
                  selected={draft.pipelineIds}
                  loading={pipelines.loading}
                  error={pipelines.error}
                  onRetry={() => void pipelines.reload()}
                  search={pipelineSearch}
                  onSearch={setPipelineSearch}
                  more={
                    pipelines.data.total > pipelines.data.items.length
                      ? `Showing ${pipelines.data.items.length} of ${pipelines.data.total.toLocaleString()}. Search to find others.`
                      : undefined
                  }
                  onChange={(ids) => set("pipelineIds", ids)}
                />
                <FilterPicker
                  label="Groups"
                  allLabel="All groups"
                  noun="group"
                  options={groups.data.map((g) => ({ id: g.id, name: g.name }))}
                  selected={draft.groupIds}
                  loading={groups.loading}
                  error={groups.error}
                  onRetry={() => void groups.reload()}
                  onChange={(ids) => set("groupIds", ids)}
                />
              </div>
            </section>
            <section aria-labelledby="notification-quiet">
              <h3 id="notification-quiet">Quiet hours</h3>
              <label className="toggle-row notifications-toggle">
                <span>
                  <strong>Hold messages overnight</strong>
                  <small>
                    What arrives during quiet hours goes out as one summary when
                    they end.
                  </small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={draft.quiet}
                  onChange={(e) => set("quiet", e.target.checked)}
                />
              </label>
              {draft.quiet && (
                <div className="notifications-quiet">
                  <div className="notifications-pair notifications-pair-times">
                    <Field label="From" hint={shown.quietStart}>
                      <input
                        type="time"
                        value={draft.quietStart}
                        aria-invalid={!!shown.quietStart || undefined}
                        onChange={(e) => set("quietStart", e.target.value)}
                      />
                    </Field>
                    <Field label="Until">
                      <input
                        type="time"
                        value={draft.quietEnd}
                        onChange={(e) => set("quietEnd", e.target.value)}
                      />
                    </Field>
                    <Field label="Time zone" hint={shown.timeZone}>
                      <Select
                        value={draft.timeZone}
                        onChange={(e) => set("timeZone", e.target.value)}
                      >
                        {zones.map((zone) => (
                          <option key={zone} value={zone}>
                            {zone.replaceAll("_", " ")}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <label className="notifications-check">
                    <input
                      type="checkbox"
                      checked={draft.errorsBypass}
                      onChange={(e) => set("errorsBypass", e.target.checked)}
                    />
                    <span>
                      <strong>Let errors through</strong>
                      <small>
                        Failed rollouts and error issues arrive at once;
                        warnings and recoveries wait.
                      </small>
                    </span>
                  </label>
                </div>
              )}
            </section>
            {channel && (
              <section aria-labelledby="notification-state">
                <h3 id="notification-state">State</h3>
                <label className="toggle-row notifications-toggle">
                  <span>
                    <strong>Channel on</strong>
                    <small>
                      Turning it off drops messages still waiting to go out.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.enabled}
                    onChange={(e) => set("enabled", e.target.checked)}
                  />
                </label>
              </section>
            )}
          </div>
          <PreviewPanel
            kind={draft.kind}
            name={draft.name}
            events={draft.events}
          />
        </div>
        <div className="modal-footer notifications-dialog-footer">
          <span className="notifications-dialog-start">
            {channel &&
              (confirmRemove ? (
                <span
                  className="notifications-remove-confirm"
                  role="group"
                  aria-label="Remove channel"
                >
                  <span>
                    Remove {channel.name}? Waiting messages are dropped.
                  </span>
                  <Button
                    variant="ghost compact"
                    disabled={busy}
                    onClick={() => setConfirmRemove(false)}
                  >
                    Keep
                  </Button>
                  <Button
                    variant="danger compact"
                    busy={busy}
                    onClick={() => void remove()}
                  >
                    Remove
                  </Button>
                </span>
              ) : (
                <Button
                  variant="danger-ghost compact"
                  icon={Trash2}
                  disabled={busy}
                  className="notifications-remove"
                  onClick={() => setConfirmRemove(true)}
                >
                  Remove channel
                </Button>
              ))}
            {channel && testable(channel) && !changed && !confirmRemove && (
              <Button
                variant="secondary compact"
                icon={Send}
                busy={!!tests.testing[channel.id]}
                disabled={busy}
                className="notifications-dialog-test"
                onClick={() => void tests.run(channel)}
              >
                {tests.testing[channel.id] ? "Sending…" : "Send test"}
              </Button>
            )}
          </span>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" busy={busy && !confirmRemove} disabled={busy}>
            {channel ? "Save changes" : "Add channel"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * A write-only value: typed once, then shown as saved with Replace and
 * Remove. Focus follows each switch, so a keyboard never lands on nothing.
 */
function SecretInput({
  label,
  field,
  onChange,
  savedText,
  canKeep = false,
  hint,
  invalid,
  required = false,
  disabled = false,
  type = "password",
  placeholder,
}: {
  label: string;
  field: SecretField;
  onChange(field: SecretField): void;
  savedText?: string;
  /** A value is saved, so a replacement can be abandoned. */
  canKeep?: boolean;
  hint?: string;
  invalid?: boolean;
  required?: boolean;
  disabled?: boolean;
  type?: "password" | "url";
  placeholder?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const undo = useRef<HTMLButtonElement>(null);
  const replace = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<"input" | "undo" | "replace" | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next) ({ input, undo, replace })[next].current?.focus();
  }, [field.state]);
  const change = (next: SecretField, focus: typeof focusNext.current) => {
    focusNext.current = focus;
    onChange(next);
  };
  if (field.state === "keep" || field.state === "remove")
    return (
      <div className="field notifications-secret">
        <span id={`${id}-label`}>{label}</span>
        <div
          className="notifications-secret-saved"
          aria-labelledby={`${id}-label`}
          role="group"
        >
          {field.state === "keep" && disabled ? (
            // What it belongs to is gone (a header name, a user name).
            <StatusBadge tone="warning" icon="alert" label="Removed on save" />
          ) : field.state === "keep" ? (
            <>
              <StatusBadge tone="success" icon="check" label="Saved" />
              {savedText && <code>{savedText}</code>}
              <span className="notifications-secret-actions">
                <Button
                  ref={replace}
                  variant="ghost compact"
                  icon={KeyRound}
                  onClick={() => change({ state: "set", value: "" }, "input")}
                >
                  Replace
                </Button>
                {!required && (
                  <Button
                    variant="ghost compact"
                    icon={X}
                    onClick={() => change({ state: "remove" }, "undo")}
                  >
                    Remove
                  </Button>
                )}
              </span>
            </>
          ) : (
            <>
              <StatusBadge
                tone="warning"
                icon="alert"
                label="Removed on save"
              />
              <Button
                ref={undo}
                variant="ghost compact"
                icon={RotateCcw}
                onClick={() => change({ state: "keep" }, "replace")}
              >
                Undo
              </Button>
            </>
          )}
        </div>
        {hint && <small>{hint}</small>}
      </div>
    );
  const value = field.state === "set" ? field.value : "";
  return (
    <div className="field notifications-secret">
      <label htmlFor={`${id}-input`}>{label}</label>
      <span className="notifications-secret-edit">
        <input
          ref={input}
          id={`${id}-input`}
          type={type}
          value={value}
          disabled={disabled}
          required={required}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) =>
            change(
              e.target.value || required || canKeep
                ? { state: "set", value: e.target.value }
                : { state: "none" },
              null,
            )
          }
        />
        {canKeep && (
          <Button
            variant="ghost compact"
            icon={RotateCcw}
            onClick={() => change({ state: "keep" }, "replace")}
          >
            Keep saved
          </Button>
        )}
      </span>
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}

/** Choose none (everything) or some pipelines or groups. */
function FilterPicker({
  label,
  allLabel,
  noun,
  options,
  names,
  selected,
  loading,
  error,
  onRetry,
  search,
  onSearch,
  more,
  onChange,
}: {
  label: string;
  allLabel: string;
  noun: string;
  options: { id: string; name: string }[];
  /** Names of chosen items the current options may not include. */
  names?: ReadonlyMap<string, string>;
  selected: string[];
  loading: boolean;
  /** A failed read: said as such, never as "none yet". */
  error?: string;
  onRetry?(): void;
  /** Searched by the server: the options are already the matches. */
  search?: string;
  onSearch?(text: string): void;
  /** Said under the list when it doesn't hold every item. */
  more?: string;
  onChange(ids: string[]): void;
}) {
  const id = useId();
  const [localSearch, setLocalSearch] = useState("");
  const text = (onSearch ? (search ?? "") : localSearch).trim();
  const setText = (value: string) =>
    onSearch ? onSearch(value) : setLocalSearch(value);
  const nameOf = (value: string) =>
    options.find((o) => o.id === value)?.name ?? names?.get(value);
  const needle = text.toLocaleLowerCase();
  const matches = onSearch
    ? options
    : options.filter((o) => o.name.toLocaleLowerCase().includes(needle));
  const listed = new Set(matches.map((o) => o.id));
  // Chosen items outside this page stay listed, so they can be cleared.
  const chosenElsewhere = selected
    .filter((value) => !listed.has(value))
    .map((value) => ({
      id: value,
      name: nameOf(value) ?? `A ${noun} chosen earlier`,
    }))
    .filter((o) => !needle || o.name.toLocaleLowerCase().includes(needle));
  const shown = [...chosenElsewhere, ...matches];
  const full = selected.length >= MAX_FILTER_IDS;
  const summary = selected.length
    ? selected.length === 1
      ? (nameOf(selected[0]) ?? `1 ${noun}`)
      : `${selected.length} ${noun}s`
    : allLabel;
  const searchable = !!onSearch || options.length > 6;
  return (
    <div className="field notifications-picker">
      <span id={`${id}-label`}>{label}</span>
      <Popover.Root onOpenChange={(open) => !open && setText("")}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="notifications-picker-trigger"
            aria-labelledby={`${id}-label ${id}-value`}
          >
            <span id={`${id}-value`}>{summary}</span>
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="notifications-picker-menu"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            aria-label={`Choose ${label.toLocaleLowerCase()}`}
          >
            {searchable && (
              <label className="notifications-picker-search">
                <Search size={14} aria-hidden="true" />
                <input
                  value={onSearch ? (search ?? "") : localSearch}
                  maxLength={100}
                  placeholder={`Find a ${noun}…`}
                  aria-label={`Find a ${noun}`}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
            )}
            <div
              className="notifications-picker-options"
              role="group"
              aria-label={label}
              aria-busy={loading || undefined}
            >
              {loading && !shown.length ? (
                <Skeleton width="70%" height={12} />
              ) : shown.length ? (
                shown.map((option) => {
                  const checked = selected.includes(option.id);
                  return (
                    <label
                      key={option.id}
                      className="notifications-picker-option"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && full}
                        onChange={() =>
                          onChange(
                            checked
                              ? selected.filter((s) => s !== option.id)
                              : [...selected, option.id],
                          )
                        }
                      />
                      <span>{option.name}</span>
                      {checked && <Check size={14} aria-hidden="true" />}
                    </label>
                  );
                })
              ) : error ? (
                <p className="notifications-picker-error" role="alert">
                  Couldn't load {noun}s.{" "}
                  {onRetry && (
                    <button type="button" onClick={onRetry}>
                      Try again
                    </button>
                  )}
                </p>
              ) : (
                <p className="control-muted">
                  {text ? `No ${noun}s match.` : `No ${noun}s yet.`}
                </p>
              )}
            </div>
            {(full || more) && (
              <p className="notifications-picker-note">
                {full
                  ? `That's the most one channel can follow: ${MAX_FILTER_IDS} ${noun}s.`
                  : more}
              </p>
            )}
            {selected.length > 0 && (
              <button
                type="button"
                className="notifications-picker-clear"
                onClick={() => onChange([])}
              >
                Send about all {noun}s
              </button>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <small>
        {selected.length
          ? `Only events about ${selected.length === 1 ? `this ${noun}` : `these ${noun}s`}.`
          : `Events about every ${noun}.`}
      </small>
    </div>
  );
}

/** The server renders an example with placeholder names, so what you see is what's sent. */
function PreviewPanel({
  kind,
  name,
  events,
}: {
  kind: "webhook" | "email";
  name: string;
  events: string[];
}) {
  const choices = notificationEvents.filter((e) => events.includes(e.value));
  const [type, setType] = useState<string>(choices[0]?.value ?? "issue.opened");
  const active = choices.some((c) => c.value === type)
    ? type
    : (choices[0]?.value ?? "issue.opened");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      withRequestDeadline(
        (signal) =>
          api<Preview>("/notifications/preview", {
            method: "POST",
            body: JSON.stringify({
              type: active,
              name: name.trim().slice(0, 80),
            }),
            signal,
          }),
        15000,
        controller.signal,
      )
        .then((result) => {
          setPreview(result);
          setFailed(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, name]);
  const event = preview?.webhook.event;
  // A recovery reads as good news whatever the problem's severity was.
  const severity =
    event?.recovery === true
      ? "resolved"
      : typeof event?.severity === "string"
        ? event.severity
        : "warning";
  return (
    <aside className="notifications-preview" aria-label="Message preview">
      <div className="notifications-preview-head">
        <h3>Preview</h3>
        {choices.length > 1 && (
          <Select
            value={active}
            aria-label="Event to preview"
            onChange={(e) => setType(e.target.value)}
          >
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        )}
      </div>
      <p className="notifications-preview-note">
        An example: the names are placeholders.
      </p>
      {failed && !preview ? (
        <p className="control-muted">The preview isn't available right now.</p>
      ) : !preview ? (
        <div className="notifications-preview-card" aria-hidden="true">
          <Skeleton width="80%" height={13} />
          <Skeleton width="95%" height={11} />
          <Skeleton width="60%" height={11} />
        </div>
      ) : kind === "email" ? (
        <div className="notifications-preview-card notifications-preview-email">
          <p className="notifications-preview-subject">
            <span>Subject</span> {preview.email.subject}
          </p>
          <pre>{preview.email.body}</pre>
        </div>
      ) : (
        <div className="notifications-preview-card" data-severity={severity}>
          <p className="notifications-preview-app">
            <span className="notifications-preview-avatar" aria-hidden="true">
              V
            </span>
            <strong>Vectory</strong>
          </p>
          <p className="notifications-preview-headline">{preview.headline}</p>
          <p className="notifications-preview-message">{preview.message}</p>
          <p className="notifications-preview-context">{preview.context}</p>
          {preview.link ? (
            <span className="notifications-preview-button">
              Open in Vectory
            </span>
          ) : (
            <p className="notifications-preview-hint">
              Set VECTORY_PUBLIC_URL to add an Open in Vectory button.
            </p>
          )}
        </div>
      )}
      <p className="notifications-preview-foot">
        {kind === "email"
          ? "Plain text, with a link to Vectory when its public address is set."
          : "Slack shows the message; other receivers read the event object in the same body."}
      </p>
    </aside>
  );
}

/* ---------- Delivery log ---------- */

function DeliveryView({
  params,
  channels,
  onLive,
}: {
  params: URLSearchParams;
  channels: Channel[];
  onLive(live: LiveState): void;
}) {
  const channel = params.get("channel") || "";
  const outcome = (attemptOutcomes.find(
    (o) => o.value === params.get("outcome"),
  )?.value ?? "") as AttemptOutcome | "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  function go(next: { channel?: string; outcome?: string; page?: number }) {
    const merged = new URLSearchParams({ view: "delivery" });
    const values = { channel, outcome, page, ...next };
    if (values.channel) merged.set("channel", values.channel);
    if (values.outcome) merged.set("outcome", values.outcome);
    if (values.page && values.page > 1) merged.set("page", String(values.page));
    // Filters replace the entry rather than piling up history.
    history.replaceState(history.state, "", `#/notifications?${merged}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(PAGE_SIZE),
  });
  if (channel) query.set("channel_id", channel);
  if (outcome) query.set("outcome", outcome);
  const log = useResource<AttemptPage>(`/notifications/deliveries?${query}`, {
    items: [],
    total: 0,
    page: 1,
    page_size: PAGE_SIZE,
  });
  useEffect(() => {
    onLive({
      updatedAt: log.updatedAt,
      error: log.error || undefined,
      loading: log.loading,
      refreshing: log.refreshing,
      onRefresh: () => void log.reload(),
    });
  }, [log.updatedAt, log.error, log.loading, log.refreshing]);
  const timeText = (at: string) =>
    new Date(at).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  const filtered = !!(channel || outcome);
  return (
    <>
      <PageToolbar
        count={
          log.loading && !log.updatedAt
            ? undefined
            : `${log.data.total.toLocaleString()} ${log.data.total === 1 ? "attempt" : "attempts"}`
        }
        filters={
          <QuickFilters
            label="Result"
            value={outcome}
            options={attemptOutcomes.map((o) => ({
              value: o.value,
              label: o.label,
            }))}
            onChange={(value) => go({ outcome: value, page: 1 })}
          />
        }
      >
        <Select
          value={channel}
          aria-label="Channel"
          className="notifications-channel-filter"
          onChange={(e) => go({ channel: e.target.value, page: 1 })}
        >
          <option value="">All channels</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </PageToolbar>
      <TableCard className="notifications-log">
        <DataTable<Attempt>
          data={log.data.items}
          rowKey={(a) => String(a.id)}
          label="Delivery log"
          loading={log.loading}
          manualSorting
          error={
            log.error
              ? {
                  title: log.updatedAt
                    ? "Couldn't refresh the delivery log."
                    : "Couldn't load the delivery log.",
                  message: log.error,
                  updatedAt: log.updatedAt,
                  retry: () => void log.reload(),
                  retrying: log.refreshing,
                }
              : null
          }
          pagination={{
            page,
            size: PAGE_SIZE,
            total: log.data.total,
            onPage: (next) => go({ page: next }),
            noun: "attempts",
          }}
          mobileCard={(attempt) => {
            const view = attemptView(attempt, timeText);
            return {
              title: attempt.title || eventLabel(attempt.type || ""),
              meta: [
                attempt.channel_name ?? "Removed channel",
                <TimeAgo key="at" value={attempt.at} />,
                view.detail,
              ],
              status: <StatusBadge tone={view.tone} label={view.label} />,
            };
          }}
          columns={[
            {
              id: "at",
              header: "When",
              sortable: false,
              width: 130,
              cell: (attempt) => (
                <span className="notifications-time">
                  <TimeAgo value={attempt.at} />
                </span>
              ),
            },
            {
              id: "channel",
              header: "Channel",
              sortable: false,
              cell: (attempt) =>
                attempt.channel_exists ? (
                  attempt.channel_name
                ) : (
                  <span className="control-muted">
                    {attempt.channel_name ?? "Channel"} (removed)
                  </span>
                ),
            },
            {
              id: "message",
              header: "Message",
              sortable: false,
              className: "notifications-message-cell",
              cell: (attempt) => (
                <span className="notifications-message">
                  <small>{eventLabel(attempt.type || attempt.kind)}</small>
                  <span>{attempt.title}</span>
                </span>
              ),
            },
            {
              id: "attempt",
              header: "Attempt",
              sortable: false,
              width: 90,
              cell: (attempt) => (
                <span className="notifications-attempt">
                  {attemptLabel(attempt)}
                </span>
              ),
            },
            {
              id: "result",
              header: "Result",
              sortable: false,
              className: "notifications-result-cell",
              cell: (attempt) => {
                const view = attemptView(attempt, timeText);
                return (
                  <span className="notifications-status">
                    <StatusBadge tone={view.tone} label={view.label} />
                    <small title={view.detail}>{view.detail}</small>
                  </span>
                );
              },
            },
          ]}
          empty={
            filtered ? (
              <EmptyState
                variant="filtered"
                title="No matching attempts"
                action={
                  <Button
                    variant="secondary"
                    onClick={() => go({ channel: "", outcome: "", page: 1 })}
                  >
                    Clear filters
                  </Button>
                }
              >
                Try another channel or result.
              </EmptyState>
            ) : (
              <EmptyState
                icon={History}
                title="Nothing sent yet"
                variant="quiet"
              >
                Every message and test shows up here with its result, for 30
                days.
              </EmptyState>
            )
          }
        />
      </TableCard>
    </>
  );
}

/* ---------- Detection ---------- */

function DetectionView({
  user,
  notify,
  onLive,
}: {
  user: User;
  notify: Notify;
  onLive(live: LiveState): void;
}) {
  const admin = can(user, "admin");
  const detection = useResource<Detection | null>("/detection", null, 0, {
    interval: 60000,
  });
  const data = detection.data;
  const [form, setForm] = useState<ThresholdForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onLive({
      updatedAt: detection.updatedAt,
      error: detection.error || undefined,
      loading: detection.loading,
      refreshing: detection.refreshing,
      onRefresh: () => void detection.reload(),
    });
  }, [
    detection.updatedAt,
    detection.error,
    detection.loading,
    detection.refreshing,
  ]);
  const current = data ? thresholdForm(data.thresholds) : null;
  const values = form ?? current;
  const errors = values && data ? thresholdErrors(values, data) : {};
  const valid = !Object.keys(errors).length;
  const dirty =
    !!values &&
    !!data &&
    valid &&
    !sameThresholds(thresholdValues(values), data.thresholds);
  const atDefaults =
    !!values &&
    !!data &&
    valid &&
    sameThresholds(thresholdValues(values), data.defaults);
  // Any typed change, valid or not, is worth a question before it's lost.
  const edited = useRef(false);
  edited.current =
    !!form &&
    !!current &&
    detectionFields.some((f) => form[f.key].trim() !== current[f.key]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (
        edited.current &&
        !window.confirm("Discard your unsaved threshold changes?")
      )
        event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!edited.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("vectory:before-navigate", guard);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("vectory:before-navigate", guard);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!data || !values || !valid || !dirty || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await withRequestDeadline(
        (signal) =>
          api<Detection>("/detection", {
            method: "PUT",
            body: JSON.stringify({
              thresholds: thresholdValues(values),
              revision: data.revision,
            }),
            signal,
          }),
        30000,
      );
      if (!mounted.current) return;
      setForm(null);
      await detection.reload();
      notify(
        sameThresholds(saved.thresholds, saved.defaults)
          ? "Detection is back on the defaults. It applies from each device's next check."
          : "Detection thresholds saved. They apply from each device's next check.",
        { tone: "success" },
      );
    } catch (e) {
      if (!mounted.current) return;
      setError(
        e instanceof APIError && e.code === "STALE_REVISION"
          ? "Someone else changed these thresholds. Review their values, then save yours again."
          : (e as Error).message,
      );
      if (e instanceof APIError && e.code === "STALE_REVISION") {
        setForm(null);
        void detection.reload();
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  if (!data)
    return detection.error ? (
      <ErrorBox
        message={detection.error}
        retry={() => void detection.reload()}
      />
    ) : (
      <section
        className="control-card notifications-thresholds"
        aria-busy="true"
      >
        {detectionFields.map((f) => (
          <div key={f.key} className="notifications-threshold">
            <Skeleton width="40%" height={13} />
            <Skeleton width={140} height={32} />
          </div>
        ))}
      </section>
    );
  return (
    <form
      onSubmit={save}
      className="control-card notifications-thresholds"
      noValidate
    >
      <div className="notifications-thresholds-head">
        <div>
          <h2>Delivery problems</h2>
          <p>
            Vectory checks each device's metrics as they arrive, at most every{" "}
            {data.evaluation_interval_seconds} seconds per device. These numbers
            decide when that opens an issue and when a canary may move on.
          </p>
        </div>
        {!admin && (
          <StatusBadge
            tone="neutral"
            icon="dot"
            label="Administrators change these"
          />
        )}
      </div>
      {error && <ErrorBox message={error} />}
      <div className="notifications-threshold-list">
        {detectionFields.map((field) => {
          const value = values?.[field.key] ?? "";
          const id = `threshold-${field.key}`;
          return (
            <div key={field.key} className="notifications-threshold">
              <div className="notifications-threshold-copy">
                <label htmlFor={id}>{field.label}</label>
                <p id={`${id}-description`}>{field.description}</p>
              </div>
              <div className="notifications-threshold-input">
                <span className="notifications-threshold-control">
                  <input
                    id={id}
                    inputMode="numeric"
                    value={value}
                    disabled={!admin || busy}
                    aria-invalid={!!errors[field.key] || undefined}
                    aria-describedby={`${id}-description ${id}-hint`}
                    onChange={(e) =>
                      setForm({
                        ...(values as ThresholdForm),
                        [field.key]: e.target.value,
                      })
                    }
                  />
                  <span>{thresholdUnit(field, value)}</span>
                </span>
                <small
                  id={`${id}-hint`}
                  data-error={errors[field.key] ? "" : undefined}
                >
                  {errors[field.key] ?? thresholdHint(field, value, data)}
                </small>
              </div>
            </div>
          );
        })}
      </div>
      <div className="notifications-thresholds-foot">
        <p className="control-muted">
          {data.updated_at ? (
            <>
              Changed by {data.updated_by_name ?? "an administrator"}{" "}
              <TimeAgo value={data.updated_at} />.
            </>
          ) : (
            "Using the defaults."
          )}
        </p>
        {admin && (
          <span className="notifications-thresholds-actions">
            <Button
              type="button"
              variant="secondary"
              icon={RotateCcw}
              disabled={busy || atDefaults}
              onClick={() => setForm(thresholdForm(data.defaults))}
            >
              Reset to defaults
            </Button>
            <Button type="submit" busy={busy} disabled={busy || !dirty}>
              Save changes
            </Button>
          </span>
        )}
      </div>
    </form>
  );
}
