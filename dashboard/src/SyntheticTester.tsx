import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Braces,
  CheckCircle2,
  CircleSlash,
  CircleX,
  FlaskConical,
  LoaderCircle,
  Play,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { api, APIError, type Config } from "./api";
import ConfigurationCodeEditor from "./ConfigurationCodeEditor";
import { diffEvents, displayValue } from "./eventDiff";
import type { VectorDiagnostic } from "./pipelineProblems";
import {
  activeSet,
  parseSamples,
  readSamples,
  uniqueSetName,
  writeSamples,
  type SampleStore,
} from "./sampleStore";
import { unitTestFromSample, type SampleResult } from "./sampleTests";
import { eventPaths } from "./vrlLanguage";
import "./sample-tester.css";

type TesterResponse = {
  valid: boolean;
  compiled?: boolean;
  output: unknown;
  errors: string[];
  diagnostics?: VectorDiagnostic[];
  results?: SampleResult[];
  ports?: string[];
  placeholders?: string[];
};

type RunState =
  | { status: "idle" }
  | { status: "running"; previous?: Completed }
  | Completed
  | { status: "failed"; message: string; unavailable?: boolean };
type Completed = {
  status: "done";
  key: string;
  response: TesterResponse;
  samples: Record<string, unknown>[];
};

const AUTO_KEY = "vectory.samples.autorun";
const readAuto = () => {
  try {
    return localStorage.getItem(AUTO_KEY) !== "off";
  } catch {
    return true;
  }
};

const portLabel = (port: string) =>
  port === "_unmatched" ? "Unmatched" : port === "" ? "Output" : port;

/** What the step's real settings do with an event the tester saw drop. */
export function productionNote(component: Config, result: SampleResult) {
  const reroute = component.reroute_dropped === true;
  if (result.outcome === "error")
    return component.drop_on_error === true
      ? reroute
        ? "Drop on error is on: Vector sends the original event to the dropped output."
        : "Drop on error is on: Vector drops the event."
      : "Drop on error is off (default): Vector passes the original event through unchanged.";
  if (result.outcome === "aborted")
    return component.drop_on_abort === false
      ? "Drop on abort is off: Vector passes the original event through unchanged."
      : reroute
        ? "Vector sends the original event to the dropped output."
        : "Vector drops the event (Drop on abort is on by default).";
  if (result.outcome === "unmatched")
    return "No route matched and Reroute unmatched is off: Vector drops the event.";
  if (result.outcome === "filtered")
    return "The condition was false: Vector drops the event.";
  return "";
}

function outcomeLabel(result: SampleResult, type: string) {
  switch (result.outcome) {
    case "emitted":
      return type === "filter"
        ? "Kept"
        : type === "remap"
          ? "Transformed"
          : "Routed";
    case "filtered":
      return "Filtered out";
    case "unmatched":
      return "No route matched";
    case "error":
      return "Runtime error";
    case "aborted":
      return "Aborted";
    default:
      return "Dropped";
  }
}

