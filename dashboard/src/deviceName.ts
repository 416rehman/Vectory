/**
 * Recovering a device replaces its identity. The old record stays, for its
 * history, under its own name with "#retired-<its id>" appended, so the new
 * identity can take the name. The marker keeps names unique; it is not for
 * people. Screens show the name the device had and say it is retired.
 */
const RETIRED_MARKER =
  /#retired-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A device's own name, and whether it is a retired identity. */
export function deviceDisplay(name: string): {
  name: string;
  retired: boolean;
} {
  const marker = RETIRED_MARKER.exec(name);
  return marker && marker.index > 0
    ? { name: name.slice(0, marker.index), retired: true }
    : { name, retired: false };
}

/** The same in one line of text, where a badge has no room. */
export function deviceLabel(name: string): string {
  const shown = deviceDisplay(name);
  return shown.retired ? `${shown.name} (retired identity)` : shown.name;
}
