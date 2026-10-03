// An update window as `vectory setup --update-window` reads it: `DAYS
// HH:MM-HH:MM`, optionally followed by ` UTC`. DAYS is `daily`, a day (`Mon`),
// a range of days (`Mon-Fri`, which wraps the week) or a list of distinct days
// (`Sat,Sun`). The times are 24-hour, in the host's own time zone unless UTC
// follows; a window that ends before it starts crosses midnight. At most 7
// windows, each at most 40 characters. The page checks every window before it
// puts one in a command, so a command never fails on the host for a window the
// page accepted.

export const WINDOW_LIMIT = 7;
export const WINDOW_CHARACTERS = 40;
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const clock = "(?:[01][0-9]|2[0-3]):[0-5][0-9]";
const shape = new RegExp(
  `^(daily|[A-Z][a-z]{2}(?:-[A-Z][a-z]{2}|(?:,[A-Z][a-z]{2})+)?) (${clock})-(${clock})( UTC)?$`,
);

/**
 * What is wrong with one window, in words, or "" when it is fine. The agent
 * reads the same grammar, so a window that passes here passes setup.
 */
export function windowProblem(spec: string): string {
  if (!spec) return "A window can't be empty.";
  if (!/^[\x20-\x7e]+$/.test(spec))
    return "A window uses printable ASCII characters only.";
  if ([...spec].length > WINDOW_CHARACTERS)
    return `A window is at most ${WINDOW_CHARACTERS} characters. Use daily for every day.`;
  const found = shape.exec(spec);
  if (!found)
    return "Write a window like Mon-Fri 02:00-04:00, or Sat,Sun 01:00-03:00 UTC.";
  const [, selection, start, end] = found;
  if (start === end) return "A window's end differs from its start.";
  if (selection === "daily") return "";
  const named = selection.split(/[-,]/);
  const unknown = named.find((day) => !days.includes(day));
  if (unknown)
    return `${unknown} isn't a day. Use ${days.join(", ")}, or daily.`;
  if (selection.includes("-") && named[0] === named[1])
    return "A range needs two different days. Use one day, or daily.";
  if (new Set(named).size !== named.length) return "List each day once.";
  return "";
}

/**
 * The windows typed one per line: the ones to put in a command, and the
 * problem with the first bad line. Blank lines are ignored.
 */
export function readWindows(text: string): {
  windows: string[];
  problem: string;
} {
  const windows = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (windows.length > WINDOW_LIMIT)
    return {
      windows,
      problem: `At most ${WINDOW_LIMIT} windows. A host updates in any of them.`,
    };
  for (const [index, spec] of windows.entries()) {
    const problem = windowProblem(spec);
    if (problem)
      return {
        windows,
        problem:
          windows.length > 1 ? `Window ${index + 1}: ${problem}` : problem,
      };
  }
  const repeated = windows.find((spec, i) => windows.indexOf(spec) !== i);
  if (repeated) return { windows, problem: `${repeated} is listed twice.` };
  return { windows, problem: "" };
}

/** "Mon–Fri 02:00–04:00": a window as the page shows it, with en dashes. */
export function windowText(spec: string) {
  return spec.replaceAll("-", "–");
}

/** The windows of a host's policy in one phrase; "Any time" when it has none. */
export function windowsText(windows: readonly string[]) {
  return windows.length ? windows.map(windowText).join(", ") : "Any time";
}
