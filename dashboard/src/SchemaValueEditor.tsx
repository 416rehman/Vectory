import {
  useContext,
  useEffect,
  useId,
  useState,
  useRef,
  useCallback,
  useMemo,
  createContext,
} from "react";
import {
  Braces,
  FileCode2,
  Link2,
  Folder,
  Regex,
  Timer,
  HardDrive,
} from "lucide-react";
import { Button } from "./ui";
import { parseDocument } from "yaml";
import ConfigurationCodeEditor, {
  type ConfigurationDiagnostic,
} from "./ConfigurationCodeEditor";
import "./schema-value-editor.css";
import VrlField from "./VrlField";
import { SchemaFieldHeader } from "./SchemaFieldChrome";
import SecretReferenceField from "./SecretReferenceField";
import { SecretPathContext, SecretScopeContext } from "./secretFieldContext";
import { isSecretField } from "./secretFields";
import { parseExactJSON } from "./configurationNumbers";
import {
  fieldModel,
  resolveSchema,
  arrayItemSchema,
  mapValueSchema,
  isSecretReference,
  validateFieldValue,
  type Schema,
} from "./pipelineSchema";

export const PendingFieldsContext = createContext<
  (id: string, dirty: boolean) => void
>(() => {});
export const ignorePending = () => {};
export function usePendingField(dirty: boolean) {
  const id = useId(),
    pending = useContext(PendingFieldsContext);
  useEffect(() => {
    pending(id, dirty);
    return () => pending(id, false);
  }, [id, pending, dirty]);
}
export function usePendingScope() {
  const parent = useContext(PendingFieldsContext),
    fields = useRef(new Set<string>()),
    // Whether anything under this scope is unapplied, for what must react to
    // it clearing (the set itself changes without a render).
    [pending, setPending] = useState(false);
  const report = useCallback(
    (id: string, dirty: boolean) => {
      if (dirty) fields.current.add(id);
      else fields.current.delete(id);
      setPending(fields.current.size > 0);
      parent(id, dirty);
    },
    [parent],
  );
  return { fields, report, pending };
}
/** A message that refuses an action until unapplied edits are dealt with. */
export const PENDING_REFUSAL = "Apply or discard pending";
const asText = (value: any) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const json = (value: any) =>
  value === undefined ? "" : JSON.stringify(value, null, 2);
