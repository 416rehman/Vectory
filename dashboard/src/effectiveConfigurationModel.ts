/**
 * What the device page says about the configuration a device was offered:
 * the drift sentence, the generation picker's labels, the changes summary and
 * the variables table. Pure functions over what `GET /devices/{id}/configuration`
 * and `.../diff` return and the device the page already holds, so every
 * sentence is testable and says only what the server verified.
 */
import type {
  ConfigurationDiffHunk,
  ConfigurationVariable,
  Device,
  DeviceConfiguration,
  DeviceConfigurationDiff,
  OfferedGeneration,
  VersionLabel,
} from "./api";
import type { StatusTone } from "./status";
import { when } from "./api";

export type Drift = {
  /** The badge beside the card title. */
  badge: string;
  tone: StatusTone;
  /** The sentence the line leads with. */
  headline: string;
  /** Why, or what to look at next. Empty when the headline says it all. */
  detail: string;
  /** Whether the time of the agent's last check-in belongs after the line. */
  showReportedAt: boolean;
};

type DriftDevice = Pick<
  Device,
  | "status"
  | "apply_state"
  | "sync_paused"
  | "local_paused"
  | "desired_generation"
>;

/** Apply states in which the agent is still on its way to the offered version. */
const IN_PROGRESS = new Set([
  "desired",
  "downloaded",
  "validated",
  "written",
  "reload_requested",
]);

/** `v3`, or the plain word when a version carries no number. */
export function versionText(version: VersionLabel | null | undefined) {
  return typeof version?.number === "number" ? `v${version.number}` : "version";
}

/** `Edge syslog v3`, or just `v3` when the pipeline has no readable name. */
export function versionName(version: VersionLabel | null | undefined) {
  const name = version?.configuration_name;
  return name ? `${name} ${versionText(version)}` : versionText(version);
}

/**
 * Whether the managed file the agent reports is what Vectory offered, in
 * words that claim only what the server verified. Equal digests establish
 * file bytes, not that Vector activated the file. The local file itself is
 * never seen.
 */
