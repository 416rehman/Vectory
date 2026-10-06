import type { Config } from "./api";

/** How long a pause in editing one field ends its undo step. */
export const COALESCE_PAUSE_MS = 1000;

/**
 * The single option an edit changed, as `component:option`, or undefined when
 * the edit touched several options (or none).
 */
export function editedField(
  id: string,
  before: Config | null | undefined,
  after: Config | null | undefined,
): string | undefined {
  if (!before || !after) return undefined;
  let changed: string | undefined;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (
      before[key] === after[key] ||
      JSON.stringify(before[key]) === JSON.stringify(after[key])
    )
      continue;
    if (changed !== undefined) return undefined;
    changed = key;
  }
  return changed === undefined ? undefined : `${id}:${changed}`;
}

/**
 * Whether an edit joins the previous undo step: both changed the same single
 * option, with no pause of `pause` ms or more between them.
 */
export function coalesces(
  previous: { key: string; at: number } | null,
  key: string | undefined,
  now: number,
  pause = COALESCE_PAUSE_MS,
) {
  return !!key && previous?.key === key && now - previous.at < pause;
}
