/**
 * Refusals the agent decides itself, before Vector sees a version, and says in
 * the same words wherever they appear. Each arrives as `CAPABILITY_DENIED`
 * with the finding's own code; the finding decides what to say, and the host's
 * mode only when the finding doesn't name the cause.
 */
export type Refusal = {
  code: "LOCAL_API_DENIED" | "INVALID_COMPONENT_ID";
  /** Follows "Apply failed": why the agent refused. */
  phrase: string;
  /** The rule, for places that already show the specific finding. */
  reason: string;
  /** What clears it. */
  next: string;
};

const refusals: Refusal[] = [
  {
    code: "LOCAL_API_DENIED",
    phrase: "because restricted mode refuses an api block",
    reason:
      "Restricted mode refuses any top-level api block, and no allowance can permit it.",
    next: "Remove the api block, or deploy to a full-mode device.",
  },
  {
    code: "INVALID_COMPONENT_ID",
    phrase: "because a component ID names a path",
    reason:
      "A component ID can't name a path, and devices in both modes refuse one.",
    next: "Rename the component and the inputs that name it.",
  },
];

/**
 * The refusal a failure reports, from its findings' codes or the leading
 * code a rollout names; null for anything else.
 */
export function agentRefusal(
  diagnostics?: readonly { code: string }[] | null,
  code?: string | null,
): Refusal | null {
  const codes = [code, ...(diagnostics ?? []).map((entry) => entry.code)];
  for (const known of codes) {
    const refusal = refusals.find((entry) => entry.code === known);
    if (refusal) return refusal;
  }
  return null;
}

/** "Apply failed because …" for a capability refusal that names no cause. */
export function capabilityPhrase(mode: "restricted" | "full" | undefined) {
  return mode === "full"
    ? "because this host's local policy doesn't allow it"
    : "because this host's restricted mode doesn't allow it";
}
