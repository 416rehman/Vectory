export type Schema = Record<string, any>;
type Match = boolean | null;
const own = (value: any, key: string) =>
  value !== null && typeof value === "object" && Object.hasOwn(value, key);
const record = (value: any): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const typeOf = (value: any) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const equal = (a: any, b: any): boolean =>
  Object.is(a, b) ||
  (Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => equal(v, b[i]))
    : record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => own(b, key) && equal(a[key], b[key])));
const typesOf = (schema: Schema): string[] =>
  Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : own(schema, "const")
        ? [typeOf(schema.const)]
        : schema.properties ||
            schema.additionalProperties ||
            schema.patternProperties
          ? ["object"]
          : schema.items || schema.prefixItems
            ? ["array"]
            : [];
const fitsType = (value: any, type: string) =>
  type === "integer"
    ? typeof value === "number" && Number.isInteger(value)
    : typeOf(value) === type;
function reference(ref: string, root: Schema): any {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce(
      (at, part) => (record(at) && own(at, part) ? at[part] : undefined),
      root,
    );
}
function nativeAnnotations(schema: Schema, root: Schema): Schema {
  // Vector 0.58 accepts relative PathBuf values, while its experimental schema's
  // shared regex describes absolute paths only. The target OS/Vector validates
  // path syntax and existence; keep unrelated JSON Schema patterns enforced.
  if (schema === root.definitions?.["stdlib::PathBuf"]) {
    const { pattern: _nativePathPattern, ...rest } = schema;
    return { ...rest, "x-vectory-native-path": true };
  }
  return schema;
}
export function isSecretReference(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^vectory-secret:[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) return true;
  return /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|SECRET\[[^.\[\]\s]+\.[^\[\]\s]+\])$/.test(
    value.replace(/^(?:Bearer|Basic) /, ""),
  );
}

/** Intersect structural constraints while preserving annotations and opaque keywords. */
function combine(left: Schema, right: Schema): Schema {
  const result: Schema = { ...left, ...right };
  if (left._metadata || right._metadata)
    result._metadata = { ...left._metadata, ...right._metadata };
  if (left.properties || right.properties) {
    result.properties = { ...left.properties, ...right.properties };
    for (const key of Object.keys(left.properties || {}))
      if (own(right.properties, key))
        result.properties[key] = equal(
          left.properties[key],
          right.properties[key],
        )
          ? left.properties[key]
          : { allOf: [left.properties[key], right.properties[key]] };
  }
  if (left.patternProperties || right.patternProperties)
    result.patternProperties = {
      ...left.patternProperties,
      ...right.patternProperties,
    };
  if (left.required || right.required)
    result.required = [
      ...new Set([...(left.required || []), ...(right.required || [])]),
    ];
  if (left.dependentRequired || right.dependentRequired) {
    result.dependentRequired = {
      ...left.dependentRequired,
      ...right.dependentRequired,
    };
    for (const key of Object.keys(left.dependentRequired || {}))
      result.dependentRequired[key] = [
        ...new Set([
          ...(left.dependentRequired[key] || []),
          ...(right.dependentRequired?.[key] || []),
        ]),
      ];
  }
  for (const keyword of ["dependentSchemas", "dependencies"]) {
    if (left[keyword] || right[keyword]) {
      const keys = new Set([
        ...Object.keys(left[keyword] || {}),
        ...Object.keys(right[keyword] || {}),
      ]);
      result[keyword] = Object.fromEntries(
        [...keys].map((key) => {
          const a = left[keyword]?.[key],
            b = right[keyword]?.[key];
          if (!own(left[keyword], key)) return [key, b];
          if (!own(right[keyword], key)) return [key, a];
          if (Array.isArray(a) && Array.isArray(b))
            return [key, [...new Set([...a, ...b])]];
          return [
            key,
            {
              allOf: [
                Array.isArray(a) ? { required: a } : a,
                Array.isArray(b) ? { required: b } : b,
              ],
            },
          ];
        }),
      );
    }
  }
  if (
    left["x-vectory-required-reasons"] ||
    right["x-vectory-required-reasons"]
  ) {
    const a = left["x-vectory-required-reasons"] || {},
      b = right["x-vectory-required-reasons"] || {};
    result["x-vectory-required-reasons"] = Object.fromEntries(
      [...new Set([...Object.keys(a), ...Object.keys(b)])].map((key) => [
        key,
        [...new Set([...(a[key] || []), ...(b[key] || [])])],
      ]),
    );
  }
  if (
    left["x-vectory-condition-pending"] ||
    right["x-vectory-condition-pending"]
  )
    result["x-vectory-condition-pending"] = true;
  if (left.type && right.type) {
    const a = typesOf(left),
      b = typesOf(right);
    const intersection = [
      ...new Set(
        a.flatMap((x) =>
          b.flatMap((y) =>
            x === y
              ? [x]
              : [x, y].includes("integer") && [x, y].includes("number")
                ? ["integer"]
                : [],
          ),
        ),
      ),
    ];
    result.type = intersection.length === 1 ? intersection[0] : intersection;
  }
  for (const key of [
    "minimum",
    "exclusiveMinimum",
    "minLength",
    "minItems",
    "minProperties",
    "minContains",
  ])
    if (typeof left[key] === "number" && typeof right[key] === "number")
      result[key] = Math.max(left[key], right[key]);
  for (const key of [
    "maximum",
    "exclusiveMaximum",
    "maxLength",
    "maxItems",
    "maxProperties",
    "maxContains",
  ])
    if (typeof left[key] === "number" && typeof right[key] === "number")
      result[key] = Math.min(left[key], right[key]);
  if (left.enum && right.enum)
    result.enum = left.enum.filter((v: any) =>
      right.enum.some((r: any) => equal(v, r)),
    );
  if (
    left.additionalProperties === false ||
    right.additionalProperties === false
  )
    result.additionalProperties = false;
  if (left.uniqueItems || right.uniqueItems) result.uniqueItems = true;
  return result;
}

