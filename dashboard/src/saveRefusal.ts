import type { Config } from "./api";
import { secretFindings } from "./secretFields";

/** What a refused draft save tells the person, and where its cause is. */
export type SaveRefusal = {
  message: string;
  /** The step the refusal is about, when the draft can name it. */
  component?: string;
  /** The setting of that step. */
  field?: string;
};

const ended = (text: string) => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * The server refused to store this draft: nothing was saved and nothing was
 * lost, so the edits stay and the fix is in them. Where the draft itself shows
 * the cause, which the server's one sentence doesn't name, say which step and
 * setting it is, so the editor can go there. A draft that changed elsewhere
 * (409) is a different case and is never described here.
 */
export function refusedSave(
  failure: { message: string },
  config: Config,
): SaveRefusal {
  const found = /Plaintext credentials/i.test(failure.message)
    ? secretFindings(config).find(
        (finding) =>
          finding.code === "plaintext_credential" &&
          finding.id &&
          finding.field,
      )
    : undefined;
  return found
    ? {
        message: `Not saved. Replace the plaintext credential in ${found.field} on ${found.id} with a device secret, such as vectory-secret:NAME. A draft never stores one. Your edits are still here.`,
        component: found.id,
        field: found.field,
      }
    : {
        message: `Not saved. ${ended(failure.message)} Your edits are still here.`,
      };
}
