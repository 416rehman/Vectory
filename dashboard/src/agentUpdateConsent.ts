// What a person chooses about agent updates for one host, and what a command
// then carries. Nothing is chosen until the person chooses it: a form that
// hasn't been touched makes no consent, and a command without consent is the
// command it always was.
import type { UpdateConsent, UpdateTrack } from "./enrollmentCommands";
import type { UpdateLevel } from "./agentUpdateCommands";
import { readWindows } from "./updateWindow";

export type ConsentForm = {
  /** Empty until the person chooses one. */
  level: UpdateLevel | "";
  track: UpdateTrack;
  /** One window per line, as typed. */
  windowsText: string;
};

export const emptyConsent: ConsentForm = {
  level: "",
  track: "patch",
  windowsText: "",
};

export type ConsentRead = {
  /** What the command carries; undefined when nothing was chosen or something blocks it. */
  consent: UpdateConsent | undefined;
  /** What blocks it, in words, or "". */
  problem: string;
  /** Where the problem belongs. */
  field?: "key" | "windows";
  /** Whether a level was chosen at all. */
  chosen: boolean;
};

/**
 * The consent the form describes. `key` is the fingerprint of the key this
 * server signs with now: a host that takes updates pins it, so without a key
 * (none set, or not read yet) a host can't be asked to take updates.
 */
export function readConsent(
  form: ConsentForm,
  key: string | null,
  options: { levels?: readonly UpdateLevel[] } = {},
): ConsentRead {
  const allowed = options.levels ?? ["auto", "ask", "off"];
  if (!form.level || !allowed.includes(form.level))
    return { consent: undefined, problem: "", chosen: false };
  if (form.level === "off")
    return { consent: { level: "off" }, problem: "", chosen: true };
  if (!key)
    return {
      consent: undefined,
      problem:
        "This server has no release key yet, so a host can't pin one. An administrator sets it in Settings, Agent updates.",
      field: "key",
      chosen: true,
    };
  const windows = readWindows(form.windowsText);
  if (windows.problem)
    return {
      consent: undefined,
      problem: windows.problem,
      field: "windows",
      chosen: true,
    };
  return {
    consent: {
      level: form.level,
      track: form.track,
      windows: windows.windows,
      key,
    },
    problem: "",
    chosen: true,
  };
}
