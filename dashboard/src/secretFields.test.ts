import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import table from "./generated/secret-fields.json";
import schema from "./generated/vector-schema.json";
import {
  DEVICE_SECRET_FIX,
  bindingInstructions,
  formatSecretPath,
  isSecretField,
  looksLikeCredential,
  pickerState,
  pickerValue,
  readPickerInput,
  secretFieldPaths,
  secretFindings,
  secretNameProblem,
  secretNamesOf,
  secretReferences,
  suggestedSecretName,
} from "./secretFields";
import SecretReferenceField, {
  SecretBindingSteps,
} from "./SecretReferenceField";
import { SecretPathContext, SecretScopeContext } from "./secretFieldContext";
import { PipelineSchemaControl } from "./PipelineSchemaFields";
import PipelineSettings from "./PipelineSettings";
import { checkVerdict } from "./pipelineProblems";

describe("the device-secret field table", () => {
  it("is the generated copy of the agent's and the server's table", () => {
    const fields = table.fields as Record<string, Record<string, string[]>>;
    const count = Object.values(fields).reduce(
      (sum, types) =>
        sum + Object.values(types).reduce((n, paths) => n + paths.length, 0),
      0,
    );
    expect(count).toBe(table.field_count);
    expect(table.schema_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Every field is marked sensitive in the schema the editor renders.
    const definitions = (schema as any).definitions;
    expect(
      definitions["vector::sinks::datadog::LocalDatadogCommonConfig"].properties
        .default_api_key._metadata.sensitive,
    ).toBe(true);
    expect(
      definitions["vector_core::tls::settings::TlsConfig"].properties.key_pass
        ._metadata.sensitive,
    ).toBe(true);
  });

  it("matches fields, list items and map values by structure", () => {
    expect(isSecretField("sinks", "datadog_logs", ["default_api_key"])).toBe(
      true,
    );
    expect(isSecretField("sinks", "kafka", ["sasl", "password"])).toBe(true);
    expect(isSecretField("sinks", "kafka", ["sasl", "username"])).toBe(false);
    expect(isSecretField("sinks", "http", ["tls", "key_pass"])).toBe(true);
    expect(isSecretField("sources", "splunk_hec", ["valid_tokens", 2])).toBe(
      true,
    );
    // An object key named like a list item is not a list item.
    expect(isSecretField("sources", "splunk_hec", ["valid_tokens", "0"])).toBe(
      false,
    );
    expect(isSecretField("sinks", "http", ["uri"])).toBe(false);
    expect(isSecretField("sinks", "http", ["request", "headers", "x"])).toBe(
      false,
    );
    expect(isSecretField("sinks", "not_a_sink", ["auth", "token"])).toBe(false);
    expect(secretFieldPaths("sinks", "elasticsearch")).toContain("auth.user");
    expect(formatSecretPath(["valid_tokens", 1])).toBe("valid_tokens[1]");
    expect(formatSecretPath(["auth", "auth", "access_key_id"])).toBe(
      "auth.auth.access_key_id",
    );
  });

  it("lists the secrets a pipeline needs, in order and by name", () => {
    const config = {
      sources: {
        hec: {
          type: "splunk_hec",
          valid_tokens: ["vectory-secret:HEC_A", "vectory-secret:HEC_B"],
        },
      },
      sinks: {
        dd: {
          type: "datadog_logs",
          inputs: ["hec"],
          default_api_key: "vectory-secret:DD_API_KEY",
        },
        web: {
          type: "http",
          inputs: ["hec"],
          uri: "vectory-secret:NOT_A_CREDENTIAL",
          auth: { strategy: "bearer", token: "vectory-secret:DD_API_KEY" },
        },
      },
    };
    expect(secretReferences(config)).toEqual([
      {
        name: "HEC_A",
        kind: "sources",
        id: "hec",
        type: "splunk_hec",
        field: "valid_tokens[0]",
      },
      {
        name: "HEC_B",
        kind: "sources",
        id: "hec",
        type: "splunk_hec",
        field: "valid_tokens[1]",
      },
      {
        name: "DD_API_KEY",
        kind: "sinks",
        id: "dd",
        type: "datadog_logs",
        field: "default_api_key",
      },
      {
        name: "DD_API_KEY",
        kind: "sinks",
        id: "web",
        type: "http",
        field: "auth.token",
      },
    ]);
    expect(secretNamesOf(config)).toEqual(["DD_API_KEY", "HEC_A", "HEC_B"]);
  });
});

describe("local checks follow the server's device-secret rules", () => {
  const sink = (fields: Record<string, unknown>) => ({
    sinks: { dd: { type: "datadog_logs", inputs: ["in"], ...fields } },
  });
  it("refuses plain text in a credential field with the fix", () => {
    expect(secretFindings(sink({ default_api_key: "0123abcd" }))).toEqual([
      {
        id: "dd",
        field: "default_api_key",
        code: "plaintext_credential",
        message: `dd.default_api_key: Plaintext credentials cannot be stored in \`default_api_key\`. ${DEVICE_SECRET_FIX}`,
      },
    ]);
    expect(DEVICE_SECRET_FIX).toBe(
      "Use a device secret: vectory-secret:NAME, then bind it on each device with `vectory configure-secrets`.",
    );
  });
  it("keeps native references and empty values valid", () => {
    for (const value of [
      "vectory-secret:DD_API_KEY",
      "SECRET[vault.dd]",
      "${DD_API_KEY}",
      "$DD_API_KEY",
      "",
    ])
      expect(secretFindings(sink({ default_api_key: value }))).toEqual([]);
  });
  it("refuses references where a secret could leave the device", () => {
    const cases: [object, string][] = [
      [
        { sinks: { out: { type: "http", uri: "vectory-secret:T" } } },
        "out.uri: Only credential fields can hold a device secret, and `uri` isn't one.",
      ],
      [
        {
          sinks: {
            out: {
              type: "http",
              request: { headers: { Authorization: "vectory-secret:T" } },
            },
          },
        },
        "out.request.headers.Authorization: Only credential fields can hold a device secret, and `request.headers.Authorization` isn't one.",
      ],
      [
        {
          transforms: {
            t: { type: "remap", source: '.token = "vectory-secret:T"' },
          },
        },
        "t.source: Only credential fields can hold a device secret, and `source` isn't one.",
      ],
      [
        {
          sources: {
            run: { type: "exec", command: ["curl", "vectory-secret:T"] },
          },
        },
        "run.command[1]: Only credential fields can hold a device secret, and `command[1]` isn't one.",
      ],
      [
        { api: { address: "vectory-secret:T" } },
        "Only credential fields can hold a device secret, and `api.address` isn't one.",
      ],
      [
        sink({ default_api_key: "Bearer vectory-secret:T" }),
        "dd.default_api_key: `default_api_key` must be exactly `vectory-secret:NAME`, where NAME is a letter followed by up to 63 letters, digits, dots, dashes or underscores.",
      ],
    ];
    for (const [config, message] of cases)
      expect(secretFindings(config).map((finding) => finding.message)).toEqual([
        message,
      ]);
  });
});

describe("the secret picker", () => {
  it("reads a value without ever showing plain text", () => {
    expect(pickerState("vectory-secret:DD_API_KEY", true)).toEqual({
      mode: "device",
      text: "DD_API_KEY",
      plainText: false,
      refused: false,
    });
    expect(pickerState("${TOKEN}", true)).toMatchObject({
      mode: "native",
      text: "${TOKEN}",
    });
    expect(pickerState("hunter2", true)).toEqual({
      mode: "device",
      text: "",
      plainText: true,
      refused: false,
    });
    expect(pickerState(undefined, true).mode).toBe("device");
    // Where the component can't take a device secret, only references remain.
    expect(pickerState(undefined, false).mode).toBe("native");
    expect(pickerState("vectory-secret:X", false)).toEqual({
      mode: "native",
      text: "",
      plainText: false,
      refused: true,
    });
  });
  it("understands what is typed or pasted", () => {
    expect(readPickerInput("device", "${TOKEN}", true)).toEqual({
      mode: "native",
      text: "${TOKEN}",
    });
    expect(readPickerInput("device", "SECRET[vault.key]", true).mode).toBe(
      "native",
    );
    expect(readPickerInput("native", "vectory-secret:API", true)).toEqual({
      mode: "device",
      text: "API",
    });
    expect(readPickerInput("native", "vectory-secret:API", false)).toEqual({
      mode: "native",
      text: "vectory-secret:API",
    });
    expect(readPickerInput("native", "plain", true).mode).toBe("native");
  });
  it("checks names live and saves only references", () => {
    expect(pickerValue("device", "DD_API_KEY")).toEqual({
      value: "vectory-secret:DD_API_KEY",
      problem: null,
    });
    expect(pickerValue("device", "").problem).toBe(
      "Enter a name for this secret.",
    );
    expect(pickerValue("device", "9lives").problem).toBe(
      "Start the name with a letter.",
    );
    expect(pickerValue("device", "dd key").problem).toBe(
      "Use only letters, digits, dots, dashes and underscores.",
    );
    expect(pickerValue("device", "A".repeat(65)).problem).toBe(
      "Use at most 64 characters.",
    );
    // A pasted API key is not a name: it would be stored in the pipeline.
    expect(looksLikeCredential("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).toBe(true);
    expect(looksLikeCredential("DATADOG_API_KEY_2")).toBe(false);
    expect(pickerValue("device", "a1b2c3d4e5f6a7b8c9d0e1f2").problem).toMatch(
      /looks like the credential itself/,
    );
    expect(pickerValue("native", "${TOKEN}").value).toBe("${TOKEN}");
    expect(pickerValue("native", "plaintext").value).toBeNull();
    expect(secretNameProblem("KAFKA.password-2")).toBeNull();
  });
  it("suggests a name from the step and the field", () => {
    expect(suggestedSecretName("dd", ["default_api_key"])).toBe(
      "DD_DEFAULT_API_KEY",
    );
    expect(suggestedSecretName("queue", ["sasl", "password"])).toBe(
      "QUEUE_PASSWORD",
    );
    expect(suggestedSecretName("hec", ["valid_tokens", 0])).toBe(
      "HEC_VALID_TOKENS",
    );
    expect(suggestedSecretName("1st", ["token"])).toBe("SECRET_1ST_TOKEN");
  });

  const render = (value: unknown, device = true, editable = true) =>
    renderToStaticMarkup(
      createElement(SecretReferenceField, {
        title: "Default API key",
        value,
        onChange: () => {},
        editable,
        device: device
          ? { componentId: "dd", path: ["default_api_key"] }
          : null,
      }),
    );
  it("renders a device secret by name with the binding steps", () => {
    const html = render("vectory-secret:DD_API_KEY");
    expect(html).toContain("vectory-secret:</span>");
    expect(html).toContain('value="DD_API_KEY"');
    expect(html).toContain(
      "Each device fills this in from its own DD_API_KEY file.",
    );
    expect(html).toContain("How to bind it on a device");
    expect(html).toContain("Use a Vector reference");
    expect(html).toContain("Default API key reference");
  });
  it("never renders a plain-text credential", () => {
    const html = render("hunter2-plain-value");
    expect(html).not.toContain("hunter2");
    expect(html).toContain("plain-text credential");
    expect(html).toContain("DD_DEFAULT_API_KEY");
    const readOnly = render("hunter2-plain-value", true, false);
    expect(readOnly).not.toContain("hunter2");
    expect(readOnly).not.toContain("Use a Vector reference");
  });
  it("offers only Vector references where a device secret can't go", () => {
    const html = render("${API_KEY}", false);
    expect(html).not.toContain("vectory-secret:</span>");
    expect(html).not.toContain("Use a device secret");
    expect(html).not.toContain("How to bind it on a device");
    expect(html).toContain("It needs full mode.");
  });
  it("renders the picker for credential fields inside a component only", () => {
    const tokenSchema = {
      type: "object",
      properties: { token: { type: "string", _metadata: { sensitive: true } } },
    };
    const inside = renderToStaticMarkup(
      createElement(
        SecretScopeContext.Provider,
        { value: { kind: "sinks", type: "http", id: "web" } },
        createElement(
          SecretPathContext.Provider,
          { value: ["auth"] },
          createElement(PipelineSchemaControl, {
            name: "auth",
            schema: tokenSchema,
            root: {},
            value: { token: "vectory-secret:WEB_TOKEN" },
            onChange: () => {},
            editable: true,
            segment: null,
          }),
        ),
      ),
    );
    expect(inside).toContain('value="WEB_TOKEN"');
    expect(inside).toContain("vectory-secret:</span>");
    const outside = renderToStaticMarkup(
      createElement(PipelineSchemaControl, {
        name: "token",
        schema: { type: "string", _metadata: { sensitive: true } },
        root: {},
        value: "${TOKEN}",
        onChange: () => {},
        editable: true,
      }),
    );
    expect(outside).toContain('value="${TOKEN}"');
    expect(outside).not.toContain("vectory-secret:</span>");
  });
  it("explains device secrets once in the component inspector", () => {
    const html = renderToStaticMarkup(
      createElement(PipelineSettings, {
        id: "dd",
        kind: "sinks",
        component: {
          type: "datadog_logs",
          inputs: ["in"],
          default_api_key: "vectory-secret:DD_API_KEY",
        },
        editable: true,
        issues: [],
        onChange: () => {},
        onPendingChange: () => {},
        onRouteRename: () => {},
        onRouteRemove: () => {},
      }),
    );
    expect(html.match(/Credentials stay on each device\./g)).toHaveLength(1);
    expect(html).toContain("<code>DD_API_KEY</code>");
    expect(html).toContain('value="DD_API_KEY"');
  });
});

describe("binding steps", () => {
  it("list every name, for Linux and macOS or Windows", () => {
    const unix = bindingInstructions(["KAFKA_PASSWORD", "DD_API_KEY"], "unix");
    expect(JSON.parse(unix.bindings)).toEqual({
      DD_API_KEY: "/etc/vectory/secrets/DD_API_KEY",
      KAFKA_PASSWORD: "/etc/vectory/secrets/KAFKA_PASSWORD",
    });
    expect(unix.commands).toBe(
      [
        "sudo vectory service-stop",
        "sudo vectory configure-secrets --secret-files /etc/vectory/secret-bindings.json",
        "sudo vectory service-start",
      ].join("\n"),
    );
    const windows = bindingInstructions(["DD_API_KEY"], "windows");
    expect(JSON.parse(windows.bindings)).toEqual({
      DD_API_KEY: "C:\\ProgramData\\Vectory\\secrets\\DD_API_KEY",
    });
    expect(windows.commands).toContain(
      "vectory configure-secrets --secret-files C:\\ProgramData\\Vectory\\secret-bindings.json",
    );
    const html = renderToStaticMarkup(
      createElement(SecretBindingSteps, { names: ["DD_API_KEY"] }),
    );
    expect(html).toContain("This file replaces its bindings.");
    expect(html).toContain("configure-secrets --secret-files");
  });
});

describe("check verdicts", () => {
  it("say that each device resolves its device secrets", () => {
    expect(
      checkVerdict(
        {
          valid: true,
          vector_validated: false,
          static_checked: true,
          deferred: true,
          deferred_reasons: ["device secrets"],
          errors: [],
          warnings: [],
        },
        0,
      ),
    ).toBe(
      "Vector 0.58 accepted this pipeline. Each device checks secrets before applying it.",
    );
  });
});
