import { parseDocument } from "yaml";
import { parse as parseToml } from "smol-toml";
import type { Config } from "./api";
import {
  catalog,
  componentSchema,
  pipelineIssues,
  vectorSchema,
  type Kind,
} from "./catalog";
import { assertExactNumbers } from "./configurationNumbers";
import { stringifyConfiguration } from "./configurationFormats";
import {
  arrayItemSchema,
  mapValueSchema,
  resolveSchema,
  schemaChoices,
  validateFieldValue,
  type Schema,
} from "./pipelineSchema";

export type ConfigurationFormat = "json" | "yaml" | "toml";
export const MAX_CONFIGURATION_BYTES = 1_048_576;
export type ConfigurationDiagnostic = {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
  /** `deferred`: a native reference or pattern a device resolves. */
  code?: string;
  componentId?: string;
  enrichmentTableId?: string;
};
export type ConfigurationSourceDiagnosis = {
  config?: Config;
  diagnostics: ConfigurationDiagnostic[];
  locallyValid: boolean;
  runtimeValidationRequired: true;
};
export class ConfigurationSourceError extends Error {
  constructor(public diagnostics: ConfigurationDiagnostic[]) {
    super(diagnostics.map((entry) => entry.message).join("\n"));
    this.name = "ConfigurationSourceError";
  }
}
const sections = [
  "sources",
  "transforms",
  "sinks",
  "enrichment_tables",
] as const;
const own = (value: object, key: string) => Object.hasOwn(value, key);
const record = (value: unknown): value is Config =>
  !!value && typeof value === "object" && !Array.isArray(value);
