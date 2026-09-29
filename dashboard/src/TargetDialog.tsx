import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Clock, Repeat2, Search } from "lucide-react";
import {
  boundedPost as post,
  type AssignmentDescription,
  type BindingSuggestions,
  type Deployment,
  type DeploymentPreview,
  type Device,
  type Group,
  type Policy,
  type Version,
} from "./api";
import { Button, ErrorBox, Field, Modal, useResource } from "./ui";
import agentCatalog from "./generated/vector-catalog.json";
import DocLink from "./DocLink";
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
import { releasePlan, type StatusTone } from "./deploymentStatus";
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
} from "./deploymentReview";
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
function isLoopbackSocketAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(
    value,
  );
  if (ipv4)
    return (
      Number(ipv4[1]) === 127 &&
      ipv4.slice(2, 5).every((part) => Number(part) <= 255) &&
      Number(ipv4[5]) <= 65535
    );
  if (!/^\[[0-9a-fA-F:]+\]:\d{1,5}$/.test(value)) return false;
  try {
    const address = new URL(`http://${value}`);
    return (
      address.hostname === "[::1]" &&
      Number(value.slice(value.lastIndexOf(":") + 1)) <= 65535
    );
  } catch {
    return false;
  }
}
function fullModeRequirements(config: Record<string, any>): string[] {
  const required = new Set<string>();
  const restrictedRoots = new Set([
    "sources",
    "transforms",
    "sinks",
    "data_dir",
    "api",
    "acknowledgements",
    "healthchecks",
    "timezone",
  ]);
  for (const key of Object.keys(config))
    if (!restrictedRoots.has(key)) required.add(`Global setting: ${key}`);
  if (
    config.api?.enabled === true &&
    !isLoopbackSocketAddress(config.api.address)
  )
    required.add("API listener outside loopback");
  for (const kind of ["sources", "transforms", "sinks"]) {
    for (const component of Object.values(config[kind] || {}) as any[]) {
      if (
        !agentCatalog.components.some(
          (known) =>
            known.kind === kind &&
            known.type === component?.type &&
            known.device_capability === "allowed",
        )
      )
        required.add(`${kind.slice(0, -1)}: ${component?.type || "unknown"}`);
      if (component?.type === "console" && component.target !== "stderr")
        required.add("Console output to stdout");
    }
  }
  function inspect(value: any) {
    if (typeof value === "string") {
      if (/\$[A-Za-z_{]|SECRET\[|\{\{|%\{/.test(value))
        required.add("Native secrets, environment values or dynamic templates");
      if (
        /get_env_var|get_secret|set_secret|remove_secret|dns_lookup|get_enrichment_table|find_enrichment_table/i.test(
          value,
        )
      )
        required.add("VRL access to device resources");
    } else if (Array.isArray(value)) value.forEach(inspect);
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (
          [
            "command",
            "exec",
            "provider",
            "secret",
            "secrets",
            "source_files",
            "files",
            "enrichment_tables",
          ].includes(key.toLowerCase())
        )
          required.add(`Native capability: ${key}`);
        if (
          ["verify_certificate", "verify_hostname"].includes(
            key.toLowerCase(),
          ) &&
          child === false
        )
          required.add("Disabled TLS verification");
        inspect(child);
      }
  }
  inspect(config);
  return [...required];
}
const deviceStates: Record<string, string> = {
  verified: "Online",
  unmanaged: "Online",
  online: "Online",
  applying: "Applying a change",
  failed: "Last change failed",
  rolled_back: "Last change rolled back",
  verification_unknown: "Needs verification",
  paused: "Sync paused",
  offline: "Offline, applies when it reconnects",
  awaiting_first_check_in: "Waiting for its first check-in",
  revoked: "Revoked",
};
function statusText(device: Device) {
  return deviceStates[device.status] || device.status.replaceAll("_", " ");
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
  assignment: AssignmentDescription | null;
  /** Whether the device ends up with this request. */
  takes: boolean;
};

export default function TargetDialog({
  userId,
  open,
  onClose,
  version,
  policy,
  onDone,
  initialDeviceIds = [],
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
  const devices = useResource<Device[]>("/devices", []),
    groups = useResource<Group[]>("/groups", []);
  const [selected, setSelected] = useState<string[]>(initialDeviceIds),
    [groupIds, setGroupIds] = useState<string[]>([]),
    [exclude, setExclude] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [devicePage, setDevicePage] = useState(1),
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
    } | null>(null),
    [busy, setBusy] = useState(false),
    [created, setCreated] = useState<{
      id: string | null;
      scheduled: boolean;
      scheduledAt: string | null;
      status: string;
    } | null>(null),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<Reviewed | null>(null);
  const effective = useMemo(
    () =>
      new Set(
        [
          ...selected,
          ...groups.data
            .filter((g) => groupIds.includes(g.id))
            .flatMap((g) => g.device_ids),
        ].filter((id) => !exclude.includes(id)),
      ),
    [selected, groupIds, exclude, groups.data],
  );
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
    setPrefill((previous) => ({
      values: (previous?.values || 0) + applied.length,
      devices: Math.max(previous?.devices || 0, touched.size),
    }));
    setPreview(null);
  }

  const blockers = (preview?.blockers || []) as PreviewBlocker[];
  const deviceName = (id: string) =>
    preview?.devices.find((device) => device.id === id)?.name ||
    devices.data.find((device) => device.id === id)?.name ||
    id;
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
  const requirements = version ? fullModeRequirements(version.config) : [];
  const restrictedTargets: Device[] = (
    preview?.devices ||
    devices.data.filter((device) => effective.has(device.id))
  ).filter((device: Device) => {
    const latest = devices.data.find((known) => known.id === device.id);
    return (
      device.configuration_mode !== "full" ||
      (latest && latest.configuration_mode !== "full")
    );
  });
  const capabilityBlocked =
    requirements.length > 0 && restrictedTargets.length > 0;
  const settingsMismatch: Device[] =
    policy && preserveExistingSettings
      ? (
          preview?.devices ||
          devices.data.filter((device) => effective.has(device.id))
        ).filter((device: Device) => {
          const same = (current?: Policy) =>
            current?.heartbeat_seconds === policy.heartbeat_seconds &&
            current?.telemetry_enabled === policy.telemetry_enabled;
          const latest = devices.data.find((known) => known.id === device.id);
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
      setError(
        "Complete the device-specific values before reviewing this deployment.",
      );
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
  const visibleDevices = devices.data.filter(
    (d) =>
      d.status !== "revoked" &&
      (d.name + " " + d.os).toLowerCase().includes(search.toLowerCase()),
  );
  const devicePageSize = 100;
  const devicePageCount = Math.max(
    1,
    Math.ceil(visibleDevices.length / devicePageSize),
  );
  const currentDevicePage = Math.min(devicePage, devicePageCount);
  const devicePageStart = (currentDevicePage - 1) * devicePageSize;
  const listedDevices = visibleDevices.slice(
    devicePageStart,
    devicePageStart + devicePageSize,
  );
  function chooseDevice(id: string) {
    const includedByGroup = groups.data.some(
      (g) => groupIds.includes(g.id) && g.device_ids.includes(id),
    );
    if (effective.has(id)) {
      setSelected((old) => old.filter((item) => item !== id));
      if (includedByGroup) setExclude((old) => [...new Set([...old, id])]);
    } else {
      setExclude((old) => old.filter((item) => item !== id));
      setSelected((old) => [...new Set([...old, id])]);
    }
    resetReview();
  }
  const resource = policy ? "policy" : "configuration";
  const change: RequestedChange = policy
    ? { kind: "policy", policy, name: policyName || null }
    : {
        kind: "configuration",
        configurationId: version?.configuration_id || null,
        pipeline:
          pipelineName ||
          inferPipelineName(preview, version?.configuration_id || null),
        number: version?.number ?? null,
      };
  const outcomes = new Map(
    (preview?.outcomes || [])
      .filter((entry) => entry.resource === resource)
      .map((entry) => [entry.device_id, entry]),
  );
  const paused = new Set(preview?.paused_device_ids || []);
  function outcomeFor(device: Device): Outcome | null {
    const outcome = outcomes.get(device.id);
    if (!outcome) return null;
    if (outcome.outcome === "replace")
      return {
        label: "Replaces",
        tone: "info",
        detail: null,
        assignment: outcome.replaces || null,
        takes: true,
      };
    if (outcome.outcome === "conflict") {
      const other = conflictRows(
        {
          outcomes: [outcome],
          conflicts: preview?.conflicts || [],
          devices: [device],
        },
        resource,
      )[0]?.assignments[0];
      return {
        label: "Conflict",
        tone: "danger",
        detail: "Same priority, different content",
        assignment: other || null,
        takes: false,
      };
    }
    if (outcome.outcome === "higher_priority")
      return {
        label: "Keeps current",
        tone: "warning",
        detail: `Priority ${outcome.assignment?.priority ?? "higher"} wins`,
        assignment:
          outcome.winner && outcome.winner.id === outcome.assignment?.id
            ? outcome.winner
            : null,
        takes: false,
      };
    if (outcome.winner)
      return {
        label: "Takes over",
        tone: "success",
        detail: `From priority ${outcome.winner.priority}`,
        assignment: outcome.winner,
        takes: true,
      };
    return {
      label: "New",
      tone: "success",
      detail:
        resource === "policy" ? "No settings assigned" : "No pipeline assigned",
      assignment: null,
      takes: true,
    };
  }
  const configurationId = version?.configuration_id || null;
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
        : requestedName(change);
    return paused.has(device.id) ? `${next}, after sync resumes` : next;
  };
  const shortName = (assignment: AssignmentDescription) =>
    shortAssignmentName(assignment, configurationId);
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
  const checkIn = Math.max(
    10,
    ...devices.data
      .filter((device) => effective.has(device.id))
      .map((device) => device.check_in_seconds || 60),
  );
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
  const title = policy
    ? policyName
      ? `Apply “${policyName}”`
      : preserveExistingSettings
        ? policy.sync_paused
          ? "Pause sync"
          : "Resume sync"
        : "Apply agent settings"
    : pipelineName
      ? `Deploy ${pipelineName} v${version?.number ?? ""}`
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
        {(error || devices.error || groups.error) && (
          <ErrorBox message={error || devices.error || groups.error} />
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
                ? "Some selected devices use restricted mode"
                : "This pipeline uses full Vector capabilities"}
            </strong>
            {capabilityBlocked ? (
              <p>
                This pipeline uses {requirements.join(", ")}. Full Vector mode
                must be enabled locally by the host operator; the dashboard
                cannot enable it.{" "}
                <DocLink
                  topic="installation"
                  section="choose-configuration-capabilities"
                >
                  Enable full Vector mode on a device
                </DocLink>
              </p>
            ) : (
              <p>
                This pipeline uses {requirements.join(", ")}. All selected
                devices currently report full Vector mode.
              </p>
            )}
            {capabilityBlocked && (
              <p>
                Choose devices with full Vector mode or change this pipeline.
                Restricted devices:{" "}
                {restrictedTargets.map((device) => device.name).join(", ")}.
              </p>
            )}
          </div>
        )}
        {!preview ? (
          <fieldset className="target-selection" disabled={busy}>
            <label className="target-search">
              <Search size={17} />
              <input
                aria-label="Find targets"
                placeholder="Search devices or groups"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setDevicePage(1);
                }}
              />
            </label>
            {groups.data.length > 0 && (
              <details className="control-disclosure target-group-list">
                <summary>
                  Choose groups ({groups.data.length})
                  {groupIds.length > 0 && `, ${groupIds.length} selected`}
                </summary>
                <div className="target-group-options">
                  {groups.data
                    .filter((g) =>
                      g.name.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((g) => (
                      <label className="target-option" key={g.id}>
                        <input
                          type="checkbox"
                          checked={groupIds.includes(g.id)}
                          onChange={() => toggle(g.id, groupIds, setGroupIds)}
                        />
                        <span>
                          <strong>{g.name}</strong>
                          <small>{devicesText(g.device_ids.length)}</small>
                        </span>
                      </label>
                    ))}
                </div>
              </details>
            )}
            <div className="target-device-list">
              <h3>Devices</h3>
              {listedDevices.map((d) => (
                <label className="target-option" key={d.id}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${d.name}`}
                    checked={effective.has(d.id)}
                    onChange={() => chooseDevice(d.id)}
                  />
                  <span>
                    <strong>{d.name}</strong>
                    <small>
                      {d.os} · {statusText(d)} ·{" "}
                      {d.configuration_mode === "full"
                        ? "Full Vector mode"
                        : "Restricted mode"}
                    </small>
                  </span>
                  <span className="target-option-now">
                    <small>Now</small>
                    {nowText(d)}
                  </span>
                </label>
              ))}
              {!visibleDevices.length && (
                <p className="control-muted">
                  {devices.data.length
                    ? "No devices match your search."
                    : "Add a device before deploying."}
                </p>
              )}
            </div>
            {visibleDevices.length > devicePageSize && (
              <nav
                className="target-device-pagination"
                aria-label="Device selection pages"
              >
                <span aria-live="polite">
                  Showing {devicePageStart + 1}–
                  {Math.min(
                    devicePageStart + devicePageSize,
                    visibleDevices.length,
                  )}{" "}
                  of {visibleDevices.length} devices
                </span>
                <div>
                  <Button
                    variant="secondary compact"
                    disabled={currentDevicePage === 1}
                    onClick={() => setDevicePage(currentDevicePage - 1)}
                  >
                    Previous devices
                  </Button>
                  <span>
                    Page {currentDevicePage} of {devicePageCount}
                  </span>
                  <Button
                    variant="secondary compact"
                    disabled={currentDevicePage === devicePageCount}
                    onClick={() => setDevicePage(currentDevicePage + 1)}
                  >
                    Next devices
                  </Button>
                </div>
              </nav>
            )}
            <div className="target-selection-summary">
              {effective.size} {effective.size === 1 ? "device" : "devices"}{" "}
              selected
              {exclude.length > 0 && (
                <span>, {exclude.length} excluded from selected groups</span>
              )}
            </div>
            {declarations.length > 0 && (
              <>
                {prefill && (
                  <p className="target-prefill" role="status">
                    <Check size={15} aria-hidden="true" />
                    Filled {prefill.values}{" "}
                    {prefill.values === 1 ? "value" : "values"} from the version{" "}
                    {prefill.devices === 1
                      ? "this device runs"
                      : "these devices run"}{" "}
                    now. Change any of them before you review.
                  </p>
                )}
                <DeploymentVariableFields
                  declarations={declarations}
                  devices={devices.data.filter((device) =>
                    effective.has(device.id),
                  )}
                  inputs={bindingInputs}
                  persistent={persistent}
                  onChange={(next) => {
                    setBindingInputs(next);
                    setPreview(null);
                    setError("");
                  }}
                />
                {effective.size > 0 && bindingResult.errors.length > 0 && (
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
                        <AssignmentLink
                          assignment={replacement.assignment}
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
                    ? "Follows the selected groups"
                    : single
                      ? "Fixed to this device"
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
              onReplace={(ids) =>
                void review({
                  ...inputs,
                  replaces: [...new Set([...replaces, ...ids])],
                })
              }
            />
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
                          {outcome.assignment ? (
                            <small>
                              <AssignmentLink
                                assignment={outcome.assignment}
                                label={shortName(outcome.assignment)}
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
                                  <code>
                                    {artifactByDevice.get(device.id)!.sha256}
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
            devices.loading ||
            groups.loading ||
            !!devices.error ||
            !!groups.error ||
            (!preview && !releaseValid) ||
            (!!preview && capabilityBlocked) ||
            (!!preview &&
              (preview.create_idempotency !== true ||
                preview.request_correlation !== true)) ||
            (!!preview && !!settingsMismatch.length) ||
            !!preview?.conflicts?.length ||
            blockers.length > 0 ||
            (!preview &&
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