const units: Record<string, { label: string; scale: number }[]> = {
  seconds: [
    { label: "seconds", scale: 1 },
    { label: "milliseconds", scale: 0.001 },
    { label: "minutes", scale: 60 },
    { label: "hours", scale: 3600 },
  ],
  milliseconds: [
    { label: "milliseconds", scale: 1 },
    { label: "seconds", scale: 1000 },
    { label: "minutes", scale: 60000 },
  ],
  bytes: [
    { label: "bytes", scale: 1 },
    { label: "KiB", scale: 1024 },
    { label: "MiB", scale: 1048576 },
    { label: "GiB", scale: 1073741824 },
  ],
};
function unitOptions(unit?: string) {
  return units[
    (
      {
        s: "seconds",
        secs: "seconds",
        second: "seconds",
        ms: "milliseconds",
        millisecond: "milliseconds",
        byte: "bytes",
        B: "bytes",
      } as Record<string, string>
    )[unit || ""] ||
      unit ||
      ""
  ];
}
export function ScalarValueEditor({
  name,
  schema,
  root,
  value,
  onChange,
  editable,
  required = false,
  label,
  path,
  hideHeader = false,
}: {
  name: string;
  schema: Schema;
  root: Schema;
  value: any;
  onChange: (v: any) => void;
  editable: boolean;
  required?: boolean;
  label?: string;
  path?: string;
  hideHeader?: boolean;
}) {
  const model = fieldModel(name, schema, root, value, {
    required,
    present: value !== undefined,
    path,
  });
  const secretScope = useContext(SecretScopeContext),
    secretPath = useContext(SecretPathContext);
  const title = label || model.title;
  const numeric =
    model.schema.type === "number" || model.schema.type === "integer";
  const choices = numeric ? unitOptions(model.intent.unit) : undefined;
  const [unitIndex, setUnitIndex] = useState(0),
    scale = choices?.[unitIndex]?.scale || 1;
  const serialized =
    numeric && typeof value === "number"
      ? String(value / scale)
      : asText(value);
  const [text, setText] = useState(serialized),
    [error, setError] = useState("");
  const errorId = useId(),
    controlId = useId();
  useEffect(() => {
    setText(serialized);
    setError("");
  }, [serialized]);
  usePendingField(text !== serialized);
  const disabled =
    !editable || model.readOnly || Object.hasOwn(model.schema, "const");
  const multiline =
    ["vrl", "regex"].includes(model.intent.kind) ||
    model.schema._metadata?.["docs::syntax_override"] === "lua" ||
    (typeof value === "string" && value.includes("\n"));
  const Icon = (
    {
      uri: Link2,
      path: Folder,
      vrl: FileCode2,
      regex: Regex,
      template: Braces,
      duration: Timer,
      bytes: HardDrive,
    } as any
  )[model.intent.kind];
  function input(next: string) {
    setText(next);
    let parsed: any = next;
    if (numeric) {
      if (!next.trim()) {
        if (!required) {
          onChange(undefined);
          setError("");
        } else setError("Enter a number.");
        return;
      }
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(next.trim())) {
        setError("Enter a complete number.");
        return;
      }
      parsed = Number(next) * scale;
      if (!Number.isFinite(parsed)) {
        setError("Enter a finite number.");
        return;
      }
      if (model.schema.type === "integer" && !Number.isSafeInteger(parsed)) {
        setError("Enter a whole number within the supported precision.");
        return;
      }
    }
    const problems = validateFieldValue(parsed, schema, root);
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setError("");
    onChange(parsed);
  }
  // Credential fields never get a text box for the value: a device secret by
  // name where this component's type allows one, otherwise a Vector reference.
  if (model.sensitive && !numeric) {
    const device =
      secretScope &&
      isSecretField(secretScope.kind, secretScope.type, secretPath)
        ? { componentId: secretScope.id, path: secretPath }
        : null;
    return (
      <SecretReferenceField
        title={title}
        value={value}
        onChange={onChange}
        editable={!disabled}
        required={required}
        device={device}
        className={
          hideHeader ? "" : "schema-field-owned schema-standalone-value"
        }
        header={
          !hideHeader && (
            <SchemaFieldHeader
              title={title}
              required={required}
              model={model}
            />
          )
        }
      />
    );
  }
  const placeholder = model.hasDefault
    ? asText(model.defaultValue)
    : model.examples.find(
        (example: any) =>
          typeof example === "string" || typeof example === "number",
      );
  return (
    <div
      className={`schema-value schema-value-${model.intent.kind} ${hideHeader ? "" : "schema-field-owned schema-standalone-value"}`}
      data-semantic={model.intent.kind}
    >
      {!hideHeader && (
        <SchemaFieldHeader title={title} required={required} model={model} />
      )}
      <div className="field">
        <span id={`${controlId}-label`}>{title}</span>
        {model.intent.kind === "vrl" ? (
          <VrlField
            path={path || name}
            title={title}
            text={text}
            readOnly={disabled}
            describedBy={error ? errorId : undefined}
            onInput={input}
          />
        ) : multiline ? (
          <div className="schema-code-control">
            <div className="schema-code-toolbar">
              <span>
                {model.intent.kind === "regex" ? "Regular expression" : "Code"}
              </span>
              <span>
                {text.split("\n").length}{" "}
                {text.split("\n").length === 1 ? "line" : "lines"}
              </span>
            </div>
            <textarea
              id={controlId}
              aria-labelledby={`${controlId}-label`}
              className="editor-code-input"
              rows={Math.min(10, Math.max(4, text.split("\n").length + 1))}
              readOnly={disabled}
              value={text}
              onChange={(event) => input(event.target.value)}
              spellCheck={false}
              aria-invalid={!!error}
              aria-required={required || undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
        ) : (
          <div className="schema-value-input">
            {Icon && <Icon size={15} aria-hidden="true" />}
            <input
              id={controlId}
              aria-labelledby={`${controlId}-label`}
              type="text"
              inputMode={numeric ? "decimal" : undefined}
              readOnly={disabled}
              value={text}
              onChange={(event) => input(event.target.value)}
              onBlur={() => {
                if (numeric && !error) setText(serialized);
              }}
              placeholder={
                placeholder === undefined ? undefined : String(placeholder)
              }
              spellCheck={
                !numeric &&
                !["path", "uri", "template"].includes(model.intent.kind)
              }
              aria-invalid={!!error}
              aria-required={required || undefined}
              aria-describedby={error ? errorId : undefined}
            />
            {choices ? (
              <select
                aria-label={`${title} display unit`}
                value={unitIndex}
                disabled={text !== serialized}
                onChange={(event) => setUnitIndex(Number(event.target.value))}
              >
                {choices.map((unit, index) => (
                  <option key={unit.label} value={index}>
                    {unit.label}
                  </option>
                ))}
              </select>
            ) : model.intent.unit ? (
              <span className="schema-unit">{model.intent.unit}</span>
            ) : null}
          </div>
        )}
      </div>
      {error && (
        <p className="schema-control-error" id={errorId} role="status">
          {error}
        </p>
      )}
    </div>
  );
}