function range(text: string, from = 0, to = from + 1) {
  from = Math.max(0, Math.min(text.length, from));
  return { from, to: Math.max(from, Math.min(text.length, to)) };
}
function location(text: string, name?: string) {
  if (!name) return range(text);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|[\\s{,.])(?:["']?)(${escaped})(?:["']?)(?=\\s*[:=\\]\\.])`,
    "m",
  ).exec(text);
  const from = match ? match.index + match[0].lastIndexOf(name) : 0;
  return range(text, from, from + (match ? name.length : 1));
}
/** Where a component (or option) name is written in configuration text. */
export function sourceOffset(text: string, name?: string) {
  return location(text, name).from;
}
function failure(text: string, message: string, field?: string): never {
  throw new ConfigurationSourceError([
    { ...location(text, field), severity: "error", message },
  ]);
}
function syntaxDiagnostic(
  text: string,
  error: unknown,
): ConfigurationDiagnostic {
  const value = error as {
    message?: string;
    pos?: [number, number];
    line?: number;
    column?: number;
  };
  const message =
    value?.message?.split("\n")[0] || "The configuration could not be parsed.";
  let from = value?.pos?.[0],
    to = value?.pos?.[1];
  if (from === undefined && typeof value.line === "number") {
    const lines = text.split("\n");
    from =
      lines
        .slice(0, Math.max(0, value.line - 1))
        .reduce((sum, line) => sum + line.length + 1, 0) +
      Math.max(0, (value.column || 1) - 1);
  }
  if (from === undefined) {
    const position = /position (\d+)/i.exec(message);
    if (position) from = Number(position[1]);
    else if (/unexpected end/i.test(message)) from = text.length;
  }
  return { ...range(text, from, to), severity: "error", message };
}

export function detectConfigurationFormat(
  fileName: string,
): ConfigurationFormat {
  const extension = /\.([^./\\]+)$/.exec(fileName)?.[1].toLowerCase();
  if (extension === "json" || extension === "toml") return extension;
  if (extension === "yaml" || extension === "yml") return "yaml";
  throw new Error("Choose a .yaml, .yml, .json or .toml configuration file.");
}

/** The format of pasted text: JSON objects, TOML tables and keys, else YAML. */
export function guessConfigurationFormat(text: string): ConfigurationFormat {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return "json";
  const tomlLike =
    /^\s*\[{1,2}[A-Za-z0-9_."-]+\]{1,2}\s*$/m.test(text) ||
    /^\s*[A-Za-z0-9_."-]+\s*=/m.test(text);
  const yamlLike = /^\s*[A-Za-z0-9_"'-]+:(\s|$)/m.test(text);
  return tomlLike && !yamlLike ? "toml" : "yaml";
}

/** "Line 4:3: message" for the first problem, so a parse error is findable. */
export function sourceErrorMessage(text: string, error: unknown) {
  const first =
    error instanceof ConfigurationSourceError ? error.diagnostics[0] : null;
  const message = first?.message || (error as Error)?.message || "";
  if (!message) return "This configuration could not be read.";
  if (!first || (first.from === 0 && !text.trim())) return message;
  const before = text.slice(0, first.from).split("\n");
  const line = before.length,
    column = before.at(-1)!.length + 1;
  return /^Line \d+/i.test(message)
    ? message
    : `Line ${line}:${column}: ${message.replace(/ at line \d+, column \d+:?$/, "")}`;
}

/** Parse without coercing non-JSON values, dropping unknown keys, or rounding integers. */
export function parseSource(
  text: string,
  format: ConfigurationFormat | string,
): Config {
  if (new TextEncoder().encode(text).length > MAX_CONFIGURATION_BYTES)
    failure(text, "The configuration exceeds the 1 MiB file limit.");
  if (!["json", "yaml", "toml"].includes(format))
    failure(text, "Unsupported configuration format.");
  let parsed: unknown;
  try {
    if (format === "toml") {
      parsed = parseToml(text, {
        integersAsBigInt: "asNeeded",
        maxDepth: 100,
        unsafeKeyBehaviour: "keep",
      });
    } else {
      // JSON.parse enforces JSON syntax; the YAML JSON AST then supplies duplicate
      // key detection and exact integer values before conversion into JS numbers.
      if (format === "json") {
        try {
          JSON.parse(text);
        } catch (error) {
          const diagnostic = syntaxDiagnostic(text, error);
          // Some V8 JSON errors include only a source excerpt, with no offset.
          // The parser's flow-syntax AST still provides a useful exact range.
          const positioned = parseDocument(text, {
            schema: "json",
            prettyErrors: false,
            logLevel: "silent",
          }).errors[0];
          if (diagnostic.from === 0 && positioned?.pos)
            Object.assign(diagnostic, range(text, ...positioned.pos));
          throw new ConfigurationSourceError([diagnostic]);
        }
      }
      const document = parseDocument(text, {
        schema: format === "json" ? "json" : "core",
        version: "1.2",
        intAsBigInt: true,
        uniqueKeys: true,
        strict: true,
        prettyErrors: false,
        resolveKnownTags: false,
        // Vector accepts YAML merge keys. Resolve them before building the
        // graph so `<<` never becomes an invented component option.
        merge: format === "yaml",
        logLevel: "silent",
      });
      const problems = [...document.errors, ...document.warnings];
      if (problems.length)
        throw new ConfigurationSourceError(
          problems.map((error) => syntaxDiagnostic(text, error)),
        );
      parsed = document.toJS({ mapAsMap: true, maxAliasCount: 50 });
    }
  } catch (error) {
    if (error instanceof ConfigurationSourceError) throw error;
    throw new ConfigurationSourceError([syntaxDiagnostic(text, error)]);
  }
  const active = new Set<object>();
  let visited = 0;
  function jsonValue(value: unknown, path: string, depth: number): any {
    if (++visited > 200_000 || depth > 100)
      failure(
        text,
        "The configuration is too deeply nested or expands to too many values.",
      );
    if (typeof value === "bigint") {
      if (
        value > BigInt(Number.MAX_SAFE_INTEGER) ||
        value < BigInt(Number.MIN_SAFE_INTEGER)
      )
        failure(
          text,
          `${path}: this integer cannot be represented exactly by the editor. Use an integer between -9007199254740991 and 9007199254740991.`,
          path.split(".").at(-1),
        );
      return Number(value);
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number") {
      try {
        assertExactNumbers(value, path);
      } catch (error) {
        failure(text, (error as Error).message, path.split(".").at(-1));
      }
      return value;
    }
    if (!value || typeof value !== "object")
      failure(text, `${path}: only JSON-compatible values can be edited.`);
    if (active.has(value))
      failure(text, `${path}: recursive YAML aliases are not supported.`);
    if (
      !(value instanceof Map) &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      failure(
        text,
        `${path}: dates, binary values and other non-JSON types are not supported. Quote the value to preserve it as text.`,
      );
    active.add(value);
    let result: any;
    if (Array.isArray(value))
      result = value.map((entry, index) =>
        jsonValue(entry, `${path}[${index}]`, depth + 1),
      );
    else {
      result = {};
      for (const [key, entry] of value instanceof Map
        ? value.entries()
        : Object.entries(value)) {
        if (typeof key !== "string")
          failure(
            text,
            `${path}: object keys must be strings; quote numeric keys.`,
          );
        Object.defineProperty(result, key, {
          value: jsonValue(entry, `${path}.${key}`, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    active.delete(value);
    return result;
  }
  const config = jsonValue(parsed, "configuration", 0);
  if (!record(config)) failure(text, "The configuration must be an object.");
  for (const section of sections) {
    if (!own(config, section)) continue;
    if (!record(config[section]))
      failure(
        text,
        `${section}: the component section must be an object.`,
        section,
      );
    for (const [id, component] of Object.entries(config[section]))
      if (!record(component))
        failure(
          text,
          `${section}.${id}: each component must be an object.`,
          id,
        );
  }
  return config;
}

const nativeReference = (value: unknown) =>
  typeof value === "string" &&
  /\$(?:\{|[A-Za-z_])|SECRET\[[^.\[\]\s]+\.[^\[\]\s]+\]|^vectory-secret:/.test(
    value,
  );

/** Validate documented scalar/container constraints without rejecting opaque fields
 * or pretending that native interpolation, paths, VRL and glob resolution ran. */
function localSchemaIssues(
  value: any,
  schema: Schema,
  path: string,
  depth = 0,
  includeRequired = true,
): string[] {
  if (depth > 24 || nativeReference(value)) return [];
  if (value === null || typeof value !== "object")
    return validateFieldValue(value, schema, vectorSchema, path);
  const resolved = resolveSchema(schema, vectorSchema, value);
  const structural = { ...resolved };
  for (const key of [
    "properties",
    "additionalProperties",
    "patternProperties",
    "items",
    "prefixItems",
    "allOf",
    "oneOf",
    "anyOf",
    "if",
    "then",
    "else",
    "not",
    "contains",
  ])
    delete structural[key];
  // Component requirements are already reported by pipelineIssues with the
  // short node label. Keep scalar/container checks here without repeating the
  // same missing field under its fully qualified schema path.
  if (!includeRequired) delete structural.required;
  const issues = validateFieldValue(value, structural, vectorSchema, path);
  const choices = schemaChoices(schema, vectorSchema, value);
  if (choices?.options.every((option) => !!option.discriminator)) {
    const keys = new Set(
      choices.options.map((option) => option.discriminator!.key),
    );
    if (keys.size === 1) {
      const key = [...keys][0];
      if (
        own(value, key) &&
        !nativeReference(value[key]) &&
        !choices.options.some(
          (option) => value[key] === option.discriminator!.value,
        )
      )
        issues.push(`${path}.${key}: choose an allowed configuration variant.`);
    }
  }
  if (Array.isArray(value))
    value.forEach((entry, index) => {
      const child = arrayItemSchema(resolved, index);
      if (child === false)
        issues.push(`${path}[${index}]: this item is not allowed.`);
      else if (child && typeof child === "object")
        issues.push(
          ...localSchemaIssues(
            entry,
            child,
            `${path}[${index}]`,
            depth + 1,
            includeRequired,
          ),
        );
    });
  else
    for (const [key, entry] of Object.entries(value)) {
      const child = mapValueSchema(resolved, key);
      // Unknown fields remain lossless for custom/version-specific Vector builds.
      if (child.not && Object.keys(child.not).length === 0) continue;
      issues.push(
        ...localSchemaIssues(
          entry,
          child,
          `${path}.${key}`,
          depth + 1,
          includeRequired,
        ),
      );
    }
  return issues;
}

// Schema findings by component path and content: while one step is edited the
// others are not re-walked. Bounded and content-keyed, so in-place changes by
// a caller still produce fresh findings.
const componentIssueCache = new Map<string, string[]>();
function cachedIssues(
  value: object,
  path: string,
  compute: () => string[],
): string[] {
  const key = `${path}\n${JSON.stringify(value)}`;
  let issues = componentIssueCache.get(key);
  if (!issues) {
    if (componentIssueCache.size > 4000) componentIssueCache.clear();
    componentIssueCache.set(key, (issues = compute()));
  }
  return issues;
}

/** Local findings for a parsed configuration; `text` only positions them. */
function diagnoseParsed(
  config: Config,
  text: string | null,
): ConfigurationDiagnostic[] {
  const diagnostics: ConfigurationDiagnostic[] = [];
  const seen = new Set<string>();
  const add = (
    message: string,
    severity: "error" | "warning",
    field?: string,
    componentId?: string,
    enrichmentTableId?: string,
  ) => {
    const key = `${severity}\n${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push({
      ...(text === null ? { from: 0, to: 0 } : location(text, field)),
      severity,
      message,
      ...(componentId ? { componentId } : {}),
      ...(enrichmentTableId ? { enrichmentTableId } : {}),
    });
  };
  try {
    for (const issue of pipelineIssues(config))
      add(issue.message, "error", issue.id, issue.id);
    const globals = resolveSchema(vectorSchema, vectorSchema, config);
    for (const [key, value] of Object.entries(config)) {
      if (["sources", "transforms", "sinks"].includes(key)) continue;
      if (!own(globals.properties || {}, key)) continue;
      if (key === "enrichment_tables" && record(value)) {
        const tables = resolveSchema(
          globals.properties[key],
          vectorSchema,
          value,
        );
        // Attribute table-local errors to both graph roles that edit this
        // same table. Map-level errors stay global below.
        for (const [tableId, table] of Object.entries(value)) {
          const path = `${key}.${tableId}`;
          const issues =
            table && typeof table === "object"
              ? cachedIssues(table, path, () =>
                  localSchemaIssues(
                    table,
                    mapValueSchema(tables, tableId),
                    path,
                  ),
                )
              : localSchemaIssues(table, mapValueSchema(tables, tableId), path);
          for (const message of issues)
            add(message, "error", tableId, undefined, tableId);
        }
      }
      for (const message of localSchemaIssues(
        value,
        globals.properties[key],
        key,
      ))
        add(message, "error", key);
    }
    for (const kind of ["sources", "transforms", "sinks"] as Kind[]) {
      for (const [id, component] of Object.entries(config[kind] || {}) as [
        string,
        Config,
      ][]) {
        if (typeof component.type !== "string" || !component.type.trim()) {
          add(`${id}: component type is required.`, "error", id, id);
          continue;
        }
        const definition = catalog.find(
          (item) => item.kind === kind && item.type === component.type,
        );
        const schema = definition && componentSchema(definition);
        if (schema)
          for (const message of cachedIssues(component, `${kind}.${id}`, () =>
            localSchemaIssues(component, schema, `${kind}.${id}`, 0, false),
          ))
            add(message, "error", id, id);
        else if (typeof component.type === "string")
          add(
            `${id}: this component type requires validation with the device's Vector build.`,
            "warning",
            id,
            id,
          );
      }
    }
  } catch {
    add(
      "Local validation could not finish. Check the component and field shapes before importing.",
      "error",
    );
  }
  let deferred = !!config.provider || !!config.secret;
  function visit(value: unknown, key?: string) {
    if (deferred) return;
    if (
      nativeReference(value) ||
      (key === "inputs" &&
        Array.isArray(value) &&
        value.some(
          (input) => typeof input === "string" && /[*?\[]/.test(input),
        ))
    )
      deferred = true;
    if (value && typeof value === "object")
      for (const [name, entry] of Object.entries(value)) visit(entry, name);
  }
  visit(config);
  if (deferred)
    diagnostics.push({
      ...(text === null ? { from: 0, to: 0 } : range(text)),
      severity: "warning",
      code: "deferred",
      message:
        "Each device resolves secrets, environment variables, providers and input patterns before applying.",
    });
  return diagnostics;
}

export function diagnoseConfigurationSource(
  text: string,
  format: ConfigurationFormat | string,
): ConfigurationSourceDiagnosis {
  let config: Config;
  try {
    config = parseSource(text, format);
  } catch (error) {
    return {
      diagnostics:
        error instanceof ConfigurationSourceError
          ? error.diagnostics
          : [syntaxDiagnostic(text, error)],
      locallyValid: false,
      runtimeValidationRequired: true,
    };
  }
  const diagnostics = diagnoseParsed(config, text);
  return {
    config,
    diagnostics,
    locallyValid: !diagnostics.some((item) => item.severity === "error"),
    runtimeValidationRequired: true,
  };
}

/**
 * The same local checks for the editor's draft object, without a text round
 * trip: unchanged components keep their identity and their cached findings.
 */
export function diagnoseConfiguration(
  config: Config,
): ConfigurationSourceDiagnosis {
  const failed = (message: string): ConfigurationSourceDiagnosis => ({
    diagnostics: [{ from: 0, to: 0, severity: "error", message }],
    locallyValid: false,
    runtimeValidationRequired: true,
  });
  try {
    const text = stringifyConfiguration(config, "json");
    if (
      text.length * 3 > MAX_CONFIGURATION_BYTES &&
      new TextEncoder().encode(text).length > MAX_CONFIGURATION_BYTES
    )
      return failed("The configuration exceeds the 1 MiB file limit.");
    if (!record(config)) return failed("The configuration must be an object.");
    for (const section of sections) {
      if (!own(config, section)) continue;
      if (!record(config[section]))
        return failed(`${section}: the component section must be an object.`);
      for (const [id, component] of Object.entries(config[section]))
        if (!record(component))
          return failed(`${section}.${id}: each component must be an object.`);
    }
    const diagnostics = diagnoseParsed(config, null);
    return {
      config,
      diagnostics,
      locallyValid: !diagnostics.some((item) => item.severity === "error"),
      runtimeValidationRequired: true,
    };
  } catch (error) {
    return failed(
      (error as Error).message || "The pipeline could not be checked locally.",
    );
  }
}

/** Import gate. A local pass is not native validation or verified activation. */
export function assertValidPipelineSource(
  text: string,
  format: ConfigurationFormat | string,
): Config {
  const result = diagnoseConfigurationSource(text, format);
  const errors = result.diagnostics.filter((item) => item.severity === "error");
  if (errors.length || !result.config)
    throw new ConfigurationSourceError(errors);
  return result.config;
}

/** Only an actually blank draft can be replaced without a replacement decision. */
export function isEmptyPipeline(config: Config): boolean {
  return (
    record(config) &&
    Object.entries(config).every(
      ([key, value]) =>
        ["sources", "transforms", "sinks"].includes(key) &&
        record(value) &&
        Object.keys(value).length === 0,
    )
  );
}

/** How many errors and warnings a source has: "1 error · 0 warnings". */
export function diagnosticCounts(
  diagnostics: readonly Pick<ConfigurationDiagnostic, "severity">[],
): string {
  const count = (severity: ConfigurationDiagnostic["severity"]) =>
    diagnostics.filter((item) => item.severity === severity).length;
  const errors = count("error"),
    warnings = count("warning");
  return `${errors} ${errors === 1 ? "error" : "errors"} · ${warnings} ${warnings === 1 ? "warning" : "warnings"}`;
}
