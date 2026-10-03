// What a refused or unanswered request about agent updates says, and what the
// person may do next. A refusal from the server is final: nothing changed. A
// request that got no answer (a timeout, a lost connection) may have been
// applied, so the page says so, reads the state and never sends it again by
// itself.
import { APIError } from "./api";

/** Replies that say the reply wasn't the server's own: they settle nothing. */
const UNSETTLED = new Set([
  "INVALID_RESPONSE",
  "UNSAFE_NUMBER",
  "CONTRACT_MISMATCH",
  "IDEMPOTENCY_CONFLICT",
]);

/**
 * Whether the server refused the request outright, so nothing was changed: its
 * own error answer for a request it understood (a missing release store
 * space, 507, included). Anything else, including a 5xx without an answer, a
 * deadline or a dropped connection, is unknown.
 */
export function isDefiniteRefusal(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.serverRejection &&
    ((error.status >= 400 && error.status < 500 && error.status !== 408) ||
      error.status === 507) &&
    !UNSETTLED.has(error.code)
  );
}

export type Failure = {
  /** What to tell the person. */
  message: string;
  code: string;
  /** Nothing changed: the form stays, ready for another try. */
  definite: boolean;
  /** The field the message belongs under, when it is about one. */
  field?: "password" | "key" | "file" | "reason";
};

const sentences: Record<string, { message: string; field?: Failure["field"] }> =
  {
    WRONG_PASSWORD: {
      message: "Your password didn't match.",
      field: "password",
    },
    RELEASE_KEY_IN_USE: {
      message:
        "This server already uses that key for something else: its manifest signing key, its device certificate authority, or a release key it holds. Create a new key for releases.",
      field: "key",
    },
    STALE_REVISION: {
      message:
        "Agent updates changed after this page loaded. It has been read again. Check what it says now, then try again.",
    },
    CUSTODY_LOCKED: {
      message:
        "Who holds the release key is fixed while updates are on. Turn them off first to change it.",
    },
    CUSTODY_REQUIRED: {
      message: "Choose who holds the release key first.",
    },
    AGENT_UPDATE_ROLLOUTS_ACTIVE: {
      message:
        "An update rollout is still running. Cancel it, or stop all updates, then try again.",
    },
    AGENT_UPDATES_STOPPED: {
      message:
        "All agent updates are stopped. An administrator clears the stop in Settings before a rollout can start.",
    },
    AGENT_UPDATES_OFF: { message: "Agent updates are off." },
    RELEASE_NOT_IN_CATALOG: {
      message: "This server's agent catalog doesn't hold that version.",
    },
    RELEASE_EXISTS: {
      message: "A release of that version already exists.",
    },
    RELEASE_NOT_READY: {
      message:
        "That release can't start a rollout: it is unsigned, expired or withdrawn.",
    },
    NOTHING_TO_UPDATE: {
      message:
        "Nobody in this review will update. Fix what the review lists, then review again.",
    },
    UPDATE_ROLLOUT_OVERLAP: {
      message:
        "A device in this review is already in an update rollout that hasn't ended. Review again.",
    },
    UPDATE_REVIEW_CHANGED: {
      message:
        "Something changed since this review (a device, a release or its key). Review again before you start.",
    },
    RELEASE_STORAGE_FULL: {
      message:
        "The release store is full. Withdraw a release you no longer need, or free space on the server.",
    },
    PAYLOAD_TOO_LARGE: {
      message:
        "That file is too large to be a signature file. A release.json.sig is under 4 KiB.",
      field: "file",
    },
  };

/** The server's answer, or the lack of one, in words, and whether it settled anything. */
export function describeFailure(error: unknown): Failure {
  if (error instanceof APIError) {
    const known = Object.hasOwn(sentences, error.code)
      ? sentences[error.code]
      : undefined;
    const wait = error.status === 429 ? error.retryAfter || 60 : 0;
    const field: Failure["field"] =
      known?.field ??
      (error.code === "RELEASE_KEY_INVALID"
        ? "key"
        : error.code === "RELEASE_SIGNATURE_INVALID"
          ? "file"
          : undefined);
    return {
      code: error.code,
      definite: isDefiniteRefusal(error),
      message: wait
        ? `Too many attempts. Try again in ${Math.max(1, Math.ceil(wait / 60))} min.`
        : known?.message || error.message,
      field,
    };
  }
  return {
    code: "",
    definite: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** What a request that may have been applied says to the person who sent it. */
export const unconfirmedText = (what: string) =>
  `We couldn't confirm ${what}. It may have been applied. Check the current state before you try again.`;
