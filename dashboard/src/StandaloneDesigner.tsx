import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowDownToLine,
  Braces,
  Check,
  CircleAlert,
  Code2,
  Download,
  FilePlus2,
  FolderOpen,
  LayoutTemplate,
  Plus,
  Search,
  X,
} from "lucide-react";
import type { Config, Graph } from "./api";
import {
  catalog,
  componentSchema,
  pipelineIssues,
  removePipelineStep,
  starter,
  toGraph,
  type Component,
  type Kind,
  vectorSchema,
} from "./catalog";
import {
  diagnoseConfiguration,
  diagnoseConfigurationSource,
  detectConfigurationFormat,
  guessConfigurationFormat,
  MAX_CONFIGURATION_BYTES,
  parseSource,
  sourceErrorMessage,
  type ConfigurationFormat,
} from "./configurationSource";
import {
  hasSourceComments,
  stringifyConfiguration,
} from "./configurationFormats";
import { arrangeGraph, connectConnection, disconnect } from "./pipelineEditing";
import { patternEdges, patternInputs } from "./inputPatterns";
import {
  graphIsTooLarge,
  renderBoundedConfiguration,
} from "./standaloneLimits";
import ConfigurationCodeEditor from "./ConfigurationCodeEditor";
import PipelineNode from "./PipelineNode";
import PipelineEdge from "./PipelineEdge";
import PipelineSchemaFields from "./PipelineSchemaFields";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import "./pipeline-node.css";
import "./standalone-designer.css";

const nodeTypes = { component: PipelineNode };
const edgeTypes = { pipeline: PipelineEdge };
const kinds: Kind[] = ["sources", "transforms", "sinks"];
const kindNames: Record<Kind, string> = {
  sources: "Sources",
  transforms: "Transforms",
  sinks: "Destinations",
};
const empty = (): Config => ({ sources: {}, transforms: {}, sinks: {} });
const emptySource = stringifyConfiguration(empty(), "yaml");
const byteLength = (text: string) => new TextEncoder().encode(text).length;
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The configuration could not be changed.";

function fallbackSchema(definition: Component) {
  const properties: Record<string, object> = {};
  for (const field of definition.fields) {
    const key = field.key.split(".")[0];
    if (properties[key]) continue;
    properties[key] = {
      type:
        field.type === "number"
          ? "number"
          : field.type === "boolean"
            ? "boolean"
            : field.type === "array"
              ? "array"
              : "string",
      ...(field.type === "array" ? { items: { type: "string" } } : {}),
      ...(field.options ? { enum: field.options } : {}),
      _metadata: { "docs::human_name": field.label },
    };
  }
  return {
    type: "object",
    properties,
    required: definition.fields
      .filter((field) => field.required)
      .map((field) => field.key.split(".")[0]),
  };
}

function formatExtension(format: ConfigurationFormat) {
  return format === "yaml" ? "yaml" : format;
}

