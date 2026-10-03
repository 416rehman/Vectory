import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DeploymentVariableFields from "./DeploymentVariableFields";
import PipelineVariables from "./PipelineVariables";

const declaration = {
  name: "site_name",
  path: "/sinks/out/labels/site",
  type: "string" as const,
};

/**
 * A variable's value is stored with the deployment where authorized people
 * read it, so a credential goes in a device secret. That is the one mechanism
 * restricted devices run: a Vector secret provider is full mode only.
 */
describe("where a variable sends credentials", () => {
  it("points the settings section to device secrets, with the guide", () => {
    const html = renderToStaticMarkup(
      createElement(PipelineVariables, {
        config: { sinks: { out: { type: "loki", labels: { site: "a" } } } },
        variables: [declaration],
        editable: true,
        onChange: () => {},
      }),
    );
    expect(html).toContain(
      "Use a device secret, which works in restricted and full mode: <code>vectory-secret:NAME</code> ",
    );
    expect(html).toContain(
      'href="/help/resources/#keep-credentials-on-the-device"',
    );
    expect(html).not.toMatch(/device-local|secret provider for those/);
  });

  it("points the deploy dialog's values to device secrets, with the guide", () => {
    const html = renderToStaticMarkup(
      createElement(DeploymentVariableFields, {
        declarations: [declaration],
        devices: [],
        inputs: { defaults: {}, devices: {} },
        persistent: false,
        onChange: () => {},
      }),
    );
    expect(html).toContain(
      "For credentials, use a device secret instead: <code>vectory-secret:NAME</code> ",
    );
    expect(html).toContain(
      'href="/help/resources/#keep-credentials-on-the-device"',
    );
    expect(html).not.toMatch(/device-local|secret provider instead/);
  });
});
