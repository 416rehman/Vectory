import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { fieldModel } from "./pipelineSchema";
import {
  SchemaFieldHelpContent,
  fieldHelpConstraints,
  schemaHelpDescriptions,
} from "./SchemaFieldChrome";
import { PipelineSchemaControl } from "./PipelineSchemaFields";

describe("field help preserves authoritative schema information", () => {
  it("retains zero bounds, exclusive limits, and false constraints", () => {
    const model = fieldModel(
      "value",
      {
        type: "number",
        minimum: 0,
        exclusiveMaximum: 10,
        multipleOf: 0.25,
        uniqueItems: false,
      },
      {},
      1,
    );
    expect(fieldHelpConstraints(model)).toEqual([
      { label: "Minimum", value: "0" },
      { label: "Less than", value: "10" },
      { label: "Multiple of", value: "0.25" },
      { label: "Unique items", value: "false" },
    ]);
  });
  it("shows descriptions, null defaults and examples safely without interpreting HTML", () => {
    const model = fieldModel(
      "value",
      {
        type: ["string", "null"],
        default: null,
        description: "Use <script> as literal text.",
        examples: ["one", "two"],
        maxLength: 50,
      },
      {},
      undefined,
    );
    const html = renderToStaticMarkup(
      createElement(SchemaFieldHelpContent, { model }),
    );
    expect(html).toContain("Use &lt;script&gt;");
    expect(html).toContain("Accepts an explicit null");
    expect(html).toContain("Vector default");
    expect(html).toContain("<pre>null</pre>");
    expect(html).toContain("<pre>two</pre>");
    expect(html).toContain("Maximum characters");
  });
  it("does not offer secret-looking schema defaults or examples as credential values", () => {
    const model = fieldModel(
      "password",
      {
        type: "string",
        default: "unsafe-default",
        examples: ["unsafe-example"],
        _metadata: { sensitive: true },
      },
      {},
      undefined,
    );
    const html = renderToStaticMarkup(
      createElement(SchemaFieldHelpContent, { model }),
    );
    expect(html).not.toContain("unsafe-default");
    expect(html).not.toContain("unsafe-example");
    expect(html).toContain("Credentials stay on each device.");
    expect(html).toContain("Plain-text credentials are never saved.");
    expect(html).toContain("keep-credentials-on-the-device");
  });
  it("gives a scalar its own help/header with required semantics and no accordion", () => {
    const html = renderToStaticMarkup(
      createElement(PipelineSchemaControl, {
        name: "rate",
        label: "One in every",
        schema: { type: "integer", minimum: 1 },
        root: {},
        value: 5,
        onChange: () => {},
        editable: true,
        required: true,
      }),
    );
    expect(html.match(/aria-label="Help for One in every"/g)).toHaveLength(1);
    expect(html).toContain('aria-required="true"');
    expect(html).toContain("schema-field-owned");
    expect(html).not.toContain("Field details");
    expect(html).not.toContain("Maximum");
  });
  it("combines inherited and selected help without inactive branch instructions", () => {
    const root = {
      definitions: { shared: { description: "Shared buffering rules." } },
    };
    const descriptions = schemaHelpDescriptions(
      [
        {
          $ref: "#/definitions/shared",
          oneOf: [{ description: "Inactive disk details." }],
        },
        {
          allOf: [
            { $ref: "#/definitions/shared" },
            { description: "Selected memory details." },
          ],
        },
      ],
      root,
    );
    expect(descriptions).toEqual([
      "Shared buffering rules.",
      "Selected memory details.",
    ]);
    const html = renderToStaticMarkup(
      createElement(SchemaFieldHelpContent, {
        model: fieldModel(
          "buffer",
          { type: "object", description: "Selected memory details." },
          {},
          {},
        ),
        descriptions,
      }),
    );
    expect(html.match(/Selected memory details/g)).toHaveLength(1);
    expect(html).not.toContain("Inactive disk");
  });
  it("renders nested fields directly and keeps their Add field in the owning header", () => {
    const html = renderToStaticMarkup(
      createElement(PipelineSchemaControl, {
        name: "settings",
        schema: {
          type: "object",
          properties: { count: { type: "integer" }, other: { type: "string" } },
        },
        root: {},
        value: { count: 4 },
        editable: true,
        onChange: () => {},
      }),
    );
    expect(html).not.toContain("<details");
    expect(html).not.toContain(">Fields<");
    expect(html).toContain("schema-object-children");
    expect(html).toContain('aria-label="Help for Count"');
    expect(html).toContain("Add field");
  });
  it("keeps nested native read-only values immutable while retaining help", () => {
    const html = renderToStaticMarkup(
      createElement(PipelineSchemaControl, {
        name: "settings",
        schema: {
          type: "object",
          readOnly: true,
          properties: {
            amount: { type: "number" },
            enabled: { type: "boolean" },
          },
        },
        root: {},
        value: { amount: 3, enabled: true },
        onChange: () => {
          throw Error("read-only render must not edit");
        },
        editable: true,
      }),
    );
    expect(html).toContain('readOnly=""');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Help for Amount"');
    expect(html).not.toContain('aria-label="Actions for Amount"');
  });
});
