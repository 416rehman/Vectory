/** Time formatting shared by live indicators, tables and audit details. */
const parse = (value?: string | number | null) => {
  if (value === null || value === undefined || value === "") return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

/** "just now", "12s ago", "4m ago", "3h ago", "2d ago". */
export function relativeTime(
  value?: string | number | null,
  now = Date.now(),
): string {
  const time = parse(value);
  if (time === null) return "never";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A compact duration such as "45s", "12m", "3h 5m" or "2d 4h". */
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Exact UTC time with seconds for audit and technical views. */
export function exactUtc(value?: string | null): string {
  const time = parse(value);
  if (time === null) return "Unavailable";
  const d = new Date(time);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** Local date and time with seconds and the zone name, for tooltips and details. */
export function exactLocal(value?: string | null, timeZone?: string): string {
  const time = parse(value);
  if (time === null) return "Unavailable";
  return new Date(time).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    timeZone,
  });
}

/** Short local time with seconds for dense lists: "Sep 29, 02:01:52". */
export function shortLocal(value?: string | null, timeZone?: string): string {
  const time = parse(value);
  if (time === null) return "Unavailable";
  return new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  });
}