type JSONValidationOptions = {
  schema?: Schema;
  root?: Schema;
  path?: string;
  label?: string;
  /** Synthetic event data is not configuration credential material. */
  protectCredentials?: boolean;
};
export type JSONValueDiagnosis = {
  value?: any;
  parseValid: boolean;
  diagnostics: ConfigurationDiagnostic[];
};
const emptySchema: Schema = {};

/** Parse only JSON values; unlike the pipeline parser this also accepts scalar/list fields. */
export function diagnoseJSONValue(
  text: string,
  {
    schema,
    root = emptySchema,
    path,
    label = "Value",
    protectCredentials = true,
  }: JSONValidationOptions = {},
): JSONValueDiagnosis {
  const diagnostics: ConfigurationDiagnostic[] = [];
  const add = (message: string, key?: string, from?: number, to?: number) => {
    if (diagnostics.length >= 20) return;
    if (from === undefined && key) {
      const token = JSON.stringify(key);
      const found = text.indexOf(token);
      if (found >= 0) {
        from = found;
        to = found + token.length;
      }
    }
    const start = Math.max(0, Math.min(text.length, from ?? 0));
    diagnostics.push({
      from: start,
      to: Math.max(start, Math.min(text.length, to ?? start + 1)),
      severity: "error",
      message,
    });
  };
  if (new TextEncoder().encode(text).length > 1_048_576) {
    add("This JSON field exceeds the 1 MiB editing limit.");
    return { parseValid: false, diagnostics };
  }
  // Bound recursion before JSON/YAML parsing or the exact-number walk. Braces in
  // string values do not add nesting; invalid syntax is diagnosed below.
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "[" || char === "{") {
      if (++depth > 64) {
        add(
          "This JSON field is too deeply nested to edit safely.",
          undefined,
          index,
        );
        return { parseValid: false, diagnostics };
      }
    } else if (char === "]" || char === "}") depth--;
  }
  let value: any;
  try {
    value = parseExactJSON(text);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Enter valid JSON.";
    // YAML's JSON AST supplies offsets even when the browser's JSON error omits them.
    const positioned = parseDocument(text, {
      schema: "json",
      prettyErrors: false,
      logLevel: "silent",
    }).errors[0];
    const offset = /position (\d+)/i.exec(message);
    add(
      message,
      undefined,
      positioned?.pos[0] ??
        (offset
          ? Number(offset[1])
          : /unexpected end/i.test(message)
            ? text.length
            : 0),
      positioned?.pos[1],
    );
    return { parseValid: false, diagnostics };
  }
  const document = parseDocument(text, {
    schema: "json",
    uniqueKeys: true,
    prettyErrors: false,
    logLevel: "silent",
  });
  if (document.errors.length) {
    for (const error of document.errors)
      add(error.message, undefined, error.pos[0], error.pos[1]);
    return { parseValid: false, diagnostics };
  }
  let count = 0;
  function bounded(current: any, depth: number): boolean {
    if (++count > 50_000 || depth > 64) return false;
    return (
      !current ||
      typeof current !== "object" ||
      Object.values(current).every((child) => bounded(child, depth + 1))
    );
  }
  if (!bounded(value, 0)) {
    add(
      "This JSON field is too deeply nested or contains too many values to edit safely.",
    );
    return { parseValid: false, diagnostics };
  }
  // A sensitive container such as the global `secret` provider map is not itself
  // a credential. Inherit sensitivity through arrays and explicit metadata only.
  function credentials(
    current: any,
    input: Schema,
    name: string,
    at: string,
    inherited = false,
  ) {
    const model = fieldModel(name, input, root, current, { path: at }),
      resolved = model.schema;
    if (typeof current === "string") {
      const normalized = name.toLowerCase().replace(/[-.]/g, "_");
      const credentialName =
        /(?:^|_)(?:password|passwd|api_key|apikey|access_key_id|secret_access_key|token|bearer|authorization|proxy_authorization|client_secret|private_key)$/.test(
          normalized,
        );
      if (
        (inherited || model.sensitive || credentialName) &&
        !isSecretReference(current)
      )
        add(
          `${at}: enter a secret reference. Plaintext credentials are not saved.`,
          name,
        );
      const authority = current.split("://")[1]?.split("/")[0],
        userInfo = authority?.includes("@")
          ? authority.slice(0, authority.indexOf("@"))
          : undefined;
      if (
        userInfo !== undefined &&
        !userInfo
          .split(":")
          .every(
            (part) =>
              isSecretReference(part) && !part.startsWith("vectory-secret:"),
          )
      )
        add(`${at}: URL credentials must use native secret references.`, name);
      return;
    }
    if (Array.isArray(current))
      current.forEach((child, index) => {
        const field = arrayItemSchema(resolved, index);
        credentials(
          child,
          field && typeof field === "object" ? field : emptySchema,
          name,
          `${at}[${index}]`,
          inherited || model.sensitive,
        );
      });
    else if (current && typeof current === "object")
      for (const [key, child] of Object.entries(current))
        credentials(
          child,
          mapValueSchema(resolved, key),
          key,
          `${at}.${key}`,
          inherited || !!resolved._metadata?.sensitive,
        );
  }
  const fieldPath = path || label,
    fieldName = path?.split(".").at(-1) || label;
  if (protectCredentials)
    credentials(value, schema || emptySchema, fieldName, fieldPath);
  if (schema) {
    // Environment interpolation happens before Vector's type checks. Keep those
    // references intact and validate the surrounding structure and literal values.
    function localSchema(input: Schema, current: any): Schema {
      if (
        typeof current === "string" &&
        /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)$/.test(
          current,
        )
      )
        return {};
      const resolved = resolveSchema(input, root, current);
      if (Array.isArray(current))
        return {
          ...resolved,
          items: undefined,
          prefixItems: current.map((child, index) =>
            localSchema(
              arrayItemSchema(resolved, index) === false
                ? { not: {} }
                : arrayItemSchema(resolved, index) || {},
              child,
            ),
          ),
        };
      if (current && typeof current === "object")
        return {
          ...resolved,
          properties: Object.fromEntries(
            Object.entries(current).map(([key, child]) => [
              key,
              localSchema(mapValueSchema(resolved, key), child),
            ]),
          ),
        };
      return input;
    }
    for (const message of validateFieldValue(
      value,
      localSchema(schema, value),
      root,
      fieldPath,
    )) {
      const prefix = message
        .split(":")[0]
        .replace(/^Enter /, "")
        .replace(/\.$/, "");
      add(
        message,
        prefix
          .split(".")
          .at(-1)
          ?.replace(/\[\d+\]$/, ""),
      );
    }
  }
  return { value, parseValid: true, diagnostics };
}

