import type { Config } from "./api";
import { sameConfiguration } from "./catalog";
import {
  ConfigurationSourceError,
  parseSource,
  sourceErrorMessage,
} from "./configurationSource";

/** What saving the draft does with the text open in Code view. */
export type CodeSavePlan =
  /** Nothing in Code is waiting to be applied: save the draft as it is. */
  | { kind: "save" }
  /** The code reads the same as the draft: only its layout was edited. */
  | { kind: "same" }
  /** The code reads differently: apply it to the draft, then save. */
  | { kind: "apply"; config: Config }
  /** The code does not parse: nothing is applied or saved. */
  | { kind: "refuse"; message: string; offset: number };

/**
 * Decide what Ctrl/Cmd+S does in Code view. Code that parses is applied and
 * then saved; code that does not parse is left as typed, with the line and
 * column of the first problem and the offset to move the cursor to.
 */
export function planCodeSave({
  code,
  format,
  unapplied,
  config,
}: {
  code: string;
  format: string;
  /** The text has edits that were never applied to the draft. */
  unapplied: boolean;
  /** The draft the code was shown from. */
  config: Config;
}): CodeSavePlan {
  if (!unapplied) return { kind: "save" };
  let parsed: Config;
  try {
    parsed = parseSource(code, format);
  } catch (failure) {
    const first =
      failure instanceof ConfigurationSourceError
        ? failure.diagnostics[0]
        : undefined;
    return {
      kind: "refuse",
      message: `Not saved. ${sourceErrorMessage(code, failure)}`,
      offset: Math.min(first?.from ?? 0, code.length),
    };
  }
  return sameConfiguration(config, parsed)
    ? { kind: "same" }
    : { kind: "apply", config: parsed };
}

/** The save status for edits that have not reached the draft yet, if any. */
export function unappliedStatus({
  code,
  fields,
}: {
  code: boolean;
  fields: boolean;
}): string | null {
  if (code) return "Unapplied code changes";
  return fields ? "Unapplied field changes" : null;
}
