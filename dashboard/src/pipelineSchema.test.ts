import { describe, expect, it } from "vitest";
import vectorSchema from "./generated/vector-schema.json";
import catalogData from "./generated/vector-catalog.json";
import { diagnoseJSONValue } from "./SchemaValueEditor";
import {
  arrayItemSchema,
  fieldModel,
  initialFieldValue,
  initialEditableFieldValue,
  mapValueSchema,
  requiredSchemaIssues,
  resolveSchema,
  preservedFieldSchema,
  schemaChoices,
  schemaPropertyKeys,
  setSchemaProperty,
  validateFieldValue,
  type Schema,
} from "./pipelineSchema";

const root: Schema = vectorSchema;
const ref = (name: string): Schema => ({ $ref: `#/definitions/${name}` });
const definition = (name: string, value?: any) =>
  resolveSchema(ref(name), root, value);
const component = (kind: string, type: string) => {
  const entry = catalogData.components.find(
    (item) => item.kind === kind && item.type === type,
  )!;
  return { $ref: entry.schema_ref };
};

describe("pinned Vector field semantics", () => {
  it("distinguishes shared Syslog settings from fields owned by several modes", () => {
    const choices = schemaChoices(component("sources", "syslog"), root, {
      type: "syslog",
      mode: "tcp",
      address: "127.0.0.1:5140",
      max_length: 2048,
    })!;
    expect(choices.sharedKeys).toEqual(
      expect.arrayContaining(["max_length", "host_key", "graph", "proxy"]),
    );
    expect(choices.sharedKeys).not.toContain("address");
    expect(choices.sharedKeys).not.toContain("mode");
    const tcp = choices.options.find(
      (option) => option.discriminator?.value === "tcp",
    )!;
    const udp = choices.options.find(
      (option) => option.discriminator?.value === "udp",
    )!;
    expect(tcp.schema.properties.address).toBeDefined();
    expect(udp.schema.properties.address).toBeDefined();
  });

  it("distinguishes omitted, explicit null, empty text and a default", () => {
    const schema = { type: ["string", "null"], default: null };
    const absent = fieldModel("label", schema, root, undefined);
    expect(absent).toMatchObject({
      present: false,
      nullable: true,
      hasDefault: true,
      defaultValue: null,
    });
    expect(fieldModel("label", schema, root, null).present).toBe(true);
    expect(validateFieldValue(null, schema, root)).toEqual([]);
    expect(validateFieldValue("", schema, root)).toEqual([]);
    expect(initialFieldValue(schema, root)).toBeNull();
    expect(
      schemaChoices(schema, root, null)?.options.find(
        (o) => o.types[0] === "string",
      )?.initialValue,
    ).toBe("");
    expect(
      requiredSchemaIssues(
        { properties: { label: schema }, required: ["label"] },
        root,
        {},
      ),
    ).toEqual(["Enter label."]);
    expect(
      requiredSchemaIssues(
        { properties: { label: schema }, required: ["label"] },
        root,
        { label: null },
      ),
    ).toEqual([]);
    expect(
      requiredSchemaIssues(
        { properties: { label: { type: "string" } }, required: ["label"] },
        root,
        { label: "" },
      ),
    ).toEqual([]);
  });

  it("keeps the actual condition's string and tagged object alternatives", () => {
    const schema = ref("vector::conditions::AnyCondition");
    const model = fieldModel("condition", schema, root, ".status == 200");
    expect(model.types).toEqual(expect.arrayContaining(["string", "object"]));
    expect(model.intent.kind).toBe("vrl");
    expect(model.choices?.options).toHaveLength(2);
    expect(initialFieldValue(schema, root)).toBeUndefined();
    const value = { type: "datadog_search", source: "service:web" };
    expect(resolveSchema(schema, root, value).properties.source).toBeDefined();
    expect(validateFieldValue(value, schema, root)).toEqual([]);
    expect(value).toEqual({ type: "datadog_search", source: "service:web" });
    expect(validateFieldValue(12, schema, root).length).toBeGreaterThan(0);
  });

  it("accepts native local timezone despite overlapping experimental untagged oneOf", () => {
    const schema = ref("vrl::compiler::datetime::TimeZone");
    expect(validateFieldValue("local", schema, root)).toEqual([]);
    expect(validateFieldValue("America/Edmonton", schema, root)).toEqual([]);
    expect(schemaChoices(schema, root, "local")?.selectedId).toBe("oneOf:0");
    const optional = ref(
      "core::option::Option<vrl::compiler::datetime::TimeZone>",
    );
    expect(fieldModel("timezone", optional, root, "local").types).toEqual(
      expect.arrayContaining(["null", "string"]),
    );
    expect(validateFieldValue("local", optional, root)).toEqual([]);
  });

  it("uses concise timezone choice labels while preserving option identities", () => {
    const optional = ref(
      "core::option::Option<vrl::compiler::datetime::TimeZone>",
    );
    const choices = schemaChoices(optional, root, null)!;
    expect(choices.options.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "oneOf:0", label: "Null" },
      { id: "oneOf:1", label: "Text" },
    ]);
    expect(choices.selectedId).toBe("oneOf:0");
    expect(
      schemaChoices(
        ref("vrl::compiler::datetime::TimeZone"),
        root,
        "local",
      )?.options.map(({ label }) => label),
    ).toEqual(["Local", "Named"]);
  });

  it("keeps the field title stable across nullable and named timezone variants", () => {
    const optional = ref(
      "core::option::Option<vrl::compiler::datetime::TimeZone>",
    );
    for (const value of [undefined, null, "local", "UTC"])
      expect(fieldModel("timezone", optional, root, value).title).toBe(
        "Timezone",
      );
    const titled = {
      ...optional,
      _metadata: { "docs::human_name": "Event timezone" },
    };
    expect(fieldModel("timezone", titled, root, "UTC").title).toBe(
      "Event timezone",
    );
    const region = definition("vector::aws::region::RegionOrEndpoint")
      .properties.region;
    expect(fieldModel("aws_region", region, root, "us-east-1").title).toBe(
      "Region",
    );
  });

  it("starts an explicitly added optional value without changing null defaults or choosing ambiguous branches", () => {
    const region = definition("vector::aws::region::RegionOrEndpoint")
      .properties.region;
    expect(initialEditableFieldValue(region, root)).toBe("");
    const withNullDefault = { ...region, default: null };
    expect(initialEditableFieldValue(withNullDefault, root)).toBe("");
    expect(initialFieldValue(withNullDefault, root)).toBeNull();
    expect(fieldModel("region", withNullDefault, root, null).present).toBe(
      true,
    );
    expect(
      initialEditableFieldValue(
        { type: ["object", "null"], default: null },
        root,
      ),
    ).toEqual({});
    expect(
      initialEditableFieldValue(
        { type: ["array", "null"], default: null },
        root,
      ),
    ).toEqual([]);
    expect(
      initialEditableFieldValue(
        { type: ["string", "object", "null"], default: null },
        root,
      ),
    ).toBeUndefined();
    expect(
      initialEditableFieldValue(
        ref("core::option::Option<vrl::compiler::datetime::TimeZone>"),
        root,
      ),
    ).toBeUndefined();
    expect(
      initialEditableFieldValue(
        { type: ["string", "null"], default: "us-east-1" },
        root,
      ),
    ).toBe("us-east-1");
  });

  it("does not materialize unsafe upstream request defaults", () => {
    const http = resolveSchema(component("sinks", "http"), root, {});
    const request = http.properties.request;
    expect(request.default.retry_attempts).toBeGreaterThan(
      Number.MAX_SAFE_INTEGER,
    );
    expect(initialFieldValue(request, root)).toEqual({});
    const fields = resolveSchema(request, root, {}).properties;
    expect(initialFieldValue(fields.retry_attempts, root)).toBeUndefined();
    expect(
      validateFieldValue({ headers: { Accept: "text/plain" } }, request, root),
    ).toEqual([]);
    expect(
      validateFieldValue(
        Number.MAX_SAFE_INTEGER + 1,
        fields.retry_attempts,
        root,
      ).join(" "),
    ).toContain("exact range");
  });

  it("keeps duration units, typed header values, template and secret metadata", () => {
    const request = definition("vector::sinks::util::http::RequestConfig", {});
    expect(
      fieldModel("timeout_secs", request.properties.timeout_secs, root).intent,
    ).toMatchObject({
      kind: "duration",
      unit: "seconds",
      source: "Vector unit metadata",
    });
    const headers = resolveSchema(request.properties.headers, root, {});
    expect(
      validateFieldValue({ "X-Count": 12 }, headers, root).length,
    ).toBeGreaterThan(0);
    expect(
      validateFieldValue({ "X-Event": "{{ message }}" }, headers, root),
    ).toEqual([]);
    const auth = definition("vector::http::Auth", { strategy: "bearer" });
    expect(fieldModel("token", auth.properties.token, root).sensitive).toBe(
      true,
    );
    expect(
      validateFieldValue("SECRET[host.token]", auth.properties.token, root),
    ).toEqual([]);
    const remap = definition("vector::transforms::remap::RemapConfig", {});
    expect(
      fieldModel("source", remap.properties.source, root).intent.kind,
    ).toBe("vrl");
    // Native languages are not validated as JavaScript syntax.
    expect(
      validateFieldValue(
        ". = parse_json!(.message)",
        remap.properties.source,
        root,
      ),
    ).toEqual([]);
  });

  it("switches actual nested Buffer storage modes without carrying inactive limits", () => {
    const sink = resolveSchema(component("sinks", "console"), root, {
      type: "console",
    });
    const schema = sink.properties.buffer;
    expect(schemaPropertyKeys(schema, root)).toEqual(
      expect.arrayContaining(["type", "when_full", "max_events", "max_size"]),
    );
    const memory = {
      type: "memory",
      max_events: 321,
      when_full: "overflow",
      custom_extension: { kept: true },
    };
    const disk = setSchemaProperty(memory, schema, root, "type", "disk");
    expect(disk).toEqual({
      type: "disk",
      when_full: "overflow",
      custom_extension: { kept: true },
    });
    expect(memory.max_events).toBe(321);
    const restored = setSchemaProperty(
      { ...disk, max_size: 536870912 },
      schema,
      root,
      "type",
      "memory",
    );
    expect(restored.max_size).toBe(536870912); // Also a legal memory size alternative.
    expect(restored.when_full).toBe("overflow");
    expect(
      setSchemaProperty(memory, schema, root, "when_full", "block").max_events,
    ).toBe(321);
  });
  it("preserves ordered buffer alternatives and their per-item constraints", () => {
    const sink = resolveSchema(component("sinks", "aws_s3"), root, {});
    const value = [
      { type: "memory", max_events: 500 },
      { type: "disk", max_size: 268435488 },
    ];
    const before = structuredClone(value);
    const schema = resolveSchema(sink.properties.buffer, root, value);
    expect(schema.type).toBe("array");
    expect(
      resolveSchema(arrayItemSchema(schema, 1), root, value[1]).properties
        .max_size,
    ).toBeDefined();
    expect(validateFieldValue(value, sink.properties.buffer, root)).toEqual([]);
    expect(value).toEqual(before);
  });

  it("removes only inactive known auth fields on explicit variant changes", () => {
    const schema = ref("vector::http::Auth");
    const input = {
      strategy: "basic",
      user: "SECRET[host.user]",
      password: "SECRET[host.password]",
      opaque_extension: { version: 2 },
    };
    const next = setSchemaProperty(input, schema, root, "strategy", "bearer");
    expect(next).toEqual({
      strategy: "bearer",
      opaque_extension: { version: 2 },
    });
    expect(
      setSchemaProperty(
        input,
        ref("core::option::Option<vector::http::Auth>"),
        root,
        "strategy",
        "bearer",
      ),
    ).toEqual(next);
    expect(input.password).toBe("SECRET[host.password]");
    expect(
      setSchemaProperty(input, schema, root, "user", "SECRET[host.other]")
        .password,
    ).toBe(input.password);
    expect(
      setSchemaProperty(input, schema, root, "strategy", "future").password,
    ).toBe(input.password);
  });

  it("models every published component without requiring optional subtrees", () => {
    let fields = 0;
    for (const entry of catalogData.components) {
      const schema = resolveSchema({ $ref: entry.schema_ref }, root, {});
      expect(schema.properties.type.const, `${entry.kind}/${entry.type}`).toBe(
        entry.type,
      );
      for (const [name, child] of Object.entries(schema.properties)) {
        const model = fieldModel(name, child as Schema, root, undefined, {
          required: schema.required?.includes(name),
        });
        expect(model.title, `${entry.type}.${name}`).toBeTruthy();
        expect(model.present).toBe(false);
        fields++;
      }
    }
    expect(catalogData.components).toHaveLength(128);
    expect(fields).toBeGreaterThan(1500);
  });

  it("resolves every pinned schema node without mutating upstream metadata", () => {
    const before = JSON.stringify(root),
      seen = new Set<object>();
    let count = 0;
    const visit = (schema: any, name: string) => {
      if (!schema || typeof schema !== "object" || seen.has(schema)) return;
      seen.add(schema);
      count++;
      expect(() => fieldModel(name, schema, root)).not.toThrow();
      for (const group of [
        "properties",
        "patternProperties",
        "dependentSchemas",
        "definitions",
        "$defs",
      ])
        for (const [name, child] of Object.entries(schema[group] || {}))
          visit(child, name);
      for (const key of ["allOf", "oneOf", "anyOf", "prefixItems"])
        for (const child of schema[key] || []) visit(child, name);
      for (const key of [
        "items",
        "additionalProperties",
        "propertyNames",
        "contains",
        "if",
        "then",
        "else",
        "not",
      ])
        if (Array.isArray(schema[key]))
          schema[key].forEach((child: any) => visit(child, name));
        else visit(schema[key], name);
    };
    visit(root, "configuration");
    expect(count).toBeGreaterThan(6000);
    expect(JSON.stringify(root)).toBe(before);
  });

  it("exposes every pinned Unix socket branch while retaining TCP requirements", () => {
    for (const [kind, type, mode, optional] of [
      ["sources", "socket", "unix_datagram", "socket_file_mode"],
      ["sources", "socket", "unix_stream", "socket_file_mode"],
      ["sources", "syslog", "unix", "socket_file_mode"],
      ["sources", "fluent", "unix", "socket_file_mode"],
      ["sources", "statsd", "unix", "convert_to"],
      ["sinks", "statsd", "unix", "unix_mode"],
    ]) {
      const schema = component(kind, type);
      const value = {
        type,
        mode,
        path: "/run/vector.sock",
        ...(kind === "sinks" ? { inputs: ["metrics"] } : {}),
      };
      const resolved = resolveSchema(schema, root, value);
      expect(resolved.properties.mode.const, `${kind}/${type}/${mode}`).toBe(
        mode,
      );
      expect(resolved.properties.path).toBeDefined();
      expect(resolved.properties[optional]).toBeDefined();
      expect(resolved.properties.address).toBeUndefined();
      expect(validateFieldValue(value, schema, root)).toEqual([]);
      expect(requiredSchemaIssues(schema, root, { type, mode })).toContain(
        "Enter path.",
      );
      expect(
        requiredSchemaIssues(schema, root, { type, mode: "tcp" }),
      ).toContain("Enter address.");
      expect(
        resolveSchema(schema, root, { type, mode: "tcp" }).properties.path,
      ).toBeUndefined();
    }
    const statsd = resolveSchema(component("sinks", "statsd"), root, {
      mode: "unix",
    });
    expect(statsd.properties.unix_mode.enum).toEqual(["Datagram", "Stream"]);
  });
});