export function driftLine(
  config: DeviceConfiguration,
  device: DriftDevice,
): Drift {
  const run = config.running;
  const generation = config.generation;
  const secrets = config.uses_local_secrets;
  const offline = device.status === "offline";
  const stale = offline
    ? " The device is offline, so this is its last report."
    : "";
  const shared = (
    detail: string,
    showReportedAt = true,
  ): Pick<Drift, "detail" | "showReportedAt"> => ({
    detail: `${detail}${stale}`.trim(),
    showReportedAt: showReportedAt && !!run.reported_at,
  });

  if (device.status === "revoked")
    return {
      badge: "Revoked",
      tone: "neutral",
      headline: "This device can no longer report what it runs.",
      ...shared(
        run.sha256
          ? "Its last report is the file digest below."
          : "It never reported a file digest.",
      ),
    };

  if (config.content === null) {
    const detail =
      run.matches_generation !== null
        ? `The file its agent reports is what Vectory offered at generation ${run.matches_generation}.`
        : run.sha256
          ? "Its agent reports a file Vectory never offered, such as the configuration adopted at setup."
          : "Its agent reports no managed file.";
    return {
      badge: "Nothing offered",
      tone: "neutral",
      headline: "Nothing is offered to this device now.",
      ...shared(detail, !!run.sha256),
    };
  }

  if (device.status === "awaiting_first_check_in")
    return {
      badge: "Not reported",
      tone: "neutral",
      headline: "This device hasn't checked in yet.",
      ...shared("Vectory can't say whether it runs this configuration.", false),
    };

  const reportedOffer =
    config.sha256 !== null &&
    (secrets
      ? run.template_sha256 === config.sha256
      : run.sha256 === config.sha256);
  if (
    reportedOffer &&
    (run.matches === null ||
      (run.matches === true && device.apply_state !== "verified_applied"))
  )
    return {
      badge: "Not verified",
      tone: "neutral",
      headline: config.current
        ? secrets
          ? "The agent reports this template, but activation isn't verified."
          : "The managed file matches this offer, but activation isn't verified."
        : `The managed file matches generation ${generation}, but activation isn't verified.`,
      ...shared(
        device.apply_state === "failed"
          ? "The latest apply failed. Check the device status and Vector log."
          : "A matching file digest alone doesn't show that Vector loaded this version.",
      ),
    };

  if (run.matches === true) {
    if (config.current)
      return {
        badge: "Matches",
        tone: "success",
        headline: "Running matches what Vectory offered.",
        ...shared(
          secrets
            ? "This version reads device secrets, so the file on the host holds the host's own values and differs from the text below. The agent applied this exact template, and the file hasn't changed since it was verified."
            : "",
        ),
      };
    return {
      badge: "File matches",
      tone: "neutral",
      headline: `The managed file matches generation ${generation}.`,
      ...shared(
        `Generation ${device.desired_generation} is the one offered now.`,
      ),
    };
  }

  if (run.matches === false) {
    const known = run.matches_generation;
    if (!config.current)
      return {
        badge: "File differs",
        tone: "neutral",
        headline: `The managed file differs from generation ${generation}.`,
        ...shared(
          known !== null
            ? `Its agent reports what Vectory offered at generation ${known}.`
            : "Its agent reports a file Vectory never offered it.",
        ),
      };
    if (known !== null)
      return {
        badge: "Differs",
        tone: "warning",
        headline: `The managed file differs from what Vectory offered at generation ${generation}: it matches generation ${known}.`,
        ...shared(
          IN_PROGRESS.has(device.apply_state)
            ? `The agent hasn't finished applying generation ${generation}.`
            : `Generation ${generation} may not be applied yet, or its apply failed. Running vs desired above says what the device verified.`,
        ),
      };
    const sync =
      device.sync_paused || device.local_paused
        ? " Sync is paused, so the agent leaves the file as it is."
        : " With sync on, the agent restores the offered configuration at its next check-in.";
    return {
      badge: "Differs",
      tone: "warning",
      headline: `The managed file differs from what Vectory offered at generation ${generation}.`,
      ...shared(
        (secrets
          ? "The file changed after the agent verified it. A local edit does this, and so does a rotated secret the agent hasn't applied yet."
          : "It isn't any configuration Vectory offered this device. A local edit does this, and so does the configuration adopted at setup before the first apply.") +
          " Vectory sees only the file's digest, never the file." +
          sync,
      ),
    };
  }

  // Nothing to compare.
  if (run.sha256 === null)
    return {
      badge: "Not reported",
      tone: "neutral",
      headline: "Not reported by this agent.",
      ...shared("Vectory can't say whether it runs this configuration.", false),
    };
  return {
    badge: "Can't compare",
    tone: "neutral",
    headline: secrets
      ? "Vectory can't compare this version with the file on the host."
      : "Vectory can't compare the running file with this configuration.",
    ...shared(
      secrets
        ? "This version reads device secrets, so the host's file differs from the text below. The agent hasn't reported a template that it applied and Vectory verified."
        : "",
    ),
  };
}

export type GenerationOption = { generation: number; label: string };

/**
 * The picker's options, newest first: `Current: v3 · generation 12`, then each
 * earlier offer with its version, generation and time, noting a generation
 * that offered the same bytes as the one before it (a retry).
 */
export function generationOptions(
  config: DeviceConfiguration,
  currentGeneration: number,
  assigned: boolean,
): GenerationOption[] {
  const items = config.generations.items;
  const pipelines = new Set(
    items.map((item) => item.version.configuration_id ?? item.version.id),
  );
  const options = items.map((item, index) => {
    const parts = [
      pipelines.size > 1
        ? versionName(item.version)
        : versionText(item.version),
      `generation ${item.generation}`,
    ];
    const older = items[index + 1];
    if (older && older.sha256 === item.sha256)
      parts.push(`same as ${older.generation}`);
    if (item.offered_at) parts.push(when(item.offered_at));
    const label = parts.join(" · ");
    return {
      generation: item.generation,
      label:
        assigned && item.generation === currentGeneration
          ? `Current: ${parts.slice(0, 2).join(" · ")}`
          : label,
    };
  });
  // A generation read by number that the 50 newest don't hold.
  if (
    config.version &&
    !items.some((item) => item.generation === config.generation)
  )
    options.push({
      generation: config.generation,
      label: `${versionText(config.version)} · generation ${config.generation}`,
    });
  return options;
}

/**
 * "Showing the newest 50 of 212" when the picker holds only some of the
 * generations the device was offered; null when it holds all of them.
 */
