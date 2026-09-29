import {
  Braces,
  CircleHelp,
  Network,
  Percent,
  Send,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { useState, useEffect, useId } from "react";
import type { Config } from "./api";
import { catalog, componentSchema, vectorSchema, type Kind } from "./catalog";
import { Button, Field } from "./ui";
import SyntheticTester from "./SyntheticTester";
import DocLink from "./DocLink";
import PipelineSchemaFields, {
  PipelineSchemaControl,
  hasRootSchemaVariants,
  type SchemaPropertySection,
} from "./PipelineSchemaFields";
import { resolveSchema, type Schema } from "./pipelineSchema";
import { SchemaFieldHelp } from "./SchemaFieldChrome";
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

export default function PipelineSettings({
  id,
  kind,
  component,
  editable,
  issues,
  fieldPickerTarget,
  onChange,
  onPendingChange,
  onRouteRename,
  onRouteRemove,
}: {
  id: string;
  kind: Kind;
  component: Config;
  editable: boolean;
  issues: string[];
  fieldPickerTarget?: HTMLElement | null;
  onChange: (value: Config) => void;
  onPendingChange: (id: string, dirty: boolean) => void;
  onRouteRename: (before: string, after: string) => void;
  onRouteRemove: (name: string) => void;
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
  return (
    <div className="pipeline-settings">
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
              Before deploying, the device owner must enable full Vector mode
              locally. The device’s Vector build must also include this
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
                Each condition creates an output that destinations can select.
                Events matching no condition use <code>_unmatched</code>.
              </p>
            </SchemaFieldHelp>
          </div>
          {Object.entries(component.route || {}).map(([name, condition]) => (
            <div className="pipeline-route" key={name}>
              <OutputName
                name={name}
                names={Object.keys(component.route || {})}
                editable={editable}
                onRename={onRouteRename}
                onPendingChange={reportPending}
              />
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
              {editable && (
                <Button
                  variant="ghost compact"
                  onClick={() => onRouteRemove(name)}
                >
                  Remove output
                </Button>
              )}
            </div>
          ))}
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
      {editable && component.type === "remap" && (
        <details className="pipeline-disclosure">
          <summary>Test with a sample event</summary>
          <SyntheticTester program={component.source || ""} />
        </details>
      )}
    </div>
  );
}
