import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PublishReview from "./PublishReview";
import { readTestRun, type TestsView } from "./publishTests";
import type { PipelineTest } from "./PipelineTestResults";
import type { Version } from "./api";

const config = {
  sources: {
    demo: { type: "demo_logs", format: "json" },
    vectory_metrics: { type: "internal_metrics" },
  },
  transforms: {
    enrich: { type: "remap", inputs: ["demo"], source: ".a = 1" },
  },
  sinks: {
    collector: { type: "http", inputs: ["enrich"], uri: "http://x.test" },
  },
};
const published = {
  id: "v1",
  number: 1,
  config: { sources: {}, transforms: {}, sinks: {} },
  created_at: new Date().toISOString(),
} as unknown as Version;
const render = (props: Partial<ComponentProps<typeof PublishReview>> = {}) =>
  renderToStaticMarkup(
    createElement(PublishReview, {
      config,
      variables: [],
      published,
      reach: null,
      status: "passed",
      statusLabel: "Checked",
      verdict: "Vector 0.58 accepted this pipeline.",
      problems: [],
      rejection: null,
      tests: { state: "none" },
      onRunTests: () => {},
      onGoToProblem: () => {},
      ...props,
    }),
  );
const results = (tests: PipelineTest[], valid: boolean): TestsView =>
  readTestRun({ valid, tests_run: true, tests, errors: [] }, tests.length);
const refused: PipelineTest = {
  name: "enrich once",
  passed: false,
  refused: true,
  message:
    "Could not build this test: inputs[0]: unable to locate target transform 'nosuch'.",
  detail:
    "Vector could not build this test.\ninputs[0]: unable to locate target transform 'nosuch'.",
};
const notRun: PipelineTest = {
  name: "second",
  passed: false,
  not_run: true,
  message: "Vector did not run this test.",
};

describe("the publish review's changes", () => {
  const same = {
    ...published,
    config: structuredClone(config),
    variables: [],
  } as unknown as Version;
  const region = {
    name: "region",
    path: "/sources/demo/format",
    type: "string" as const,
  };

  it("says there is nothing to publish when nothing differs", () => {
    expect(render({ published: same })).toContain(
      "No configuration changes since v1.",
    );
  });

  it("names a change to the variables alone instead of saying nothing changed", () => {
    const html = render({ published: same, variables: [region] });
    expect(html).toContain("Variables: region added");
    expect(html).not.toContain("No configuration changes");
    const declared = { ...same, variables: [region] } as unknown as Version;
    expect(render({ published: declared, variables: [] })).toContain(
      "Variables: region removed",
    );
    expect(render({ published: declared, variables: [region] })).toContain(
      "No configuration changes since v1.",
    );
  });

  it("warns about live-event access only when the Vector API is enabled", () => {
    const enabled = render({
      config: { ...config, api: { enabled: true, address: "0.0.0.0:8686" } },
    });
    expect(enabled).toContain("Vector API exposure");
    expect(enabled).toContain("listens on every interface");
    expect(enabled).toContain("stream live events");
    const disabled = render({
      config: { ...config, api: { enabled: false, address: "0.0.0.0:8686" } },
    });
    expect(disabled).not.toContain("Vector API exposure");
    expect(render()).not.toContain("Vector API exposure");
  });
});

describe("the publish review's tests", () => {
  it("shows nothing for a pipeline without tests", () => {
    expect(render()).not.toContain("Pipeline tests");
    expect(render()).not.toContain("Tests:");
  });

  it("says how many passed, apart from the check", () => {
    const html = render({
      tests: results(
        [
          { name: "a", passed: true },
          { name: "b", passed: true },
        ],
        true,
      ),
    });
    expect(html).toContain("<strong>Tests:</strong>");
    expect(html).toContain("2 of 2 passed");
    expect(html).toContain('data-tests-state="passed"');
    // The check keeps its own words; the tests never borrow them.
    expect(html).toContain("<strong>Checked</strong>");
    expect(html).not.toContain("Publishing anyway");
  });

  it("leads with what Vector could not build and never says checked beside it", () => {
    const html = render({ tests: results([refused, notRun], false) });
    expect(html).toContain(
      "Vector couldn&#x27;t build 1 of 2 tests (inputs[0]: no step named &#x27;nosuch&#x27;); the other didn&#x27;t run.",
    );
    expect(html).toContain('data-tests-state="failing"');
    expect(html).toContain("Publishing anyway is recorded in the audit log.");
    // The steps the pipeline has, so the name can be fixed.
    expect(html).toContain("Steps you can test: enrich.");
    // The reason is said once, in the canvas's words.
    expect(html).not.toContain("unable to locate target transform");
    expect(html.split("No step named").length - 1).toBe(1);
    const tests = html.slice(html.indexOf('aria-label="Pipeline tests"'));
    expect(tests.slice(0, tests.indexOf("</section>"))).not.toMatch(/checked/i);
  });

  it("waits, and offers another run when no answer came", () => {
    expect(render({ tests: { state: "running", total: 2 } })).toContain(
      "Running 2 tests…",
    );
    const html = render({
      tests: {
        state: "unavailable",
        total: 2,
        message: "Vector's test runner isn't available on this server.",
      },
    });
    expect(html).toContain("Couldn&#x27;t run the 2 tests.");
    expect(html).toContain("Run tests again");
    expect(html).toContain('data-tests-state="unavailable"');
  });

  it("explains a refusal at publish without the API's words", () => {
    const html = render({
      rejection: {
        code: "TESTS_FAILED",
        message:
          "Pipeline tests didn't pass (1 failed). Nothing was published. Fix them, or publish again with acknowledge_test_failures set to true.",
      },
    });
    expect(html).toContain(
      "The pipeline tests didn&#x27;t pass. Nothing was published.",
    );
    expect(html).not.toContain("acknowledge_test_failures");
  });
});

describe("the publish review's changed steps", () => {
  it("name a step with the canvas title once, and the Vector type only when it says more", () => {
    const html = render({ published });
    // A step the catalog has no friendly name for used to print its type twice.
    expect(html).not.toMatch(/httphttp/);
    expect(html).not.toMatch(/internal_metricsinternal_metrics/);
    expect(html).toContain(
      'HTTP destination <code class="publish-change-type">http</code>',
    );
    // A title that already is the type adds no second copy of it.
    expect(html).toContain("Internal Metrics</span>");
    expect(html).not.toContain('publish-change-type">internal_metrics<');
    expect(html).toContain("Remap</span>");
    expect(html).not.toContain('publish-change-type">remap<');
  });
});