export function generationsNote(config: DeviceConfiguration): string | null {
  const { total, items } = config.generations;
  return total > items.length
    ? `Showing the newest ${items.length.toLocaleString()} of ${total.toLocaleString()}`
    : null;
}

/** `3 added · 1 removed · 2 changed`, or that nothing differs. */
export function countsSentence(counts: DeviceConfigurationDiff["counts"]) {
  const parts = [
    counts.added && `${counts.added.toLocaleString()} added`,
    counts.removed && `${counts.removed.toLocaleString()} removed`,
    counts.changed && `${counts.changed.toLocaleString()} changed`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No changes";
}

/** Where a hunk is: its components and its line range in the newer text. */
export function hunkTitle(hunk: ConfigurationDiffHunk) {
  const side =
    hunk.new_lines > 0
      ? [hunk.new_start, hunk.new_lines]
      : [hunk.old_start, hunk.old_lines];
  const [start, length] = side;
  const lines =
    length <= 1 ? `line ${start}` : `lines ${start}–${start + length - 1}`;
  return { where: hunk.section ?? "Top level", lines };
}

/** What the changes panel leads with. */
export function changesHeading(
  from: number | null,
  diff: DeviceConfigurationDiff,
) {
  if (from === null) return "First configuration offered";
  return diff.from
    ? `What changed since generation ${diff.from.generation}`
    : "What changed";
}

/** An RFC 6901 pointer as dotted keys: `/sinks/out/buffer` is `sinks.out.buffer`. */
export function fieldLabel(pointer: string) {
  return pointer
    .split("/")
    .slice(1)
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

const SOURCES: Record<NonNullable<ConfigurationVariable["source"]>, string> = {
  device: "Set for this device",
  default: "Deployment default",
  group: "Group default",
};

export type VariableRow = {
  name: string;
  field: string;
  /** The value as text; null when it is never shown. */
  value: string | null;
  type: ConfigurationVariable["type"];
  source: string;
};

export function variableRows(
  variables: ConfigurationVariable[],
): VariableRow[] {
  return variables.map((variable) => ({
    name: variable.name,
    field: fieldLabel(variable.path),
    value: variable.value === null ? null : String(variable.value),
    type: variable.type,
    source: variable.source ? SOURCES[variable.source] : "Not recorded",
  }));
}

/** A file name for what was offered: `edge-nyc-01-generation-12.json`. */
export function downloadName(
  deviceName: string,
  generation: number,
  format: "json" | "yaml" | null,
) {
  const slug =
    deviceName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|-+$/g, "") || "device";
  return `${slug}-generation-${generation}.${format === "yaml" ? "yaml" : "json"}`;
}

/** `4.2 KB`, `1.0 MB`: a size for the summary line. */
export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The first and last characters of a digest: `3f9a1c42…c21d`. */
export function shortDigest(sha256: string) {
  return sha256.length > 16
    ? `${sha256.slice(0, 8)}…${sha256.slice(-4)}`
    : sha256;
}

/**
 * What the device reports that can change what a read of its configuration
 * says: when this changes, the page reads again. Check-ins that change none of
 * it (nearly all of them) never cause a read.
 */
export function evidenceKey(
  device: Pick<
    Device,
    | "status"
    | "desired_generation"
    | "desired_version_id"
    | "desired_sha256"
    | "actual_sha256"
    | "applied_template_sha256"
    | "reported_generation"
  >,
) {
  return [
    device.status === "revoked",
    device.desired_generation,
    device.desired_version_id ?? "",
    device.desired_sha256 ?? "",
    device.actual_sha256 ?? "",
    device.applied_template_sha256 ?? "",
    device.reported_generation,
  ].join("|");
}

/** The path of one read; a generation is only sent when one was chosen. */
export function configurationPath(deviceId: string, generation: number | null) {
  const base = `/devices/${encodeURIComponent(deviceId)}/configuration`;
  return generation === null ? base : `${base}?generation=${generation}`;
}

/** The comparison of exactly the pair on screen, never a default that could move. */
export function diffPath(deviceId: string, from: number, to: number) {
  return `/devices/${encodeURIComponent(deviceId)}/configuration/diff?from=${from}&to=${to}`;
}

/** Whether the picker can show this generation, for a stale choice after a read fails. */
export function offeredGeneration(
  config: DeviceConfiguration,
  generation: number,
): OfferedGeneration | undefined {
  return config.generations.items.find(
    (item) => item.generation === generation,
  );
}