const conditionKeywords = new Set([
  "$ref",
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "definitions",
  "$defs",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
  "_metadata",
  "type",
  "const",
  "enum",
  "allOf",
  "oneOf",
  "anyOf",
  "not",
  "if",
  "then",
  "else",
  "required",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "items",
  "prefixItems",
  "additionalItems",
  "contains",
  "minContains",
  "maxContains",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
]);

/** Conservative JSON Schema matching. Unknown references/recursion stay unknown. */
function matches(
  schema: any,
  root: Schema,
  value: any,
  depth = 0,
  condition = false,
): Match {
  if (schema === true) return true;
  if (schema === false) return false;
  if (!record(schema) || depth > 30 || (condition && value === undefined))
    return null;
  schema = nativeAnnotations(schema, root);
  const checks: Match[] = [];
  if (
    condition &&
    Object.keys(schema).some(
      (key) => !conditionKeywords.has(key) && !key.startsWith("x-"),
    )
  )
    checks.push(null);
  const check = (branch: any, v = value, strict = condition) =>
    matches(branch, root, v, depth + 1, strict);
  if (schema.$ref) {
    const target = reference(schema.$ref, root);
    checks.push(target === undefined ? null : check(target));
  }
  if (schema.type && !typesOf(schema).some((type) => fitsType(value, type)))
    return false;
  if (own(schema, "const") && !equal(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some((option: any) => equal(value, option)))
    return false;
  if (schema.allOf)
    checks.push(...schema.allOf.map((branch: Schema) => check(branch)));
  for (const key of ["oneOf", "anyOf"])
    if (schema[key]) {
      const results: Match[] = schema[key].map((branch: Schema) =>
        check(branch),
      );
      const count = results.filter((v) => v === true).length;
      checks.push(
        key === "oneOf" &&
          schema._metadata?.["docs::enum_tagging"] !== "untagged"
          ? count > 1
            ? false
            : results.includes(null)
              ? null
              : count === 1
          : count
            ? true
            : results.includes(null)
              ? null
              : false,
      );
    }
  if (own(schema, "not")) {
    const result = check(schema.not);
    checks.push(result === null ? null : !result);
  }
  if (own(schema, "if")) {
    const result = check(schema.if, value, true);
    if (result === null) checks.push(null);
    else if (own(schema, result ? "then" : "else"))
      checks.push(check(result ? schema.then : schema.else));
  }
  if (record(value)) {
    if (schema.required?.some((key: string) => !own(value, key))) return false;
    if (
      (schema.minProperties !== undefined &&
        Object.keys(value).length < schema.minProperties) ||
      (schema.maxProperties !== undefined &&
        Object.keys(value).length > schema.maxProperties)
    )
      return false;
    for (const [key, child] of Object.entries(schema.properties || {}))
      if (own(value, key)) checks.push(check(child, value[key]));
    for (const [key, child] of Object.entries(value)) {
      const patterns = Object.entries(schema.patternProperties || {}).filter(
        ([pattern]) => {
          try {
            return new RegExp(pattern, "u").test(key);
          } catch {
            checks.push(null);
            return false;
          }
        },
      );
      for (const [, branch] of patterns) checks.push(check(branch, child));
      if (
        !own(schema.properties, key) &&
        !patterns.length &&
        own(schema, "additionalProperties")
      )
        checks.push(check(schema.additionalProperties, child));
      if (own(schema, "propertyNames"))
        checks.push(check(schema.propertyNames, key));
    }
    for (const [key, required] of Object.entries(
      schema.dependentRequired || {},
    ))
      if (
        own(value, key) &&
        (required as string[]).some((name) => !own(value, name))
      )
        return false;
    for (const [key, branch] of Object.entries(schema.dependentSchemas || {}))
      if (own(value, key)) checks.push(check(branch));
    for (const [key, dependent] of Object.entries(schema.dependencies || {}))
      if (own(value, key))
        checks.push(
          Array.isArray(dependent)
            ? dependent.every((name) => own(value, name))
            : check(dependent),
        );
  }
  if (Array.isArray(value)) {
    if (
      (schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.maxItems !== undefined && value.length > schema.maxItems)
    )
      return false;
    if (
      schema.uniqueItems &&
      value.some((item, i) =>
        value.slice(0, i).some((other) => equal(item, other)),
      )
    )
      return false;
    value.forEach((item, i) => {
      const child = arrayItemSchema(schema, i);
      if (child !== undefined) checks.push(check(child, item));
    });
    if (own(schema, "contains")) {
      const found = value.map((item) => check(schema.contains, item)),
        count = found.filter((v) => v === true).length;
      if (
        count > (schema.maxContains ?? Infinity) ||
        count + found.filter((v) => v === null).length <
          (schema.minContains ?? 1)
      )
        return false;
      if (found.includes(null)) checks.push(null);
    }
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    if (
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum) ||
      (typeof schema.exclusiveMinimum === "number" &&
        value <= schema.exclusiveMinimum) ||
      (typeof schema.exclusiveMaximum === "number" &&
        value >= schema.exclusiveMaximum)
    )
      return false;
    if (schema.multipleOf > 0) {
      const ratio = value / schema.multipleOf;
      if (
        Math.abs(ratio - Math.round(ratio)) >
        Math.min(1e-7, Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8)
      )
        return false;
    }
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (
      (schema.minLength !== undefined && length < schema.minLength) ||
      (schema.maxLength !== undefined && length > schema.maxLength)
    )
      return false;
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) return false;
      } catch {
        checks.push(null);
      }
    }
  }
  return checks.includes(false) ? false : checks.includes(null) ? null : true;
}

