import {
  APIError,
  isSessionInterruption,
  type Device,
  type DeviceValidation,
  type DeviceValidationDevice,
} from "./api";
import { defaultRelease, rolloutFor } from "./deploymentReviewModel";
import { CommandValueError } from "./enrollmentCommands";
import { bindingCommands, stateDirArguments } from "./hostApprovalCommands";
import { bindingInstructions, type BindingPlatform } from "./secretFields";
import type { StatusIcon, StatusTone } from "./status";

/**
 * "Check on devices": what the review shows while the target devices validate
 * the candidate on their own hosts. Everything here is advisory. A check never
 * changes a deployment, a device or the Deploy button, so nothing in this
 * file decides whether a deployment may be sent.
 */

/** How often a running check is read. */
export const POLL_MS = 2000;
/** The slowest a failing read backs off to. */
export const POLL_BACKOFF_MS = 10000;

/** What one device's row comes to, for the matrix and the summary line. */
export type CheckKind =
  | "pending"
  | "passed"
  | "needs_fix"
  | "needs_secret"
  | "offline"
  | "expired"
  | "unsupported";

export function checkKind(
  row: Pick<DeviceValidationDevice, "state" | "secrets_missing">,
): CheckKind {
  if (row.state === "failed")
    return row.secrets_missing.length > 0 ? "needs_secret" : "needs_fix";
  return row.state;
}

export const checkLook: Record<
  CheckKind,
  { label: string; tone: StatusTone; icon: StatusIcon }
> = {
  pending: { label: "Checking…", tone: "info", icon: "progress" },
  passed: { label: "Passes here", tone: "success", icon: "check" },
  needs_fix: { label: "Needs a fix", tone: "danger", icon: "x" },
  needs_secret: { label: "Needs a secret", tone: "warning", icon: "alert" },
  offline: { label: "Offline: not checked", tone: "neutral", icon: "offline" },
  expired: { label: "No answer in time", tone: "warning", icon: "clock" },
  unsupported: {
    label: "Older agent: can't check",
    tone: "neutral",
    icon: "minus",
  },
};

/** The kinds a person can ask again for as a group: nothing came back. */
export function isUnanswered(kind: CheckKind) {
  return kind === "offline" || kind === "expired";
}

/** What a device that hasn't bound a secret says, per secret, around its name. */
export function secretLineParts(name: string) {
  return ["Secret ", name, " isn't bound on this device"] as const;
}
export function secretLine(name: string) {
  return secretLineParts(name).join("");
}

export function platformOf(device?: Pick<Device, "os">): BindingPlatform {
  return device?.os === "windows" ? "windows" : "unix";
}

/** What a device reports about how its host runs the agent. */
export type CheckedHost = Pick<
  Device,
  "os" | "secret_names" | "state_dir" | "service_manager"
> &
  Partial<Pick<Device, "name">>;

/**
 * The commands that bind the missing names on a host. The bindings file
 * replaces every binding, so it lists the names the host already has too. The
 * commands are made for the host: its state directory when that isn't the
 * default, and the way it stops and starts its agent, as the host commands for
 * an allowance are. Without a device they are the generic ones.
 */
export function bindCommands(missing: readonly string[], device?: CheckedHost) {
  const steps = bindingInstructions(
    [...(device?.secret_names ?? []), ...missing],
    platformOf(device),
  );
  return device
    ? {
        ...steps,
        commands: bindingCommands(steps.bindingsFile, {
          name: device.name ?? "",
          os: device.os,
          state_dir: device.state_dir,
          service_manager: device.service_manager,
        }),
      }
    : steps;
}

/**
 * A fix that names `vectory allow` runs on a host whose agent may keep its
 * state elsewhere. Say so with `--state-dir`, as the commands for the host do,
 * so the command the person pastes reaches the agent that refused.
 */
export function hostHint(
  hint: string | undefined,
  device?: Pick<Device, "os" | "state_dir">,
) {
  if (!hint || !device?.state_dir) return hint;
  let stateDir: string[];
  try {
    stateDir = stateDirArguments(device);
  } catch (error) {
    if (error instanceof CommandValueError) return hint;
    throw error;
  }
  return stateDir.length
    ? hint.replace(
        /\bvectory allow (?!--state-dir\b)/g,
        `vectory allow ${stateDir.join(" ")} `,
      )
    : hint;
}

/* ---------- What the review was, when the check was asked for ---------- */

/**
 * The version and, for each device, the digest of the candidate it would be
 * offered. A check belongs to exactly this: a different version, a device
 * added or removed, or a changed value on a device is a different check.
 * Priority, canary and replacement choices don't change what a device is
 * asked to validate, so they are not part of it.
 */
export function reviewIdentity(
  request: { version_id?: unknown },
  devices: readonly { id: string }[],
  artifacts: readonly { device_id: string; sha256: string }[] | undefined,
) {
  const digests = new Map(
    (artifacts ?? []).map((artifact) => [artifact.device_id, artifact.sha256]),
  );
  return [
    String(request.version_id ?? ""),
    ...devices.map((device) => `${device.id}:${digests.get(device.id) ?? ""}`),
  ]
    .sort()
    .join("|");
}

