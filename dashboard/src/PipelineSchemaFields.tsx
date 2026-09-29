import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  ChevronDown,
  Copy,
  FileCode2,
  Folder,
  HardDrive,
  KeyRound,
  Link2,
  ListPlus,
  Pencil,
  Regex,
  Search,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import type { Config } from "./api";
import { createPortal } from "react-dom";
import * as Popover from "@radix-ui/react-popover";
import { SchemaFieldHeader, type FieldAction } from "./SchemaFieldChrome";
import { Button, Field, IconButton } from "./ui";
import {
  fieldModel,
  fieldTitle,
  initialFieldValue,
  initialEditableFieldValue,
  resolveSchema,
  preservedFieldSchema,
  schemaDescription,
  isSecretReference,
  schemaChoices,
  schemaPropertyKeys,
  setSchemaProperty,
  validateFieldValue,
  type Schema,
} from "./pipelineSchema";
import {
  JSONValueEditor,
  ScalarValueEditor,
  PendingFieldsContext,
  ignorePending,
  usePendingField,
  usePendingScope,
} from "./SchemaValueEditor";
import "./schema-controls.css";

export type SchemaPropertySection = {
  id: string;
  title: string;
  icon?: ReactNode;
  /** Omit fields for the fallback section; membership never depends on values. */
  fields?: readonly string[];
};

const FieldPathContext = createContext("");
const FieldTrailContext = createContext<string[]>([]);
const ConditionFormatContext = createContext(false);
const clone = (value: any) =>
  value === undefined ? undefined : structuredClone(value);
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const record = (value: any): value is Config =>
  !!value && typeof value === "object" && !Array.isArray(value);
const genericTypes = [
  { type: "string", label: "Text", value: "" },
  { type: "number", label: "Number", value: 0 },
  { type: "boolean", label: "Boolean", value: false },
  { type: "object", label: "Object", value: {} },
  { type: "array", label: "List", value: [] },
  { type: "null", label: "Null", value: null },
];
function PropertyPendingScope({
  name,
  report,
  children,
}: {
  name: string;
  report: (name: string, id: string, pending: boolean) => void;
  children: ReactNode;
}) {
  const pending = useCallback(
    (id: string, dirty: boolean) => report(name, id, dirty),
    [name, report],
  );
  return (
    <PendingFieldsContext.Provider value={pending}>
      {children}
    </PendingFieldsContext.Provider>
  );
}
function itemSchema(schema: Schema, key: string): Schema {
  const matching = Object.entries(schema.patternProperties || {}).flatMap(
    ([pattern, definition]) => {
      try {
        return new RegExp(pattern).test(key) ? [definition as Schema] : [];
      } catch {
        return [];
      }
    },
  );
  if (matching.length)
    return matching.length === 1 ? matching[0] : { allOf: matching };
  return record(schema.additionalProperties) ? schema.additionalProperties : {};
}
function keyErrors(schema: Schema, key: string, root: Schema): string[] {
  const errors = validateFieldValue(key, schema.propertyNames || {}, root);
  if (
    schema.additionalProperties === false &&
    !Object.hasOwn(schema.properties || {}, key)
  ) {
    const matching = Object.keys(schema.patternProperties || {}).some(
      (pattern) => {
        try {
          return new RegExp(pattern).test(key);
        } catch {
          return false;
        }
      },
    );
    if (!matching)
      errors.push("This name does not match an allowed key pattern.");
  }
  return errors;
}