function requiredReasons(schema: Schema, reason: string): Schema {
  if (!Array.isArray(schema.required) || !schema.required.length) return schema;
  return combine(schema, {
    "x-vectory-required-reasons": Object.fromEntries(
      schema.required.map((key: string) => [key, [reason]]),
    ),
  });
}
function conditionReason(
  condition: any,
  schema: Schema,
  root: Schema,
  value: any,
  positive: boolean,
): string {
  if (positive && record(condition) && record(condition.properties)) {
    const entries = Object.entries(condition.properties);
    if (entries.length === 1) {
      const [key, rule] = entries[0];
      const field = expand(schema.properties?.[key] || {}, root, value?.[key]);
      if (
        record(rule) &&
        own(rule, "const") &&
        own(value, key) &&
        ["string", "number", "boolean"].includes(typeof rule.const) &&
        !field._metadata?.sensitive &&
        !/(password|token|secret|credential|key)/i.test(key)
      ) {
        const label = fieldTitle(key, field),
          literal = JSON.stringify(rule.const);
        if (literal.length <= 80)
          return `Required when ${label} is ${literal}.`;
      }
    }
  }
  return "Required by the selected configuration.";
}

/** Unknown conditions offer possible properties without imposing a branch's requirements. */
function includePossibleProperties(
  base: Schema,
  thenSchema: Schema,
  elseSchema: Schema,
): Schema {
  const keys = new Set([
    ...Object.keys(thenSchema.properties || {}),
    ...Object.keys(elseSchema.properties || {}),
  ]);
  const additions = Object.fromEntries(
    [...keys]
      .filter((key) => !own(base.properties, key))
      .map((key) => {
        const a = thenSchema.properties?.[key] ?? {},
          b = elseSchema.properties?.[key] ?? {};
        return [
          key,
          equal(a, b)
            ? a
            : { anyOf: [a, b], "x-vectory-condition-pending": true },
        ];
      }),
  );
  return combine(base, {
    properties: additions,
    "x-vectory-condition-pending": true,
  });
}

/** Expand intersections/references/known conditions without choosing union branches. */
function expand(
  schema: any,
  root: Schema,
  value: any,
  seen = new Set<string>(),
): Schema {
  if (schema === false) return { not: {} };
  if (!record(schema)) return {};
  schema = nativeAnnotations(schema, root);
  let result = { ...schema };
  if (typeof schema.$ref === "string") {
    const target = reference(schema.$ref, root);
    if (seen.has(schema.$ref) || target === undefined)
      return { ...schema, "x-vectory-unresolved": true };
    const next = new Set(seen);
    next.add(schema.$ref);
    const siblings = { ...schema };
    delete siblings.$ref;
    result = combine(expand(target, root, value, next), siblings);
  }
  const all = result.allOf;
  delete result.allOf;
  for (const branch of all || [])
    result = combine(result, expand(branch, root, value, seen));
  if (own(result, "if")) {
    const rule = result.if,
      yes = result.then,
      no = result.else;
    const condition = matches(rule, root, value, 0, true);
    delete result.if;
    delete result.then;
    delete result.else;
    if (condition !== null)
      result = combine(
        result,
        requiredReasons(
          expand(condition ? yes : no, root, value, seen),
          conditionReason(rule, result, root, value, condition),
        ),
      );
    else
      result = includePossibleProperties(
        result,
        expand(yes, root, value, seen),
        expand(no, root, value, seen),
      );
  }
  if (record(value)) {
    const dependencies = [
      ...Object.entries(result.dependentSchemas || {}),
      ...Object.entries(result.dependencies || {}),
      ...Object.entries(result.dependentRequired || {}).map(
        ([key, names]) => [key, { required: names }] as [string, any],
      ),
    ];
    for (const [key, dependent] of dependencies)
      if (own(value, key)) {
        const field = expand(
          result.properties?.[key] || {},
          root,
          value[key],
          seen,
        );
        const branch = Array.isArray(dependent)
          ? { required: dependent }
          : expand(dependent, root, value, seen);
        result = combine(
          result,
          requiredReasons(
            branch,
            `Required when ${fieldTitle(key, field)} is configured.`,
          ),
        );
      }
  }
  return result;
}

