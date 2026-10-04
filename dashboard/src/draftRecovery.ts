import type { Config, VariableDeclaration } from "./api";
import { findPlainCredential } from "./credentialFields";
import type { DraftContent } from "./staleDraftRecovery";

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
  metadata?: { name: string; description: string };
  /** The acknowledged revision these edits started from, for three-way merge. */
  base?: DraftContent;
};

const legacyKey = (userId: string, pipelineId: string) =>
  `vectory.draft.v1:${userId}:${pipelineId}`;
const copyPrefix = (userId: string, pipelineId: string) =>
  `vectory.draft.v2:${userId}:${pipelineId}:`;
// Created for this document, not sessionStorage: a duplicated browser tab may
// inherit sessionStorage and must still own a separate recovery copy.
export const createRecoveryCopyId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const pageCopyId = createRecoveryCopyId();
const currentKey = (userId: string, pipelineId: string, copyId = pageCopyId) =>
  `${copyPrefix(userId, pipelineId)}${copyId}`;
export const recoveryDraftId = currentKey;
const leasePrefix = (userId: string, pipelineId: string) =>
  `vectory.draft.lease:${userId}:${pipelineId}:`;
const leaseKey = (userId: string, pipelineId: string, copyId: string) =>
  `${leasePrefix(userId, pipelineId)}${copyId}`;
// Background tabs can have timers suspended. A stale lease is not proof that
// its owner closed; foreign-copy deletion still needs explicit confirmation.
const LEASE_AGE_MS = 5 * 60_000;
export function renewRecoveryLease(
  userId: string,
  pipelineId: string,
  copyId: string,
) {
  try {
    localStorage.setItem(leaseKey(userId, pipelineId, copyId), `${Date.now()}`);
  } catch {
    // The copy can still be saved or downloaded without a lease.
  }
}
export function clearRecoveryLease(
  userId: string,
  pipelineId: string,
  copyId: string,
) {
  try {
    localStorage.removeItem(leaseKey(userId, pipelineId, copyId));
  } catch {
    // A stale lease expires automatically.
  }
}
export function recoveryCopyActive(
  userId: string,
  pipelineId: string,
  id: string,
) {
  const prefix = copyPrefix(userId, pipelineId);
  if (!id.startsWith(prefix)) return false;
  try {
    const value = localStorage.getItem(
      leaseKey(userId, pipelineId, id.slice(prefix.length)),
    );
    return value !== null && Date.now() - Number(value) < LEASE_AGE_MS;
  } catch {
    return false;
  }
}
export type RecoveryDraftEntry = { id: string; draft: RecoveryDraft };
export const ownsRecoveryDraft = (
  userId: string,
  pipelineId: string,
  id: string,
  copyId = pageCopyId,
) => id === currentKey(userId, pipelineId, copyId);
export const isLegacyRecoveryDraft = (
  userId: string,
  pipelineId: string,
  id: string,
) => id === legacyKey(userId, pipelineId);
const MAX_CHARACTERS = 1_500_000;
const record = (value: unknown): value is Config =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Whether plain text sits under a credential-like option. Such a draft is
 * never written to browser storage; secret references are fine.
 */
export function holdsPlainCredential(value: unknown): boolean {
  return findPlainCredential(value) !== null;
}

/** Store the edits; false when they were not stored (see the rules above). */
export function storeRecoveryDraft(
  userId: string,
  pipelineId: string,
  draft: Omit<RecoveryDraft, "saved_at">,
  now = new Date(),
  copyId = pageCopyId,
): boolean {
  const storageKey = currentKey(userId, pipelineId, copyId);
  try {
    if (holdsPlainCredential(draft.config)) {
      localStorage.removeItem(storageKey);
      return false;
    }
    const { base, ...currentOnly } = draft;
    const savedAt = now.toISOString();
    let text = JSON.stringify({
      ...currentOnly,
      ...(base && !holdsPlainCredential(base.config) ? { base } : {}),
      saved_at: savedAt,
    });
    // Preserve the current edits when an added merge base would exceed the
    // browser cap. That copy remains compare/download only after a conflict.
    if (text.length > MAX_CHARACTERS && base)
      text = JSON.stringify({ ...currentOnly, saved_at: savedAt });
    if (text.length > MAX_CHARACTERS) {
      localStorage.removeItem(storageKey);
      return false;
    }
    localStorage.setItem(storageKey, text);
    return true;
  } catch {
    // Never offer a previous recovery copy as though it held current edits.
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Storage may be unavailable altogether.
    }
    return false;
  }
}

function readStoredCopy(storageKey: string): RecoveryDraft | null {
  try {
    const raw = localStorage.getItem(storageKey);
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
      (value.metadata !== undefined &&
        (!record(value.metadata) ||
          typeof value.metadata.name !== "string" ||
          typeof value.metadata.description !== "string")) ||
      (value.base !== undefined &&
        (!record(value.base) ||
          !record(value.base.config) ||
          !record(value.base.positions) ||
          !Array.isArray(value.base.variables) ||
          (value.base.metadata !== undefined &&
            (!record(value.base.metadata) ||
              typeof value.base.metadata.name !== "string" ||
              typeof value.base.metadata.description !== "string"))))
    )
      return null;
    if (
      holdsPlainCredential(value.config) ||
      (value.base && holdsPlainCredential(value.base.config))
    ) {
      // Older clients may have stored a value the current detector recognizes.
      localStorage.removeItem(storageKey);
      return null;
    }
    for (const position of [
      ...Object.values(value.positions),
      ...Object.values(value.base?.positions || {}),
    ])
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

/** List independent browser copies, newest first; old single-slot copies remain readable. */
export function listRecoveryDrafts(
  userId: string,
  pipelineId: string,
): RecoveryDraftEntry[] {
  try {
    const prefix = copyPrefix(userId, pipelineId);
    const ids = [legacyKey(userId, pipelineId)];
    for (let index = 0; index < localStorage.length; index++) {
      const candidate = localStorage.key(index);
      if (candidate?.startsWith(prefix)) ids.push(candidate);
    }
    return ids
      .map((id) => ({ id, draft: readStoredCopy(id) }))
      .filter((entry): entry is RecoveryDraftEntry => entry.draft !== null)
      .sort(
        (a, b) =>
          b.draft.saved_at.localeCompare(a.draft.saved_at) ||
          b.id.localeCompare(a.id),
      );
  } catch {
    return [];
  }
}

export function readRecoveryDraft(
  userId: string,
  pipelineId: string,
): RecoveryDraft | null {
  return listRecoveryDrafts(userId, pipelineId)[0]?.draft ?? null;
}

/** Remove only this page's copy, or a selected copy owned by this account/pipeline. */
export function clearRecoveryDraft(
  userId: string,
  pipelineId: string,
  selectedId?: string,
) {
  const prefix = copyPrefix(userId, pipelineId);
  if (
    selectedId &&
    selectedId !== legacyKey(userId, pipelineId) &&
    !selectedId.startsWith(prefix)
  )
    return;
  try {
    localStorage.removeItem(selectedId ?? currentKey(userId, pipelineId));
  } catch {
    // Unavailable storage holds nothing to clear.
  }
}
