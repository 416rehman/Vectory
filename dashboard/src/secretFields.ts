import type { Config } from "./api";
import table from "./generated/secret-fields.json";

/**
 * Device secrets: `vectory-secret:NAME` references that each device fills from
 * a local file. They are allowed only at the credential fields of the pinned
 * Vector schema (generated/secret-fields.json, the same table the agent and
 * the server use). A path step is an object field or a list index.
 */
export type SecretPath = readonly (string | number)[];
export type SecretKind = "sources" | "transforms" | "sinks";

export const SECRET_PREFIX = "vectory-secret:";
export const DEVICE_SECRET_FIX =
  "Use a device secret: vectory-secret:NAME, then bind it on each device with `vectory configure-secrets`.";
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const KINDS: readonly SecretKind[] = ["sources", "transforms", "sinks"];

type Step = { field: string } | "*" | "[]";
const fields = table.fields as Record<string, Record<string, string[]>>;
const patterns = new Map<string, Step[][]>();
function patternsFor(kind: string, type: string): Step[][] {
  const key = `${kind}/${type}`;
  let parsed = patterns.get(key);
  if (!parsed) {
    parsed = (fields[kind]?.[type] ?? []).map((path) =>
      path.split(".").flatMap((segment): Step[] => {
        const name = segment.replace(/(\[\])+$/, "");
        const items = (segment.length - name.length) / 2;
        return [
          name === "*" ? "*" : { field: name },
          ...Array<Step>(items).fill("[]"),
        ];
      }),
    );
    patterns.set(key, parsed);
  }
  return parsed;
}

/** The table's paths for one component type: `a.b`, `list[]`, `map.*`. */
export function secretFieldPaths(kind: string, type: string): string[] {
  return fields[kind]?.[type] ?? [];
}

/** Whether a path inside a component can hold a device secret. */
export function isSecretField(
  kind: string,
  type: string,
  path: SecretPath,
): boolean {
  return patternsFor(kind, type).some(
    (pattern) =>
      pattern.length === path.length &&
      pattern.every((want, index) => {
        const got = path[index];
        if (want === "[]") return typeof got === "number";
        if (want === "*") return typeof got === "string";
        return got === want.field;
      }),
  );
}

/** `auth.token`, `valid_tokens[1]`. */
export function formatSecretPath(path: SecretPath): string {
  return path
    .map((step, index) =>
      typeof step === "number" ? `[${step}]` : index === 0 ? step : `.${step}`,
    )
    .join("");
}

/** The name of an exact `vectory-secret:NAME` reference, or null. */
export function secretNameOf(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(SECRET_PREFIX))
    return null;
  const name = value.slice(SECRET_PREFIX.length);
  return NAME.test(name) ? name : null;
}

/**
 * A name that is really the credential, pasted into the name box: a UUID or
 * well-known token prefix, a long run of letters and digits without
 * separators, or a long mixed-case string with digits. Names are stored in
 * the pipeline, so these are refused. Names such as DD_API_KEY_2 pass.
 */
export function looksLikeCredential(name: string): boolean {
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(name)) return true;
  if (
    name.length >= 16 &&
    /^(?:gh[oprsu]_|github_pat_|glpat-|xox[abeprs]-|sk-)/.test(name)
  )
    return true;
  const digits = /\d/.test(name),
    lower = /[a-z]/.test(name),
    upper = /[A-Z]/.test(name);
  if (name.length >= 20 && digits && (lower || upper) && !/[_.-]/.test(name))
    return true;
  return name.length >= 24 && digits && lower && upper;
}

/** What is wrong with a secret name while it is typed, or null. */
export function secretNameProblem(name: string): string | null {
  if (!name) return "Enter a name for this secret.";
  if (looksLikeCredential(name))
    return "That looks like the credential itself. Use a name, such as DD_API_KEY, and keep the value in a file on each device.";
  if (!/^[A-Za-z]/.test(name)) return "Start the name with a letter.";
  if (/[^A-Za-z0-9_.-]/.test(name))
    return "Use only letters, digits, dots, dashes and underscores.";
  if (name.length > 64) return "Use at most 64 characters.";
  return null;
}

/** A name for a new secret from its step and field: DD_DEFAULT_API_KEY. */
export function suggestedSecretName(componentId: string, path: SecretPath) {
  const field = [...path].reverse().find((step) => typeof step === "string");
  const words = `${componentId}_${field ?? "secret"}`
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  const name = /^[A-Z]/.test(words) ? words : `SECRET_${words}`;
  return name.slice(0, 64);
}