export type SchemaChoice = {
  id: string;
  label: string;
  schema: Schema;
  types: string[];
  matches: Match;
  discriminator?: { key: string; value: any };
  initialValue: any;
};
export type SchemaChoiceSet = {
  kind: "oneOf" | "anyOf" | "type";
  options: SchemaChoice[];
  /** Properties declared outside the union, independent of its selected branch. */
  sharedKeys: string[];
  selectedId: string | null;
  ambiguous: boolean;
};
function semanticTypes(schema: Schema, root: Schema, depth = 0): string[] {
  if (depth > 12 || schema["x-vectory-unresolved"]) return typesOf(schema);
  const direct = typesOf(schema);
  if (direct.length) return direct;
  return [
    ...new Set(
      (schema.oneOf || schema.anyOf || []).flatMap((branch: Schema) =>
        semanticTypes(expand(branch, root, undefined), root, depth + 1),
      ),
    ),
  ] as string[];
}
function safeDefault(value: any): boolean {
  if (typeof value === "number")
    return (
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
  if (Array.isArray(value)) return value.every(safeDefault);
  if (record(value)) return Object.values(value).every(safeDefault);
  return true;
}
function usableDefault(schema: Schema, root: Schema): boolean {
  return (
    own(schema, "default") &&
    safeDefault(schema.default) &&
    matches(schema, root, schema.default) !== false
  );
}
function seed(schema: Schema, root: Schema): any {
  if (usableDefault(schema, root)) return structuredClone(schema.default);
  if (own(schema, "const")) return structuredClone(schema.const);
  const types = semanticTypes(schema, root);
  if (types.length !== 1) return undefined;
  if (types[0] === "null") return null;
  if (types[0] === "object")
    return Object.fromEntries(
      Object.entries(schema.properties || {})
        .filter(([, field]) => own(field, "const"))
        .map(([key, field]: any) => [key, structuredClone(field.const)]),
    );
  if (types[0] === "array") return [];
  if (types[0] === "boolean") return false;
  if (types[0] === "string") return "";
  return undefined;
}
function choiceLabel(
  branch: Schema,
  types: string[],
  discriminator: SchemaChoice["discriminator"],
  index: number,
): string {
  const concise = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const label = value.trim();
    return label &&
      label.length <= 40 &&
      label.split(/\s+/).length <= 5 &&
      !/[\r\n.!?]/.test(label)
      ? label
      : undefined;
  };
  const human =
    concise(branch._metadata?.["docs::human_name"]) ||
    concise(branch._metadata?.logical_name);
  if (human) return human;
  if (discriminator) return String(discriminator.value);
  if (own(branch, "const")) {
    if (branch.const === null) return "Null";
    if (typeof branch.const === "boolean")
      return branch.const ? "True" : "False";
    if (typeof branch.const === "number") return String(branch.const);
    if (
      typeof branch.const === "string" &&
      branch.const.length <= 40 &&
      !/[\r\n]/.test(branch.const)
    )
      return branch.const;
  }
  const title = concise(branch.title);
  if (title) return title;
  const names: Record<string, string> = {
    string: "Text",
    object: "Object",
    array: "List",
    boolean: "Boolean",
    integer: "Integer",
    number: "Number",
    null: "Null",
  };
  return (
    types.map((type) => names[type] || type).join(" or ") ||
    `Option ${index + 1}`
  );
}
function choiceSet(
  expanded: Schema,
  root: Schema,
  value: any,
): SchemaChoiceSet | null {
  const kind = expanded.oneOf
    ? "oneOf"
    : expanded.anyOf
      ? "anyOf"
      : Array.isArray(expanded.type) && expanded.type.length > 1
        ? "type"
        : null;
  if (!kind) return null;
  const branches =
    kind === "type"
      ? expanded.type.map((type: string) => ({ type }))
      : expanded[kind];
  const shared = { ...expanded };
  delete shared.oneOf;
  delete shared.anyOf;
  if (kind === "type") delete shared.type;
  const branchSchemas: Schema[] = branches.map((branch: Schema) =>
    expand(branch, root, value),
  );
  const nonNull = branchSchemas.filter(
    (branch) => !typesOf(branch).includes("null"),
  );
  const tag = [
    ...new Set(
      nonNull.flatMap((branch) => Object.keys(branch.properties || {})),
    ),
  ].find(
    (key) =>
      nonNull.length > 1 &&
      nonNull.every((branch) =>
        own(expand(branch.properties?.[key], root, undefined), "const"),
      ) &&
      new Set(
        nonNull.map((branch) =>
          JSON.stringify(expand(branch.properties[key], root, undefined).const),
        ),
      ).size === nonNull.length,
  );
  const options = branchSchemas.map((branch, i): SchemaChoice => {
    const schema = combine(shared, branch),
      constant = tag ? expand(branch.properties?.[tag], root, undefined) : {};
    const discriminator =
      tag && own(constant, "const")
        ? { key: tag, value: constant.const }
        : undefined;
    const types = semanticTypes(schema, root);
    const label = choiceLabel(branch, types, discriminator, i);
    return {
      id: `${kind}:${i}`,
      label,
      schema,
      types,
      matches: value === undefined ? null : matches(schema, root, value),
      discriminator,
      initialValue: seed(schema, root),
    };
  });
  const tagged = options.filter(
    (option) =>
      option.discriminator &&
      own(value, option.discriminator.key) &&
      equal(value[option.discriminator.key], option.discriminator.value),
  );
  const exact = options.filter((option) => option.matches === true),
    compatible = options.filter(
      (option) =>
        option.types.length &&
        option.types.some((type) => fitsType(value, type)),
    );
  const literal = exact.filter((option) => own(option.schema, "const"));
  const selected =
    tagged.length === 1
      ? tagged[0]
      : literal.length === 1
        ? literal[0]
        : exact.length === 1
          ? exact[0]
          : value !== undefined && compatible.length === 1
            ? compatible[0]
            : null;
  return {
    kind,
    options,
    sharedKeys: Object.keys(shared.properties || {}),
    selectedId: selected?.id || null,
    ambiguous:
      !selected &&
      (exact.length > 1 ||
        options.filter((option) => option.matches !== false).length > 1),
  };
}
export function schemaChoices(
  schema: Schema,
  root: Schema,
  value?: any,
): SchemaChoiceSet | null {
  return choiceSet(expand(schema, root, value), root, value);
}