function SampleCard({
  index,
  line,
  sample,
  result,
  component,
  onJump,
  onSave,
}: {
  index: number;
  line: number;
  sample: Record<string, unknown>;
  result: SampleResult;
  component: Config;
  onJump?: (line: number, column: number) => void;
  onSave?: () => void;
}) {
  const [showJSON, setShowJSON] = useState(false);
  const type = String(component.type || "");
  const good = result.outcome === "emitted";
  const tone =
    result.outcome === "error" ? "danger" : good ? "success" : "neutral";
  const Icon =
    result.outcome === "error" ? CircleX : good ? CheckCircle2 : CircleSlash;
  const note = productionNote(component, result);
  return (
    <li className="sample-result" data-tone={tone}>
      <header>
        <span className="sample-result-index" title={`Line ${line}`}>
          {index + 1}
        </span>
        <Icon size={15} aria-hidden="true" className="sample-result-icon" />
        <strong>{outcomeLabel(result, type)}</strong>
        {type !== "remap" &&
          result.outputs
            .filter((output) => output.port)
            .map((output) => (
              <span className="sample-port" key={output.port}>
                <ArrowRight size={11} aria-hidden="true" />
                {portLabel(output.port)}
              </span>
            ))}
        {onSave && (
          <button
            type="button"
            className="sample-result-action"
            onClick={onSave}
            title="Add a Vector unit test that expects this result"
          >
            <Save size={13} aria-hidden="true" />
            Save as test
          </button>
        )}
      </header>
      {result.outcome === "error" && (
        <p className="sample-result-message">
          {result.line && onJump ? (
            <button
              type="button"
              className="sample-jump"
              onClick={() => onJump(result.line!, result.column || 1)}
            >
              Line {result.line}
              {result.column ? `:${result.column}` : ""}
            </button>
          ) : null}
          <span>{result.message}</span>
        </p>
      )}
      {note && <p className="sample-result-note">{note}</p>}
      {good &&
        result.outputs.map((output) => {
          const stamped = new Set(output.timestamps.map((path) => `.${path}`));
          const changes =
            type === "remap" ? diffEvents(sample, output.event) : [];
          return (
            <div key={output.port} className="sample-output">
              {type === "remap" && (
                <ul
                  className="sample-diff"
                  aria-label={`Changes to sample ${index + 1}`}
                >
                  {changes.length === 0 && (
                    <li className="sample-diff-none">No fields changed.</li>
                  )}
                  {changes.slice(0, 14).map((change) => (
                    <li key={change.path} data-kind={change.kind}>
                      <span className="sample-diff-sign" aria-hidden="true">
                        {change.kind === "added"
                          ? "+"
                          : change.kind === "removed"
                            ? "−"
                            : "~"}
                      </span>
                      <span className="sr-only">{change.kind}</span>
                      <code className="sample-diff-path">{change.path}</code>
                      <code className="sample-diff-value">
                        {change.kind === "changed" && (
                          <>
                            <del>{displayValue(change.before)}</del>
                            <ArrowRight size={11} aria-hidden="true" />
                          </>
                        )}
                        {change.kind === "removed" ? (
                          <del>{displayValue(change.before)}</del>
                        ) : (
                          displayValue(change.after, stamped.has(change.path))
                        )}
                      </code>
                    </li>
                  ))}
                  {changes.length > 14 && (
                    <li className="sample-diff-none">
                      {changes.length - 14} more changes. View the event for all
                      fields.
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      {good && (
        <button
          type="button"
          className="sample-json-toggle"
          aria-expanded={showJSON}
          onClick={() => setShowJSON(!showJSON)}
        >
          <Braces size={13} aria-hidden="true" />
          {showJSON ? "Hide event" : "View event"}
        </button>
      )}
      {showJSON && (
        <pre className="sample-json">
          {result.outputs
            .map(
              (output) =>
                (output.port && type !== "remap"
                  ? `# ${portLabel(output.port)}\n`
                  : "") + JSON.stringify(output.event, null, 2),
            )
            .join("\n\n")}
        </pre>
      )}
    </li>
  );
}

/**
 * Run user-written synthetic samples through the current step in the
 * isolated Vector worker, as you type. Samples stay in this browser.
 */
export default function SyntheticTester({
  userId,
  pipelineId,
  componentId,
  component,
  timezone,
  canRun,
  canSaveTests,
  existingTests,
  onSaveTests,
  onCompile,
  onPaths,
  onJump,
  wide = false,
}: {
  userId: string;
  pipelineId: string;
  componentId: string;
  component: Config;
  timezone?: string;
  canRun: boolean;
  canSaveTests: boolean;
  existingTests: readonly Config[];
  onSaveTests?: (tests: Config[]) => void;
  /** Compile findings for this step, or null while unknown. */
  onCompile?: (diagnostics: VectorDiagnostic[] | null) => void;
  onPaths?: (paths: string[]) => void;
  onJump?: (field: string, line: number, column: number) => void;
  wide?: boolean;
}) {
  const [store, setStore] = useState<SampleStore>(() =>
    readSamples(userId, pipelineId),
  );
  const [persisted, setPersisted] = useState(true);
  const [auto, setAuto] = useState(readAuto);
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [renaming, setRenaming] = useState<string | null>(null);
  const set = activeSet(store, componentId);
  function commitRename() {
    const name = renaming?.trim();
    setRenaming(null);
    if (name && name !== set.name)
      update({
        ...store,
        sets: store.sets.map((item) =>
          item.id === set.id ? { ...item, name } : item,
        ),
      });
  }
  const parsed = useMemo(() => parseSamples(set.text), [set.text]);
  const transform = useMemo(() => {
    const { inputs: _inputs, graph: _graph, ...settings } = component || {};
    return settings;
  }, [component]);
  const runnable =
    canRun &&
    ["remap", "filter", "route", "exclusive_route"].includes(transform.type) &&
    !(transform.type === "remap" && (transform.file || transform.files)) &&
    parsed.samples.length > 0 &&
    parsed.errors.every((error) => error.message.startsWith("Only the first"));
  const key = JSON.stringify([transform, parsed.samples, timezone || null]);
  const generation = useRef(0);
  const callbacks = useRef({ onCompile, onPaths });
  callbacks.current = { onCompile, onPaths };
  const samplesId = useId();

  function update(next: SampleStore) {
    setStore(next);
    setPersisted(writeSamples(userId, pipelineId, next));
  }
  function editText(text: string) {
    update({
      ...store,
      sets: store.sets.map((item) =>
        item.id === set.id ? { ...item, text } : item,
      ),
    });
  }

  async function execute() {
    if (!runnable) return;
    const current = ++generation.current;
    const samples = parsed.samples;
    setRun((previous) => ({
      status: "running",
      previous:
        previous.status === "done"
          ? previous
          : previous.status === "running"
            ? previous.previous
            : undefined,
    }));
    try {
      const response = await api<TesterResponse>("/vrl/test", {
        method: "POST",
        body: JSON.stringify({
          transform,
          samples,
          timezone: timezone || null,
        }),
      });
      if (current !== generation.current) return;
      setRun({ status: "done", key, response, samples });
      callbacks.current.onCompile?.(
        response.compiled === false ? response.diagnostics || [] : [],
      );
      const outputs = (response.results || []).flatMap((result) =>
        result.outputs.map((output) => output.event),
      );
      callbacks.current.onPaths?.(eventPaths([...samples, ...outputs]));
    } catch (failure) {
      if (current !== generation.current) return;
      const unavailable =
        failure instanceof APIError && [503, 403].includes(failure.status);
      setRun({
        status: "failed",
        unavailable,
        message:
          failure instanceof APIError && failure.status === 503
            ? "Sample runs need the isolated Vector worker, which isn't available on this server."
            : failure instanceof APIError && failure.status === 429
              ? `${failure.message} Auto-run resumes when you edit again.`
              : (failure as Error).message,
      });
      callbacks.current.onCompile?.(null);
    }
  }

  useEffect(() => {
    if (!auto || !runnable) return;
    if (run.status === "done" && run.key === key) return;
    const timer = window.setTimeout(() => void execute(), 650);
    return () => window.clearTimeout(timer);
  }, [key, auto, runnable]);
  useEffect(
    () => () => {
      generation.current++;
      callbacks.current.onCompile?.(null);
    },
    [],
  );
  useEffect(() => {
    callbacks.current.onPaths?.(eventPaths(parsed.samples));
  }, [parsed.samples]);

  const completed =
    run.status === "done"
      ? run
      : run.status === "running"
        ? run.previous
        : undefined;
  const stale = !!completed && completed.key !== key;
  const response = completed?.response;
  const results = response?.results || [];
  const sampleDiagnostics = parsed.errors.map((error) => {
    const lines = set.text.split("\n");
    const from = lines
      .slice(0, error.line - 1)
      .reduce((sum, text) => sum + text.length + 1, 0);
    return {
      from,
      to: from + (lines[error.line - 1]?.length || 0),
      severity: error.message.startsWith("Only")
        ? ("warning" as const)
        : ("error" as const),
      message: error.message,
    };
  });
  const programField =
    transform.type === "remap"
      ? "source"
      : transform.type === "filter"
        ? "condition"
        : "";

  function saveTests(indexes: number[]) {
    if (!completed || !onSaveTests) return;
    const created: Config[] = [];
    for (const index of indexes) {
      const result = results[index];
      if (!result) continue;
      created.push(
        unitTestFromSample({
          componentId,
          component,
          sample: completed.samples[index],
          result,
          name: `${componentId}: ${set.name} ${index + 1}`,
          existing: [...existingTests, ...created],
        }),
      );
    }
    if (created.length) onSaveTests(created);
  }

  return (
    <section
      className={`sample-tester${wide ? " sample-tester-wide" : ""}`}
      aria-label={`Test ${componentId} with samples`}
    >
      <header className="sample-tester-header">
        <FlaskConical size={15} aria-hidden="true" />
        <h3>Test with samples</h3>
        <span className="sample-tester-status" aria-live="polite">
          {run.status === "running" ? (
            <>
              <LoaderCircle size={13} className="spin" aria-hidden="true" />{" "}
              Running
            </>
          ) : stale && auto ? (
            "Waiting for you to pause"
          ) : completed && !stale ? (
            `${parsed.samples.length} ${parsed.samples.length === 1 ? "sample" : "samples"} · Vector 0.58`
          ) : null}
        </span>
        <label className="sample-auto">
          <input
            type="checkbox"
            checked={auto}
            onChange={(event) => {
              setAuto(event.target.checked);
              try {
                localStorage.setItem(
                  AUTO_KEY,
                  event.target.checked ? "on" : "off",
                );
              } catch {
                /* the choice lasts for this page */
              }
            }}
          />
          Auto-run
        </label>
        <button
          type="button"
          className="sample-run"
          disabled={!runnable || run.status === "running"}
          onClick={() => void execute()}
          title="Run samples (Ctrl/⌘ Enter in the program)"
        >
          <Play size={13} aria-hidden="true" />
          Run
        </button>
      </header>
      <div className="sample-tester-body">
        <div className="sample-input">
          <div className="sample-set-bar">
            <label className="sr-only" htmlFor={samplesId}>
              {renaming === null ? "Sample set" : "Sample set name"}
            </label>
            {renaming === null ? (
              <select
                id={samplesId}
                value={set.id}
                onChange={(event) =>
                  update({
                    ...store,
                    active: {
                      ...store.active,
                      [componentId]: event.target.value,
                    },
                  })
                }
              >
                {store.sets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={samplesId}
                autoFocus
                maxLength={60}
                value={renaming}
                onChange={(event) => setRenaming(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setRenaming(null);
                  }
                }}
              />
            )}
            <button
              type="button"
              className="sample-icon-button"
              aria-label="New sample set"
              title="New sample set"
              disabled={store.sets.length >= 12}
              onClick={() => {
                const name = uniqueSetName(store);
                const id = `set-${Date.now().toString(36)}`;
                update({
                  ...store,
                  sets: [...store.sets, { id, name, text: "{}" }],
                  active: { ...store.active, [componentId]: id },
                });
              }}
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              className="sample-icon-button"
              aria-label={`Rename ${set.name}`}
              title="Rename sample set"
              onClick={() => setRenaming(set.name)}
            >
              Aa
            </button>
            <button
              type="button"
              className="sample-icon-button"
              aria-label={`Delete ${set.name}`}
              title="Delete sample set"
              disabled={store.sets.length < 2}
              onClick={() =>
                update({
                  ...store,
                  sets: store.sets.filter((item) => item.id !== set.id),
                })
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="sample-editor">
            <ConfigurationCodeEditor
              label={`Samples for ${componentId}, one JSON object per line`}
              format="json"
              value={set.text}
              diagnostics={sampleDiagnostics}
              onChange={editText}
            />
          </div>
          <p className="sample-hint">
            One JSON object per line. Samples stay in this browser
            {persisted
              ? ""
              : " for this visit (browser storage is unavailable)"}
            .
          </p>
        </div>
        <div className="sample-output-column" aria-live="polite">
          {!canRun ? (
            <p className="sample-empty">Your role can't run samples.</p>
          ) : run.status === "failed" ? (
            <p className="sample-error" role="alert">
              {run.message}
            </p>
          ) : !runnable && parsed.samples.length === 0 ? (
            <p className="sample-empty">
              Add a sample event to see what this step does with it.
            </p>
          ) : response?.compiled === false ? (
            <div className="sample-compile" role="status">
              <CircleX size={15} aria-hidden="true" />
              <div>
                <strong>This step doesn’t compile yet.</strong>
                <p>Fix the highlighted problems and the samples run again.</p>
              </div>
            </div>
          ) : completed ? (
            <>
              <ol
                className={`sample-results${stale ? " sample-results-stale" : ""}`}
              >
                {results.map((result, index) => (
                  <SampleCard
                    key={index}
                    index={index}
                    line={parsed.lines[index] || index + 1}
                    sample={completed.samples[index]}
                    result={result}
                    component={component}
                    onJump={
                      onJump && programField
                        ? (line, column) => onJump(programField, line, column)
                        : undefined
                    }
                    onSave={
                      canSaveTests && onSaveTests
                        ? () => saveTests([index])
                        : undefined
                    }
                  />
                ))}
              </ol>
              {canSaveTests && onSaveTests && results.length > 1 && (
                <button
                  type="button"
                  className="sample-save-all"
                  onClick={() => saveTests(results.map((_, index) => index))}
                >
                  <Save size={13} aria-hidden="true" />
                  Save all {results.length} as tests
                </button>
              )}
              {!!response?.placeholders?.length && (
                <p className="sample-hint">
                  Ran with placeholders for {response.placeholders.join(", ")}.
                </p>
              )}
            </>
          ) : (
            <p className="sample-empty">
              {auto
                ? "Running your samples…"
                : "Run the samples to see the result."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
