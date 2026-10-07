import type { Config, Configuration } from "./api";
import type { ConfigurationFormat } from "./configurationSource";
import { toGraph } from "./catalog";
import { arrangeGraph } from "./pipelineEditing";
import { graphIsTooLarge } from "./standaloneLimits";

export type LocalDesignerDocument = {
  name: string;
  config: Config;
  source: string;
  format: ConfigurationFormat;
};

/** An in-memory editor document, never a server record or published version. */
export function localEditorDocument(
  local: LocalDesignerDocument,
): Configuration {
  return {
    id: "local-designer",
    name: local.name,
    description: "",
    revision: 0,
    config: local.config,
    graph: graphIsTooLarge(local.config)
      ? { nodes: [], edges: [] }
      : arrangeGraph(toGraph(local.config)),
    variables: [],
    created_at: "",
    updated_at: "",
  };
}
