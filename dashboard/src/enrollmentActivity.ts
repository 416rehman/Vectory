// Interprets live enrollment activity for one install command. Devices are
// only ever told "refused"; these recorded reasons are for administrators.
import type { Device, EnrollmentEvent } from "./api";
import type { HostOS } from "./enrollmentCommands";

const reasons: Record<string, { title: string; fix: string }> = {
  TOKEN_UNKNOWN: {
    title: "the token wasn't recognized",
    fix: "Check that the whole token was pasted, then run the command again.",
  },
  TOKEN_EXPIRED: {
    title: "the token expired",
    fix: "Create a new command and run it again.",
  },
  TOKEN_REVOKED: {
    title: "the token was revoked",
    fix: "Create a new command and run it again.",
  },
  TOKEN_EXHAUSTED: {
    title: "the token was already used",
    fix: "Create a new command for this device.",
  },
  NAME_TAKEN: {
    title: "that name belongs to an existing device",
    fix: "Run the command again with another --name, or authorize recovery from the existing device's page to replace it.",
  },
  NAME_PREFIX_MISMATCH: {
    title: "the token only allows other device names",
    fix: "Use a name the token allows, or create a new command without a name restriction.",
  },
  RECOVERY_NAME_MISMATCH: {
    title: "this recovery token is for another device name",
    fix: "Use the recovered device's exact name.",
  },
  RECOVERY_TARGET_MISSING: {
    title: "the device being recovered no longer exists",
    fix: "Create a new command to add it as a new device.",
  },
  REQUEST_MISMATCH: {
    title: "a different key reused an earlier request",
    fix: "Run setup again from the same state directory, or start over with a new command.",
  },
  DEVICE_REVOKED: {
    title: "the device this request enrolled was revoked",
    fix: "Create a new command to add the host again.",
  },
  MALFORMED: {
    title: "the request was incomplete or used an unsupported agent",
    fix: "Use the agent from this server's install command.",
  },
  INTERNAL: {
    title: "the server couldn't finish the enrollment",
    fix: "Run the command again. If it repeats, check the server log.",
  },
};

export function refusal(event: { reason_code?: string | null }) {
  return (
    reasons[event.reason_code || ""] || {
      title: "the server refused it",
      fix: "Check Activity for details.",
    }
  );
}

/**
 * The day's attempts plus what the live watch saw since, newest first and
 * each attempt once: the history list moves as a device enrolls on the page.
 */
export function mergeAttempts(
  history: EnrollmentEvent[],
  live: EnrollmentEvent[],
): EnrollmentEvent[] {
  const seen = new Set<string>();
  const merged: EnrollmentEvent[] = [];
  for (const event of [...live, ...history]) {
    const key = event.id || `${event.created_at}|${event.device_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.sort(
    (a, b) =>
      (Date.parse(b.created_at || "") || 0) -
      (Date.parse(a.created_at || "") || 0),
  );
}

/** "linux/amd64, agent 0.1.0" and similar, from whatever the device sent. */
export function describeAgent(event: {
  agent_os?: string | null;
  agent_arch?: string | null;
  agent_version?: string | null;
}) {
  const platform =
    event.agent_os && event.agent_arch
      ? `${event.agent_os}/${event.agent_arch}`
      : event.agent_os || "";
  return [platform, event.agent_version ? `agent ${event.agent_version}` : ""]
    .filter(Boolean)
    .join(", ");
}

/**
 * Attempts that belong to this command's token, plus refusals of unknown
 * tokens since it was created (a mistyped token can't name its token).
 * Oldest first.
 */
export function eventsFor(events: EnrollmentEvent[], tokenId: string) {
  return events
    .filter(
      (event) =>
        event.token_id === tokenId ||
        (event.outcome === "failure" &&
          event.reason_code === "TOKEN_UNKNOWN" &&
          !event.token_id),
    )
    .slice()
    .reverse();
}

export type Progress = {
  /** This command's attempts, oldest first. */
  events: EnrollmentEvent[];
  /** The latest refusal, while nothing has enrolled. */
  refused: EnrollmentEvent | null;
  enrolled: EnrollmentEvent | null;
  device: Device | null;
  revoked: boolean;
  checkedIn: boolean;
};

/**
 * Where this command's device is. The activity record names the device it
 * enrolled; without activity (an older server), a device that wasn't in the
 * inventory before the command was created and has the expected name counts.
 */
export function progress(
  events: EnrollmentEvent[],
  devices: Device[],
  tokenId: string,
  baseline: Set<string>,
  expectedName: string,
): Progress {
  const mine = eventsFor(events, tokenId);
  const enrolled =
    mine.filter((e) => e.outcome === "success" && e.device_id).at(-1) || null;
  let device = enrolled
    ? devices.find((d) => d.id === enrolled.device_id) || null
    : null;
  if (!enrolled) {
    const fresh = devices.filter((d) => !baseline.has(d.id));
    const wanted = expectedName.trim().toLowerCase();
    const candidates = wanted
      ? fresh.filter((d) => d.name.toLowerCase() === wanted)
      : fresh;
    device = candidates.length === 1 ? candidates[0] : null;
  }
  const revoked = device?.status === "revoked";
  return {
    events: mine,
    refused:
      enrolled || device
        ? null
        : mine.filter((e) => e.outcome === "failure").at(-1) || null,
    enrolled,
    device,
    revoked,
    checkedIn: !!device && !revoked && !!device.last_seen,
  };
}

/**
 * Setup's own check-ins land within seconds of each other; a check-in this
 * long after the first one seen means something runs the agent.
 */
export const LATER_CHECK_IN_MS = 20000;

/**
 * What keeps a freshly connected agent running. "supervised": a service
 * manager (or an agent too old to say); "unsupervised": no service, and no
 * check-in since setup's own; "running": no service, but the agent checked
 * in again later, so something runs it.
 */
export function supervision(
  device: Pick<Device, "service_manager" | "last_seen">,
  firstCheckIn: string | null,
): "supervised" | "unsupervised" | "running" {
  if (device.service_manager !== "none") return "supervised";
  const first = Date.parse(firstCheckIn || ""),
    last = Date.parse(device.last_seen || "");
  return Number.isFinite(first) &&
    Number.isFinite(last) &&
    last - first >= LATER_CHECK_IN_MS
    ? "running"
    : "unsupervised";
}

/**
 * The timeline line for an agent nothing keeps running: "r16-auto checked in
 * once, but nothing keeps its agent running. Start it with …, or use a host
 * with systemd." Without a service by choice (or on Windows, where setup
 * always registers one unless told not to), the operator's supervisor runs it.
 */
export function unsupervisedLine(
  name: string,
  run: string,
  os: HostOS,
  byChoice: boolean,
) {
  return {
    title: `${name} checked in once, but nothing keeps its agent running.`,
    before: "Start it with ",
    command: run,
    after:
      byChoice || os === "windows"
        ? " and keep it running under your own supervisor."
        : `, or use a host with ${os === "darwin" ? "launchd" : "systemd"}.`,
  };
}