function Designer() {
  const [config, setConfig] = useState<Config>(empty);
  const [graph, setGraph] = useState<Graph>(() => toGraph(empty()));
  const [graphOmitted, setGraphOmitted] = useState(false);
  const [code, setCode] = useState(emptySource);
  const [appliedCode, setAppliedCode] = useState(emptySource);
  const [format, setFormat] = useState<ConfigurationFormat>("yaml");
  const [name, setName] = useState("vector");
  const [view, setView] = useState<"details" | "code">("details");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [selection, setSelection] = useState<
    { type: "node" | "edge"; id: string } | undefined
  >();
  const [edgeStyle, setEdgeStyle] = useState<
    "curved" | "orthogonal" | "straight"
  >("curved");
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<ConfigurationFormat>("yaml");
  const [importName, setImportName] = useState("vector");
  const [importError, setImportError] = useState("");
  const [addKind, setAddKind] = useState<Kind>("sources");
  const [addQuery, setAddQuery] = useState("");
  const [notice, setNotice] = useState("");
  const importDialog = useRef<HTMLDialogElement>(null);
  const addDialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const flow = useRef<ReactFlowInstance<any, any> | null>(null);
  const detailsTab = useRef<HTMLButtonElement>(null);
  const codeTab = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const guide = document.querySelector<HTMLDetailsElement>(".designer-guide");
    function dismissGuide(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && guide?.open) {
        guide.open = false;
        guide.querySelector<HTMLElement>("summary")?.focus();
      }
    }
    function outsideGuide(event: PointerEvent) {
      if (guide?.open && !guide.contains(event.target as Node))
        guide.open = false;
    }
    document.addEventListener("keydown", dismissGuide);
    document.addEventListener("pointerdown", outsideGuide);
    return () => {
      document.removeEventListener("keydown", dismissGuide);
      document.removeEventListener("pointerdown", outsideGuide);
    };
  }, []);

  useEffect(() => {
    const dialog = importDialog.current;
    if (importOpen && !dialog?.open) dialog?.showModal();
    if (!importOpen && dialog?.open) dialog.close();
  }, [importOpen]);
  useEffect(() => {
    const dialog = addDialog.current;
    if (addOpen && !dialog?.open) dialog?.showModal();
    if (!addOpen && dialog?.open) dialog.close();
  }, [addOpen]);

  const codeDirty = code !== appliedCode;
  const diagnosis = useMemo(
    () =>
      graphOmitted
        ? { diagnostics: [], locallyValid: false }
        : diagnoseConfiguration(config),
    [config, graphOmitted],
  );
  const sourceDiagnosis = useMemo(
    () =>
      !codeDirty && graphOmitted
        ? { config, diagnostics: [], locallyValid: false }
        : diagnoseConfigurationSource(code, format),
    [code, format, codeDirty, graphOmitted, config],
  );
  const issues = useMemo(() => {
    if (graphOmitted) return [];
    const known = pipelineIssues(config);
    const messages = new Set(
      known.map((entry) => `${entry.id || ""}:${entry.message}`),
    );
    for (const diagnostic of diagnosis.diagnostics) {
      if (diagnostic.severity !== "error" || !diagnostic.componentId) continue;
      const entry = { id: diagnostic.componentId, message: diagnostic.message };
      const key = `${entry.id}:${entry.message}`;
      if (!messages.has(key)) {
        known.push(entry);
        messages.add(key);
      }
    }
    return known;
  }, [config, graphOmitted, diagnosis]);
  const issueCount = diagnosis.diagnostics.filter(
    (item) => item.severity === "error",
  ).length;

  const visualNodes = useMemo(
    () =>
      graph.nodes.map((node) => {
        const nodeIssues = issues.filter((issue) => issue.id === node.id);
        return {
          ...node,
          selected: selection?.type === "node" && selection.id === node.id,
          data: {
            ...node.data,
            hasIssue: nodeIssues.length > 0,
            issueCount: nodeIssues.length,
            issueMessage: nodeIssues[0]?.message,
            connectivityWarning:
              node.data.kind === "transforms" && node.data.disconnected
                ? "No incoming connection"
                : undefined,
          },
        };
      }),
    [graph.nodes, issues, selection],
  );
  const visualEdges = useMemo(() => {
    const concrete = graph.edges.map((edge) => ({
      ...edge,
      type: "pipeline",
      selected: selection?.type === "edge" && selection.id === edge.id,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#79818d" },
      data: { connectionStyle: edgeStyle },
    }));
    const patterns = (
      graphOmitted ? [] : patternEdges(patternInputs(config))
    ).map((edge) => ({
      ...edge,
      type: "pipeline",
      selectable: false,
      data: {
        connectionStyle: edgeStyle,
        pattern: edge.pattern,
        patternMore: edge.more,
      },
    }));
    return [...concrete, ...patterns];
  }, [graph.edges, config, edgeStyle, selection, graphOmitted]);

  const selectedNode =
    selection?.type === "node"
      ? graph.nodes.find((node) => node.id === selection.id)
      : undefined;
  const selectedEdge =
    selection?.type === "edge"
      ? graph.edges.find((edge) => edge.id === selection.id)
      : undefined;
  const selectedKind = selectedNode?.data.kind as Kind | undefined;
  const selectedComponent = selectedNode?.data.component as Config | undefined;
  const selectedDefinition = catalog.find(
    (item) =>
      item.kind === selectedKind && item.type === selectedComponent?.type,
  );
  const additions = catalog
    .filter((item) => item.kind === addKind)
    .filter((item) =>
      `${item.label} ${item.type} ${item.description}`
        .toLowerCase()
        .includes(addQuery.toLowerCase().trim()),
    )
    .sort(
      (left, right) =>
        Number(!!right.curated) - Number(!!left.curated) ||
        left.label.localeCompare(right.label),
    )
    .slice(0, 60);

  function inspectorTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const next =
      event.key === "Home"
        ? "details"
        : event.key === "End"
          ? "code"
          : event.key === "ArrowRight" || event.key === "ArrowLeft"
            ? view === "details"
              ? "code"
              : "details"
            : null;
    if (!next) return;
    event.preventDefault();
    setView(next);
    setInspectorOpen(true);
    (next === "details" ? detailsTab : codeTab).current?.focus();
  }

  function fitSoon() {
    window.setTimeout(
      () => flow.current?.fitView({ padding: 0.18, duration: 360 }),
      30,
    );
  }

  function warnSourceRewrite(): boolean {
    if (codeDirty) {
      setNotice("Apply or discard your code edits before changing the graph.");
      setView("code");
      setInspectorOpen(true);
      return false;
    }
    if (
      hasSourceComments(appliedCode, format) &&
      !window.confirm(
        "This graph edit will regenerate the configuration and remove YAML or TOML comments. Download the original first if you need those comments. Continue?",
      )
    )
      return false;
    return true;
  }

  function replaceConfig(
    next: Config,
    nextSelection = selection,
    relayout = false,
  ) {
    try {
      const rendered = renderBoundedConfiguration(next, format);
      const tooLarge = graphIsTooLarge(next);
      const nextGraph = tooLarge
        ? { nodes: [], edges: [] }
        : relayout
          ? arrangeGraph(toGraph(next))
          : toGraph(next, graph);
      setConfig(next);
      setGraph(nextGraph);
      setGraphOmitted(tooLarge);
      setCode(rendered);
      setAppliedCode(rendered);
      setSelection(nextSelection);
      setNotice(
        tooLarge
          ? "The configuration is intact, but its graph exceeds a display limit: 500 components, 2,000 connections or output ports, or 128 outputs per component. Edit or export it in Code."
          : "Configuration updated locally. Export to keep your work.",
      );
      if (relayout) fitSoon();
      return true;
    } catch (error) {
      setNotice(errorText(error));
      return false;
    }
  }

  function load(
    text: string,
    incomingFormat: ConfigurationFormat,
    fileName: string,
  ) {
    try {
      if (byteLength(text) > MAX_CONFIGURATION_BYTES)
        throw Error("Choose a configuration no larger than 1 MiB.");
      const parsed = parseSource(text, incomingFormat);
      const tooLarge = graphIsTooLarge(parsed);
      setConfig(parsed);
      setGraph(
        tooLarge ? { nodes: [], edges: [] } : arrangeGraph(toGraph(parsed)),
      );
      setGraphOmitted(tooLarge);
      setCode(text);
      setAppliedCode(text);
      setFormat(incomingFormat);
      setName(fileName.replace(/\.(yaml|yml|json|toml)$/i, "") || "vector");
      setSelection(undefined);
      setView("details");
      setInspectorOpen(false);
      setImportError("");
      setImportOpen(false);
      setNotice(
        tooLarge
          ? "Configuration opened locally. The graph exceeds a display limit: 500 components, 2,000 connections or output ports, or 128 outputs per component. Code and export remain available."
          : "Configuration opened locally. No file was uploaded.",
      );
      fitSoon();
      return true;
    } catch (error) {
      setImportError(sourceErrorMessage(text, error));
      return false;
    }
  }

  function confirmReplacement(): boolean {
    return (
      (!codeDirty && appliedCode === emptySource && format === "yaml") ||
      window.confirm(
        "Replace the configuration in this tab? Export your current work first if you want to keep it.",
      )
    );
  }

  function startBlank() {
    if (!confirmReplacement()) return;
    load(emptySource, "yaml", "vector.yaml");
    setNotice("Blank configuration ready. Add a source to begin.");
  }

  function startExample() {
    if (!confirmReplacement()) return;
    load(
      stringifyConfiguration(starter, "yaml"),
      "yaml",
      "synthetic-example.yaml",
    );
    setNotice(
      "Synthetic example opened. It is sample configuration, not an active pipeline.",
    );
  }

  async function readFile(file?: File) {
    if (!file) return;
    if (file.size > MAX_CONFIGURATION_BYTES) {
      setImportError("Choose a configuration no larger than 1 MiB.");
      return;
    }
    try {
      const incomingFormat = detectConfigurationFormat(file.name);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      setImportText(text);
      setImportName(file.name);
      setImportFormat(incomingFormat);
      setImportError("");
    } catch (error) {
      setImportError(errorText(error));
    }
  }

  function applyCode() {
    if (byteLength(code) > MAX_CONFIGURATION_BYTES) {
      setNotice("The configuration exceeds the 1 MiB limit.");
      return;
    }
    if (!sourceDiagnosis.config) {
      setNotice(
        sourceDiagnosis.diagnostics[0]?.message ||
          "Fix the code before applying it.",
      );
      return;
    }
    setConfig(sourceDiagnosis.config);
    const tooLarge = graphIsTooLarge(sourceDiagnosis.config);
    setGraph(
      tooLarge
        ? { nodes: [], edges: [] }
        : arrangeGraph(toGraph(sourceDiagnosis.config)),
    );
    setGraphOmitted(tooLarge);
    setAppliedCode(code);
    setSelection(undefined);
    setNotice(
      tooLarge
        ? "Code applied. The graph exceeds the display limit; code and export remain available."
        : "Code applied to the local graph. Local checks may still need attention.",
    );
    fitSoon();
  }

  function discardCodeEdits() {
    setCode(appliedCode);
    setNotice("Unapplied code edits discarded.");
  }

  function changeFormat(nextFormat: ConfigurationFormat) {
    if (nextFormat === format) return;
    if (codeDirty) {
      setNotice("Apply or discard your code edits before changing format.");
      return;
    }
    if (
      hasSourceComments(appliedCode, format) &&
      !window.confirm(
        "Converting formats removes YAML or TOML comments. Download the original first if you need them. Continue?",
      )
    )
      return;
    try {
      const rendered = renderBoundedConfiguration(config, nextFormat);
      setFormat(nextFormat);
      setCode(rendered);
      setAppliedCode(rendered);
      setNotice(
        `Converted locally to ${nextFormat.toUpperCase()}. Export to keep this format.`,
      );
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  function exportFile() {
    if (codeDirty) {
      setView("code");
      setInspectorOpen(true);
      setNotice("Apply or discard your code edits before exporting.");
      return;
    }
    try {
      parseSource(appliedCode, format);
      const blob = new Blob([appliedCode], {
        type: "text/plain;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name || "vector"}.${formatExtension(format)}`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(
        "Configuration downloaded. It has not been validated by Vector or deployed.",
      );
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  function addComponent(item: Component) {
    if (graphOmitted) {
      setNotice(
        "Reduce the configuration below the graph display limit in Code before adding components visually.",
      );
      return;
    }
    if (!warnSourceRewrite()) return;
    const next = structuredClone(config);
    const used = new Set(
      kinds.flatMap((kind) => Object.keys(next[kind] || {})),
    );
    const base = item.type.replace(/[^a-zA-Z0-9_]/g, "_") || "step";
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}_${suffix++}`;
    next[item.kind] ??= {};
    next[item.kind][id] = {
      type: item.type,
      ...structuredClone(item.defaults),
      ...(item.kind === "sources" ? {} : { inputs: [] }),
    };
    if (replaceConfig(next, { type: "node", id }, true)) {
      setAddOpen(false);
      setView("details");
      setInspectorOpen(true);
    }
  }

  function changeComponent(nextComponent: Config) {
    if (!selectedNode || !selectedKind || !warnSourceRewrite()) return;
    const next = structuredClone(config);
    next[selectedKind][selectedNode.id] = nextComponent;
    replaceConfig(next);
  }

  function removeComponent() {
    if (!selectedNode || !warnSourceRewrite()) return;
    if (!window.confirm(`Remove ${selectedNode.id} and its connections?`))
      return;
    replaceConfig(removePipelineStep(config, selectedNode.id), undefined);
  }

  function connect(connection: Connection) {
    if (!warnSourceRewrite()) return;
    if (!connection.source || !connection.target) return;
    try {
      const next = connectConnection(config, connection);
      replaceConfig(next, { type: "node", id: connection.target });
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  function removeConnection() {
    if (!selectedEdge || !warnSourceRewrite()) return;
    try {
      replaceConfig(disconnect(config, selectedEdge), undefined);
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  function onNodesChange(changes: NodeChange[]) {
    setGraph((previous) => ({
      ...previous,
      nodes: applyNodeChanges(changes, previous.nodes),
    }));
  }

  return (
    <section
      className="standalone-designer"
      aria-label="Vector configuration designer"
    >
      <div className="designer-toolbar">
        <div className="designer-toolbar-lead">
          <div>
            <strong>Configuration workspace</strong>
            <small>Local to this browser tab</small>
          </div>
        </div>
        <div className="designer-toolbar-actions">
          <button type="button" onClick={startBlank}>
            <FilePlus2 size={16} />
            Blank
          </button>
          <button type="button" onClick={startExample}>
            <LayoutTemplate size={16} />
            Example
          </button>
          <button
            type="button"
            onClick={() => {
              setImportText("");
              setImportName("vector");
              setImportFormat("yaml");
              setImportError("");
              setImportOpen(true);
            }}
          >
            <FolderOpen size={16} />
            Import
          </button>
          <button
            type="button"
            className="designer-export"
            onClick={exportFile}
          >
            <Download size={16} />
            Export {format.toUpperCase()}
          </button>
        </div>
      </div>
      <div className="designer-workspace">
        <div className="designer-canvas-wrap">
          <div className="designer-canvas-bar">
            <div className="designer-canvas-title">
              {graphOmitted
                ? "Graph display limit reached"
                : graph.nodes.length
                  ? `${graph.nodes.length} components · ${graph.edges.length} connections`
                  : "Empty configuration"}
            </div>
            <div className="designer-canvas-actions">
              <label>
                Lines{" "}
                <select
                  aria-label="Connection style"
                  value={edgeStyle}
                  onChange={(event) =>
                    setEdgeStyle(event.target.value as typeof edgeStyle)
                  }
                >
                  <option value="curved">Curved</option>
                  <option value="orthogonal">Circuit</option>
                  <option value="straight">Straight</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => {
                  setGraph(arrangeGraph(toGraph(config)));
                  fitSoon();
                }}
                disabled={!graph.nodes.length}
                title="Arrange graph"
              >
                <LayoutTemplate size={16} />
                <span>Arrange</span>
              </button>
              <button
                type="button"
                className="designer-add-button"
                disabled={graphOmitted}
                onClick={() => setAddOpen(true)}
              >
                <Plus size={16} />
                Add component
              </button>
            </div>
          </div>
          <div className="designer-canvas" aria-label="Pipeline graph">
            <ReactFlow
              nodes={visualNodes}
              edges={visualEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={(instance) => {
                flow.current = instance;
              }}
              onNodesChange={onNodesChange}
              onNodeClick={(_event, node) => {
                setSelection({ type: "node", id: node.id });
                setView("details");
                setInspectorOpen(true);
              }}
              onEdgeClick={(_event, edge) => {
                if (!edge.id.startsWith("pattern:")) {
                  setSelection({ type: "edge", id: edge.id });
                  setView("details");
                  setInspectorOpen(true);
                }
              }}
              onPaneClick={() => setSelection(undefined)}
              onConnect={connect}
              nodesConnectable
              nodesDraggable
              nodesFocusable
              edgesFocusable
              deleteKeyCode={null}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.2}
              maxZoom={2}
              proOptions={{ hideAttribution: false }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="#cbd4de"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
            {graphOmitted ? (
              <div className="designer-empty">
                <h2>Graph display limit reached.</h2>
                <p>
                  The full configuration is preserved in Code and remains
                  available to export. Visual editing supports up to 500
                  components, 2,000 connections or output ports, and 128 outputs
                  per component.
                </p>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setView("code");
                      setInspectorOpen(true);
                    }}
                  >
                    Open Code
                  </button>
                </div>
              </div>
            ) : (
              !graph.nodes.length && (
                <div className="designer-empty">
                  <div className="designer-empty-symbol" aria-hidden="true">
                    <span>○</span>
                    <span>→</span>
                    <span>○</span>
                  </div>
                  <h2>Every flow starts somewhere.</h2>
                  <p>
                    Add a source, open the synthetic example, or import a
                    configuration you already have.
                  </p>
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        setAddKind("sources");
                        setAddOpen(true);
                      }}
                    >
                      <Plus size={17} />
                      Add a source
                    </button>
                    <button type="button" onClick={startExample}>
                      Explore example
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        </div>
        <aside
          className="designer-inspector"
          data-inspector-open={inspectorOpen}
          aria-label="Configuration inspector"
        >
          <div className="designer-inspector-bar">
            <div
              className="designer-inspector-tabs"
              role="tablist"
              aria-label="Inspector view"
            >
              <button
                type="button"
                ref={detailsTab}
                id="designer-details-tab"
                role="tab"
                aria-controls="designer-details-panel"
                aria-selected={view === "details"}
                tabIndex={view === "details" ? 0 : -1}
                onKeyDown={inspectorTabKeyDown}
                onClick={() => {
                  setView("details");
                  setInspectorOpen(true);
                }}
              >
                Details
              </button>
              <button
                type="button"
                ref={codeTab}
                id="designer-code-tab"
                role="tab"
                aria-controls="designer-code-panel"
                aria-selected={view === "code"}
                tabIndex={view === "code" ? 0 : -1}
                onKeyDown={inspectorTabKeyDown}
                onClick={() => {
                  setView("code");
                  setInspectorOpen(true);
                }}
              >
                <Code2 size={15} />
                Code
                {codeDirty && (
                  <span
                    className="designer-unsaved-dot"
                    aria-label="Unapplied edits"
                  />
                )}
              </button>
            </div>
            <button
              className="designer-inspector-close"
              type="button"
              aria-label="Collapse inspector"
              onClick={() => {
                setInspectorOpen(false);
                (view === "code" ? codeTab : detailsTab).current?.focus();
              }}
            >
              <X size={17} />
            </button>
          </div>
          {view === "details" ? (
            <>
              <div
                id="designer-details-panel"
                className="designer-inspector-body"
                role="tabpanel"
                aria-labelledby="designer-details-tab"
                tabIndex={0}
              >
                {graphOmitted ? (
                  <div className="designer-inspector-empty">
                    <div
                      className="designer-inspector-glyph"
                      aria-hidden="true"
                    >
                      <Braces size={25} />
                    </div>
                    <h2>Configuration preserved.</h2>
                    <p>
                      This file is larger than the graph display limit. Open
                      Code to inspect, edit, and export the complete source.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setView("code");
                        setInspectorOpen(true);
                      }}
                    >
                      <Code2 size={16} />
                      Open Code
                    </button>
                  </div>
                ) : selectedNode && selectedComponent && selectedKind ? (
                  <>
                    <div
                      className="designer-detail-heading"
                      data-pipeline-category={selectedKind}
                    >
                      <small>{kindNames[selectedKind].slice(0, -1)}</small>
                      <h2>{selectedNode.id}</h2>
                      <code>{selectedComponent.type || "No type"}</code>
                    </div>
                    {issues.filter((issue) => issue.id === selectedNode.id)
                      .length > 0 && (
                      <div className="designer-detail-problems">
                        <strong>Needs attention</strong>
                        <ul>
                          {issues
                            .filter((issue) => issue.id === selectedNode.id)
                            .slice(0, 6)
                            .map((issue, index) => (
                              <li key={`${issue.message}-${index}`}>
                                {issue.message}
                              </li>
                            ))}
                        </ul>
                      </div>
                    )}
                    <p className="designer-detail-intro">
                      Change fields below, or use Code for every setting. Drag
                      from an output to an input to connect components.
                    </p>
                    {selectedDefinition ? (
                      <PipelineSchemaFields
                        key={selectedNode.id}
                        schema={
                          componentSchema(selectedDefinition) ||
                          fallbackSchema(selectedDefinition)
                        }
                        root={vectorSchema}
                        component={selectedComponent}
                        onChange={changeComponent}
                        editable
                      />
                    ) : (
                      <p className="designer-unknown">
                        This component is outside the bundled catalog. Its
                        settings are preserved. Open Code to edit them directly.
                      </p>
                    )}
                    <div className="designer-detail-footer">
                      <button
                        type="button"
                        onClick={() => {
                          setView("code");
                          setInspectorOpen(true);
                        }}
                      >
                        <Braces size={15} />
                        Edit full configuration
                      </button>
                      <button
                        type="button"
                        className="designer-danger-link"
                        onClick={removeComponent}
                      >
                        Remove component
                      </button>
                    </div>
                  </>
                ) : selectedEdge ? (
                  <>
                    <div className="designer-detail-heading">
                      <small>Connection</small>
                      <h2>
                        {selectedEdge.source} → {selectedEdge.target}
                      </h2>
                    </div>
                    <p className="designer-detail-intro">
                      This connection adds an input reference to{" "}
                      <code>{selectedEdge.target}</code>. Drag a component
                      output to another input to create a connection.
                    </p>
                    <button
                      type="button"
                      className="designer-danger-link"
                      onClick={removeConnection}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <>
                    <div className="designer-inspector-empty">
                      <div
                        className="designer-inspector-glyph"
                        aria-hidden="true"
                      >
                        ↗
                      </div>
                      <h2>Follow the flow.</h2>
                      <p>
                        Select a component or connection to inspect its
                        settings. Draw between handles to connect steps.
                      </p>
                      <button type="button" onClick={() => setAddOpen(true)}>
                        <Plus size={16} />
                        Add component
                      </button>
                    </div>
                    <div
                      className="designer-check-summary"
                      data-tone={
                        graphOmitted
                          ? "skipped"
                          : issueCount
                            ? "error"
                            : "clear"
                      }
                    >
                      <strong>
                        {graphOmitted || issueCount ? (
                          <CircleAlert size={16} />
                        ) : (
                          <Check size={16} />
                        )}
                        Local structure check
                      </strong>
                      <p>
                        {graphOmitted
                          ? "Graph and local checks were skipped because this configuration exceeds the display limit."
                          : issueCount
                            ? `${issueCount} local ${issueCount === 1 ? "error" : "errors"} to review.`
                            : "No local structural errors detected."}{" "}
                        The installed Vector binary must validate the final
                        file.
                      </p>
                    </div>
                  </>
                )}
              </div>
              <div
                id="designer-code-panel"
                role="tabpanel"
                aria-labelledby="designer-code-tab"
                hidden
              />
            </>
          ) : (
            <>
              <div
                id="designer-details-panel"
                role="tabpanel"
                aria-labelledby="designer-details-tab"
                hidden
              />
              <div
                id="designer-code-panel"
                className="designer-code-pane"
                role="tabpanel"
                aria-labelledby="designer-code-tab"
                tabIndex={0}
              >
                <div className="designer-code-head">
                  <label htmlFor="designer-format">Format</label>
                  <select
                    id="designer-format"
                    value={format}
                    onChange={(event) =>
                      changeFormat(event.target.value as ConfigurationFormat)
                    }
                  >
                    <option value="yaml">YAML</option>
                    <option value="json">JSON</option>
                    <option value="toml">TOML</option>
                  </select>
                  <span>
                    {byteLength(code).toLocaleString()} / 1,048,576 bytes
                  </span>
                </div>
                <ConfigurationCodeEditor
                  value={code}
                  format={format}
                  onChange={setCode}
                  diagnostics={sourceDiagnosis.diagnostics}
                  label="Vector configuration code"
                />
                <div className="designer-code-foot">
                  <span>
                    {sourceDiagnosis.diagnostics.filter(
                      (item) => item.severity === "error",
                    ).length ? (
                      <>
                        <CircleAlert size={15} />
                        Local errors found
                      </>
                    ) : (
                      "Local structural checks only. Vector validates on your host."
                    )}
                  </span>
                  <div>
                    <button
                      type="button"
                      disabled={!codeDirty}
                      onClick={discardCodeEdits}
                    >
                      Discard edits
                    </button>
                    <button
                      type="button"
                      className="designer-apply"
                      disabled={
                        !codeDirty ||
                        !sourceDiagnosis.config ||
                        byteLength(code) > MAX_CONFIGURATION_BYTES
                      }
                      onClick={applyCode}
                    >
                      Apply code
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
      <div className="designer-status" role="status" aria-live="polite">
        <span>
          {notice || "No configuration is uploaded or automatically saved."}
        </span>
        <span>
          {graphOmitted
            ? "Local checks skipped"
            : issueCount
              ? `${issueCount} local ${issueCount === 1 ? "error" : "errors"}`
              : "Local structure only"}
        </span>
      </div>

      <dialog
        ref={importDialog}
        className="designer-dialog"
        onClose={() => setImportOpen(false)}
        aria-labelledby="designer-import-title"
      >
        <div className="designer-dialog-head">
          <div>
            <small>Bring your own file</small>
            <h2 id="designer-import-title">Import a configuration</h2>
          </div>
          <button
            type="button"
            className="designer-dialog-close"
            onClick={() => setImportOpen(false)}
            aria-label="Close import"
          >
            <X size={20} />
          </button>
        </div>
        <p>
          Choose a .yaml, .yml, .json, or .toml file, or paste code below. The
          file stays in this browser tab.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,.json,.toml"
          className="designer-hidden-file"
          onChange={(event) => {
            void readFile(event.target.files?.[0]);
          }}
        />
        <button
          type="button"
          className="designer-file-choice"
          onClick={() => fileInput.current?.click()}
        >
          <ArrowDownToLine size={17} />
          Choose a local file <span>Maximum 1 MiB</span>
        </button>
        <div className="designer-import-row">
          <label htmlFor="designer-import-format">Format</label>
          <select
            id="designer-import-format"
            value={importFormat}
            onChange={(event) =>
              setImportFormat(event.target.value as ConfigurationFormat)
            }
          >
            <option value="yaml">YAML</option>
            <option value="json">JSON</option>
            <option value="toml">TOML</option>
          </select>
        </div>
        <label className="designer-import-label" htmlFor="designer-import-code">
          Configuration code
        </label>
        <textarea
          id="designer-import-code"
          value={importText}
          onChange={(event) => {
            setImportText(event.target.value);
            setImportError("");
            if (!importName.includes("."))
              setImportFormat(guessConfigurationFormat(event.target.value));
          }}
          placeholder="sources:\n  my_source:\n    type: demo_logs"
          spellCheck={false}
        />
        {importError && (
          <p className="designer-import-error" role="alert">
            {importError}
          </p>
        )}
        <div className="designer-dialog-actions">
          <button type="button" onClick={() => setImportOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="designer-apply"
            disabled={!importText.trim()}
            onClick={() => {
              if (confirmReplacement())
                load(importText, importFormat, importName);
            }}
          >
            Visualize configuration
          </button>
        </div>
      </dialog>

      <dialog
        ref={addDialog}
        className="designer-dialog designer-add-dialog"
        onClose={() => setAddOpen(false)}
        aria-labelledby="designer-add-title"
      >
        <div className="designer-dialog-head">
          <div>
            <small>Build the event flow</small>
            <h2 id="designer-add-title">Add a component</h2>
          </div>
          <button
            type="button"
            className="designer-dialog-close"
            onClick={() => setAddOpen(false)}
            aria-label="Close component picker"
          >
            <X size={20} />
          </button>
        </div>
        <p>
          Choose a Vector component, then connect its handles on the canvas.
        </p>
        <div
          className="designer-kind-tabs"
          role="group"
          aria-label="Component category"
        >
          {kinds.map((kind) => (
            <button
              type="button"
              aria-pressed={addKind === kind}
              key={kind}
              onClick={() => setAddKind(kind)}
            >
              {kindNames[kind]}
            </button>
          ))}
        </div>
        <label className="designer-search">
          <Search size={17} />
          <input
            type="search"
            value={addQuery}
            onChange={(event) => setAddQuery(event.target.value)}
            placeholder="Search components"
            aria-label="Search components"
          />
        </label>
        <div className="designer-component-list">
          {additions.length ? (
            additions.map((item) => (
              <button
                type="button"
                key={`${item.kind}:${item.type}`}
                onClick={() => addComponent(item)}
              >
                <span>
                  <strong>{item.label}</strong>
                  <code>{item.type}</code>
                </span>
                <small>{item.description}</small>
              </button>
            ))
          ) : (
            <p>No matching components in this category.</p>
          )}
        </div>
      </dialog>
    </section>
  );
}

createRoot(document.getElementById("designer-app")!).render(<Designer />);