export function isNativeReference(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|SECRET\[[^.[\]\s]+\.[^[\]\s]+\])$/.test(
      value.replace(/^(?:Bearer|Basic) /, ""),
    )
  );
}

export type SecretUse = {
  name: string;
  kind: SecretKind;
  id: string;
  type: string;
  field: string;
};
export type SecretFinding = {
  id?: string;
  field: string;
  code:
    | "plaintext_credential"
    | "secret_reference_refused"
    | "secret_reference_invalid";
  message: string;
};

const record = (value: unknown): value is Config =>
  !!value && typeof value === "object" && !Array.isArray(value);

function visit(
  value: unknown,
  path: (string | number)[],
  each: (text: string, path: SecretPath) => void,
) {
  if (typeof value === "string") each(value, path);
  else if (Array.isArray(value))
    value.forEach((item, index) => visit(item, [...path, index], each));
  else if (record(value))
    for (const [key, item] of Object.entries(value))
      visit(item, [...path, key], each);
}

/** Every string in a configuration with its component and field. */
function scan(
  config: Config,
  each: (
    text: string,
    at: {
      kind: SecretKind;
      id: string;
      type: string;
      field: SecretPath;
    } | null,
    path: SecretPath,
  ) => void,
) {
  if (!record(config)) return;
  for (const [key, value] of Object.entries(config)) {
    const kind = KINDS.find((section) => section === key);
    if (!kind || !record(value)) {
      visit(value, [key], (text, path) => each(text, null, path));
      continue;
    }
    for (const [id, component] of Object.entries(value)) {
      if (!record(component)) {
        visit(component, [key, id], (text, path) => each(text, null, path));
        continue;
      }
      const type = typeof component.type === "string" ? component.type : "";
      for (const [field, item] of Object.entries(component))
        visit(item, [field], (text, path) =>
          each(text, { kind, id, type, field: path }, [key, id, ...path]),
        );
    }
  }
}

/** The device secrets a configuration uses, in pipeline order. */
export function secretReferences(config: Config): SecretUse[] {
  const uses: SecretUse[] = [];
  scan(config, (text, at) => {
    const name = secretNameOf(text);
    if (name && at?.type && isSecretField(at.kind, at.type, at.field))
      uses.push({
        name,
        kind: at.kind,
        id: at.id,
        type: at.type,
        field: formatSecretPath(at.field),
      });
  });
  return uses;
}

/** Distinct secret names a configuration needs, sorted. */
export function secretNamesOf(config: Config): string[] {
  return [...new Set(secretReferences(config).map((use) => use.name))].sort();
}

export type SecretNeed = {
  name: string;
  /** Where the configuration reads it: `dd.default_api_key`. */
  uses: string[];
};

/** Each secret a configuration needs, sorted by name, with where it is read. */
export function secretNeeds(config: Config | null | undefined): SecretNeed[] {
  const uses = new Map<string, string[]>();
  for (const use of config ? secretReferences(config) : [])
    uses.set(use.name, [
      ...(uses.get(use.name) ?? []),
      `${use.id}.${use.field}`,
    ]);
  return [...uses.keys()]
    .sort()
    .map((name) => ({ name, uses: uses.get(name)! }));
}

/**
 * The secrets a draft reads, for the publish review. `added` marks a name the
 * published version doesn't read (never set for a first version).
 */
export function secretReview(
  before: Config | null,
  after: Config,
): (SecretNeed & { added: boolean })[] {
  const known = new Set(before ? secretNamesOf(before) : []);
  return secretNeeds(after).map((need) => ({
    ...need,
    added: !!before && !known.has(need.name),
  }));
}

export type DeviceSecretState = SecretNeed & {
  /** Bound on the device; null when the device doesn't report its names. */
  bound: boolean | null;
};

/**
 * The secrets a version needs, checked against the names a device reported
 * binding at its last check-in (names only; values never leave the device).
 */
export function deviceSecretStates(
  config: Config | null | undefined,
  bound: readonly string[] | null | undefined,
): DeviceSecretState[] {
  return secretNeeds(config).map((need) => ({
    ...need,
    bound: Array.isArray(bound) ? bound.includes(need.name) : null,
  }));
}

/**
 * The server's device-secret rules, checked instantly: a reference outside a
 * credential field, a malformed one, and plain text in a credential field.
 * Native `SECRET[...]`, `${VAR}` and `$VAR` references stay valid there.
 */