/** Resolve only an evidenced union shape; retain every alternative for explicit editing. */
export function resolveSchema(
  schema: Schema,
  root: Schema,
  value?: any,
  seen = new Set<string>(),
  depth = 0,
): Schema {
  if (depth > 24) return { ...schema, "x-vectory-unresolved": true };
  const expanded = expand(schema, root, value, seen),
    choices = choiceSet(expanded, root, value);
  let result = { ...expanded };
  if (choices) {
    const selected = choices.options.find(
      (option) => option.id === choices.selectedId,
    );
    if (selected)
      result = resolveSchema(selected.schema, root, value, seen, depth + 1);
    else {
      const nonNull = choices.options.filter(
        (option) => !option.types.includes("null"),
      );
      if (
        nonNull.length &&
        nonNull.every(
          (option) =>
            own(option.schema, "const") || Array.isArray(option.schema.enum),
        )
      ) {
        result.enum = [
          ...new Set(
            nonNull.flatMap((option) =>
              own(option.schema, "const")
                ? [option.schema.const]
                : option.schema.enum,
            ),
          ),
        ];
        result.type = [...new Set(result.enum.map(typeOf))];
        if (result.type.length === 1) result.type = result.type[0];
      }
      const tagged = nonNull.filter((option) => option.discriminator);
      if (tagged.length === nonNull.length && tagged.length) {
        const key = tagged[0].discriminator!.key;
        result.type = "object";
        result.properties = {
          ...result.properties,
          [key]: {
            type: typeOf(tagged[0].discriminator!.value),
            enum: tagged.map((option) => option.discriminator!.value),
            _metadata: tagged[0].schema.properties?.[key]?._metadata,
          },
        };
        result.required = [...new Set([...(result.required || []), key])];
      }
    }
    result["x-vectory-choice"] = choices;
  }
  if (!result.type && result.properties) result.type = "object";
  if (!result.type && (result.items || result.prefixItems))
    result.type = "array";
  return result;
}
/** Presentation schema for a configured field whose conditional definition is inactive.
 * Values and annotations survive; inactive validation rules do not. */
export function preservedFieldSchema(
  schema: Schema,
  root: Schema,
  value: any,
): Schema {
  const displayMetadata = new Set([
    "docs::human_name",
    "vectory::label",
    "vectory::entry_label",
    "docs::type_unit",
    "docs::syntax_override",
    "docs::type_override",
    "docs::templateable",
    "sensitive",
  ]);
  // Sensitivity applies across nullable/untagged alternatives even when the
  // current opaque value does not match a formerly active branch.
  function sensitive(input: any, seen = new Set<any>(), depth = 0): boolean {
    if (!record(input) || seen.has(input) || depth > 30) return false;
    seen.add(input);
    if (input._metadata?.sensitive === true) return true;
    if (input.$ref && sensitive(reference(input.$ref, root), seen, depth + 1))
      return true;
    return ["allOf", "oneOf", "anyOf"].some(
      (key) =>
        Array.isArray(input[key]) &&
        input[key].some((child: any) => sensitive(child, seen, depth + 1)),
    );
  }
  let count = 0;
  const ancestors = new Set<any>();
  function preserve(
    input: any,
    current: any,
    inheritedSensitive = false,
    depth = 0,
  ): Schema {
    const resolved = resolveSchema(record(input) ? input : {}, root, current);
    const metadata = Object.fromEntries(
      Object.entries(resolved._metadata || {}).filter(([key]) =>
        displayMetadata.has(key),
      ),
    );
    const isSensitive =
      inheritedSensitive || sensitive(input) || metadata.sensitive === true;
    if (isSensitive) metadata.sensitive = true;
    const output: Schema = {
      "x-vectory-preserved": true,
      ...(resolved.readOnly === true ? { readOnly: true } : {}),
      ...(typeof resolved.title === "string" ? { title: resolved.title } : {}),
      ...(typeof resolved.description === "string"
        ? { description: resolved.description }
        : {}),
      ...(Object.keys(metadata).length ? { _metadata: metadata } : {}),
      ...(current !== undefined ? { type: typeOf(current) } : {}),
    };
    if (!record(current) && !Array.isArray(current)) return output;
    const children = Object.keys(current).length;
    if (++count + children > 4096 || depth >= 24 || ancestors.has(current)) {
      // A bounded fallback must not turn undiscovered nested credentials into
      // unrestricted plaintext fields. The original value remains untouched.
      return {
        ...output,
        _metadata: { ...metadata, sensitive: true },
        "x-vectory-preserved-truncated": true,
      };
    }
    count += children;
    ancestors.add(current);
    if (Array.isArray(current)) {
      output.items = current.map((child, index) =>
        preserve(
          arrayItemSchema(resolved, index) ?? {},
          child,
          isSensitive,
          depth + 1,
        ),
      );
      output.additionalItems = {};
    } else {
      output.properties = Object.fromEntries(
        Object.entries(current).map(([key, child]) => [
          key,
          preserve(
            mapValueSchema(resolved, key),
            child,
            isSensitive,
            depth + 1,
          ),
        ]),
      );
    }
    ancestors.delete(current);
    return output;
  }
  return preserve(schema, value);
}

