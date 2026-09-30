/**
 * An enrollment token's scope as Add device collects it: preapproved device
 * names and labels for the devices it enrolls. Normalized exactly as the
 * server does (server/src/enrollment_scope.rs), so the page can say what's
 * wrong before anything is sent. The server checks again.
 */
export const maxPreapprovedNames = 500;
export const maxLabels = 8;
const maxLabelKey = 63;
const maxLabelValue = 128;

// Rust's str::trim: Unicode White_Space only (JavaScript's trim also strips
// U+FEFF, which the server keeps and then refuses).
const whiteSpace =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const trimmed = (value: string) =>
  value.replace(new RegExp(`^[${whiteSpace}]+|[${whiteSpace}]+$`, "g"), "");
// ASCII only, as Rust's to_ascii_lowercase: "K" (Kelvin) must stay invalid.
const asciiLower = (value: string) =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const utf8Length = (value: string) => new TextEncoder().encode(value).length;
const nameShape = /^[a-z0-9][a-z0-9._-]*$/;
// Controls: C0, DEL and C1, as Rust's char::is_control.
const control = /[\u0000-\u001f\u007f-\u009f]/;

/** A device name as enrollment stores it, or null when it can never enroll. */
export function deviceName(raw: string) {
  if (!raw || utf8Length(raw) > 100 || raw.includes("\0")) return null;
  const name = asciiLower(trimmed(raw));
  return nameShape.test(name) ? name : null;
}

export function labelKey(raw: string) {
  const key = asciiLower(trimmed(raw));
  return key.length <= maxLabelKey && nameShape.test(key) ? key : null;
}

export function labelValue(raw: string) {
  const value = trimmed(raw);
  return value && [...value].length <= maxLabelValue && !control.test(value)
    ? value
    : null;
}

type Parsed<T> = { value: T | null; error: string };

/**
 * Preapproved names from a text field: one per line or separated by commas
 * or spaces. Empty means no list. Repeats of a name count once.
 */
export function parsePreapprovedNames(
  text: string,
  prefix = "",
): Parsed<string[]> {
  const entries = text.split(/[\s,]+/).filter(Boolean);
  if (!entries.length) return { value: null, error: "" };
  const names: string[] = [];
  for (const entry of entries) {
    const name = deviceName(entry);
    if (!name)
      return {
        value: null,
        error: `${entry.slice(0, 100)} can't be a device name. Use letters, numbers, dots, hyphens or underscores, starting with a letter or number.`,
      };
    if (prefix && !name.startsWith(prefix))
      return {
        value: null,
        error: `${name} doesn't start with ${prefix}, so it could never enroll.`,
      };
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > maxPreapprovedNames)
    return {
      value: null,
      error: `List at most ${maxPreapprovedNames} names; this has ${names.length}.`,
    };
  return { value: names, error: "" };
}

/** Labels from a text field, one key=value per line. Empty means none. */
export function parseLabels(text: string): Parsed<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((line) => trimmed(line));
  if (!lines.length) return { value: null, error: "" };
  const labels: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf("=");
    if (at < 0)
      return {
        value: null,
        error: `Write each label as key=value, for example site=berlin.`,
      };
    const key = labelKey(line.slice(0, at));
    if (!key)
      return {
        value: null,
        error: `${trimmed(line.slice(0, at)) || "An empty key"} can't be a label key. Use up to ${maxLabelKey} letters, numbers, dots, hyphens or underscores, starting with a letter or number.`,
      };
    const value = labelValue(line.slice(at + 1));
    if (!value)
      return {
        value: null,
        error: `Give ${key} a value of 1 to ${maxLabelValue} characters.`,
      };
    if (key in labels)
      return { value: null, error: `${key} appears more than once.` };
    labels[key] = value;
  }
  if (Object.keys(labels).length > maxLabels)
    return { value: null, error: `Use at most ${maxLabels} labels.` };
  return { value: labels, error: "" };
}

/**
 * A warning when a token's use limit is below the number of names it lists,
 * so that some listed names could never enroll; empty otherwise. `maxUses`
 * is the form's text: empty means no limit.
 */
export function usesBelowNames(names: string[] | null, maxUses: string) {
  const uses = Number(maxUses);
  if (!names || !maxUses.trim() || !Number.isInteger(uses) || uses < 1)
    return "";
  if (uses >= names.length) return "";
  return `Only ${uses} of these ${names.length} names can enroll: raise Devices it can enroll, or leave it empty.`;
}

/** Whether a stored scope equals a requested one; absent and null match. */
export function sameScope(
  a: {
    allowed_names?: string[] | null;
    labels?: Record<string, string> | null;
  },
  b: {
    allowed_names?: string[] | null;
    labels?: Record<string, string> | null;
  },
) {
  const names = (value?: string[] | null) => JSON.stringify(value || null);
  const labels = (value?: Record<string, string> | null) =>
    JSON.stringify(
      value && Object.keys(value).length
        ? Object.entries(value).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        : null,
    );
  return (
    names(a.allowed_names) === names(b.allowed_names) &&
    labels(a.labels) === labels(b.labels)
  );
}

/** What a token may enroll, in one line for the token list. */
export function scopeText(token: {
  name_prefix?: string | null;
  allowed_names?: string[] | null;
  labels?: Record<string, string> | null;
  recovery_name?: string;
}) {
  if (token.recovery_name) return `Recovery for ${token.recovery_name}`;
  const names = token.allowed_names || [];
  const parts = [
    names.length === 1
      ? `Only ${names[0]}`
      : names.length > 1
        ? `${names.length} preapproved names`
        : token.name_prefix
          ? `Names starting with ${token.name_prefix}`
          : "Any unique device name",
  ];
  const labels = Object.entries(token.labels || {});
  if (labels.length)
    parts.push(
      `labels ${labels.map(([key, value]) => `${key}=${value}`).join(", ")}`,
    );
  return parts.join(" · ");
}
