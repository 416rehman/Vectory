import {
  Braces,
  CircleHelp,
  Network,
  Percent,
  Send,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { EditorView } from "@codemirror/view";
import type { Config } from "./api";
import { catalog, componentSchema, vectorSchema, type Kind } from "./catalog";
import { Button, Field, Modal } from "./ui";
import SyntheticTester from "./SyntheticTester";
import DocLink from "./DocLink";
import PipelineSchemaFields, {
  FieldPathScope,
  FieldProblemsContext,
  PipelineSchemaControl,
  hasRootSchemaVariants,
  type SchemaPropertySection,
} from "./PipelineSchemaFields";
import { resolveSchema, type Schema } from "./pipelineSchema";
import { SchemaFieldHelp } from "./SchemaFieldChrome";
import VrlField from "./VrlField";
import ProblemText from "./ProblemText";
import { VrlFieldContext, type VrlFieldServices } from "./vrlFieldContext";
import {
  checkProblems,
  type Problem,
  type VectorDiagnostic,
} from "./pipelineProblems";
import "./inspector.css";

// These are presentation groups for existing native fields, never schema defaults.
// A field's group is independent of whether it is configured or currently required.
function propertySections(
  kind: Kind,
  type: string,
  primaryKeys: string[],
): SchemaPropertySection[] {
  const encoding = ["encoding", "decoding", "framing", "compression"],
    connection = [
      "auth",
      "tls",
      "proxy",
      "sasl",
      "keepalive",
      "connection_limit",
      "connect_timeout_secs",
      "tls_handshake_timeout_secs",
      "receive_buffer_bytes",
      "send_buffer_bytes",
    ],
    delivery = [
      "buffer",
      "batch",
      "request",
      "acknowledgements",
      "healthcheck",
      "healthcheck_uri",
      "retry_strategy",
    ],
    secondary = new Set([...encoding, ...connection, ...delivery]),
    sampling = kind === "transforms" && type === "sample";
  return [
    sampling
      ? {
          id: "sampling",
          title: "Sampling",
          icon: <Percent size={15} />,
          fields: [
            "rate",
            "ratio",
            "rate_field",
            "ratio_field",
            "key_field",
            "group_by",
            "exclude",
            "sample_rate_key",
          ],
        }
      : {
          id: "configuration",
          title: "Configuration",
          icon: <Settings2 size={15} />,
          fields: [
            ...new Set([
              ...primaryKeys,
              "source",
              "file",
              "files",
              "condition",
              "include",
              "exclude",
              "address",
              "path",
              "mode",
              "uri",
              "endpoint",
              "endpoints",
              "bucket",
              "key_prefix",
              "region",
              "bootstrap_servers",
              "topics",
              "topic",
              "group_id",
              "table",
              "database",
              "url",
              "host",
              "port",
            ]),
          ].filter((key) => !secondary.has(key)),
        },
    {
      id: "encoding",
      title: "Encoding",
      icon: <Braces size={15} />,
      fields: encoding,
    },
    {
      id: "connection",
      title: "Connection",
      icon: <Network size={15} />,
      fields: connection,
    },
    {
      id: "delivery",
      title: "Delivery",
      icon: <Send size={15} />,
      fields: delivery,
    },
    {
      id: "settings",
      title: "Settings",
      icon: <SlidersHorizontal size={15} />,
    },
  ];
}

function OutputName({
  name,
  names,
  editable,
  onRename,
  onPendingChange,
}: {
  name: string;
  names: string[];
  editable: boolean;
  onRename: (before: string, after: string) => void;
  onPendingChange: (id: string, dirty: boolean) => void;
}) {
  const [text, setText] = useState(name),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0),
    fieldId = useId(),
    errorId = useId();
  useEffect(() => {
    setText(name);
    setError("");
  }, [name]);
  useEffect(() => {
    onPendingChange(fieldId, text !== name);
    return () => onPendingChange(fieldId, false);
  }, [fieldId, text, name, attempt, onPendingChange]);
  function commit() {
    if (text === name) return;
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(text) ||
      text === "_unmatched" ||
      names.includes(text)
    ) {
      setError(
        "Use a unique name with letters, numbers, underscores or hyphens.",
      );
      return;
    }
    onPendingChange(fieldId, false);
    setAttempt((previous) => previous + 1);
    onRename(name, text);
  }
  return (
    <div className="schema-output-name">
      <Field label="Output name">
        <input
          aria-label={`Output name ${name}`}
          value={text}
          readOnly={!editable}
          onChange={(event) => {
            setText(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape" && text !== name) {
              event.preventDefault();
              event.stopPropagation();
              setText(name);
              setError("");
            }
          }}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
        />
      </Field>
      {error && (
        <p role="status" className="schema-control-error" id={errorId}>
          {error}
        </p>
      )}
      {editable && text !== name && (
        <div className="schema-json-actions">
          <Button variant="secondary compact" onClick={commit}>
            Rename output
          </Button>
          <Button
            variant="ghost compact"
            onClick={() => {
              setText(name);
              setError("");
            }}
          >
            Cancel rename
          </Button>
        </div>
      )}
    </div>
  );
}