export function fieldTitle(name: string, schema: Schema): string {
  return (
    schema._metadata?.["docs::human_name"] ||
    name
      .replaceAll("_", " ")
      .replace(/^./, (character) => character.toUpperCase())
  );
}
export function schemaDescription(value?: string): string | undefined {
  return value
    ?.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export type FieldIntent = {
  kind:
    | "text"
    | "uri"
    | "path"
    | "template"
    | "vrl"
    | "regex"
    | "duration"
    | "bytes"
    | "timezone"
    | "secret"
    | "type-tag";
  source: string;
  unit?: string;
};
export type FieldModel = {
  schema: Schema;
  title: string;
  description?: string;
  types: string[];
  nullable: boolean;
  required: boolean;
  present: boolean;
  hasDefault: boolean;
  defaultValue?: any;
  defaultUsable: boolean;
  defaultNote?: string;
  examples: any[];
  choices: SchemaChoiceSet | null;
  intent: FieldIntent;
  constraints: Schema;
  sensitive: boolean;
  readOnly: boolean;
  deprecated: boolean;
};
const constraintKeys = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "patternProperties",
  "additionalProperties",
  "unevaluatedProperties",
  "contains",
  "minContains",
  "maxContains",
];
export function fieldModel(
  name: string,
  schema: Schema,
  root: Schema,
  value?: any,
  options: { required?: boolean; present?: boolean; path?: string } = {},
): FieldModel {
  const resolved = resolveSchema(schema, root, value),
    expanded = expand(schema, root, value),
    choices = choiceSet(expanded, root, value);
  const types = [
    ...new Set(
      choices
        ? choices.options.flatMap((option) => option.types)
        : typesOf(resolved),
    ),
  ];
  const metadata = resolved._metadata || {},
    lower = name.toLowerCase(),
    description = schemaDescription(resolved.description || resolved.title);
  const credentialPath = /(?:^|\.)auth\.(?:user|username|value)$/.test(
    options.path || "",
  );
  const resourcePath = /(?:_file|_path|_dir|_directory)$/.test(lower);
  const sensitive =
    !!metadata.sensitive ||
    credentialPath ||
    (!resourcePath &&
      /(?:^|_)(password|token|secret|api_key|access_key|private_key|connection_string)(?:$|_)/.test(
        lower,
      ));
  const syntax = metadata["docs::syntax_override"],
    unit = metadata["docs::type_unit"];
  let intent: FieldIntent = { kind: "text", source: "plain JSON value" };
  if (sensitive)
    intent = {
      kind: "secret",
      source: metadata.sensitive
        ? "Vector sensitive metadata"
        : "credential field name",
    };
  else if (
    syntax === "vrl_program" ||
    syntax === "vrl" ||
    metadata["docs::type_override"] === "condition"
  )
    intent = { kind: "vrl", source: "Vector syntax metadata" };
  else if (metadata["docs::templateable"] || syntax === "strftime")
    intent = { kind: "template", source: "Vector template metadata" };
  else if (unit === "bytes")
    intent = { kind: "bytes", source: "Vector unit metadata", unit };
  else if (
    typeof unit === "string" &&
    /^(nano|micro|milli)?seconds$|^minutes$|^hours$/.test(unit)
  )
    intent = { kind: "duration", source: "Vector unit metadata", unit };
  else if (resolved.format === "uri" || resolved.format === "uri-reference")
    intent = { kind: "uri", source: "JSON Schema format" };
  else if (/^(url|uri|endpoint|dsn)$/.test(lower))
    intent = { kind: "uri", source: "resource field name" };
  else if (
    resolved["x-vectory-native-path"] ||
    /^(path|file|files|directory|data_dir)$|_(path|file|dir)$/.test(lower)
  )
    intent = { kind: "path", source: "resource field name" };
  else if (/regex|pattern/.test(lower) && types.includes("string"))
    intent = {
      kind: "regex",
      source: "pattern field name; native syntax is validated by Vector",
    };
  else if (lower === "timezone" || lower === "time_zone")
    intent = { kind: "timezone", source: "timezone field name" };
  else if (
    own(resolved, "const") ||
    (resolved.enum &&
      ["type", "codec", "strategy", "method", "mode"].includes(lower))
  )
    intent = { kind: "type-tag", source: "schema discriminator or enum" };
  const examples =
    resolved.examples ??
    metadata["docs::examples"] ??
    metadata["docs::example"];
  return {
    schema: resolved,
    title: fieldTitle(name, expanded),
    description,
    types,
    nullable: types.includes("null"),
    required: !!options.required,
    present: options.present ?? value !== undefined,
    hasDefault: own(expanded, "default"),
    defaultUsable: usableDefault(expanded, root),
    ...(usableDefault(expanded, root)
      ? { defaultValue: expanded.default }
      : {}),
    ...(own(expanded, "default") && !usableDefault(expanded, root)
      ? {
          defaultNote:
            "Vector supplies this default when omitted; the browser cannot safely materialize it.",
        }
      : {}),
    examples:
      examples === undefined
        ? []
        : Array.isArray(examples)
          ? examples
          : [examples],
    choices,
    intent,
    constraints: Object.fromEntries(
      constraintKeys
        .filter((key) => own(resolved, key))
        .map((key) => [key, resolved[key]]),
    ),
    sensitive,
    readOnly: !!resolved.readOnly,
    deprecated:
      !!resolved.deprecated ||
      !!metadata.deprecated ||
      !!metadata.deprecated_message,
  };
}
export function initialFieldValue(schema: Schema, root: Schema): any {
  const expanded = expand(schema, root, undefined);
  if (usableDefault(expanded, root)) return structuredClone(expanded.default);
  if (choiceSet(expanded, root, undefined)) return undefined;
  return seed(resolveSchema(schema, root), root);
}
/** Starter for an explicit Add action; imported null and omitted defaults use the ordinary initializer. */
export function initialEditableFieldValue(
  schema: Schema,
  root: Schema,
  depth = 0,
): any {
  if (depth > 12) return undefined;
  const expanded = expand(schema, root, undefined);
  if (usableDefault(expanded, root) && expanded.default !== null)
    return structuredClone(expanded.default);
  const choices = choiceSet(expanded, root, undefined);
  if (choices) {
    const nonNull = choices.options.filter((option) =>
      option.types.some((type) => type !== "null"),
    );
    return nonNull.length === 1
      ? initialEditableFieldValue(nonNull[0].schema, root, depth + 1)
      : undefined;
  }
  const value = seed(resolveSchema(schema, root), root);
  return value === null ? undefined : value;
}
/** All fields declared by an object's alternatives, excluding fields inside child objects. */
export function schemaPropertyKeys(
  schema: Schema,
  root: Schema,
  depth = 0,
): string[] {
  if (depth > 20) return [];
  const keys = new Set(
    Object.keys(resolveSchema(schema, root).properties || {}),
  );
  const choices = schemaChoices(schema, root);
  for (const option of choices?.options || [])
    for (const key of schemaPropertyKeys(option.schema, root, depth + 1))
      keys.add(key);
  return [...keys];
}

