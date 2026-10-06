/**
 * Verbs the command palette offers on the things it finds: pause or cancel or
 * roll back a rollout, deploy or duplicate a pipeline, show a device's issues.
 * Each opens what the page itself opens (a reviewed dialog, or a page); none
 * changes anything on its own. They appear only when the words typed ask for
 * the verb, and only to a person whose role allows it.
 */
import type { PaletteEntry } from "./commandPaletteModel";
import { commandFor, type ThingCommand } from "./commands";

export type Verb =
  "pause" | "cancel" | "rollback" | "deploy" | "duplicate" | "issues";

export type VerbEntry = PaletteEntry & {
  verb: Verb;
  /** A command the page for `route` registers; it opens that page first. */
  command?: { name: string; route: string };
  /** Or an address to open. */
  href?: string;
};

/** What the signed-in person may do: the roles are not a ladder. */
export type Roles = { operate: boolean; edit: boolean };

/** Words that ask for a verb; a word asks when it begins one of these. */
const VERB_WORDS: Record<Verb, readonly string[]> = {
  pause: ["pause", "hold"],
  cancel: ["cancel", "stop"],
  rollback: ["roll", "rollback", "revert", "undo"],
  deploy: ["deploy", "release", "ship"],
  duplicate: ["duplicate", "copy", "clone"],
  issues: ["issues", "problems", "failures", "show"],
};

/** Whether the words typed ask for this verb ("pa", "roll", "dep"). */
export function queryAsksFor(query: string, verb: Verb) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .some(
      (word) =>
        word.length >= 2 &&
        VERB_WORDS[verb].some((name) => name.startsWith(word)),
    );
}

/** The verbs worth listing for what was typed. */
export function askedVerbs(query: string, entries: readonly VerbEntry[]) {
  return entries.filter((entry) => queryAsksFor(query, entry.verb));
}

const everyVerb = Object.keys(VERB_WORDS) as Verb[];

/**
 * The typed words that name a thing, without the ones that ask for a verb:
 * "pause edge" looks for "edge", "roll back edge" for "edge". When every word
 * asks for a verb, the whole text is used.
 */
export function wordsNamingThings(query: string) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const asks = (word: string) =>
    everyVerb.some((verb) => queryAsksFor(word, verb));
  const naming = words.filter(
    (word, index) =>
      !asks(word) &&
      !(word.toLowerCase() === "back" && /^roll/i.test(words[index - 1] ?? "")),
  );
  return naming.length ? naming.join(" ") : query.trim();
}

/** The rollout page offers each of these in these states. */
const PAUSABLE = ["active"];
const CANCELLABLE = ["active", "paused", "scheduled"];
const REVERSIBLE = ["active", "paused", "completed", "cancelled", "failed"];

export type RolloutSubject = {
  id: string;
  status: string;
  version_id?: string | null;
  rolled_back_by?: string | null;
  rollback_available?: boolean;
};

export function rolloutVerbs(
  rollout: RolloutSubject,
  title: string,
  { operate }: Roles,
): VerbEntry[] {
  if (!operate) return [];
  const route = `deployments/${rollout.id}`;
  const verb = (
    command: ThingCommand,
    kind: Verb,
    name: string,
    subtitle: string,
    keywords: string,
  ): VerbEntry => ({
    key: `verb:${command}:${rollout.id}`,
    kind: "action",
    verb: kind,
    title: `${name} ${title}`,
    subtitle,
    keywords,
    command: { name: commandFor(command, rollout.id), route },
  });
  const entries: VerbEntry[] = [];
  if (PAUSABLE.includes(rollout.status))
    entries.push(
      verb(
        "rollout.pause",
        "pause",
        "Pause",
        "Opens the review. Devices already released keep their version.",
        "pause hold rollout",
      ),
    );
  if (CANCELLABLE.includes(rollout.status))
    entries.push(
      verb(
        "rollout.cancel",
        "cancel",
        rollout.status === "scheduled" ? "Cancel schedule for" : "Cancel",
        "Opens the review before anything stops.",
        "cancel stop rollout schedule",
      ),
    );
  if (
    rollout.version_id &&
    !rollout.rolled_back_by &&
    REVERSIBLE.includes(rollout.status) &&
    rollout.rollback_available !== false
  )
    entries.push(
      verb(
        "rollout.rollback",
        "rollback",
        "Roll back",
        "Opens the rollback review. Nothing changes until you confirm.",
        "rollback revert undo previous version",
      ),
    );
  return entries;
}

export type PipelineSubject = {
  id: string;
  name: string;
  /** Present once the pipeline has a published version. */
  latest_version?: { number: number } | null;
};

export function pipelineVerbs(
  pipeline: PipelineSubject,
  { operate, edit }: Roles,
): VerbEntry[] {
  const route = `configurations/${pipeline.id}`;
  const entries: VerbEntry[] = [];
  if (operate && pipeline.latest_version)
    entries.push({
      key: `verb:pipeline.deploy:${pipeline.id}`,
      kind: "action",
      verb: "deploy",
      title: `Deploy ${pipeline.name} v${pipeline.latest_version.number}…`,
      subtitle: "Choose devices, then review before anything is sent.",
      keywords: "deploy release ship rollout devices",
      command: { name: commandFor("pipeline.deploy", pipeline.id), route },
    });
  if (edit)
    entries.push({
      key: `verb:pipeline.duplicate:${pipeline.id}`,
      kind: "action",
      verb: "duplicate",
      title: `Duplicate ${pipeline.name}…`,
      subtitle: "Copy this pipeline's draft under a new name.",
      keywords: "duplicate copy clone pipeline",
      command: { name: commandFor("pipeline.duplicate", pipeline.id), route },
    });
  return entries;
}

export function deviceVerbs(device: { id: string; name: string }): VerbEntry[] {
  return [
    {
      key: `verb:device.issues:${device.id}`,
      kind: "action",
      verb: "issues",
      title: `Show issues for ${device.name}`,
      subtitle: "Failures this device reported",
      keywords: "issues problems failures errors device",
      href: `#/issues?device=${encodeURIComponent(device.id)}`,
    },
  ];
}