function MapEntry({
  entryKey,
  value,
  schema,
  root,
  onChange,
  onRename,
  onRemove,
  onDuplicate,
  editable,
  depth,
  label,
}: {
  entryKey: string;
  value: any;
  schema: Schema;
  root: Schema;
  onChange: (v: any) => void;
  onRename: (key: string) => string | undefined;
  onRemove: () => void;
  onDuplicate: () => void;
  editable: boolean;
  depth: number;
  label: string;
}) {
  const scope = usePendingScope();
  const [renaming, setRenaming] = useState(false),
    [name, setName] = useState(entryKey),
    [error, setError] = useState("");
  usePendingField(renaming && name !== entryKey);
  return (
    <div className="schema-map-entry">
      {renaming && (
        <div className="schema-key-editor">
          <Field label={`Rename ${entryKey}`}>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
              autoFocus
              aria-invalid={!!error}
            />
          </Field>
          <Button
            variant="secondary compact"
            onClick={() => {
              if (scope.fields.current.size) {
                setError(
                  "Apply or discard pending value changes before renaming this entry.",
                );
                return;
              }
              const problem = onRename(name);
              if (problem) setError(problem);
              else {
                setRenaming(false);
                setError("");
              }
            }}
          >
            Rename
          </Button>
          <IconButton
            icon={X}
            label="Cancel rename"
            onClick={() => {
              setRenaming(false);
              setName(entryKey);
              setError("");
            }}
          />
        </div>
      )}
      {error && (
        <p className="schema-control-error" role="status">
          {error}
        </p>
      )}
      <PendingFieldsContext.Provider value={scope.report}>
        <SchemaField
          inCollection
          name={entryKey}
          recordLabel={entryKey || "(empty name)"}
          recordActions={
            editable && !renaming
              ? [
                  {
                    icon: Pencil,
                    label: `Rename ${entryKey}`,
                    onSelect: () => setRenaming(true),
                  },
                  {
                    icon: Copy,
                    label: `Duplicate ${entryKey}`,
                    onSelect: onDuplicate,
                  },
                  {
                    icon: Trash2,
                    label: `Remove ${label} ${entryKey}`,
                    onSelect: onRemove,
                    danger: true,
                  },
                ]
              : undefined
          }
          schema={schema}
          root={root}
          value={value}
          onChange={onChange}
          editable={editable}
          depth={depth + 1}
        />
      </PendingFieldsContext.Provider>
    </div>
  );
}
function MapFields({
  schema,
  root,
  value,
  onChange,
  editable,
  depth,
  onEntryPendingChange,
}: {
  schema: Schema;
  root: Schema;
  value: Config;
  onChange: (v: Config) => void;
  editable: boolean;
  depth: number;
  onEntryPendingChange?: (name: string, id: string, pending: boolean) => void;
}) {
  const reportParent = useContext(PendingFieldsContext);
  const reportEntry = useCallback(
    (name: string, id: string, pending: boolean) => {
      if (onEntryPendingChange) onEntryPendingChange(name, id, pending);
      else reportParent(id, pending);
    },
    [onEntryPendingChange, reportParent],
  );
  const [name, setName] = useState(""),
    [entryType, setEntryType] = useState("string"),
    [error, setError] = useState("");
  const label = (
    schema._metadata?.["vectory::entry_label"] || "entry"
  ).toLowerCase();
  const unrestricted =
    schema.additionalProperties === undefined ||
    schema.additionalProperties === true ||
    (record(schema.additionalProperties) &&
      !Object.keys(schema.additionalProperties).length);
  const knownValue = record(value) ? value : {};
  usePendingField(
    name !== "" ||
      Object.values(knownValue).some((value) => value === undefined),
  );
  function check(key: string, old?: string) {
    if (Object.hasOwn(knownValue, key) && key !== old)
      return "An entry with this name already exists.";
    return keyErrors(schema, key, root)[0];
  }
  function remove(key: string) {
    const next = { ...knownValue };
    delete next[key];
    onChange(next);
  }
  return (
    <div className="pipeline-schema-map schema-map">
      {Object.entries(knownValue).map(([key, item]) => (
        <PropertyPendingScope key={key} name={key} report={reportEntry}>
          <MapEntry
            entryKey={key}
            label={label}
            value={item}
            schema={{
              ...itemSchema(schema, key),
              ...(schema._metadata?.sensitive
                ? {
                    _metadata: {
                      ...itemSchema(schema, key)._metadata,
                      sensitive: true,
                    },
                  }
                : {}),
            }}
            root={root}
            depth={depth}
            editable={editable}
            onChange={(next) => onChange({ ...knownValue, [key]: next })}
            onRemove={() => remove(key)}
            onRename={(nextKey) => {
              const problem = check(nextKey, key);
              if (problem) return problem;
              if (nextKey !== key)
                onChange(
                  Object.fromEntries(
                    Object.entries(knownValue).map(([name, v]) => [
                      name === key ? nextKey : name,
                      v,
                    ]),
                  ),
                );
              return undefined;
            }}
            onDuplicate={() => {
              let proposed = key + "_copy",
                index = 2;
              while (Object.hasOwn(knownValue, proposed))
                proposed = key + "_copy_" + index++;
              const problem = check(proposed);
              if (problem) {
                setError(`Choose a valid name before duplicating: ${problem}`);
                setName(proposed);
                return;
              }
              onChange({ ...knownValue, [proposed]: clone(item) });
            }}
          />
        </PropertyPendingScope>
      ))}
      {editable && (
        <div className="schema-map-add">
          <Field label={`New ${label} name`}>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
              placeholder={`${label}_name`}
              aria-invalid={!!error}
            />
          </Field>
          {unrestricted && (
            <Field label="Value type">
              <select
                value={entryType}
                onChange={(event) => setEntryType(event.target.value)}
              >
                {genericTypes.map((type) => (
                  <option value={type.type} key={type.type}>
                    {type.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Button
            variant="secondary compact"
            disabled={!name}
            onClick={() => {
              const problem = check(name);
              if (problem) {
                setError(problem);
                return;
              }
              const item = unrestricted
                ? genericTypes.find((type) => type.type === entryType)!.value
                : initialFieldValue(itemSchema(schema, name), root);
              onChange({ ...knownValue, [name]: clone(item) });
              setName("");
              setError("");
            }}
          >
            Add {label}
          </Button>
          {error && (
            <p className="schema-control-error" role="status">
              {error}
            </p>
          )}
        </div>
      )}
      {!Object.keys(knownValue).length && (
        <p className="schema-empty-note">
          No {label === "entry" ? "entries" : label + "s"} configured.
        </p>
      )}
    </div>
  );
}

type ArrayRow = { id: string; value: any; committed: boolean };
function ArrayFields({
  schema,
  root,
  value,
  onChange,
  editable,
  depth,
}: {
  schema: Schema;
  root: Schema;
  value: any[];
  onChange: (v: any[]) => void;
  editable: boolean;
  depth: number;
}) {
  const counter = useRef(0),
    makeRow = (item: any, committed = true): ArrayRow => ({
      id: `row-${++counter.current}`,
      value: clone(item),
      committed,
    });
  const [rows, setRows] = useState<ArrayRow[]>(() =>
      value.map((item) => makeRow(item)),
    ),
    source = useRef(JSON.stringify(value));
  const [error, setError] = useState("");
  const label = (
      schema._metadata?.["vectory::entry_label"] || "item"
    ).toLowerCase(),
    title = label[0].toUpperCase() + label.slice(1);
  usePendingField(
    rows.some((row) => !row.committed) ||
      !same(
        rows.filter((row) => row.committed).map((row) => row.value),
        value,
      ),
  );
  useEffect(() => {
    const encoded = JSON.stringify(value);
    if (encoded !== source.current) {
      source.current = encoded;
      setRows((previous) =>
        value.map((item, index) => ({
          ...previous[index],
          ...(previous[index] ? {} : makeRow(item)),
          value: clone(item),
          committed: true,
        })),
      );
    }
  }, [JSON.stringify(value)]);
  const childSchema = (index: number) =>
    Array.isArray(schema.items)
      ? schema.items[index] || schema.additionalItems || {}
      : schema.items || {};
  function update(nextRows: ArrayRow[]) {
    setRows(nextRows);
    const next = nextRows
      .filter((row) => row.committed)
      .map((row) => row.value);
    if (next.some((value) => value === undefined)) {
      setError("Finish each list value before applying the list.");
      return;
    }
    const problems = validateFieldValue(next, schema, root);
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setError("");
    if (!same(next, value)) {
      source.current = JSON.stringify(next);
      onChange(next);
    }
  }
  function add(copy?: ArrayRow) {
    if (schema.maxItems !== undefined && rows.length >= schema.maxItems) {
      setError(`This list accepts at most ${schema.maxItems} items.`);
      return;
    }
    const next = copy
      ? clone(copy.value)
      : initialFieldValue(childSchema(rows.length), root);
    const valid =
      next !== undefined &&
      validateFieldValue(next, childSchema(rows.length), root).length === 0 &&
      (!schema._metadata?.sensitive || isSecretReference(next));
    update([...rows, makeRow(next, valid)]);
  }
  function move(index: number, direction: number) {
    const next = [...rows],
      [row] = next.splice(index, 1);
    next.splice(index + direction, 0, row);
    update(next);
  }
  return (
    <div className="pipeline-schema-array schema-array">
      {rows.map((row, index) => (
        <div
          className={`schema-array-entry ${!row.committed ? "schema-array-entry-draft" : ""}`}
          key={row.id}
        >
          <SchemaField
            inCollection
            required
            name={`${title} ${index + 1}`}
            recordLabel={
              <>
                {title} {index + 1}
                {!row.committed && <small>Finish to add</small>}
              </>
            }
            recordActions={
              editable
                ? [
                    {
                      icon: ArrowUp,
                      label: `Move ${label} ${index + 1} up`,
                      disabled: index === 0,
                      onSelect: () => move(index, -1),
                    },
                    {
                      icon: ArrowDown,
                      label: `Move ${label} ${index + 1} down`,
                      disabled: index === rows.length - 1,
                      onSelect: () => move(index, 1),
                    },
                    {
                      icon: Copy,
                      label: `Duplicate ${label} ${index + 1}`,
                      onSelect: () => add(row),
                    },
                    {
                      icon: Trash2,
                      label: `Remove ${label} ${index + 1}`,
                      onSelect: () =>
                        update(rows.filter((old) => old.id !== row.id)),
                      danger: true,
                    },
                  ]
                : undefined
            }
            schema={{
              ...childSchema(index),
              ...(schema._metadata?.sensitive
                ? {
                    _metadata: {
                      ...childSchema(index)._metadata,
                      sensitive: true,
                    },
                  }
                : {}),
            }}
            root={root}
            value={row.value}
            onChange={(next) => {
              const valid =
                next !== undefined &&
                validateFieldValue(next, childSchema(index), root).length ===
                  0 &&
                (!schema._metadata?.sensitive || isSecretReference(next));
              update(
                rows.map((old) =>
                  old.id === row.id
                    ? { ...old, value: next, committed: old.committed || valid }
                    : old,
                ),
              );
            }}
            editable={editable}
            depth={depth + 1}
          />
        </div>
      ))}
      {error && (
        <p className="schema-control-error" role="status">
          {error}
        </p>
      )}
      {editable && (
        <Button variant="secondary compact" onClick={() => add()}>
          Add {label}
        </Button>
      )}
      {!rows.length && (
        <p className="schema-empty-note">
          No {label === "item" ? "items" : label + "s"} configured.
        </p>
      )}
    </div>
  );
}

function SchemaField({
  name,
  schema,
  root,
  value: configuredValue,
  onChange: commitValue,
  editable,
  depth,
  required = false,
  label,
  inCollection = false,
  nestedChoice = false,
  unboxed = false,
  exclude = [],
  onRemove,
  recordLabel,
  recordActions,
  sectionIcon,
  fieldPickerTarget,
  fieldSections,
  requiredReason,
}: {
  name: string;
  schema: Schema;
  root: Schema;
  value: any;
  onChange: (v: any) => void;
  editable: boolean;
  depth: number;
  required?: boolean;
  label?: string;
  inCollection?: boolean;
  nestedChoice?: boolean;
  unboxed?: boolean;
  exclude?: string[];
  onRemove?: () => void;
  recordLabel?: ReactNode;
  recordActions?: FieldAction[];
  sectionIcon?: ReactNode;
  fieldPickerTarget?: HTMLElement | null;
  fieldSections?: readonly SchemaPropertySection[];
  requiredReason?: string;
}) {
  const parentPath = useContext(FieldPathContext),
    path = parentPath ? `${parentPath}.${name}` : name;
  const trail = useContext(FieldTrailContext);
  const inConditionFormat = useContext(ConditionFormatContext);
  const scope = usePendingScope(),
    [choiceError, setChoiceError] = useState("");
  const rawPending = useRef(new Set<string>());
  const reportRawPending = useCallback(
    (id: string, dirty: boolean) => {
      if (dirty) rawPending.current.add(id);
      else rawPending.current.delete(id);
      scope.report(id, dirty);
    },
    [scope.report],
  );
  const hasStructuredPending = () =>
    [...scope.fields.current].some((id) => !rawPending.current.has(id));
  const [stagedChoice, setStagedChoice] = useState<{
    baseline: any;
    previousChoice: string | null;
  } | null>(null);
  const staging =
      !!stagedChoice && same(configuredValue, stagedChoice.baseline),
    value = staging ? undefined : configuredValue;
  usePendingField(staging);
  const model = fieldModel(name, schema, root, value, {
    required,
    present: value !== undefined,
    path,
  });
  const canEdit = editable && !model.readOnly;
  const choices = model.choices;
  const nullChoice = choices?.options.find(
      (option) => option.types.length === 1 && option.types[0] === "null",
    ),
    valueChoice = choices?.options.find(
      (option) => !option.types.includes("null"),
    );
  const simpleNullable =
    choices?.options.length === 2 && !!nullChoice && !!valueChoice;
  const [forcedChoice, setForcedChoice] = useState<string | null>(null),
    [rawOpen, setRawOpen] = useState(false),
    [rawVisited, setRawVisited] = useState(false),
    [objectPickerTarget, setObjectPickerTarget] =
      useState<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (stagedChoice && !same(configuredValue, stagedChoice.baseline)) {
      setStagedChoice(null);
      setForcedChoice(null);
      setChoiceError("");
    }
  }, [configuredValue, stagedChoice]);
  const cache = useRef(new Map<string, any>());
  const forcedOption = choices?.options.find(
    (option) => option.id === forcedChoice,
  );
  const valueType =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const forcedCompatible =
    forcedOption &&
    (value === undefined ||
      !forcedOption.types.length ||
      forcedOption.types.includes(valueType) ||
      (valueType === "number" && forcedOption.types.includes("integer"))) &&
    (!forcedOption.discriminator ||
      value?.[forcedOption.discriminator.key] ===
        forcedOption.discriminator.value);
  const activeChoice =
    (forcedCompatible ? forcedChoice : choices?.selectedId) ||
    (simpleNullable && value !== null ? valueChoice!.id : null);
  const selectedChoice = choices?.options.find(
    (option) => option.id === activeChoice,
  );
  const schemaToRender = selectedChoice?.schema || schema;
  const nestedChoices = selectedChoice
    ? schemaChoices(schemaToRender, root, value)
    : null;
  const resolved = { ...resolveSchema(schemaToRender, root, value) };
  const primitiveChoices =
    !simpleNullable &&
    choices?.options.every(
      (option) =>
        (Object.hasOwn(option.schema, "const") &&
          (option.schema.const === null ||
            typeof option.schema.const !== "object")) ||
        (Array.isArray(option.schema.enum) &&
          option.schema.enum.every(
            (item: any) => item === null || typeof item !== "object",
          )),
    );
  if (primitiveChoices)
    resolved.enum = choices!.options.flatMap((option) =>
      Object.hasOwn(option.schema, "const")
        ? [option.schema.const]
        : option.schema.enum,
    );

  if (!resolved.type && !resolved.enum && value !== undefined && value !== null)
    resolved.type = Array.isArray(value) ? "array" : typeof value;
  const title = label || model.title;
  const tagged =
    choices?.options.every((option) => !!option.discriminator) &&
    choices.options.every(
      (option) =>
        option.discriminator?.key === choices.options[0].discriminator?.key,
    );
  const conditionFormat =
    choices?.options.some((option) => option.label === "String") &&
    choices.options.some((option) => option.label === "Map") &&
    [schema._metadata, model.schema._metadata].some(
      (metadata) => metadata?.["docs::type_override"] === "condition",
    );
  const conditionExpression = conditionFormat
    ? choices?.options.find((option) => option.label === "String")
    : undefined;
  const conditionMap = conditionFormat
    ? choices?.options.find((option) => option.label === "Map")
    : undefined;
  const conditionTypes = conditionMap
    ? schemaChoices(
        conditionMap.schema,
        root,
        record(value) ? value : undefined,
      )
    : null;
  const conditionKinds =
    conditionExpression &&
    conditionTypes?.options.length &&
    conditionTypes.options.every(
      (option) => option.discriminator?.key === "type",
    )
      ? [
          {
            id: "expression",
            label: "VRL expression",
            option: conditionExpression,
          },
          ...conditionTypes.options.map((option) => ({
            id: `type:${option.id}`,
            label: option.label === "VRL" ? "VRL (structured)" : option.label,
            option,
          })),
        ]
      : null;
  const conditionKind =
    typeof value === "string"
      ? "expression"
      : record(value)
        ? conditionKinds?.find(
            ({ option }) => option.discriminator?.value === value.type,
          )?.id || "current"
        : "";
  const selectedConditionType = conditionKinds?.find(
    ({ id }) => id === conditionKind && id !== "expression",
  );
  const conditionType =
    tagged &&
    inConditionFormat &&
    choices?.options[0].discriminator?.key === "type";
  const variantLabel = tagged
    ? conditionType
      ? "Condition type"
      : fieldTitle(choices!.options[0].discriminator!.key, {})
    : conditionFormat
      ? "Condition format"
      : `${title} ${nestedChoice ? "mode" : "format"}`;
  const choiceVisible =
    choices &&
    !simpleNullable &&
    choices.options.length > 1 &&
    !resolved.enum &&
    !choices.options.every(
      (option) => option.types.length === 1 && option.types[0] === "null",
    );
  const unknownType =
    !model.types.length &&
    !model.schema.properties &&
    !model.schema.enum &&
    model.schema.const === undefined &&
    !choices;
  const nullable = model.nullable;
  const rawAvailable =
    !unboxed &&
    !nestedChoice &&
    depth < 20 &&
    (resolved.type === "object" || resolved.type === "array");
  const rawId = useId();
  const ownsHeader = !unboxed && !nestedChoice;
  const structured = resolved.type === "object" || resolved.type === "array";
  const expected = resolved.type === "integer" ? "number" : resolved.type,
    actual =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const mismatched =
    value !== undefined && value !== null && expected && expected !== actual;
  function onChange(next: any) {
    // An empty chosen shape is an editor draft, not a request to erase null.
    if (staging && next === undefined) return;
    setStagedChoice(null);
    if (!same(configuredValue, next)) commitValue(next);
  }
  function cancelStagedChoice() {
    setForcedChoice(stagedChoice?.previousChoice || null);
    setStagedChoice(null);
    setChoiceError("");
  }
  function choose(id: string) {
    if (scope.fields.current.size) {
      setChoiceError(
        simpleNullable
          ? "Apply or discard pending field changes before changing this field."
          : "Apply or discard pending field changes before changing formats.",
      );
      return;
    }
    setChoiceError("");
    const next = choices?.options.find((option) => option.id === id);
    if (!next) return;
    if (activeChoice) cache.current.set(activeChoice, clone(value));
    let nextValue = cache.current.has(id)
      ? clone(cache.current.get(id))
      : clone(next.initialValue);
    if (!cache.current.has(id) && next.discriminator && record(value))
      nextValue = setSchemaProperty(
        value,
        schema,
        root,
        next.discriminator.key,
        next.discriminator.value,
      );
    if (record(nextValue) && record(value)) {
      // Graph fields and opaque extensions belong to the component, not a mode.
      const knownKeys = new Set(
        choices!.options.flatMap((option) =>
          schemaPropertyKeys(option.schema, root),
        ),
      );
      const preservedKeys = new Set([
        ...exclude,
        ...choices!.sharedKeys,
        ...Object.keys(value).filter((key) => !knownKeys.has(key)),
        ...Object.keys(nextValue).filter((key) => !knownKeys.has(key)),
      ]);
      for (const key of preservedKeys) {
        if (Object.hasOwn(value, key))
          Object.defineProperty(nextValue, key, {
            value: clone(value[key]),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        else delete nextValue[key];
      }
    }
    setForcedChoice(id);
    if (nextValue === undefined)
      setStagedChoice((previous) =>
        previous && staging
          ? previous
          : {
              baseline: clone(configuredValue),
              previousChoice: activeChoice || null,
            },
      );
    else onChange(nextValue);
  }
  function chooseConditionKind(id: string) {
    if (scope.fields.current.size) {
      setChoiceError(
        "Apply or discard pending field changes before changing conditions.",
      );
      return;
    }
    setChoiceError("");
    const next = conditionKinds?.find((kind) => kind.id === id);
    if (!next) return;
    if (conditionKind)
      cache.current.set(`condition:${conditionKind}`, clone(value));
    const cached = cache.current.get(`condition:${id}`);
    const currentVrlSource =
      id === "expression" &&
      record(value) &&
      value.type === "vrl" &&
      typeof value.source === "string"
        ? value.source
        : undefined;
    let nextValue: any;
    if (currentVrlSource !== undefined) nextValue = currentVrlSource;
    else if (cache.current.has(`condition:${id}`)) nextValue = clone(cached);
    else if (id === "expression") nextValue = clone(next.option.initialValue);
    else {
      nextValue = record(next.option.initialValue)
        ? clone(next.option.initialValue)
        : {};
      nextValue.type = next.option.discriminator!.value;
      if (record(value)) {
        const knownKeys = new Set(
          conditionTypes!.options.flatMap((option) =>
            schemaPropertyKeys(option.schema, root),
          ),
        );
        for (const key of Object.keys(value))
          if (!knownKeys.has(key)) nextValue[key] = clone(value[key]);
      }
    }
    if (
      next.option.discriminator?.value === "vrl" &&
      typeof value === "string"
    ) {
      if (!record(nextValue)) nextValue = { type: "vrl" };
      nextValue.source = value;
    }
    onChange(nextValue);
  }
  let control;
  if (value === null && simpleNullable)
    control = (
      <div className="schema-explicit-null" aria-label={`${title}: null`}>
        <span>
          <code>null</code>
        </span>
      </div>
    );
  else if (value === null && nullable)
    control = (
      <p className="schema-null-note">
        Explicit <code>null</code> is configured.
      </p>
    );
  else if (
    conditionKinds &&
    selectedChoice &&
    nestedChoices &&
    selectedConditionType &&
    depth < 20
  )
    control = (
      <SchemaField
        inCollection={inCollection}
        name={name}
        schema={selectedConditionType.option.schema}
        root={root}
        value={value}
        onChange={onChange}
        editable={canEdit}
        required={required}
        label={title}
        nestedChoice
        unboxed={unboxed}
        exclude={[...exclude, "type"]}
        fieldPickerTarget={fieldPickerTarget || objectPickerTarget}
        fieldSections={fieldSections}
        depth={depth + 1}
      />
    );
  else if (
    conditionKinds &&
    selectedChoice &&
    nestedChoices &&
    record(value) &&
    depth < 20
  )
    control = (
      <JSONValueEditor
        label={title}
        value={value}
        editable={canEdit}
        onChange={onChange}
        schema={schema}
        root={root}
        path={path}
      />
    );
  else if (selectedChoice && nestedChoices && depth < 20)
    control = (
      <SchemaField
        inCollection={inCollection}
        name={name}
        schema={schemaToRender}
        root={root}
        value={value}
        onChange={onChange}
        editable={canEdit}
        required={required}
        label={title}
        nestedChoice
        unboxed={unboxed}
        exclude={[
          ...exclude,
          ...(tagged && choiceVisible
            ? [choices!.options[0].discriminator!.key]
            : []),
        ]}
        fieldPickerTarget={fieldPickerTarget || objectPickerTarget}
        fieldSections={fieldSections}
        depth={depth + 1}
      />
    );
  else if (mismatched)
    control = (
      <>
        <p className="schema-control-hint">
          The imported value has a different format. Its contents are preserved.
        </p>
        <JSONValueEditor
          label={title}
          value={value}
          editable={canEdit}
          onChange={onChange}
          schema={schema}
          root={root}
          path={path}
        />
      </>
    );
  else if (resolved.type === "object" && depth < 20) {
    const inner = (
      <>
        {resolved.properties ? (
          <ObjectFields
            schema={schemaToRender}
            root={root}
            value={record(value) ? value : {}}
            onChange={onChange}
            editable={canEdit}
            depth={depth + 1}
            fieldPickerTarget={fieldPickerTarget || objectPickerTarget}
            fieldSections={fieldSections}
            exclude={[
              ...exclude,
              ...(tagged ? [choices!.options[0].discriminator!.key] : []),
            ]}
          />
        ) : (
          <MapFields
            schema={resolved}
            root={root}
            value={record(value) ? value : {}}
            onChange={onChange}
            editable={canEdit}
            depth={depth + 1}
          />
        )}
      </>
    );
    control = unboxed ? (
      inner
    ) : (
      <div className="schema-object-children">{inner}</div>
    );
  } else if (resolved.type === "array" && depth < 20)
    control = (
      <div className="schema-list-field">
        <div className="schema-collection-label">
          <span>
            {Array.isArray(value) ? value.length : 0}{" "}
            {value?.length === 1 ? "item" : "items"}
          </span>
        </div>
        <ArrayFields
          schema={resolved}
          root={root}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          editable={canEdit}
          depth={depth}
        />
      </div>
    );
  else if (
    Object.hasOwn(resolved, "const") &&
    !Array.isArray(resolved.enum) &&
    (!choices || choices.options.length === 1)
  )
    control = (
      <div className="schema-fixed-value">
        <p className="schema-control-hint">
          This format requires <code>{JSON.stringify(resolved.const)}</code>.
          {value !== undefined && !same(value, resolved.const) && (
            <>
              {" "}
              Current value: <code>{JSON.stringify(value)}</code>.
            </>
          )}
        </p>
        {canEdit && !same(value, resolved.const) && (
          <Button
            variant="secondary compact"
            onClick={() => onChange(clone(resolved.const))}
          >
            Use required value
          </Button>
        )}
      </div>
    );
  else if (Array.isArray(resolved.enum))
    control = (
      <Field label={title}>
        <select
          disabled={!canEdit}
          aria-required={required || undefined}
          value={value === undefined ? "" : JSON.stringify(value)}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? undefined
                : JSON.parse(event.target.value),
            )
          }
        >
          <option value="">Choose {title.toLowerCase()}</option>
          {resolved.enum.map((option: any) => (
            <option key={JSON.stringify(option)} value={JSON.stringify(option)}>
              {option === null ? "Null" : String(option)}
            </option>
          ))}
          {value !== undefined &&
            !resolved.enum.some((option: any) => same(option, value)) && (
              <option value={JSON.stringify(value)}>
                {String(value)} (current value)
              </option>
            )}
        </select>
      </Field>
    );
  else if (resolved.type === "boolean")
    control = (
      <Field label={title}>
        <select
          disabled={!canEdit}
          aria-required={required || undefined}
          value={value === undefined ? "" : String(value)}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? undefined
                : event.target.value === "true",
            )
          }
        >
          <option value="">
            {model.hasDefault
              ? `Vector default: ${String(model.defaultValue)}`
              : "Not configured"}
          </option>
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
      </Field>
    );
  else if (
    ["string", "number", "integer"].includes(resolved.type) ||
    resolved.const !== undefined
  )
    control = (
      <ScalarValueEditor
        hideHeader
        path={path}
        name={name}
        schema={{ ...schemaToRender, type: resolved.type }}
        root={root}
        value={value}
        onChange={onChange}
        editable={canEdit}
        required={required}
        label={title}
      />
    );
  else if (unknownType || value === null)
    control =
      value === null ? (
        <p className="schema-null-note">
          Explicit <code>null</code> is configured.
        </p>
      ) : null;
  else
    control = (
      <JSONValueEditor
        label={title}
        value={value}
        editable={canEdit}
        onChange={onChange}
        schema={schema}
        root={root}
        path={path}
      />
    );
  function guardedAction(action: () => void) {
    if (staging || scope.fields.current.size) {
      setChoiceError(
        "Apply or discard pending field changes before removing or copying this value.",
      );
      return;
    }
    action();
  }
  const actions: FieldAction[] = (canEdit ? recordActions || [] : []).map(
    (action) => ({
      ...action,
      onSelect:
        action.danger || action.icon === Copy
          ? () => guardedAction(action.onSelect)
          : action.onSelect,
    }),
  );
  if (staging && canEdit)
    actions.push({
      label: `Cancel ${title} value edit`,
      icon: X,
      onSelect: cancelStagedChoice,
    });
  if (simpleNullable && canEdit)
    actions.push(
      value === null
        ? {
            label: `Enter ${title} value`,
            onSelect: () => choose(valueChoice!.id),
          }
        : {
            label: `Set ${title} to null`,
            onSelect: () => choose(nullChoice!.id),
          },
    );
  else if (nullable && !choiceVisible && canEdit)
    actions.push({
      label: value === null ? `Enter ${title} value` : `Set ${title} to null`,
      onSelect: () => {
        if (scope.fields.current.size) {
          setChoiceError(
            "Apply or discard pending field changes before changing formats.",
          );
          return;
        }
        setChoiceError("");
        if (value !== null) {
          cache.current.set("non-null", clone(value));
          onChange(null);
        } else
          onChange(
            cache.current.has("non-null")
              ? clone(cache.current.get("non-null"))
              : initialEditableFieldValue(schema, root),
          );
      },
    });
  if (rawAvailable)
    actions.push({
      label: `${canEdit ? "Edit" : "View"} ${title} as ${rawOpen ? "fields" : "JSON"}`,
      icon: Braces,
      onSelect: () => {
        if (!rawOpen && (staging || hasStructuredPending())) {
          setChoiceError(
            "Apply or discard pending field changes before editing this value as JSON.",
          );
          return;
        }
        setChoiceError("");
        setRawVisited(true);
        setRawOpen(!rawOpen);
      },
    });
  if (canEdit && onRemove)
    actions.push({
      label: `Remove ${title.toLowerCase()}`,
      icon: Trash2,
      danger: true,
      onSelect: () => guardedAction(onRemove),
    });
  return (
    <ConditionFormatContext.Provider
      value={inConditionFormat || !!conditionFormat}
    >
      <FieldPathContext.Provider value={path}>
        <FieldTrailContext.Provider
          value={ownsHeader ? [...trail, title] : trail}
        >
          <PendingFieldsContext.Provider value={scope.report}>
            <div
              className={`schema-field-control ${ownsHeader ? "schema-field-owned" : ""} ${structured ? "schema-field-section" : ""}`}
              data-field-name={name}
            >
              {ownsHeader && (
                <SchemaFieldHeader
                  title={title}
                  label={recordLabel}
                  leading={sectionIcon}
                  parentLabel={trail.at(-1)}
                  parentPath={trail.join(" / ")}
                  required={required && !inCollection}
                  requiredReason={requiredReason}
                  model={model}
                  helpSchemas={[schema, schemaToRender]}
                  helpRoot={root}
                  accessory={
                    <span
                      className="schema-field-picker-slot"
                      ref={setObjectPickerTarget}
                      hidden={rawOpen}
                    />
                  }
                  actions={actions}
                />
              )}
              {ownsHeader &&
                required &&
                requiredReason?.startsWith("Required when ") && (
                  <p className="schema-condition-note">{requiredReason}</p>
                )}
              {choiceError && (
                <p className="schema-control-error" role="status">
                  {choiceError}
                </p>
              )}
              {unknownType && (
                <Field label={`${title} value type`}>
                  <select
                    disabled={!canEdit}
                    value={actual === "undefined" ? "" : actual}
                    onChange={(event) => {
                      if (scope.fields.current.size) {
                        setChoiceError(
                          "Apply or discard pending field changes before changing formats.",
                        );
                        return;
                      }
                      cache.current.set(`type:${actual}`, clone(value));
                      const next = genericTypes.find(
                        (type) => type.type === event.target.value,
                      );
                      if (next)
                        onChange(
                          cache.current.has(`type:${next.type}`)
                            ? clone(cache.current.get(`type:${next.type}`))
                            : clone(next.value),
                        );
                    }}
                  >
                    <option value="">Choose a type</option>
                    {genericTypes.map((type) => (
                      <option key={type.type} value={type.type}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {conditionKinds ? (
                <div className="schema-variant schema-selector-owned">
                  <SchemaFieldHeader
                    title="Condition kind"
                    model={model}
                    helpSchemas={[schema, schemaToRender]}
                    helpRoot={root}
                  />
                  <Field label="Condition kind">
                    <select
                      value={conditionKind}
                      disabled={!canEdit}
                      aria-required={required || undefined}
                      onChange={(event) =>
                        chooseConditionKind(event.target.value)
                      }
                    >
                      <option value="">Choose a condition</option>
                      {conditionKind === "current" && (
                        <option value="current" disabled>
                          {record(value) && typeof value.type === "string"
                            ? `Unknown condition: ${value.type}`
                            : "Unknown condition"}
                        </option>
                      )}
                      {conditionKinds.map(({ id, label }) => (
                        <option value={id} key={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : (
                choiceVisible && (
                  <div
                    className={`schema-variant ${tagged || unboxed ? "schema-selector-owned" : ""}`}
                  >
                    {(tagged || unboxed) && (
                      <SchemaFieldHeader
                        title={variantLabel}
                        model={
                          tagged
                            ? fieldModel(
                                choices.options[0].discriminator!.key,
                                resolved.properties?.[
                                  choices.options[0].discriminator!.key
                                ] || {},
                                root,
                                value?.[choices.options[0].discriminator!.key],
                                { required: true },
                              )
                            : model
                        }
                        helpSchemas={[schema, schemaToRender]}
                        helpRoot={root}
                      />
                    )}
                    <Field label={variantLabel}>
                      <select
                        value={activeChoice || ""}
                        disabled={!canEdit}
                        aria-required={required || undefined}
                        onChange={(event) => choose(event.target.value)}
                      >
                        <option value="">
                          {conditionFormat
                            ? "Choose a condition format"
                            : "Choose a format"}
                        </option>
                        {choices.options.map((option) => (
                          <option value={option.id} key={option.id}>
                            {conditionFormat && option.label === "String"
                              ? "VRL expression"
                              : conditionFormat && option.label === "Map"
                                ? "Structured condition"
                                : option.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {choices.ambiguous &&
                      !forcedChoice &&
                      value !== undefined &&
                      value !== null &&
                      (typeof value === "object"
                        ? Object.keys(value).length > 0
                        : value !== "") && (
                        <p className="schema-control-hint">
                          More than one format matches this value. Choose the
                          intended format to edit its fields.
                        </p>
                      )}
                  </div>
                )
              )}
              <div className="schema-structured-value" hidden={rawOpen}>
                {control}
              </div>
              {rawAvailable && (
                <div className="schema-raw-value" id={rawId} hidden={!rawOpen}>
                  {rawVisited && (
                    <PendingFieldsContext.Provider value={reportRawPending}>
                      <JSONValueEditor
                        label={title}
                        value={value}
                        editable={canEdit}
                        onChange={(next) => {
                          if (staging || hasStructuredPending())
                            throw new Error(
                              "Apply or discard pending field changes before applying JSON.",
                            );
                          onChange(next);
                        }}
                        schema={schema}
                        root={root}
                        path={path}
                      />
                    </PendingFieldsContext.Provider>
                  )}
                </div>
              )}
            </div>
          </PendingFieldsContext.Provider>
        </FieldTrailContext.Provider>
      </FieldPathContext.Provider>
    </ConditionFormatContext.Provider>
  );
}

function ObjectFields({
  schema,
  root,
  value,
  onChange,
  editable,
  depth = 0,
  exclude = [],
  fieldPickerTarget,
  fieldSections,
}: {
  schema: Schema;
  root: Schema;
  value: Config;
  onChange: (v: Config) => void;
  editable: boolean;
  depth?: number;
  exclude?: string[];
  fieldPickerTarget?: HTMLElement | null;
  fieldSections?: readonly SchemaPropertySection[];
}) {
  const [search, setSearch] = useState(""),
    [enabled, setEnabled] = useState<string[]>([]),
    [focusKey, setFocusKey] = useState<string | null>(null),
    [pickerOpen, setPickerOpen] = useState(false),
    [changeError, setChangeError] = useState("");
  const rememberedFields = useRef(new Map<string, Schema>()),
    pendingProperties = useRef(new Map<string, Set<string>>()),
    reportParent = useContext(PendingFieldsContext);
  const reportProperty = useCallback(
    (name: string, id: string, pending: boolean) => {
      const ids = pendingProperties.current.get(name) || new Set<string>();
      if (pending) ids.add(id);
      else ids.delete(id);
      if (ids.size) pendingProperties.current.set(name, ids);
      else pendingProperties.current.delete(name);
      reportParent(id, pending);
    },
    [reportParent],
  );
  const pickerRef = useRef<HTMLDivElement>(null),
    pickerButton = useRef<HTMLButtonElement>(null),
    skipPickerReturnFocus = useRef(false),
    searchRef = useRef<HTMLInputElement>(null),
    pickerId = useId(),
    sectionId = useId();
  useEffect(() => {
    if (!pickerOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        !pickerRef.current?.contains(event.target as Node) &&
        !pickerButton.current?.contains(event.target as Node)
      ) {
        skipPickerReturnFocus.current = true;
        setPickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [pickerOpen]);
  const fieldRows = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (!focusKey) return;
    const row = fieldRows.current.get(focusKey);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    (
      row.querySelector<HTMLElement>(
        "input:not([disabled]),textarea:not([readonly]),select:not([disabled])",
      ) || row.querySelector<HTMLElement>("summary,button:not([disabled])")
    )?.focus({ preventScroll: true });
    setFocusKey(null);
  }, [focusKey, enabled, value]);
  const resolved = resolveSchema(schema, root, value),
    activeFields: Record<string, Schema> = resolved.properties || {},
    required: string[] = resolved.required || [];
  for (const [key, definition] of Object.entries(activeFields))
    rememberedFields.current.set(key, definition);
  function preservedField(key: string, current: any): Schema | undefined {
    const previous = rememberedFields.current.get(key);
    if (!rememberedFields.current.has(key) || current === undefined)
      return undefined;
    return {
      ...preservedFieldSchema(previous!, root, current),
      description:
        "The current selection does not define this field. Its value is preserved.",
    };
  }
  // Retain the same controls for configured fields when their condition changes.
  // Values stay visible and editable, but no longer carry inactive requirements.
  const fields: Record<string, Schema> = Object.fromEntries([
    ...Object.keys(value)
      .filter(
        (key) =>
          !Object.hasOwn(activeFields, key) &&
          rememberedFields.current.has(key),
      )
      .map((key) => [key, preservedField(key, value[key])!]),
    ...Object.entries(activeFields),
  ]);
  const fixed = new Set(
    Object.keys(fields).filter((key) => {
      const definition = resolveSchema(fields[key], root, value[key]);
      const options = schemaChoices(fields[key], root, value[key]);
      return (
        required.includes(key) &&
        (!options || options.options.length === 1) &&
        Object.hasOwn(value, key) &&
        Object.hasOwn(definition, "const") &&
        same(value[key], definition.const)
      );
    }),
  );
  const keys = Object.keys(fields).filter(
    (key) =>
      !exclude.includes(key) &&
      !fixed.has(key) &&
      !fields[key]._metadata?.["docs::hidden"],
  );
  const shown = keys
    .filter(
      (key) =>
        required.includes(key) ||
        Object.hasOwn(value, key) ||
        enabled.includes(key),
    )
    .sort(
      (a, b) => Number(required.includes(b)) - Number(required.includes(a)),
    );
  const activeShown = shown.filter(
    (key) => Object.hasOwn(activeFields, key) || required.includes(key),
  );
  const retainedShown = shown.filter(
    (key) => !Object.hasOwn(activeFields, key) && !required.includes(key),
  );
  const available = keys.filter(
    (key) =>
      !shown.includes(key) &&
      `${key} ${fieldTitle(key, fields[key])} ${fields[key].title || ""} ${fields[key].description || ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const additional = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !Object.hasOwn(fields, key) && !exclude.includes(key),
    ),
  );
  const allowsAdditional =
    resolved.additionalProperties !== false ||
    Object.keys(resolved.patternProperties || {}).length > 0;
  usePendingField(enabled.some((key) => value[key] === undefined));
  function canApply(result: Config, changedNames: string[]) {
    const nextResolved = resolveSchema(schema, root, result);
    for (const [key, ids] of pendingProperties.current) {
      if (changedNames.includes(key) || !ids.size) continue;
      const definition = Object.hasOwn(nextResolved.properties || {}, key)
        ? nextResolved.properties[key]
        : preservedField(key, result[key]) || itemSchema(nextResolved, key);
      const previous = Object.hasOwn(fields, key)
        ? fields[key]
        : itemSchema(resolved, key);
      const remainsVisible =
        Object.hasOwn(result, key) ||
        enabled.includes(key) ||
        nextResolved.required?.includes(key);
      if (!remainsVisible || !same(previous, definition)) {
        setChangeError(
          `Finish or discard the pending ${fieldTitle(key, fields[key] || {})} edit before changing ${changedNames.map((name) => fieldTitle(name, fields[name] || {})).join(", ") || "these fields"}.`,
        );
        return false;
      }
    }
    setChangeError("");
    return true;
  }
  function change(name: string, next: any, remove = false) {
    const result = setSchemaProperty(value, schema, root, name, next);
    if (next === undefined) delete result[name];
    if (!canApply(result, [name])) return;
    if (next === undefined)
      setEnabled((previous) =>
        remove
          ? previous.filter((key) => key !== name)
          : previous.includes(name)
            ? previous
            : [...previous, name],
      );
    onChange(result);
  }
  const requirements = [
    ...new Set(
      keys.flatMap((key) => {
        const item = fields[key]._metadata || {};
        return item["docs::required_one_of"]?.length &&
          !item["docs::required_one_of"].some(
            (name: string) =>
              Object.hasOwn(value, name) &&
              value[name] !== undefined &&
              value[name] !== null,
          )
          ? [
              `Set one of: ${item["docs::required_one_of"].map((name: string) => fieldTitle(name, fields[name] || {})).join(", ")}.`,
            ]
          : [];
      }),
    ),
  ];
  const picker = editable && keys.some((key) => !shown.includes(key)) && (
    <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
      <div className="schema-field-picker">
        <Popover.Trigger asChild>
          <button
            type="button"
            className="schema-field-picker-trigger"
            ref={pickerButton}
            aria-expanded={pickerOpen}
            aria-controls={pickerId}
          >
            <ListPlus size={15} aria-hidden="true" /> Add field{" "}
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="schema-field-picker-panel"
            id={pickerId}
            ref={pickerRef}
            aria-label="Add a field"
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              if (skipPickerReturnFocus.current) {
                event.preventDefault();
                skipPickerReturnFocus.current = false;
              }
            }}
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            <div className="schema-field-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                aria-label={
                  depth ? "Find nested optional fields" : "Find optional fields"
                }
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search fields"
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    pickerRef.current
                      ?.querySelector<HTMLButtonElement>(
                        ".schema-field-picker-results button",
                      )
                      ?.focus();
                  }
                }}
              />
              {search && (
                <IconButton
                  icon={X}
                  label="Clear field search"
                  onClick={() => setSearch("")}
                />
              )}
            </div>
            <div
              className="schema-field-picker-results"
              onKeyDown={(event) => {
                if (
                  !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                )
                  return;
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button",
                  ),
                );
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                if (index < 0) return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : index + (event.key === "ArrowDown" ? 1 : -1);
                if (next < 0) searchRef.current?.focus();
                else buttons[Math.min(next, buttons.length - 1)]?.focus();
              }}
            >
              {available.length ? (
                available.map((key) => {
                  const intent = fieldModel(key, fields[key], root, undefined)
                    .intent.kind;
                  const Icon = (
                    {
                      uri: Link2,
                      path: Folder,
                      vrl: FileCode2,
                      regex: Regex,
                      template: Braces,
                      duration: Timer,
                      bytes: HardDrive,
                      secret: KeyRound,
                    } as Record<string, typeof Link2>
                  )[intent];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        const initial = initialEditableFieldValue(
                          fields[key],
                          root,
                        );
                        if (initial === undefined)
                          setEnabled((previous) => [...previous, key]);
                        else change(key, initial);
                        setSearch("");
                        skipPickerReturnFocus.current = true;
                        setPickerOpen(false);
                        setFocusKey(key);
                      }}
                    >
                      {Icon && <Icon size={15} aria-hidden="true" />}
                      <span className="schema-option-copy">
                        <strong>{fieldTitle(key, fields[key])}</strong>
                        <small>
                          {schemaDescription(
                            fields[key].title || fields[key].description || key,
                          )}
                        </small>
                      </span>
                    </button>
                  );
                })
              ) : (
                <p>No matching fields.</p>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </div>
    </Popover.Root>
  );
  const renderProperty = (key: string, sectionIcon?: ReactNode) => (
    <div
      className="pipeline-schema-field"
      key={key}
      ref={(node) => {
        if (node) fieldRows.current.set(key, node);
        else fieldRows.current.delete(key);
      }}
    >
      <PropertyPendingScope name={key} report={reportProperty}>
        <SchemaField
          name={key}
          label={fields[key]._metadata?.["vectory::label"]}
          schema={
            resolved.properties?.strategy &&
            (key === "user" || (key === "value" && value.strategy === "custom"))
              ? {
                  ...fields[key],
                  _metadata: { ...fields[key]._metadata, sensitive: true },
                }
              : fields[key]
          }
          root={root}
          value={value[key]}
          onChange={(next) => change(key, next)}
          editable={editable}
          depth={depth}
          sectionIcon={sectionIcon}
          required={required.includes(key)}
          requiredReason={
            [
              ...(resolved["x-vectory-required-reasons"]?.[key] || []),
              ...(fields[key]._metadata?.["docs::required_when"]
                ? [
                    `Required when ${fields[key]._metadata["docs::required_when"]}.`,
                  ]
                : []),
            ].join(" ") || undefined
          }
          onRemove={
            required.includes(key)
              ? undefined
              : () => change(key, undefined, true)
          }
        />
      </PropertyPendingScope>
    </div>
  );
  const additionalFields = (Object.keys(additional).length > 0 ||
    (allowsAdditional && !Object.keys(fields).length)) && (
    <section className="schema-additional">
      <h4>{Object.keys(fields).length ? "Additional fields" : "Entries"}</h4>
      {!allowsAdditional && (
        <p className="schema-control-hint">
          These imported fields are preserved. This format may require removing
          them before native validation succeeds.
        </p>
      )}
      <MapFields
        schema={resolved}
        root={root}
        value={additional}
        onEntryPendingChange={reportProperty}
        onChange={(next) => {
          const result = { ...value };
          for (const key of Object.keys(additional)) delete result[key];
          const updated = { ...result, ...next };
          const changedNames = [
            ...new Set([...Object.keys(additional), ...Object.keys(next)]),
          ].filter((key) => !same(additional[key], next[key]));
          if (canApply(updated, changedNames)) onChange(updated);
        }}
        editable={editable}
        depth={depth}
      />
    </section>
  );
  const sections: readonly SchemaPropertySection[] = fieldSections?.length
    ? [
        ...fieldSections,
        ...(fieldSections.some((section) => !section.fields)
          ? []
          : [{ id: "settings", title: "Settings" }]),
      ]
    : [];
  const fallbackSection = sections.find((section) => !section.fields);
  const sectionFor = (key: string) =>
    sections.find((section) => section.fields?.includes(key)) ||
    fallbackSection;
  return (
    <div className="pipeline-schema-fields schema-fields">
      {fieldPickerTarget ? createPortal(picker, fieldPickerTarget) : picker}
      {changeError && (
        <p className="schema-control-error" role="status">
          {changeError}
        </p>
      )}
      {requirements.length > 0 && (
        <div className="schema-requirements">
          {requirements.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
      {sections.length ? (
        <div className="schema-property-sections">
          {sections.map((section) => {
            const sectionKeys = activeShown.filter(
              (key) => sectionFor(key) === section,
            );
            const hasAdditional =
              section === fallbackSection && additionalFields;
            if (!sectionKeys.length && !hasAdditional) return null;
            const singleKey = sectionKeys[0];
            const mergedHeading =
              sectionKeys.length === 1 &&
              !hasAdditional &&
              (
                fields[singleKey]._metadata?.["vectory::label"] ||
                fieldTitle(singleKey, fields[singleKey])
              ).toLocaleLowerCase() === section.title.toLocaleLowerCase();
            return (
              <section
                key={section.id}
                className={`schema-property-section ${mergedHeading ? "schema-property-section-merged" : ""}`}
                data-property-section={section.id}
                aria-label={mergedHeading ? section.title : undefined}
                aria-labelledby={
                  mergedHeading ? undefined : `${sectionId}-${section.id}`
                }
              >
                {!mergedHeading && (
                  <h3
                    className="schema-property-section-heading"
                    id={`${sectionId}-${section.id}`}
                  >
                    {section.icon && (
                      <span
                        className="schema-property-section-icon"
                        aria-hidden="true"
                      >
                        {section.icon}
                      </span>
                    )}
                    <span>{section.title}</span>
                  </h3>
                )}
                <div className="schema-property-section-content">
                  {sectionKeys.map((key) =>
                    renderProperty(
                      key,
                      mergedHeading ? section.icon : undefined,
                    ),
                  )}
                  {hasAdditional || null}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <>
          {activeShown.map((key) => renderProperty(key))}
          {additionalFields}
        </>
      )}
      {retainedShown.length > 0 && (
        <section
          className="schema-retained-fields"
          aria-labelledby={`${sectionId}-retained`}
        >
          <h4 id={`${sectionId}-retained`}>Kept from another selection</h4>
          {retainedShown.map((key) => renderProperty(key))}
        </section>
      )}
      {!editable &&
        !shown.length &&
        !Object.keys(additional).length &&
        Object.keys(fields).length > 0 && (
          <p className="schema-empty-note">Uses Vector defaults.</p>
        )}
    </div>
  );
}
export function SecretReferenceControl({
  title,
  value,
  editable,
  onChange,
  onPendingChange = ignorePending,
}: {
  title: string;
  value: any;
  editable: boolean;
  onChange: (v: any) => void;
  onPendingChange?: (id: string, dirty: boolean) => void;
}) {
  return (
    <PendingFieldsContext.Provider value={onPendingChange}>
      <ScalarValueEditor
        name="secret"
        schema={{
          type: "string",
          _metadata: { sensitive: true, "docs::human_name": title },
        }}
        root={{}}
        value={value}
        onChange={onChange}
        editable={editable}
      />
    </PendingFieldsContext.Provider>
  );
}
export function PipelineSchemaControl({
  name,
  schema,
  root,
  value,
  onChange,
  editable,
  required = false,
  label,
  onPendingChange = ignorePending,
}: {
  name: string;
  schema: Schema;
  root: Schema;
  value: any;
  onChange: (v: any) => void;
  editable: boolean;
  required?: boolean;
  label?: string;
  onPendingChange?: (id: string, dirty: boolean) => void;
}) {
  return (
    <PendingFieldsContext.Provider value={onPendingChange}>
      <SchemaField
        name={name}
        schema={schema}
        root={root}
        value={value}
        onChange={onChange}
        editable={editable}
        required={required}
        label={label}
        depth={0}
      />
    </PendingFieldsContext.Provider>
  );
}
export function hasRootSchemaVariants(
  schema: Schema,
  root: Schema,
  value: any,
) {
  // Required-one-of groups constrain fields within one shape; they are not modes.
  return (
    !!schemaChoices(schema, root, value) &&
    resolveSchema(schema, root, value)._required_one_of_constraint !== true
  );
}

export default function PipelineSchemaFields({
  schema,
  root,
  component,
  onChange,
  editable,
  exclude = [],
  fieldPickerTarget,
  fieldSections,
  onPendingChange = ignorePending,
}: {
  schema: Schema;
  root: Schema;
  component: Config;
  onChange: (v: Config) => void;
  editable: boolean;
  exclude?: string[];
  fieldPickerTarget?: HTMLElement | null;
  fieldSections?: readonly SchemaPropertySection[];
  onPendingChange?: (id: string, dirty: boolean) => void;
}) {
  return (
    <PendingFieldsContext.Provider value={onPendingChange}>
      {hasRootSchemaVariants(schema, root, component) ? (
        <SchemaField
          name="component"
          schema={schema}
          root={root}
          value={component}
          onChange={onChange}
          editable={editable}
          fieldPickerTarget={fieldPickerTarget}
          fieldSections={fieldSections}
          exclude={["type", "inputs", ...exclude]}
          unboxed
          depth={0}
        />
      ) : (
        <ObjectFields
          schema={schema}
          root={root}
          value={component}
          onChange={onChange}
          editable={editable}
          fieldPickerTarget={fieldPickerTarget}
          fieldSections={fieldSections}
          exclude={["type", "inputs", ...exclude]}
        />
      )}
    </PendingFieldsContext.Provider>
  );
}
