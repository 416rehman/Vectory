import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Clock, Repeat2, Search } from "lucide-react";
import {
  api,
  boundedPost as post,
  withRequestDeadline,
  type AssignmentDescription,
  type BindingSuggestions,
  type Deployment,
  type DeploymentPreview,
  type Device,
  type GroupSummary,
  type Policy,
  type Version,
} from "./api";
import { Button, CopyButton, ErrorBox, Field, Modal, useResource } from "./ui";
import DocLink from "./DocLink";
import DevicePicker from "./DevicePicker";
import { readMatchingIds } from "./deviceInventory";
import { DataTable } from "./DataTable";
import { deploymentRoute } from "./deploymentRouting";
import { assertDeploymentReceipt } from "./deploymentReceipt";
import { DeploymentRecoveryDialog } from "./DeploymentRecovery";
import { DeploymentStorageRecoveryDialog } from "./DeploymentStorageRecovery";
import DeploymentVariableFields from "./DeploymentVariableFields";
import {
  resolveVariableBindings,
  type BindingInputs,
} from "./deploymentVariables";
import {
  beginDeploymentOperation,
  finishDeploymentOperation,
  readDeploymentRegistry,
  setDeploymentRequestActive,
  type DeploymentOperation,
  type DeploymentStorageIssue,
} from "./deploymentRequests";
import { releasePlan } from "./deploymentStatus";
import { deviceDisplayStatus, statusLabel, type StatusTone } from "./status";
import { shortDigest } from "./enrollmentCommands";
import {
  allowancesFile,
  fullModeRequirements,
  hasHostApprovals,
  hostApprovals,
  type AgentCatalog,
} from "./hostRequirements";
import {
  AssignmentLink,
  ConflictTable,
  CopyDetails,
  OutcomeChip,
  ReleaseStrategyFields,
} from "./DeploymentReview";
import {
  assignmentMeta,
  conflictRows,
  defaultRelease,
  devicesText,
  keptLine,
  inferPipelineName,
  localInputValue,
  pauseSource,
  policySummary,
  releaseErrors,
  requestedName,
  reviewHeadline,
  rolloutFor,
  runningName,
  scheduledAt,
  shortAssignmentName,
  startsIn,
  technicalDetails,
  usesCanary,
  type ReleaseSettings,
  type RequestedChange,
} from "./deploymentReviewModel";
import "./control.css";
import "./target-dialog.css";

type PreviewBlocker = NonNullable<DeploymentPreview["blockers"]>[number];
function blockerTitle(code: string): string {
  switch (code) {
    case "ACTIVE_CANARY_OVERLAP":
      return "An active canary overlaps these devices";
    case "FULL_VECTOR_MODE_REQUIRED":
      return "Full Vector mode is required on these devices";
    case "VECTOR_VERSION_INCOMPATIBLE":
      return "These devices have an incompatible Vector version";
    default:
      return "Deployment blocked for these devices";
  }
}
function blockerRowLabel(code: string): string {
  switch (code) {
    case "ACTIVE_CANARY_OVERLAP":
      return "Active canary overlaps";
    case "FULL_VECTOR_MODE_REQUIRED":
      return "Full Vector mode required";
    case "VECTOR_VERSION_INCOMPATIBLE":
      return "Vector version incompatible";
    default:
      return "Deployment blocked";
  }
}
/**
 * A restricted host refuses destinations, listeners and paths it hasn't
 * approved. Say which ones this version uses, and hand over the exact
 * allowances file and commands for the host.
 */
function HostApprovalNote({
  approvals,
  devices,
}: {
  approvals: ReturnType<typeof hostApprovals>;
  devices: Device[];
}) {
  const parts = [
    approvals.destinations.length
      ? `${approvals.destinations.length === 1 ? "destination" : "destinations"} ${approvals.destinations.join(", ")}`
      : "",
    approvals.listeners.length
      ? `${approvals.listeners.length === 1 ? "listener" : "listeners"} ${approvals.listeners.join(", ")}`
      : "",
    approvals.fileRoots.length
      ? `files under ${approvals.fileRoots.join(", ")}`
      : "",
  ].filter(Boolean);
  const hostSteps = [
    "sudo vectory service-stop",
    "sudo tee /etc/vectory/allowances.json <<'EOF'",
    allowancesFile(approvals),
    "EOF",
    "sudo vectory install --capability-policy /etc/vectory/allowances.json",
    "sudo vectory service-start",
  ].join("\n");
  return (
    <div className="control-note target-approval-note" role="status">
      <strong>
        {devices.length === 1
          ? `${devices[0].name} runs`
          : `${devices.length} selected devices run`}{" "}
        in restricted mode and refuse this version until their host approves it
      </strong>
      <p>
        It uses {parts.join("; ")}. Only the host operator can allow these; the
        dashboard can&apos;t.
      </p>
      <details className="target-approval-steps">
        <summary>Commands for the host</summary>
        <p>
          Run these on each restricted host. The file replaces the host&apos;s
          current allowances, so keep anything it already allows.
        </p>
        <pre tabIndex={0} aria-label="Host approval commands">
          <code>{hostSteps}</code>
        </pre>
        <CopyButton
          text={hostSteps}
          label="Copy commands"
          copiedMessage="Host commands copied."
        />
      </details>
    </div>
  );
}

/**
 * Which components a restricted device accepts. The 99 KB catalog is read
 * only when this dialog opens, so it is not part of any page's download.
 * "failed" means it could not be read: nothing can be declared safe then.
 */
function useAgentCatalog() {
  const [catalog, setCatalog] = useState<AgentCatalog | "failed" | null>(null);
  useEffect(() => {
    let live = true;
    import("./generated/vector-catalog.json").then(
      (module) => live && setCatalog(module.default),
      () => live && setCatalog("failed"),
    );
    return () => {
      live = false;
    };
  }, []);
  return catalog;
}
function statusText(device: Device) {
  const label = statusLabel("device", deviceDisplayStatus(device));
  return device.status === "offline"
    ? `${label}, applies when it reconnects`
    : label;
}
function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
/** Worth a second line in the review: anything but a healthy, idle device. */
function notable(device: Device) {
  return !["verified", "unmanaged", "online"].includes(device.status);
}

/** What the request changes and the assignments it may take over. */
type Inputs = {
  replaces: string[];
  priority: number;
  mode: string;
  declined: boolean;
};
type Reviewed = DeploymentPreview & {
  request: Record<string, any>;
  key: string;
};
/** A same-pipeline (or pause) replacement adopted by default, and what it changed. */
type Adoption = {
  assignments: AssignmentDescription[];
  previousPriority: number;
  previousMode: string;
};
type Outcome = {
  label: string;
  tone: StatusTone;
  detail: string | null;
  /** The assignment involved, when the server identifies it. */
  link: { id: string; label: string } | null;
  /** Whether the device ends up with this request. */
  takes: boolean;
};

/** Rows kept by name for devices seen while choosing; the oldest go first. */
const KNOWN_ROWS = 2000;
/** Devices named in the opening selection whose rows are read one by one. */
const OPENING_ROWS = 25;
/** Groups listed at once; a search narrows the rest. */
const GROUPS_SHOWN = 50;
/** Devices a device-specific value can be typed for. */
const VALUE_ROWS = 500;

