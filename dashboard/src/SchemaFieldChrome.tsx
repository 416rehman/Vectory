import { useRef, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Info, Ellipsis, X, type LucideIcon } from "lucide-react";
import DocLink from "./DocLink";
import useHoverDisclosure from "./useHoverDisclosure";
import {
  schemaDescription,
  type FieldModel,
  type Schema,
} from "./pipelineSchema";

export type FieldAction = {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
};

const constraintLabels: Record<string, string> = {
  minimum: "Minimum",
  maximum: "Maximum",
  exclusiveMinimum: "Greater than",
  exclusiveMaximum: "Less than",
  multipleOf: "Multiple of",
  minLength: "Minimum characters",
  maxLength: "Maximum characters",
  pattern: "Pattern",
  format: "Format",
  minItems: "Minimum items",
  maxItems: "Maximum items",
  uniqueItems: "Unique items",
  minProperties: "Minimum entries",
  maxProperties: "Maximum entries",
};
export function fieldHelpConstraints(model: FieldModel) {
  return Object.entries(constraintLabels).flatMap(([key, label]) =>
    Object.hasOwn(model.constraints, key)
      ? [{ label, value: String(model.constraints[key]) }]
      : [],
  );
}
const formatValue = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** Keep shared/ref annotations alongside selected-branch help, without listing inactive branches. */
export function schemaHelpDescriptions(
  schemas: Schema[],
  root: Schema,
): string[] {
  const descriptions = new Set<string>(),
    seen = new Set<Schema>();
  function visit(schema: Schema | undefined, depth = 0) {
    if (!schema || typeof schema !== "object" || seen.has(schema) || depth > 30)
      return;
    seen.add(schema);
    if (typeof schema.description === "string") {
      const text = schemaDescription(schema.description);
      if (text && !/^Config used to build\b/i.test(text))
        descriptions.add(text);
    }
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
      let target: any = root;
      for (const part of schema.$ref.slice(2).split("/"))
        target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      visit(target, depth + 1);
    }
    if (Array.isArray(schema.allOf))
      schema.allOf.forEach((part: Schema) => visit(part, depth + 1));
  }
  schemas.forEach((schema) => visit(schema));
  return [...descriptions];
}

