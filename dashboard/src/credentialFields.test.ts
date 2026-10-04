import { describe, expect, it } from "vitest";
import { findPlainCredential } from "./credentialFields";

describe("plaintext credential detection", () => {
  it("names the field without copying the credential value", () => {
    for (const [value, path] of [
      [
        {
          sinks: {
            out: {
              request: { headers: { Authorization: "Bearer hidden-value" } },
            },
          },
        },
        "sinks.out.request.headers.Authorization",
      ],
      [
        {
          sinks: {
            out: {
              request: { headers: { "X-Honeycomb-Team": "hidden-value" } },
            },
          },
        },
        "sinks.out.request.headers.X-Honeycomb-Team",
      ],
      [
        {
          sinks: {
            out: { request: { headers: { Cookie: "session=hidden-value" } } },
          },
        },
        "sinks.out.request.headers.Cookie",
      ],
      [
        {
          sinks: {
            out: { uri: "https://example.test/ingest?api_key=hidden-value" },
          },
        },
        "sinks.out.uri",
      ],
      [
        {
          sinks: {
            out: {
              uri: "https://hooks.slack.com/services/T000/B000/hidden-value",
            },
          },
        },
        "sinks.out.uri",
      ],
    ] as const) {
      expect(findPlainCredential(value)?.path).toBe(path);
      expect(JSON.stringify(findPlainCredential(value))).not.toContain(
        "hidden",
      );
    }
  });

  it("refuses device references outside generated credential fields", () => {
    expect(
      findPlainCredential({
        sinks: {
          out: {
            uri: "https://example.test/ingest?api_key=vectory-secret:INGEST_KEY",
            request: {
              headers: { Authorization: "vectory-secret:INGEST_KEY" },
            },
          },
        },
      })?.kind,
    ).toBe("unsupported_reference");
    expect(
      findPlainCredential({
        sinks: {
          out: {
            type: "http",
            uri: "https://example.test/ingest",
            request: {
              headers: { Authorization: "vectory-secret:INGEST_KEY" },
            },
          },
        },
      })?.path,
    ).toBe("sinks.out.request.headers.Authorization");
    expect(
      findPlainCredential({
        sinks: { out: { type: "http", uri: "vectory-secret:INGEST_URL" } },
      })?.kind,
    ).toBe("unsupported_reference");
    expect(
      findPlainCredential({
        sinks: {
          out: { type: "splunk_hec_logs", default_token: "vectory-secret:HEC" },
        },
      }),
    ).toBeNull();
    expect(
      findPlainCredential({
        sinks: {
          out: {
            type: "splunk_hec_logs",
            default_token: "Bearer vectory-secret:HEC",
          },
        },
      })?.kind,
    ).toBe("unsupported_reference");
    expect(
      findPlainCredential({
        sinks: {
          out: { type: "splunk_hec_logs", default_token: "Token ${HEC}" },
        },
      })?.kind,
    ).toBe("plaintext");
  });

  it("allows native references and ordinary values", () => {
    expect(
      findPlainCredential({
        sinks: { out: { uri: "https://example.test/ingest?format=json" } },
      }),
    ).toBeNull();
    expect(
      findPlainCredential({
        sinks: {
          out: {
            uri: "https://${API_USER}:${API_PASS}@example.test/ingest?api_key=$KEY",
          },
        },
      }),
    ).toBeNull();
  });

  it("finds the server's URL and token cases even inside component strings", () => {
    for (const [config, path] of [
      [
        {
          sinks: {
            out: {
              type: "http",
              uri: "https://discord.com/api/webhooks/123/long-webhook-token",
            },
          },
        },
        "sinks.out.uri",
      ],
      [
        {
          sinks: {
            out: {
              type: "http",
              uri: "https://discord.com/api/webhooks/123/long-webhook-token/extra",
            },
          },
        },
        "sinks.out.uri",
      ],
      [
        {
          sinks: {
            out: {
              type: "http",
              uri: "https://hooks.slack.com/services/T123/B%ZZ/long-webhook-token",
            },
          },
        },
        "sinks.out.uri",
      ],
      [
        {
          sinks: {
            out: { type: "http", uri: "https://user:long-password@[bad" },
          },
        },
        "sinks.out.uri",
      ],
      [
        { sinks: { out: { type: "http", uri: "://user:long-password@host" } } },
        "sinks.out.uri",
      ],
      [
        {
          sinks: {
            out: {
              type: "http",
              uri: "https://example.test/ingest?api_key=%76ectory-secret%3AINGEST",
            },
          },
        },
        "sinks.out.uri",
      ],
      [
        {
          sinks: {
            out: {
              type: "http",
              uri: "https://vectory-secret%3AINGEST@example.test/ingest",
            },
          },
        },
        "sinks.out.uri",
      ],
      [
        {
          sinks: {
            out: {
              type: "http",
              uri: "https://example.test/ingest?client.secret=long-credential",
            },
          },
        },
        "sinks.out.uri",
      ],
      [
        {
          transforms: {
            t: {
              type: "remap",
              source:
                '.url = "https://example.test/ingest?auth=long-credential"',
            },
          },
        },
        "transforms.t.source",
      ],
      [
        {
          sources: {
            input: { type: "demo_logs", note: "sk-abcdefghijklmnop" },
          },
        },
        "sources.input.note",
      ],
      [
        {
          sinks: {
            out: {
              type: "http",
              request: { headers: { "X-Session-Id": "long-credential" } },
            },
          },
        },
        "sinks.out.request.headers.X-Session-Id",
      ],
      [
        {
          sinks: { out: { request: { headers: { Authorization: "éééééé" } } } },
        },
        "sinks.out.request.headers.Authorization",
      ],
    ] as const) {
      expect(findPlainCredential(config)?.path).toBe(path);
    }
  });

  it("does not call placeholders or native references plaintext", () => {
    for (const entry of [
      "https://hooks.slack.com/services/T000/B000/${WEBHOOK_TOKEN}",
      "https://example.test/ingest?api_key=example",
    ]) {
      expect(
        findPlainCredential({ sinks: { out: { uri: entry } } }),
      ).toBeNull();
    }
    expect(
      findPlainCredential({
        sinks: { out: { request: { headers: { Cookie: "sid=${COOKIE}" } } } },
      }),
    ).toBeNull();
    expect(
      findPlainCredential({
        sinks: {
          out: { request: { headers: { Authorization: "Bearer redacted" } } },
        },
      }),
    ).toBeNull();
    for (const key of ["client_key", "kms_key", "redis_key", "ssekms_key"]) {
      expect(
        findPlainCredential({
          sinks: { out: { [key]: "ordinary-field-name" } },
        }),
      ).toBeNull();
    }
  });

  it("refuses short plaintext credentials in named fields, headers, and URLs", () => {
    for (const [config, path] of [
      [
        { sources: { input: { client_secret: "x" } } },
        "sources.input.client_secret",
      ],
      [
        { sinks: { out: { request: { headers: { Authorization: "abc" } } } } },
        "sinks.out.request.headers.Authorization",
      ],
      [
        {
          sinks: { out: { uri: "https://example.test/ingest?api_key=short" } },
        },
        "sinks.out.uri",
      ],
    ] as const) {
      expect(findPlainCredential(config)?.path).toBe(path);
    }
    expect(
      findPlainCredential({ sources: { input: { client_secret: "" } } }),
    ).toBeNull();
  });

  it("does not exempt a credential because a later header part is a placeholder", () => {
    for (const [header, value] of [
      ["Authorization", "Bearer live-secret=example"],
      ["Cookie", "sid=live-secret; theme=example"],
      ["Cookie", "sid=live-secret; theme=${THEME}"],
    ]) {
      expect(
        findPlainCredential({
          sinks: { out: { request: { headers: { [header]: value } } } },
        })?.kind,
      ).toBe("plaintext");
    }
  });

  it("fails closed when a configuration is too deeply nested to scan", () => {
    let value: unknown = { password: "long-credential" };
    for (let index = 0; index < 42; index++) value = { nested: value };
    expect(findPlainCredential(value)?.kind).toBe("scan_limit");
  });
});
