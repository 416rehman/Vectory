import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeProps,
  type NodeChange,
  type Connection,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Database,
  ExternalLink,
  FileClock,
  GitBranch,
  GitCompareArrows,
  History,
  LayoutGrid,
  Maximize2,
  MoreHorizontal,
  Plus,
  Redo2,
  Rocket,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Undo2,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import YAML from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  api,
  can,
  download,
  post,
  put,
  when,
  type Config,
  type Configuration,
  type Graph,
  type User,
  type Version,
} from "./api";
import {
  catalog,
  connect,
  getPath,
  setPath,
  starter,
  toGraph,
  validateGraph,
  outputPorts,
  type Component,
  type Kind,
} from "./catalog";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  Modal,
  PageHeader,
  SearchBox,
  Spinner,
  useResource,
} from "./ui";
import TargetDialog from "./TargetDialog";
import SyntheticTester from "./SyntheticTester";

const kindLabel = { sources: "Source", transforms: "Transform", sinks: "Sink" };
const kindIcon = {
  sources: Database,
  transforms: GitBranch,
  sinks: ArrowDownToLine,
};
function ComponentNode({ data, selected }: NodeProps) {
  const kind = data.kind as Kind;
  const component = data.component as Config;
  const Icon = kindIcon[kind];
  const outputs = outputPorts(component);
  return (
    <div
      className={`pipeline-node ${kind} ${selected ? "selected" : ""} ${data.disconnected ? "disconnected" : ""}`}
    >
      {kind !== "sources" && (
        <Handle type="target" position={Position.Left} id="input" />
      )}
      <div className="node-topline">
        <span>{kindLabel[kind]}</span>
        <span className="node-type">{component.type}</span>
      </div>
      <div className="node-name">
        <span className="node-symbol">
          <Icon size={19} />
        </span>
        <strong>{String(data.label)}</strong>
      </div>
      <div className="node-foot">
        {data.disconnected
          ? "Disconnected · connect a port"
          : catalog.find((c) => c.type === component.type && c.kind === kind)
              ?.label || "Opaque component · preserved"}
        <MoreHorizontal size={15} />
      </div>
      {kind !== "sinks" &&
        outputs.map((output, i) => (
          <Handle
            key={output}
            type="source"
            position={Position.Right}
            id={output}
            style={{ top: `${((i + 1) * 100) / (outputs.length + 1)}%` }}
            title={output}
          />
        ))}
    </div>
  );
}
const nodeTypes = { component: ComponentNode };

