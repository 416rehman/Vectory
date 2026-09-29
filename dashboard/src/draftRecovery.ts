import type { Config, VariableDeclaration } from "./api";
import { isSecretReference } from "./pipelineSchema";

/**
 * Unsaved editor changes kept in this browser so a crash, a closed tab or a
 * lost session does not lose them. Only positions are kept for the graph.
 */
export type RecoveryDraft = {
  /** The saved draft revision these edits started from. */
  revision: number;
  saved_at: string;
  config: Config;
  positions: Record<string, { x: number; y: number }>;
  variables: VariableDeclaration[];
};

const key = (userId: string, pipelineId: string) =>
  `vectory.draft.v1:${userId}:${pipelineId}`;
const MAX_CHARACTERS = 1_500_000;
const CREDENTIAL_KEY =
  /pass(?:word|phrase)?$|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential/i;
const record = (value: unknown): value is Config =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Whether plain text sits under a credential-like option. Such a draft is
 * never written to browser storage; secret references are fine.
 */
export function holdsPlainCredential(value: unknown, depth = 0): boolean {
  if (depth > 40 || !value || typeof value !== "object") return false;
  for (const [name, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" &&
      CREDENTIAL_KEY.test(name) &&
      entry.trim() &&
      !isSecretReference(entry)
    )
      return true;
    if (holdsPlainCredential(entry, depth + 1)) return true;
  }
  return false;
}

/** Store the edits; false when they were not stored (see the rules above). */
export function storeRecoveryDraft(
  userId: string,
  pipelineId: string,
  draft: Omit<RecoveryDraft, "saved_at">,
  now = new Date(),
): boolean {
  try {
    if (holdsPlainCredential(draft.config)) {
      localStorage.removeItem(key(userId, pipelineId));
      return false;
    }
    const text = JSON.stringify({ ...draft, saved_at: now.toISOString() });
    if (text.length > MAX_CHARACTERS) return false;
    localStorage.setItem(key(userId, pipelineId), text);
    return true;
  } catch {
    return false;
  }
}

export function readRecoveryDraft(
  userId: string,
  pipelineId: string,
): RecoveryDraft | null {
  try {
    const raw = localStorage.getItem(key(userId, pipelineId));
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      !record(value) ||
      !Number.isSafeInteger(value.revision) ||
      typeof value.saved_at !== "string" ||
      Number.isNaN(Date.parse(value.saved_at)) ||
      !record(value.config) ||
      !record(value.positions) ||
      !Array.isArray(value.variables) ||
      holdsPlainCredential(value.config)
    )
      return null;
    for (const position of Object.values(value.positions))
      if (
        !record(position) ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y)
      )
        return null;
    return value as RecoveryDraft;
  } catch {
    return null;
  }
}

export function clearRecoveryDraft(userId: string, pipelineId: string) {
  try {
    localStorage.removeItem(key(userId, pipelineId));
  } catch {
    // Unavailable storage holds nothing to clear.
  }
}