export function SchemaFieldHelpContent({
  model,
  descriptions = [],
}: {
  model: FieldModel;
  descriptions?: string[];
}) {
  const prose = [
    ...new Set(
      [...descriptions, model.description].filter(
        (text): text is string =>
          !!text && !/^Config used to build\b/i.test(text),
      ),
    ),
  ];
  const constraints = fieldHelpConstraints(model);
  return (
    <>
      {prose.map((description) => (
        <p key={description}>{description}</p>
      ))}
      <p>
        {model.required ? "Required field." : "Optional field."}
        {model.nullable ? " Accepts an explicit null value." : ""}
        {model.readOnly ? " Read only." : ""}
        {!model.present
          ? " Not configured; Vector applies its default when available."
          : ""}
      </p>
      {model.sensitive ? (
        <p>
          Credentials stay on each device. Name a device secret, saved as{" "}
          <code>vectory-secret:NAME</code>, or in full mode use a Vector
          reference such as <code>SECRET[backend.key]</code>. Plain-text
          credentials are never saved.{" "}
          <DocLink topic="resources" section="keep-credentials-on-the-device">
            Device secrets
          </DocLink>
        </p>
      ) : (
        <>
          {model.hasDefault && (
            <div>
              <strong>Vector default</strong>
              <pre>{formatValue(model.defaultValue)}</pre>
              {model.defaultNote && <p>{model.defaultNote}</p>}
            </div>
          )}
          {model.examples.length > 0 && (
            <div>
              <strong>Examples</strong>
              {model.examples.map((example, index) => (
                <pre key={index}>{formatValue(example)}</pre>
              ))}
            </div>
          )}
        </>
      )}
      {model.intent.unit && <p>Unit: {model.intent.unit}.</p>}
      {constraints.length > 0 && (
        <dl>
          {constraints.map(({ label, value }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {model.intent.kind === "vrl" && (
        <p>
          <DocLink topic="pipelines" section="vrl">
            VRL
          </DocLink>{" "}
          runs on the device. Use sample tests to check the result.
        </p>
      )}
      {model.intent.kind === "template" && (
        <p>
          <DocLink topic="pipelines" section="event-templates">
            Event templates
          </DocLink>{" "}
          use <code>{"{{ field }}"}</code> for event values and supported time
          directives for timestamps.
        </p>
      )}
      {model.intent.kind === "regex" && (
        <p>
          Native Vector validation checks supported regular expression syntax.
        </p>
      )}
      {model.intent.kind === "path" && (
        <p>This path is on the device running Vector.</p>
      )}
      {model.deprecated && (
        <p>Deprecated in this Vector version. Existing values are preserved.</p>
      )}
    </>
  );
}

/** Hover and keyboard focus reveal help; pointer clicks never pin it open. */
export function SchemaFieldHelp({
  title,
  children,
  triggerContent,
  className = "",
}: {
  title: string;
  children: ReactNode;
  triggerContent?: ReactNode;
  className?: string;
}) {
  const help = useHoverDisclosure();
  return (
    <Popover.Root open={help.open} onOpenChange={help.onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`schema-help-trigger ${className}`.trim()}
          ref={help.triggerRef}
          aria-label={`Help for ${title}`}
          aria-expanded={help.open}
          aria-haspopup="dialog"
          {...help.triggerProps}
        >
          {triggerContent ?? <Info size={13} aria-hidden="true" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={help.contentRef}
          className="schema-help-popover"
          aria-label={`Help for ${title}`}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          tabIndex={-1}
          {...help.contentProps}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={help.onEscapeKeyDown}
        >
          <div className="schema-help-heading">
            <strong>{title}</strong>
            <button
              type="button"
              aria-label={`Close help for ${title}`}
              onClick={() => help.close(true)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function SchemaFieldHeader({
  title,
  label,
  leading,
  parentLabel,
  parentPath,
  required,
  requiredReason,
  model,
  actions = [],
  accessory,
  helpSchemas,
  helpRoot = {},
}: {
  title: string;
  label?: ReactNode;
  leading?: ReactNode;
  parentLabel?: string;
  parentPath?: string;
  required?: boolean;
  requiredReason?: string;
  model: FieldModel;
  actions?: FieldAction[];
  accessory?: ReactNode;
  helpSchemas?: Schema[];
  helpRoot?: Schema;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnFocusScope = useRef<HTMLElement | null>(null);
  function select(action: FieldAction) {
    const field = trigger.current?.closest(".schema-field-control");
    const scope = trigger.current?.closest(
      ".schema-fields,.schema-array,.schema-map,.pipeline-settings",
    );
    returnFocusScope.current =
      field?.parentElement?.closest<HTMLElement>(".schema-field-owned") ||
      trigger.current?.closest<HTMLElement>(".editor-inspector") ||
      (scope as HTMLElement | null);
    if (field && scope) {
      const controls = Array.from(
        scope.querySelectorAll<HTMLElement>(
          "input:not([disabled]),select:not([disabled]),textarea:not([readonly]),button.schema-field-picker-trigger",
        ),
      );
      returnFocus.current =
        controls.find(
          (node) =>
            !field.contains(node) &&
            !!(
              field.compareDocumentPosition(node) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ) ||
        controls.find((node) => !field.contains(node)) ||
        trigger.current
          ?.closest(".editor-inspector")
          ?.querySelector<HTMLElement>(
            ".editor-inspector-properties-toolbar button.schema-field-picker-trigger",
          ) ||
        null;
    }
    action.onSelect();
  }
  return (
    <div className="schema-record-header">
      {leading && (
        <span className="schema-property-section-icon" aria-hidden="true">
          {leading}
        </span>
      )}
      <span className="schema-record-label">
        <strong>{label ?? title}</strong>
        {required && (
          <span
            className="schema-required"
            title={requiredReason || "Required"}
            aria-label={requiredReason || "Required"}
          >
            *
          </span>
        )}
        <SchemaFieldHelp title={title}>
          {requiredReason && <p>{requiredReason}</p>}
          <SchemaFieldHelpContent
            model={model}
            descriptions={
              helpSchemas
                ? schemaHelpDescriptions(helpSchemas, helpRoot)
                : undefined
            }
          />
        </SchemaFieldHelp>
        {parentLabel && (
          <small className="schema-parent-label" title={parentPath}>
            in {parentLabel}
          </small>
        )}
      </span>
      {accessory}
      {actions.length > 0 && (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              ref={trigger}
              className="schema-actions-trigger"
              aria-label={`Actions for ${title}`}
            >
              <Ellipsis size={16} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="schema-actions-menu"
              align="end"
              sideOffset={5}
              collisionPadding={12}
              loop
              aria-label={`Actions for ${title}`}
              onEscapeKeyDown={(event) => event.stopPropagation()}
              onCloseAutoFocus={(event) => {
                if (!trigger.current?.isConnected) {
                  event.preventDefault();
                  requestAnimationFrame(() => {
                    const destination = returnFocus.current?.isConnected
                      ? returnFocus.current
                      : returnFocusScope.current?.querySelector<HTMLElement>(
                          "button.schema-field-picker-trigger",
                        );
                    destination?.focus();
                  });
                }
              }}
            >
              {actions.map((action) => {
                const Icon = action.icon;
                return (
                  <DropdownMenu.Item
                    key={action.label}
                    className="schema-menu-action"
                    disabled={action.disabled}
                    data-danger={action.danger || undefined}
                    onSelect={() => select(action)}
                  >
                    {Icon && <Icon size={15} aria-hidden="true" />}
                    <span>{action.label}</span>
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}
