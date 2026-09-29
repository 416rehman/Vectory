import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Panel,
  MiniMap,
  MarkerType,
  applyNodeChanges,
  applyEdgeChanges,
  type OnConnectEnd,
  type OnConnectStart,
  type OnReconnect,
  type NodeChange,
  type Connection,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ArchiveRestore,
  AlignLeft,
  ArrowLeft,
  Check,
  Database,
  LayoutGrid,
  X,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  Undo2,
  Redo2,
  Minus,
  Maximize,
  Workflow,
  Code2,
  Copy,
  WrapText,
  Upload,
  Download,
  FileText,
  FileCheck2,
  Server,
  History,
  Save,
  Trash2,
  Unplug,
  CircleHelp,
  Blocks,
  RotateCcw,
  RefreshCw,
  ChevronDown,
  MessageSquareText,
  Activity,
  Radio,
  ClipboardCopy,
} from "lucide-react";
import {
  api,
  APIError,
  PublishReceiptSchema,
  PublishRequestLookupSchema,
  withRequestDeadline,
  can,
  download,
  post,
  put,
  when,
  type Config,
  type Configuration,
  type Device,
  type Graph,
  type User,
  type Version,
  type VariableDeclaration,
} from "./api";
import {
  catalog,
  vectorSchema,
  toGraph,
  outputPorts,
  addConnectedComponent,
  sameConfiguration,
  removePipelineStep,
  type Component,
  type Kind,
} from "./catalog";
import { Button, IconButton, ErrorBox, Field, Modal, Spinner } from "./ui";
import TargetDialog from "./TargetDialog";

import PipelineSettings from "./PipelineSettings";
import PipelineGlobals from "./PipelineGlobals";
import PipelineDetails from "./PipelineDetails";
import PipelineSaveStatus from "./PipelineSaveStatus";
import { variableErrors } from "./variableFields";
import PipelineHistory from "./PipelineHistory";
import PublishRecovery, { type PublishRecoveryHandle } from "./PublishRecovery";
import PipelineCreationRecovery, {
  type PipelineCreationRecoveryHandle,
} from "./PipelineCreationRecovery";
import { usePipelineCreationOperations } from "./pipelineCreationRequests";
import {
  beginPublishOperation,
  finishPublishOperation,
  publishOperationAvailable,
  assertPublishReceipt,
  usePublishOperations,
  type PublishOperation,
} from "./publishRequests";
import PipelineActions, { type PipelineAction } from "./PipelineActions";
import PublishReview from "./PublishReview";
import { deviceReach, reachLabel } from "./publishReview";
import { pipelineConnectivity } from "./pipelineConnectivity";
import SelectedDevice, { pipelineRoute } from "./SelectedDevice";
import type {
  PipelineDestination,
  PipelineSection,
} from "./pipelineDestination";
import "./pipeline-library.css";
import {
  arrangeGraph,
  renameComponent,
  retargetReferences,
  componentName,
  reconnect,
  disconnect,
  canConnect,
  connectConnection,
  besidePosition,
  freePosition,
  placeBlock,
  primaryOutput,
  type BlockStep,
} from "./pipelineEditing";
import PipelineSchemaFields from "./PipelineSchemaFields";
import { resolveSchema } from "./pipelineSchema";
import DocLink, { HelpLink } from "./DocLink";
import { assertExactNumbers } from "./configurationNumbers";
import {
  hasSourceComments,
  stringifyConfiguration,
} from "./configurationFormats";
import {
  parseSource,
  diagnoseConfiguration,
  diagnoseConfigurationSource,
  assertValidPipelineSource,
  detectConfigurationFormat,
  isEmptyPipeline,
  MAX_CONFIGURATION_BYTES,
  sourceOffset,
} from "./configurationSource";
import ConfigurationCodeEditor from "./ConfigurationCodeEditor";
import ConfigurationImportDialog, {
  type ConfigurationImport,
} from "./ConfigurationImportDialog";
import "./editor.css";
import PipelineNode, { ComponentIcon, componentTitle } from "./PipelineNode";
import PipelineCheckButton from "./PipelineCheckButton";
import ProblemsPanel from "./ProblemsPanel";
import {
  applyFix,
  checkFailureMessage,
  checkLabel,
  checkProblems,
  checkStatus,
  checkVerdict,
  componentProblems,
  countProblems,
  localProblems,
  mergeProblems,
  settleStaleProblems,
  type PipelineCheck,
  type Problem,
} from "./pipelineProblems";
import { vrlValue, withVrlValue } from "./PipelineSettings";
import { upstreamOf } from "./sampleUpstream";
import { copySteps, pasteSteps, stepsText } from "./canvasClipboard";
import { patternEdges, patternInputs, patternSummary } from "./inputPatterns";
import CanvasFind from "./CanvasFind";
import {
  edgeRate,
  formatRate,
  liveSummary,
  nodeLive,
  type PipelineTelemetry,
} from "./liveGraph";

const LIVE_KEY = "vectory.editor.live";
const readLiveSetting = () => {
  try {
    return localStorage.getItem(LIVE_KEY) === "on";
  } catch {
    return false;
  }
};
/** How often live numbers refresh: about one agent check-in. */
const LIVE_REFRESH_MS = 15000;
import { coalesces, editedField } from "./editHistory";
import { draftSummary } from "./draftSummary";
import {
  pipelineTemplates,
  withMonitoring,
  type PipelineTemplate,
} from "./pipelineTemplates";
import "./pipeline-templates.css";
import {
  clearRecoveryDraft,
  readRecoveryDraft,
  storeRecoveryDraft,
  type RecoveryDraft,
} from "./draftRecovery";
import {
  PIPELINE_NODE_WIDTH,
  PIPELINE_NODE_BODY_HEIGHT,
  PIPELINE_NODE_COLUMN_GAP,
} from "./pipelineNodeModel";
import "./pipeline-node.css";
import CanvasComponentMenu, {
  type CanvasPickerLocation,
} from "./CanvasComponentMenu";
import TabLabel from "./TabLabel";
import "./editor-canvas.css";
import "./editor-code.css";
import { useDismissibleDetails } from "./useDismissibleDetails";
import { diagnoseJSONValue } from "./SchemaValueEditor";
import PipelineEdge, { ConnectionCancellation } from "./PipelineEdge";
import ConnectionStylePicker, {
  useConnectionStyle,
} from "./ConnectionStylePicker";
import { connectionLineTypes } from "./connectionStyle";
import CanvasActionMenu, { type CanvasAction } from "./CanvasActionMenu";

const edgeTypes = { pipeline: PipelineEdge };
// React Flow (MIT) permits hiding its attribution badge; the brief asks for it.
const FLOW_PRO_OPTIONS = { hideAttribution: true };
// Canvas options keep one identity: React Flow copies changed props into its
// store, which re-runs every node and edge subscription.
const connectionLineStyle = { stroke: "var(--accent)", strokeWidth: 2 };
const fitViewOptions = { padding: 0.12, minZoom: 0.15, maxZoom: 1 };
const smallFitViewOptions = { padding: 0.12, minZoom: 0.65, maxZoom: 1 };
const defaultEdgeOptions = {
  type: "pipeline",
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: "var(--muted)",
    width: 12,
    height: 12,
  },
};
type ConnectionGesture = {
  nodeId: string;
  handleId: string;
  handleType: "source" | "target";
};
type GraphMenu = {
  kind: "node" | "edge";
  id: string;
  position: { x: number; y: number };
  opener?: HTMLElement;
};

const kindLabel: Record<Kind, string> = {
  sources: "Source",
  transforms: "Transformation",
  sinks: "Destination",
};
const kindPlural: Record<Kind, string> = {
  sources: "Sources",
  transforms: "Transformations",
  sinks: "Destinations",
};
function ComponentName({
  id,
  editable,
  onRename,
  onPendingChange,
}: {
  id: string;
  editable: boolean;
  onRename: (name: string) => boolean;
  onPendingChange: (id: string, pending: boolean) => void;
}) {
  const [editing, setEditing] = useState(false),
    [name, setName] = useState(id);
  useEffect(() => {
    onPendingChange("component-name", editing && name !== id);
    return () => onPendingChange("component-name", false);
  }, [editing, name, id, onPendingChange]);
  function cancel() {
    setName(id);
    setEditing(false);
  }
  function commit() {
    if (name.trim() === id) {
      cancel();
      return;
    }
    onPendingChange("component-name", false);
    if (onRename(name)) setEditing(false);
    else onPendingChange("component-name", name !== id);
  }
  if (!editing)
    return editable ? (
      <button
        className="editor-node-name"
        aria-label="Rename component"
        onClick={() => setEditing(true)}
      >
        <code>{id}</code>
        <Pencil size={13} />
      </button>
    ) : (
      <code>{id}</code>
    );
  return (
    <div className="editor-name-input">
      <input
        aria-label="Component name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      />
      <Button variant="secondary compact" onClick={commit}>
        Rename
      </Button>
      <IconButton icon={X} label="Cancel component rename" onClick={cancel} />
    </div>
  );
}
const nodeTypes = { component: PipelineNode };
function initialGraph(config: Config, saved?: Graph): Graph {
  const graph = toGraph(config, saved);
  const defaultGrid = graph.nodes.every(
    (node) =>
      node.position.x ===
        ["sources", "transforms", "sinks"].indexOf(node.data.kind) * 290 + 60 &&
      (node.position.y - 100) % 170 === 0,
  );
  return !saved?.nodes.length || defaultGrid ? arrangeGraph(graph) : graph;
}
function pipelineSummary(config: Config) {
  return (["sources", "transforms", "sinks"] as Kind[])
    .map((kind) => {
      const values = Object.values(config[kind] || {}) as Config[];
      if (!values.length)
        return kind === "transforms"
          ? null
          : kind === "sources"
            ? "No source yet"
            : "No destination yet";
      if (values.length > 1)
        return `${values.length} ${kindPlural[kind].toLowerCase()}`;
      return (
        catalog.find((c) => c.kind === kind && c.type === values[0]?.type)
          ?.label ||
        values[0]?.type ||
        "Custom step"
      );
    })
    .filter(Boolean)
    .join(" → ");
}
/** Whether two graphs place the same nodes at the same positions. */
function samePositions(left: any[], right: any[]) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every(
        (node, index) =>
          node.id === right[index].id &&
          (node.position === right[index].position ||
            (node.position?.x === right[index].position?.x &&
              node.position?.y === right[index].position?.y)),
      ))
  );
}
const saveShortcut =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? "⌘S"
    : "Ctrl+S";