export default function TargetDialog({
  userId,
  open,
  onClose,
  version,
  policy,
  onDone,
  initialDeviceIds = [],
  initialDevices = [],
  preserveExistingSettings = false,
  pipelineName,
  initialStrategy,
  policyId,
  policyName,
}: {
  userId: string;
  open: boolean;
  onClose: () => void;
  version?: Version;
  policy?: Policy;
  onDone: (message: string) => void;
  initialDeviceIds?: string[];
  /** Rows the caller already has for `initialDeviceIds`. */
  initialDevices?: Device[];
  preserveExistingSettings?: boolean;
  /** The pipeline's display name, when the caller knows it. */
  pipelineName?: string;
  /** Preselects a release strategy (the Schedules page starts on Scheduled). */
  initialStrategy?: ReleaseSettings["strategy"];
  /** Saved agent settings being applied; recorded for attribution. */
  policyId?: string;
  policyName?: string;
}) {
  const [initialRegistry] = useState(() => readDeploymentRegistry(userId));
  const [storageIssue, setStorageIssue] =
    useState<DeploymentStorageIssue | null>(initialRegistry.errors[0] || null);
  const [recovery, setRecovery] = useState<DeploymentOperation | null>(
    initialRegistry.operations[0] || null,
  );
  // Groups by name and member count; their members are read when one is chosen.
  const groups = useResource<GroupSummary[]>("/groups?slim=1", [], 0, {
    interval: 60000,
  });
  // The devices this dialog has seen, by id: the ones picked one by one, the
  // ones it was opened with. A fleet is never held here, only what is chosen.
  const [known, setKnown] = useState<ReadonlyMap<string, Device>>(
    () => new Map(initialDevices.map((device) => [device.id, device])),
  );
  const keepRows = useCallback(
    (rows: Device[]) =>
      setKnown((previous) => {
        const next = new Map(previous);
        for (const row of rows) {
          next.delete(row.id);
          next.set(row.id, row);
        }
        while (next.size > KNOWN_ROWS)
          next.delete(next.keys().next().value as string);
        return next;
      }),
    [],
  );
  const [selected, setSelected] = useState<string[]>(initialDeviceIds),
    [groupIds, setGroupIds] = useState<string[]>([]),
    [exclude, setExclude] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [bindingInputs, setBindingInputs] = useState<BindingInputs>({
      defaults: {},
      devices: {},
    }),
    [release, setRelease] = useState<ReleaseSettings>(() =>
      initialStrategy === "scheduled"
        ? {
            ...defaultRelease,
            strategy: "scheduled",
            schedule: localInputValue(
              Math.ceil((Date.now() + 3600000) / 900000) * 900000,
            ),
          }
        : { ...defaultRelease, strategy: initialStrategy || "all" },
    ),
    [priority, setPriority] = useState(100),
    [priorityTouched, setPriorityTouched] = useState(false),
    [mode, setMode] = useState("snapshot"),
    [modeTouched, setModeTouched] = useState(false),
    [replaces, setReplaces] = useState<string[]>([]),
    [declined, setDeclined] = useState(false),
    [adoption, setAdoption] = useState<Adoption | null>(null),
    [prefill, setPrefill] = useState<{
      values: number;
      devices: number;
      /** "Edge syslog processing v2" when every value came from one version. */
      source: string | null;
    } | null>(null),
    // Missing values are pointed out once someone tries to review.
    [bindingAttempted, setBindingAttempted] = useState(false),
    [busy, setBusy] = useState(false),
    [created, setCreated] = useState<{
      id: string | null;
      scheduled: boolean;
      scheduledAt: string | null;
      status: string;
    } | null>(null),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<Reviewed | null>(null),
    // The review whose devices-left-behind the person accepted; any new
    // review asks again.
    [leftBehindAccepted, setLeftBehindAccepted] = useState<Reviewed | null>(
      null,
    );
  // Callers such as the editor don't pass the pipeline's name; the reviewed
  // preview carries it, so the review never shows a bare "Version 1".
  const knownPipelineName =
    pipelineName || preview?.configuration_name || undefined;
  // A chosen group's members, read once when it is chosen. The server reads
  // the group again when it reviews and sends, so this only counts.
  const [members, setMembers] = useState<
    Record<string, { ids: string[]; truncated: boolean }>
  >({});
  const [membersError, setMembersError] = useState("");
  const groupsLoading = groupIds.some((id) => !(id in members));
  useEffect(() => {
    const wanted = groupIds.filter((id) => !(id in members));
    if (!wanted.length) return;
    const controller = new AbortController();
    for (const id of wanted)
      readMatchingIds({ group: id }, controller.signal).then(
        (found) => {
          if (controller.signal.aborted) return;
          setMembersError("");
          setMembers((previous) => ({
            ...previous,
            [id]: { ids: found.ids, truncated: found.truncated },
          }));
        },
        (failure) => {
          if (!controller.signal.aborted)
            setMembersError(
              `Couldn't read the group's devices. ${(failure as Error).message}`,
            );
        },
      );
    return () => controller.abort();
    // Members are read for groups newly chosen, not again for each change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupIds]);
  const fromGroups = useMemo(
    () => new Set(groupIds.flatMap((id) => members[id]?.ids ?? [])),
    [groupIds, members],
  );
  const excluded = useMemo(() => new Set(exclude), [exclude]);
  const effective = useMemo(() => {
    const ids = new Set<string>();
    for (const id of selected) if (!excluded.has(id)) ids.add(id);
    for (const id of fromGroups) if (!excluded.has(id)) ids.add(id);
    return ids;
  }, [selected, fromGroups, excluded]);
  // The rows known for what is chosen: enough for names, notes and per-device
  // values, never the whole selection when it is large.
  const chosenRows = useMemo(
    () =>
      [...effective].flatMap((id) => {
        const row = known.get(id);
        return row ? [row] : [];
      }),
    [effective, known],
  );
  // Devices the dialog was opened with are named before anything is typed.
  useEffect(() => {
    const missing = initialDeviceIds
      .filter((id) => !known.has(id))
      .slice(0, OPENING_ROWS);
    if (!missing.length) return;
    const controller = new AbortController();
    void Promise.allSettled(
      missing.map((id) =>
        withRequestDeadline(
          (signal) =>
            api<Device>(`/devices/${encodeURIComponent(id)}`, { signal }),
          15000,
          controller.signal,
        ),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      keepRows(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        ),
      );
    });
    return () => controller.abort();
    // Once, for the devices named when the dialog opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const declarations = version?.variables || [];
  const scheduled = release.strategy === "scheduled";
  const persistent = !scheduled && mode === "persistent";
  const bindingResult = useMemo(
    () =>
      resolveVariableBindings(
        declarations,
        bindingInputs,
        [...effective],
        persistent,
      ),
    // The declarations belong to the version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version?.variables, bindingInputs, effective, persistent],
  );
  const releaseProblems = releaseErrors(release);
  const releaseValid = Object.keys(releaseProblems).length === 0;
  function buildBody(inputs: Inputs) {
    return {
      ...(version
        ? { version_id: version.id }
        : { policy, ...(policyId ? { policy_id: policyId } : {}) }),
      selector: {
        device_ids: selected,
        group_ids: groupIds,
        exclude_ids: exclude,
      },
      ...(declarations.length
        ? { variable_bindings: bindingResult.bindings }
        : {}),
      ...(inputs.replaces.length ? { replaces: inputs.replaces } : {}),
      priority: inputs.priority,
      target_mode: scheduled ? "snapshot" : inputs.mode,
      scheduled_at: releaseValid ? scheduledAt(release) : null,
      rollout: rolloutFor(release),
    };
  }
  const inputs: Inputs = { replaces, priority, mode, declined };
  const body = buildBody(inputs);
  const builder = useRef(buildBody);
  builder.current = buildBody;
  const currentBody = useRef("");
  const mounted = useRef(true);
  const currentActor = useRef(userId);
  currentActor.current = userId;
  const inFlight = useRef(false);
  const receiptLink = useRef<HTMLAnchorElement>(null);
  const prefilledKeys = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    const protectRequest = (event: Event) => {
      if (inFlight.current) event.preventDefault();
    };
    const protectUnload = (event: BeforeUnloadEvent) => {
      if (!inFlight.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("vectory:before-navigate", protectRequest);
    window.addEventListener("beforeunload", protectUnload);
    return () => {
      mounted.current = false;
      window.removeEventListener("vectory:before-navigate", protectRequest);
      window.removeEventListener("beforeunload", protectUnload);
    };
  }, []);
  useEffect(() => {
    if (created) receiptLink.current?.focus();
  }, [created]);
  currentBody.current = JSON.stringify(body);

  // Prefill device-specific values from what each device already runs for
  // this pipeline, so shipping a new version doesn't mean retyping them.
  const effectiveKey = [...effective].sort().join(",");
  useEffect(() => {
    if (!version || !declarations.length || !effective.size) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await post<BindingSuggestions>(
          "/deployments/binding-suggestions",
          { version_id: version.id, device_ids: [...effective] },
        );
        if (cancelled || !mounted.current || !result?.devices) return;
        applySuggestions(result);
      } catch {
        // Older servers don't suggest values; the fields stay empty.
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Suggestions follow the version and the device set only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version?.id, effectiveKey]);
  const latestInputs = useRef(bindingInputs);
  latestInputs.current = bindingInputs;
  function applySuggestions(result: BindingSuggestions) {
    const old = latestInputs.current;
    const next: BindingInputs = {
      defaults: { ...old.defaults },
      devices: { ...old.devices },
    };
    const targets = [...effective];
    const applied: string[] = [];
    const touched = new Set<string>();
    for (const declaration of declarations) {
      const name = declaration.name;
      const suggested = targets.map((device) => {
        const value = result.devices[device]?.[name];
        return typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
          ? String(value)
          : null;
      });
      // One value everywhere becomes the default; otherwise per-device values.
      const shared =
        suggested.length > 1 &&
        suggested.every((value) => value !== null && value === suggested[0]);
      if (shared) {
        const key = `default:${name}`;
        if (
          !prefilledKeys.current.has(key) &&
          !Object.prototype.hasOwnProperty.call(next.defaults, name)
        ) {
          applied.push(key);
          next.defaults[name] = suggested[0]!;
          targets.forEach((device) => touched.add(device));
        }
        continue;
      }
      targets.forEach((device, index) => {
        const value = suggested[index];
        const key = `${device}:${name}`;
        if (value === null || prefilledKeys.current.has(key)) return;
        const current = next.devices[device] || {};
        if (Object.prototype.hasOwnProperty.call(current, name)) return;
        applied.push(key);
        next.devices[device] = { ...current, [name]: value };
        touched.add(device);
      });
    }
    if (!applied.length) return;
    // Never refill a value someone cleared on purpose.
    applied.forEach((key) => prefilledKeys.current.add(key));
    setBindingInputs(next);
    const origins = new Set(
      [...touched].map((device) => {
        const source = result.sources?.[device];
        if (!source?.configuration_name) return null;
        return source.version_number
          ? `${source.configuration_name} v${source.version_number}`
          : source.configuration_name;
      }),
    );
    const origin =
      origins.size === 1 ? ([...origins][0] as string | null) : null;
    setPrefill((previous) => ({
      values: (previous?.values || 0) + applied.length,
      devices: Math.max(previous?.devices || 0, touched.size),
      source: previous && previous.source !== origin ? null : origin,
    }));
    setPreview(null);
  }

  const blockers = (preview?.blockers || []) as PreviewBlocker[];
  const previewed = useMemo(
    () => new Map((preview?.devices || []).map((device) => [device.id, device])),
    [preview],
  );
  const deviceName = (id: string) =>
    previewed.get(id)?.name || known.get(id)?.name || id;
  const blockersByDevice = new Map<string, string[]>();
  for (const blocker of blockers) {
    if (blocker.resource !== (policy ? "policy" : "configuration")) continue;
    const label = blockerRowLabel(blocker.code);
    for (const id of blocker.device_ids) {
      const labels = blockersByDevice.get(id) || [];
      if (!labels.includes(label)) labels.push(label);
      blockersByDevice.set(id, labels);
    }
  }
  const agentCatalog = useAgentCatalog();
  const requirements =
    version && agentCatalog && agentCatalog !== "failed"
      ? fullModeRequirements(version.config, agentCatalog)
      : [];
  // Until the component list is read, what the pipeline needs is unknown.
  const capabilityUnknown =
    !!version && !(agentCatalog && agentCatalog !== "failed");
  const restrictedTargets: Device[] = (preview?.devices || chosenRows).filter(
    (device: Device) => {
      const latest = known.get(device.id);
      return (
        device.configuration_mode !== "full" ||
        (latest && latest.configuration_mode !== "full")
      );
    },
  );
  const capabilityBlocked =
    requirements.length > 0 && restrictedTargets.length > 0;
  // Restricted devices also refuse destinations, listeners and paths their
  // host hasn't approved. Nothing here knows a host's allowances, so say
  // exactly what each restricted host must allow before this version runs.
  const approvals = useMemo(
    () => (version ? hostApprovals(version.config) : null),
    [version],
  );
  const needsApproval =
    !capabilityBlocked &&
    !!approvals &&
    hasHostApprovals(approvals) &&
    restrictedTargets.length > 0;
  const settingsMismatch: Device[] =
    policy && preserveExistingSettings
      ? (preview?.devices || chosenRows).filter((device: Device) => {
          const same = (current?: Policy) =>
            current?.heartbeat_seconds === policy.heartbeat_seconds &&
            current?.telemetry_enabled === policy.telemetry_enabled;
          const latest = known.get(device.id);
          return (
            !same(device.effective_policy) ||
            (latest && !same(latest.effective_policy))
          );
        })
      : [];
  /** Selection changes invalidate the review and any replacement chosen for it. */
  function resetReview() {
    setPreview(null);
    if (adoption) {
      if (!priorityTouched) setPriority(adoption.previousPriority);
      if (!modeTouched) setMode(adoption.previousMode);
    }
    setAdoption(null);
    setReplaces([]);
    setDeclined(false);
  }
  function toggle(
    value: string,
    list: string[],
    setter: (v: string[]) => void,
  ) {
    setter(
      list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
    );
    resetReview();
  }
  function registryReady() {
    const registry = readDeploymentRegistry(userId);
    if (registry.errors.length) {
      setStorageIssue(registry.errors[0]);
      return false;
    }
    const existing = registry.operations[0];
    if (existing) {
      setError("");
      setRecovery(existing);
      return false;
    }
    return true;
  }
  /**
   * Reviews the request. A new version of the pipeline a device already runs
   * (or new settings for a device) replaces that assignment by default and
   * keeps its priority, so shipping is never a conflict.
   */
  async function review(next: Inputs) {
    if (inFlight.current || created) return;
    if (bindingResult.errors.length) {
      // The values section lists exactly what's missing.
      setBindingAttempted(true);
      return;
    }
    if (!releaseValid) {
      setError("Fix the release settings before reviewing this deployment.");
      return;
    }
    if (!registryReady()) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      let chosen = next;
      let request = builder.current(chosen);
      let result = await post<DeploymentPreview>(
        "/deployments/preview",
        structuredClone(request),
      );
      let adopted: Adoption | null = null;
      const suggested = result.suggested_replaces || [];
      if (!chosen.declined && !chosen.replaces.length && suggested.length) {
        const previousPriority = chosen.priority;
        const previousMode = chosen.mode;
        chosen = {
          ...chosen,
          replaces: suggested.map((entry) => entry.assignment.id),
          priority: priorityTouched
            ? chosen.priority
            : (result.suggested_priority ?? chosen.priority),
          mode:
            !modeTouched &&
            !scheduled &&
            suggested.every(
              (entry) => entry.assignment.target_mode === "persistent",
            )
              ? "persistent"
              : chosen.mode,
        };
        request = builder.current(chosen);
        result = await post<DeploymentPreview>(
          "/deployments/preview",
          structuredClone(request),
        );
        adopted = {
          assignments: suggested.map((entry) => entry.assignment),
          previousPriority,
          previousMode,
        };
      }
      if (!mounted.current || currentActor.current !== userId) return;
      const key = JSON.stringify(request);
      // The selection must not have changed while the review was running.
      if (JSON.stringify(builder.current(chosen)) !== key) {
        setError(
          "Targets changed during preview. Review the current selection again.",
        );
        return;
      }
      setReplaces(chosen.replaces);
      setPriority(chosen.priority);
      setMode(chosen.mode);
      setDeclined(chosen.declined);
      if (adopted) setAdoption(adopted);
      else if (!chosen.replaces.length) setAdoption(null);
      setPreview({ ...result, request, key });
    } catch (e) {
      if (!mounted.current || currentActor.current !== userId) return;
      setError((e as Error).message);
      setStorageIssue(readDeploymentRegistry(userId).errors[0] || null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (inFlight.current || created || !preview) return;
    if (!registryReady()) return;
    let operation: DeploymentOperation | null = null;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (
        preview.create_idempotency !== true ||
        preview.request_correlation !== true
      )
        throw Error(
          "Update the server before sending a deployment. This server cannot confirm the exact saved request.",
        );
      if (blockers.length)
        throw Error(
          blockers
            .map((blocker) => blocker.reason)
            .filter(Boolean)
            .join(" ") ||
            "The deployment preview has blockers. Review the affected devices before sending.",
        );
      if (artifactReviewIncomplete)
        throw Error(
          "The server did not confirm a rendered artifact for every reviewed device. Review again after the server is updated.",
        );
      if (settingsMismatch.length)
        throw Error(
          "Some selected devices use different agent settings. Return to the device list and select devices with matching settings.",
        );
      if (capabilityUnknown)
        throw Error(
          agentCatalog === "failed"
            ? "Vectory couldn't read the component list to check this pipeline. Reload the page and try again."
            : "Vectory is still checking what this pipeline needs. Try again in a moment.",
        );
      if (capabilityBlocked)
        throw Error(
          "This pipeline requires full Vector mode on every selected device. Only the host operator can enable that mode.",
        );
      if (preview.key !== currentBody.current) {
        setPreview(null);
        throw Error(
          "The selection changed. Preview it again before deploying.",
        );
      }
      operation = beginDeploymentOperation(
        userId,
        {
          ...(preview.request as any),
          expected_device_ids: preview.devices.map((d) => d.id),
        },
        preview.create_idempotency === true,
        policy
          ? policyName
            ? `Agent settings: ${policyName}`
            : "Agent settings"
          : `Pipeline version ${version?.number}`,
      );
      if (!setDeploymentRequestActive(operation, true)) {
        setRecovery(operation);
        return;
      }
      const result = assertDeploymentReceipt(
        operation,
        await post<Deployment>("/deployments", operation.request),
      );
      try {
        finishDeploymentOperation(operation);
      } catch {
        setError(
          "Your deployment is saved, but this browser could not clear its recovery reminder. You can still open the deployment below.",
        );
      }
      if (!mounted.current || currentActor.current !== userId) return;
      setCreated({
        id: result.id,
        scheduled: !!preview.request.scheduled_at,
        scheduledAt: preview.request.scheduled_at,
        status: result.status,
      });
      onDone(
        result.status === "scheduled"
          ? "Deployment scheduled. Its devices are fixed until it starts."
          : policy
            ? "Settings saved. Devices apply them on their next check-in."
            : "Rollout started. Its page tracks each device until it verifies.",
      );
    } catch (e) {
      if (!mounted.current || currentActor.current !== userId) return;
      // A rejected attempt cannot exclude another tab's same-key success.
      // Retain the reviewed request until a result or explicit dismissal.
      setError((e as Error).message);
      if (operation) setRecovery(operation);
      else setStorageIssue(readDeploymentRegistry(userId).errors[0] || null);
    } finally {
      if (operation) setDeploymentRequestActive(operation, false);
      inFlight.current = false;
      setBusy(false);
    }
  }
  function chooseDevice(device: Device) {
    const id = device.id;
    keepRows([device]);
    if (effective.has(id)) {
      setSelected((old) => old.filter((item) => item !== id));
      if (fromGroups.has(id)) setExclude((old) => [...new Set([...old, id])]);
    } else {
      setExclude((old) => old.filter((item) => item !== id));
      setSelected((old) => [...new Set([...old, id])]);
    }
    resetReview();
  }
  /** Everything a search matched, chosen at once. */
  function chooseMatching(ids: string[]) {
    const added = new Set(ids);
    setExclude((old) => old.filter((item) => !added.has(item)));
    setSelected((old) => [...new Set([...old, ...ids])]);
    resetReview();
  }
  function clearDevices() {
    setSelected([]);
    setExclude([]);
    resetReview();
  }
  const resource = policy ? "policy" : "configuration";
  const change: RequestedChange = policy
    ? { kind: "policy", policy, name: policyName || null }
    : {
        kind: "configuration",
        configurationId: version?.configuration_id || null,
        pipeline:
          knownPipelineName ||
          inferPipelineName(preview, version?.configuration_id || null),
        number: version?.number ?? null,
      };
  const outcomes = new Map(
    (preview?.outcomes || [])
      .filter((entry) => entry.resource === resource)
      .map((entry) => [entry.device_id, entry]),
  );
  const paused = new Set(preview?.paused_device_ids || []);
  const configurationId = version?.configuration_id || null;
  const shortName = (assignment: AssignmentDescription) =>
    shortAssignmentName(assignment, configurationId);
  function outcomeFor(device: Device): Outcome | null {
    // A device the server won't release to never reads as "New".
    const blocked = blockersByDevice.get(device.id);
    if (blocked?.length)
      return {
        label: "Blocked",
        tone: "danger",
        detail: blocked.join("; "),
        link: null,
        takes: false,
      };
    const outcome = outcomes.get(device.id);
    if (!outcome) return null;
    if (outcome.outcome === "replace")
      return {
        label: "Replaces",
        tone: "info",
        detail: null,
        link: outcome.replaces
          ? { id: outcome.replaces.id, label: shortName(outcome.replaces) }
          : null,
        takes: true,
      };
    if (outcome.outcome === "conflict") {
      const row = conflictRows(
        {
          outcomes: [outcome],
          conflicts: preview?.conflicts || [],
          devices: [device],
        },
        resource,
      )[0];
      // The one it follows today, which may outrank the conflict.
      const other = row?.winner || row?.assignments[0];
      return {
        label: "Conflict",
        tone: "danger",
        detail: "Same priority, different content",
        link: other ? { id: other.id, label: shortName(other) } : null,
        takes: false,
      };
    }
    if (outcome.outcome === "higher_priority")
      return {
        label: "Keeps current",
        tone: "warning",
        detail: `Priority ${outcome.assignment?.priority ?? "higher"} wins`,
        // The outranking assignment may still be waiting for its rollout, so
        // it is named only when it is the one the device follows today.
        link: outcome.assignment
          ? {
              id: outcome.assignment.id,
              label:
                outcome.winner?.id === outcome.assignment.id
                  ? shortName(outcome.winner)
                  : "View assignment",
            }
          : null,
        takes: false,
      };
    if (outcome.winner)
      return {
        label: "Takes over",
        tone: "success",
        detail: `From priority ${outcome.winner.priority}`,
        link: { id: outcome.winner.id, label: shortName(outcome.winner) },
        takes: true,
      };
    return {
      label: "New",
      tone: "success",
      detail:
        resource === "policy" ? "No settings assigned" : "No pipeline assigned",
      link: null,
      takes: true,
    };
  }
  const nowText = (device: Device) =>
    policy
      ? policySummary(device.effective_policy)
      : runningName(device, configurationId);
  const afterText = (device: Device) => {
    const outcome = outcomeFor(device);
    if (outcome && !outcome.takes)
      return outcome.label === "Conflict"
        ? "Blocked until resolved"
        : "No change";
    const next = policy
      ? policySummary(policy)
      : device.running_version?.configuration_id === configurationId &&
          version?.number
        ? `v${version.number}`
        : // A pipeline's own name keeps its case; only "version 1" is capitalized.
          change.kind === "configuration" && change.pipeline
          ? requestedName(change)
          : capitalize(requestedName(change));
    return paused.has(device.id) ? `${next}, after sync resumes` : next;
  };
  /** The device already runs exactly what it would receive. */
  const sameContent = (device: Device) => {
    if (policy || !device.actual_sha256) return false;
    const rendered =
      artifactByDevice.get(device.id)?.sha256 ||
      (declarations.length ? null : version?.sha256);
    return !!rendered && rendered === device.actual_sha256;
  };
  const artifactPreviews = preview?.artifact_previews || [];
  const artifactByDevice = new Map(
    artifactPreviews.map((artifact) => [artifact.device_id, artifact]),
  );
  const artifactReviewIncomplete =
    declarations.length > 0 &&
    !!preview &&
    (artifactPreviews.length !== preview.devices.length ||
      artifactByDevice.size !== artifactPreviews.length ||
      preview.devices.some((device) => {
        const artifact = artifactByDevice.get(device.id);
        return (
          !artifact ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.size) ||
          artifact.size <= 0
        );
      }));
  const reviewedBindings = preview?.request?.variable_bindings as
    typeof bindingResult.bindings | undefined;
  const bindingFor = (deviceId: string, name: string) => {
    const override = reviewedBindings?.devices?.[deviceId];
    if (override && Object.prototype.hasOwnProperty.call(override, name))
      return { source: "Override", value: override[name] };
    return {
      source: "Default",
      value: reviewedBindings?.defaults?.[name],
    };
  };
  // The longest check-in among the devices the plan covers: the reviewed
  // devices once there are any, otherwise the ones seen so far.
  const planned = preview?.devices || chosenRows;
  const checkIn = planned.length
    ? planned.reduce(
        (longest, device) => Math.max(longest, device.check_in_seconds || 60),
        10,
      )
    : 60;
  const plan = releaseValid
    ? releasePlan({
        kind: usesCanary(release) ? "canary" : "all",
        devices: effective.size,
        canarySize: release.canary,
        batchSize: release.batch,
        observeSeconds: release.observe,
        checkInSeconds: effective.size ? checkIn : 60,
      })
    : null;
  const stopRule = usesCanary(release)
    ? release.threshold === 0
      ? "stops at the first failure"
      : `stops if more than ${release.threshold} fail`
    : null;
  const planSentence = plan
    ? [plan.sentence, stopRule].filter(Boolean).join(" · ")
    : "Fix the highlighted fields to see the plan.";
  const startText = (value: string) => {
    const at = new Date(value);
    if (Number.isNaN(at.valueOf())) return "";
    const relative = startsIn(value);
    return `${at.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })}${relative ? ` (${relative})` : ""}`;
  };
  const conflictList = preview ? conflictRows(preview, resource) : [];
  // Devices an existing assignment outranks keep what they run: sending then
  // changes only the others, and says so.
  const kept = preview
    ? preview.devices.filter(
        (device) => outcomeFor(device)?.label === "Keeps current",
      )
    : [];
  const keptLines = kept.slice(0, 3).map((device) => {
    const outcome = outcomes.get(device.id);
    const outranking =
      outcome?.winner && outcome.winner.id === outcome.assignment?.id
        ? outcome.winner
        : outcome?.assignment
          ? { priority: outcome.assignment.priority, rollback_of: null }
          : null;
    return keptLine(device, outranking, resource);
  });
  const leftBehind = kept.length > 0 && leftBehindAccepted !== preview;
  const replacements = preview?.replacements || [];
  const headline = preview
    ? reviewHeadline(preview, change, preview.devices.length)
    : "";
  const singleReplacement =
    replacements.length === 1 &&
    change.kind === "configuration" &&
    replacements[0].device_ids.length === preview?.devices.length;
  const pausedDevices = (preview?.devices || []).filter((device) =>
    paused.has(device.id),
  );
  const single = preview?.devices.length === 1;
  const chosenGroups = groups.data.filter((group) =>
    groupIds.includes(group.id),
  );
  // Groups that match the search, the chosen ones first, a screenful at a time.
  const matchingGroups = groups.data.filter((group) =>
    group.name.toLowerCase().includes(search.toLowerCase()),
  );
  const shownGroups = [
    ...matchingGroups.filter((group) => groupIds.includes(group.id)),
    ...matchingGroups.filter((group) => !groupIds.includes(group.id)),
  ].slice(0, GROUPS_SHOWN);
  const groupNames =
    chosenGroups.length === 0
      ? ""
      : chosenGroups.length <= 2
        ? chosenGroups.map((group) => group.name).join(" and ")
        : `${chosenGroups[0].name} and ${chosenGroups.length - 1} more groups`;
  const title = policy
    ? policyName
      ? `Apply “${policyName}”`
      : preserveExistingSettings
        ? policy.sync_paused
          ? "Pause sync"
          : "Resume sync"
        : "Apply agent settings"
    : knownPipelineName
      ? `Deploy ${knownPipelineName} v${version?.number ?? ""}`
      : `Deploy version ${version?.number ?? ""}`;

  if (storageIssue?.actor_id === userId)
    return (
      <DeploymentStorageRecoveryDialog
        issue={storageIssue}
        userId={userId}
        onClose={onClose}
        onRecovered={onDone}
      />
    );
  if (recovery?.actor_id === userId)
    return (
      <DeploymentRecoveryDialog
        operation={recovery}
        userId={userId}
        initialError={error}
        onClose={onClose}
        onRecovered={onDone}
      />
    );
  if (created && preview) {
    const awaitingSchedule = created.status === "scheduled";
    const destination = deploymentRoute(created.scheduled, created.id, {
      search: "",
      status: "all",
      page: 1,
    });
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={awaitingSchedule ? "Deployment scheduled" : "Deployment created"}
        description="The request is saved. Its page tracks each device from release to verified."
      >
        <div className="modal-body target-receipt">
          {error && <ErrorBox message={error} />}
          <div className="target-receipt-heading">
            <span className="target-receipt-icon">
              {awaitingSchedule ? <Clock size={20} /> : <Check size={20} />}
            </span>
            <div>
              <strong>{headline}</strong>
              <p>
                {awaitingSchedule && created.scheduledAt
                  ? `Starts ${startText(created.scheduledAt)}`
                  : planSentence}
              </p>
            </div>
          </div>
          <dl className="control-summary-list">
            <div>
              <dt>Devices</dt>
              <dd>{devicesText(preview.devices.length)} in the review</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>{preview.request.priority}</dd>
            </div>
          </dl>
          <p className="control-muted">
            This confirms the request was saved, not that devices applied it.
            Each device counts only after its agent verifies the change.
          </p>
          {!created.id && (
            <ErrorBox message="The server accepted the request but did not return a deployment link. Find it in deployment history before creating another." />
          )}
        </div>
        <div className="modal-footer target-footer">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <a ref={receiptLink} className="button" href={`#/${destination}`}>
            {!created.id
              ? "View history"
              : created.scheduled
                ? "View schedule"
                : "View deployment"}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      </Modal>
    );
  }
  const sendLabel = preview
    ? scheduled
      ? "Schedule deployment"
      : kept.length
        ? `${policy ? "Apply to" : "Deploy to"} ${preview.devices.length - kept.length} of ${devicesText(preview.devices.length)}`
        : policy
          ? "Apply settings"
          : "Deploy to devices"
    : "Review deployment";
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
      className="target-dialog"
      title={title}
      description={
        preview
          ? "Check what changes on each device, then send."
          : "Choose devices and how to release, then review exactly what changes."
      }
    >
      <div className="modal-body target-flow">
        <ol className="control-steps" aria-label="Deployment steps">
          <li aria-current={!preview ? "step" : undefined}>
            <span>1</span>Devices and release
          </li>
          <li aria-current={preview ? "step" : undefined}>
            <span>2</span>Review and send
          </li>
        </ol>
        {(error || groups.error || membersError) && (
          <ErrorBox message={error || groups.error || membersError} />
        )}
        {!!settingsMismatch.length && (
          <ErrorBox
            message={`To keep each device's check-in and metrics settings, choose devices that share them. These devices differ or haven't reported settings: ${settingsMismatch.map((device) => device.name).join(", ")}.`}
          />
        )}
        {!!requirements.length && (
          <div className="control-note" role="status">
            <strong>
              {capabilityBlocked
                ? `${restrictedTargets.length === 1 ? `${restrictedTargets[0].name} runs` : `${restrictedTargets.length} selected devices run`} in restricted mode and will refuse this version`
                : effective.size
                  ? "This pipeline uses full Vector capabilities"
                  : "This version needs Full Vector mode"}
            </strong>
            <p>
              It uses {requirements.join(", ")}.{" "}
              {capabilityBlocked
                ? "Choose devices in Full Vector mode, or have the host operator enable it; the dashboard can't."
                : effective.size
                  ? "All selected devices currently report full Vector mode."
                  : "Choose devices in Full Vector mode."}{" "}
              {!effective.size || capabilityBlocked ? (
                <DocLink
                  topic="installation"
                  section="choose-configuration-capabilities"
                >
                  Enable Full Vector mode on a device
                </DocLink>
              ) : null}
            </p>
            {capabilityBlocked && restrictedTargets.length > 1 && (
              <p>
                Restricted:{" "}
                {restrictedTargets
                  .slice(0, 5)
                  .map((device) => device.name)
                  .join(", ")}
                {restrictedTargets.length > 5
                  ? ` and ${restrictedTargets.length - 5} more`
                  : ""}
                .
              </p>
            )}
          </div>
        )}
        {needsApproval && approvals && (
          <HostApprovalNote approvals={approvals} devices={restrictedTargets} />
        )}
        {!preview ? (
          <fieldset className="target-selection" disabled={busy}>
            <label className="target-search">
              <Search size={17} />
              <input
                aria-label="Find targets"
                placeholder="Search devices or groups"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            {groups.data.length > 0 && (
              <details
                className="control-disclosure target-group-list"
                open={groups.data.length <= 12}
              >
                <summary>
                  Choose groups ({groups.data.length})
                  {groupIds.length > 0 && `, ${groupIds.length} selected`}
                </summary>
                <div className="target-group-options">
                  {shownGroups.map((g) => (
                    <label className="target-option" key={g.id}>
                      <input
                        type="checkbox"
                        checked={groupIds.includes(g.id)}
                        onChange={() => toggle(g.id, groupIds, setGroupIds)}
                      />
                      <span>
                        <strong>{g.name}</strong>
                        <small>{devicesText(g.member_count)}</small>
                      </span>
                    </label>
                  ))}
                  {matchingGroups.length > shownGroups.length && (
                    <p className="control-muted">
                      Showing {shownGroups.length} of{" "}
                      {matchingGroups.length.toLocaleString()} groups. Search to
                      narrow the list.
                    </p>
                  )}
                  {!matchingGroups.length && (
                    <p className="control-muted">
                      No groups match your search.
                    </p>
                  )}
                </div>
              </details>
            )}
            <div className="target-device-list">
              <h3>Devices</h3>
              <DevicePicker
                label="Devices"
                search={search}
                isChecked={(device) => effective.has(device.id)}
                onToggle={chooseDevice}
                onRows={keepRows}
                onMatching={(found, rows) => {
                  keepRows(rows);
                  chooseMatching(found.ids);
                }}
                note={(device) =>
                  device.configuration_mode === "full"
                    ? "Full Vector mode"
                    : "Restricted mode"
                }
                extra={{ id: "now", header: "Now", cell: nowText }}
                actions={
                  <Button
                    variant="ghost compact"
                    disabled={
                      !selected.length && !exclude.length && !groupIds.length
                    }
                    onClick={clearDevices}
                  >
                    Clear selection
                  </Button>
                }
              />
            </div>
            <div className="target-selection-summary">
              {effective.size.toLocaleString()}{" "}
              {effective.size === 1 ? "device" : "devices"} selected
              {groupsLoading && !membersError && (
                <span>, reading the groups&apos; devices…</span>
              )}
              {exclude.length > 0 && (
                <span>, {exclude.length} excluded from selected groups</span>
              )}
            </div>
            {declarations.length > 0 && (
              <>
                {prefill && (
                  <p className="target-prefill" role="status">
                    <Check size={15} aria-hidden="true" />
                    <span>
                      Filled {prefill.values}{" "}
                      {prefill.values === 1 ? "value" : "values"} from{" "}
                      {prefill.source ? (
                        <>
                          <strong>{prefill.source}</strong>, what{" "}
                          {prefill.devices === 1
                            ? "this device runs"
                            : "these devices run"}{" "}
                          now
                        </>
                      ) : prefill.devices === 1 ? (
                        "the version this device runs now"
                      ) : (
                        "the versions these devices run now"
                      )}
                      . Change any of them before you review.
                    </span>
                  </p>
                )}
                <DeploymentVariableFields
                  declarations={declarations}
                  devices={chosenRows.slice(0, VALUE_ROWS)}
                  inputs={bindingInputs}
                  persistent={persistent}
                  onChange={(next) => {
                    setBindingInputs(next);
                    setPreview(null);
                    setError("");
                  }}
                />
                {effective.size > Math.min(chosenRows.length, VALUE_ROWS) && (
                  <p className="control-muted">
                    Each device has its own value here when you pick it one by
                    one. The default applies to the other{" "}
                    {(
                      effective.size - Math.min(chosenRows.length, VALUE_ROWS)
                    ).toLocaleString()}{" "}
                    selected devices.
                  </p>
                )}
                {bindingAttempted &&
                  effective.size > 0 &&
                  bindingResult.errors.length > 0 && (
                    <ErrorBox message={bindingResult.errors.join("\n")} />
                  )}
              </>
            )}
            <ReleaseStrategyFields
              value={release}
              errors={releaseProblems}
              plan={
                release.strategy === "scheduled" && release.schedule && plan
                  ? `Starts ${startText(release.schedule)} · ${planSentence}`
                  : planSentence
              }
              onChange={(patch) => {
                setRelease((old) => ({ ...old, ...patch }));
                setPreview(null);
                setError("");
              }}
            />
            <details className="control-disclosure target-advanced">
              <summary>Advanced options</summary>
              <div className="control-disclosure-content">
                <div className="control-two-col">
                  <Field
                    label="Assignment priority"
                    hint="Higher priorities win. Equal priorities must send the same thing."
                  >
                    <input
                      type="number"
                      min={-1000000}
                      max={1000000}
                      value={priority}
                      onChange={(e) => {
                        setPriority(+e.target.value);
                        setPriorityTouched(true);
                        setPreview(null);
                      }}
                    />
                  </Field>
                  <Field
                    label="Target membership"
                    hint={
                      scheduled
                        ? "A schedule always keeps the devices you chose."
                        : undefined
                    }
                  >
                    <select
                      value={scheduled ? "snapshot" : mode}
                      disabled={scheduled}
                      onChange={(e) => {
                        setMode(e.target.value);
                        setModeTouched(true);
                        setPreview(null);
                      }}
                    >
                      <option value="snapshot">
                        Only the selected devices
                      </option>
                      <option value="persistent">
                        Also include future group members
                      </option>
                    </select>
                  </Field>
                </div>
              </div>
            </details>
          </fieldset>
        ) : (
          <div className="target-review">
            <div className="target-review-heading">
              <h3>{headline}</h3>
              <p>
                {scheduled && release.schedule
                  ? `Starts ${startText(release.schedule)} · `
                  : ""}
                {planSentence}
              </p>
            </div>
            {(replacements.length > 1 ||
              (replacements.length === 1 && !singleReplacement)) && (
              <ul
                className="target-replacements"
                aria-label="Replaced assignments"
              >
                {replacements.map((replacement) => (
                  <li key={replacement.assignment.id}>
                    <Repeat2 size={15} aria-hidden="true" />
                    <span>
                      <span>
                        Replaces{" "}
                        {replacement.assignment.rollback_of
                          ? "the rollback to "
                          : ""}
                        <AssignmentLink
                          id={replacement.assignment.id}
                          label={shortName(replacement.assignment)}
                          disabled={busy}
                        />{" "}
                        on {devicesText(replacement.device_ids.length)}
                      </span>
                      <small>
                        {assignmentMeta(replacement.assignment)}
                        {replacement.retires_assignment === false
                          ? ". It keeps its other devices."
                          : ""}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {adoption && replaces.length > 0 && (
              <div className="target-adoption" role="status">
                <p>
                  {change.kind === "policy"
                    ? change.policy.sync_paused
                      ? `Replaces the settings ${single ? "this device follows" : "these devices follow"} now. Resuming later replaces the pause the same way.`
                      : adoption.assignments.some((a) => a.policy?.sync_paused)
                        ? "Replaces the pause, so it can't win again later."
                        : `Replaces the settings ${single ? "this device follows" : "these devices follow"} now.`
                    : adoption.assignments.some((a) => a.rollback_of)
                      ? // After a rollback: the fix replaces both, so every
                        // device takes it in one review.
                        `Replaces the rollback to ${shortName(adoption.assignments.find((a) => a.rollback_of)!)} and the rollout it stopped, so ${single ? "this device takes" : "every device takes"} this version.`
                      : `A new version replaces the one ${single ? "this device runs" : "these devices run"} now.`}{" "}
                  Priority stays {priority}
                  {mode === "persistent" && !scheduled
                    ? " and it follows the same groups"
                    : ""}
                  .
                </p>
                <button
                  type="button"
                  className="target-link-button"
                  disabled={busy}
                  onClick={() =>
                    void review({
                      replaces: [],
                      priority: priorityTouched
                        ? priority
                        : adoption.previousPriority,
                      mode: modeTouched ? mode : adoption.previousMode,
                      declined: true,
                    })
                  }
                >
                  Keep{" "}
                  {adoption.assignments.length === 1
                    ? shortName(adoption.assignments[0])
                    : "the current assignments"}{" "}
                  as well
                </button>
              </div>
            )}
            <dl className="control-summary-list target-summary">
              <div>
                <dt>When</dt>
                <dd>
                  {scheduled && release.schedule
                    ? startText(release.schedule)
                    : "On each device's next check-in"}
                </dd>
              </div>
              <div>
                <dt>Release</dt>
                <dd>{planSentence}</dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>
                  {priority}
                  {adoption && replaces.length > 0 && !priorityTouched
                    ? " · kept from the assignment it replaces"
                    : ""}
                </dd>
              </div>
              <div>
                <dt>Membership</dt>
                <dd>
                  {body.target_mode === "persistent"
                    ? `Follows ${groupNames || "the selected groups"}`
                    : single
                      ? "Fixed to this device"
                      : groupNames
                        ? `Fixed to the ${devicesText(preview.devices.length)} in ${groupNames} now`
                        : `Fixed to these ${devicesText(preview.devices.length)}`}
                </dd>
              </div>
              {declarations.length > 0 && (
                <div>
                  <dt>Device-specific values</dt>
                  <dd>
                    {declarations.length}{" "}
                    {declarations.length === 1 ? "field" : "fields"}, reviewed
                    per device
                  </dd>
                </div>
              )}
            </dl>
            {artifactReviewIncomplete && (
              <ErrorBox message="The server did not confirm a rendered artifact for every reviewed device. Go back and review this deployment again after the server is updated." />
            )}
            {(preview.create_idempotency !== true ||
              preview.request_correlation !== true) && (
              <ErrorBox message="Update the server before sending a deployment. This server cannot confirm the exact saved request." />
            )}
            {blockers.map((blocker, index) => (
              <div
                className="control-note"
                role="alert"
                key={`${blocker.code}-${blocker.deployment_id || index}`}
              >
                <strong>{blockerTitle(blocker.code)}</strong>
                <p>{blocker.reason}</p>
                {blocker.device_ids.length > 0 && (
                  <p>
                    {blocker.device_ids.length} affected{" "}
                    {blocker.device_ids.length === 1 ? "device" : "devices"}:{" "}
                    {blocker.device_ids.map(deviceName).join(", ")}.
                  </p>
                )}
                {blocker.code === "ACTIVE_CANARY_OVERLAP" &&
                  blocker.deployment_id && (
                    <p>
                      <a
                        href={`#/${deploymentRoute(false, blocker.deployment_id, { search: "", status: "all", page: 1 })}`}
                        onClick={(event) => {
                          if (inFlight.current) event.preventDefault();
                        }}
                      >
                        View active canary
                      </a>
                    </p>
                  )}
              </div>
            ))}
            <ConflictTable
              rows={conflictList}
              requestLabel={requestedName(change)}
              priority={priority}
              winningPriority={preview.winning_priority ?? null}
              busy={busy}
              onUsePriority={(next) => {
                setPriorityTouched(true);
                void review({ ...inputs, priority: next });
              }}
              replaceAll={(preview.replacements_needed || []).map(
                (entry) => entry.assignment.id,
              )}
              onReplace={(ids) =>
                void review({
                  ...inputs,
                  replaces: [...new Set([...replaces, ...ids])],
                })
              }
            />
            {kept.length > 0 && (
              <label className="control-note target-left-behind">
                <input
                  type="checkbox"
                  checked={leftBehindAccepted === preview}
                  disabled={busy}
                  onChange={(event) =>
                    setLeftBehindAccepted(
                      event.currentTarget.checked ? preview : null,
                    )
                  }
                />
                <span>
                  <strong>
                    {keptLines.join(". ")}
                    {kept.length > 3
                      ? `. ${kept.length - 3} more keep what they run`
                      : ""}
                    .
                  </strong>
                  <small>
                    {preview.devices.length - kept.length === 1
                      ? "Only the other device changes."
                      : preview.devices.length === kept.length
                        ? "No device changes now."
                        : `Only the other ${devicesText(preview.devices.length - kept.length)} change.`}{" "}
                    Replace or outrank what{" "}
                    {kept.length === 1 ? "it follows" : "they follow"} to
                    include {kept.length === 1 ? "it" : "them"}.
                  </small>
                </span>
              </label>
            )}
            {pausedDevices.length > 0 && (
              <div className="control-note target-paused" role="status">
                <strong>
                  {pausedDevices.length === 1
                    ? "1 device has sync paused"
                    : `${pausedDevices.length} devices have sync paused`}
                </strong>
                <p>
                  This change is saved now and waits until sync resumes on{" "}
                  {pausedDevices.length === 1 ? "it" : "them"}.
                </p>
                <ul>
                  {pausedDevices.slice(0, 6).map((device) => (
                    <li key={device.id}>
                      <strong>{device.name}</strong>{" "}
                      {pauseSource(device) || "Sync paused."}
                    </li>
                  ))}
                  {pausedDevices.length > 6 && (
                    <li>and {pausedDevices.length - 6} more</li>
                  )}
                </ul>
              </div>
            )}
            <div className="target-review-table">
              <DataTable<Device>
                data={preview.devices}
                rowKey={(device) => device.id}
                label="Deployment review devices"
                columns={[
                  {
                    id: "device",
                    header: "Device",
                    value: (device) => device.name,
                    filter: { placeholder: "Find a reviewed device" },
                    cell: (device) => {
                      const blocked = blockersByDevice.get(device.id) || [];
                      return (
                        <>
                          <strong>{device.name}</strong>
                          {notable(device) && (
                            <small>{statusText(device)}</small>
                          )}
                          {blocked.length > 0 && (
                            <small className="target-review-blocker">
                              Blocked: {blocked.join("; ")}
                            </small>
                          )}
                        </>
                      );
                    },
                  },
                  {
                    id: "change",
                    header: "Now → After",
                    value: (device) =>
                      `${nowText(device)} ${afterText(device)}`,
                    cell: (device) => (
                      <span className="target-now-after">
                        <span>{nowText(device)}</span>
                        <ArrowRight size={13} aria-label="then" />
                        <strong
                          data-unchanged={
                            outcomeFor(device)?.takes === false || undefined
                          }
                        >
                          {afterText(device)}
                        </strong>
                        {outcomeFor(device)?.takes !== false &&
                          sameContent(device) && (
                            <small className="target-same-content">
                              Same content as it runs now
                            </small>
                          )}
                      </span>
                    ),
                  },
                  {
                    id: "outcome",
                    header: "Outcome",
                    value: (device) =>
                      outcomeFor(device)?.label || "Outcome unavailable",
                    cell: (device) => {
                      const outcome = outcomeFor(device);
                      if (!outcome)
                        return (
                          <span className="control-muted">
                            Outcome unavailable
                          </span>
                        );
                      return (
                        <span className="target-outcome">
                          <OutcomeChip tone={outcome.tone}>
                            {outcome.label}
                          </OutcomeChip>
                          {outcome.link ? (
                            <small>
                              <AssignmentLink
                                id={outcome.link.id}
                                label={outcome.link.label}
                                disabled={busy}
                              />
                              {outcome.detail ? ` · ${outcome.detail}` : ""}
                            </small>
                          ) : (
                            outcome.detail && <small>{outcome.detail}</small>
                          )}
                        </span>
                      );
                    },
                    filter: {
                      options: [
                        ...new Set<string>(
                          preview.devices.map(
                            (device) =>
                              outcomeFor(device)?.label ||
                              "Outcome unavailable",
                          ),
                        ),
                      ].map((value) => ({ value, label: value })),
                    },
                  },
                  ...(declarations.length > 0
                    ? [
                        {
                          id: "bindings",
                          header: "Values and rendered artifact",
                          value: (device: Device) =>
                            declarations
                              .map((declaration) =>
                                String(
                                  bindingFor(device.id, declaration.name)
                                    .value ?? "",
                                ),
                              )
                              .join(" "),
                          cell: (device: Device) => (
                            <div className="target-review-variables">
                              {declarations.map((declaration) => {
                                const binding = bindingFor(
                                  device.id,
                                  declaration.name,
                                );
                                return (
                                  <div key={declaration.name}>
                                    <strong>{declaration.name}</strong>
                                    <code>{JSON.stringify(binding.value)}</code>
                                    <small>{binding.source}</small>
                                  </div>
                                );
                              })}
                              {artifactByDevice.get(device.id) && (
                                <div>
                                  <strong>Rendered SHA-256</strong>
                                  <code
                                    title={
                                      artifactByDevice.get(device.id)!.sha256
                                    }
                                  >
                                    {shortDigest(
                                      artifactByDevice.get(device.id)!.sha256,
                                    )}
                                  </code>
                                  <small>
                                    {artifactByDevice.get(device.id)!.size}{" "}
                                    bytes
                                  </small>
                                </div>
                              )}
                            </div>
                          ),
                        },
                      ]
                    : []),
                ]}
                empty="No reviewed devices match these filters."
              />
            </div>
            {preview.devices.length > 1 && (
              <p className="control-muted target-filter-note">
                Filters only change this view. All {preview.devices.length}{" "}
                reviewed devices stay included.
              </p>
            )}
            <div className="target-review-notes">
              {preview.warnings
                ?.filter(
                  (warning) =>
                    !/sync paused/.test(warning) || !pausedDevices.length,
                )
                .map((warning: string) => (
                  <p key={warning}>{warning}</p>
                ))}
              {!preview.outcomes && (
                <p>
                  This server doesn't report outcomes. Review existing
                  assignments before sending.
                </p>
              )}
              <p>
                {version
                  ? "Each device checks the change against its own Vector and local resources before switching. It counts as done only when its agent verifies it."
                  : "Each device counts as done only when its agent confirms the new settings."}
              </p>
            </div>
            <details className="control-disclosure">
              <summary>Technical details</summary>
              <div className="control-disclosure-content target-technical">
                {version && (
                  <dl className="control-summary-list">
                    <div>
                      <dt>
                        {declarations.length
                          ? "Published base SHA-256"
                          : "Artifact SHA-256"}
                      </dt>
                      <dd className="control-wrap-code">{version.sha256}</dd>
                    </div>
                    <div>
                      <dt>Priority</dt>
                      <dd>{priority}</dd>
                    </div>
                  </dl>
                )}
                <CopyDetails
                  text={() => technicalDetails(preview.request, preview)}
                />
              </div>
            </details>
          </div>
        )}
      </div>
      <div className="modal-footer target-footer">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={preview ? () => setPreview(null) : onClose}
        >
          {preview ? "Back to selection" : "Cancel"}
        </Button>
        <Button
          busy={busy}
          disabled={
            !effective.size ||
            groupsLoading ||
            !!membersError ||
            (!preview && !releaseValid) ||
            (!!preview && (capabilityBlocked || capabilityUnknown)) ||
            // Nothing selected could run it: the note above says why.
            (!preview &&
              capabilityBlocked &&
              restrictedTargets.length >= effective.size) ||
            (!!preview &&
              (preview.create_idempotency !== true ||
                preview.request_correlation !== true)) ||
            (!!preview && !!settingsMismatch.length) ||
            !!preview?.conflicts?.length ||
            (!!preview && leftBehind) ||
            blockers.length > 0 ||
            (!preview &&
              bindingAttempted &&
              declarations.length > 0 &&
              bindingResult.errors.length > 0) ||
            artifactReviewIncomplete
          }
          onClick={() => void (preview ? send() : review(inputs))}
        >
          {sendLabel}
        </Button>
      </div>
    </Modal>
  );
}