/** The request that asks every reviewed device, as the review sent it. */
export function checkBody(request: Record<string, unknown>, runTests: boolean) {
  return { ...request, device_validation: true, run_tests: runTests };
}

/**
 * The request for some of the reviewed devices only: the same version and the
 * same values for them, nothing that depends on the rest of the selection
 * (groups, exclusions, a canary, replaced assignments, a schedule). The server
 * refuses a value for a device that isn't selected, so the values are cut too.
 */
export function retryBody(
  request: Record<string, any>,
  deviceIds: readonly string[],
  runTests: boolean,
) {
  const ids = [...new Set(deviceIds)];
  const bindings = request.variable_bindings as
    | {
        defaults?: Record<string, unknown>;
        devices?: Record<string, unknown>;
      }
    | undefined;
  return {
    version_id: request.version_id,
    selector: { device_ids: ids, group_ids: [], exclude_ids: [] },
    ...(bindings
      ? {
          variable_bindings: {
            defaults: bindings.defaults ?? {},
            devices: Object.fromEntries(
              ids.flatMap((id) =>
                bindings.devices && id in bindings.devices
                  ? [[id, bindings.devices[id]]]
                  : [],
              ),
            ),
          },
        }
      : {}),
    priority: request.priority,
    target_mode: "snapshot",
    scheduled_at: null,
    rollout: rolloutFor(defaultRelease),
    device_validation: true,
    run_tests: runTests,
  };
}

/* ---------- Runs: one check, then the retries for some of its devices ---------- */

export type Run = {
  id: string;
  /** What the review was when this was asked for. */
  identity: string;
  requestedAt: number;
  /** The devices a retry asked again; null for the check of the whole review. */
  scope: readonly string[] | null;
  detail: DeviceValidation | null;
};

const waiting = (id: string, name: string): DeviceValidationDevice => ({
  id,
  name,
  state: "pending",
  diagnostics: [],
  tests: [],
  secrets_missing: [],
  updated_at: "",
});

/**
 * One row per device, in name order: the newest answer for each. A device a
 * retry has asked again reads "Checking…" at once, never its earlier answer.
 */
export function mergeRuns(runs: readonly Run[]): DeviceValidationDevice[] {
  const first = runs[0]?.detail;
  if (!first) return [];
  const rows = new Map(first.devices.map((row) => [row.id, row]));
  for (const run of runs.slice(1))
    for (const id of run.scope ?? []) {
      const known = rows.get(id);
      if (!known) continue;
      rows.set(
        id,
        run.detail?.devices.find((row) => row.id === id) ??
          waiting(id, known.name),
      );
    }
  return first.devices.map((row) => rows.get(row.id)!);
}

/** Whether anything is still being asked: a run unread, or one with devices pending. */
export function isRunning(runs: readonly Run[]) {
  return runs.some((run) => !run.detail || run.detail.state === "running");
}

/** Runs worth reading again. */
export function runsToRead(runs: readonly Run[]) {
  return runs.filter((run) => !run.detail || run.detail.state === "running");
}

/* ---------- The summary line ---------- */

export type Summary = {
  total: number;
  /** Devices that gave an answer: passed or failed. */
  answered: number;
  running: boolean;
  counts: Record<CheckKind, number>;
  text: string;
};

const noun = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Each kind's words in the summary, in the order they are read. */
const phrases: [CheckKind, (n: number) => string][] = [
  ["passed", (n) => (n === 1 ? "1 passes" : `${n} pass`)],
  ["needs_secret", (n) => `${n} ${noun(n, "needs", "need")} a secret`],
  ["needs_fix", (n) => `${n} ${noun(n, "needs", "need")} a fix`],
  ["offline", (n) => `${n} offline`],
  ["expired", (n) => `${n} didn't answer`],
  ["unsupported", (n) => `${n} ${noun(n, "has", "have")} an older agent`],
  ["pending", (n) => `${n} still checking`],
];

/**
 * "Checked 3 of 4 devices: 2 pass, 1 needs a secret, 1 offline." Always the
 * rows as they are: it counts what answered, and says what didn't.
 */
export function summarize(rows: readonly DeviceValidationDevice[]): Summary {
  const counts: Record<CheckKind, number> = {
    pending: 0,
    passed: 0,
    needs_fix: 0,
    needs_secret: 0,
    offline: 0,
    expired: 0,
    unsupported: 0,
  };
  for (const row of rows) counts[checkKind(row)] += 1;
  const total = rows.length;
  const answered = counts.passed + counts.needs_fix + counts.needs_secret;
  const running = counts.pending > 0;
  const parts = phrases
    .filter(([kind]) => counts[kind] > 0)
    .map(([kind, say]) => say(counts[kind]));
  const text = total
    ? `Checked ${answered} of ${total} ${noun(total, "device", "devices")}${running ? " so far" : ""}: ${parts.join(", ")}.`
    : "No device was asked.";
  return { total, answered, running, counts, text };
}

