/**
 * What a device's apply events say about its metrics: the markers drawn on its
 * charts and the baseline its "since" counters count from. Pure functions over
 * the audit rows the device page already reads, so a marker never claims more
 * than the server recorded: a release and the state the agent reported after it.
 */
import { statusOf, type StatusTone } from "./status";

/** The parts of an audit row these functions read. */
export type ChangeEvent = {
  id: string;
  action: string;
  outcome: string;
  created_at: string | null;
  /** For a release: the pipeline and version it released, "Orders v1". */
  target_name?: string | null;
};

export type ApplyState =
  "verified_applied" | "failed" | "rolled_back" | "verification_unknown";
const APPLY_STATES: readonly string[] = [
  "verified_applied",
  "failed",
  "rolled_back",
  "verification_unknown",
];

export type ApplyMarker = {
  /** The audit row of the state the agent reported. */
  id: string;
  at: string;
  state: ApplyState;
  tone: StatusTone;
  /** The status vocabulary's word: "Applied", "Rolled back". */
  stateLabel: string;
  /** The release it followed, "Orders v1"; null when no release is known. */
  version: string | null;
  /** "v1" from that release, for a short note. */
  versionNumber: string | null;
};

const settingsRelease = /^Agent settings/i;
const versionNumberOf = (name: string | null) =>
  /\bv(\d+)$/.exec(name ?? "")?.[0] ?? null;

/**
 * The outcomes a device reported after each release, oldest first. Events come
 * newest first, as the audit lists them. An outcome counts when a release of a
 * pipeline version (or a retry of one) came before it: a device that resumes
 * after a pause reports Applied again without changing what it runs.
 */
