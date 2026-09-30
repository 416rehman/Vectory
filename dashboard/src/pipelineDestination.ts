export type PipelinePanel = "settings" | "history" | "details" | "tools";
export type PipelineSection =
  | "general"
  | "enrichment_tables"
  | "secret"
  | "variables"
  | "tests"
  | "provider";
export type PipelineDestination = {
  panel: PipelinePanel;
  section?: PipelineSection;
  /** The test to select (1-based), for the tests section. */
  test?: number;
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

/** Links can open a view, never run a test, save, publish or deploy. */
export function readPipelineDestination(
  search: string,
): PipelineDestination | undefined {
  const query = new URLSearchParams(search);
  const panel = query.get("panel");
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

export function pipelineDestinationLabel(destination: PipelineDestination) {
  if (destination.panel === "settings")
    return sections[destination.section || "general"];
  return {
    history: "Version history",
    details: "Pipeline details",
    tools: "Pipeline actions",
  }[destination.panel];
}
