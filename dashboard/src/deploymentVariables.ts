import type { Device, VariableDeclaration } from "./api";

export type BindingInputs = {
  defaults: Record<string, string>;
  devices: Record<string, Record<string, string>>;
};
export type BindingValue = string | number | boolean;
export type VariableBindings = {
  defaults: Record<string, BindingValue>;
  devices: Record<string, Record<string, BindingValue>>;
};

const has = (object: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(object, key);

function parseValue(
  declaration: VariableDeclaration,
  raw: string,
): { value?: BindingValue; error?: string } {
  if (declaration.type === "integer") {
    if (
      !/^-?(?:0|[1-9][0-9]*)$/.test(raw) ||
      !Number.isSafeInteger(Number(raw))
    )
      return {
        error:
          "Enter a whole number between -9007199254740991 and 9007199254740991.",
      };
    return { value: Number(raw) };
  }
  if (declaration.type === "boolean") {
    if (raw !== "true" && raw !== "false")
      return { error: "Choose true or false." };
    return { value: raw === "true" };
  }
  if (new TextEncoder().encode(raw).length > 4096)
    return { error: "Keep this value under 4096 UTF-8 bytes." };
  if (
    /[\u0000-\u001f\u007f]|\$\{|\{\{|%\{|SECRET\[|vectory-secret:|password=|token=|api_key=|:\/\/[^/\s]*@/i.test(
      raw,
    ) ||
    raw.includes("$")
  )
    return {
      error:
        "Use a nonsecret literal without interpolation, credentials, or control characters.",
    };
  return { value: raw };
}

export function resolveVariableBindings(
  declarations: VariableDeclaration[],
  inputs: BindingInputs,
  targetIds: string[],
  persistent: boolean,
): { bindings: VariableBindings; errors: string[] } {
  const bindings: VariableBindings = { defaults: {}, devices: {} };
  const errors: string[] = [];
  for (const declaration of declarations) {
    const name = declaration.name;
    if (has(inputs.defaults, name)) {
      const parsed = parseValue(declaration, inputs.defaults[name]);
      if (parsed.error) errors.push(`${name} default: ${parsed.error}`);
      else bindings.defaults[name] = parsed.value!;
    } else if (persistent) {
      errors.push(`${name} needs a default for future group members.`);
    }
    let missing = 0;
    for (const deviceId of targetIds) {
      const input = inputs.devices[deviceId];
      if (input && has(input, name)) {
        const parsed = parseValue(declaration, input[name]);
        if (parsed.error)
          errors.push(`${name} override for ${deviceId}: ${parsed.error}`);
        else {
          (bindings.devices[deviceId] ||= {})[name] = parsed.value!;
        }
      } else if (!has(inputs.defaults, name)) {
        missing++;
      }
    }
    if (missing)
      errors.push(
        `${name} needs a value for ${missing} selected ${missing === 1 ? "device" : "devices"}.`,
      );
  }
  return { bindings, errors };
}

/**
 * Per-device values pasted from a spreadsheet or CSV: one device per line,
 * its name (or ID) first, then one value per declaration in order, separated
 * by tabs or commas. Blank cells are skipped; a header row is ignored.
 */
export function pastedValues(
  text: string,
  declarations: Pick<VariableDeclaration, "name">[],
  devices: Pick<Device, "id" | "name">[],
) {
  const byName = new Map<string, string>();
  for (const device of devices) {
    byName.set(device.name.toLowerCase(), device.id);
    byName.set(device.id.toLowerCase(), device.id);
  }
  const values: Record<string, Record<string, string>> = {};
  const unknown: string[] = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  lines.forEach((line, index) => {
    const cells = line
      .split(line.includes("\t") ? "\t" : ",")
      .map((cell) => cell.trim().replace(/^"(.*)"$/, "$1"));
    const key = (cells[0] || "").toLowerCase();
    const deviceId = byName.get(key);
    if (!deviceId) {
      // A spreadsheet header ("device", "name", …) is not a device.
      if (index === 0 && /^(device|name|host)/.test(key)) return;
      unknown.push(cells[0]);
      return;
    }
    declarations.forEach((declaration, position) => {
      const value = cells[position + 1];
      if (value === undefined || value === "") return;
      (values[deviceId] ||= {})[declaration.name] = value;
    });
  });
  return { values, applied: Object.keys(values).length, unknown };
}