/** Said when the list was cut: it is always the devices first by name. */
export function truncationNote(asked: number, reviewed: number) {
  const left = reviewed - asked;
  return `Checked the first ${asked.toLocaleString()} devices by name.${
    left > 0
      ? ` The other ${left.toLocaleString()} ${noun(left, "wasn't", "weren't")} checked.`
      : ""
  }`;
}

/* ---------- One device's row ---------- */

/** The finding to lead with: the first error, else the first of anything. */
export function leadFinding(row: Pick<DeviceValidationDevice, "diagnostics">) {
  return (
    row.diagnostics.find((finding) => finding.severity === "error") ??
    row.diagnostics[0]
  );
}

/** "2 of 4 tests pass, 1 fails, 1 didn't run"; null when there were none. */
export function testsLine(tests: DeviceValidationDevice["tests"]) {
  if (!tests.length) return null;
  const notRun = tests.filter((test) => test.not_run).length;
  const passed = tests.filter((test) => test.passed && !test.not_run).length;
  const failed = tests.length - passed - notRun;
  return [
    `${passed} of ${tests.length} ${noun(tests.length, "test passes", "tests pass")}`,
    failed ? `${failed} ${noun(failed, "fails", "fail")}` : "",
    notRun ? `${notRun} didn't run` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** How long the device took: "850 ms" or "1.4 s". */
export function tookText(milliseconds: number | undefined) {
  if (milliseconds === undefined) return null;
  return milliseconds < 1000
    ? `${milliseconds} ms`
    : `${(milliseconds / 1000).toFixed(1)} s`;
}

/** Findings behind the first one, and whether there is anything more to open. */
export function hasMore(row: DeviceValidationDevice) {
  return row.diagnostics.length > 1 || row.tests.length > 0;
}

/* ---------- When something goes wrong ---------- */

/** A calm inline message: what happened, whether anything changed, what to do. */
export type Notice = {
  kind:
    | "role"
    | "throttled"
    | "gone"
    | "network"
    | "session"
    | "refused"
    | "failed";
  /** Whether asking for the check or reading its results went wrong. */
  step: "start" | "read";
  message: string;
  /** A 429's code (`RATE_LIMITED` or `CAPACITY_BUSY`). */
  code?: string;
  /** Seconds a throttled request waits before it may be tried again. */
  retryAfter?: number;
};

/** "40 s" or "2 min": how long to wait. */
export function waitText(seconds: number) {
  const whole = Math.max(1, Math.ceil(seconds));
  return whole < 60 ? `${whole} s` : `${Math.ceil(whole / 60)} min`;
}

/** What a 429 says, with the time that is left when it is known. */
export function throttleMessage(
  step: "start" | "read",
  code: string,
  seconds?: number,
) {
  const wait = seconds ? ` in ${waitText(seconds)}` : "";
  if (step === "read")
    return `Too many requests just now. The results load again${wait || " shortly"}.`;
  return code === "CAPACITY_BUSY"
    ? `Too many checks are waiting for devices to answer. Try again${wait || " in a few minutes"}.`
    : `Checks are limited to a few a minute. Try again${wait || " shortly"}.`;
}

export function explainCheckError(
  error: unknown,
  step: "start" | "read",
): Notice {
  if (isSessionInterruption(error))
    return { kind: "session", step, message: (error as Error).message };
  if (!(error instanceof APIError))
    return {
      kind: "failed",
      step,
      message:
        step === "start"
          ? "Couldn't start the check. Try again."
          : "Couldn't read the check's results.",
    };
  if (error.status === 403)
    return {
      kind: "role",
      step,
      message:
        step === "start"
          ? "Your role can't run a check. Ask an operator or administrator."
          : "Your role can't read these results.",
    };
  if (error.status === 429)
    return {
      kind: "throttled",
      step,
      code: error.code,
      retryAfter: error.retryAfter,
      message: throttleMessage(step, error.code, error.retryAfter),
    };
  if (step === "read" && error.status === 404)
    return {
      kind: "gone",
      step,
      message:
        "These results are no longer available. Check again for current ones.",
    };
  if (error.code === "NETWORK_UNAVAILABLE" || error.code === "REQUEST_TIMEOUT")
    return {
      kind: "network",
      step,
      message:
        step === "start"
          ? "Vectory didn't answer, so the check may not have started. Try again."
          : "Can't reach Vectory. Trying again…",
    };
  // A refusal the server explained, such as "The reviewed devices changed."
  if (error.serverRejection)
    return { kind: "refused", step, message: error.message };
  return {
    kind: "failed",
    step,
    message:
      step === "start"
        ? `Couldn't start the check. ${error.message}`
        : `Couldn't read the check's results. ${error.message}`,
  };
}

/** Milliseconds until the next read after `failures` in a row, or a 429's wait. */
export function nextPollDelay(failures: number, retryAfter?: number) {
  if (retryAfter) return Math.max(POLL_MS, retryAfter * 1000);
  if (!failures) return POLL_MS;
  return Math.min(POLL_MS * 2 ** Math.min(failures, 4), POLL_BACKOFF_MS);
}
