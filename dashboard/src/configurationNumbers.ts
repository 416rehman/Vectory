/** Reject a lossy edit before it reaches draft state or persistence. Never coerce a Vector number to text. */
export function assertExactNumbers(
  value: unknown,
  path = "configuration",
): void {
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      throw Error(
        path +
          ": this number cannot be represented exactly by the editor. The configuration was not loaded or saved. Whole numbers must be between -9007199254740991 and 9007199254740991.",
      );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value))
    assertExactNumbers(
      entry,
      Array.isArray(value) ? path + "[" + key + "]" : path + "." + key,
    );
}

type RawJSON = { readonly rawJSON: string };
const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => RawJSON })
  .rawJSON;
const isRawJSON = (
  JSON as unknown as { isRawJSON?: (value: unknown) => boolean }
).isRawJSON;

/**
 * A whole number beyond 2^53 kept as its exact digits (epoch nanoseconds,
 * 64-bit IDs). `JSON.stringify` writes it back as the same number.
 */
export function isExactInteger(value: unknown): value is RawJSON {
  return !!isRawJSON && isRawJSON(value);
}

/**
 * Parse event payloads without losing precision: whole numbers beyond
 * 2^53 keep their exact digits. Browsers without JSON source access fall
 * back to a plain parse, and the exactness guard then names the field.
 */
export function parseLosslessJSON(text: string): any {
  if (!rawJSON) return JSON.parse(text);
  return JSON.parse(text, function (
    this: unknown,
    _key: string,
    value: unknown,
    context?: { source?: string },
  ) {
    return typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      context?.source &&
      /^-?\d+$/.test(context.source)
      ? rawJSON(context.source)
      : value;
  } as (key: string, value: unknown) => unknown);
}

export function parseExactJSON(text: string): any {
  const value = JSON.parse(text);
  assertExactNumbers(value);
  return value;
}

export function stringifyExactJSON(value: unknown): string {
  assertExactNumbers(value);
  return JSON.stringify(value);
}