export function applyMarkers(events: ChangeEvent[]): ApplyMarker[] {
  const dated = [...events]
    .reverse()
    .map((event) => ({ event, time: Date.parse(event.created_at ?? "") }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);
  const markers: ApplyMarker[] = [];
  let pending: string | null = null;
  let released: string | null = null;
  for (const { event } of dated) {
    if (event.action === "deployment.release") {
      const name = event.target_name?.trim() || null;
      if (!name || settingsRelease.test(name)) continue;
      pending = released = name;
    } else if (event.action === "device.retry") {
      pending = released;
    } else if (
      event.action === "device.apply_state" &&
      APPLY_STATES.includes(event.outcome)
    ) {
      if (event.outcome === "verified_applied" && pending === null) continue;
      const entry = statusOf("apply", event.outcome);
      markers.push({
        id: event.id,
        at: event.created_at!,
        state: event.outcome as ApplyState,
        tone: entry.tone,
        stateLabel: entry.label,
        version: pending,
        versionNumber: versionNumberOf(pending),
      });
      pending = null;
    }
  }
  return markers;
}

/**
 * The audit read holds a device's newest events. When the device has more, the
 * time of the oldest one read: nothing before it can be marked, and the charts
 * say so rather than let a missing marker read as "no change". Null when the
 * read holds every event.
 */
export function markedSince(page: {
  total: number;
  items: { created_at: string | null }[];
}): string | null {
  if (page.total <= page.items.length) return null;
  return page.items.at(-1)?.created_at ?? null;
}

/** The newest marker that changed what the device runs (an apply or a rollback). */
export function lastVersionChange(markers: ApplyMarker[]) {
  return (
    [...markers]
      .reverse()
      .find(
        (marker) =>
          marker.state === "verified_applied" || marker.state === "rolled_back",
      ) ?? null
  );
}

export type MarkerCluster = {
  /** Where the cluster is drawn, 0 (left edge) to 1 (right edge). */
  x: number;
  markers: ApplyMarker[];
  tone: StatusTone;
};
const severity: Record<StatusTone, number> = {
  danger: 4,
  warning: 3,
  info: 2,
  neutral: 1,
  success: 0,
};

/**
 * Markers laid on a plot whose slots run from `startMs` to `endMs` (the first
 * and last slot starts). Markers closer than `minGap` of the plot width merge
 * into one cluster that takes the most severe tone, so two changes a minute
 * apart never draw over each other; each marker stays in its cluster's list.
 * An outcome inside the slot still collecting sits at the right edge.
 */
export function clusterMarkers(
  markers: ApplyMarker[],
  startMs: number,
  endMs: number,
  slotMs: number,
  minGap = 0.035,
): MarkerCluster[] {
  const span = endMs - startMs;
  if (!(span > 0)) return [];
  const placed = markers
    .map((marker) => ({ marker, time: Date.parse(marker.at) }))
    .filter(({ time }) => time >= startMs && time < endMs + slotMs)
    .map(({ marker, time }) => ({
      marker,
      x: Math.min(1, (time - startMs) / span),
    }))
    .sort((a, b) => a.x - b.x);
  const clusters: MarkerCluster[] = [];
  let anchor = -1;
  for (const { marker, x } of placed) {
    const current = clusters.at(-1);
    if (current && x - anchor < minGap) {
      current.markers.push(marker);
      if (severity[marker.tone] > severity[current.tone])
        current.tone = marker.tone;
    } else {
      clusters.push({ x, markers: [marker], tone: marker.tone });
      anchor = x;
    }
  }
  return clusters;
}

/** The time of an apply event as the chart and its tooltips show it. */
export function markerTime(at: string) {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One reading of a cumulative counter, from a history sample. */
export type CounterReading = { at: string; value: number | null | undefined };

export type CounterSince = {
  /** What to show: the count since the version was applied, else the total. */
  value: number;
  /** Vector's own total: never hidden, it is in the tooltip. */
  total: number;
  basis:
    | "change" // counted from the first sample after the version was applied
    | "start" // nothing changed since Vector started: its total is this version's
    | "unknown"; // a version was applied after it started, and no sample says where it stood
};

/**
 * Vector keeps its counters across a reload, so after a switch the total
 * still holds the previous pipeline's events. The count since the version was
 * applied is the total less the counter at the first sample after the apply:
 * it can leave out what Vector counted in between (about one check-in), and
 * never includes the previous pipeline's events. A total below that baseline
 * means Vector restarted, so the total is all newer. When the version was
 * applied before Vector's current process started, its total belongs to this
 * version already.
 */
export function counterSince(options: {
  total: number | null | undefined;
  /** When the latest sample was taken, and Vector's uptime in it. */
  latestAt: string;
  uptimeSeconds?: number | null;
  /** When the device last applied or rolled back to a version. */
  changedAt: string | null;
  /** The history's readings of this counter, oldest first. */
  readings: CounterReading[];
}): CounterSince | null {
  const { total } = options;
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  const changed = Date.parse(options.changedAt ?? "");
  const latest = Date.parse(options.latestAt);
  const started =
    typeof options.uptimeSeconds === "number" && Number.isFinite(latest)
      ? latest - options.uptimeSeconds * 1000
      : null;
  if (!Number.isFinite(changed)) return { value: total, total, basis: "start" };
  if (started !== null && changed <= started)
    return { value: total, total, basis: "start" };
  const baseline = options.readings.find(
    (reading) =>
      Date.parse(reading.at) >= changed &&
      typeof reading.value === "number" &&
      Number.isFinite(reading.value),
  );
  if (!baseline) return { value: total, total, basis: "unknown" };
  const before = baseline.value as number;
  return {
    value: total >= before ? total - before : total,
    total,
    basis: "change",
  };
}

/**
 * The words under a tile for one cumulative counter, and the tooltip that
 * keeps Vector's own total reachable. Null when the sample has no such counter.
 */
export function counterNote(
  since: CounterSince | null,
  change: Pick<
    ApplyMarker,
    "state" | "versionNumber" | "version" | "at"
  > | null,
  format: (value: number) => string,
) {
  if (!since) return null;
  const total = format(since.total);
  if (since.basis === "start")
    return { text: `${total} since Vector started`, title: undefined };
  if (since.basis === "unknown")
    return {
      text: `${total} since Vector started, including earlier versions`,
      title: `Vector reports ${total} since it started. A version was applied after that, and no earlier sample says how many of these came before it.`,
    };
  const rolledBack = change?.state === "rolled_back";
  const label = rolledBack
    ? "the rollback"
    : change?.versionNumber
      ? `${change.versionNumber} applied`
      : "the last change";
  const named = change?.version ?? "The version";
  const when = change ? markerTime(change.at) : "an unknown time";
  return {
    text: `${format(since.value)} since ${label}`,
    title: `Vector reports ${total} since it started and keeps its counters when a pipeline changes. ${named} was ${rolledBack ? "rolled back" : "applied"} at ${when}; ${format(since.value)} of the total was counted after that.`,
  };
}
