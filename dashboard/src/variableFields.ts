import type { Config, VariableDeclaration } from "./api";

export type VariableField = VariableDeclaration & { label: string };

const blockedSegments = new Set([
  "api",
  "type",
  "inputs",
  "source",
  "condition",
  "tls",
  "verify_certificate",
  "verify_hostname",
  "ca_file",
  "cert_file",
  "key_file",
  "command",
  "exec",
  "script",
  "code",
  "auth",
  "password",
  "secret",
  "secrets",
  "token",
  "credential",
  "private_key",
  "access_key",
  "api_key",
  "headers",
  "query",
  "provider",
  "source_files",
  "files",
]);

const safeSegment = (part: string) =>
  !blockedSegments.has(part.toLowerCase()) &&
  !/password|secret|credential/i.test(part);
const encode = (part: string) => part.replaceAll("~", "~0").replaceAll("/", "~1");

/** Only existing, typed scalar leaves can be overridden at deployment. */
export function variableFields(config: Config): VariableField[] {
  const fields: VariableField[] = [];
  function visit(value: unknown, segments: string[]) {
    if (segments.length > 24) return;
    const type =
      typeof value === "string"
        ? "string"
        : typeof value === "boolean"
          ? "boolean"
          : typeof value === "number" && Number.isSafeInteger(value)
            ? "integer"
            : null;
    if (type && segments.length) {
      fields.push({
        name: "",
        path: `/${segments.map(encode).join("/")}`,
        type,
        label: segments.join(" › "),
      });
      return;
    }
    if (Array.isArray(value)) return;
    if (value && typeof value === "object") {
      for (const [part, child] of Object.entries(value))
        if (safeSegment(part)) visit(child, [...segments, part]);
    }
  }
  visit(config, []);
  return fields.sort((left, right) => left.label.localeCompare(right.label));
}

export function variableErrors(
  config: Config,
  declarations: VariableDeclaration[],
): string[] {
  const fields = new Map(variableFields(config).map((field) => [field.path, field]));
  const names = new Set<string>();
  const paths = new Set<string>();
  const errors: string[] = [];
  if (declarations.length > 64)
    errors.push("A pipeline can declare at most 64 device-specific variables.");
  for (const declaration of declarations) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(declaration.name))
      errors.push(`Variable ${declaration.name || "(unnamed)"} needs a letter-led name using letters, numbers, or underscores.`);
    if (names.has(declaration.name))
      errors.push(`Variable name ${declaration.name} is used more than once.`);
    names.add(declaration.name);
    if (paths.has(declaration.path))
      errors.push(`Field ${declaration.path} is assigned to more than one variable.`);
    paths.add(declaration.path);
    if (new TextEncoder().encode(declaration.path).length > 512)
      errors.push(`Variable ${declaration.name} has a field path longer than 512 bytes.`);
    const field = fields.get(declaration.path);
    if (!field)
      errors.push(`Variable ${declaration.name} no longer points to an eligible field (${declaration.path}).`);
    else if (field.type !== declaration.type)
      errors.push(`Variable ${declaration.name} expects ${declaration.type}, but ${field.label} is now ${field.type}.`);
  }
  return errors;
}
