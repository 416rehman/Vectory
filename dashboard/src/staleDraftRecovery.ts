import type { Config, VariableDeclaration } from "./api";
import { configurationDiff, differencePath } from "./configurationDiff";

export type DraftContent = {
  config: Config;
  variables: VariableDeclaration[];
  positions: Record<string, { x: number; y: number }>;
  metadata?: { name: string; description: string };
};

export function graphPositions(graph: {
  nodes: { id: string; position?: { x: number; y: number } }[];
}): DraftContent["positions"] {
  return Object.fromEntries(
    graph.nodes
      .filter(
        (node) =>
          typeof node.id === "string" &&
          Number.isFinite(node.position?.x) &&
          Number.isFinite(node.position?.y),
      )
      .map((node) => [node.id, node.position!] as const),
  );
}

export type LocalDraftCopy = {
  revision: number;
  base?: DraftContent;
  unappliedCode?: { format: string; text: string };
} & DraftContent;

export type DraftDifference = {
  path: string;
  server: unknown;
  local: unknown;
};

export type DraftMergeConflict = {
  path: string;
  base: unknown;
  server: unknown;
  local: unknown;
};
export type DraftMergeChoice = "server" | "local";
export type DraftMergeResult = {
  merged: DraftContent;
  conflicts: DraftMergeConflict[];
};

const missing = Symbol("missing draft value");
type MergeValue = unknown | typeof missing;
const record = (value: MergeValue): value is Record<string, unknown> =>
  value !== missing &&
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string): MergeValue =>
  Object.hasOwn(value, key) ? value[key] : missing;

function equal(left: MergeValue, right: MergeValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equal(left[key], right[key]),
    )
  );
}

/** Merge independently edited paths; arrays are atomic because Vector uses order. */
export function mergeDraftCopies(
  base: DraftContent,
  local: DraftContent,
  server: DraftContent,
  choices: Record<string, DraftMergeChoice> = {},
): DraftMergeResult {
  const conflicts: DraftMergeConflict[] = [];
  const copy = (value: MergeValue): MergeValue =>
    value === missing ? missing : structuredClone(value);
  const merge = (
    before: MergeValue,
    mine: MergeValue,
    theirs: MergeValue,
    path: (string | number)[],
    label: (path: (string | number)[]) => string,
  ): MergeValue => {
    if (equal(mine, theirs)) return copy(mine);
    if (equal(mine, before)) return copy(theirs);
    if (equal(theirs, before)) return copy(mine);
    if (record(before) && record(mine) && record(theirs)) {
      // A discriminator changes the meaning of sibling fields. Do not
      // combine a previous type's options with the replacement type.
      if (
        (Object.hasOwn(before, "type") ||
          Object.hasOwn(mine, "type") ||
          Object.hasOwn(theirs, "type")) &&
        (mine.type !== before.type || theirs.type !== before.type)
      ) {
        const key = label(path);
        conflicts.push({
          path: key,
          base: before,
          server: theirs,
          local: mine,
        });
        return copy(choices[key] === "local" ? mine : theirs);
      }
      const entries: [string, unknown][] = [];
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(mine),
        ...Object.keys(theirs),
      ])) {
        const value = merge(
          own(before, key),
          own(mine, key),
          own(theirs, key),
          [...path, key],
          label,
        );
        if (value !== missing) entries.push([key, value]);
      }
      return Object.fromEntries(entries);
    }
    const key = label(path);
    conflicts.push({
      path: key,
      base: before === missing ? undefined : before,
      server: theirs === missing ? undefined : theirs,
      local: mine === missing ? undefined : mine,
    });
    return copy(choices[key] === "local" ? mine : theirs);
  };
  let metadata: DraftContent["metadata"] | undefined;
  if (base.metadata && local.metadata && server.metadata) {
    metadata = merge(
      base.metadata,
      local.metadata,
      server.metadata,
      [],
      (path) => `Pipeline ${differencePath(path)}`,
    ) as DraftContent["metadata"];
  } else if (local.metadata && server.metadata) {
    // An older browser backup may not have a metadata merge base. If names
    // differ, make the operator choose rather than silently using the server.
    if (!equal(local.metadata, server.metadata)) {
      const path = "Pipeline details";
      conflicts.push({
        path,
        base: base.metadata,
        local: local.metadata,
        server: server.metadata,
      });
      metadata = copy(
        choices[path] === "local" ? local.metadata : server.metadata,
      ) as DraftContent["metadata"];
    } else metadata = copy(server.metadata) as DraftContent["metadata"];
  } else if (server.metadata || local.metadata)
    metadata = copy(
      server.metadata ?? local.metadata,
    ) as DraftContent["metadata"];
  return {
    merged: {
      config: merge(
        base.config,
        local.config,
        server.config,
        [],
        differencePath,
      ) as Config,
      variables: merge(
        base.variables,
        local.variables,
        server.variables,
        [],
        (path) =>
          path.length ? `Variables ${differencePath(path)}` : "Variables",
      ) as VariableDeclaration[],
      positions: merge(
        base.positions,
        local.positions,
        server.positions,
        [],
        (path) => (path.length ? `Layout ${differencePath(path)}` : "Layout"),
      ) as DraftContent["positions"],
      ...(metadata ? { metadata } : {}),
    },
    conflicts,
  };
}

/** Compare the two current copies without treating either as the merge base. */
export function staleDraftDifferences(
  local: Pick<LocalDraftCopy, "config" | "variables" | "metadata">,
  server: Pick<LocalDraftCopy, "config" | "variables" | "metadata">,
): DraftDifference[] {
  const changes = [
    ...configurationDiff(server.config, local.config).map((change) => ({
      path: differencePath(change.path),
      server: change.before,
      local: change.after,
    })),
    ...configurationDiff(server.variables, local.variables).map((change) => ({
      path: `Variables ${differencePath(change.path)}`,
      server: change.before,
      local: change.after,
    })),
    ...(server.metadata && local.metadata
      ? configurationDiff(server.metadata, local.metadata).map((change) => ({
          path: `Pipeline ${differencePath(change.path)}`,
          server: change.before,
          local: change.after,
        }))
      : []),
  ];
  return changes;
}

/** A local download, separate from Vector configuration import/export. */
export function serializeLocalDraftCopy(copy: LocalDraftCopy): string {
  return JSON.stringify(
    {
      format: "vectory-local-draft-backup-v1",
      base_revision: copy.revision,
      config: copy.config,
      variables: copy.variables,
      positions: copy.positions,
      ...(copy.metadata ? { metadata: copy.metadata } : {}),
      ...(copy.base ? { base: copy.base } : {}),
      ...(copy.unappliedCode ? { unapplied_code: copy.unappliedCode } : {}),
    },
    null,
    2,
  );
}