/** Read a VRL option by its dotted path inside a component. */
export function vrlValue(component: Config, path: string): string {
  const [first, second, third] = path.split(".");
  if (first === "route" && second) {
    const value = component.route?.[second];
    return typeof value === "string" ? value : value?.source || "";
  }
  if (first === "routes" && third === "condition") {
    const value = component.routes?.[Number(second)]?.condition;
    return typeof value === "string" ? value : value?.source || "";
  }
  const value = component[first];
  return typeof value === "string" ? value : value?.source || "";
}
/** Write a VRL option, keeping a structured `{type: "vrl", source}` condition. */
export function withVrlValue(
  component: Config,
  path: string,
  text: string,
): Config {
  const set = (current: any) =>
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...current, source: text }
      : text;
  const [first, second, third] = path.split(".");
  if (first === "route" && second)
    return {
      ...component,
      route: { ...component.route, [second]: set(component.route?.[second]) },
    };
  if (
    first === "routes" &&
    third === "condition" &&
    Array.isArray(component.routes)
  ) {
    const routes = component.routes.map((route: Config, index: number) =>
      index === Number(second)
        ? { ...route, condition: set(route?.condition) }
        : route,
    );
    return { ...component, routes };
  }
  return { ...component, [first]: set(component[first]) };
}
/** Field paths as reported by Vector: `route.x` for a route condition. */
const canonicalPath = (path: string) =>
  path
    .replace(/^route\.([^.]+)\.condition$/, "route.$1")
    .replace(/\.source$/, "");
/** VRL options show their findings in the VRL editor, not under the field. */
const vrlPath = (path: string) =>
  /^(?:source|condition|route\.[^.]+|routes\.\d+\.condition)$/.test(
    canonicalPath(path),
  );
export type SettingsFocus = {
  field?: string;
  line?: number;
  column?: number;
  nonce: number;
};