export function Configurations({
  user,
  notify,
  navigate,
}: {
  user: User;
  notify: (m: string) => void;
  navigate: (p: string) => void;
}) {
  const { data, loading, error, reload } = useResource<Configuration[]>(
    "/configurations",
    [],
  );
  const [search, setSearch] = useState(""),
    [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [template, setTemplate] = useState("starter"),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const config =
        template === "starter"
          ? structuredClone(starter)
          : { sources: {}, transforms: {}, sinks: {} };
      const result = await post<Configuration>("/configurations", {
        name,
        description,
        config,
        graph: toGraph(config),
      });
      setOpen(false);
      notify("Configuration created. Your draft is ready.");
      navigate(`configurations/${result.id}`);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = data.filter((c) =>
    (c.name + " " + c.description).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="BUILD & MANAGE"
        title="Configurations"
        description="Build your pipelines once. Run them across your infrastructure."
      >
        {can(user, "edit") && (
          <Button icon={Plus} onClick={() => setOpen(true)}>
            New configuration
          </Button>
        )}
      </PageHeader>
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search configurations…"
        />
        <span className="muted">{data.length} configurations</span>
      </div>
      {loading ? (
        <div className="loading">
          <Spinner />
          Loading configurations
        </div>
      ) : filtered.length ? (
        <div className="config-grid">
          {filtered.map((c) => (
            <button
              key={c.id}
              className="config-card"
              onClick={() => navigate(`configurations/${c.id}`)}
            >
              <div className="config-card-top">
                <span className="square-icon">
                  <Workflow size={22} />
                </span>
                <Badge status="neutral">Draft r{c.revision}</Badge>
              </div>
              <h3>{c.name}</h3>
              <p>
                {c.description || "A Vector pipeline, ready to make your own."}
              </p>
              <div className="mini-pipeline">
                <span>
                  <Database size={15} />
                  {Object.keys(c.config.sources || {}).length}
                </span>
                <i />
                <span>
                  <GitBranch size={15} />
                  {Object.keys(c.config.transforms || {}).length}
                </span>
                <i />
                <span>
                  <ArrowDownToLine size={15} />
                  {Object.keys(c.config.sinks || {}).length}
                </span>
              </div>
              <div className="config-card-footer">
                <span>Updated {when(c.updated_at)}</span>
                <ArrowRight size={17} />
              </div>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          icon={Workflow}
          title={
            search ? "No matching configurations" : "Good pipelines start here"
          }
          action={
            can(user, "edit") ? (
              <Button icon={Plus} onClick={() => setOpen(true)}>
                Create your first pipeline
              </Button>
            ) : undefined
          }
        >
          {search
            ? "Try another name or clear your search."
            : "Start with a safe synthetic pipeline, or bring an existing Vector configuration. Your drafts stay separate from deployed versions."}
        </Empty>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create a configuration"
        description="Give your pipeline a home. You can connect it to devices after publishing."
      >
        <form onSubmit={create}>
          <div className="modal-body">
            {formError && <ErrorBox message={formError} />}
            <Field label="Configuration name">
              <input
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Application logs"
                autoFocus
              />
            </Field>
            <Field label="Description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this pipeline do?"
                rows={2}
              />
            </Field>
            <Field label="Start from">
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
              >
                <option value="starter">
                  Synthetic logs → enrich → console
                </option>
                <option value="empty">An empty canvas</option>
              </select>
            </Field>
            <div className="hint-box">
              <ShieldCheck size={18} />
              <span>
                The starter uses synthetic events. It reads no application files
                and sends no data to external services.
              </span>
            </div>
          </div>
          <div className="modal-footer">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button busy={busy} type="submit" icon={Plus}>
              Create configuration
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export default function Editor({
  id,
  user,
  notify,
  navigate,
}: {
  id: string;
  user: User;
  notify: (m: string) => void;
  navigate: (p: string) => void;
}) {
  const [doc, setDoc] = useState<Configuration | null>(null),
    [config, setConfig] = useState<Config>({}),
    [nodes, setNodes] = useState<any[]>([]),
    [edges, setEdges] = useState<Edge[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [view, setView] = useState("canvas"),
    [format, setFormat] = useState("yaml"),
    [code, setCode] = useState(""),
    [paletteSearch, setPaletteSearch] = useState(""),
    [dirty, setDirty] = useState(false),
    [saveStatus, setSaveStatus] = useState("All changes saved"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [validation, setValidation] = useState<any>(null),
    [historyOpen, setHistoryOpen] = useState(false),
    [versions, setVersions] = useState<Version[]>([]),
    [revisions, setRevisions] = useState<any[]>([]),
    [compare, setCompare] = useState<[Version, Version] | null>(null),
    [deployVersion, setDeployVersion] = useState<Version | null>(null),
    [publishOpen, setPublishOpen] = useState(false),
    [message, setMessage] = useState(""),
    [inspectorRaw, setInspectorRaw] = useState(""),
    [keyboardSource, setKeyboardSource] = useState(""),
    [keyboardTarget, setKeyboardTarget] = useState("");
  const stack = useRef<{ config: Config; graph: Graph }[]>([]),
    future = useRef<{ config: Config; graph: Graph }[]>([]),
    latest = useRef({ doc, config, nodes, edges, dirty }),
    pendingSave = useRef<Promise<Configuration | null> | null>(null),
    fileRef = useRef<HTMLInputElement>(null),
    flow = useRef<any>(null),
    importedCodeDirty = useRef(false);
  latest.current = { doc, config, nodes, edges, dirty };
  const editable = can(user, "edit");
  const errors = validateGraph(config);
  useEffect(() => {
    let alive = true;
    api<Configuration>(`/configurations/${id}`)
      .then((result) => {
        if (!alive) return;
        const graph = toGraph(result.config, result.graph);
        setDoc(result);
        setConfig(result.config);
        setNodes(graph.nodes);
        setEdges(graph.edges);
        setDirty(false);
        setError("");
      })
      .catch((e) => setError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty || importedCodeDirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    const navigate = (event: Event) => {
      if (
        (dirty || importedCodeDirty.current) &&
        !confirm("Leave this editor? Unsaved changes may be lost.")
      )
        event.preventDefault();
    };
    window.addEventListener("vectory:before-navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("vectory:before-navigate", navigate);
    };
  }, [dirty]);
  const persist = useCallback(
    async function saveDraft(explicit = false): Promise<Configuration | null> {
      if (pendingSave.current) {
        const active = pendingSave.current;
        const saved = await active;
        if (pendingSave.current === active) pendingSave.current = null;
        if (!saved) return null;
        return latest.current.dirty ? saveDraft(explicit) : latest.current.doc;
      }
      const current = latest.current;
      if (!current.doc || !editable) return current.doc;
      const revision = current.doc.revision;
      setSaveStatus("Saving…");
      const operation = (async () => {
        try {
          const updated = await put<Configuration>(
            `/configurations/${id}/draft`,
            {
              revision,
              graph: { nodes: current.nodes, edges: current.edges },
              config: current.config,
              message: explicit
                ? "Saved from pipeline editor"
                : "Draft autosave",
            },
          );
          setDoc(updated);
          latest.current.doc = updated;
          const stillSame =
            latest.current.config === current.config &&
            latest.current.nodes === current.nodes &&
            latest.current.edges === current.edges;
          if (stillSame) {
            setDirty(false);
            latest.current.dirty = false;
          }
          setSaveStatus(stillSame ? "All changes saved" : "Unsaved changes");
          if (explicit) notify("Draft revision saved.");
          return updated;
        } catch (e) {
          setError((e as Error).message);
          setSaveStatus("Save failed — your edits are still here");
          return null;
        }
      })();
      pendingSave.current = operation;
      try {
        return await operation;
      } finally {
        if (pendingSave.current === operation) pendingSave.current = null;
      }
    },
    [editable, id, notify],
  );
  useEffect(() => {
    if (!dirty || !editable || saveStatus.startsWith("Save failed")) return;
    const timer = setTimeout(() => void persist(), 2000);
    return () => clearTimeout(timer);
  }, [config, nodes, edges, dirty, editable, persist, saveStatus]);
  function replace(next: Config, graph?: Graph, remember = true) {
    if (!editable) return;
    if (remember) {
      stack.current.push({
        config: structuredClone(config),
        graph: { nodes: structuredClone(nodes), edges: structuredClone(edges) },
      });
      if (stack.current.length > 50) stack.current.shift();
      future.current = [];
    }
    const nextGraph = toGraph(next, graph || { nodes, edges });
    setConfig(next);
    setNodes(nextGraph.nodes);
    setEdges(nextGraph.edges);
    setDirty(true);
    setSaveStatus("Unsaved changes");
    setValidation(null);
  }
  function undo(redo = false) {
    const from = redo ? future.current : stack.current,
      to = redo ? stack.current : future.current;
    const item = from.pop();
    if (item) {
      to.push({
        config: structuredClone(config),
        graph: { nodes: structuredClone(nodes), edges: structuredClone(edges) },
      });
      replace(item.config, item.graph, false);
    }
  }
  function add(item: Component) {
    let name = item.type,
      n = 1;
    while (nodes.some((v) => v.id === name)) name = `${item.type}_${++n}`;
    const next = structuredClone(config);
    next[item.kind] ??= {};
    next[item.kind][name] = {
      type: item.type,
      ...structuredClone(item.defaults),
      ...(item.kind === "sources" ? {} : { inputs: [] }),
    };
    replace(next);
    setSelected(name);
    notify(`${item.label} added. Connect it to your pipeline.`);
  }
  function onConnect(connection: Connection) {
    try {
      replace(
        connect(
          config,
          connection.source,
          connection.target,
          connection.sourceHandle || "output",
        ),
      );
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function remove(ids: string[]) {
    const next = structuredClone(config);
    for (const kind of ["sources", "transforms", "sinks"])
      for (const [key, value] of Object.entries(next[kind] || {}) as [
        string,
        Config,
      ][]) {
        if (ids.includes(key)) delete next[kind][key];
        else if (Array.isArray(value?.inputs))
          value.inputs = value.inputs.filter(
            (input: unknown) =>
              typeof input !== "string" || !ids.includes(input.split(".")[0]),
          );
      }
    replace(next);
    if (selected && ids.includes(selected)) setSelected(null);
  }
  function duplicate() {
    if (!selected) return;
    const node = nodes.find((n) => n.id === selected);
    if (!node) return;
    const next = structuredClone(config);
    let name = selected + "_copy",
      i = 1;
    while (nodes.some((n) => n.id === name)) name = selected + "_copy" + i++;
    next[node.data.kind][name] = structuredClone(
      next[node.data.kind][selected],
    );
    replace(next);
    setSelected(name);
  }
  function changeNodes(changes: NodeChange[]) {
    const removals = changes
      .filter((c) => c.type === "remove")
      .map((c) => c.id);
    if (removals.length) {
      remove(removals);
      return;
    }
    setNodes((prev) => applyNodeChanges(changes, prev));
    if (changes.some((c) => c.type === "position" && c.dragging === false)) {
      setDirty(true);
      setSaveStatus("Unsaved changes");
    }
  }
  function removeEdges(removed: Edge[]) {
    const next = structuredClone(config);
    for (const edge of removed) {
      for (const kind of ["transforms", "sinks"])
        if (next[kind]?.[edge.target])
          next[kind][edge.target].inputs = (
            next[kind][edge.target].inputs || []
          ).filter(
            (input: string) =>
              input !==
              (edge.sourceHandle && edge.sourceHandle !== "output"
                ? `${edge.source}.${edge.sourceHandle}`
                : edge.source),
          );
    }
    replace(next);
  }
  function stringify(value: Config, f = format) {
    return f === "json"
      ? JSON.stringify(value, null, 2)
      : f === "toml"
        ? stringifyToml(value)
        : YAML.stringify(value);
  }
  function parse(value: string, f = format): Config {
    const result =
      f === "json"
        ? JSON.parse(value)
        : f === "toml"
          ? parseToml(value)
          : YAML.parse(value, { maxAliasCount: 50, uniqueKeys: true });
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw Error("The configuration must be an object.");
    return result;
  }
  function changeView(next: string) {
    if (next === "canvas" && importedCodeDirty.current) {
      try {
        replace(parse(code));
        importedCodeDirty.current = false;
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    if (next === "code") setCode(stringify(config));
    setView(next);
  }
  async function importFile(file: File) {
    if (file.size > 1048576) {
      setError("Configuration files must be under 1 MiB.");
      return;
    }
    try {
      const text = await file.text();
      const f = file.name.endsWith(".json")
        ? "json"
        : file.name.endsWith(".toml")
          ? "toml"
          : "yaml";
      replace(parse(text, f));
      setCode(text);
      setFormat(f);
      setView("code");
      importedCodeDirty.current = false;
      notify(
        "Imported. Unknown fields are preserved; formatting and comments are normalized on export.",
      );
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`);
    }
  }
  async function validate() {
    setBusy(true);
    setError("");
    try {
      const current = view === "code" ? parse(code) : config;
      if (view === "code") {
        replace(current);
        importedCodeDirty.current = false;
      }
      const result = await post(`/configurations/${id}/validate`, {
        config: current,
      });
      setValidation(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    setBusy(true);
    setError("");
    try {
      if (view === "code" && importedCodeDirty.current)
        throw Error("Apply your code changes before publishing.");
      let saved = latest.current.doc;
      while (latest.current.dirty || pendingSave.current) {
        saved = await persist();
        if (!saved) break;
      }
      if (!saved) throw Error("Save your draft before publishing.");
      const version = await post<Version>(`/configurations/${id}/publish`, {
        revision: saved.revision,
        message,
      });
      setPublishOpen(false);
      notify(`Version ${version.number} published. It is ready to deploy.`);
      setDeployVersion(version);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function openHistory() {
    setBusy(true);
    try {
      const result = await Promise.all([
        api<Version[]>(`/configurations/${id}/versions`),
        api<any[]>(`/configurations/${id}/revisions`),
      ]);
      setVersions(result[0]);
      setRevisions(result[1]);
      setHistoryOpen(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selectedNode = nodes.find((n) => n.id === selected);
  const component = selectedNode
    ? config[selectedNode.data.kind]?.[selectedNode.id]
    : null;
  const definition = component
    ? catalog.find(
        (c) => c.type === component.type && c.kind === selectedNode.data.kind,
      )
    : null;
  useEffect(() => {
    setInspectorRaw(component ? JSON.stringify(component, null, 2) : "");
  }, [selected, component]);
  function changeComponent(value: Config) {
    const next = structuredClone(config);
    next[selectedNode.data.kind][selectedNode.id] = value;
    replace(next);
  }
  async function reloadLatest() {
    if (
      !confirm(
        "Reload the server draft and discard local edits? Export your edits first if you want to keep them.",
      )
    )
      return;
    try {
      const result = await api<Configuration>(`/configurations/${id}`);
      const graph = toGraph(result.config, result.graph);
      setDoc(result);
      setConfig(result.config);
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setCode(stringify(result.config));
      setDirty(false);
      importedCodeDirty.current = false;
      stack.current = [];
      future.current = [];
      setSaveStatus("All changes saved");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!doc)
    return (
      <>
        {error ? (
          <ErrorBox message={error} />
        ) : (
          <div className="loading">
            <Spinner />
            Opening your pipeline…
          </div>
        )}
      </>
    );
  return (
    <div className="editor-page">
      <div className="editor-heading">
        <div className="editor-heading-left">
          <IconButton
            icon={ArrowLeft}
            label="Back to configurations"
            onClick={() => navigate("configurations")}
          />
          <div>
            <h1>
              {doc.name}
              <Badge status="neutral">Draft</Badge>
            </h1>
            <p>
              <span className={dirty ? "save-dot pending" : "save-dot"} />
              <span aria-live="polite">{saveStatus}</span>
              <span className="dot-separator">·</span>Revision {doc.revision}
            </p>
          </div>
        </div>
        <div className="page-actions">
          <Button variant="secondary" icon={History} onClick={openHistory}>
            History
          </Button>
          {editable && (
            <Button
              variant="secondary"
              icon={Save}
              onClick={() => void persist(true)}
            >
              Save draft
            </Button>
          )}
          {can(user, "operate") && (
            <Button icon={Rocket} onClick={() => setPublishOpen(true)}>
              Publish version
            </Button>
          )}
        </div>
      </div>
      {error && (
        <div className="editor-message">
          <ErrorBox message={error} />
          {saveStatus.startsWith("Save failed") && (
            <Button variant="secondary compact" onClick={reloadLatest}>
              Reload server draft
            </Button>
          )}
          <IconButton
            icon={X}
            label="Dismiss error"
            onClick={() => setError("")}
          />
        </div>
      )}
      <div className="editor-toolbar">
        <div className="segmented">
          <button
            className={view === "canvas" ? "selected" : ""}
            onClick={() => changeView("canvas")}
          >
            <Workflow size={15} />
            Visual editor
          </button>
          <button
            className={view === "code" ? "selected" : ""}
            onClick={() => changeView("code")}
          >
            <Code2 size={15} />
            Code
          </button>
        </div>
        <div className="editor-tools">
          <span className="muted">Vector 0.58.0</span>
          <span className="toolbar-divider" />
          <IconButton
            icon={Undo2}
            label="Undo"
            disabled={!editable || !stack.current.length}
            onClick={() => undo()}
          />
          <IconButton
            icon={Redo2}
            label="Redo"
            disabled={!editable || !future.current.length}
            onClick={() => undo(true)}
          />
          <IconButton
            icon={LayoutGrid}
            label="Auto-layout pipeline"
            disabled={!editable}
            onClick={() => {
              const graph = toGraph(config);
              replace(config, graph);
              setTimeout(() => flow.current?.fitView({ padding: 0.25 }), 20);
            }}
          />
          <IconButton
            icon={Maximize2}
            label="Fit pipeline"
            onClick={() => flow.current?.fitView({ padding: 0.25 })}
          />
          <span className="toolbar-divider" />
          {editable && (
            <Button
              variant="ghost compact"
              icon={Upload}
              onClick={() => fileRef.current?.click()}
            >
              Import
            </Button>
          )}
          <Button
            variant="ghost compact"
            icon={ArrowDownToLine}
            onClick={() =>
              download(
                `${doc.name.replace(/[^a-z0-9_-]/gi, "_")}.${format}`,
                stringify(config),
              )
            }
          >
            Export
          </Button>
          {editable && (
            <Button
              variant="secondary compact"
              busy={busy}
              icon={ShieldCheck}
              onClick={validate}
            >
              Validate
            </Button>
          )}
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".json,.yaml,.yml,.toml"
            onChange={(e) => {
              if (e.target.files?.[0]) void importFile(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <div className="editor-workspace">
        {view === "canvas" && (
          <aside className="component-palette">
            <div className="palette-heading">
              <h3>Components</h3>
              <span>{catalog.length}</span>
            </div>
            <div className="palette-search">
              <Search size={14} />
              <input
                aria-label="Search components"
                placeholder="Find a component…"
                value={paletteSearch}
                onChange={(e) => setPaletteSearch(e.target.value)}
              />
            </div>
            {(["sources", "transforms", "sinks"] as Kind[]).map((kind) => (
              <div key={kind} className="palette-section">
                <h4>{kind}</h4>
                {catalog
                  .filter(
                    (c) =>
                      c.kind === kind &&
                      (c.label + " " + c.type)
                        .toLowerCase()
                        .includes(paletteSearch.toLowerCase()),
                  )
                  .map((item) => {
                    const Icon = kindIcon[kind];
                    return (
                      <button
                        key={item.type}
                        draggable={editable}
                        disabled={!editable}
                        onDragStart={(e) =>
                          e.dataTransfer.setData(
                            "application/vectory-component",
                            `${kind}/${item.type}`,
                          )
                        }
                        onClick={() => add(item)}
                        className={`palette-component ${kind}`}
                        title={item.description}
                      >
                        <span>
                          <Icon size={15} />
                        </span>
                        {item.label}
                        <Plus size={13} />
                      </button>
                    );
                  })}
              </div>
            ))}
            <div className="palette-help">
              <span className="keyboard-key">↵</span> Click or drag to add
              <br />
              Select a node to configure it.
            </div>
          </aside>
        )}
        {view === "canvas" ? (
          <div
            className="canvas"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const [kind, type] = e.dataTransfer
                .getData("application/vectory-component")
                .split("/");
              const item = catalog.find(
                (c) => c.kind === kind && c.type === type,
              );
              if (item) add(item);
            }}
          >
            <div className="canvas-label">
              <span className="live-dot" />
              PIPELINE CANVAS<span>Connect. Transform. Deliver.</span>
            </div>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={(instance) => {
                flow.current = instance;
              }}
              onNodesChange={editable ? changeNodes : undefined}
              onEdgesDelete={editable ? removeEdges : undefined}
              onEdgesChange={(changes) =>
                setEdges((prev) =>
                  applyEdgeChanges(
                    changes.filter((c) => c.type !== "remove"),
                    prev,
                  ),
                )
              }
              onConnect={editable ? onConnect : undefined}
              onNodeClick={(_, node) => setSelected(node.id)}
              onPaneClick={() => setSelected(null)}
              nodesDraggable={editable}
              nodesConnectable={editable}
              deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
              fitView
              fitViewOptions={{ padding: 0.1 }}
              minZoom={0.2}
              maxZoom={2}
              defaultEdgeOptions={{
                type: "smoothstep",
                style: { stroke: "#95a69b", strokeWidth: 2 },
              }}
            >
              <Background color="#d4ddd7" gap={22} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(n) =>
                  n.data.kind === "sources"
                    ? "#7dafd8"
                    : n.data.kind === "transforms"
                      ? "#a99bd8"
                      : "#81b399"
                }
                maskColor="rgba(238,243,240,.65)"
              />
            </ReactFlow>
            {!nodes.length && (
              <div className="canvas-empty">
                <Workflow size={35} />
                <h3>Your pipeline starts with a source</h3>
                <p>Choose a component on the left to begin.</p>
              </div>
            )}
            <div className="canvas-status">
              <span>{nodes.length} components</span>
              <span>{edges.length} connections</span>
              <span>
                {errors.length
                  ? `${errors.length} checks need attention`
                  : "Graph connections valid"}
              </span>
            </div>
          </div>
        ) : (
          <div className="code-editor">
            <div className="code-heading">
              <span>
                <Braces size={16} /> Canonical Vector configuration
              </span>
              <select
                aria-label="Configuration format"
                value={format}
                onChange={(e) => {
                  try {
                    const current = importedCodeDirty.current
                      ? parse(code)
                      : config;
                    setCode(stringify(current, e.target.value));
                    setFormat(e.target.value);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <option value="yaml">YAML</option>
                <option value="toml">TOML</option>
                <option value="json">JSON</option>
              </select>
            </div>
            <textarea
              aria-label="Vector configuration code"
              spellCheck={false}
              readOnly={!editable}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                importedCodeDirty.current = true;
              }}
            />
            <div className="code-footer">
              <small>
                Unknown fields are preserved. Comments and formatting are
                normalized.
              </small>
              {editable && (
                <Button
                  variant="secondary"
                  icon={Check}
                  onClick={() => {
                    try {
                      replace(parse(code));
                      importedCodeDirty.current = false;
                      notify("Code applied to the visual model.");
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Apply code changes
                </Button>
              )}
            </div>
          </div>
        )}
        <aside className="properties">
          <div className="properties-title">
            <Settings2 size={16} />
            <h3>
              {selectedNode ? "Component properties" : "Pipeline details"}
            </h3>
            {selected && (
              <IconButton
                icon={X}
                label="Close inspector"
                onClick={() => setSelected(null)}
              />
            )}
          </div>
          {component && selectedNode ? (
            <div className="properties-body">
              <div
                className={`component-inspector-symbol ${selectedNode.data.kind}`}
              >
                {(() => {
                  const Icon = kindIcon[selectedNode.data.kind as Kind];
                  return <Icon size={23} />;
                })()}
              </div>
              <h3>{selectedNode.id}</h3>
              <p className="muted">
                {definition?.description ||
                  "This component uses the raw editor. Its fields are preserved."}
              </p>
              <Field label="Component ID">
                <input value={selectedNode.id} readOnly />
              </Field>
              {definition?.fields.map((field) => (
                <Field
                  key={field.key}
                  label={field.label + (field.required ? " *" : "")}
                >
                  {field.type === "vrl" ? (
                    <textarea
                      spellCheck={false}
                      className="vrl-editor"
                      rows={6}
                      readOnly={!editable}
                      value={getPath(component, field.key) || ""}
                      onChange={(e) =>
                        changeComponent(
                          setPath(component, field.key, e.target.value),
                        )
                      }
                    />
                  ) : field.type === "array" ? (
                    <textarea
                      rows={3}
                      readOnly={!editable}
                      value={
                        Array.isArray(getPath(component, field.key))
                          ? getPath(component, field.key).join("\n")
                          : String(getPath(component, field.key) ?? "")
                      }
                      onChange={(e) =>
                        changeComponent(
                          setPath(
                            component,
                            field.key,
                            e.target.value.split("\n").filter(Boolean),
                          ),
                        )
                      }
                    />
                  ) : (
                    <input
                      type={field.type === "number" ? "number" : "text"}
                      readOnly={!editable}
                      value={getPath(component, field.key) ?? ""}
                      onChange={(e) =>
                        changeComponent(
                          setPath(
                            component,
                            field.key,
                            field.type === "number"
                              ? Number(e.target.value)
                              : e.target.value,
                          ),
                        )
                      }
                    />
                  )}
                </Field>
              ))}
              {editable && component.type === "remap" && (
                <SyntheticTester program={component.source || ""} />
              )}
              <details className="raw-properties">
                <summary>All component fields (JSON)</summary>
                <textarea
                  aria-label="Raw component properties"
                  spellCheck={false}
                  readOnly={!editable}
                  rows={10}
                  value={inspectorRaw}
                  onChange={(e) => setInspectorRaw(e.target.value)}
                />
                {editable && (
                  <Button
                    variant="secondary compact"
                    onClick={() => {
                      try {
                        const parsed = JSON.parse(inspectorRaw);
                        if (
                          !parsed ||
                          typeof parsed !== "object" ||
                          typeof parsed.type !== "string"
                        )
                          throw Error(
                            "A component object with a type is required.",
                          );
                        changeComponent(parsed);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Apply fields
                  </Button>
                )}
              </details>
              <a
                className="text-link"
                target="_blank"
                rel="noreferrer"
                href={`https://vector.dev/docs/reference/configuration/${selectedNode.data.kind}/${component.type}/`}
              >
                Component documentation
                <ExternalLink size={13} />
              </a>
              {editable && (
                <div className="inspector-actions">
                  <Button variant="secondary" icon={Copy} onClick={duplicate}>
                    Duplicate
                  </Button>
                  <Button
                    variant="danger-ghost"
                    icon={Trash2}
                    onClick={() => remove([selectedNode.id])}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="properties-body">
              <div className="pipeline-info-symbol">
                <Workflow size={26} />
              </div>
              <h3>A clear path for your data</h3>
              <p className="muted">
                Select a component to edit its properties, or connect handles to
                define where events flow.
              </p>
              <dl className="detail-list">
                <div>
                  <dt>Sources</dt>
                  <dd>{Object.keys(config.sources || {}).length}</dd>
                </div>
                <div>
                  <dt>Transforms</dt>
                  <dd>{Object.keys(config.transforms || {}).length}</dd>
                </div>
                <div>
                  <dt>Sinks</dt>
                  <dd>{Object.keys(config.sinks || {}).length}</dd>
                </div>
                <div>
                  <dt>Compatibility</dt>
                  <dd>Vector 0.58.0</dd>
                </div>
              </dl>
              <div className="hint-box vertical">
                <ShieldCheck size={18} />
                <strong>Your live pipeline stays safe</strong>
                <p>
                  Draft edits never affect devices. Publish an immutable
                  version, then explicitly deploy it.
                </p>
              </div>
              <h4>Keyboard connection</h4>
              <Field label="From">
                <select
                  value={keyboardSource}
                  onChange={(e) => setKeyboardSource(e.target.value)}
                >
                  <option value="">Select output</option>
                  {nodes
                    .filter((n) => n.data.kind !== "sinks")
                    .flatMap((n) =>
                      outputPorts(n.data.component).map((out) => (
                        <option
                          key={`${n.id}.${out}`}
                          value={out === "output" ? n.id : `${n.id}.${out}`}
                        >
                          {out === "output" ? n.id : `${n.id}.${out}`}
                        </option>
                      )),
                    )}
                </select>
              </Field>
              <Field label="To">
                <select
                  value={keyboardTarget}
                  onChange={(e) => setKeyboardTarget(e.target.value)}
                >
                  <option value="">Select input</option>
                  {nodes
                    .filter((n) => n.data.kind !== "sources")
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.id}
                      </option>
                    ))}
                </select>
              </Field>
              <Button
                variant="secondary"
                disabled={!keyboardSource || !keyboardTarget || !editable}
                icon={Plus}
                onClick={() => {
                  const [source, handle] = keyboardSource.split(".");
                  onConnect({
                    source,
                    target: keyboardTarget,
                    sourceHandle: handle || "output",
                    targetHandle: "input",
                  });
                }}
              >
                Connect components
              </Button>
            </div>
          )}
        </aside>
      </div>
      {(validation || errors.length > 0) && (
        <div className="validation-panel">
          <div>
            <ShieldCheck size={17} />
            <strong>
              {validation
                ? validation.valid
                  ? "Structural checks passed"
                  : "Validation needs attention"
                : "Graph checks"}
            </strong>
            <Badge status={validation?.valid ? "valid" : "warning"}>
              {validation?.valid
                ? "Reviewed"
                : `${(validation?.errors || errors).length} issues`}
            </Badge>
          </div>
          {(validation?.errors || errors).map((e: string, i: number) => (
            <p key={i}>{e}</p>
          ))}
          {validation?.warnings?.map((w: string, i: number) => (
            <p className="validation-warning" key={i}>
              {w}
            </p>
          ))}
        </div>
      )}
      <Modal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title="Publish an immutable version"
        description="Publishing makes this draft available for deployment. Your devices will keep their current version."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <div className="hint-box">
            <FileClock size={20} />
            <span>
              The graph and configuration are saved together. Moving nodes will
              never change the runtime artifact hash.
            </span>
          </div>
          <Field label="What changed?">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Describe this version for your team"
              rows={3}
            />
          </Field>
          {errors.length > 0 && <ErrorBox message={errors.join(". ")} />}
          <p className="muted">
            The agent validates the exact artifact with its installed Vector
            binary before applying it. Server validation availability is
            included in the version record.
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setPublishOpen(false)}>
            Cancel
          </Button>
          <Button
            icon={Rocket}
            busy={busy}
            disabled={errors.length > 0}
            onClick={publish}
          >
            Publish version
          </Button>
        </div>
      </Modal>
      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="Version history"
        description="Published versions are immutable. Deploying an older version creates a new desired generation."
        wide
      >
        <div className="modal-body">
          <h3>Published versions</h3>
          {versions.length ? (
            versions.map((v, i) => (
              <div className="version-row" key={v.id}>
                <span className="version-number">v{v.number}</span>
                <div>
                  <strong>{v.message || "Published version"}</strong>
                  <small>
                    {when(v.created_at)} · {v.sha256.slice(0, 12)}
                  </small>
                </div>
                {i < versions.length - 1 && (
                  <Button
                    variant="ghost compact"
                    icon={GitCompareArrows}
                    onClick={() => setCompare([versions[i + 1], v])}
                  >
                    Compare
                  </Button>
                )}
                {can(user, "operate") && (
                  <Button
                    variant="secondary compact"
                    icon={Rocket}
                    onClick={() => {
                      setHistoryOpen(false);
                      setDeployVersion(v);
                    }}
                  >
                    Deploy
                  </Button>
                )}
              </div>
            ))
          ) : (
            <p className="muted">
              No published versions yet. Save and publish your first version.
            </p>
          )}
          <h3 className="section-space">Saved draft revisions</h3>
          {revisions.map((r) => (
            <div className="version-row" key={r.id || r.revision}>
              <span className="version-number">r{r.revision}</span>
              <div>
                <strong>{r.message || "Draft saved"}</strong>
                <small>
                  {when(r.created_at)} · {r.author || "Workspace member"}
                </small>
              </div>
              {editable && (
                <Button
                  variant="ghost compact"
                  onClick={() => {
                    replace(r.config, r.graph);
                    setHistoryOpen(false);
                    notify(
                      "Revision loaded into the draft. Published versions are unchanged.",
                    );
                  }}
                >
                  Restore draft
                </Button>
              )}
            </div>
          ))}
        </div>
      </Modal>
      <Modal
        open={!!compare}
        onClose={() => setCompare(null)}
        wide
        title="Compare versions"
        description="Semantic configuration comparison. Canvas coordinates are excluded."
      >
        {compare && (
          <div className="modal-body diff-grid">
            {compare.map((v, i) => (
              <div key={v.id}>
                <h3>
                  Version {v.number} {i === 0 ? "· before" : "· after"}
                </h3>
                <pre>
                  {YAML.stringify(v.config)
                    .split("\n")
                    .map((line, n) => {
                      const other = YAML.stringify(compare[1 - i].config).split(
                        "\n",
                      );
                      return (
                        <span
                          className={
                            !other.includes(line)
                              ? i === 0
                                ? "diff-removed"
                                : "diff-added"
                              : ""
                          }
                          key={n}
                        >
                          {!other.includes(line)
                            ? i === 0
                              ? "− "
                              : "+ "
                            : "  "}
                          {line}
                          {"\n"}
                        </span>
                      );
                    })}
                </pre>
              </div>
            ))}
          </div>
        )}
      </Modal>
      {deployVersion && (
        <TargetDialog
          open
          onClose={() => setDeployVersion(null)}
          version={deployVersion}
          onDone={notify}
        />
      )}
    </div>
  );
}
