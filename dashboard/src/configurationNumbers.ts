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

export function parseExactJSON(text: string): any {
  const value = JSON.parse(text);
  assertExactNumbers(value);
  return value;
}

export function stringifyExactJSON(value: unknown): string {
  assertExactNumbers(value);
  return JSON.stringify(value);
}