const AUTO_CHECK_KEY = "vectory.editor.auto-check";
function readAutoCheck() {
  try {
    return window.localStorage.getItem(AUTO_CHECK_KEY) !== "off";
  } catch {
    return true;
  }
}
function writeAutoCheck(value: boolean) {
  try {
    window.localStorage.setItem(AUTO_CHECK_KEY, value ? "on" : "off");
  } catch {
    // A preference only: the choice still applies until the page reloads.
  }
}
type EditorSnapshot = {
  config: Config;
  graph: Graph;
  variables: VariableDeclaration[];
};
export default function Editor({
  id,
  initialDeviceId,
  destination,
  user,
  notify,
  navigate,
}: {
  id: string;
  initialDeviceId?: string;
  destination?: PipelineDestination;
  user: User;
  notify: (m: string) => void;
  navigate: (p: string) => void;
}) {
  const [connectionStyle, setConnectionStyle] = useConnectionStyle();
  const [doc, setDoc] = useState<Configuration | null>(null),
    [config, setConfig] = useState<Config>({}),
    [variables, setVariables] = useState<VariableDeclaration[]>([]),
    [nodes, setNodes] = useState<any[]>([]),
    [edges, setEdges] = useState<Edge[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [view, setView] = useState("canvas"),
    [autoArrange, setAutoArrange] = useState(true),
    [format, setFormat] = useState("yaml"),
    [code, setCode] = useState(""),
    [canvasPicker, setCanvasPicker] = useState<CanvasPickerLocation | null>(
      null,
    ),
    [graphMenu, setGraphMenu] = useState<GraphMenu | null>(null),
    [shortcutsOpen, setShortcutsOpen] = useState(false),
    [connectionGesture, setConnectionGesture] =
      useState<ConnectionGesture | null>(null),
    [hoveredConnection, setHoveredConnection] = useState<string | null>(null),
    [focusedConnection, setFocusedConnection] = useState<string | null>(null),
    [reconnecting, setReconnecting] = useState(false),
    [pickerKind, setPickerKind] = useState<Kind | null>(null),
    [customComponentJSON, setCustomComponentJSON] =
      useState('{\n  "type": ""\n}'),
    [publishedVersion, setPublishedVersion] = useState<Version | null>(null),
    [live, setLive] = useState(readLiveSetting),
    [findOpen, setFindOpen] = useState(false),
    [telemetry, setTelemetry] = useState<{
      data: PipelineTelemetry | null;
      error: string;
    } | null>(null),
    [publishedVersionStatus, setPublishedVersionStatus] = useState<
      "loading" | "ready" | "failed"
    >("loading"),
    [publishedVersionError, setPublishedVersionError] = useState(""),
    [publishedLookup, setPublishedLookup] = useState<{
      id: string;
      attempt: number;
      observation: number;
    } | null>(null),
    [dirty, setDirty] = useState(false),
    [saveStatus, setSaveStatus] = useState("All changes saved"),
    [loadAttempt, setLoadAttempt] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    // The last Vector check and the exact draft it checked. Findings stay
    // visible (marked stale) until the next check of the edited draft.
    [check, setCheck] = useState<{
      result: PipelineCheck;
      config: Config;
      variables: VariableDeclaration[];
      /** The Code text checked before it was applied to the draft. */
      code?: string;
    } | null>(null),
    [checking, setChecking] = useState(false),
    // Why the last requested check could not run. Earlier findings stay.
    [checkError, setCheckError] = useState(""),
    [problemsOpen, setProblemsOpen] = useState(false),
    [autoCheck, setAutoCheck] = useState(readAutoCheck),
    [codeReveal, setCodeReveal] = useState<{
      offset: number;
      nonce: number;
    } | null>(null),
    [focusRequest, setFocusRequest] = useState<{
      component: string;
      field?: string;
      line?: number;
      column?: number;
      nonce: number;
    } | null>(null),
    [savingDraft, setSavingDraft] = useState(false),
    // The note for "Save with note…"; null while that dialog is closed.
    [saveNote, setSaveNote] = useState<string | null>(null),
    // Unsaved edits found in this browser, until restored or discarded.
    [recovery, setRecovery] = useState<RecoveryDraft | null>(null),
    // What an applied template still needs, until dismissed.
    [templateNeeds, setTemplateNeeds] = useState<{
      title: string;
      needs: string[];
    } | null>(null),
    // Why the server definitively refused the last publish attempt.
    [publishRejection, setPublishRejection] = useState<{
      code: string;
      message: string;
    } | null>(null),
    // The version just published, offered for deployment next.
    [publishedResult, setPublishedResult] = useState<Version | null>(null),
    // Where this pipeline's versions are assigned, for the publish review.
    [publishReach, setPublishReach] = useState<string | null>(null),
    [historyOpen, setHistoryOpen] = useState(false),
    [historyVersion, setHistoryVersion] = useState<Version | null>(null),
    [publishNotice, setPublishNotice] = useState<
      "uncertain" | "confirmed" | null
    >(null),
    [pipelineAction, setPipelineAction] = useState<{
      action: PipelineAction;
      configuration: Configuration;
    } | null>(null),
    [deployVersion, setDeployVersion] = useState<Version | null>(null),
    [publishOpen, setPublishOpen] = useState(false),
    [globalsOpen, setGlobalsOpen] = useState(false),
    [globalsSection, setGlobalsSection] = useState<PipelineSection>("general"),
    [detailsOpen, setDetailsOpen] = useState(false),
    [discardOpen, setDiscardOpen] = useState(false),
    [message, setMessage] = useState(""),
    [fieldPickerTarget, setFieldPickerTarget] = useState<HTMLDivElement | null>(
      null,
    ),
    [pendingFieldCount, setPendingFieldCount] = useState(0),
    [draggingFile, setDraggingFile] = useState(false),
    [importCandidate, setImportCandidate] =
      useState<ConfigurationImport | null>(null),
    [codeAnalysis, setCodeAnalysis] = useState<{
      text: string;
      format: string;
      result: ReturnType<typeof diagnoseConfigurationSource>;
    } | null>(null);
  const stack = useRef<EditorSnapshot[]>([]),
    future = useRef<EditorSnapshot[]>([]),
    lastEdit = useRef<{ key: string; at: number } | null>(null),
    latest = useRef({ doc, config, variables, nodes, edges, dirty }),
    pendingSave = useRef<Promise<Configuration | null> | null>(null),
    saveUncertain = useRef(false),
    uncertainSaveRevision = useRef<number | null>(null),
    saveNeedsReload = useRef(false),
    discardGate = useRef(false),
    discardReturnFocus = useRef<HTMLButtonElement | null>(null),
    detailsReturnFocus = useRef<HTMLElement | null>(null),
    detailsTitleRef = useRef<HTMLButtonElement | null>(null),
    checkGeneration = useRef(0),
    checkInFlight = useRef(false),
    explicitSaveInFlight = useRef(false),
    fileRef = useRef<HTMLInputElement>(null),
    flow = useRef<any>(null),
    graphRef = useRef<HTMLDivElement>(null),
    pickerPlacement = useRef<CanvasPickerLocation | null>(null),
    pickerOpener = useRef<HTMLElement | null>(null),
    importedCodeDirty = useRef(false),
    importGeneration = useRef(0),
    dragDepth = useRef(0),
    importContext = useRef({ config, code, pending: false, allowed: false });
  // Stable per-node and per-edge callbacks that read the latest handlers, so
  // cached canvas objects never hold stale closures.
  type MenuHandler = (
    id: string,
    position: { x: number; y: number },
    opener: HTMLElement,
  ) => void;
  const graphHandlers = useRef<{
    nodeMenu: MenuHandler;
    edgeMenu: MenuHandler;
    edgeHover: (id: string, hovered: boolean) => void;
    edgeInsert: (id: string, position: { x: number; y: number }) => void;
  }>({
    nodeMenu: () => {},
    edgeMenu: () => {},
    edgeHover: () => {},
    edgeInsert: () => {},
  });
  const handlerCache = useRef(
    new Map<
      string,
      {
        menu: (position: { x: number; y: number }, opener: HTMLElement) => void;
        hover: (hovered: boolean) => void;
        insert: (position: { x: number; y: number }) => void;
      }
    >(),
  );
  function stableHandlers(key: string) {
    let entry = handlerCache.current.get(key);
    if (!entry) {
      const [kind, ...rest] = key.split(":");
      const id = rest.join(":");
      entry = {
        menu: (position, opener) =>
          (kind === "node"
            ? graphHandlers.current.nodeMenu
            : graphHandlers.current.edgeMenu)(id, position, opener),
        hover: (hovered) => graphHandlers.current.edgeHover(id, hovered),
        insert: (position) => graphHandlers.current.edgeInsert(id, position),
      };
      handlerCache.current.set(key, entry);
    }
    return entry;
  }
  const flowCache = useRef(
    new Map<string, { inputs: unknown[]; value: any }>(),
  );
  function cachedFlowObject(key: string, inputs: unknown[], build: () => any) {
    const hit = flowCache.current.get(key);
    if (
      hit &&
      hit.inputs.length === inputs.length &&
      hit.inputs.every((value, index) => Object.is(value, inputs[index]))
    )
      return hit.value;
    const value = build();
    flowCache.current.set(key, { inputs, value });
    return value;
  }
  // Canvas callbacks keep one identity per name and call the latest handler.
  const canvasHandlers = useRef(new Map<string, (...args: any[]) => any>()),
    canvasWrappers = useRef(new Map<string, (...args: any[]) => any>());
  function stableCanvasHandler<T extends (...args: any[]) => any>(
    name: string,
    handler: T | undefined,
  ): T | undefined {
    if (!handler) return undefined;
    canvasHandlers.current.set(name, handler);
    let wrapper = canvasWrappers.current.get(name);
    if (!wrapper) {
      wrapper = (...args: any[]) => canvasHandlers.current.get(name)?.(...args);
      canvasWrappers.current.set(name, wrapper);
    }
    return wrapper as T;
  }
  const flowNodeArray = useRef<any[]>([]),
    flowEdgeArray = useRef<any[]>([]),
    // Whether the latest graph change came from a config edit (deferred to
    // the canvas) rather than a drag or selection (immediate).
    graphFromEdit = useRef(false);
  function stableArray(previous: { current: any[] }, next: any[]) {
    if (
      previous.current.length !== next.length ||
      next.some((item, index) => item !== previous.current[index])
    )
      previous.current = next;
    return previous.current;
  }
  const publishActive = useRef<AbortController | null>(null);
  const publishMounted = useRef(false);
  const publicationObservation = useRef(0);
  const publicationError = useRef("");
  function reportPublicationError(message: string) {
    publicationError.current = message;
    setError(message);
  }
  function acceptPublishedVersion(version: Version) {
    publicationObservation.current++;
    setPublishedVersion(version);
    setPublishedVersionStatus("ready");
    setPublishedVersionError("");
    setPublishNotice(null);
    setError((previous) =>
      previous === publicationError.current ? "" : previous,
    );
  }
  function retryPublishedVersion() {
    const lookupObservation = publicationObservation.current;
    setPublishedVersionStatus("loading");
    setPublishedLookup((previous) => ({
      id,
      attempt: (previous?.attempt || 0) + 1,
      observation: lookupObservation,
    }));
  }
  const publishRecoveryRef = useRef<PublishRecoveryHandle>(null);
  const pipelineCreationRecoveryRef =
    useRef<PipelineCreationRecoveryHandle>(null);
  const pipelineCreationRecovery = usePipelineCreationOperations(user.id);
  const unresolvedPipelineCreation =
    pipelineCreationRecovery.operations.length > 0 ||
    pipelineCreationRecovery.errors.length > 0;
  const publishRecovery = usePublishOperations(user.id, id);
  const unresolvedPublish =
    publishRecovery.operations.length > 0 || publishRecovery.errors.length > 0;
  useEffect(() => {
    publishMounted.current = true;
    return () => {
      publishMounted.current = false;
      publishActive.current?.abort();
    };
  }, []);
  const reconnectGesture = useRef<{
    edge: Edge;
    x: number;
    y: number;
    applied: boolean;
    cancelled: boolean;
  } | null>(null);
  const connectionCancelled = useRef(false);
  const pendingSchemaFields = useRef(new Set<string>());
  const pointerFocus = useRef(false);
  const clearConnectionHighlight = useCallback(() => {
    setHoveredConnection(null);
    setFocusedConnection(null);
  }, []);
  useEffect(() => {
    clearConnectionHighlight();
  }, [
    config,
    view,
    historyOpen,
    busy,
    connectionGesture,
    reconnecting,
    graphMenu,
    canvasPicker,
    clearConnectionHighlight,
  ]);
  useEffect(() => {
    const release = () => {
      pointerFocus.current = false;
    };
    const leave = () => {
      release();
      clearConnectionHighlight();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", leave);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", leave);
    };
  }, [clearConnectionHighlight]);
  const highlightEnabled =
    view === "canvas" &&
    !historyOpen &&
    !busy &&
    !connectionGesture &&
    !reconnecting &&
    !graphMenu &&
    !canvasPicker;
  const highlightedConnection = highlightEnabled
    ? edges.find((edge) => edge.id === (hoveredConnection || focusedConnection))
    : undefined;
  function hoverConnection(id: string, hovered: boolean) {
    if (hovered && highlightEnabled) setHoveredConnection(id);
    else setHoveredConnection((current) => (current === id ? null : current));
  }
  const schemaPendingChange = useCallback(
    (fieldId: string, hasChanges: boolean) => {
      if (hasChanges) {
        pendingSchemaFields.current.add(fieldId);
      } else pendingSchemaFields.current.delete(fieldId);
      setPendingFieldCount(pendingSchemaFields.current.size);
    },
    [],
  );
  latest.current = { doc, config, variables, nodes, edges, dirty };
  const editable = can(user, "edit") && !!doc && !doc.archived;
  const checkable =
    (editable || can(user, "operate")) && !!doc && !doc.archived;
  importContext.current = {
    config,
    code,
    pending: importedCodeDirty.current || !!pendingSchemaFields.current.size,
    allowed:
      editable &&
      !busy &&
      !historyOpen &&
      !globalsOpen &&
      !detailsOpen &&
      !discardOpen &&
      !publishOpen &&
      !deployVersion &&
      !pipelineAction &&
      !pickerKind,
  };
  useEffect(
    () => () => {
      importGeneration.current++;
    },
    [id],
  );
  useEffect(() => {
    if (view !== "code") return;
    const timer = setTimeout(
      () =>
        setCodeAnalysis({
          text: code,
          format,
          result: diagnoseConfigurationSource(code, format),
        }),
      250,
    );
    return () => clearTimeout(timer);
  }, [code, format, view]);
  const currentAnalysis =
    codeAnalysis?.text === code && codeAnalysis.format === format
      ? codeAnalysis.result
      : null;
  // Local checks trail typing: React paints the keystroke first and then
  // diagnoses the new draft in the background.
  const checkedConfig = useDeferredValue(config),
    checkedVariables = useDeferredValue(variables);
  const graphDiagnosis = useMemo(
    () => diagnoseConfiguration(checkedConfig),
    [checkedConfig],
  );
  const issues = graphDiagnosis.diagnostics
    .filter((item) => item.severity === "error")
    .map((item) => ({
      id: item.componentId,
      enrichmentTableId: item.enrichmentTableId,
      message: item.message,
    }));
  const issueAffectsMemoryTable = (
    issue: (typeof issues)[number],
    tableId: string,
  ) =>
    issue.enrichmentTableId === tableId ||
    nodes.some(
      (tableNode) =>
        tableNode.data.enrichmentTable === tableId && tableNode.id === issue.id,
    );
  // Node badges: errors, else Vector warnings, for a step or the memory table
  // it edits. Connectivity has its own badge.
  const nodeProblemData = (node: any) => {
    const table: string | undefined = node.data.enrichmentTable;
    const entry =
      nodeProblems.get(node.id) ||
      (table ? nodeProblems.get(table) : undefined);
    const tableIssue = table
      ? issues.find((issue) => issueAffectsMemoryTable(issue, table))
      : undefined;
    const errors = entry?.errors || (tableIssue ? 1 : 0);
    const first = entry
      ? [entry.first.field, entry.first.message].filter(Boolean).join(": ")
      : undefined;
    return {
      hasIssue: errors > 0,
      issueCount: errors,
      issueMessage: entry?.errors ? first : tableIssue?.message,
      warningMessage: !errors && entry?.warnings ? first : undefined,
    };
  };
  const connectivity = useMemo(
    () => pipelineConnectivity(checkedConfig),
    [checkedConfig],
  );
  const customJSONAnalysis = useMemo(
    () => diagnoseJSONValue(customComponentJSON),
    [customComponentJSON],
  );
  const codeFeedbackId = useId();
  const checkFeedbackId = useId();
  const customJSONFeedbackId = useId();
  const customJSONErrorId = useId();
  const variableMessages = useMemo(
    () => variableErrors(checkedConfig, checkedVariables),
    [checkedConfig, checkedVariables],
  );
  const errors = [...issues.map((issue) => issue.message), ...variableMessages];
  // Problems: instant local checks plus the last Vector check. Vector's
  // findings stay visible, marked stale, until a check of the edited draft.
  const codeChecked = view === "code" && importedCodeDirty.current;
  const draftChanged = useMemo(() => {
    if (!check) return false;
    if (codeChecked) return check.code !== code;
    return (
      (check.config !== checkedConfig &&
        !sameConfiguration(check.config, checkedConfig)) ||
      (check.variables !== checkedVariables &&
        JSON.stringify(check.variables) !== JSON.stringify(checkedVariables))
    );
  }, [check, checkedConfig, checkedVariables, code, codeChecked]);
  // An unfinished field value is not in the draft yet, so the last check no
  // longer describes what is on screen.
  const checkStale = draftChanged || (!!check && pendingFieldCount > 0);
  // Whether the draft still equals the published version.
  const publishedDraft = useMemo(
    () =>
      !!publishedVersion &&
      sameConfiguration(publishedVersion.config, checkedConfig) &&
      JSON.stringify(publishedVersion.variables || []) ===
        JSON.stringify(checkedVariables),
    [publishedVersion, checkedConfig, checkedVariables],
  );
  // Unapplied Code edits are what a check sends, so their local findings
  // count until the text is applied or discarded.
  const codeProblemSource =
    codeChecked && currentAnalysis ? currentAnalysis : null;
  const draftProblems = useMemo(
    () =>
      codeProblemSource
        ? localProblems(
            codeProblemSource.diagnostics,
            codeProblemSource.config
              ? pipelineConnectivity(codeProblemSource.config)
              : new Map(),
            variableMessages,
            codeProblemSource.config || checkedConfig,
          )
        : localProblems(
            graphDiagnosis.diagnostics,
            connectivity,
            variableMessages,
            checkedConfig,
          ),
    [
      codeProblemSource,
      graphDiagnosis,
      connectivity,
      variableMessages,
      checkedConfig,
    ],
  );
  // Auto-check needs a source and a destination; until then stale Vector
  // findings (such as "No sources defined") would contradict the canvas.
  const missingForCheck = [
    Object.keys(checkedConfig.sources || {}).length ? "" : "source",
    Object.keys(checkedConfig.sinks || {}).length ? "" : "destination",
  ].filter(Boolean);
  const dropStaleVector = checkStale && missingForCheck.length > 0;
  const problems = useMemo(() => {
    const vector = dropStaleVector
      ? []
      : checkProblems(check?.result || null, checkedConfig, checkStale);
    const program = (
      draft: "checked" | "current",
      component: string,
      field: string,
    ) => {
      const value = (draft === "checked" ? check?.config : checkedConfig)
        ?.transforms?.[component];
      return value ? vrlValue(value, field) : null;
    };
    return mergeProblems(
      draftProblems,
      checkStale ? settleStaleProblems(vector, program) : vector,
    );
  }, [draftProblems, check, checkedConfig, checkStale, dropStaleVector]);
  const problemCounts = countProblems(problems);
  // Vector errors from a check of this exact draft block publishing: the
  // server would refuse the same draft.
  const freshVectorErrors =
    !checkStale &&
    problems.some(
      (problem) =>
        problem.origin === "vector" &&
        problem.severity === "error" &&
        !problem.stale,
    );
  const nodeProblems = useMemo(() => componentProblems(problems), [problems]);
  const status = checkStatus({
    checking,
    check: check?.result || null,
    stale: checkStale,
    errors: problemCounts.errors,
    failed: !!checkError,
  });
  const statusLabel = checkLabel(status, problemCounts.errors);
  const verdict = checkError
    ? checkError
    : checkStale
      ? pendingFieldCount
        ? "Apply or discard the field you're editing, then check again."
        : autoCheck && missingForCheck.length
          ? `Add a ${missingForCheck.join(" and a ")} and Vector checks automatically.`
          : autoCheck
            ? "Changed since the last check. Checking again when you pause."
            : "Changed since the last check."
      : checkVerdict(check?.result || null, problemCounts.errors);
  const autoCheckAttempt = useRef<{
    config: Config;
    variables: VariableDeclaration[];
  } | null>(null);
  // Auto-check waits while a dialog or unfinished field has the user's focus.
  const autoCheckReady =
    autoCheck &&
    checkable &&
    !!doc &&
    view === "canvas" &&
    !checking &&
    !busy &&
    !historyOpen &&
    !publishOpen &&
    !globalsOpen &&
    !detailsOpen &&
    !discardOpen &&
    !deployVersion &&
    !pipelineAction &&
    !importCandidate &&
    pendingFieldCount === 0 &&
    (!check || checkStale) &&
    Object.keys(config.sources || {}).length > 0 &&
    Object.keys(config.sinks || {}).length > 0;
  useEffect(() => {
    if (!autoCheckReady) return;
    const attempt = autoCheckAttempt.current;
    // One automatic attempt per draft: a failed attempt waits for the next edit.
    if (attempt?.config === config && attempt.variables === variables) return;
    const timer = window.setTimeout(() => {
      autoCheckAttempt.current = { config, variables };
      void validate({ auto: true });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [autoCheckReady, config, variables]);
  function changeAutoCheck(value: boolean) {
    setAutoCheck(value);
    writeAutoCheck(value);
  }
  // Live numbers for the versions devices run, refreshed about once per
  // check-in while the canvas is visible.
  const liveAvailable = !!publishedVersion;
  const liveOn = live && liveAvailable && view === "canvas";
  useEffect(() => {
    if (!liveOn) return;
    let alive = true,
      timer = 0;
    const controller = new AbortController();
    const load = async () => {
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(load, LIVE_REFRESH_MS);
        return;
      }
      try {
        const data = await api<PipelineTelemetry>(
          `/configurations/${id}/telemetry`,
          { signal: controller.signal },
        );
        if (alive) setTelemetry({ data, error: "" });
      } catch (failure) {
        if (alive)
          setTelemetry((previous) => ({
            data: previous?.data ?? null,
            error: (failure as Error).message,
          }));
      }
      if (alive) timer = window.setTimeout(load, LIVE_REFRESH_MS);
    };
    void load();
    return () => {
      alive = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [liveOn, id]);
  function toggleLive() {
    const next = !live;
    setLive(next);
    if (!next) setTelemetry(null);
    try {
      localStorage.setItem(LIVE_KEY, next ? "on" : "off");
    } catch {
      /* the choice lasts for this visit */
    }
  }
  const liveData = liveOn ? (telemetry?.data ?? null) : null;
  const liveStatus =
    liveOn && telemetry?.data
      ? liveSummary(telemetry.data, publishedVersion?.number ?? null)
      : null;
  const toolsRef = useRef<HTMLDetailsElement>(null);
  useDismissibleDetails(toolsRef);
  const handledDestination = useRef("");
  const blockedDestination = useRef("");
  const destinationKey = destination
    ? `${destination.panel}:${destination.section || ""}`
    : "";
  useEffect(() => {
    if (!destination) {
      handledDestination.current = "";
      blockedDestination.current = "";
      return;
    }
    if (!doc || handledDestination.current === destinationKey || busy) return;
    // A navigation request must never replace an open form or unapplied fields.
    if (
      globalsOpen ||
      detailsOpen ||
      discardOpen ||
      publishOpen ||
      deployVersion ||
      pipelineAction
    ) {
      if (blockedDestination.current !== destinationKey)
        notify(
          "Close the current dialog to continue to the linked pipeline view.",
        );
      blockedDestination.current = destinationKey;
      return;
    }
    if (destination.panel !== "history" && historyOpen) {
      setHistoryOpen(false);
      return;
    }
    handledDestination.current = destinationKey;
    blockedDestination.current = "";
    if (destination.panel === "history") openHistory();
    else if (destination.panel === "tools") {
      if (toolsRef.current) toolsRef.current.open = true;
    } else
      tool(() => {
        if (destination.panel === "details") {
          detailsReturnFocus.current = detailsTitleRef.current;
          setDetailsOpen(true);
        } else {
          setGlobalsSection(destination.section || "general");
          setGlobalsOpen(true);
        }
      });
  }, [
    doc?.id,
    destinationKey,
    busy,
    globalsOpen,
    detailsOpen,
    discardOpen,
    publishOpen,
    deployVersion,
    pipelineAction,
    historyOpen,
  ]);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setError("");
    withRequestDeadline(
      (signal) => api<Configuration>(`/configurations/${id}`, { signal }),
      15000,
      controller.signal,
    )
      .then((result) => {
        if (!alive) return;
        const graph = initialGraph(result.config, result.graph);
        setDoc(result);
        setConfig(result.config);
        setVariables(result.variables || []);
        graphFromEdit.current = false;
        setNodes(graph.nodes);
        setEdges(graph.edges);
        setDirty(false);
        checkGeneration.current++;
        checkInFlight.current = false;
        setChecking(false);
        setCheck(null);
        setCheckError("");
        setError("");
        // Offer edits left unsaved in this browser (a crash, closed tab or
        // lost session) unless they match what the server already has.
        const stored =
          can(user, "edit") && !result.archived
            ? readRecoveryDraft(user.id, id)
            : null;
        if (
          stored &&
          (!sameConfiguration(stored.config, result.config) ||
            JSON.stringify(stored.variables) !==
              JSON.stringify(result.variables || []))
        )
          setRecovery(stored);
        else {
          if (stored) clearRecoveryDraft(user.id, id);
          setRecovery(null);
        }
        setPublishedVersion(null);
        setPublishedVersionStatus("loading");
        setPublishedVersionError("");
        const lookupObservation = publicationObservation.current;
        setPublishedLookup((previous) => ({
          id,
          attempt: (previous?.attempt || 0) + 1,
          observation: lookupObservation,
        }));
      })
      .catch((e) => {
        if (alive)
          setError((e as Error)?.message || "The request did not complete.");
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [id, loadAttempt]);
  useEffect(() => {
    if (
      !publishedLookup ||
      publishedLookup.id !== id ||
      publishedLookup.observation !== publicationObservation.current
    )
      return;
    let alive = true;
    const controller = new AbortController();
    const observation = publishedLookup.observation;
    setPublishedVersionStatus("loading");
    setPublishedVersionError("");
    async function readPublishedVersion() {
      const history = await withRequestDeadline(
        (signal) =>
          api<{ items: { id: string }[] }>(
            `/configurations/${id}/history?kind=versions&page=1&page_size=1`,
            { signal },
          ),
        15000,
        controller.signal,
      );
      const latestId = history.items[0]?.id;
      const version = latestId
        ? await withRequestDeadline(
            (signal) => api<Version>(`/versions/${latestId}`, { signal }),
            15000,
            controller.signal,
          )
        : null;
      if (
        version &&
        (version.id !== latestId || version.configuration_id !== id)
      )
        throw Error("Published version identity did not match this pipeline.");
      if (alive && observation === publicationObservation.current) {
        setPublishedVersion(version);
        setPublishedVersionStatus("ready");
      }
    }
    void readPublishedVersion().catch((failure) => {
      if (alive && observation === publicationObservation.current) {
        setPublishedVersionStatus("failed");
        setPublishedVersionError(
          failure instanceof APIError && failure.code === "IDENTITY_MISMATCH"
            ? "The returned version did not match this pipeline. Retry the check."
            : (failure as Error)?.message ||
                "Published version could not be checked.",
        );
      }
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [id, publishedLookup]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (
        publishActive.current ||
        dirty ||
        saveUncertain.current ||
        saveNeedsReload.current ||
        importedCodeDirty.current ||
        pendingSchemaFields.current.size
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    const navigate = (event: Event) => {
      if (
        publishActive.current ||
        ((dirty ||
          importedCodeDirty.current ||
          pendingSchemaFields.current.size ||
          saveUncertain.current ||
          saveNeedsReload.current) &&
          !confirm(
            saveUncertain.current || saveNeedsReload.current
              ? "Leave this editor? A draft save is unresolved. It may still change the server draft."
              : "Leave this editor? Unsaved changes may be lost.",
          ))
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
    async function saveDraft(
      explicit = false,
      metadata?: { name: string; description: string },
      parentSignal?: AbortSignal,
      note?: string,
    ): Promise<Configuration | null> {
      // Opening the discard dialog suspends queued saves immediately.
      if (discardGate.current) return null;
      if (pendingSave.current) {
        const active = pendingSave.current;
        const saved = await active;
        if (pendingSave.current === active) pendingSave.current = null;
        if (discardGate.current) return null;
        if (!saved) return null;
        return latest.current.dirty || metadata
          ? saveDraft(explicit, metadata, parentSignal, note)
          : latest.current.doc;
      }
      const current = latest.current;
      if (!current.doc || !editable) return current.doc;
      const revision = current.doc.revision,
        savedDoc = current.doc;
      setSaveStatus("Saving…");
      const operation = (async () => {
        try {
          const updated = await withRequestDeadline(
            (signal) =>
              put<Configuration>(
                `/configurations/${id}/draft`,
                {
                  revision,
                  ...metadata,
                  graph: { nodes: current.nodes, edges: current.edges },
                  config: current.config,
                  variables: current.variables,
                  // An explicit save records the author's note, or a
                  // summary of what changed since the saved revision.
                  message: metadata
                    ? "Updated pipeline details"
                    : note?.trim() ||
                      (explicit
                        ? draftSummary(
                            savedDoc.config,
                            current.config,
                            savedDoc.variables || [],
                            current.variables,
                          )
                        : "Saved before publishing"),
                },
                signal,
              ),
            30000,
            parentSignal,
          );
          saveUncertain.current = false;
          uncertainSaveRevision.current = null;
          saveNeedsReload.current = false;
          setDoc(updated);
          latest.current.doc = updated;
          // Measurements and selection change node and edge objects without
          // changing the draft; only the config, variables and positions do.
          const stillSame =
            latest.current.config === current.config &&
            latest.current.variables === current.variables &&
            samePositions(latest.current.nodes, current.nodes);
          if (stillSame) {
            setDirty(false);
            latest.current.dirty = false;
          }
          setSaveStatus(stillSame ? "All changes saved" : "Unsaved changes");
          if (explicit) notify("Draft revision saved.");
          return updated;
        } catch (e) {
          const rejected = e instanceof APIError && e.serverRejection;
          if (rejected && e.status === 409) {
            // The revision we sent is stale. A preceding timed-out request
            // cannot commit after another write has advanced that revision.
            saveUncertain.current = false;
            uncertainSaveRevision.current = null;
            saveNeedsReload.current = true;
          } else if (!rejected) {
            // A timeout, session interruption, or unreadable success response
            // cannot establish whether the server committed the PUT.
            saveUncertain.current = true;
            uncertainSaveRevision.current ??= revision;
          }
          setError(
            saveNeedsReload.current
              ? "The server draft changed. Reload it before discarding or saving these local edits."
              : saveUncertain.current
                ? "The draft save was not confirmed. Your edits are still here. Retry Save draft or reload the server draft."
                : (e as Error).message,
          );
          setSaveStatus(
            saveNeedsReload.current
              ? "Save conflict — reload server draft"
              : saveUncertain.current
                ? "Save status unknown — your edits are still here"
                : "Save failed — your edits are still here",
          );
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
  // Undo history keeps references: every edit builds new objects and never
  // changes an earlier draft. Edits to one field without a pause of a second
  // or more share one undo step, so undo reverts a typed word, not a letter.
  function rememberDraft(coalesce?: string) {
    const now = performance.now(),
      previous = lastEdit.current;
    lastEdit.current = coalesce ? { key: coalesce, at: now } : null;
    future.current = [];
    if (coalesces(previous, coalesce, now) && stack.current.length) return;
    stack.current.push({ config, graph: { nodes, edges }, variables });
    if (stack.current.length > 100) stack.current.shift();
  }
  function replace(
    next: Config,
    graph?: Graph,
    remember = true,
    nextVariables = variables,
    coalesce?: string,
  ) {
    if (!editable) return;
    try {
      assertExactNumbers(next);
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    if (remember) rememberDraft(coalesce);
    let nextGraph = toGraph(next, graph || { nodes, edges });
    const edgeShape = (items: Edge[]) =>
      JSON.stringify(
        items.map((edge) => [edge.source, edge.target, edge.sourceHandle]),
      );
    const topologyChanged =
      nextGraph.nodes.length !== nodes.length ||
      edgeShape(nextGraph.edges) !== edgeShape(edges) ||
      nextGraph.nodes.some(
        (node) =>
          !nodes.some(
            (old) =>
              old.id === node.id &&
              JSON.stringify(outputPorts(old.data.component)) ===
                JSON.stringify(outputPorts(node.data.component)),
          ),
      );
    if (autoArrange && !graph && topologyChanged)
      nextGraph = arrangeGraph(nextGraph);
    setConfig(next);
    setVariables(nextVariables);
    graphFromEdit.current = true;
    setNodes(nextGraph.nodes);
    setEdges(nextGraph.edges);
    setDirty(true);
    setSaveStatus("Unsaved changes");
  }
  function undo(redo = false) {
    if (pendingSchemaFields.current.size && !closeSettings()) return;
    const from = redo ? future.current : stack.current,
      to = redo ? stack.current : future.current;
    const item = from.pop();
    if (item) {
      to.push({ config, graph: { nodes, edges }, variables });
      lastEdit.current = null;
      replace(item.config, item.graph, false, item.variables);
    }
  }

  function closeCanvasPicker() {
    setCanvasPicker(null);
    pickerPlacement.current = null;
    if (pickerOpener.current?.isConnected) pickerOpener.current.focus();
    else graphRef.current?.focus();
  }
  function openCanvasPicker(
    screen: { x: number; y: number },
    input = "",
    kind?: Kind,
    position?: { x: number; y: number },
    insertBefore?: string[],
    shiftFrom?: number,
  ) {
    if (!editable || busy || !flow.current || !closeSettings()) return;
    setGraphMenu(null);
    const location = {
      screen,
      position: position ?? flow.current.screenToFlowPosition(screen),
      input,
      kind,
      insertBefore,
      shiftFrom,
    };
    pickerPlacement.current = location;
    pickerOpener.current = document.activeElement as HTMLElement;
    setCanvasPicker(location);
    setError("");
  }
  // A new step goes into free space: beside the selected step and fed by its
  // main output, or near the middle of the view when nothing is selected.
  /** Insert a step on a connection, taking over its downstream end. */
  function insertOnEdge(edgeId: string, screen?: { x: number; y: number }) {
    const edge = edges.find((item) => item.id === edgeId);
    const source = nodes.find((node) => node.id === edge?.source),
      target = nodes.find((node) => node.id === edge?.target);
    if (!edge || !source || !target || !flow.current) return;
    const input =
      !edge.sourceHandle || edge.sourceHandle === "output"
        ? edge.source
        : `${edge.source}.${edge.sourceHandle}`;
    // Use the gap between the steps when there is one; otherwise the new
    // step takes the target's column and everything from there moves right.
    const roomy =
      target.position.x - source.position.x >= 2 * PIPELINE_NODE_COLUMN_GAP;
    const position = roomy
      ? freePosition(nodes, {
          x: source.position.x + PIPELINE_NODE_COLUMN_GAP,
          y: (source.position.y + target.position.y) / 2,
        })
      : { x: target.position.x, y: target.position.y };
    openCanvasPicker(
      screen ?? flow.current.flowToScreenPosition(position),
      input,
      "transforms",
      position,
      [edge.target],
      roomy ? undefined : target.position.x,
    );
  }
  function openPicker(kind?: Kind) {
    const bounds = graphRef.current?.getBoundingClientRect();
    if (!bounds || !flow.current) return;
    const screen = {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + Math.min(bounds.height / 3, 180),
    };
    const anchor = selected
      ? nodes.find((node) => node.id === selected && !node.data.enrichmentTable)
      : undefined;
    const input = anchor && kind !== "sources" ? primaryOutput(anchor) : "";
    const position = anchor
      ? input
        ? besidePosition(nodes, anchor)
        : freePosition(nodes, anchor.position)
      : freePosition(nodes, flow.current.screenToFlowPosition(screen));
    openCanvasPicker(screen, input, kind, position);
  }
  const onConnectStart: OnConnectStart = (_event, params) => {
    connectionCancelled.current = false;
    setCanvasPicker(null);
    setGraphMenu(null);
    if (params.nodeId && params.handleType)
      setConnectionGesture({
        nodeId: params.nodeId,
        handleId:
          params.handleId ||
          (params.handleType === "source" ? "output" : "input"),
        handleType: params.handleType,
      });
  };
  const onConnectEnd: OnConnectEnd = (event, state) => {
    setConnectionGesture(null);
    if (reconnectGesture.current || connectionCancelled.current) return;
    if (
      state.isValid ||
      !state.fromNode ||
      state.fromHandle?.type !== "source" ||
      state.toNode
    )
      return;
    const target = event.target;
    if (
      !(target instanceof Element) ||
      !target.closest(".react-flow__pane") ||
      target.closest(".react-flow__node, .react-flow__handle")
    )
      return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!point) return;
    const port = state.fromHandle.id || "output";
    const namedOnly = ["route", "exclusive_route"].includes(
      nodes.find((node) => node.id === state.fromNode?.id)?.data.component.type,
    );
    openCanvasPicker(
      { x: point.clientX, y: point.clientY },
      port === "output" && !namedOnly
        ? state.fromNode.id
        : state.fromNode.id + "." + port,
    );
  };
  function add(item: Component, input?: string) {
    if (!editable || busy || !guardInspectorDrafts()) return;
    try {
      const placement = pickerPlacement.current
        ? {
            ...pickerPlacement.current,
            input: input ?? pickerPlacement.current.input,
          }
        : null;
      // Sources never take an input; other steps join the chosen output, and
      // an insertion on a connection takes over its downstream end.
      const result = addConnectedComponent(
        config,
        item,
        item.kind === "sources" ? "" : placement?.input || "",
        item.kind === "transforms" ? (placement?.insertBefore ?? []) : [],
        { autoConnectSource: false },
      );
      const nextGraph = toGraph(result.config, { nodes, edges });
      if (placement) {
        const shiftFrom =
          item.kind === "transforms" ? placement.shiftFrom : undefined;
        nextGraph.nodes = nextGraph.nodes.map((node) =>
          node.id === result.id
            ? { ...node, position: placement.position }
            : shiftFrom !== undefined && node.position.x >= shiftFrom - 1
              ? {
                  ...node,
                  position: {
                    x: node.position.x + PIPELINE_NODE_COLUMN_GAP,
                    y: node.position.y,
                  },
                }
              : node,
        );
        setAutoArrange(false);
      }
      replace(result.config, nextGraph);
      setPickerKind(null);
      setCanvasPicker(null);
      pickerPlacement.current = null;
      setSelected(result.id);
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            '.editor-inspector-body input, .editor-inspector-body textarea, .editor-inspector-body [contenteditable="true"], .editor-inspector-body select, .editor-inspector-body summary, .editor-inspector button',
          )
          ?.focus();
      });
      notify(item.label + " added.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function importComponentDefinition() {
    try {
      if (!pickerKind) return;
      if (
        !customJSONAnalysis.parseValid ||
        customJSONAnalysis.diagnostics.some((item) => item.severity === "error")
      )
        throw Error(
          customJSONAnalysis.diagnostics[0]?.message || "Enter valid JSON.",
        );
      const parsed = customJSONAnalysis.value;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof parsed.type !== "string" ||
        !/^[a-z][a-z0-9_]{0,99}$/.test(parsed.type)
      )
        throw Error(
          'Enter a component object with a valid Vector type, such as {"type":"kafka", ...}.',
        );
      const known = catalog.find(
        (item) => item.kind === pickerKind && item.type === parsed.type,
      );
      add({
        type: parsed.type,
        label: known?.label || parsed.type,
        kind: pickerKind,
        description: known?.description || "Imported component definition",
        defaults: parsed,
        fields: known?.fields || [],
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function onConnect(connection: Connection) {
    if (
      !editable ||
      busy ||
      connectionCancelled.current ||
      !canConnect(config, connection)
    )
      return;
    if (!closeSettings()) return;
    try {
      const next = connectConnection(config, connection);
      replace(next, toGraph(next, { nodes, edges }));
    } catch (e) {
      notify((e as Error).message);
    }
  }

  const onReconnect: OnReconnect = (previous, connection) => {
    const gesture = reconnectGesture.current;
    if (!editable || busy || gesture?.cancelled || !closeSettings()) return;
    try {
      const next = reconnect(config, previous, connection);
      if (gesture) gesture.applied = true;
      if (!sameConfiguration(config, next)) {
        replace(next, toGraph(next, { nodes, edges }));
        notify("Connection moved. Undo restores its previous endpoints.");
      }
    } catch (failure) {
      notify((failure as Error).message);
    }
  };

  function openGraphMenu(
    kind: "node" | "edge",
    itemId: string,
    position: { x: number; y: number },
    opener?: HTMLElement,
  ) {
    setCanvasPicker(null);
    setGraphMenu({ kind, id: itemId, position, opener });
  }

  const validPorts = useMemo(() => {
    const result = new Map<string, { input: boolean; outputs: string[] }>();
    if (!connectionGesture || !editable) return result;
    for (const node of nodes) {
      const input =
        connectionGesture.handleType === "source" &&
        canConnect(
          config,
          {
            source: connectionGesture.nodeId,
            sourceHandle: connectionGesture.handleId,
            target: node.id,
            targetHandle: "input",
          },
          reconnectGesture.current?.edge,
        );
      const outputs =
        connectionGesture.handleType === "target"
          ? outputPorts(node.data.component).filter((handle) =>
              canConnect(
                config,
                {
                  source: node.id,
                  sourceHandle: handle,
                  target: connectionGesture.nodeId,
                  targetHandle: connectionGesture.handleId,
                },
                reconnectGesture.current?.edge,
              ),
            )
          : [];
      result.set(node.id, { input, outputs });
    }
    return result;
  }, [config, connectionGesture, editable, nodes]);

  function graphActions(): CanvasAction[] {
    if (!graphMenu) return [];
    if (graphMenu.kind === "edge") {
      const edge = edges.find((item) => item.id === graphMenu.id);
      if (!edge) return [];
      return [
        {
          id: "source",
          label: "Source properties",
          icon: Settings2,
          onSelect: () => selectStep(edge.source),
        },
        {
          id: "target",
          label: "Destination properties",
          icon: Settings2,
          onSelect: () => selectStep(edge.target),
        },
        ...(editable
          ? [
              {
                id: "insert",
                label: "Insert a step",
                icon: Plus,
                onSelect: () =>
                  insertOnEdge(edge.id, {
                    x: graphMenu.position.x,
                    y: graphMenu.position.y,
                  }),
              },
              {
                id: "disconnect",
                label: "Disconnect",
                icon: Unplug,
                shortcut: "Delete",
                danger: true,
                onSelect: () => removeEdges([edge]),
              },
            ]
          : []),
      ];
    }
    const node = nodes.find((item) => item.id === graphMenu.id);
    if (!node) return [];
    const connections = edges.filter(
      (edge) => edge.source === node.id || edge.target === node.id,
    );
    return [
      {
        id: "properties",
        label: "Open properties",
        icon: Settings2,
        shortcut: "Enter",
        onSelect: () => selectStep(node.id),
      },
      ...(editable
        ? [
            {
              id: "duplicate",
              label: "Duplicate step",
              icon: Copy,
              shortcut: "Ctrl/⌘ D",
              disabled: !!node.data.enrichmentTable,
              onSelect: () => duplicate(node.id),
            },
            {
              id: "disconnect",
              label: "Disconnect connections",
              icon: Unplug,
              disabled: !connections.length,
              onSelect: () => removeEdges(connections),
            },
            {
              id: "remove",
              label: "Remove step",
              icon: Trash2,
              shortcut: "Delete",
              danger: true,
              onSelect: () => remove([node.id]),
            },
          ]
        : []),
    ];
  }

  function graphKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    pointerFocus.current = false;
    if (event.key === "Escape") clearConnectionHighlight();
    const target = event.target as HTMLElement;
    if (
      target.closest(
        'input,textarea,select,[contenteditable="true"],[role="menu"],[data-node-action]',
      )
    )
      return;
    const nodeId = target.closest(".react-flow__node")?.getAttribute("data-id");
    const edgeId = target.closest(".react-flow__edge")?.getAttribute("data-id");
    if (
      event.key === "Escape" &&
      !connectionGesture &&
      multiSelected.length > 1
    ) {
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "a"
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (selected && !closeSettings()) return;
      setNodes((previous) =>
        previous.map((node) =>
          node.data.enrichmentTable ? node : { ...node, selected: true },
        ),
      );
      return;
    }
    if (event.key === "Escape" && connectionGesture) {
      event.preventDefault();
      event.stopPropagation();
      connectionCancelled.current = true;
      if (reconnectGesture.current) reconnectGesture.current.cancelled = true;
      setConnectionGesture(null);
      return;
    }
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      event.stopPropagation();
      const item =
        target.closest(".react-flow__node,.react-flow__edge") || target;
      const bounds = item.getBoundingClientRect();
      if (nodeId || edgeId)
        openGraphMenu(
          nodeId ? "node" : "edge",
          (nodeId || edgeId)!,
          {
            x: bounds.left + Math.min(bounds.width, 80),
            y: bounds.top + Math.min(bounds.height, 50),
          },
          target,
        );
      else if (editable) openPicker();
      return;
    }
    if (
      event.key === "Enter" &&
      nodeId &&
      !target.closest(".react-flow__handle")
    ) {
      event.preventDefault();
      selectStep(nodeId);
      return;
    }
    if (!editable || busy) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      undo(event.shiftKey);
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "d" &&
      nodeId
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (multiSelected.length > 1 && multiSelected.includes(nodeId))
        duplicateSelection();
      else duplicate(nodeId);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      const selectedNodes = nodes.filter((n) => n.selected).map((n) => n.id);
      if (nodeId && !selectedNodes.includes(nodeId)) selectedNodes.push(nodeId);
      const selectedEdges = edges.filter(
        (edge) => edge.selected || edge.id === edgeId,
      );
      if (selectedNodes.length) remove(selectedNodes);
      else if (selectedEdges.length) removeEdges(selectedEdges);
      return;
    }
    const direction = (
      {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      } as Record<string, number[]>
    )[event.key];
    if (direction && nodeId && !target.closest(".react-flow__handle")) {
      event.preventDefault();
      event.stopPropagation();
      const distance = event.shiftKey ? 50 : 10;
      setAutoArrange(false);
      const moved = nodes.map((node) =>
        node.id === nodeId || node.selected
          ? {
              ...node,
              position: {
                x: node.position.x + direction[0] * distance,
                y: node.position.y + direction[1] * distance,
              },
            }
          : node,
      );
      replace(config, { nodes: moved, edges });
    }
  }

  function remove(ids: string[]) {
    if (!guardInspectorDrafts()) return;
    const tableNames = [
      ...new Set(
        nodes
          .filter((node) => ids.includes(node.id) && node.data.enrichmentTable)
          .map((node) => node.data.enrichmentTable),
      ),
    ];
    if (
      tableNames.length &&
      !confirm(
        `Remove memory table ${tableNames.join(", ")} and its export source?`,
      )
    )
      return;
    replace(ids.reduce((next, id) => removePipelineStep(next, id), config));
    if (selected && ids.includes(selected)) setSelected(null);
    requestAnimationFrame(() =>
      graphRef.current?.focus({ preventScroll: true }),
    );
  }
  function duplicate(nodeId = selected) {
    if (!guardInspectorDrafts()) return;
    if (!nodeId) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || node.data.enrichmentTable) return;
    const next = structuredClone(config);
    let name = nodeId + "_copy",
      i = 1;
    while (nodes.some((n) => n.id === name)) name = nodeId + "_copy" + i++;
    next[node.data.kind][name] = structuredClone(next[node.data.kind][nodeId]);
    replace(next);
    setSelected(name);
    requestAnimationFrame(() =>
      graphRef.current
        ?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${CSS.escape(name)}"]`,
        )
        ?.focus({ preventScroll: true }),
    );
  }
  // Steps a toolbar action or shortcut applies to: the canvas selection, or
  // the step whose properties are open.
  const multiSelected = nodes
    .filter((node) => node.selected && !node.data.enrichmentTable)
    .map((node) => node.id);
  function selectionIds() {
    return multiSelected.length ? multiSelected : selected ? [selected] : [];
  }
  function copySelection(clipboard?: DataTransfer | null) {
    const ids = selectionIds();
    if (!ids.length) return false;
    const text = stepsText(copySteps(config, ids));
    if (clipboard) clipboard.setData("text/plain", text);
    else void navigator.clipboard?.writeText(text).catch(() => {});
    notify(
      `Copied ${ids.length === 1 ? `${ids[0]}` : `${ids.length} steps`} as Vector YAML.`,
    );
    return true;
  }
  /** Add steps from Vector configuration text, placed in free space. */
  function pasteText(text: string) {
    if (!editable || busy || !guardInspectorDrafts()) return;
    try {
      const pasted = pasteSteps(config, text);
      const graph = toGraph(pasted.config, { nodes, edges });
      const originals = new Map(nodes.map((node) => [node.id, node]));
      const steps: BlockStep[] = [...pasted.ids].map(([from, to]) => {
        const kind = pasted.kinds.get(to) || "transforms";
        return {
          id: to,
          kind,
          component: pasted.config[kind][to],
          position: originals.get(from)?.position,
        };
      });
      // Copies of steps from this pipeline land just below the originals,
      // and steps from elsewhere at the top left of what is on screen.
      const known = steps.every((step) => step.position);
      const bounds = graphRef.current?.getBoundingClientRect();
      const origin = flow.current?.screenToFlowPosition({
        x: (bounds?.left ?? 0) + 120,
        y: (bounds?.top ?? 0) + 120,
      }) ?? { x: 80, y: 80 };
      const anchor = known
        ? {
            x: Math.min(...steps.map((step) => step.position!.x)) + 40,
            y: Math.min(...steps.map((step) => step.position!.y)) + 40,
          }
        : origin;
      const positions = placeBlock(nodes, steps, anchor);
      graph.nodes = graph.nodes.map((node) =>
        positions.has(node.id)
          ? { ...node, position: positions.get(node.id)!, selected: true }
          : { ...node, selected: false },
      );
      setAutoArrange(false);
      replace(pasted.config, graph);
      setSelected(null);
      notify(
        pasted.ids.size === 1
          ? `Pasted ${[...pasted.ids.values()][0]}.`
          : `Pasted ${pasted.ids.size} steps.`,
      );
    } catch (failure) {
      notify((failure as Error).message);
    }
  }
  function duplicateSelection() {
    const ids = selectionIds();
    if (ids.length === 1) duplicate(ids[0]);
    else if (ids.length) pasteText(stepsText(copySteps(config, ids)));
  }
  function clearSelection() {
    setNodes((previous) =>
      previous.map((node) =>
        node.selected ? { ...node, selected: false } : node,
      ),
    );
  }
  // Selecting several steps (Shift-drag, Ctrl-click, Ctrl+A) puts the
  // inspector away: it shows one step at a time.
  const selectingMany = multiSelected.length > 1;
  useEffect(() => {
    if (selectingMany && selected) closeSettings();
  }, [selectingMany]);
  function findStep(stepId: string) {
    const node = nodes.find((item) => item.id === stepId);
    setFindOpen(false);
    if (!node) return;
    selectStep(stepId);
    flow.current?.setCenter(
      node.position.x + PIPELINE_NODE_WIDTH / 2,
      node.position.y + PIPELINE_NODE_BODY_HEIGHT / 2,
      {
        zoom: Math.max(flow.current.getZoom(), 0.85),
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 220,
      },
    );
    requestAnimationFrame(() =>
      graphRef.current
        ?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${CSS.escape(stepId)}"]`,
        )
        ?.focus({ preventScroll: true }),
    );
  }
  function changeNodes(changes: NodeChange[]) {
    graphFromEdit.current = false;
    if (!editable) {
      // Controlled nodes must retain measurements across presentation updates;
      // otherwise ReactFlow removes and recreates their connected SVG edges.
      // Read-only users accept measurements only, never positions or mutations.
      const measurements = changes
        .filter((change) => change.type === "dimensions")
        .map((change) => ({
          id: change.id,
          type: "dimensions" as const,
          dimensions: change.dimensions,
        }));
      if (measurements.length)
        setNodes((previous) => applyNodeChanges(measurements, previous));
      return;
    }
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
    if (!editable || busy || !removed.length || !closeSettings()) return;
    try {
      const next = disconnect(config, removed);
      replace(next, toGraph(next, { nodes, edges }));
      requestAnimationFrame(() =>
        graphRef.current?.focus({ preventScroll: true }),
      );
      notify(
        `${removed.length === 1 ? "Connection" : "Connections"} disconnected. Undo restores ${removed.length === 1 ? "it" : "them"}.`,
      );
    } catch (failure) {
      notify((failure as Error).message);
    }
  }
  function stringify(value: Config, f = format) {
    return stringifyConfiguration(value, f);
  }
  function syncCode(value: Config) {
    try {
      setCode(stringify(value));
    } catch (failure) {
      setFormat("json");
      setCode(stringify(value, "json"));
      setError(
        `${(failure as Error).message} Showing the complete configuration as JSON.`,
      );
    }
  }
  function exportConfiguration() {
    if (!doc) return;
    try {
      download(
        `${doc.name.replace(/[^a-z0-9_-]/gi, "_")}.${format}`,
        view === "code" ? code : stringify(config),
      );
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  useEffect(() => {
    if (view === "code" && !importedCodeDirty.current) syncCode(config);
  }, [config, view, format]);
  function parse(value: string, f = format): Config {
    return parseSource(value, f);
  }
  function formatCode() {
    if (!editable) return;
    try {
      const formatted = stringify(parse(code));
      setCode(formatted);
      importedCodeDirty.current = formatted !== stringify(config);
      setError("");
      notify(`${format.toUpperCase()} formatted.`);
    } catch (failure) {
      notify(`Cannot format: ${(failure as Error).message}`);
    }
  }
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      notify("Code copied.");
    } catch {
      notify(
        "Clipboard access is unavailable. Select the code and copy it with Ctrl/Cmd+C.",
      );
    }
  }
  function changeView(next: string) {
    if (next !== view && view === "code" && importedCodeDirty.current) {
      setError("Apply or discard your Code changes before switching to Graph.");
      return;
    }
    if (next !== view && !closeSettings()) return;
    if (next === "code" && view !== "code") syncCode(config);
    if (toolsRef.current) toolsRef.current.open = false;
    setView(next);
  }
  async function importFile(file: File) {
    const generation = ++importGeneration.current;
    const before = importContext.current;
    if (!before.allowed) {
      notify(
        editable
          ? "Close the current dialog before importing a pipeline."
          : "This pipeline is read-only.",
      );
      return;
    }
    if (hasUnappliedImportFields()) {
      notify(
        "Apply or discard pending code and field changes before importing a pipeline.",
      );
      return;
    }
    try {
      const fileFormat = detectConfigurationFormat(file.name);
      if (file.size > MAX_CONFIGURATION_BYTES)
        throw Error("Configuration files must be 1 MiB or smaller.");
      const bytes = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw Error(
          "The file is not valid UTF-8. Save it as UTF-8 and try again.",
        );
      }
      if (generation !== importGeneration.current) return;
      const parsed = assertValidPipelineSource(text, fileFormat);
      const current = importContext.current;
      if (
        !current.allowed ||
        hasUnappliedImportFields() ||
        current.config !== before.config ||
        current.code !== before.code
      ) {
        notify(
          "The draft changed while the file was being read. Drop the file again to review it.",
        );
        return;
      }
      if (sameConfiguration(current.config, parsed)) {
        notify("This file already matches the pipeline.");
        return;
      }
      const candidate = {
        name: file.name,
        format: fileFormat,
        text,
        config: parsed,
        before: current.config,
      };
      if (isEmptyPipeline(current.config)) applyImportedPipeline(candidate);
      else setImportCandidate(candidate);
    } catch (failure) {
      if (generation === importGeneration.current)
        notify(`Import failed: ${(failure as Error).message}`);
    }
  }
  function applyImportedPipeline(candidate: ConfigurationImport) {
    const current = importContext.current;
    if (
      !current.allowed ||
      hasUnappliedImportFields() ||
      current.config !== candidate.before
    ) {
      setImportCandidate(null);
      notify(
        "The draft changed. Drop the file again to review the updated differences.",
      );
      return;
    }
    setImportCandidate(null);
    setSelected(null);
    setCanvasPicker(null);
    setError("");
    replace(candidate.config);
    setFormat(candidate.format);
    setCode(stringifyConfiguration(candidate.config, candidate.format));
    importedCodeDirty.current = false;
    notify(`Imported ${candidate.name}. You can undo this change.`);
    requestAnimationFrame(
      () => void flow.current?.fitView({ padding: 0.2, duration: 240 }),
    );
  }
  function hasUnappliedImportFields() {
    return importedCodeDirty.current || !!pendingSchemaFields.current.size;
  }
  // Check the draft (or unapplied Code edits) with the isolated Vector worker.
  // A check never locks the editor; a newer check or a reload supersedes it.
  async function validate({ auto = false } = {}) {
    if (checkInFlight.current) return;
    if (pendingSchemaFields.current.size) {
      if (!auto)
        setError(
          "Resolve or apply pending field changes before checking this pipeline.",
        );
      return;
    }
    let candidate = latest.current.config;
    if (view === "code" && importedCodeDirty.current) {
      const diagnosis = diagnoseConfigurationSource(code, format);
      if (!diagnosis.config) {
        if (!auto) setError("Fix the code syntax before checking it.");
        return;
      }
      candidate = diagnosis.config;
    }
    const candidateVariables = latest.current.variables;
    const candidateCode =
      candidate === latest.current.config ? undefined : code;
    const generation = ++checkGeneration.current;
    checkInFlight.current = true;
    setChecking(true);
    if (!auto) {
      setCheckError("");
      setProblemsOpen(true);
    }
    try {
      const result = await post<PipelineCheck>(
        `/configurations/${id}/validate`,
        { config: candidate },
      );
      if (generation !== checkGeneration.current) return;
      setCheck({
        result,
        config: candidate,
        variables: candidateVariables,
        code: candidateCode,
      });
      setCheckError("");
    } catch (e) {
      if (generation !== checkGeneration.current) return;
      // An automatic check that could not run (busy checker, lost session)
      // keeps the earlier findings and tries again after the next edit.
      if (!auto) setCheckError(checkFailureMessage(e));
    } finally {
      if (generation === checkGeneration.current) {
        checkInFlight.current = false;
        setChecking(false);
      }
    }
  }
  // Clears the saved request after the server confirms nothing was
  // committed under its key; false when that cannot be established.
  async function rejectedWithoutCommit(
    operation: PublishOperation,
    signal: AbortSignal,
  ) {
    try {
      const lookup = await withRequestDeadline(
        (lookupSignal) =>
          api(
            `/configurations/publish-requests/${operation.id}`,
            { signal: lookupSignal },
            PublishRequestLookupSchema,
          ),
        15000,
        signal,
      );
      if (lookup.request_id !== operation.id || lookup.found !== false)
        return false;
      finishPublishOperation(operation);
      return true;
    } catch {
      return false;
    }
  }
  function closePublishedResult() {
    setPublishedResult(null);
    setPublishOpen(false);
  }
  async function publish() {
    if (
      publishActive.current ||
      busy ||
      !can(user, "operate") ||
      unresolvedPublish ||
      publishNotice ||
      doc?.archived
    )
      return;
    const controller = new AbortController();
    publishActive.current = controller;
    setBusy(true);
    setError("");
    setPublishRejection(null);
    let operation: PublishOperation | null = null;
    const current = () =>
      publishMounted.current && publishActive.current === controller;
    try {
      if (saveUncertain.current || saveNeedsReload.current)
        throw Error(
          "Review the draft save result before publishing. Reload the server draft or retry Save draft first.",
        );
      if (importedCodeDirty.current || pendingSchemaFields.current.size)
        throw Error("Apply your code and field changes before publishing.");
      if (!diagnoseConfiguration(latest.current.config).locallyValid)
        throw Error("Resolve the pipeline errors before publishing.");
      if (
        variableErrors(latest.current.config, latest.current.variables).length
      )
        throw Error(
          "Resolve the device-specific variable fields before publishing.",
        );
      let saved = latest.current.doc;
      while (latest.current.dirty || pendingSave.current) {
        saved = await withRequestDeadline(
          (signal) => persist(false, undefined, signal),
          30000,
          controller.signal,
        );
        if (!current()) return;
        if (!saved) break;
      }
      if (!saved)
        throw Error(
          saveUncertain.current
            ? "The draft save result is unknown. Retry Save draft and review its result before publishing."
            : "Save your draft before publishing.",
        );
      operation = beginPublishOperation(user.id, id, {
        revision: saved.revision,
        message,
      });
      let lookup;
      try {
        lookup = await withRequestDeadline(
          (signal) =>
            api(
              `/configurations/publish-requests/${operation!.id}`,
              { signal },
              PublishRequestLookupSchema,
            ),
          30000,
          controller.signal,
        );
      } catch (failure) {
        if (failure instanceof APIError && [404, 405].includes(failure.status))
          throw Error(
            "Update the server to enable recoverable publishing. Review the saved request before publishing again.",
          );
        throw failure;
      }
      if (!current()) return;
      if (lookup.request_id !== operation.id)
        throw Error(
          "The server could not confirm recovery support. Review the saved request before publishing again.",
        );
      if (!publishOperationAvailable(operation))
        throw Error(
          "The saved request changed in another tab. Review it before publishing.",
        );
      // Even a found result for a fresh key must pass server payload binding.
      const version = await withRequestDeadline(
        (signal) =>
          api(
            `/configurations/${id}/publish`,
            {
              method: "POST",
              body: JSON.stringify(operation!.request),
              signal,
            },
            PublishReceiptSchema,
          ),
        30000,
        controller.signal,
      );
      if (!current()) return;
      assertPublishReceipt(operation, version);
      acceptPublishedVersion(version);
      try {
        finishPublishOperation(operation);
      } catch {
        setPublishNotice("confirmed");
        reportPublicationError(
          "The version is published, but this browser could not clear its reminder. Review the saved request to clear it when browser storage is available.",
        );
        return;
      }
      setMessage("");
      setPublishRejection(null);
      setPublishedResult(version);
    } catch (failure) {
      if (!current()) return;
      // A peer can send this shared intent while our preflight or POST waits,
      // so a structured rejection alone cannot rule out a committed result
      // under the same request key. It becomes definitive once the server
      // confirms that no version was committed under that key. That holds
      // for a structured 5xx too, such as an unavailable Vector checker.
      if (
        operation &&
        failure instanceof APIError &&
        failure.serverRejection &&
        failure.status >= 400 &&
        failure.code !== "IDEMPOTENCY_CONFLICT" &&
        (await rejectedWithoutCommit(operation, controller.signal))
      ) {
        if (!current()) return;
        setPublishRejection({ code: failure.code, message: failure.message });
        if (failure.code === "VALIDATION_FAILED") void validate();
        return;
      }
      if (!current()) return;
      if (operation) {
        setPublishNotice("uncertain");
      }
      reportPublicationError((failure as Error).message);
    } finally {
      if (publishActive.current === controller) publishActive.current = null;
      if (publishMounted.current) setBusy(false);
    }
  }
  async function saveDraftNow(confirmServerDraft = false, note?: string) {
    if (!editable || busy || explicitSaveInFlight.current) return;
    if (saveNeedsReload.current) {
      setError("The server draft changed. Reload it before saving again.");
      return;
    }
    if (hasUnappliedImportFields()) {
      setError(
        "Apply or discard unfinished code and field edits before saving the draft.",
      );
      return;
    }
    if (!latest.current.dirty && !(confirmServerDraft && saveUncertain.current))
      return;
    explicitSaveInFlight.current = true;
    setSavingDraft(true);
    setError("");
    try {
      return await persist(true, undefined, undefined, note);
    } finally {
      explicitSaveInFlight.current = false;
      setSavingDraft(false);
    }
  }
  function openSaveNote() {
    if (!editable || !latest.current.doc) return;
    const saved = latest.current.doc;
    setSaveNote(
      draftSummary(
        saved.config,
        latest.current.config,
        saved.variables || [],
        latest.current.variables,
      ),
    );
  }
  async function saveWithNote() {
    const note = saveNote;
    if (note === null) return;
    const saved = await saveDraftNow(false, note);
    if (saved) setSaveNote(null);
  }
  // Ctrl/Cmd+S saves the draft anywhere in the editor. The browser's own
  // "save page" never applies here, even when there is nothing to save.
  const saveShortcutState = useRef({ blocked: false, save: () => {} });
  saveShortcutState.current = {
    blocked:
      !editable ||
      historyOpen ||
      publishOpen ||
      globalsOpen ||
      detailsOpen ||
      discardOpen ||
      !!deployVersion ||
      !!pipelineAction ||
      !!importCandidate ||
      saveNote !== null,
    save: () => {
      if (hasUnappliedImportFields()) {
        setError(
          "Apply or discard unfinished code and field edits before saving the draft.",
        );
        return;
      }
      void saveDraftNow();
    },
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "s" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      const shortcut = saveShortcutState.current;
      if (!shortcut.blocked) shortcut.save();
    };
    // Capture phase: panels that stop key propagation still save.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // Canvas clipboard and find. They apply while the canvas (or nothing in
  // particular) has focus; text fields and code editors keep their own.
  const canvasShortcuts = useRef({
    active: false,
    copy: (_clipboard: DataTransfer | null): boolean => false,
    paste: (_text: string) => {},
    find: () => {},
  });
  canvasShortcuts.current = {
    active:
      view === "canvas" &&
      !historyOpen &&
      !publishOpen &&
      !globalsOpen &&
      !detailsOpen &&
      !discardOpen &&
      !deployVersion &&
      !pipelineAction &&
      !importCandidate &&
      saveNote === null,
    copy: copySelection,
    paste: pasteText,
    find: () => setFindOpen(true),
  };
  useEffect(() => {
    const onCanvas = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return false;
      if (
        target.closest(
          '.cm-editor, input, textarea, select, [contenteditable="true"], [role="dialog"]',
        )
      )
        return false;
      return (
        target === document.body ||
        !!graphRef.current?.contains(target) ||
        target.closest(".editor-workspace") !== null
      );
    };
    const onCopy = (event: ClipboardEvent) => {
      const shortcut = canvasShortcuts.current;
      if (!shortcut.active || !onCanvas(event)) return;
      if (window.getSelection()?.toString()) return;
      if (shortcut.copy(event.clipboardData)) event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      const shortcut = canvasShortcuts.current;
      if (!shortcut.active || !onCanvas(event)) return;
      const text = event.clipboardData?.getData("text/plain");
      if (!text?.trim()) return;
      event.preventDefault();
      shortcut.paste(text);
    };
    const onFind = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "f" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const shortcut = canvasShortcuts.current;
      if (!shortcut.active || !onCanvas(event)) return;
      event.preventDefault();
      shortcut.find();
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onFind);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onFind);
    };
  }, []);
  // Unsaved edits live in this browser until saved or discarded. While an
  // earlier copy awaits Restore or Discard it is not overwritten.
  useEffect(() => {
    if (!doc || !editable || recovery) return;
    if (!dirty) {
      clearRecoveryDraft(user.id, id);
      return;
    }
    const timer = window.setTimeout(
      () =>
        storeRecoveryDraft(user.id, id, {
          revision: doc.revision,
          config,
          variables,
          positions: Object.fromEntries(
            nodes.map((node) => [node.id, node.position]),
          ),
        }),
      800,
    );
    return () => window.clearTimeout(timer);
  }, [dirty, config, variables, nodes, doc?.revision, editable, recovery]);
  function restoreRecovery() {
    if (!recovery || !editable || !closeSettings()) return;
    replace(
      recovery.config,
      {
        nodes: Object.entries(recovery.positions).map(([nodeId, position]) => ({
          id: nodeId,
          position,
        })) as Graph["nodes"],
        edges: [],
      },
      true,
      recovery.variables,
    );
    setRecovery(null);
    notify("Unsaved changes restored. Save to keep them.");
  }
  function discardRecovery() {
    clearRecoveryDraft(user.id, id);
    setRecovery(null);
  }
  function applyTemplate(template: PipelineTemplate) {
    if (!editable || !isEmptyPipeline(config)) return;
    replace(structuredClone(template.config));
    setTemplateNeeds({ title: template.title, needs: template.needs });
  }
  // Vector's own metrics, exported for local scraping, without touching
  // existing steps or their names.
  function addMonitoring() {
    const next = withMonitoring(config);
    if (!next) {
      notify("This pipeline already exports Vector's internal metrics.");
      return;
    }
    replace(next);
    const added = Object.entries(next.sinks).find(
      ([sinkId]) => !Object.hasOwn(config.sinks || {}, sinkId),
    )?.[1] as Config | undefined;
    notify(
      `Added monitoring: Vector's internal metrics on ${added?.address} for Prometheus on the device.`,
    );
  }
  function openHistory() {
    if (toolsRef.current) toolsRef.current.open = false;
    setHistoryVersion(null);
    setHistoryOpen(true);
  }
  async function savedForAction(): Promise<Configuration> {
    if (pendingSave.current) await pendingSave.current;
    if (saveUncertain.current || saveNeedsReload.current)
      throw Error("Review the server draft before continuing.");
    if (latest.current.dirty)
      throw Error("Save or discard your changes before continuing.");
    const saved = latest.current.doc;
    if (!saved) throw Error("The pipeline could not be loaded.");
    return saved;
  }
  function acceptSavedSnapshot(
    result: Configuration,
    graph = toGraph(result.config, result.graph),
  ) {
    latest.current = {
      doc: result,
      config: result.config,
      variables: result.variables || [],
      nodes: graph.nodes,
      edges: graph.edges,
      dirty: false,
    };
    setDoc(result);
    setConfig(result.config);
    setVariables(result.variables || []);
    graphFromEdit.current = false;
    setNodes(graph.nodes);
    setEdges(graph.edges);
    syncCode(result.config);
    setSelected(null);
    setDirty(false);
    importedCodeDirty.current = false;
    stack.current = [];
    future.current = [];
    setSaveStatus("All changes saved");
  }
  function requestDiscard() {
    if (!editable || busy) return;
    if (saveUncertain.current || saveNeedsReload.current) {
      setError(
        "Review the server draft before discarding these local edits. Reload it, or retry Save draft if its result is unknown.",
      );
      return;
    }
    discardGate.current = true;
    setDiscardOpen(true);
    setCanvasPicker(null);
    pickerPlacement.current = null;
    pickerOpener.current = null;
    setGraphMenu(null);
    connectionCancelled.current = true;
    if (reconnectGesture.current) reconnectGesture.current.cancelled = true;
    setConnectionGesture(null);
    if (toolsRef.current) toolsRef.current.open = false;
  }
  function cancelDiscard() {
    if (busy) return;
    discardGate.current = false;
    setDiscardOpen(false);
  }
  async function discardChanges() {
    if (!editable || busy) return;
    setBusy(true);
    try {
      // An already-sent request may have saved an earlier edit. Keep that
      // acknowledged revision and discard only the local changes after it.
      if (pendingSave.current) await pendingSave.current;
      if (saveUncertain.current || saveNeedsReload.current) {
        setError(
          "Review the server draft before discarding these local edits. Reload it, or retry Save draft if its result is unknown.",
        );
        return;
      }
      const saved = latest.current.doc;
      if (!saved) return;
      importGeneration.current++;
      setImportCandidate(null);
      pendingSchemaFields.current.clear();
      setPendingFieldCount(0);
      setCodeAnalysis(null);
      setError("");
      acceptSavedSnapshot(saved, initialGraph(saved.config, saved.graph));
      notify("Unsaved changes discarded.");
    } finally {
      discardGate.current = false;
      setDiscardOpen(false);
      setBusy(false);
    }
  }
  async function openPipelineAction(action: PipelineAction) {
    if (busy) return;
    if (toolsRef.current) toolsRef.current.open = false;
    if (action === "duplicate" && unresolvedPipelineCreation) {
      const opener = toolsRef.current?.querySelector("summary");
      if (opener) pipelineCreationRecoveryRef.current?.openSaved(opener);
      return;
    }
    if (hasPendingFields) {
      setError(
        "Apply or resolve unfinished field changes before duplicating or archiving this pipeline.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await savedForAction();
      setPipelineAction({ action, configuration: saved });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function restoreSnapshot(source: {
    revision_id?: string;
    version_id?: string;
  }) {
    if (!editable || busy || hasPendingFields)
      throw Error(
        "Apply unfinished field changes before restoring a snapshot. Archived pipelines must be unarchived first.",
      );
    setBusy(true);
    setError("");
    try {
      const saved = await savedForAction();
      const restored = await post<Configuration>(
        `/configurations/${id}/restore`,
        { revision: saved.revision, ...source },
      );
      const graph = toGraph(restored.config, restored.graph);
      stack.current.push({
        config: latest.current.config,
        graph: { nodes: latest.current.nodes, edges: latest.current.edges },
        variables: latest.current.variables,
      });
      if (stack.current.length > 100) stack.current.shift();
      future.current = [];
      lastEdit.current = null;
      latest.current = {
        doc: restored,
        config: restored.config,
        variables: restored.variables || [],
        nodes: graph.nodes,
        edges: graph.edges,
        dirty: false,
      };
      setDoc(restored);
      setConfig(restored.config);
      setVariables(restored.variables || []);
      graphFromEdit.current = false;
      setNodes(graph.nodes);
      setEdges(graph.edges);
      syncCode(restored.config);
      setSelected(null);
      setDirty(false);
      importedCodeDirty.current = false;
      setSaveStatus("All changes saved");
      notify(
        `Restored as draft revision ${restored.revision}. Published versions and devices are unchanged.`,
      );
      return true;
    } finally {
      setBusy(false);
    }
  }
  const selectedNode = nodes.find((n) => n.id === selected);
  const patterns = useMemo(() => patternInputs(config), [config]);
  const patternEdgeList = useMemo(() => patternEdges(patterns), [patterns]);
  const component = selectedNode
    ? selectedNode.data.enrichmentTable
      ? config.enrichment_tables?.[selectedNode.data.enrichmentTable]
      : config[selectedNode.data.kind]?.[selectedNode.id]
    : null;
  // Stable while the steps feeding the selection are unchanged, so typing in
  // other steps doesn't re-run the tester.
  const upstreamText = useMemo(
    () =>
      selected && config.transforms?.[selected]
        ? JSON.stringify(upstreamOf(config, selected))
        : "",
    [config, selected],
  );
  const selectedUpstream = useMemo(
    () => (upstreamText ? JSON.parse(upstreamText) : undefined),
    [upstreamText],
  );
  const selectedProblems = useMemo(
    () =>
      selected
        ? problems.filter((problem) => problem.component === selected)
        : [],
    [problems, selected],
  );
  const hasPendingFields = !!(pendingFieldCount || importedCodeDirty.current);
  const displaySaveStatus = saveNeedsReload.current
    ? "Save conflict — reload server draft"
    : saveUncertain.current
      ? "Save status unknown — review server draft"
      : hasPendingFields
        ? "Unapplied field changes"
        : saveStatus;
  const definition = component
    ? catalog.find(
        (c) => c.type === component.type && c.kind === selectedNode.data.kind,
      )
    : null;
  function changeComponent(value: Config) {
    const table = selectedNode.data.enrichmentTable;
    if (!table) {
      // Only the edited step gets a new object, so unchanged steps keep their
      // identity for the canvas, the local checks and the undo history.
      const kind = selectedNode.data.kind;
      replace(
        { ...config, [kind]: { ...config[kind], [selectedNode.id]: value } },
        undefined,
        true,
        variables,
        editedField(selectedNode.id, component, value),
      );
      setError("");
      return;
    }
    const before = component.source_config?.source_key,
      after = value.source_config?.source_key;
    if (typeof after === "string" && before !== after) {
      try {
        componentName(config, after, before, [table]);
      } catch (failure) {
        setError((failure as Error).message);
        return;
      }
    }
    let next: Config = {
      ...config,
      enrichment_tables: { ...config.enrichment_tables, [table]: value },
    };
    if (
      typeof before === "string" &&
      typeof after === "string" &&
      before !== after &&
      after
    ) {
      next = retargetReferences(next, before, after);
      if (selected === before) setSelected(after);
    }
    replace(
      next,
      undefined,
      true,
      variables,
      editedField(table, component, value),
    );
    setError("");
  }
  function renameSelected(name: string) {
    if (
      !selectedNode ||
      selectedNode.data.enrichmentTable ||
      !guardInspectorDrafts()
    )
      return false;
    try {
      const next = renameComponent(config, selectedNode.id, name);
      const after = name.trim();
      replace(next, {
        nodes: nodes.map((node) =>
          node.id === selectedNode.id ? { ...node, id: after } : node,
        ),
        edges,
      });
      setSelected(after);
      setError("");
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    }
  }
  async function reloadLatest() {
    if (busy || pendingSave.current) return;
    const unresolved = saveUncertain.current;
    if (
      !confirm(
        unresolved
          ? "Reload the server draft and discard local edits? An earlier save may still finish afterward. Export your edits first if you want to keep them."
          : "Reload the server draft and discard local edits? Export your edits first if you want to keep them.",
      )
    )
      return;
    const before = {
      ...latest.current,
      code: importContext.current.code,
      pendingFields: pendingSchemaFields.current.size,
      importedCode: importedCodeDirty.current,
    };
    setBusy(true);
    try {
      const result = await withRequestDeadline(
        (signal) => api<Configuration>(`/configurations/${id}`, { signal }),
        30000,
      );
      if (
        before.doc !== latest.current.doc ||
        before.config !== latest.current.config ||
        before.variables !== latest.current.variables ||
        before.nodes !== latest.current.nodes ||
        before.edges !== latest.current.edges ||
        before.dirty !== latest.current.dirty ||
        before.code !== importContext.current.code ||
        before.pendingFields !== pendingSchemaFields.current.size ||
        before.importedCode !== importedCodeDirty.current
      ) {
        setError(
          "The editor changed while the server draft was loading. Reload again to review the latest version.",
        );
        return;
      }
      const graph = toGraph(result.config, result.graph);
      const earlierSaveCanStillFinish =
        unresolved &&
        uncertainSaveRevision.current !== null &&
        result.revision <= uncertainSaveRevision.current;
      saveUncertain.current = earlierSaveCanStillFinish;
      if (!earlierSaveCanStillFinish) uncertainSaveRevision.current = null;
      saveNeedsReload.current = false;
      acceptSavedSnapshot(result, graph);
      if (earlierSaveCanStillFinish) {
        setSaveStatus("Save status unknown — earlier save may still finish");
        setError(
          "Server draft reloaded. An earlier save may still finish and change it. Confirm this server draft to prevent that write from changing it.",
        );
      } else setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function guardInspectorDrafts() {
    if (
      pendingSchemaFields.current.size &&
      !confirm("Discard unapplied field changes?")
    )
      return false;
    return true;
  }
  function closeSettings() {
    if (!guardInspectorDrafts()) return;
    setSelected(null);
    setError("");
    return true;
  }
  function dismissInspector() {
    const closedId = selected;
    const previousFocus = document.activeElement;
    if (!closeSettings()) return;
    let attempts = 0;
    const returnFocus = () => {
      const graph = graphRef.current;
      if (!graph?.isConnected) return;
      const node = Array.from(
        graph.querySelectorAll<HTMLElement>(".react-flow__node"),
      ).find((element) => element.dataset.id === closedId);
      const active = document.activeElement;
      if (
        active !== document.body &&
        active !== previousFocus &&
        active !== node
      )
        return;
      // React Flow briefly hides nodes while measuring the wider canvas.
      if (
        node?.getClientRects().length &&
        getComputedStyle(node).visibility === "visible"
      ) {
        node.focus({ preventScroll: true });
        return;
      }
      if (++attempts < 12) requestAnimationFrame(returnFocus);
      else graph.focus({ preventScroll: true });
    };
    requestAnimationFrame(returnFocus);
  }
  function selectStep(stepId: string) {
    if (selected === stepId) return;
    if (!closeSettings()) return;
    setSelected(stepId);
    setError("");
  }
  // Open the step a problem belongs to and reveal the field and position.
  // Pipeline-wide problems open the matching pipeline settings section.
  function openProblem(problem: Problem) {
    // In Code, go to where the step (or the first syntax error) is written.
    if (view === "code") {
      const syntax = currentAnalysis?.diagnostics.find(
        (item) => item.severity === "error" && !item.componentId,
      );
      setCodeReveal({
        offset: problem.component
          ? sourceOffset(code, problem.component)
          : syntax?.from || 0,
        nonce: Date.now(),
      });
      return;
    }
    const node = problem.component
      ? nodes.find(
          (item) =>
            item.id === problem.component ||
            item.data.enrichmentTable === problem.component,
        )
      : undefined;
    if (!node) {
      tool(() => {
        setGlobalsSection(
          problem.section === "tests"
            ? "tests"
            : problem.section === "enrichment_tables"
              ? "enrichment_tables"
              : problem.code === "variables"
                ? "variables"
                : "general",
        );
        setGlobalsOpen(true);
      });
      return;
    }
    if (selected !== node.id) {
      if (!closeSettings()) return;
      setSelected(node.id);
    }
    setFocusRequest({
      component: node.id,
      field: problem.field,
      line: problem.line,
      column: problem.column,
      nonce: Date.now(),
    });
  }
  function canFixProblem(problem: Problem) {
    return (
      editable &&
      !!problem.fix &&
      !!problem.component &&
      !!problem.field &&
      !!config.transforms?.[problem.component]
    );
  }
  function fixProblem(problem: Problem) {
    if (!canFixProblem(problem)) return;
    if (pendingSchemaFields.current.size) {
      setError("Apply or discard pending field changes before applying a fix.");
      return;
    }
    const current = config.transforms[problem.component!];
    const text = vrlValue(current, problem.field!);
    const fixed = applyFix(text, problem);
    if (fixed === null || fixed === text) {
      notify(
        "The program changed since this check. Check again to refresh fixes.",
      );
      return;
    }
    replace({
      ...config,
      transforms: {
        ...config.transforms,
        [problem.component!]: withVrlValue(current, problem.field!, fixed),
      },
    });
    notify(`Applied: ${problem.fix!.label}.`);
  }
  function saveSampleTests(tests: Config[]) {
    if (!editable || !tests.length) return;
    replace({
      ...config,
      tests: [...(Array.isArray(config.tests) ? config.tests : []), ...tests],
    });
    notify(
      tests.length === 1
        ? `Added pipeline test “${tests[0].name}”. Save to keep it.`
        : `Added ${tests.length} pipeline tests. Save to keep them.`,
    );
  }
  function renameRoute(before: string, after: string) {
    if (!selectedNode) return;
    if (!guardInspectorDrafts()) return;
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(after) ||
      after === "_unmatched" ||
      component.route?.[after]
    ) {
      setError(
        "Use a unique output name with letters, numbers, underscores or hyphens.",
      );
      return;
    }
    const next = structuredClone(config),
      route = next.transforms[selectedNode.id].route;
    next.transforms[selectedNode.id].route = Object.fromEntries(
      Object.entries(route).map(([key, value]) => [
        key === before ? after : key,
        value,
      ]),
    );
    replace(
      retargetReferences(
        next,
        `${selectedNode.id}.${before}`,
        `${selectedNode.id}.${after}`,
      ),
    );
    setError("");
  }
  function removeRoute(name: string) {
    if (!selectedNode) return;
    if (!guardInspectorDrafts()) return;
    const next = structuredClone(config);
    delete next.transforms[selectedNode.id].route[name];
    for (const kind of ["transforms", "sinks", "enrichment_tables"])
      for (const c of Object.values(next[kind] || {}) as Config[])
        if (Array.isArray(c.inputs))
          c.inputs = c.inputs.filter(
            (ref: string) => ref !== `${selectedNode.id}.${name}`,
          );
    replace(next);
  }
  function tool(action: () => void) {
    if (!closeSettings()) return;
    if (toolsRef.current) toolsRef.current.open = false;
    action();
  }
  function openDetails(opener: HTMLElement) {
    if (busy) return;
    tool(() => {
      detailsReturnFocus.current = opener;
      setDetailsOpen(true);
    });
  }
  const matchesPublished =
    publishedVersionStatus === "ready" &&
    !!publishedVersion &&
    publishedDraft &&
    !importedCodeDirty.current;
  const publishNotePlaceholder =
    publishOpen && publishedVersion
      ? draftSummary(
          publishedVersion.config,
          config,
          publishedVersion.variables || [],
          variables,
        )
      : "What changed in this version?";
  // Opening the review checks the draft when auto-check is on and the last
  // check does not describe it.
  useEffect(() => {
    if (
      publishOpen &&
      !publishedResult &&
      autoCheck &&
      checkable &&
      (!check || checkStale) &&
      !checking
    )
      void validate({ auto: true });
  }, [publishOpen]);
  // Where this pipeline's versions are assigned, read when the review opens.
  useEffect(() => {
    if (!publishOpen || publishedResult) return;
    let alive = true;
    const controller = new AbortController();
    setPublishReach(null);
    Promise.all([
      withRequestDeadline(
        (signal) => api<Device[]>("/devices", { signal }),
        15000,
        controller.signal,
      ),
      withRequestDeadline(
        (signal) =>
          api<{ items: { id: string; number: number }[] }>(
            `/configurations/${id}/history?kind=versions&page=1&page_size=50`,
            { signal },
          ),
        15000,
        controller.signal,
      ),
    ])
      .then(([devices, history]) => {
        if (alive)
          setPublishReach(
            reachLabel(deviceReach(devices, history.items || [])),
          );
      })
      .catch(() => {
        if (alive) setPublishReach("Device assignments are unavailable.");
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [publishOpen, publishedResult, id]);
  const saveIndicator = (
    <PipelineSaveStatus
      status={displaySaveStatus}
      publishedVersionNumber={
        matchesPublished ? publishedVersion!.number : undefined
      }
      archived={!!doc?.archived}
    />
  );
  const inlineSettings = !!component && !!selectedNode && view === "canvas";
  const memorySchema = selectedNode?.data.enrichmentTable
    ? resolveSchema(
        resolveSchema(vectorSchema, vectorSchema, config).properties
          .enrichment_tables,
        vectorSchema,
        config.enrichment_tables,
      ).additionalProperties
    : null;
  const memoryIssues = selectedNode?.data.enrichmentTable
    ? issues.filter((issue) =>
        issueAffectsMemoryTable(issue, selectedNode.data.enrichmentTable),
      )
    : [];
  const settingsContent =
    component && selectedNode ? (
      selectedNode.data.enrichmentTable ? (
        <div className="memory-table-settings">
          <p>
            Settings for <strong>{selectedNode.data.enrichmentTable}</strong>,
            shared by its input and export source.{" "}
            <DocLink topic="resources" section="enrich-events-with-local-data">
              About enrichment tables
            </DocLink>
          </p>
          {memoryIssues.length > 0 && (
            <div className="pipeline-field-errors" role="status">
              <strong>Finish this table</strong>
              <ul>
                {memoryIssues.map((issue) => (
                  <li key={issue.message}>{issue.message}</li>
                ))}
              </ul>
            </div>
          )}
          <PipelineSchemaFields
            schema={memorySchema || { type: "object" }}
            root={vectorSchema}
            component={component}
            onChange={changeComponent}
            editable={editable}
            onPendingChange={schemaPendingChange}
            fieldPickerTarget={fieldPickerTarget}
          />
        </div>
      ) : (
        <PipelineSettings
          key={selectedNode.id}
          id={selectedNode.id}
          kind={selectedNode.data.kind}
          component={component}
          editable={editable}
          fieldPickerTarget={fieldPickerTarget}
          issues={issues
            .filter((issue) => issue.id === selectedNode.id)
            .map((issue) => issue.message)}
          problems={selectedProblems}
          onChange={changeComponent}
          onPendingChange={schemaPendingChange}
          onRouteRename={renameRoute}
          onRouteRemove={removeRoute}
          pipelineId={id}
          userId={user.id}
          timezone={
            typeof config.timezone === "string" ? config.timezone : undefined
          }
          canRunSamples={checkable}
          existingTests={Array.isArray(config.tests) ? config.tests : []}
          onSaveTests={editable ? saveSampleTests : undefined}
          focus={
            focusRequest?.component === selectedNode.id ? focusRequest : null
          }
          upstream={selectedUpstream}
          inputPatterns={patterns.filter(
            (input) => input.target === selectedNode.id,
          )}
        />
      )
    ) : null;
  const problemsPanel = (
    <ProblemsPanel
      problems={problems}
      config={config}
      open={problemsOpen}
      onOpenChange={setProblemsOpen}
      verdict={
        problemCounts.errors && !checkError && !checkStale
          ? "Fix the errors to publish."
          : verdict
      }
      autoCheck={checkable ? autoCheck : undefined}
      onAutoCheckChange={checkable ? changeAutoCheck : undefined}
      onSelect={openProblem}
      onFix={fixProblem}
      checking={checking}
      canFix={canFixProblem}
      status={status}
      onCheck={checkable ? () => void validate() : undefined}
    />
  );
  function fitGraph() {
    flow.current?.fitView({
      padding: 0.1,
      minZoom: 0.15,
      maxZoom: 1,
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 0
        : 220,
    });
  }
  const viewportContext = useRef({ selected, view, nodeCount: nodes.length });
  useEffect(() => {
    const previous = viewportContext.current;
    viewportContext.current = { selected, view, nodeCount: nodes.length };
    if (view !== "canvas") return;
    if (
      previous.selected &&
      !selected &&
      previous.view === view &&
      previous.nodeCount === nodes.length
    ) {
      // Closing properties must not move a target under the next pointer click.
      // Stop an unfinished opening animation without reframing the canvas.
      const instance = flow.current;
      if (instance)
        void instance.setViewport(instance.getViewport(), { duration: 0 });
      return;
    }
    const timer = window.setTimeout(() => {
      const duration = window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
        ? 0
        : 220;
      const node = selected ? nodes.find((node) => node.id === selected) : null;
      if (node && nodeInView(node)) return;
      if (node)
        flow.current?.setCenter(
          node.position.x + PIPELINE_NODE_WIDTH / 2,
          node.position.y + PIPELINE_NODE_BODY_HEIGHT / 2,
          { zoom: flow.current.getZoom(), duration },
        );
      else
        flow.current?.fitView({
          padding: 0.12,
          minZoom: nodes.length <= 8 ? 0.65 : 0.15,
          maxZoom: 1,
          duration,
        });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [selected, view, nodes.length]);
  /** Whether a node is fully visible in the canvas as laid out now. */
  function nodeInView(node: { position: { x: number; y: number } }) {
    const instance = flow.current,
      pane = graphRef.current?.querySelector(".react-flow");
    if (!instance || !pane) return false;
    const bounds = pane.getBoundingClientRect();
    const { x, y, zoom } = instance.getViewport();
    const left = node.position.x * zoom + x,
      top = node.position.y * zoom + y;
    return (
      left >= 0 &&
      top >= 0 &&
      left + PIPELINE_NODE_WIDTH * zoom <= bounds.width &&
      top + PIPELINE_NODE_BODY_HEIGHT * zoom <= bounds.height
    );
  }
  useEffect(() => {
    if (!selected || view !== "canvas" || historyOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      // Escape belongs to the control that has focus first: completion
      // popups, code editors (Escape then Tab leaves them), fields and menus.
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !target?.closest(
          '.cm-editor, input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"]',
        ) &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        dismissInspector();
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  });
  // Canvas objects are rebuilt only for nodes and edges whose inputs changed,
  // so React Flow re-renders just what an edit touched.
  graphHandlers.current = {
    nodeMenu: (nodeId, position, opener) => {
      if (
        graphMenu?.kind === "node" &&
        graphMenu.id === nodeId &&
        graphMenu.opener === opener
      )
        setGraphMenu(null);
      else openGraphMenu("node", nodeId, position, opener);
    },
    edgeMenu: (edgeId, position, opener) =>
      openGraphMenu("edge", edgeId, position, opener),
    edgeHover: (edgeId, hovered) => hoverConnection(edgeId, hovered),
    edgeInsert: (edgeId, position) => insertOnEdge(edgeId, position),
  };
  if (flowCache.current.size > 4 * (nodes.length + edges.length) + 64)
    flowCache.current.clear();
  const nodeKinds = new Map(nodes.map((node) => [node.id, node.data.kind]));
  const currentFlowNodes = nodes.map((node) => {
    const highlight = highlightedConnection
      ? [highlightedConnection.source, highlightedConnection.target].includes(
          node.id,
        )
        ? "endpoint"
        : "dimmed"
      : undefined;
    const problem = nodeProblemData(node),
      ports = validPorts.get(node.id),
      outputs = ports?.outputs || [],
      isSelected = node.id === selected || !!node.selected,
      menuOpen = graphMenu?.kind === "node" && graphMenu.id === node.id,
      warning = connectivity.get(node.id),
      reading =
        liveOn && !node.data.enrichmentTable
          ? nodeLive(liveData, node.id)
          : undefined;
    const liveKey = reading === undefined ? "" : JSON.stringify(reading);
    return cachedFlowObject(
      `node:${node.id}`,
      [
        node,
        liveKey,
        highlight,
        isSelected,
        problem.hasIssue,
        problem.issueCount,
        problem.issueMessage,
        problem.warningMessage,
        warning,
        editable && !busy,
        menuOpen,
        !!connectionGesture,
        ports?.input || false,
        outputs.join("\n"),
      ],
      () => ({
        ...node,
        ariaLabel: `${componentTitle(
          String(node.data.component?.type || ""),
          node.data.kind,
          {
            enrichmentTable: node.data.enrichmentTable,
            implicitSource: node.data.implicitSource,
          },
        )} ${node.id}${problem.hasIssue ? ", has problems" : ""}`,
        domAttributes: {
          ...node.domAttributes,
          "data-connection-highlight": highlight,
        },
        selected: isSelected,
        data: {
          ...node.data,
          ...problem,
          live: reading,
          connectivityWarning: warning,
          editable: editable && !busy,
          openMenu: stableHandlers(`node:${node.id}`).menu,
          menuOpen,
          connectionActive: !!connectionGesture,
          validInputTarget: ports?.input || false,
          validOutputTargets: outputs,
        },
      }),
    );
  });
  const currentFlowEdges = edges.map((edge) => {
    const highlight = highlightedConnection
      ? highlightedConnection.id === edge.id
        ? "active"
        : "dimmed"
      : undefined;
    const category = nodeKinds.get(edge.source) || "transforms";
    const rate = liveOn
      ? edgeRate(liveData, edge.source, edge.sourceHandle || "output")
      : undefined;
    return cachedFlowObject(
      `edge:${edge.id}`,
      [edge, highlight, category, editable, connectionStyle, rate],
      () => ({
        ...edge,
        type: "pipeline",
        className: "pipeline-connection",
        ariaLabel: `Connection from ${edge.source}${edge.sourceHandle && edge.sourceHandle !== "output" ? "." + edge.sourceHandle : ""} to ${edge.target}${rate === undefined ? "" : rate === null ? ", no live data" : `, ${formatRate(rate)} events`}`,
        domAttributes: {
          ...edge.domAttributes,
          "data-connection-highlight": highlight,
          "data-pipeline-category": category,
        } as Edge["domAttributes"],
        data: {
          editable,
          connectionStyle,
          liveRate: rate,
          connectionHighlight: highlight,
          onHoverChange: stableHandlers(`edge:${edge.id}`).hover,
          openMenu: stableHandlers(`edge:${edge.id}`).menu,
          insertStep: editable
            ? stableHandlers(`edge:${edge.id}`).insert
            : undefined,
        },
      }),
    );
  });
  // Wildcard inputs draw a dashed, read-only line to each output they match.
  const currentPatternEdges = patternEdgeList.map((edge) => {
    const category = nodeKinds.get(edge.source) || "transforms";
    const rate = liveOn
      ? edgeRate(liveData, edge.source, edge.sourceHandle)
      : undefined;
    return cachedFlowObject(
      `pattern:${edge.id}`,
      [edge, category, connectionStyle, rate],
      () => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: edge.targetHandle,
        type: "pipeline",
        className: "pipeline-connection pipeline-connection-pattern",
        selectable: false,
        focusable: false,
        deletable: false,
        reconnectable: false,
        ariaLabel: `Wildcard input ${edge.pattern}: ${edge.source}${edge.sourceHandle !== "output" ? "." + edge.sourceHandle : ""} to ${edge.target}`,
        domAttributes: {
          "data-pipeline-category": category,
        } as Edge["domAttributes"],
        data: {
          editable: false,
          connectionStyle,
          pattern: edge.pattern,
          patternMore: edge.more,
          liveRate: rate,
        },
      }),
    );
  });
  // Canvas arrays keep their identity while no element changed, and a config
  // edit reaches the canvas in a deferred render: a keystroke paints the
  // inspector first and the node summary follows. Drags and selections stay
  // immediate.
  const flowNodes = stableArray(flowNodeArray, currentFlowNodes),
    flowEdges = stableArray(flowEdgeArray, [
      ...currentFlowEdges,
      ...currentPatternEdges,
    ]);
  const deferredFlowNodes = useDeferredValue(flowNodes),
    deferredFlowEdges = useDeferredValue(flowEdges);
  const canvasNodes = graphFromEdit.current ? deferredFlowNodes : flowNodes,
    canvasEdges = graphFromEdit.current ? deferredFlowEdges : flowEdges;
  if (!doc)
    return error ? (
      <section
        className="editor-load-error"
        aria-labelledby="editor-load-title"
      >
        <h1 id="editor-load-title">Couldn&apos;t open this pipeline</h1>
        <p>Try again or return to Pipelines. No draft changes were sent.</p>
        <ErrorBox message={error} />
        <Button
          icon={RefreshCw}
          onClick={() => setLoadAttempt((attempt) => attempt + 1)}
        >
          Retry opening pipeline
        </Button>
        <Button
          variant="secondary"
          onClick={() => navigate(pipelineRoute(undefined, initialDeviceId))}
        >
          Back to pipelines
        </Button>
      </section>
    ) : (
      <div className="loading">
        <Spinner />
        Opening pipeline
      </div>
    );
  return (
    <div className="editor-page editor-redesigned">
      <div className="editor-header">
        <div className="editor-title">
          <button
            className="editor-back"
            disabled={busy}
            onClick={() => {
              if (busy) return;
              if (historyOpen) setHistoryOpen(false);
              else navigate(pipelineRoute(undefined, initialDeviceId));
            }}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            {historyOpen ? "Back to editor" : "Pipelines"}
          </button>
          <div className="page-title-row">
            <h1 aria-label={doc.name}>
              <button
                type="button"
                className="editor-details-trigger editor-name-trigger"
                ref={detailsTitleRef}
                aria-label={`${editable ? "Edit" : "View"} pipeline details: ${doc.name}`}
                title={
                  editable ? "Edit pipeline details" : "View pipeline details"
                }
                disabled={busy}
                onClick={(event) => openDetails(event.currentTarget)}
              >
                <span>{doc.name}</span>
                {editable && <Pencil size={14} aria-hidden="true" />}
              </button>
            </h1>
            <HelpLink
              topic="pipelines"
              section="add-and-connect-components"
              label="Help for the pipeline editor"
            />
          </div>
          {(doc.description || editable) && (
            <p className="editor-description">
              <button
                type="button"
                className={`editor-details-trigger editor-description-trigger${doc.description ? "" : " editor-description-empty"}`}
                aria-label={
                  editable
                    ? "Edit pipeline description"
                    : "View pipeline description"
                }
                title={
                  editable
                    ? "Edit pipeline description"
                    : "View pipeline description"
                }
                disabled={busy}
                onClick={(event) => openDetails(event.currentTarget)}
              >
                {doc.description || "Add description"}
              </button>
            </p>
          )}
        </div>
      </div>
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
      {(error ||
        saveUncertain.current ||
        saveNeedsReload.current ||
        saveStatus.startsWith("Save failed")) &&
        (historyOpen ||
          !selected ||
          saveUncertain.current ||
          saveNeedsReload.current) &&
        !pickerKind &&
        !canvasPicker &&
        !publishOpen && (
          <div className="editor-message">
            <ErrorBox
              message={
                error ||
                (saveNeedsReload.current
                  ? "The server draft changed. Reload it before continuing."
                  : saveUncertain.current
                    ? "The draft save was not confirmed. Reload the server draft or retry Save draft."
                    : "The draft save failed. Your edits are still here.")
              }
            />
            {(saveStatus.startsWith("Save failed") ||
              saveUncertain.current ||
              saveNeedsReload.current) && (
              <Button variant="secondary" onClick={reloadLatest}>
                Reload server draft
              </Button>
            )}
            {saveUncertain.current && dirty && (
              <Button
                variant="secondary"
                disabled={savingDraft || hasPendingFields}
                onClick={() => void saveDraftNow()}
              >
                Retry Save draft
              </Button>
            )}
            {saveUncertain.current && !dirty && (
              <Button
                variant="secondary"
                disabled={savingDraft || hasPendingFields}
                onClick={() => void saveDraftNow(true)}
              >
                Confirm server draft
              </Button>
            )}
          </div>
        )}
      {doc.archived && !historyOpen ? (
        <div className="editor-archive-note">
          <p>
            <strong>Archived pipeline.</strong> The draft is read-only.
            Published versions and running deployments remain available.
          </p>
          {can(user, "edit") && (
            <Button
              variant="secondary compact"
              disabled={busy}
              onClick={() => void openPipelineAction("unarchive")}
            >
              Unarchive pipeline
            </Button>
          )}
        </div>
      ) : (
        !doc.archived &&
        !editable && (
          <p className="editor-readonly">
            {can(user, "operate")
              ? "You can publish and deploy this draft. An editor or administrator can change its steps."
              : "You have read-only access to this pipeline."}
          </p>
        )
      )}
      {initialDeviceId && (
        <SelectedDevice
          id={initialDeviceId}
          onClear={() => navigate(pipelineRoute(id))}
        />
      )}
      {can(user, "operate") && !busy && (
        <PublishRecovery
          ref={publishRecoveryRef}
          user={user}
          configurationId={id}
          showRecent={false}
          onRecovered={acceptPublishedVersion}
          onReview={(version) => {
            if (!closeSettings()) return false;
            setHistoryVersion(version);
            setHistoryOpen(true);
            return true;
          }}
        />
      )}
      {can(user, "edit") && !busy && (
        <PipelineCreationRecovery
          ref={pipelineCreationRecoveryRef}
          user={user}
          showRecent={false}
          onRecovered={() => {
            /* Recovery never replaces this editor's draft. */
          }}
          onReview={(result) => {
            if (result.id === id) return true;
            navigate(pipelineRoute(result.id, initialDeviceId, destination));
            // App checks unfinished edits when processing the route. Keep the
            // receipt open if navigation is declined; success unmounts it.
            return false;
          }}
        />
      )}
      {historyOpen && (
        <PipelineHistory
          key={historyVersion?.id || "history"}
          initialVersion={historyVersion}
          saveIndicator={saveIndicator}
          configuration={doc}
          draft={config}
          hasPendingFields={hasPendingFields}
          user={user}
          onClose={() => setHistoryOpen(false)}
          onRestore={restoreSnapshot}
          onDeploy={setDeployVersion}
        />
      )}
      <div
        className="editor-draft-workspace"
        style={historyOpen ? { display: "none" } : undefined}
        inert={busy}
        onDragEnterCapture={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (++dragDepth.current === 1 && editable) setDraggingFile(true);
        }}
        onDragOverCapture={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = editable ? "copy" : "none";
        }}
        onDragLeaveCapture={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          if (--dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDraggingFile(false);
          }
        }}
        onDropCapture={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          dragDepth.current = 0;
          setDraggingFile(false);
          if (event.dataTransfer.files.length !== 1) {
            importGeneration.current++;
            notify("Drop one YAML, JSON, or TOML file at a time.");
            return;
          }
          void importFile(event.dataTransfer.files[0]);
        }}
      >
        {draggingFile && (
          <div className="editor-file-drop-hint" aria-hidden="true">
            <Upload size={26} />
            <strong>Drop a pipeline file</strong>
            <span>YAML, JSON, or TOML · up to 1 MiB</span>
          </div>
        )}
        <div className="editor-toolbar" aria-label="Pipeline toolbar">
          <nav className="editor-view-switch" aria-label="Pipeline view">
            {[
              { id: "canvas", label: "Graph", icon: Workflow },
              { id: "code", label: "Code", icon: Code2 },
            ].map((item) => (
              <button
                key={item.id}
                ref={view === item.id ? discardReturnFocus : undefined}
                aria-pressed={view === item.id}
                onClick={() => changeView(item.id)}
              >
                <TabLabel icon={item.icon}>{item.label}</TabLabel>
              </button>
            ))}
          </nav>
          <div className="editor-toolbar-actions">
            <div className="editor-toolbar-secondary">
              {editable && (dirty || hasPendingFields) && (
                <Button
                  variant="ghost compact"
                  className="editor-discard-changes"
                  icon={RotateCcw}
                  disabled={busy}
                  onClick={requestDiscard}
                >
                  Discard changes
                </Button>
              )}
              {checkable && (
                <PipelineCheckButton
                  key={id}
                  status={status}
                  label={statusLabel}
                  description={
                    checking ? "Checking the pipeline with Vector…" : verdict
                  }
                  feedbackId={checkFeedbackId}
                  disabled={busy}
                  hidden={historyOpen}
                  onCheck={() => {
                    setProblemsOpen(true);
                    void validate();
                  }}
                />
              )}
              <IconButton
                icon={Settings2}
                label="Pipeline settings"
                onClick={() =>
                  tool(() => {
                    setGlobalsSection("general");
                    setGlobalsOpen(true);
                  })
                }
              />
            </div>
            <div className="editor-header-actions" inert={busy}>
              <details
                ref={toolsRef}
                className="editor-tools-menu"
                style={historyOpen ? { display: "none" } : undefined}
              >
                <summary>
                  Actions <MoreHorizontal size={17} aria-hidden="true" />
                </summary>
                <div>
                  {editable && (
                    <button
                      onClick={(event) =>
                        openDetails(
                          toolsRef.current?.querySelector("summary") ||
                            event.currentTarget,
                        )
                      }
                    >
                      <FileText size={16} aria-hidden="true" />
                      Pipeline details
                    </button>
                  )}
                  <button onClick={openHistory}>
                    <History size={16} aria-hidden="true" />
                    Version history
                  </button>
                  {editable && (
                    <button onClick={() => tool(addMonitoring)}>
                      <Activity size={16} aria-hidden="true" />
                      Add monitoring
                    </button>
                  )}
                  {can(user, "operate") && (
                    <button
                      onClick={() => {
                        const opener =
                          toolsRef.current?.querySelector("summary");
                        if (toolsRef.current) toolsRef.current.open = false;
                        if (opener)
                          publishRecoveryRef.current?.openRecent(opener);
                      }}
                    >
                      <History size={16} aria-hidden="true" />
                      Your publish requests
                    </button>
                  )}
                  {can(user, "edit") && (
                    <button
                      onClick={() => {
                        const opener =
                          toolsRef.current?.querySelector("summary");
                        if (toolsRef.current) toolsRef.current.open = false;
                        if (opener)
                          pipelineCreationRecoveryRef.current?.openRecent(
                            opener,
                          );
                      }}
                    >
                      <History size={16} aria-hidden="true" />
                      Your pipeline requests
                    </button>
                  )}
                  {can(user, "edit") && (
                    <>
                      <button
                        onClick={() => void openPipelineAction("duplicate")}
                      >
                        <Copy size={16} aria-hidden="true" />
                        Duplicate pipeline
                      </button>
                      <button
                        onClick={() =>
                          void openPipelineAction(
                            doc.archived ? "unarchive" : "archive",
                          )
                        }
                      >
                        {doc.archived ? (
                          <ArchiveRestore size={16} aria-hidden="true" />
                        ) : (
                          <Archive size={16} aria-hidden="true" />
                        )}
                        {doc.archived
                          ? "Unarchive pipeline"
                          : "Archive pipeline"}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() =>
                      tool(() => {
                        setGlobalsSection("general");
                        setGlobalsOpen(true);
                      })
                    }
                  >
                    <Settings2 size={16} aria-hidden="true" />
                    Pipeline settings
                  </button>
                  {editable && (
                    <button
                      disabled={!future.current.length}
                      onClick={() => tool(() => undo(true))}
                    >
                      <Redo2 size={16} aria-hidden="true" />
                      Redo last change
                    </button>
                  )}
                  {editable && (
                    <button
                      onClick={() => tool(() => fileRef.current?.click())}
                    >
                      <Upload size={16} aria-hidden="true" />
                      Import configuration file
                    </button>
                  )}
                  <button onClick={() => tool(exportConfiguration)}>
                    <Download size={16} aria-hidden="true" />
                    Export configuration
                  </button>
                </div>
              </details>
              {saveIndicator}
              {!historyOpen && (can(user, "operate") || editable) && (
                <div
                  className="editor-primary-action"
                  role="group"
                  aria-label="Pipeline save and publish actions"
                >
                  {editable && (
                    <div className="editor-save-split">
                      <Button
                        variant="secondary"
                        className="editor-save-button"
                        icon={Save}
                        busy={savingDraft}
                        disabled={busy || hasPendingFields || !dirty}
                        aria-keyshortcuts="Control+S Meta+S"
                        title={
                          hasPendingFields
                            ? "Apply unfinished code and field edits before saving"
                            : dirty
                              ? `Save draft (${saveShortcut})`
                              : "No unsaved changes"
                        }
                        onClick={() => void saveDraftNow()}
                      >
                        Save
                      </Button>
                      <DropdownMenu.Root
                        modal={false}
                        onOpenChange={(open) => {
                          if (open && toolsRef.current)
                            toolsRef.current.open = false;
                        }}
                      >
                        <DropdownMenu.Trigger asChild>
                          <button
                            type="button"
                            className="button secondary editor-save-trigger"
                            aria-label="Save options"
                            title="Save options"
                            disabled={busy || savingDraft}
                          >
                            <ChevronDown size={15} aria-hidden="true" />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            className="editor-save-menu"
                            align="end"
                            sideOffset={6}
                            collisionPadding={12}
                            aria-label="Save options"
                            loop
                            onEscapeKeyDown={(event) => event.stopPropagation()}
                          >
                            <DropdownMenu.Item
                              className="editor-save-menu-item"
                              disabled={
                                hasPendingFields ||
                                !dirty ||
                                busy ||
                                savingDraft
                              }
                              onSelect={() => void saveDraftNow()}
                              aria-keyshortcuts="Control+S Meta+S"
                            >
                              <Save size={16} aria-hidden="true" />
                              Save draft
                              <kbd
                                className="editor-save-menu-shortcut"
                                aria-hidden="true"
                              >
                                {saveShortcut}
                              </kbd>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className="editor-save-menu-item"
                              disabled={
                                hasPendingFields ||
                                !dirty ||
                                busy ||
                                savingDraft
                              }
                              onSelect={openSaveNote}
                            >
                              <MessageSquareText size={16} aria-hidden="true" />
                              Save with note…
                            </DropdownMenu.Item>
                            {hasPendingFields && (
                              <p className="editor-save-menu-hint">
                                Apply unfinished code and field edits before
                                saving.
                              </p>
                            )}
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </div>
                  )}
                  {can(user, "operate") && (
                    <Button
                      className="editor-primary-button"
                      icon={
                        publishedVersionStatus === "failed"
                          ? RefreshCw
                          : matchesPublished || doc.archived
                            ? Server
                            : FileCheck2
                      }
                      busy={busy}
                      disabled={
                        publishedVersionStatus === "loading" ||
                        (publishedVersionStatus === "ready" &&
                          ((!!doc.archived && !publishedVersion) ||
                            (!matchesPublished &&
                              !doc.archived &&
                              unresolvedPublish)))
                      }
                      title={
                        publishedVersionStatus === "failed"
                          ? `Could not check the published version: ${publishedVersionError}. Retry without reloading your draft.`
                          : !matchesPublished && unresolvedPublish
                            ? "Review the saved publish request before publishing again"
                            : undefined
                      }
                      onClick={() => {
                        if (publishedVersionStatus === "failed") {
                          retryPublishedVersion();
                          return;
                        }
                        if (publishedVersionStatus !== "ready") return;
                        if (doc.archived && publishedVersion) {
                          setDeployVersion(publishedVersion);
                          return;
                        }
                        if (!closeSettings()) return;
                        if (matchesPublished)
                          setDeployVersion(publishedVersion);
                        else {
                          setPublishNotice(null);
                          setError("");
                          setPublishOpen(true);
                        }
                      }}
                    >
                      {publishedVersionStatus === "loading"
                        ? "Checking version"
                        : publishedVersionStatus === "failed"
                          ? "Retry version check"
                          : doc.archived && !publishedVersion
                            ? "No published version"
                            : matchesPublished || doc.archived
                              ? "Choose devices"
                              : "Review & publish"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        {templateNeeds && editable && (
          <div className="editor-recovery" role="status">
            <FileText size={16} aria-hidden="true" />
            <p>
              <strong>{templateNeeds.title} is ready to adjust.</strong>{" "}
              You&apos;ll need: {templateNeeds.needs.join(" ")}
            </p>
            <Button
              variant="ghost compact"
              onClick={() => setTemplateNeeds(null)}
            >
              Dismiss
            </Button>
          </div>
        )}
        {recovery && editable && (
          <div className="editor-recovery" role="status">
            <History size={16} aria-hidden="true" />
            <p>
              <strong>
                Unsaved changes from {when(recovery.saved_at)} are still in this
                browser.
              </strong>{" "}
              {recovery.revision === doc.revision
                ? "Restore them to keep editing, or discard them."
                : `The saved draft changed since then (revision ${recovery.revision} → ${doc.revision}). Restoring replaces it in the editor; review before saving.`}
            </p>
            <Button variant="secondary compact" onClick={restoreRecovery}>
              Restore changes
            </Button>
            <Button variant="ghost compact" onClick={discardRecovery}>
              Discard
            </Button>
          </div>
        )}
        {publishedVersionStatus === "failed" && (
          <div className="editor-published-status-error" role="status">
            <span>Published version check failed: {publishedVersionError}</span>
            {!can(user, "operate") && (
              <button type="button" onClick={retryPublishedVersion}>
                Retry version check
              </button>
            )}
          </div>
        )}
        {view === "canvas" ? (
          <div
            className={`editor-workspace ${inlineSettings ? "editor-workspace-inspecting" : ""}`}
          >
            <div className="editor-graph-section">
              <div
                className="editor-graph"
                ref={graphRef}
                tabIndex={-1}
                role="region"
                aria-label="Pipeline canvas"
                data-highlighted-connection={highlightedConnection?.id}
                onKeyDownCapture={graphKeyDown}
                onPointerLeave={() => setHoveredConnection(null)}
                onPointerDownCapture={(event) => {
                  pointerFocus.current = true;
                  setFocusedConnection(null);
                  if (
                    !(event.target as Element).closest(
                      ".react-flow__edge,[data-connection-edge-id]",
                    )
                  )
                    setHoveredConnection(null);
                }}
                onFocusCapture={(event) => {
                  const target = event.target as Element;
                  const edge = target.closest(".react-flow__edge");
                  const edgeId =
                    edge?.getAttribute("data-id") ||
                    target
                      .closest("[data-connection-edge-id]")
                      ?.getAttribute("data-connection-edge-id");
                  if (
                    highlightEnabled &&
                    edgeId &&
                    !pointerFocus.current &&
                    target.matches(":focus-visible")
                  ) {
                    setHoveredConnection(null);
                    setFocusedConnection(edgeId);
                  } else if (!edgeId) clearConnectionHighlight();
                }}
                onBlurCapture={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  )
                    clearConnectionHighlight();
                  else setFocusedConnection(null);
                }}
                onAuxClickCapture={(event) => {
                  if (event.button !== 1 || !editable) return;
                  const edgeId = (event.target as Element)
                    .closest(".react-flow__edge")
                    ?.getAttribute("data-id");
                  const edge = edges.find((item) => item.id === edgeId);
                  if (edge) {
                    event.preventDefault();
                    event.stopPropagation();
                    removeEdges([edge]);
                  }
                }}
              >
                <ReactFlow
                  proOptions={FLOW_PRO_OPTIONS}
                  nodes={canvasNodes}
                  edges={canvasEdges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onInit={stableCanvasHandler("onInit", (instance) => {
                    flow.current = instance;
                  })}
                  onNodesChange={stableCanvasHandler(
                    "onNodesChange",
                    changeNodes,
                  )}
                  onEdgesChange={stableCanvasHandler(
                    "onEdgesChange",
                    (changes) => {
                      graphFromEdit.current = false;
                      setEdges((previous) =>
                        applyEdgeChanges(
                          changes.filter((c) => c.type !== "remove"),
                          previous,
                        ),
                      );
                    },
                  )}
                  onConnect={stableCanvasHandler(
                    "onConnect",
                    editable ? onConnect : undefined,
                  )}
                  onConnectStart={stableCanvasHandler(
                    "onConnectStart",
                    editable ? onConnectStart : undefined,
                  )}
                  onConnectEnd={stableCanvasHandler(
                    "onConnectEnd",
                    editable ? onConnectEnd : undefined,
                  )}
                  onClickConnectStart={stableCanvasHandler(
                    "onClickConnectStart",
                    editable ? onConnectStart : undefined,
                  )}
                  onClickConnectEnd={stableCanvasHandler(
                    "onClickConnectEnd",
                    editable ? () => setConnectionGesture(null) : undefined,
                  )}
                  isValidConnection={stableCanvasHandler(
                    "isValidConnection",
                    (connection) =>
                      editable &&
                      !busy &&
                      !connectionCancelled.current &&
                      !reconnectGesture.current?.cancelled &&
                      canConnect(
                        config,
                        connection,
                        reconnectGesture.current?.edge,
                      ),
                  )}
                  onReconnect={stableCanvasHandler(
                    "onReconnect",
                    editable ? onReconnect : undefined,
                  )}
                  onReconnectStart={stableCanvasHandler(
                    "onReconnectStart",
                    editable
                      ? (event: React.MouseEvent, edge: Edge) => {
                          clearConnectionHighlight();
                          setReconnecting(true);
                          reconnectGesture.current = {
                            edge,
                            x: event.clientX,
                            y: event.clientY,
                            applied: false,
                            cancelled: false,
                          };
                        }
                      : undefined,
                  )}
                  onReconnectEnd={stableCanvasHandler(
                    "onReconnectEnd",
                    editable
                      ? (
                          event: MouseEvent | TouchEvent,
                          _edge: Edge,
                          _handle: unknown,
                          state: { toNode: unknown },
                        ) => {
                          setReconnecting(false);
                          const gesture = reconnectGesture.current;
                          reconnectGesture.current = null;
                          setConnectionGesture(null);
                          if (
                            !gesture ||
                            gesture.applied ||
                            gesture.cancelled ||
                            state.toNode
                          )
                            return;
                          const point =
                            "changedTouches" in event
                              ? event.changedTouches[0]
                              : event;
                          const target = event.target;
                          if (
                            point &&
                            Math.hypot(
                              point.clientX - gesture.x,
                              point.clientY - gesture.y,
                            ) > 8 &&
                            target instanceof Element &&
                            target.closest(".react-flow__pane") &&
                            !target.closest(
                              ".react-flow__node,.react-flow__handle",
                            )
                          )
                            removeEdges([gesture.edge]);
                        }
                      : undefined,
                  )}
                  edgesReconnectable={editable}
                  reconnectRadius={12}
                  connectionRadius={28}
                  connectionLineType={connectionLineTypes[connectionStyle]}
                  connectionLineStyle={connectionLineStyle}
                  onEdgeClick={stableCanvasHandler(
                    "onEdgeClick",
                    (_event: React.MouseEvent, edge: Edge) => {
                      if (!closeSettings()) return;
                      graphFromEdit.current = false;
                      setNodes((previous) =>
                        previous.map((node) => ({ ...node, selected: false })),
                      );
                      setEdges((previous) =>
                        previous.map((item) => ({
                          ...item,
                          selected: item.id === edge.id,
                        })),
                      );
                    },
                  )}
                  onEdgeMouseEnter={stableCanvasHandler(
                    "onEdgeMouseEnter",
                    (_event, edge) => hoverConnection(edge.id, true),
                  )}
                  onEdgeMouseLeave={stableCanvasHandler(
                    "onEdgeMouseLeave",
                    (_event, edge) => hoverConnection(edge.id, false),
                  )}
                  onMoveStart={stableCanvasHandler(
                    "onMoveStart",
                    clearConnectionHighlight,
                  )}
                  onEdgeContextMenu={stableCanvasHandler(
                    "onEdgeContextMenu",
                    (event, edge) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openGraphMenu(
                        "edge",
                        edge.id,
                        { x: event.clientX, y: event.clientY },
                        event.currentTarget as unknown as HTMLElement,
                      );
                    },
                  )}
                  onNodeContextMenu={stableCanvasHandler(
                    "onNodeContextMenu",
                    (event, node) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openGraphMenu(
                        "node",
                        node.id,
                        { x: event.clientX, y: event.clientY },
                        event.currentTarget as HTMLElement,
                      );
                    },
                  )}
                  onPaneContextMenu={stableCanvasHandler(
                    "onPaneContextMenu",
                    editable
                      ? (event) => {
                          event.preventDefault();
                          openCanvasPicker({
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }
                      : undefined,
                  )}
                  onNodeClick={stableCanvasHandler(
                    "onNodeClick",
                    (event, node) => {
                      if (
                        (event.target as Element).closest(
                          ".react-flow__handle,[data-node-action]",
                        )
                      )
                        return;
                      // Ctrl, Cmd or Shift builds a multi-selection, and the
                      // inspector only ever shows one step.
                      if (event.ctrlKey || event.metaKey || event.shiftKey) {
                        if (selected) closeSettings();
                        return;
                      }
                      selectStep(node.id);
                    },
                  )}
                  onPaneClick={stableCanvasHandler("onPaneClick", () => {
                    if (canvasPicker) closeCanvasPicker();
                    else closeSettings();
                  })}
                  onNodeDragStart={stableCanvasHandler(
                    "onNodeDragStart",
                    editable
                      ? () => {
                          clearConnectionHighlight();
                          setAutoArrange(false);
                          rememberDraft();
                        }
                      : undefined,
                  )}
                  nodesDraggable={editable}
                  nodesConnectable={editable}
                  deleteKeyCode={null}
                  fitView
                  fitViewOptions={
                    nodes.length <= 8 ? smallFitViewOptions : fitViewOptions
                  }
                  zoomOnDoubleClick={false}
                  minZoom={0.15}
                  maxZoom={2}
                  defaultEdgeOptions={defaultEdgeOptions}
                >
                  <ConnectionCancellation
                    active={!!connectionGesture}
                    onCancel={() => {
                      connectionCancelled.current = true;
                      if (reconnectGesture.current)
                        reconnectGesture.current.cancelled = true;
                      setConnectionGesture(null);
                    }}
                  />
                  {connectionGesture && (
                    <Panel
                      position="top-center"
                      className="editor-connection-guidance"
                      role="status"
                    >
                      {reconnectGesture.current
                        ? "Move to a highlighted port, or release on blank canvas to disconnect."
                        : "Connect to a highlighted port."}{" "}
                      Esc cancels.
                    </Panel>
                  )}
                  {editable && !connectionGesture && (
                    <Panel
                      position="top-left"
                      className="editor-add-component-panel"
                    >
                      <button
                        type="button"
                        className="editor-add-component-fab"
                        aria-haspopup="dialog"
                        aria-expanded={!!canvasPicker}
                        disabled={busy}
                        onClick={() => openPicker()}
                      >
                        <Blocks size={18} aria-hidden="true" />
                        <span>Add component</span>
                      </button>
                    </Panel>
                  )}
                  {multiSelected.length > 1 && !connectionGesture && (
                    <Panel
                      position="top-center"
                      className="editor-selection-toolbar"
                    >
                      <div role="toolbar" aria-label="Selected steps">
                        <strong>{multiSelected.length} steps selected</strong>
                        {editable && (
                          <button type="button" onClick={duplicateSelection}>
                            <Copy size={14} aria-hidden="true" />
                            Duplicate
                          </button>
                        )}
                        <button type="button" onClick={() => copySelection()}>
                          <ClipboardCopy size={14} aria-hidden="true" />
                          Copy YAML
                        </button>
                        {editable && (
                          <button
                            type="button"
                            data-danger
                            onClick={() => remove(multiSelected)}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            Delete
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label="Clear selection"
                          title="Clear selection"
                          onClick={clearSelection}
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </Panel>
                  )}
                  {findOpen && (
                    <Panel position="top-center" className="editor-find-panel">
                      <CanvasFind
                        nodes={nodes}
                        onFind={findStep}
                        onClose={() => {
                          setFindOpen(false);
                          graphRef.current?.focus();
                        }}
                      />
                    </Panel>
                  )}
                  {liveAvailable && !connectionGesture && (
                    <Panel position="top-right" className="editor-live-panel">
                      <button
                        type="button"
                        className="editor-live-toggle"
                        aria-pressed={liveOn}
                        onClick={toggleLive}
                        title={
                          liveOn
                            ? "Hide live numbers"
                            : "Show events per second from devices running this pipeline"
                        }
                      >
                        <Radio size={15} aria-hidden="true" />
                        Live
                      </button>
                      {liveOn && (
                        <div
                          className="editor-live-status"
                          role="status"
                          data-tone={
                            telemetry?.error && !telemetry.data
                              ? "error"
                              : (liveStatus?.tone ?? "loading")
                          }
                        >
                          <span>
                            {!telemetry
                              ? "Loading live numbers…"
                              : telemetry.error && !telemetry.data
                                ? `Live numbers are unavailable: ${telemetry.error}`
                                : liveStatus?.message}
                          </span>
                          {liveStatus?.suggestMonitoring && editable && (
                            <button
                              type="button"
                              onClick={() => tool(addMonitoring)}
                            >
                              <Activity size={13} aria-hidden="true" />
                              Add monitoring
                            </button>
                          )}
                          {liveStatus &&
                            liveStatus.tone !== "empty" &&
                            !publishedDraft && (
                              <small>
                                Your draft has changes that aren&apos;t running.
                              </small>
                            )}
                        </div>
                      )}
                    </Panel>
                  )}
                  <Panel
                    position="bottom-left"
                    className="editor-canvas-controls"
                  >
                    {editable && (
                      <div role="group" aria-label="Edit graph">
                        <IconButton
                          icon={Undo2}
                          label="Undo"
                          disabled={!stack.current.length}
                          onClick={() => undo()}
                        />
                        <IconButton
                          icon={Redo2}
                          label="Redo"
                          disabled={!future.current.length}
                          onClick={() => undo(true)}
                        />
                      </div>
                    )}
                    <div role="group" aria-label="Graph view">
                      <IconButton
                        icon={Minus}
                        label="Zoom out"
                        onClick={() =>
                          flow.current?.zoomOut({
                            duration: window.matchMedia(
                              "(prefers-reduced-motion: reduce)",
                            ).matches
                              ? 0
                              : 180,
                          })
                        }
                      />
                      <IconButton
                        icon={Plus}
                        label="Zoom in"
                        onClick={() =>
                          flow.current?.zoomIn({
                            duration: window.matchMedia(
                              "(prefers-reduced-motion: reduce)",
                            ).matches
                              ? 0
                              : 180,
                          })
                        }
                      />
                      <IconButton
                        icon={Maximize}
                        label="Fit graph"
                        onClick={fitGraph}
                      />
                      <IconButton
                        icon={CircleHelp}
                        label="Canvas shortcuts"
                        onClick={() => setShortcutsOpen(true)}
                      />
                      <ConnectionStylePicker
                        value={connectionStyle}
                        onChange={setConnectionStyle}
                      />
                    </div>
                    {editable && (
                      <div role="group" aria-label="Graph layout">
                        <IconButton
                          icon={LayoutGrid}
                          label="Arrange graph"
                          onClick={() => {
                            if (!closeSettings()) return;
                            replace(config, arrangeGraph({ nodes, edges }));
                            setTimeout(fitGraph, 30);
                          }}
                        />
                      </div>
                    )}
                  </Panel>
                  {nodes.length > 12 && (
                    <MiniMap
                      pannable
                      zoomable
                      ariaLabel="Pipeline overview"
                      nodeColor="var(--line-strong, var(--line))"
                      maskColor="color-mix(in srgb, var(--surface) 70%, transparent)"
                    />
                  )}
                  <Background
                    variant={BackgroundVariant.Dots}
                    gap={24}
                    color="var(--pipeline-grid-dot)"
                    size={1.5}
                  />
                </ReactFlow>
                {!nodes.length && (
                  <div className="editor-canvas-empty">
                    <div>
                      <Database size={25} />
                      <h2>Add your first source</h2>
                      <p>
                        Build the pipeline on this canvas. Connect sources to
                        transformations and destinations.
                      </p>
                      {editable && (
                        <>
                          <div className="editor-canvas-empty-actions">
                            <Button
                              icon={Plus}
                              onClick={() => openPicker("sources")}
                            >
                              Choose a source
                            </Button>
                            <Button
                              variant="secondary"
                              icon={Upload}
                              onClick={() =>
                                tool(() => fileRef.current?.click())
                              }
                            >
                              Import Vector config
                            </Button>
                          </div>
                          <div className="canvas-templates">
                            <p className="pipeline-start-heading">
                              Or start from a template
                            </p>
                            <div className="canvas-templates-grid">
                              {pipelineTemplates.map((template) => (
                                <button
                                  key={template.id}
                                  type="button"
                                  className="canvas-template"
                                  onClick={() => applyTemplate(template)}
                                >
                                  <strong>{template.title}</strong>
                                  <small>{template.summary}</small>
                                </button>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
              {problemsPanel}
            </div>
            {inlineSettings && (
              <aside
                className="editor-inspector editor-component-panel"
                aria-label="Component settings"
                data-pipeline-category={
                  selectedNode.data.enrichmentTable
                    ? undefined
                    : selectedNode.data.kind
                }
              >
                <header>
                  <span className="pipeline-category-icon editor-inspector-icon">
                    <ComponentIcon
                      type={component.type}
                      kind={selectedNode.data.kind}
                      size={25}
                    />
                  </span>
                  <div className="editor-inspector-identity">
                    <span className="pipeline-category-label">
                      {selectedNode.data.enrichmentTable
                        ? "Enrichment table"
                        : selectedNode.data.kind === "sources"
                          ? "Source"
                          : selectedNode.data.kind === "sinks"
                            ? "Destination"
                            : "Transform"}
                      {!selectedNode.data.enrichmentTable && (
                        <code className="editor-inspector-type">
                          {component.type}
                        </code>
                      )}
                    </span>
                    <h2>
                      {selectedNode.data.enrichmentTable
                        ? "Memory enrichment table"
                        : definition?.label || component.type}
                    </h2>
                    <ComponentName
                      key={selectedNode.id}
                      id={selectedNode.id}
                      editable={editable && !selectedNode.data.enrichmentTable}
                      onRename={renameSelected}
                      onPendingChange={schemaPendingChange}
                    />
                  </div>
                  <div className="editor-inspector-header-actions">
                    <HelpLink
                      className="editor-component-docs"
                      href={
                        definition?.docs_url ||
                        "https://vector.dev/docs/reference/configuration/" +
                          (selectedNode.data.enrichmentTable
                            ? "enrichment_tables"
                            : selectedNode.data.kind) +
                          "/" +
                          component.type +
                          "/"
                      }
                      label="Component documentation"
                    />
                    <IconButton
                      icon={X}
                      label="Close component settings"
                      onClick={dismissInspector}
                    />
                  </div>
                </header>
                <div className="editor-inspector-properties-toolbar">
                  <span>Configuration</span>
                  <div
                    ref={setFieldPickerTarget}
                    className="editor-inspector-field-picker"
                  />
                </div>
                <div className="editor-inspector-body">
                  {error && <ErrorBox message={error} />} {settingsContent}
                </div>
              </aside>
            )}
          </div>
        ) : (
          <div className="editor-code-view">
            <div className="editor-code-toolbar">
              <Field label="Format">
                <select
                  value={format}
                  onChange={(e) => {
                    try {
                      setCode(stringify(parse(code), e.target.value));
                      setFormat(e.target.value);
                    } catch (error) {
                      setError((error as Error).message);
                    }
                  }}
                >
                  <option value="yaml">YAML</option>
                  <option value="toml">TOML</option>
                  <option value="json">JSON</option>
                </select>
              </Field>
              <div className="editor-code-actions">
                {editable && (
                  <Button
                    variant="ghost compact"
                    onClick={formatCode}
                    title="Format code (Ctrl/Cmd+Shift+F). Comments and layout are normalized."
                  >
                    <WrapText size={15} aria-hidden="true" />
                    Format code
                  </Button>
                )}
                <Button variant="ghost compact" onClick={() => void copyCode()}>
                  <Copy size={15} aria-hidden="true" />
                  Copy code
                </Button>
              </div>
            </div>
            <ConfigurationCodeEditor
              describedBy={codeFeedbackId}
              format={format}
              readOnly={!editable}
              value={code}
              diagnostics={currentAnalysis?.diagnostics || []}
              onFormat={formatCode}
              reveal={codeReveal}
              onChange={(value) => {
                setCode(value);
                importedCodeDirty.current = value !== stringify(config);
              }}
            />
            <div
              id={codeFeedbackId}
              className="editor-code-diagnostics"
              aria-live="polite"
            >
              {currentAnalysis?.diagnostics.length ? (
                <details>
                  <summary>
                    {
                      currentAnalysis.diagnostics.filter(
                        (item) => item.severity === "error",
                      ).length
                    }{" "}
                    errors ·{" "}
                    {
                      currentAnalysis.diagnostics.filter(
                        (item) => item.severity === "warning",
                      ).length
                    }{" "}
                    warnings
                  </summary>
                  <ul>
                    {currentAnalysis.diagnostics.map((item, index) => (
                      <li key={index}>
                        <span>
                          {item.severity === "error" ? "Error" : "Warning"} ·
                          Line {code.slice(0, item.from).split("\n").length}
                        </span>{" "}
                        {item.message}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : (
                <span>
                  {currentAnalysis
                    ? "No syntax or schema issues."
                    : "Reading code…"}
                </span>
              )}
            </div>
            {problemsPanel}
            {editable && (
              <div className="editor-code-footer">
                <span>
                  {importedCodeDirty.current
                    ? "Code changes have not been applied to the draft."
                    : "Code matches the current draft."}
                  {importedCodeDirty.current &&
                    hasSourceComments(code, format) && (
                      <strong className="editor-code-comments">
                        {" "}
                        Comments are not kept when you apply. Comments inside
                        VRL programs are.
                      </strong>
                    )}
                </span>
                {importedCodeDirty.current && (
                  <Button
                    variant="ghost compact"
                    onClick={() => {
                      importedCodeDirty.current = false;
                      syncCode(config);
                      setError("");
                    }}
                  >
                    Discard code changes
                  </Button>
                )}
                <Button
                  disabled={!importedCodeDirty.current}
                  onClick={() => {
                    try {
                      replace(parse(code));
                      importedCodeDirty.current = false;
                      setError("");
                      notify("Code changes applied to the draft.");
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Apply code changes
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      {importCandidate && (
        <ConfigurationImportDialog
          candidate={importCandidate}
          onCancel={() => setImportCandidate(null)}
          onConfirm={() => applyImportedPipeline(importCandidate)}
        />
      )}
      <Modal
        open={saveNote !== null}
        onClose={() => !savingDraft && setSaveNote(null)}
        title="Save draft"
        description="The note appears in version history with this draft revision."
      >
        <div className="modal-body">
          <Field label="Note">
            <textarea
              rows={3}
              maxLength={500}
              value={saveNote ?? ""}
              disabled={savingDraft}
              onChange={(event) => setSaveNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void saveWithNote();
                }
              }}
            />
          </Field>
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            disabled={savingDraft}
            onClick={() => setSaveNote(null)}
          >
            Cancel
          </Button>
          <Button
            icon={Save}
            busy={savingDraft}
            disabled={hasPendingFields || !dirty}
            onClick={() => void saveWithNote()}
          >
            Save draft
          </Button>
        </div>
      </Modal>
      <Modal
        open={discardOpen}
        onClose={cancelDiscard}
        returnFocusRef={discardReturnFocus}
        title="Discard unsaved changes?"
        description="Return to the last saved draft. Unsaved graph, code, and field edits will be removed. Changes already saved to the draft are kept."
      >
        <div className="modal-footer">
          <Button variant="secondary" disabled={busy} onClick={cancelDiscard}>
            Cancel
          </Button>
          <Button
            variant="danger"
            busy={busy}
            icon={RotateCcw}
            onClick={() => void discardChanges()}
          >
            Discard changes
          </Button>
        </div>
      </Modal>
      {canvasPicker && (
        <CanvasComponentMenu
          location={canvasPicker}
          config={config}
          error={error}
          onAdd={add}
          onClose={closeCanvasPicker}
          onImport={(kind) => {
            setCanvasPicker(null);
            setPickerKind(kind);
          }}
        />
      )}
      {graphMenu && (
        <CanvasActionMenu
          key={`${graphMenu.kind}:${graphMenu.id}:${graphMenu.position.x}:${graphMenu.position.y}`}
          kind={graphMenu.kind}
          title={
            graphMenu.kind === "node"
              ? `Step: ${graphMenu.id}`
              : "Connection actions"
          }
          position={graphMenu.position}
          returnFocus={graphMenu.opener || graphRef.current}
          actions={graphActions()}
          onClose={() => setGraphMenu(null)}
        />
      )}
      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="Canvas shortcuts"
      >
        <div className="modal-body">
          <p>
            Select a connection to reveal its draggable endpoints. Highlighted
            ports accept the connection. Drop an existing endpoint on blank
            canvas to disconnect it; an invalid drop keeps the connection.
          </p>
          <dl className="canvas-shortcuts-list">
            <dt>Delete / Backspace</dt>
            <dd>Remove selected steps or disconnect selected lines.</dd>
            <dt>Arrow keys</dt>
            <dd>Move a focused step 10 pixels. Hold Shift for 50 pixels.</dd>
            <dt>Ctrl / ⌘ S</dt>
            <dd>Save the draft.</dd>
            <dt>⌘ K</dt>
            <dd>Open the command menu.</dd>
            <dt>Ctrl / ⌘ F</dt>
            <dd>Find a step by ID, name or type.</dd>
            <dt>Ctrl / ⌘ C, V</dt>
            <dd>
              Copy the selected steps as Vector YAML, and paste steps from any
              Vector configuration.
            </dd>
            <dt>Ctrl / ⌘ click, Shift drag</dt>
            <dd>Select several steps. Ctrl / ⌘ A selects all.</dd>
            <dt>Ctrl / ⌘ D</dt>
            <dd>Duplicate the focused or selected steps.</dd>
            <dt>Ctrl / ⌘ Z</dt>
            <dd>Undo. Add Shift to redo.</dd>
            <dt>Shift F10 / Menu key</dt>
            <dd>Open actions for the focused step or connection.</dd>
            <dt>Escape</dt>
            <dd>Cancel a connection move or dismiss the menu.</dd>
            <dt>Middle-click a line</dt>
            <dd>Disconnect it.</dd>
          </dl>
          <p>
            Right-click a step or connection for its actions. Every canvas edit
            can be undone.
          </p>
        </div>
        <div className="modal-footer">
          <Button onClick={() => setShortcutsOpen(false)}>Done</Button>
        </div>
      </Modal>
      <Modal
        open={!!pickerKind}
        onClose={() => {
          setPickerKind(null);
          pickerPlacement.current = null;
        }}
        title="Import component definition"
      >
        <div className="modal-body">
          <div id={customJSONErrorId}>
            {error && <ErrorBox message={error} />}
          </div>
          <Field label="Component category">
            <select
              value={pickerKind || "sources"}
              onChange={(event) => setPickerKind(event.target.value as Kind)}
            >
              {(["sources", "transforms", "sinks"] as Kind[])
                .filter(
                  (kind) =>
                    !pickerPlacement.current?.input || kind !== "sources",
                )
                .map((kind) => (
                  <option key={kind} value={kind}>
                    {kindLabel[kind]}
                  </option>
                ))}
            </select>
          </Field>
          <div className="editor-component-json">
            <div className="schema-json-toolbar">
              <span>Component definition (JSON)</span>
              <Button
                variant="ghost compact"
                icon={AlignLeft}
                disabled={!customJSONAnalysis.parseValid}
                onClick={() =>
                  setCustomComponentJSON(
                    JSON.stringify(customJSONAnalysis.value, null, 2),
                  )
                }
              >
                Format JSON
              </Button>
            </div>
            <ConfigurationCodeEditor
              describedBy={`${customJSONFeedbackId} ${customJSONErrorId}`}
              label="Component definition (JSON)"
              format="json"
              value={customComponentJSON}
              onChange={setCustomComponentJSON}
              onFormat={() => {
                if (customJSONAnalysis.parseValid)
                  setCustomComponentJSON(
                    JSON.stringify(customJSONAnalysis.value, null, 2),
                  );
              }}
              diagnostics={customJSONAnalysis.diagnostics}
            />
            <div id={customJSONFeedbackId} role="status">
              {!!customJSONAnalysis.diagnostics.length && (
                <p className="schema-control-error">
                  {customJSONAnalysis.diagnostics[0].message}
                </p>
              )}
            </div>
          </div>
          <Button variant="secondary" onClick={importComponentDefinition}>
            Add component from JSON
          </Button>
        </div>
      </Modal>
      <Modal
        open={!!component && !!selectedNode && !inlineSettings && !historyOpen}
        onClose={closeSettings}
        title={`${definition?.label || component?.type || "Step"} settings`}
        description={
          definition?.description || "Configure this step’s properties."
        }
        wide
      >
        {component && selectedNode && (
          <>
            <div className="modal-body">
              {error && <ErrorBox message={error} />}
              {settingsContent}
            </div>
            <div className="modal-footer">
              <span className="editor-dialog-save" aria-live="polite">
                {displaySaveStatus}
              </span>
              <Button onClick={closeSettings}>Done</Button>
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={publishOpen && !!publishedResult}
        onClose={closePublishedResult}
        title={`Version ${publishedResult?.number ?? ""} published`}
        description="Publishing changed no device. Choose devices to deploy this version now, or later from this pipeline."
      >
        <div className="modal-footer">
          <Button variant="secondary" onClick={closePublishedResult}>
            Done
          </Button>
          {publishedResult && (
            <Button
              icon={Server}
              onClick={() => {
                const version = publishedResult;
                closePublishedResult();
                setDeployVersion(version);
              }}
            >
              Choose devices
            </Button>
          )}
        </div>
      </Modal>
      <Modal
        open={publishOpen && !publishedResult}
        onClose={() => !publishActive.current && !busy && setPublishOpen(false)}
        title="Review & publish"
        description="Publish a version of this draft, then choose which devices receive it."
      >
        <div className="modal-body editor-publish-review">
          {error && <ErrorBox message={error} />}
          {publishNotice && (
            <section role="status" className="editor-publish-notice">
              <h3>
                {publishNotice === "confirmed"
                  ? "Version published"
                  : "Publish result needs confirmation"}
              </h3>
              <p>
                {publishNotice === "confirmed"
                  ? `Version ${publishedVersion?.number} is saved. Its original request remains available for review.`
                  : "Your original request is saved in this browser. Close this dialog and review its status, including after a reload."}
              </p>
            </section>
          )}
          {unresolvedPublish && !publishNotice && !busy && (
            <ErrorBox message="Review the saved publish request before publishing again." />
          )}
          <h3>{doc.name}</h3>
          <p>{pipelineSummary(config)}</p>
          {variables.length > 0 && (
            <p>
              {variables.length} device-specific{" "}
              {variables.length === 1 ? "field" : "fields"}. Values are set when
              you deploy this version.
            </p>
          )}
          <PublishReview
            config={config}
            published={publishedVersion}
            reach={publishReach}
            status={status}
            statusLabel={statusLabel}
            verdict={checking ? "Checking the pipeline with Vector…" : verdict}
            problems={problems}
            rejection={publishRejection}
            onCheck={checkable ? () => void validate() : undefined}
            onGoToProblem={(problem) => {
              if (publishActive.current || busy) return;
              setPublishOpen(false);
              openProblem(problem);
            }}
          />
          {dirty && (
            <p>
              Publishing will save your unsaved changes as a draft revision
              before creating the version.
            </p>
          )}
          <Field label="Version note (optional)">
            <textarea
              rows={3}
              value={message}
              disabled={busy || !!publishNotice || unresolvedPublish}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={publishNotePlaceholder}
            />
          </Field>
          <p>
            Publishing does not change any device. You will review targets in
            the next step.
          </p>
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => !publishActive.current && setPublishOpen(false)}
          >
            {publishNotice ? "Close and review request" : "Back to draft"}
          </Button>
          <Button
            busy={busy}
            disabled={
              errors.length > 0 ||
              freshVectorErrors ||
              hasPendingFields ||
              importedCodeDirty.current ||
              unresolvedPublish ||
              !!publishNotice ||
              // The server refuses a draft its checker cannot verify.
              status === "unavailable"
            }
            onClick={publish}
          >
            Publish version
          </Button>
        </div>
      </Modal>{" "}
      {pipelineAction && (
        <PipelineActions
          {...pipelineAction}
          user={user}
          onClose={() => setPipelineAction(null)}
          onRecovery={() => {
            setPipelineAction(null);
            const opener = toolsRef.current?.querySelector("summary");
            if (opener) pipelineCreationRecoveryRef.current?.openSaved(opener);
          }}
          onReloaded={acceptSavedSnapshot}
          onSaved={(result) => {
            const action = pipelineAction.action;
            setPipelineAction(null);
            if (action === "duplicate") {
              notify("Pipeline duplicated.");
              navigate(pipelineRoute(result.id, initialDeviceId));
            } else {
              acceptSavedSnapshot(result);
              notify(
                action === "archive"
                  ? "Pipeline archived. Running deployments are unchanged."
                  : "Pipeline unarchived.",
              );
            }
          }}
        />
      )}
      {deployVersion && can(user, "operate") && (
        <TargetDialog
          key={user.id}
          userId={user.id}
          open
          onClose={() => setDeployVersion(null)}
          version={deployVersion}
          initialDeviceIds={initialDeviceId ? [initialDeviceId] : []}
          onDone={notify}
        />
      )}
      {detailsOpen && (
        <PipelineDetails
          returnFocusRef={detailsReturnFocus}
          editable={editable}
          name={doc.name}
          description={doc.description}
          onClose={() => setDetailsOpen(false)}
          onPendingChange={schemaPendingChange}
          onSave={async (name, description) => {
            setError("");
            return !!(await persist(false, { name, description }));
          }}
        />
      )}
      {globalsOpen && (
        <PipelineGlobals
          initialSection={globalsSection}
          config={config}
          variables={variables}
          onChange={(next) => replace(next)}
          onVariablesChange={(next) => replace(config, undefined, true, next)}
          onClose={() => setGlobalsOpen(false)}
          editable={editable}
        />
      )}
    </div>
  );
}