export default function PipelineSettings({
  id,
  kind,
  component,
  editable,
  issues,
  problems = [],
  fieldPickerTarget,
  onChange,
  onPendingChange,
  onRouteRename,
  onRouteRemove,
  pipelineId,
  userId,
  timezone,
  canRunSamples = false,
  existingTests = [],
  onSaveTests,
  focus,
}: {
  id: string;
  kind: Kind;
  component: Config;
  editable: boolean;
  issues: string[];
  /** Local and Vector findings for this component. */
  problems?: Problem[];
  fieldPickerTarget?: HTMLElement | null;
  onChange: (value: Config) => void;
  onPendingChange: (id: string, dirty: boolean) => void;
  onRouteRename: (before: string, after: string) => void;
  onRouteRemove: (name: string) => void;
  pipelineId?: string;
  userId?: string;
  timezone?: string;
  canRunSamples?: boolean;
  existingTests?: readonly Config[];
  onSaveTests?: (tests: Config[]) => void;
  /** Reveal a field (and a position in a VRL program) when `nonce` changes. */
  focus?: SettingsFocus | null;
}) {
  const definition = catalog.find(
    (c) => c.kind === kind && c.type === component.type,
  );
  const reportPending = onPendingChange;
  const fields = definition?.fields || [];
  const schema = definition ? componentSchema(definition) : undefined;
  const resolved = resolveSchema(schema || {}, vectorSchema, component),
    hasRootChoices =
      !!schema && hasRootSchemaVariants(schema, vectorSchema, component);
  // Keep native constraints while presenting curated names and primary fields first.
  // All configured fields share one list and one Add field picker.
  const primaryProperties: Record<string, Schema> = {};
  for (const field of hasRootChoices ? [] : fields) {
    const key = field.key.split(".")[0];
    if (Object.hasOwn(primaryProperties, key)) continue;
    const grouped = field.key.includes(".");
    const fieldSchema: Schema = resolved.properties?.[key] || {};
    primaryProperties[key] = {
      ...(Object.keys(fieldSchema).length
        ? fieldSchema
        : {
            type:
              field.type === "number"
                ? "number"
                : field.type === "array"
                  ? "array"
                  : "string",
            ...(field.type === "array" ? { items: { type: "string" } } : {}),
            ...(field.options ? { enum: field.options } : {}),
          }),
      _metadata: {
        ...fieldSchema._metadata,
        ...(!grouped
          ? { "docs::human_name": field.label, "vectory::label": field.label }
          : {}),
        ...(field.type === "vrl"
          ? { "docs::syntax_override": "vrl_program" }
          : {}),
        ...(field.type === "array"
          ? { "vectory::entry_label": key === "include" ? "path" : "item" }
          : {}),
      },
    };
  }
  const settingsSchema = hasRootChoices
    ? schema!
    : {
        ...resolved,
        type: "object",
        properties: {
          ...primaryProperties,
          ...resolved.properties,
          ...primaryProperties,
        },
        required: schema
          ? resolved.required
          : fields
              .filter((field) => field.required)
              .map((field) => field.key.split(".")[0]),
      };
  const hasRouteEditor = kind === "transforms" && component.type === "route";
  const sections = propertySections(
    kind,
    component.type,
    fields.map((field) => field.key.split(".")[0]),
  );
  // The sample tester's compile result is fresher than the last pipeline
  // check for this step's VRL, so it replaces those findings while known.
  const [compiled, setCompiled] = useState<VectorDiagnostic[] | null>(null);
  const [pathHints, setPathHints] = useState<string[]>([]);
  const [studio, setStudio] = useState<string | null>(null);
  const views = useRef(new Map<string, EditorView>());
  const testable =
    kind === "transforms" &&
    ["remap", "filter", "route", "exclusive_route"].includes(component.type) &&
    !!pipelineId &&
    !!userId;
  const testerField =
    component.type === "remap"
      ? "source"
      : component.type === "filter"
        ? "condition"
        : "";
  const fieldProblems = useCallback(
    (path: string) => {
      const field = canonicalPath(path);
      if (compiled && testable)
        return compiled
          .filter((item) => (item.field || testerField) === field)
          .map(
            (item) =>
              checkProblems(
                {
                  valid: false,
                  vector_validated: false,
                  errors: [],
                  warnings: [],
                  diagnostics: [item],
                },
                {},
              )[0],
          );
      return problems.filter((problem) => problem.field === field);
    },
    [compiled, problems, testable, testerField],
  );
  function jump(field: string, line: number, column: number) {
    const view = [...views.current].find(
      ([path]) => canonicalPath(path) === field,
    )?.[1];
    if (!view) return false;
    const target = view.state.doc.line(Math.min(line, view.state.doc.lines));
    const position = Math.min(target.to, target.from + Math.max(0, column - 1));
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    view.dom.scrollIntoView?.({ block: "nearest" });
    view.focus();
    return true;
  }
  const root = useRef<HTMLDivElement>(null);
  // Reveal the field a problem points to once its control has mounted.
  useEffect(() => {
    if (!focus) return;
    let frame = 0,
      attempts = 0;
    const field = focus.field ? canonicalPath(focus.field) : "";
    const reveal = () => {
      if (field && vrlPath(field)) {
        if (jump(field, focus.line || 1, focus.column || 1)) return;
      } else if (field) {
        const control = root.current?.querySelector<HTMLElement>(
          `[data-field-path="${CSS.escape(field)}"]`,
        );
        if (control) {
          control.scrollIntoView?.({ block: "center" });
          // The value itself, not the help or actions buttons in its header.
          (
            control.querySelector<HTMLElement>(
              "input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable=true]",
            ) || control.querySelector<HTMLElement>("button:not(:disabled)")
          )?.focus({ preventScroll: true });
          return;
        }
      }
      if (++attempts < 12) {
        frame = requestAnimationFrame(reveal);
        return;
      }
      root.current
        ?.querySelector<HTMLElement>(
          ".pipeline-vector-problems, .pipeline-field-errors",
        )
        ?.scrollIntoView?.({ block: "nearest" });
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [focus?.nonce]);
  const optionProblems = useCallback(
    (path: string) =>
      vrlPath(path) ? [] : problems.filter((problem) => problem.field === path),
    [problems],
  );
  const tester = (wide = false) =>
    testable ? (
      <SyntheticTester
        key={`${id}:${wide}`}
        userId={userId!}
        pipelineId={pipelineId!}
        componentId={id}
        component={component}
        timezone={timezone}
        canRun={canRunSamples}
        canSaveTests={editable}
        existingTests={existingTests}
        onSaveTests={onSaveTests}
        onCompile={setCompiled}
        onPaths={setPathHints}
        onJump={jump}
        wide={wide}
      />
    ) : null;
  const services = useMemo<VrlFieldServices>(
    () => ({
      problems: fieldProblems,
      pathHints,
      after: (path) =>
        !studio && canonicalPath(path) === testerField ? tester() : null,
      expand: (path) => setStudio(path),
      registerView: (path, view) => {
        if (view) views.current.set(path, view);
        else views.current.delete(path);
      },
    }),
    [
      fieldProblems,
      pathHints,
      testerField,
      studio,
      component,
      canRunSamples,
      existingTests,
    ],
  );
  // Vector's findings outside VRL programs. Findings for a shown option also
  // appear under that option.
  const summary = problems.filter(
    (problem) =>
      problem.origin === "vector" && !(problem.field && vrlPath(problem.field)),
  );
  return (
    <VrlFieldContext.Provider value={services}>
      <FieldProblemsContext.Provider value={optionProblems}>
        <div className="pipeline-settings" ref={root}>
          {!!definition?.platforms?.length && (
            <div className="pipeline-capability-hint">
              <SchemaFieldHelp
                title="Platform availability"
                className="pipeline-capability-trigger"
                triggerContent={
                  <>
                    <CircleHelp size={14} aria-hidden="true" />
                    <span>Platform availability</span>
                  </>
                }
              >
                <p>
                  Available on {definition.platforms.join(", ")}. The device’s
                  Vector build must include this component.
                </p>
              </SchemaFieldHelp>
            </div>
          )}
          {definition?.device_capability !== "allowed" && (
            <div className="pipeline-capability-hint">
              <SchemaFieldHelp
                title="Full Vector mode required"
                className="pipeline-capability-trigger"
                triggerContent={
                  <>
                    <CircleHelp size={14} aria-hidden="true" />
                    <span>Full Vector mode required</span>
                  </>
                }
              >
                <p>
                  Before deploying, the device owner must enable full Vector
                  mode locally. The device’s Vector build must also include this
                  component.
                </p>
                <p>
                  <DocLink
                    topic="installation"
                    section="choose-configuration-capabilities"
                  >
                    How to enable full mode
                  </DocLink>
                </p>
              </SchemaFieldHelp>
            </div>
          )}
          {issues.length > 0 && (
            <div className="pipeline-field-errors" role="status">
              <strong>Finish this step</strong>
              <ul>
                {issues.map((issue) => (
                  <li key={issue}>{issue.replace(`${id}: `, "")}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.length > 0 && (
            <div className="pipeline-vector-problems" role="status">
              <strong>
                Vector found{" "}
                {summary.length === 1
                  ? "a problem"
                  : `${summary.length} problems`}
              </strong>
              <ul>
                {summary.map((problem) => (
                  <li
                    key={problem.key}
                    data-severity={problem.severity}
                    data-stale={problem.stale || undefined}
                  >
                    <span>
                      {problem.field && problem.field !== "inputs" && (
                        <code>{problem.field}</code>
                      )}
                      <ProblemText text={problem.message} />
                    </span>
                    {problem.hint && (
                      <small>
                        <ProblemText text={problem.hint.split("\n")[0]} />
                      </small>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {definition && (
            <PipelineSchemaFields
              schema={settingsSchema}
              root={vectorSchema}
              component={component}
              fieldPickerTarget={fieldPickerTarget}
              fieldSections={sections}
              editable={editable}
              onChange={onChange}
              onPendingChange={reportPending}
              exclude={[...(hasRouteEditor ? ["route"] : [])]}
            />
          )}
          {hasRouteEditor && (
            <section className="pipeline-settings-section">
              <div className="pipeline-settings-section-heading">
                <h3>Named outputs</h3>
                <SchemaFieldHelp title="Named outputs">
                  <p>
                    Each condition creates an output that destinations can
                    select. Events matching no condition use{" "}
                    <code>_unmatched</code>.
                  </p>
                </SchemaFieldHelp>
              </div>
              {Object.entries(component.route || {}).map(
                ([name, condition]) => (
                  <div className="pipeline-route" key={name}>
                    <OutputName
                      name={name}
                      names={Object.keys(component.route || {})}
                      editable={editable}
                      onRename={onRouteRename}
                      onPendingChange={reportPending}
                    />
                    <FieldPathScope path={`route.${name}`}>
                      <PipelineSchemaControl
                        name="condition"
                        label={`Condition for ${name}`}
                        schema={{
                          $ref: "#/definitions/vector::conditions::AnyCondition",
                        }}
                        root={vectorSchema}
                        value={condition}
                        editable={editable}
                        onPendingChange={reportPending}
                        onChange={(value) =>
                          onChange({
                            ...component,
                            route: { ...component.route, [name]: value },
                          })
                        }
                      />
                    </FieldPathScope>
                    {editable && (
                      <Button
                        variant="ghost compact"
                        onClick={() => onRouteRemove(name)}
                      >
                        Remove output
                      </Button>
                    )}
                  </div>
                ),
              )}
              {editable && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    let name = "branch",
                      number = 2;
                    while (component.route?.[name]) name = `branch_${number++}`;
                    onChange({
                      ...component,
                      route: { ...component.route, [name]: "true" },
                    });
                  }}
                >
                  Add named output
                </Button>
              )}
            </section>
          )}
          {testable && !testerField && !studio && tester()}
          {!definition && (
            <>
              <div className="pipeline-capability-hint">
                <SchemaFieldHelp
                  title="Custom component"
                  className="pipeline-capability-trigger"
                  triggerContent={
                    <>
                      <CircleHelp size={14} aria-hidden="true" />
                      <span>Custom component</span>
                    </>
                  }
                >
                  <p>
                    Imported fields are preserved and validated by Vector on the
                    device.
                  </p>
                </SchemaFieldHelp>
              </div>
              <PipelineSchemaFields
                schema={{ type: "object", additionalProperties: true }}
                root={vectorSchema}
                component={component}
                fieldPickerTarget={fieldPickerTarget}
                fieldSections={sections}
                onChange={onChange}
                editable={editable}
                onPendingChange={reportPending}
              />
            </>
          )}
          <Modal
            open={!!studio}
            onClose={() => setStudio(null)}
            wide
            className="vrl-studio"
            title={`${id} · ${studio && studio.startsWith("route.") ? `Condition for ${studio.split(".")[1]}` : studio === "condition" ? "Condition" : "VRL program"}`}
            description="Edit the program with more room and test it against your samples."
          >
            {studio && (
              <div className="vrl-studio-body">
                <div className="vrl-studio-program">
                  <VrlField
                    path={studio}
                    title={`${id} ${studio}`}
                    text={vrlValue(component, canonicalPath(studio))}
                    readOnly={!editable}
                    onInput={(text) =>
                      onChange(
                        withVrlValue(component, canonicalPath(studio), text),
                      )
                    }
                  />
                </div>
                <div className="vrl-studio-samples">{tester(true)}</div>
              </div>
            )}
          </Modal>
        </div>
      </FieldProblemsContext.Provider>
    </VrlFieldContext.Provider>
  );
}
