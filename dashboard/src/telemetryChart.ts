import type {
  TelemetryHistory,
  TelemetryRange,
  TelemetrySample,
} from "./runtimeModel";

/**
 * How often a range's history is read again. Only the newest chart step
 * changes, and a longer range has longer steps, so reading a week every 15
 * seconds would repeat the same answer 20 times per new point.
 */
export const telemetryPollMs: Record<TelemetryRange, number> = {
  "15m": 15_000,
  "1h": 15_000,
  "2h": 30_000,
  "6h": 60_000,
  "24h": 60_000,
  "7d": 300_000,
  "30d": 600_000,
};

export type TimelinePoint = {
  /** First minute (Unix minutes) of this slot. */
  bucket: number;
  at: string;
  /** Missing when the device reported nothing in this slot: a gap, not zero. */
  sample?: TelemetrySample;
};

export const present = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const sampleMinute = (sample: TelemetrySample) =>
  sample.bucket ?? Math.floor(Date.parse(sample.sampled_at) / 60000);

/**
 * Evenly spaced slots across the reported window. A range response carries
 * its window and step; the legacy shape (raw minutes) spans at most
 * `legacyMinutes` ending at the newest sample.
 */
export function timeline(
  history: Pick<TelemetryHistory, "samples" | "step_seconds" | "from" | "to">,
  legacyMinutes = 120,
): TimelinePoint[] {
  const samples = history.samples.filter((sample) =>
    Number.isFinite(sampleMinute(sample)),
  );
  const step = history.step_seconds
    ? Math.max(1, Math.round(history.step_seconds / 60))
    : 1;
  const from = Date.parse(history.from ?? ""),
    to = Date.parse(history.to ?? "");
  let start: number, end: number;
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    start = Math.floor(from / 60000);
    end = Math.floor(to / 60000);
  } else {
    if (!samples.length) return [];
    const minutes = samples.map(sampleMinute);
    end = Math.max(...minutes) + 1;
    start = Math.max(Math.min(...minutes), end - legacyMinutes);
  }
  const slot = (minute: number) => Math.floor(minute / step) * step;
  const bySlot = new Map(
    samples.map((sample) => [slot(sampleMinute(sample)), sample]),
  );
  const points: TimelinePoint[] = [];
  for (
    let bucket = slot(start);
    bucket < end && points.length < 400;
    bucket += step
  )
    points.push({
      bucket,
      at: new Date(bucket * 60000).toISOString(),
      sample: bySlot.get(bucket),
    });
  return points;
}

/** A clean axis maximum (1, 2 or 5 × 10^n) at or above the value. */
export function niceMax(value: number) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

/**
 * Empty slots a line may cross. A device checks in once per heartbeat, up
 * to 20% late plus processing time, so a run of empty slots shorter than
 * that is not a missed report. Longer runs stay visible as gaps.
 */
export function bridgeSlots(heartbeatSeconds: number, stepSeconds: number) {
  if (!(heartbeatSeconds > 0 && stepSeconds > 0)) return 0;
  return Math.max(
    0,
    Math.ceil((heartbeatSeconds * 1.2 + 15) / stepSeconds) - 1,
  );
}

/** Empty slots inside a run of at most `bridge` slots between two reports. */
export function bridgedSlots(reported: boolean[], bridge: number) {
  const bridged = reported.map(() => false);
  let last = -1;
  reported.forEach((here, index) => {
    if (!here) return;
    if (last >= 0 && index - last - 1 <= bridge)
      for (let slot = last + 1; slot < index; slot++) bridged[slot] = true;
    last = index;
  });
  return bridged;
}

/**
 * The slot a pointer or key on `index` reads: a bridged empty slot reads
 * its nearest report (the earlier one on a tie); keys moving in `step`
 * skip bridged slots entirely.
 */
export function readableSlot(
  index: number,
  reported: boolean[],
  bridged: boolean[],
  step?: -1 | 1,
) {
  if (!bridged[index]) return index;
  if (step) {
    let slot = index;
    while (bridged[slot]) slot += step;
    return slot;
  }
  let before = index,
    after = index;
  while (!reported[before]) before--;
  while (!reported[after]) after++;
  return index - before <= after - index ? before : after;
}

/**
 * SVG path commands for one series. Missing values break the line unless
 * the run of empty slots is at most `bridge` long.
 */
export function seriesPath(
  values: (number | null | undefined)[],
  x: (index: number) => number,
  y: (value: number) => number,
  bridge = 0,
) {
  const commands: string[] = [];
  let last = -1;
  values.forEach((value, index) => {
    if (!present(value)) return;
    const joined = last >= 0 && index - last - 1 <= bridge;
    commands.push(
      `${joined ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`,
    );
    last = index;
  });
  return commands.join(" ");
}

/** Reported values that no line reaches, drawn as their own marks. */
export function isolatedPoints(
  values: (number | null | undefined)[],
  bridge = 0,
) {
  const reported = values.flatMap((value, index) =>
    present(value) ? [index] : [],
  );
  return reported.filter((index, position) => {
    const before = reported[position - 1],
      after = reported[position + 1];
    return (
      (before === undefined || index - before - 1 > bridge) &&
      (after === undefined || after - index - 1 > bridge)
    );
  });
}

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** 1,284 / 12.9K / 4.2M; small rates keep two decimals. */
export function formatNumber(value: number) {
  return Math.abs(value) < 1000 ? exact.format(value) : compact.format(value);
}
export function formatPercent(ratio: number) {
  const percent = ratio * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent > 0 && percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}
export function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${exact.format(unit ? Math.round(value * 10) / 10 : value)} ${units[unit]}`;
}
export function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return seconds < 60
    ? `${Math.floor(seconds)}s`
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

/** Axis time label: clock time within a day, date and time beyond. */
export function axisTime(at: string, spanMinutes: number) {
  const date = new Date(at);
  return spanMinutes > 1440
    ? date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
}