export function setSchemaProperty(
  value: Schema,
  schema: Schema,
  root: Schema,
  name: string,
  next: any,
): Schema {
  const result = { ...value, [name]: next };
  const activeTag = (
    input: Schema,
    current: Schema,
    depth = 0,
  ): SchemaChoice | undefined => {
    if (depth > 12) return undefined;
    const choices = schemaChoices(input, root, current),
      selected = choices?.options.find(
        (option) => option.id === choices.selectedId,
      );
    if (!selected) return undefined;
    if (selected.discriminator?.key === name) return selected;
    return activeTag(selected.schema, current, depth + 1);
  };
  const previous = activeTag(schema, value),
    selected = activeTag(schema, result);
  // The renderer caches inactive branch drafts. Remove only prior known fields
  // after an explicit valid discriminator switch, never on an ordinary edit.
  if (
    previous?.discriminator?.key === name &&
    selected?.discriminator?.key === name &&
    previous.id !== selected.id
  )
    for (const key of Object.keys(
      resolveSchema(previous.schema, root, value).properties || {},
    ))
      if (!own(resolveSchema(selected.schema, root, result).properties, key))
        delete result[key];
  return result;
}
export function arrayItemSchema(schema: Schema, index: number): any {
  if (Array.isArray(schema.prefixItems))
    return schema.prefixItems[index] ?? schema.items;
  if (Array.isArray(schema.items))
    return schema.items[index] ?? schema.additionalItems;
  return schema.items;
}
export function mapValueSchema(schema: Schema, key: string): Schema {
  const branches: Schema[] = [];
  if (own(schema.properties, key)) branches.push(schema.properties[key]);
  for (const [pattern, child] of Object.entries(
    schema.patternProperties || {},
  )) {
    try {
      if (new RegExp(pattern, "u").test(key)) branches.push(child as Schema);
    } catch {
      /* unsupported patterns remain opaque */
    }
  }
  if (!branches.length)
    return schema.additionalProperties === false
      ? { not: {} }
      : record(schema.additionalProperties)
        ? schema.additionalProperties
        : {};
  return branches.length === 1 ? branches[0] : { allOf: branches };
}