export function JSONValueEditor({
  label,
  value,
  editable,
  onChange,
  schema,
  root = emptySchema,
  path,
}: {
  label: string;
  value: any;
  editable: boolean;
  onChange: (v: any) => void;
  schema?: Schema;
  root?: Schema;
  path?: string;
}) {
  const serialized = json(value),
    [text, setText] = useState(serialized),
    [conflict, setConflict] = useState(false),
    [applyError, setApplyError] = useState("");
  const previousSerialized = useRef(serialized),
    labelId = useId(),
    feedbackId = useId();
  useEffect(() => {
    if (text === previousSerialized.current || text === serialized) {
      setText(serialized);
      setConflict(false);
      setApplyError("");
    } else if (serialized !== previousSerialized.current) setConflict(true);
    previousSerialized.current = serialized;
  }, [serialized]);
  const dirty = text !== serialized;
  usePendingField(dirty);
  const diagnosis = useMemo(
    () => diagnoseJSONValue(text, { schema, root, path, label }),
    [text, schema, root, path, label],
  );
  const model = schema
    ? fieldModel(path?.split(".").at(-1) || label, schema, root, value, {
        path,
      })
    : undefined;
  const readOnly =
    !editable ||
    !!model?.readOnly ||
    (!!model && Object.hasOwn(model.schema, "const"));
  const diagnostics = text.trim() || dirty ? diagnosis.diagnostics : [];
  function format() {
    if (readOnly || !diagnosis.parseValid) return;
    setText(json(diagnosis.value));
    setApplyError("");
  }
  function apply() {
    if (
      readOnly ||
      !dirty ||
      diagnosis.diagnostics.length ||
      !diagnosis.parseValid
    )
      return;
    if (conflict && !confirm("Replace the updated value with this JSON draft?"))
      return;
    try {
      onChange(diagnosis.value);
      setText(json(diagnosis.value));
      setConflict(false);
      setApplyError("");
    } catch (error) {
      setApplyError(
        error instanceof Error
          ? error.message
          : "This value could not be applied.",
      );
    }
  }
  return (
    <div
      className="pipeline-json-field"
      role="group"
      aria-labelledby={labelId}
      aria-describedby={feedbackId}
    >
      <div className="schema-json-toolbar">
        <span id={labelId}>{label} (JSON)</span>
        {!readOnly && (
          <Button
            variant="ghost compact"
            disabled={!diagnosis.parseValid}
            onClick={format}
          >
            Format JSON
          </Button>
        )}
      </div>
      <ConfigurationCodeEditor
        value={text}
        format="json"
        label={`${label} (JSON)`}
        describedBy={feedbackId}
        readOnly={readOnly}
        diagnostics={diagnostics}
        onFormat={readOnly ? undefined : format}
        onChange={(next) => {
          if (!readOnly) {
            setText(next);
            setApplyError("");
          }
        }}
      />
      <div
        id={feedbackId}
        className="schema-json-feedback"
        role="status"
        aria-live="polite"
      >
        {conflict && (
          <p className="schema-control-error">
            This value changed in another field. Your JSON draft is preserved;
            review it before applying.
          </p>
        )}
        {applyError && <p className="schema-control-error">{applyError}</p>}
        {!!diagnostics.length && (
          <ul className="schema-json-errors">
            {diagnostics.slice(0, 5).map((diagnostic, index) => (
              <li key={index}>{diagnostic.message}</li>
            ))}
          </ul>
        )}
        {diagnostics.length > 5 && (
          <p>{diagnostics.length - 5} more errors are marked in the editor.</p>
        )}
        {!diagnostics.length && (text.trim() || dirty) && (
          <p>
            {schema ? "JSON and local field checks passed." : "Valid JSON."}
            {dirty ? " Not applied." : ""}
          </p>
        )}
      </div>
      {!readOnly && (
        <div className="schema-json-actions">
          <Button
            variant="secondary compact"
            disabled={!dirty || !diagnosis.parseValid || !!diagnostics.length}
            onClick={apply}
          >
            Apply {label.toLowerCase()}
          </Button>
          {dirty && (
            <Button
              variant="ghost compact"
              onClick={() => {
                setText(serialized);
                setConflict(false);
                setApplyError("");
              }}
            >
              Discard changes
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
