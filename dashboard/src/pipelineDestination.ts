export type PipelinePanel = "settings" | "history" | "details" | "tools";
export type PipelineSection =
  | "general"
  | "enrichment_tables"
  | "secret"
  | "variables"
  | "tests"
  | "provider";
export type PipelineDestination = {
  /** A view of the pipeline, or "step": one step to open, as a fix leads to. */
  panel: PipelinePanel | "step";
  section?: PipelineSection;
  /** The test to select (1-based), for the tests section. */
  test?: number;
  /** For "step": the step to select, and the field to show in its settings. */
  select?: string;
  field?: string;
};

const panels = new Set(["settings", "history", "details", "tools"]);
const sections: Record<PipelineSection, string> = {
  general: "Pipeline settings",
  enrichment_tables: "Enrichment tables",
  secret: "Secrets",
  variables: "Variables",
  tests: "Pipeline tests",
  provider: "Configuration provider",
};
/** A step's name is only ever compared with the draft's, so it needs no shape. */
const MAX_STEP_NAME = 100;
/** A field's path: names, dots and list positions, as a finding writes it. */
const fieldPath = /^[A-Za-z0-9_.\[\]-]{1,128}$/;

/** Links can open a view, never run a test, save, publish or deploy. */
export function readPipelineDestination(
  search: string,
): PipelineDestination | undefined {
  const query = new URLSearchParams(search);
  const panel = query.get("panel");
  const select = query.get("select");
  if (!panel && select && select.length <= MAX_STEP_NAME) {
    const field = query.get("field");
    return {
      panel: "step",
      select,
      ...(field && fieldPath.test(field) ? { field } : {}),
    };
  }
  if (!panel || !panels.has(panel)) return undefined;
  const section = query.get("section");
  const test = query.get("test");
  return {
    panel: panel as PipelinePanel,
    ...(panel === "settings" && section && Object.hasOwn(sections, section)
      ? { section: section as PipelineSection }
      : {}),
    ...(panel === "settings" &&
    section === "tests" &&
    test &&
    /^[1-9]\d{0,2}$/.test(test)
      ? { test: Number(test) }
      : {}),
  };
}

/**
 * Whether a step writes the setting a link names: its path (`rate`,
 * `route.errors`, `routes[0].condition`) leads to a value in the step. A
 * setting the step doesn't write may still be offered under "Add field".
 */
export function fieldIsSet(step: unknown, path: string): boolean {
  const parts = path.split(/[.[\]]+/).filter(Boolean);
  if (!parts.length) return false;
  let current: unknown = step;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return false;
    if (!Object.hasOwn(current, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

/** The address parameters a destination is written as. */
export function destinationQuery(
  destination: PipelineDestination,
  query = new URLSearchParams(),
) {
  if (destination.panel === "step") {
    if (destination.select) query.set("select", destination.select);
    if (destination.field) query.set("field", destination.field);
    return query;
  }
  query.set("panel", destination.panel);
  if (destination.section) query.set("section", destination.section);
  if (destination.test) query.set("test", String(destination.test));
  return query;
}

/**
 * A pipeline's address with the step and field a finding names. A finding that
 * names no step leaves the address as it is, and the pipeline opens alone.
 */
export function withStep(
  href: string,
  step?: string | null,
  field?: string | null,
) {
  if (!step) return href;
  const query = destinationQuery({
    panel: "step",
    select: step,
    ...(field ? { field } : {}),
  });
  return `${href}${href.includes("?") ? "&" : "?"}${query}`;
}

/** Where a problem is fixed: the pipeline, with its step selected. */
export function pipelineFixHref(
  configurationId: string,
  step?: string | null,
  field?: string | null,
) {
  return withStep(
    `#/configurations/${encodeURIComponent(configurationId)}`,
    step,
    field,
  );
}

export function pipelineDestinationLabel(destination: PipelineDestination) {
  if (destination.panel === "settings")
    return sections[destination.section || "general"];
  return {
    history: "Version history",
    details: "Pipeline details",
    tools: "Pipeline actions",
    step: "the step",
  }[destination.panel];
}