/** Check JSON constraints only; native VRL, regex, templates and resources stay native checks. */
export function validateFieldValue(
  value: any,
  schema: Schema,
  root: Schema,
  path = "Value",
  depth = 0,
): string[] {
  if (value === undefined || depth > 24) return [];
  // Preserved schemas describe controls, not native validation rules. Inactive
  // values may change shape or reorder mixed arrays; credential checks remain
  // separate in the scalar and raw-JSON controls.
  if (schema["x-vectory-preserved"] === true) return [];
  const resolved = resolveSchema(schema, root, value),
    types = typesOf(resolved),
    issues: string[] = [];
  const add = (message: string) => issues.push(`${path}: ${message}`);
  if (types.length && !types.some((type) => fitsType(value, type)))
    add(`expected ${types.join(" or ")}.`);
  if (
    typeof value === "number" &&
    types.includes("integer") &&
    !Number.isSafeInteger(value)
  )
    add(
      "integer exceeds the browser's exact range; do not round or convert it silently.",
    );
  if (own(resolved, "const") && !equal(value, resolved.const))
    add("does not match the required constant.");
  if (
    resolved.enum &&
    !resolved.enum.some((option: any) => equal(option, value))
  )
    add("choose an allowed value.");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) add("must be a finite number.");
    for (const [key, invalid, wording] of [
      ["minimum", value < resolved.minimum, "at least"],
      ["maximum", value > resolved.maximum, "at most"],
      ["exclusiveMinimum", value <= resolved.exclusiveMinimum, "greater than"],
      ["exclusiveMaximum", value >= resolved.exclusiveMaximum, "less than"],
    ] as const)
      if (typeof resolved[key] === "number" && invalid)
        add(`must be ${wording} ${resolved[key]}.`);
    if (
      resolved.multipleOf > 0 &&
      matches({ multipleOf: resolved.multipleOf }, root, value) === false
    )
      add(`must be a multiple of ${resolved.multipleOf}.`);
  }
  if (typeof value === "string") {
    if (
      resolved.minLength !== undefined &&
      [...value].length < resolved.minLength
    )
      add(`must contain at least ${resolved.minLength} characters.`);
    if (
      resolved.maxLength !== undefined &&
      [...value].length > resolved.maxLength
    )
      add(`must contain at most ${resolved.maxLength} characters.`);
    if (
      resolved.pattern &&
      matches({ pattern: resolved.pattern }, root, value) === false
    )
      add("does not match the field's JSON Schema pattern.");
  }
  const union = schemaChoices(schema, root, value);
  if (union && union.options.every((option) => option.matches === false))
    add("does not match any available configuration shape.");
  if (
    union?.kind === "oneOf" &&
    expand(schema, root, value)._metadata?.["docs::enum_tagging"] !==
      "untagged" &&
    union.options.filter((option) => option.matches === true).length > 1
  )
    add("matches multiple exclusive configuration shapes.");
  if (Array.isArray(value)) {
    if (resolved.minItems !== undefined && value.length < resolved.minItems)
      add(`needs at least ${resolved.minItems} items.`);
    if (resolved.maxItems !== undefined && value.length > resolved.maxItems)
      add(`allows at most ${resolved.maxItems} items.`);
    if (
      resolved.uniqueItems &&
      value.some((item, i) =>
        value.slice(0, i).some((other) => equal(item, other)),
      )
    )
      add("items must be unique.");
    value.forEach((item, index) => {
      const child = arrayItemSchema(resolved, index);
      if (child === false) add(`item ${index + 1} is not allowed.`);
      else if (record(child))
        issues.push(
          ...validateFieldValue(
            item,
            child,
            root,
            `${path}[${index}]`,
            depth + 1,
          ),
        );
    });
  }
  if (record(value)) {
    for (const key of resolved.required || [])
      if (!own(value, key))
        issues.push(`Enter ${path === "Value" ? key : `${path}.${key}`}.`);
    for (const [key, child] of Object.entries(value)) {
      const field = mapValueSchema(resolved, key);
      if (field.not && Object.keys(field.not).length === 0)
        add(`field ${key} is not allowed in this shape.`);
      else
        issues.push(
          ...validateFieldValue(
            child,
            field,
            root,
            `${path}.${key}`,
            depth + 1,
          ),
        );
      if (
        resolved.propertyNames &&
        matches(resolved.propertyNames, root, key) === false
      )
        add(`field name ${key} does not match the key constraints.`);
    }
    if (
      resolved.minProperties !== undefined &&
      Object.keys(value).length < resolved.minProperties
    )
      add(`needs at least ${resolved.minProperties} fields.`);
    if (
      resolved.maxProperties !== undefined &&
      Object.keys(value).length > resolved.maxProperties
    )
      add(`allows at most ${resolved.maxProperties} fields.`);
  }
  // Retain exact intersection/contains/not checks that a simplified field model
  // cannot express, without pretending to validate native expression languages.
  if (!issues.length && matches(schema, root, value) === false)
    add("does not satisfy the field's JSON Schema constraints.");
  return [...new Set(issues)].slice(0, 100);
}
export function requiredSchemaIssues(
  schema: Schema,
  root: Schema,
  value: any,
  path = "",
  depth = 0,
): string[] {
  if (depth > 20 || value === null || value === undefined) return [];
  const resolved = resolveSchema(schema, root, value),
    issues: string[] = [];
  for (const key of resolved.required || []) {
    if (["type", "inputs"].includes(key) && !path) continue;
    if (!own(value, key))
      issues.push(`Enter ${path ? `${path}.${key}` : key}.`);
  }
  if (record(value))
    for (const [key, child] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key,
        field = mapValueSchema(resolved, key);
      if (child === null) {
        if (matches(field, root, null) === false)
          issues.push(`${next} cannot be null.`);
      } else if (record(child) || Array.isArray(child))
        issues.push(
          ...requiredSchemaIssues(field, root, child, next, depth + 1),
        );
    }
  if (Array.isArray(value))
    value.forEach((child, i) => {
      const field = arrayItemSchema(resolved, i);
      if (record(field))
        issues.push(
          ...requiredSchemaIssues(
            field,
            root,
            child,
            `${path}[${i}]`,
            depth + 1,
          ),
        );
    });
  return [...new Set(issues)];
}
