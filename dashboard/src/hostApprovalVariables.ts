import type { Config, Device, VariableDeclaration } from "./api";
import type { VariableBindings } from "./deploymentVariables";
import { hostApprovals, type HostApprovals } from "./hostRequirements";

type Scalar = string | number | boolean;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string) =>
  Object.hasOwn(value, key);

/** Decode the same object-only JSON Pointer leaves accepted by the server. */
function pointer(path: string): string[] | null {
  if (!path.startsWith("/") || new TextEncoder().encode(path).length > 512)
    return null;
  const tokens = path.slice(1).split("/");
  if (tokens.some((token) => !token || /~(?![01])/.test(token))) return null;
  return tokens.map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function sameType(value: unknown, type: VariableDeclaration["type"]): boolean {
  return type === "string"
    ? typeof value === "string"
    : type === "boolean"
      ? typeof value === "boolean"
      : typeof value === "number" && Number.isSafeInteger(value);
}

/** Copy the path to a declared scalar without mutating the published version. */
function withValue(
  config: Record<string, unknown>,
  tokens: readonly string[],
  value: Scalar,
  type: VariableDeclaration["type"],
): Record<string, unknown> | null {
  const branch = (
    node: unknown,
    index: number,
  ): Record<string, unknown> | null => {
    if (!object(node) || !own(node, tokens[index])) return null;
    const key = tokens[index];
    const child = node[key];
    const replacement =
      index === tokens.length - 1
        ? sameType(child, type) && sameType(value, type)
          ? value
          : null
        : branch(child, index + 1);
    if (replacement === null) return null;
    // Object.fromEntries creates an own data property even for __proto__.
    const copy = Object.fromEntries(Object.entries(node));
    Object.defineProperty(copy, key, {
      value: replacement,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    return copy;
  };
  return branch(config, 0);
}

/**
 * Compute host requirements from the exact typed values each selected device
 * would receive. Null means a value or published path is incomplete: callers
 * must show no base-version commands in that state.
 */
export function hostApprovalsByDevice(
  config: Config,
  declarations: readonly VariableDeclaration[],
  bindings: VariableBindings,
  devices: readonly Pick<Device, "id" | "os">[],
): Map<string, HostApprovals> | null {
  const result = new Map<string, HostApprovals>();
  if (!declarations.length) {
    const byOS = new Map<string, HostApprovals>();
    for (const device of devices) {
      let approvals = byOS.get(device.os);
      if (!approvals) {
        approvals = hostApprovals(config, device.os);
        byOS.set(device.os, approvals);
      }
      result.set(device.id, approvals);
    }
    return result;
  }
  const parsed = declarations.map((declaration) => ({
    declaration,
    tokens: pointer(declaration.path),
  }));
  if (parsed.some((item) => !item.tokens)) return null;
  const seen = new Set<string>();
  for (const { declaration } of parsed) {
    if (seen.has(declaration.path)) return null;
    seen.add(declaration.path);
  }
  const cache = new Map<string, HostApprovals>();
  for (const device of devices) {
    const overrides = bindings.devices[device.id] || {};
    const values: Scalar[] = [];
    for (const { declaration } of parsed) {
      const source = own(overrides, declaration.name)
        ? overrides
        : bindings.defaults;
      if (!own(source, declaration.name)) return null;
      const value = source[declaration.name];
      if (!sameType(value, declaration.type)) return null;
      values.push(value);
    }
    const signature = JSON.stringify([device.os, values]);
    let approvals = cache.get(signature);
    if (!approvals) {
      let rendered: Record<string, unknown> = config;
      for (const [index, { declaration, tokens }] of parsed.entries()) {
        const next = withValue(
          rendered,
          tokens!,
          values[index],
          declaration.type,
        );
        if (!next) return null;
        rendered = next;
      }
      approvals = hostApprovals(rendered, device.os);
      cache.set(signature, approvals);
    }
    result.set(device.id, approvals);
  }
  return result;
}