describe("lossless JSON schema shape and constraint model", () => {
  it("uses short metadata or type labels instead of unfamiliar documentation sentences", () => {
    const schema = {
      anyOf: [
        {
          type: "object",
          title:
            "Configuration describing how this unfamiliar branch processes events.",
        },
        {
          type: "string",
          title: "A string value.",
          _metadata: {
            "docs::human_name":
              "This documentation sentence should never become an option label.",
          },
        },
        { type: "array", title: "Ordered items" },
        { type: "null" },
        { type: "boolean", _metadata: { "docs::human_name": "Enabled flag" } },
      ],
    };
    const before = structuredClone(schema),
      choices = schemaChoices(schema, {}, undefined)!;
    expect(choices.options.map(({ label }) => label)).toEqual([
      "Object",
      "Text",
      "Ordered items",
      "Null",
      "Enabled flag",
    ]);
    expect(choices.options.map(({ id }) => id)).toEqual([
      "anyOf:0",
      "anyOf:1",
      "anyOf:2",
      "anyOf:3",
      "anyOf:4",
    ]);
    expect(choices.selectedId).toBeNull();
    expect(schema).toEqual(before);
  });
  it("does not choose the first equally compatible untagged object", () => {
    const schema = {
      anyOf: [
        { type: "object", properties: { value: { type: "string" } } },
        { type: "object", properties: { value: { type: "number" } } },
      ],
    };
    expect(schemaChoices(schema, {}, {})?.selectedId).toBeNull();
    expect(schemaChoices(schema, {}, {})?.ambiguous).toBe(true);
    expect(initialFieldValue(schema, {})).toBeUndefined();
    expect(schemaChoices(schema, {}, { value: 4 })?.selectedId).toBe("anyOf:1");
  });

  it("includes shared required fields in every selected alternative", () => {
    const schema = {
      allOf: [
        {
          type: "object",
          properties: { shared: { type: "boolean" } },
          required: ["shared"],
        },
        {
          oneOf: [
            {
              properties: { kind: { const: "a" }, alpha: { type: "string" } },
              required: ["kind", "alpha"],
            },
            {
              properties: { kind: { const: "b" }, beta: { type: "number" } },
              required: ["kind", "beta"],
            },
          ],
        },
      ],
    };
    const options = schemaChoices(schema, {}, { kind: "b", shared: true })!;
    const selected = options.options.find((o) => o.id === options.selectedId)!;
    expect(selected.schema.properties.shared).toEqual({ type: "boolean" });
    expect(selected.schema.required).toEqual(
      expect.arrayContaining(["shared", "kind", "beta"]),
    );
    expect(
      requiredSchemaIssues(schema, {}, { kind: "b", shared: true }),
    ).toEqual(["Enter beta."]);
  });

  it("follows numeric and referenced conditions, else and present-field dependencies", () => {
    const root = { definitions: { threshold: { type: "number", minimum: 5 } } };
    const schema = {
      type: "object",
      properties: { amount: { type: "number" }, enabled: { type: "boolean" } },
      if: {
        required: ["amount"],
        properties: { amount: { $ref: "#/definitions/threshold" } },
      },
      then: { required: ["large"] },
      else: { required: ["small"] },
      dependentRequired: { enabled: ["reason"] },
      dependentSchemas: {
        enabled: { properties: { reason: { minLength: 3, type: "string" } } },
      },
    };
    expect(requiredSchemaIssues(schema, root, { amount: 6 })).toEqual([
      "Enter large.",
    ]);
    expect(requiredSchemaIssues(schema, root, { amount: 2 })).toEqual([
      "Enter small.",
    ]);
    expect(
      requiredSchemaIssues(schema, root, {
        amount: 6,
        large: true,
        enabled: false,
      }),
    ).toEqual(["Enter reason."]);
    expect(
      validateFieldValue(
        { amount: 6, large: true, enabled: false, reason: "x" },
        schema,
        root,
      ).join(" "),
    ).toContain("at least 3");
  });

  it("explains all six pinned conditional requirements from their actual selector values", () => {
    const dnstap = component("sources", "dnstap");
    for (const [mode, key] of [
      ["tcp", "address"],
      ["unix", "socket_path"],
    ]) {
      const active = resolveSchema(dnstap, root, { type: "dnstap", mode });
      expect(active.required).toContain(key);
      expect(active["x-vectory-required-reasons"][key]).toEqual([
        `Required when Mode is "${mode}".`,
      ]);
    }
    const fd = resolveSchema(component("sources", "file_descriptor"), root, {
      type: "file_descriptor",
    });
    for (const [field, selector, values] of [
      ["decoding", "codec", ["avro", "vrl"]],
      ["framing", "method", ["character_delimited", "length_delimited"]],
    ] as const) {
      for (const value of values) {
        const active = resolveSchema(fd.properties[field], root, {
          [selector]: value,
        });
        expect(active.required).toContain(value);
        expect(active["x-vectory-required-reasons"][value][0]).toContain(
          JSON.stringify(value),
        );
      }
    }
  });

  it("handles boolean conditions and boolean branches, while absent selectors follow JSON Schema rules", () => {
    expect(
      resolveSchema(
        {
          if: false,
          then: { required: ["wrong"] },
          else: { required: ["fallback"] },
        },
        {},
        {},
      ).required,
    ).toEqual(["fallback"]);
    expect(validateFieldValue({}, { if: true, then: false }, {})).not.toEqual(
      [],
    );
    expect(validateFieldValue({}, { if: false, else: false }, {})).not.toEqual(
      [],
    );
    const schema = {
      if: { properties: { mode: { const: "active" } } },
      then: { required: ["defaultBranch"] },
      else: { required: ["otherBranch"] },
    };
    // properties alone does not require mode; omission deliberately matches then.
    expect(resolveSchema(schema, {}, {}).required).toEqual(["defaultBranch"]);
    expect(resolveSchema(schema, {}, { mode: "inactive" }).required).toEqual([
      "otherBranch",
    ]);
    expect(
      resolveSchema(
        { ...schema, if: { ...schema.if, required: ["mode"] } },
        {},
        {},
      ).required,
    ).toEqual(["otherBranch"]);
    expect(
      resolveSchema(
        { then: { required: ["orphan"] }, else: { required: ["orphan"] } },
        {},
        {},
      ).required,
    ).toBeUndefined();
  });

  it("leaves unsupported or unresolved conditions pending without falsely requiring or hiding a branch", () => {
    for (const condition of [
      { $ref: "#/missing" },
      { properties: { mode: { format: "unimplemented-format" } } },
      { unsupportedAssertion: true },
    ]) {
      const schema = {
        type: "object",
        properties: { mode: { type: "string" } },
        if: condition,
        then: {
          properties: { alpha: { type: "integer" } },
          required: ["alpha"],
        },
        else: { properties: { beta: { type: "boolean" } }, required: ["beta"] },
      };
      const value = {
        mode: "opaque",
        alpha: "allowed until the condition is known",
        retained: [null, false],
      };
      const before = structuredClone(value),
        original = structuredClone(schema);
      const resolved = resolveSchema(schema, {}, value);
      expect(resolved["x-vectory-condition-pending"]).toBe(true);
      expect(resolved.required || []).toEqual([]);
      expect(Object.keys(resolved.properties)).toEqual(
        expect.arrayContaining(["alpha", "beta", "mode"]),
      );
      expect(validateFieldValue(value, schema, {})).toEqual([]);
      expect(value).toEqual(before);
      expect(schema).toEqual(original);
    }
    // A known failing conjunct can disprove a condition despite unknown assertions.
    expect(
      resolveSchema(
        {
          if: { type: "array", unknownRule: true },
          else: { required: ["fallback"] },
        },
        {},
        {},
      ).required,
    ).toEqual(["fallback"]);
  });

  it("intersects same-trigger dependencies and removes only their requirements when the trigger is removed", () => {
    const schema = {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          _metadata: { "docs::human_name": "Feature" },
        },
      },
      allOf: [
        {
          dependentSchemas: {
            enabled: {
              properties: { endpoint: { type: "string" } },
              required: ["endpoint"],
            },
          },
        },
        {
          dependentSchemas: {
            enabled: {
              properties: { retries: { type: "integer", minimum: 1 } },
              required: ["retries"],
            },
          },
        },
        { dependencies: { enabled: ["legacy"] } },
        {
          dependencies: {
            enabled: {
              properties: { legacy: { type: "string" } },
              required: ["extra"],
            },
          },
        },
        { dependentRequired: { enabled: ["reason"] } },
      ],
    };
    const active = resolveSchema(schema, {}, { enabled: false });
    expect(active.required).toEqual(
      expect.arrayContaining([
        "endpoint",
        "retries",
        "legacy",
        "extra",
        "reason",
      ]),
    );
    expect(Object.keys(active.properties)).toEqual(
      expect.arrayContaining(["endpoint", "retries", "legacy"]),
    );
    expect(active["x-vectory-required-reasons"].reason).toContain(
      "Required when Feature is configured.",
    );
    const retained = {
      endpoint: "https://example.test",
      retries: "opaque after removal",
      legacy: null,
    };
    const before = structuredClone(retained);
    const inactive = resolveSchema(schema, {}, retained);
    expect(inactive.required || []).toEqual([]);
    expect(requiredSchemaIssues(schema, {}, retained)).toEqual([]);
    expect(validateFieldValue(retained, schema, {})).toEqual([]);
    expect(retained).toEqual(before);
  });

  it("never creates dependent values or guesses a legacy requires dialect", () => {
    const schema = {
      properties: { enabled: { type: "boolean" } },
      dependentRequired: { enabled: ["reason"] },
      dependentSchemas: {
        enabled: {
          properties: { reason: { type: "string", default: "not inserted" } },
        },
      },
    };
    for (const enabled of [false, null, 0]) {
      const value = { enabled };
      expect(resolveSchema(schema, {}, value).required).toContain("reason");
      expect(value).toEqual({ enabled });
    }
    const unknown = resolveSchema(
      { if: { requires: "legacy" }, then: { required: ["guess"] } },
      {},
      {},
    );
    expect(unknown["x-vectory-condition-pending"]).toBe(true);
    expect(unknown.required || []).toEqual([]);
  });

  it("supports false property-name and contains assertions inside conditions", () => {
    expect(
      resolveSchema(
        {
          if: { propertyNames: false },
          then: { required: ["empty"] },
          else: { required: ["hasFields"] },
        },
        {},
        { present: true },
      ).required,
    ).toEqual(["hasFields"]);
    expect(
      resolveSchema(
        {
          if: { contains: false },
          then: { title: "wrong" },
          else: { title: "correct" },
        },
        {},
        [1],
      ).title,
    ).toBe("correct");
  });

  it("preserves inactive nested annotations and sensitivity without applying old constraints", () => {
    const referenceRoot = {
      definitions: {
        credential: {
          title: "Access credential",
          description: "A local reference.",
          type: "string",
          minLength: 200,
          _metadata: { sensitive: true, "docs::human_name": "Credential" },
        },
        options: {
          title: "Options",
          description: "Original options help.",
          type: "object",
          required: ["count", "missing"],
          additionalProperties: false,
          properties: {
            count: { type: "integer", minimum: 10, default: 20 },
            nested: {
              type: "object",
              required: ["credential"],
              properties: { credential: { $ref: "#/definitions/credential" } },
            },
          },
        },
      },
    };
    const value = {
      count: "now opaque",
      nested: { credential: "${TOKEN}" },
      extra: [false, null, ""],
    };
    const before = structuredClone(value),
      rootBefore = structuredClone(referenceRoot);
    const preserved = preservedFieldSchema(
      { $ref: "#/definitions/options" },
      referenceRoot,
      value,
    );
    expect(preserved.title).toBe("Options");
    expect(preserved.description).toBe("Original options help.");
    expect(preserved.required).toBeUndefined();
    expect(preserved.additionalProperties).toBeUndefined();
    expect(preserved.properties.count).toEqual({
      type: "string",
      "x-vectory-preserved": true,
    });
    expect(
      preserved.properties.nested.properties.credential._metadata.sensitive,
    ).toBe(true);
    expect(preserved.properties.nested.properties.credential.description).toBe(
      "A local reference.",
    );
    expect(validateFieldValue(value, preserved, referenceRoot)).toEqual([]);
    expect(value).toEqual(before);
    expect(referenceRoot).toEqual(rootBefore);
  });

  it("preserves nullable inherited sensitivity and mixed array annotations by actual index", () => {
    const secret = {
      $ref: "#/definitions/core::option::Option<vector_common::sensitive_string::SensitiveString>",
    };
    expect(preservedFieldSchema(secret, root, null)._metadata.sensitive).toBe(
      true,
    );
    const schema = {
      type: "array",
      minItems: 20,
      maxItems: 1,
      uniqueItems: true,
      items: [secret, { type: "integer", minimum: 100 }],
      additionalItems: false,
    };
    const current = ["${TOKEN}", "no longer integer", null, false];
    const preserved = preservedFieldSchema(schema, root, current);
    expect(preserved.items.map((item: Schema) => item.type)).toEqual([
      "string",
      "string",
      "null",
      "boolean",
    ]);
    expect(preserved.items[0]._metadata.sensitive).toBe(true);
    expect(preserved.items[1].minimum).toBeUndefined();
    expect(validateFieldValue(current, preserved, root)).toEqual([]);
    expect(validateFieldValue([...current, {}], preserved, root)).toEqual([]);
    expect(validateFieldValue([...current].reverse(), preserved, root)).toEqual(
      [],
    );
    expect(validateFieldValue({ changed: "shape" }, preserved, root)).toEqual(
      [],
    );
  });

  it("retains inherited container sensitivity, prototype-like own keys, and bounds deep fallback", () => {
    const value = JSON.parse(
      '{"__proto__":{"credential":"${TOKEN}"},"constructor":false}',
    );
    const preserved = preservedFieldSchema(
      {
        type: "object",
        _metadata: {
          sensitive: true,
          "docs::required_when": "old rule",
          "docs::hidden": true,
        },
      },
      {},
      value,
    );
    expect(Object.hasOwn(preserved.properties, "__proto__")).toBe(true);
    expect(
      preserved.properties.__proto__.properties.credential._metadata.sensitive,
    ).toBe(true);
    expect(preserved._metadata["docs::required_when"]).toBeUndefined();
    expect(preserved._metadata["docs::hidden"]).toBeUndefined();
    let deep: any = "${TOKEN}";
    for (let index = 0; index < 35; index++) deep = { child: deep };
    let node = preservedFieldSchema({}, {}, deep),
      levels = 0;
    while (node.properties?.child) {
      node = node.properties.child;
      levels++;
    }
    expect(levels).toBe(24);
    expect(node["x-vectory-preserved-truncated"]).toBe(true);
    expect(node._metadata.sensitive).toBe(true);
  });

  it("keeps inactive presentation separate from credential, number-safety and read-only protection", () => {
    const input = {
      type: "object",
      properties: {
        access: { $ref: "#/definitions/secret" },
        locked: { type: "string", readOnly: true },
      },
    };
    const definitions = {
      definitions: {
        secret: { type: "string", _metadata: { sensitive: true } },
      },
    };
    const schema = preservedFieldSchema(input, definitions, {
      access: "${TOKEN}",
      locked: "original",
    });
    expect(schema.properties.locked.readOnly).toBe(true);
    expect(
      diagnoseJSONValue('{"access":"plaintext"}', {
        schema,
        root: definitions,
      }).diagnostics.some((issue) => /secret reference/i.test(issue.message)),
    ).toBe(true);
    expect(
      diagnoseJSONValue('{"access":"${TOKEN}","extra":9007199254740993}', {
        schema,
        root: definitions,
      }).parseValid,
    ).toBe(false);
    expect(
      diagnoseJSONValue('{"access":"${TOKEN}","extra":[null,false]}', {
        schema,
        root: definitions,
      }).diagnostics,
    ).toEqual([]);
    const broad = preservedFieldSchema(
      {},
      {},
      Array.from({ length: 5000 }, () => "opaque"),
    );
    expect(broad["x-vectory-preserved-truncated"]).toBe(true);
    expect(broad._metadata.sensitive).toBe(true);
  });

  it("keeps false schemas in uncertain branches and treats own undefined as present without assigning values", () => {
    const resolved = resolveSchema(
      {
        if: { unknownAssertion: true },
        then: { properties: { blocked: false } },
        else: { properties: { blocked: false } },
      },
      {},
      {},
    );
    expect(resolved.properties.blocked).toBe(false);
    expect(validateFieldValue({ blocked: true }, resolved, {})).not.toEqual([]);
    const partial = resolveSchema(
      {
        if: { unknownAssertion: true },
        then: { properties: { possible: false } },
      },
      {},
      {},
    );
    expect(partial.properties.possible.anyOf).toEqual([false, {}]);
    expect(validateFieldValue({ possible: true }, partial, {})).toEqual([]);
    const value = { enabled: undefined };
    const dependency = { dependentRequired: { enabled: ["reason"] } };
    expect(resolveSchema(dependency, {}, value).required).toEqual(["reason"]);
    expect(Object.hasOwn(value, "enabled")).toBe(true);
    expect(Object.hasOwn(value, "reason")).toBe(false);
    expect(
      resolveSchema(dependency, {}, JSON.parse(JSON.stringify(value))).required,
    ).toBeUndefined();
  });

  it("intersects nested allOf constraints without mutating source schemas", () => {
    const schema = {
      allOf: [
        { properties: { count: { type: "integer", minimum: 1 } } },
        { properties: { count: { maximum: 5 } } },
      ],
    };
    const before = structuredClone(schema);
    const count = resolveSchema(schema, {}, {}).properties.count;
    expect(validateFieldValue(4, count, {})).toEqual([]);
    expect(validateFieldValue(6, count, {}).length).toBeGreaterThan(0);
    expect(schema).toEqual(before);
  });

  it("validates patterned typed maps and key constraints without dropping opaque values", () => {
    const schema = {
      type: "object",
      patternProperties: { "^count_": { type: "integer", minimum: 0 } },
      additionalProperties: false,
      propertyNames: { maxLength: 14 },
    };
    expect(validateFieldValue({ count_total: 3 }, schema, {})).toEqual([]);
    expect(
      validateFieldValue({ count_total: "3" }, schema, {}).length,
    ).toBeGreaterThan(0);
    expect(validateFieldValue({ other: 3 }, schema, {}).length).toBeGreaterThan(
      0,
    );
    expect(mapValueSchema(schema, "count_total")).toEqual({
      type: "integer",
      minimum: 0,
    });
    const opaque = { known: "x", extension: { arbitrary: [1, null, false] } };
    expect(
      setSchemaProperty(
        opaque,
        { properties: { known: { type: "string" } } },
        {},
        "known",
        "y",
      ).extension,
    ).toEqual(opaque.extension);
  });

  it("keeps tuple order, rejects disallowed trailing items and duplicate values", () => {
    const schema = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: false,
      minItems: 2,
      uniqueItems: true,
    };
    expect(validateFieldValue(["sample", 2], schema, {})).toEqual([]);
    expect(
      validateFieldValue([2, "sample"], schema, {}).length,
    ).toBeGreaterThan(0);
    expect(
      validateFieldValue(["sample", 2, 3], schema, {}).join(" "),
    ).toContain("not allowed");
    expect(
      validateFieldValue(
        [{}, {}],
        { type: "array", uniqueItems: true },
        {},
      ).join(" "),
    ).toContain("unique");
  });

  it("handles recursive local references without infinite expansion", () => {
    const root = {
      definitions: {
        node: {
          type: "object",
          properties: {
            name: { type: "string" },
            child: { $ref: "#/definitions/node" },
          },
        },
      },
    };
    expect(
      validateFieldValue(
        { name: "a", child: { name: "b" } },
        ref("node"),
        root,
      ),
    ).toEqual([]);
    expect(
      validateFieldValue(
        { name: "a", child: { name: 2 } },
        ref("node"),
        root,
      ).join(" "),
    ).toContain("child.name");
    const recursive = {
      definitions: { cycle: { allOf: [{ $ref: "#/definitions/cycle" }] } },
    };
    expect(() => resolveSchema(ref("cycle"), recursive, {})).not.toThrow();
    expect(
      resolveSchema({ $ref: "#/definitions/missing" }, root)[
        "x-vectory-unresolved"
      ],
    ).toBe(true);
  });

  it("enforces native JSON numeric bounds and Unicode string lengths", () => {
    const number = {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 1,
      multipleOf: 0.1,
    };
    expect(validateFieldValue(0.3, number, {})).toEqual([]);
    expect(
      validateFieldValue(1_000_000_000.5, { type: "number", multipleOf: 1 }, {})
        .length,
    ).toBeGreaterThan(0);
    expect(validateFieldValue(0, number, {}).length).toBeGreaterThan(0);
    expect(validateFieldValue(0.35, number, {}).length).toBeGreaterThan(0);
    expect(validateFieldValue(Infinity, number, {}).length).toBeGreaterThan(0);
    expect(
      validateFieldValue(
        "😀",
        { type: "string", minLength: 1, maxLength: 1 },
        {},
      ),
    ).toEqual([]);
    expect(
      validateFieldValue("xx", { type: "string", maxLength: 1 }, {}).length,
    ).toBeGreaterThan(0);
  });

  it("retains exact contains, not, and intersection checks behind the field model", () => {
    expect(
      validateFieldValue([1, 2], { type: "array", contains: { const: 3 } }, {})
        .length,
    ).toBeGreaterThan(0);
    expect(
      validateFieldValue([1, 3], { type: "array", contains: { const: 3 } }, {}),
    ).toEqual([]);
    expect(
      validateFieldValue("forbidden", { not: { const: "forbidden" } }, {})
        .length,
    ).toBeGreaterThan(0);
    const closed = {
      allOf: [
        { properties: { a: {} }, additionalProperties: false },
        { properties: { b: {} } },
      ],
    };
    expect(
      validateFieldValue({ a: 1, b: 2 }, closed, {}).length,
    ).toBeGreaterThan(0);
  });

  it("distinguishes authentication values from credential file paths", () => {
    expect(
      fieldModel("user", { type: "string" }, root, undefined, {
        path: "sinks.http.auth.user",
      }).sensitive,
    ).toBe(true);
    expect(
      fieldModel("value", { type: "string" }, root, undefined, {
        path: "sinks.http.auth.value",
      }).sensitive,
    ).toBe(true);
    expect(fieldModel("user", { type: "string" }, root).sensitive).toBe(false);
    for (const name of ["secret_file", "private_key_path", "token_file"])
      expect(fieldModel(name, { type: "string" }, root).intent.kind).toBe(
        "path",
      );
  });

  it("defers native PathBuf syntax so valid relative VRL files remain editable", () => {
    const remap = definition("vector::transforms::remap::RemapConfig", {});
    expect(
      validateFieldValue("relative.vrl", remap.properties.file, root),
    ).toEqual([]);
    expect(
      validateFieldValue(["relative.vrl"], remap.properties.files, root),
    ).toEqual([]);
    expect(
      fieldModel("location", ref("stdlib::PathBuf"), root).intent.kind,
    ).toBe("path");
    expect(
      validateFieldValue(
        "not-a-number",
        { type: "string", pattern: "^[0-9]+$" },
        {},
      ).length,
    ).toBeGreaterThan(0);
  });
});
