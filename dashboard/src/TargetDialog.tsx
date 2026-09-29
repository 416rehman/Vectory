import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Clock, Search } from "lucide-react";
import {
  boundedPost as post,
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
import "./control.css";
type PreviewBlocker = {
  code: string;
  reason: string;
  resource: "configuration" | "policy";
  device_ids: string[];
  deployment_id?: string;
};
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
export default function TargetDialog({
  userId,
  open,
  onClose,
  version,
  policy,
  onDone,
  initialDeviceIds = [],
  preserveExistingSettings = false,
}: {
  userId: string;
  open: boolean;
  onClose: () => void;
  version?: Version;
  policy?: Policy;
  onDone: (message: string) => void;
  initialDeviceIds?: string[];
  preserveExistingSettings?: boolean;
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
    [priority, setPriority] = useState(100),
    [mode, setMode] = useState("snapshot"),
    [schedule, setSchedule] = useState(""),
    [rollout, setRollout] = useState("all"),
    [canary, setCanary] = useState(1),
    [batch, setBatch] = useState(10),
    [observe, setObserve] = useState(60),
    [busy, setBusy] = useState(false),
    [created, setCreated] = useState<{
      id: string | null;
      scheduled: boolean;
      scheduledAt: string | null;
      status: string;
    } | null>(null),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<any>(null);
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
  const persistent = !schedule && mode === "persistent";
  const bindingResult = useMemo(
    () =>
      resolveVariableBindings(
        declarations,
        bindingInputs,
        [...effective],
        persistent,
      ),
    [version?.variables, bindingInputs, effective, persistent],
  );
  const body = useMemo(
    () => ({
      ...(version ? { version_id: version.id } : { policy }),
      selector: {
        device_ids: selected,
        group_ids: groupIds,
        exclude_ids: exclude,
      },
      ...(declarations.length
        ? { variable_bindings: bindingResult.bindings }
        : {}),
      priority,
      target_mode: schedule ? "snapshot" : mode,
      scheduled_at: schedule ? new Date(schedule).toISOString() : null,
      rollout: {
        kind: rollout,
        canary_size: canary,
        batch_size: batch,
        observation_seconds: observe,
        failure_threshold: 0,
      },
    }),
    [
      version,
      policy,
      selected,
      groupIds,
      exclude,
      declarations.length,
      bindingResult.bindings,
      priority,
      mode,
      schedule,
      rollout,
      canary,
      batch,
      observe,
    ],
  );
  const currentBody = useRef("");
  const mounted = useRef(true);
  const currentActor = useRef(userId);
  currentActor.current = userId;
  const inFlight = useRef(false);
  const receiptLink = useRef<HTMLAnchorElement>(null);
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
  const blockers = (preview?.blockers || []) as PreviewBlocker[];
  const blockedDeviceNames = (blocker: PreviewBlocker) =>
    blocker.device_ids.map(
      (id) =>
        (preview?.devices as Device[] | undefined)?.find(
          (device) => device.id === id,
        )?.name ||
        devices.data.find((device) => device.id === id)?.name ||
        id,
    );
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
  function change<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setPreview(null);
  }
  function toggle(
    value: string,
    list: string[],
    setter: (v: string[]) => void,
  ) {
    change(
      setter,
      list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
    );
  }
  async function submit() {
    if (inFlight.current || created) return;
    if (bindingResult.errors.length) {
      setError("Complete the device-specific values before reviewing this deployment.");
      return;
    }
    const registry = readDeploymentRegistry(userId);
    if (registry.errors.length) {
      setStorageIssue(registry.errors[0]);
      return;
    }
    const existing = registry.operations[0];
    if (existing) {
      setError("");
      setRecovery(existing);
      return;
    }
    let operation: DeploymentOperation | null = null;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!preview) {
        const request = structuredClone(body),
          key = JSON.stringify(request);
        const result = await post<DeploymentPreview>(
          "/deployments/preview",
          request,
        );
        if (!mounted.current || currentActor.current !== userId) return;
        if (currentBody.current === key)
          setPreview({ ...result, request, key });
        else
          setError(
            "Targets changed during preview. Review the current selection again.",
          );
      } else {
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
            ...preview.request,
            expected_device_ids: preview.devices.map((d: Device) => d.id),
          },
          preview.create_idempotency === true,
          policy ? "Agent settings" : `Pipeline version ${version?.number}`,
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
            ? "Deployment scheduled. Target membership is frozen."
            : "Deployment saved. Open its progress to track device results.",
        );
      }
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
    setPreview(null);
  }
  const currentState = (device: Device) =>
    policy
      ? device.sync_paused
        ? "Sync paused"
        : "Sync enabled"
      : device.desired_version_id
        ? device.desired_version_id === version?.id
          ? `Version ${version.number}`
          : "Another version assigned"
        : "No pipeline assigned";
  const outcomes = new Map(
    ((preview?.outcomes as DeploymentPreview["outcomes"]) || [])
      .filter(
        (entry) => entry.resource === (policy ? "policy" : "configuration"),
      )
      .map((entry) => [entry.device_id, entry]),
  );
  const priorityOutcome = (device: Device) => {
    const outcome = outcomes.get(device.id);
    if (outcome?.outcome === "higher_priority")
      return `Higher priority wins${outcome.assignment ? ` (${outcome.assignment.priority})` : ""}`;
    if (outcome?.outcome === "conflict") return "Conflicting assignment";
    if (outcome?.outcome === "requested") return "No current priority conflict";
    return "Priority outcome unavailable";
  };
  const overridden = ((preview?.devices as Device[]) || []).filter(
    (device) => outcomes.get(device.id)?.outcome === "higher_priority",
  );
  const artifactPreviews = (preview?.artifact_previews || []) as NonNullable<
    DeploymentPreview["artifact_previews"]
  >;
  const artifactByDevice = new Map(
    artifactPreviews.map((artifact) => [artifact.device_id, artifact]),
  );
  const artifactReviewIncomplete =
    declarations.length > 0 &&
    !!preview &&
    (artifactPreviews.length !== preview.devices.length ||
      artifactByDevice.size !== artifactPreviews.length ||
      preview.devices.some((device: Device) => {
        const artifact = artifactByDevice.get(device.id);
        return (
          !artifact ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.size) ||
          artifact.size <= 0
        );
      }));
  const reviewedBindings = preview?.request?.variable_bindings as
    | typeof bindingResult.bindings
    | undefined;
  const bindingFor = (deviceId: string, name: string) => {
    const override = reviewedBindings?.devices?.[deviceId];
    if (override && Object.prototype.hasOwnProperty.call(override, name))
      return { source: "Override", value: override[name] };
    return {
      source: "Default",
      value: reviewedBindings?.defaults?.[name],
    };
  };
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
  if (created) {
    const scheduled = created.scheduled;
    const awaitingSchedule = created.status === "scheduled";
    const destination = deploymentRoute(scheduled, created.id, {
      search: "",
      status: "all",
      page: 1,
    });
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={awaitingSchedule ? "Deployment scheduled" : "Deployment created"}
        description="The original request is saved. Open the deployment to review its current status and device results."
      >
        <div className="modal-body target-receipt">
          {error && <ErrorBox message={error} />}
          <div className="target-receipt-heading">
            <span className="target-receipt-icon">
              {awaitingSchedule ? <Clock size={20} /> : <Check size={20} />}
            </span>
            <div>
              <strong>
                {policy
                  ? "Agent settings"
                  : `Pipeline version ${version?.number}`}
              </strong>
              <p>
                {preview.devices.length}{" "}
                {preview.devices.length === 1 ? "device" : "devices"} in the
                original review
              </p>
            </div>
          </div>
          <dl className="control-summary-list">
            <div>
              <dt>Reviewed timing</dt>
              <dd>
                {scheduled && created.scheduledAt
                  ? new Date(created.scheduledAt).toLocaleString()
                  : "After release and the next agent check-in"}
              </dd>
            </div>
            <div>
              <dt>Reviewed priority</dt>
              <dd>{preview.request.priority}</dd>
            </div>
          </dl>
          <p className="control-muted">
            This receipt confirms the request was saved. It does not confirm
            that devices applied it.
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
              : scheduled
                ? "View schedule"
                : "View deployment"}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
      title={
        policy
          ? "Apply agent settings"
          : `Deploy version ${version?.number ?? ""}`
      }
      description="Choose devices, then review exactly what will be sent."
    >
      <div className="modal-body target-flow">
        <ol className="control-steps" aria-label="Deployment steps">
          <li aria-current={!preview ? "step" : undefined}>
            <span>1</span>Choose devices
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
            message={`To preserve check-in and telemetry settings, choose devices with matching settings. These devices differ or have no reported settings: ${settingsMismatch.map((device) => device.name).join(", ")}.`}
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
          <>
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
                  <summary>Choose groups ({groups.data.length})</summary>
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
                            <small>{g.device_ids.length} devices</small>
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
                        {d.os},{" "}
                        {d.status === "offline"
                          ? "Offline, applies when reconnected"
                          : d.status.replaceAll("_", " ")}
                        {", "}
                        {d.configuration_mode === "full"
                          ? "Full Vector mode"
                          : "Restricted mode"}
                      </small>
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
                    )} of {visibleDevices.length} devices
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
                  <DeploymentVariableFields
                    declarations={declarations}
                    devices={devices.data.filter((device) => effective.has(device.id))}
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
              <details className="control-disclosure target-advanced">
                <summary>Advanced options</summary>
                <div className="control-disclosure-content">
                  <div className="control-two-col">
                    <Field
                      label="Assignment priority"
                      hint="Higher priorities win. Equal priorities must agree."
                    >
                      <input
                        type="number"
                        min={-1000000}
                        max={1000000}
                        value={priority}
                        onChange={(e) => change(setPriority, +e.target.value)}
                      />
                    </Field>
                    <Field label="Target membership">
                      <select
                        value={schedule ? "snapshot" : mode}
                        disabled={!!schedule}
                        onChange={(e) => change(setMode, e.target.value)}
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
                  <Field
                    label="Schedule (optional)"
                    hint={`Local time: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Scheduled targets stay fixed.`}
                  >
                    <input
                      type="datetime-local"
                      value={schedule}
                      min={new Date(
                        Date.now() +
                          60000 -
                          new Date().getTimezoneOffset() * 60000,
                      )
                        .toISOString()
                        .slice(0, 16)}
                      onChange={(e) => change(setSchedule, e.target.value)}
                    />
                  </Field>
                  <Field label="Release strategy">
                    <select
                      value={rollout}
                      onChange={(e) => change(setRollout, e.target.value)}
                    >
                      <option value="all">All selected devices</option>
                      <option value="canary">
                        Start with a canary, then batches
                      </option>
                    </select>
                  </Field>
                  {rollout === "canary" && (
                    <div className="control-three-col">
                      <Field label="Canary devices">
                        <input
                          type="number"
                          min={1}
                          value={canary}
                          onChange={(e) => change(setCanary, +e.target.value)}
                        />
                      </Field>
                      <Field label="Batch size">
                        <input
                          type="number"
                          min={1}
                          value={batch}
                          onChange={(e) => change(setBatch, +e.target.value)}
                        />
                      </Field>
                      <Field label="Observe (seconds)">
                        <input
                          type="number"
                          min={10}
                          max={86400}
                          value={observe}
                          onChange={(e) => change(setObserve, +e.target.value)}
                        />
                      </Field>
                    </div>
                  )}
                </div>
              </details>
            </fieldset>
          </>
        ) : (
          <div className="target-review">
            <div className="target-review-heading">
              <h3>
                {preview.devices.length}{" "}
                {preview.devices.length === 1 ? "device" : "devices"} selected
                for review
              </h3>
              <p>
                {policy
                  ? `Heartbeat every ${policy.heartbeat_seconds} seconds, ${policy.sync_paused ? "Pause configuration sync" : "Enable configuration sync"}, metrics ${policy.telemetry_enabled ? "on" : "off"}`
                  : `Published version ${version?.number}`}
              </p>
            </div>
            <dl className="control-summary-list">
              <div>
                <dt>When</dt>
                <dd>
                  {schedule
                    ? new Date(schedule).toLocaleString()
                    : "After release and the next agent check-in"}
                </dd>
              </div>
              <div>
                <dt>Release</dt>
                <dd>
                  {rollout === "canary"
                    ? `${canary} canary devices, then batches of ${batch}`
                    : "All selected devices"}
                </dd>
              </div>
              <div>
                <dt>Membership</dt>
                <dd>
                  {body.target_mode === "persistent"
                    ? "Follows selected groups"
                    : "Fixed to the devices below"}
                </dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>{priority}</dd>
              </div>
              {declarations.length > 0 && (
                <div>
                  <dt>Device-specific values</dt>
                  <dd>
                    {declarations.length} {declarations.length === 1 ? "field" : "fields"},
                    reviewed per device
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
                    {blockedDeviceNames(blocker).join(", ")}.
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
            {overridden.length > 0 && (
              <div className="control-note" role="status">
                <strong>
                  Higher-priority assignments take precedence on{" "}
                  {overridden.length}{" "}
                  {overridden.length === 1 ? "device" : "devices"}
                </strong>
                <p>
                  This request will not replace them. Go back to change its
                  priority or the selected devices.
                </p>
              </div>
            )}
            {preview.conflicts?.length > 0 && (
              <ErrorBox message="Some selected devices have a conflicting assignment. Go back and change the selection or priority before sending." />
            )}
            {preview.conflicts?.length > 0 && (
              <details className="control-disclosure">
                <summary>Conflict details</summary>
                <pre>{JSON.stringify(preview.conflicts, null, 2)}</pre>
              </details>
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
                          {device.status === "offline" && (
                            <small>Offline</small>
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
                    id: "current",
                    header: "Current",
                    value: currentState,
                    cell: currentState,
                    filter: {
                      options: [
                        ...new Set<string>(
                          (preview.devices as Device[]).map(currentState),
                        ),
                      ].map((value) => ({ value, label: value })),
                    },
                  },
                  {
                    id: "outcome",
                    header: "Priority outcome",
                    value: priorityOutcome,
                    cell: (device) => (
                      <>
                        {priorityOutcome(device)}
                        {outcomes.get(device.id)?.assignment && (
                          <small>
                            <a
                              aria-disabled={busy || undefined}
                              onClick={(event) => {
                                if (inFlight.current) event.preventDefault();
                              }}
                              href={`#/${deploymentRoute(false, outcomes.get(device.id)!.assignment!.id, { search: "", status: "all", page: 1 })}`}
                            >
                              View assignment
                            </a>
                          </small>
                        )}
                      </>
                    ),
                    filter: {
                      options: [
                        ...new Set<string>(
                          (preview.devices as Device[]).map(priorityOutcome),
                        ),
                      ].map((value) => ({ value, label: value })),
                    },
                  },
                  ...(declarations.length > 0
                    ? [{
                        id: "bindings",
                        header: "Values and rendered artifact",
                        value: (device: Device) =>
                          declarations
                            .map((declaration) =>
                              String(bindingFor(device.id, declaration.name).value ?? ""),
                            )
                            .join(" "),
                        cell: (device: Device) => (
                          <div className="target-review-variables">
                            {declarations.map((declaration) => {
                              const binding = bindingFor(device.id, declaration.name);
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
                                <code>{artifactByDevice.get(device.id)!.sha256}</code>
                                <small>{artifactByDevice.get(device.id)!.size} bytes</small>
                              </div>
                            )}
                          </div>
                        ),
                      }]
                    : []),
                ]}
                empty="No reviewed devices match these filters."
              />
            </div>
            <p className="control-muted">
              Column filters only change this view. All {preview.devices.length}{" "}
              reviewed devices remain included.
            </p>
            <div className="target-review-notes">
              <p>
                {schedule
                  ? "Priority outcomes reflect current assignments. They are checked again when the schedule runs."
                  : "Priority outcomes reflect current assignments. Eligible devices still wait for rollout release and agent verification."}
              </p>
              {!preview.outcomes && (
                <p>
                  This server does not report priority outcomes. Review existing
                  assignments before sending.
                </p>
              )}
              {preview.warnings?.map((warning: string) => (
                <p key={warning}>{warning}</p>
              ))}
              <p>
                Progress is complete only after each agent verifies the change.
              </p>
              {version && (
                <p>
                  Each device validates against its installed Vector build and
                  local resources before activation. Full mode uses the Vector
                  process's OS permissions; restricted mode also checks local
                  file, network and listener rules. This page cannot verify
                  those resources.
                </p>
              )}
            </div>
            {version && (
              <details className="control-disclosure">
                <summary>Technical details</summary>
                <dl className="control-summary-list">
                  <div>
                    <dt>{declarations.length ? "Published base SHA-256" : "Artifact SHA-256"}</dt>
                    <dd className="control-wrap-code">{version.sha256}</dd>
                  </div>
                  <div>
                    <dt>Priority</dt>
                    <dd>{priority}</dd>
                  </div>
                </dl>
              </details>
            )}
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
            (!!preview && capabilityBlocked) ||
            (!!preview &&
              (preview.create_idempotency !== true ||
                preview.request_correlation !== true)) ||
            (!!preview && !!settingsMismatch.length) ||
            !!preview?.conflicts?.length ||
            blockers.length > 0 ||
            (!preview && declarations.length > 0 && bindingResult.errors.length > 0) ||
            artifactReviewIncomplete
          }
          onClick={submit}
        >
          {preview
            ? schedule
              ? "Schedule deployment"
              : policy
                ? "Apply settings"
                : "Deploy to devices"
            : "Review deployment"}
        </Button>
      </div>
    </Modal>
  );
}
