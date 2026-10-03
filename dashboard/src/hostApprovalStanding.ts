// What the deploy review can say about a restricted host's allowances.
//
// Vectory never sees them: they live in the host's own policy, and only the
// agent applies them. So the review states a condition ("refuses it unless its
// host already allows ..."), never a fact, and drops the condition for a device
// once something in the review says its host accepts what the version uses:
// Check on devices passed on it, or the version it verifiably runs already
// uses every destination, listener and file root this one does (it applied, so
// its host allowed them).
import type { Device } from "./api";
import type { HostApprovals } from "./hostRequirements";

/** Why a restricted device is known to need nothing more from its host. */
export type ApprovalBasis = "passed" | "runs";

type Restricted = Pick<Device, "id" | "running_version">;

const total = (approvals: HostApprovals) =>
  approvals.destinations.length +
  approvals.listeners.length +
  approvals.fileRoots.length;

/** "destination a:1", "destinations a:1, b:2", "listener c:3", "files under /var/log". */
export function approvalParts(approvals: HostApprovals): string[] {
  const { destinations, listeners, fileRoots } = approvals;
  return [
    destinations.length
      ? `${destinations.length === 1 ? "destination" : "destinations"} ${destinations.join(", ")}`
      : "",
    listeners.length
      ? `${listeners.length === 1 ? "listener" : "listeners"} ${listeners.join(", ")}`
      : "",
    fileRoots.length ? `files under ${fileRoots.join(", ")}` : "",
  ].filter(Boolean);
}

/** "a", "a and b", "a, b and c". */
function sentenceList(items: readonly string[]) {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * What a row names, short: the one thing when there is one, otherwise how many
 * of each ("2 destinations and 1 listener"). The note lists them all.
 */
export function approvalSummary(approvals: HostApprovals): string {
  if (total(approvals) === 1) return approvalParts(approvals)[0];
  const { destinations, listeners, fileRoots } = approvals;
  return sentenceList(
    [
      destinations.length &&
        `${destinations.length} ${destinations.length === 1 ? "destination" : "destinations"}`,
      listeners.length &&
        `${listeners.length} ${listeners.length === 1 ? "listener" : "listeners"}`,
      fileRoots.length &&
        `files under ${fileRoots.length} ${fileRoots.length === 1 ? "directory" : "directories"}`,
    ].filter((part): part is string => !!part),
  );
}

/** A directory an allowance for `held` covers: itself and everything below it. */
const underRoot = (root: string, held: string) =>
  root === held || root.startsWith(held.endsWith("/") ? held : `${held}/`);

/**
 * Whether `used` already holds everything `needed` names. A host that let one
 * version use a destination or listener allowed that exact address; a file
 * root is allowed with everything under it.
 */
export function approvalsCovered(
  needed: HostApprovals,
  used: HostApprovals,
): boolean {
  return (
    needed.destinations.every((item) => used.destinations.includes(item)) &&
    needed.listeners.every((item) => used.listeners.includes(item)) &&
    needed.fileRoots.every((root) =>
      used.fileRoots.some((held) => underRoot(root, held)),
    )
  );
}

/**
 * Which restricted devices need nothing more from their hosts, and why. A
 * passed check is the stronger reason. `running` maps a version id to what
 * that version uses; null means it could not be read or compared (a version
 * with device-specific values uses different addresses on each device), and
 * proves nothing.
 */
export function approvalBasis(
  needed: HostApprovals,
  devices: readonly Restricted[],
  evidence: {
    passed: ReadonlySet<string>;
    running: ReadonlyMap<string, HostApprovals | null>;
    /** False when this version's own addresses differ by device. */
    comparable: boolean;
  },
): Map<string, ApprovalBasis> {
  const known = new Map<string, ApprovalBasis>();
  for (const device of devices) {
    if (evidence.passed.has(device.id)) {
      known.set(device.id, "passed");
      continue;
    }
    const held = device.running_version?.id
      ? evidence.running.get(device.running_version.id)
      : null;
    if (evidence.comparable && held && approvalsCovered(needed, held))
      known.set(device.id, "runs");
  }
  return known;
}

/** What a row says beside a restricted device that may still be refused. */
export function refusalCondition(approvals: HostApprovals): string {
  return `refuses it unless its host allows ${approvalSummary(approvals)}`;
}

/** "web-01", "web-01 and edge-2", "web-01, edge-2 and 3 more". */
function named(names: readonly string[]) {
  return names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** The note's headline, for the restricted devices that may still be refused. */
export function approvalHeadline(names: readonly string[]): string {
  return names.length === 1
    ? `${names[0]} runs in restricted mode and needs its host to allow what this version uses`
    : `${names.length.toLocaleString()} selected devices run in restricted mode and need their hosts to allow what this version uses`;
}

/**
 * The note's two paragraphs under the headline: what the version uses and the
 * condition it puts on the host, then how to find out and who can allow it.
 */
export function approvalParagraphs(
  approvals: HostApprovals,
  devices: number,
): [string, string] {
  const one = devices === 1;
  return [
    `It uses ${approvalParts(approvals).join("; ")}. ${
      one
        ? "It refuses this version unless its host already allows these."
        : "They refuse this version unless their hosts already allow these."
    }`,
    `Vectory can't see a host's allowances; Check on devices in the review shows whether ${one ? "it has" : "they have"} them. Only the host operator can allow these; the dashboard can't.`,
  ];
}

/** What the review already knows about the other restricted devices, or null. */
export function approvalEvidence(
  passed: readonly string[],
  runs: readonly string[],
): string | null {
  const sentences = [
    passed.length ? `Check on devices passed on ${named(passed)}.` : "",
    runs.length
      ? `${named(runs)} already ${runs.length === 1 ? "runs" : "run"} a version that uses these.`
      : "",
  ].filter(Boolean);
  return sentences.length ? sentences.join(" ") : null;
}

/** The note when a check passed on every restricted device still in question. */
export function passedHeadline(names: readonly string[]): string {
  return `Check on devices passed on ${named(names)}`;
}
export function passedSentence(devices: number): string {
  return devices === 1
    ? "It runs in restricted mode, and its host accepted this version."
    : "They run in restricted mode, and their hosts accepted this version.";
}
