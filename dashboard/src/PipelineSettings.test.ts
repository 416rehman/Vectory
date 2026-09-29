import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import PipelineSettings from "./PipelineSettings";
import { catalog, type Kind } from "./catalog";
import type { Config } from "./api";

function render(kind: Kind, component: Config) {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(PipelineSettings, {
      id: "reviewed",
      kind,
      component,
      editable: true,
      issues: [],
      onChange: noop,
      onPendingChange: noop,
      onRouteRename: noop,
      onRouteRemove: noop,
    }),
  );
}

describe("curated settings retain native fields without duplicate controls", () => {
  it("groups actual sampling fields without adding modes or empty sections", () => {
    const component = {
      type: "sample",
      inputs: ["seed"],
      rate: 25,
      key_field: "customer_id",
      measure_cpu_usage: true,
    };
    const before = structuredClone(component),
      html = render("transforms", component);
    const sampling = html.slice(
      html.indexOf('data-property-section="sampling"'),
      html.indexOf('data-property-section="settings"'),
    );
    expect(sampling).toContain("One in every");
    expect(sampling).toContain('value="25"');
    expect(sampling).toContain('value="customer_id"');
    expect(html.match(/data-property-section=/g)).toHaveLength(2);
    expect(html.match(/aria-label="Help for One in every"/g)).toHaveLength(1);
    expect(html).not.toContain('data-property-section="delivery"');
    expect(html).not.toContain("Selection mode");
    expect(component).toEqual(before);
  });

  it("keeps grouped nested fields intact and unknown fields visible exactly once", () => {
    const html = render("sinks", {
      type: "http",
      inputs: ["seed"],
      uri: "https://collector.example.test/events",
      encoding: { codec: "json" },
      auth: { strategy: "basic", user: "${USER}", password: "${PASSWORD}" },
      buffer: { type: "memory", max_events: 321, when_full: "block" },
      future_setting: "keep-this-value",
    });
    expect(html.match(/data-property-section=/g)).toHaveLength(5);
    for (const section of [
      "configuration",
      "encoding",
      "connection",
      "delivery",
      "settings",
    ])
      expect(
        html.match(new RegExp(`data-property-section="${section}"`, "g")),
      ).toHaveLength(1);
    for (const value of ["${USER}", "${PASSWORD}", "keep-this-value", "321"])
      expect(html.split(`value="${value}"`).length - 1).toBe(1);
    expect(html).toContain("Additional fields");
    expect(html).not.toContain("More Vector settings");
  });

  it("carries grouping through root variants without showing inactive required controls", () => {
    const html = render("sources", {
      type: "syslog",
      mode: "unix",
      path: "/run/vector.sock",
      max_length: 4096,
    });
    expect(html).toContain('data-property-section="configuration"');
    expect(html).toContain('value="/run/vector.sock"');
    expect(html).toContain('value="4096"');
    expect(html).not.toContain('aria-label="Help for Address"');
    expect(html.match(/value="\/run\/vector.sock"/g)).toHaveLength(1);
  });

  it("preserves the curated sampling label through native allOf constraints", () => {
    const html = render("transforms", {
      type: "sample",
      inputs: ["seed"],
      rate: 10,
    });
    expect(html).toContain("One in every");
    expect(html).toContain('aria-label="Help for One in every"');
    expect(html).not.toContain('aria-label="Help for Rate"');
    expect(html).toContain('value="10"');
    expect(html).toContain('aria-required="true"');
  });

  it("keeps HTTP authentication in the unified field picker", () => {
    const definition = catalog.find(
      (entry) => entry.kind === "sources" && entry.type === "http_server",
    )!;
    const html = render("sources", {
      type: "http_server",
      ...definition.defaults,
    });
    expect(html).not.toContain("More Vector settings");
    expect(html).toContain("Add field");
    const configured = render("sources", {
      type: "http_server",
      ...definition.defaults,
      auth: {
        strategy: "basic",
        username: "${HTTP_USERNAME}",
        password: "${HTTP_PASSWORD}",
      },
    });
    expect(configured).toContain("Username reference");
    expect(configured).toContain("<strong>Auth</strong>");
    expect(configured).toContain("Password reference");
    expect(configured).not.toContain("<summary>Authentication</summary>");
  });

  it("keeps sink authentication in the shared field list without duplicate controls", () => {
    for (const type of ["http", "loki", "elasticsearch"]) {
      const definition = catalog.find(
        (entry) => entry.kind === "sinks" && entry.type === type,
      )!;
      const html = render("sinks", {
        type,
        ...definition.defaults,
        inputs: ["seed"],
        auth: { strategy: "basic", user: "${USER}", password: "${PASSWORD}" },
      });
      expect(html).not.toContain("<summary>Authentication</summary>");
      expect(html.match(/<strong>Auth<\/strong>/g)).toHaveLength(1);
      expect(html.match(/value="\$\{PASSWORD\}"/g)).toHaveLength(1);
    }
  });

  it("uses the named-output editor for the actual route transform", () => {
    const html = render("transforms", {
      type: "route",
      inputs: ["seed"],
      route: { matched: "true" },
    });
    expect(html).toContain("Named outputs");
    expect(html).toContain('aria-label="Output name matched"');
    expect(html).not.toContain("<strong>Route</strong>");
  });
});
