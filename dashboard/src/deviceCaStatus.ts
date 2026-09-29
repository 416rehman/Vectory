/**
 * The device certificate authorities as GET /settings reports them
 * (`device_ca`): the current one, and during a rotation's overlap the
 * previous one with the devices that still hold its certificates.
 */
export type DeviceCa = {
  sha256: string;
  subject: string;
  not_before: string;
  not_after: string;
};
export type PreviousDeviceCa = DeviceCa & {
  devices: number;
  device_names: string[];
  last_expires_at: string | null;
};
export type DeviceCaStatus = {
  current: DeviceCa;
  previous: PreviousDeviceCa | null;
};

const hex = /^[0-9a-f]{64}$/;

/** The status, or null when the server doesn't report one (or reports junk). */
export function readDeviceCa(value: unknown): DeviceCaStatus | null {
  const status = value as Partial<DeviceCaStatus> | null | undefined;
  const ca = (item: unknown): item is DeviceCa =>
    !!item &&
    typeof item === "object" &&
    hex.test(String((item as DeviceCa).sha256)) &&
    typeof (item as DeviceCa).not_after === "string";
  if (!status || !ca(status.current)) return null;
  const previous = status.previous;
  if (
    previous &&
    (!ca(previous) ||
      !Number.isSafeInteger(previous.devices) ||
      !Array.isArray(previous.device_names))
  )
    return null;
  return { current: status.current, previous: previous || null };
}

/** "3f9a1c2b…e4d1a0c7": enough to compare at a glance; the title holds all. */
export function shortFingerprint(sha256: string) {
  return `${sha256.slice(0, 8)}…${sha256.slice(-8)}`;
}

/** "Sep 27, 2036", or the raw value when it isn't a date. */
export function day(value: string | null | undefined) {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.valueOf())
    ? at.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : value || "";
}

/** Who still uses the previous authority, and what to do next. */
export function previousSummary(previous: PreviousDeviceCa) {
  if (previous.devices === 0)
    return "No device uses it anymore. Retire it with vectory-admin retire-device-ca --apply on the stopped server.";
  const names = previous.device_names.slice(0, 3);
  const more = previous.devices - names.length;
  const listed =
    more > 0
      ? `${names.join(", ")} and ${more} more`
      : names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
        : names[0];
  const count =
    previous.devices === 1
      ? "1 device still uses"
      : `${previous.devices} devices still use`;
  const until = previous.last_expires_at
    ? ` Each moves when it renews; the last of their certificates expires ${day(previous.last_expires_at)}.`
    : "";
  return `${count} it: ${listed}.${until}`;
}