export function secretFindings(config: Config): SecretFinding[] {
  const findings: SecretFinding[] = [];
  scan(config, (text, at, path) => {
    const credential = !!at?.type && isSecretField(at.kind, at.type, at.field);
    const field = formatSecretPath(at ? at.field : path);
    const prefix = at ? `${at.id}.${field}: ` : "";
    if (text.includes(SECRET_PREFIX)) {
      if (credential && secretNameOf(text)) return;
      findings.push(
        credential
          ? {
              id: at?.id,
              field,
              code: "secret_reference_invalid",
              message: `${prefix}\`${field}\` must be exactly \`vectory-secret:NAME\`, where NAME is a letter followed by up to 63 letters, digits, dots, dashes or underscores.`,
            }
          : {
              id: at?.id,
              field,
              code: "secret_reference_refused",
              message: `${prefix}Only credential fields can hold a device secret, and \`${field}\` isn't one.`,
            },
      );
    } else if (credential && text && !isNativeReference(text))
      findings.push({
        id: at?.id,
        field,
        code: "plaintext_credential",
        message: `${prefix}Plaintext credentials cannot be stored in \`${field}\`. ${DEVICE_SECRET_FIX}`,
      });
  });
  return findings;
}

/** A credential field's value as the picker shows it. */
export type PickerMode = "device" | "native";
export type PickerState = {
  mode: PickerMode;
  /** The secret name (device) or the whole reference (native). */
  text: string;
  /** A plain-text credential is set; it is never shown. */
  plainText: boolean;
  /** A device secret sits where this field can't take one. */
  refused: boolean;
};

export function pickerState(
  value: unknown,
  deviceAllowed: boolean,
): PickerState {
  const fresh = (plainText = false, refused = false): PickerState => ({
    mode: deviceAllowed ? "device" : "native",
    text: "",
    plainText,
    refused,
  });
  if (typeof value !== "string" || value === "") return fresh();
  if (value.startsWith(SECRET_PREFIX))
    return deviceAllowed
      ? {
          mode: "device",
          text: value.slice(SECRET_PREFIX.length),
          plainText: false,
          refused: false,
        }
      : fresh(false, true);
  if (isNativeReference(value))
    return { mode: "native", text: value, plainText: false, refused: false };
  return fresh(true);
}

/**
 * What typing `text` means: a device secret name, or (when it starts like
 * one) a Vector reference. A pasted `vectory-secret:NAME` is its name.
 */
export function readPickerInput(
  mode: PickerMode,
  text: string,
  deviceAllowed: boolean,
): { mode: PickerMode; text: string } {
  if (deviceAllowed && text.startsWith(SECRET_PREFIX))
    return { mode: "device", text: text.slice(SECRET_PREFIX.length) };
  if (mode === "device" && /^(?:\$|SECRET\[|Bearer |Basic )/.test(text))
    return { mode: "native", text };
  return { mode: deviceAllowed ? mode : "native", text };
}

/** The value to save for the picker's text, or why there is none yet. */
export function pickerValue(
  mode: PickerMode,
  text: string,
): { value: string | null; problem: string | null } {
  if (mode === "device") {
    const problem = secretNameProblem(text);
    return { value: problem ? null : SECRET_PREFIX + text, problem };
  }
  if (isNativeReference(text)) return { value: text, problem: null };
  return {
    value: null,
    problem: text
      ? "Enter SECRET[backend.key], ${VARIABLE} or $VARIABLE. Plain-text credentials are never saved."
      : "Enter a Vector secret or variable reference.",
  };
}

export type BindingPlatform = "unix" | "windows";

/** Where the guide suggests keeping each secret's file. */
export function secretFile(name: string, platform: BindingPlatform) {
  return platform === "windows"
    ? `C:\\ProgramData\\Vectory\\secrets\\${name}`
    : `/etc/vectory/secrets/${name}`;
}

/**
 * The bindings file and commands for one device. The file replaces every
 * binding, so it lists all the names the device needs.
 */
export function bindingInstructions(
  names: readonly string[],
  platform: BindingPlatform,
) {
  const list = [...new Set(names)].sort();
  const bindingsFile =
    platform === "windows"
      ? "C:\\ProgramData\\Vectory\\secret-bindings.json"
      : "/etc/vectory/secret-bindings.json";
  const bindings = JSON.stringify(
    Object.fromEntries(list.map((name) => [name, secretFile(name, platform)])),
    null,
    2,
  );
  const commands =
    platform === "windows"
      ? [
          "vectory service-stop",
          `vectory configure-secrets --secret-files ${bindingsFile}`,
          "vectory service-start",
        ]
      : [
          "sudo vectory service-stop",
          `sudo vectory configure-secrets --secret-files ${bindingsFile}`,
          "sudo vectory service-start",
        ];
  return { bindingsFile, bindings, commands: commands.join("\n") };
}
