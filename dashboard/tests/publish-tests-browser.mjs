// Actual App/Editor; every HTTP request uses isolated synthetic state. The
// publish review runs the draft's pipeline tests when it opens, says what came
// out in words that never borrow "Checked", and turns the primary button into
// "Publish anyway" while a test is failing, refused or did not run.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import {
  isPipelineTelemetry,
  pipelineTelemetry,
} from "./telemetry-replies.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_PUBLISH_TESTS_OUTPUT || ".local/publish-tests",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/Editor.tsx",
  "dashboard/src/PublishReview.tsx",
  "dashboard/src/publishReviewModel.ts",
  "dashboard/src/PipelineTestResults.tsx",
  "dashboard/src/PipelineGlobals.tsx",
  "dashboard/src/publishTests.ts",
  "dashboard/src/publishRequests.ts",
  "dashboard/src/publish-review.css",
  "dashboard/tests/publish-tests-browser.mjs",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(resolve(root, p)))
          .digest("hex"),
      ]),
    ),
  );
const loaded = await hashes();
const reservation = net.createServer();
await new Promise((done, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:publish-tests";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "publish-tests-isolated",
      resolveId(id) {
        if (id === "virtual:publish-tests") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__publish-tests") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic publish review tests</title></head><body><div id="root"></div><script type="module">import "virtual:publish-tests";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${port}`,
  browser = await chromium.launch();
const id = (n) => `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`,
  created = "2026-09-27T12:00:00Z",
  clone = (v) => structuredClone(v);
const results = [],
  accessibility = [],
  screenshots = [];

const testCase = (name, target = "enrich") => ({
  name,
  inputs: [
    {
      insert_at: target,
      type: "log",
      log_fields: { message: "example" },
    },
  ],
  outputs: [
    {
      extract_from: target,
      conditions: [{ type: "vrl", source: ".seen == true" }],
    },
  ],
});
function baseDocument(tests, kind) {
  const config = {
    sources: { demo: { type: "demo_logs", format: "json" } },
    transforms: {
      enrich: { type: "remap", inputs: ["demo"], source: ".seen = true" },
    },
    sinks: { output: { type: "blackhole", inputs: ["enrich"] } },
  };
  if (kind === "enrichment") {
    config.enrichment_tables = {
      regions: {
        type: "file",
        file: {
          path: "/etc/vectory/regions.csv",
          encoding: { type: "csv", include_headers: true },
        },
      },
    };
    config.transforms.enrich.source =
      '.seen = true\n.region = get_enrichment_table_record!("regions", { "id": .id })';
  }
  if (kind === "program") {
    // A remap whose program is a file on the device.
    config.transforms.enrich = {
      type: "remap",
      inputs: ["demo"],
      file: "/etc/vector/enrich.vrl",
    };
  }
  if (kind === "lua") {
    config.transforms.probe = {
      type: "lua",
      version: "2",
      inputs: ["enrich"],
      source: "function process(event, emit) emit(event) end",
      hooks: { process: "process" },
    };
    config.sinks.output.inputs = ["probe"];
  }
  if (tests) config.tests = tests;
  return {
    id: id(1),
    name: "Synthetic tests gate",
    description: "Isolated pipeline; never deployed.",
    revision: 1,
    archived: false,
    archived_at: null,
    created_at: created,
    updated_at: created,
    config,
    graph: { nodes: [], edges: [] },
  };
}
// What the synthetic test runner answers, by mode.
const rows = {
  passed: [
    { name: "first", passed: true },
    { name: "second", passed: true },
  ],
  refused: [
    {
      name: "first",
      passed: false,
      refused: true,
      message:
        "Could not build this test: inputs[0]: unable to locate target transform 'nosuch'.",
      detail:
        "Vector could not build this test.\ninputs[0]: unable to locate target transform 'nosuch'.",
    },
    {
      name: "second",
      passed: false,
      not_run: true,
      message: "Vector did not run this test.",
    },
  ],
  failing: [
    { name: "first", passed: true },
    {
      name: "second",
      passed: false,
      message: "condition 0 failed: .seen == true",
      detail: "output payloads from enrich:\n{}",
    },
    { name: "third", passed: true },
  ],
};
// What the server answers for a draft with a Lua step: it never asks the
// isolated worker, because Lua can run any program.
const luaSentence =
  "Lua can run any program, so tests that include it run only on devices. Use Check on devices with Also run the pipeline's tests.";
const luaTestReply = {
  valid: false,
  tests_run: false,
  tests: [],
  deferred: true,
  deferred_reasons: ["Lua runs on devices"],
  errors: [luaSentence],
  warnings: ["Each device checks Lua code before applying this version."],
  diagnostics: [
    {
      severity: "error",
      section: "tests",
      code: "tests_on_devices",
      message: luaSentence,
    },
  ],
  static_checked: false,
  vector_validated: false,
  vector_version: "0.58.0",
};
const luaValidation = {
  valid: true,
  vector_validated: false,
  static_checked: true,
  deferred: true,
  deferred_reasons: ["Lua runs on devices"],
  diagnostics: [
    {
      severity: "warning",
      section: "transforms",
      component: "probe",
      code: "device_check",
      message: "This step runs Lua code, so only a device checks it.",
    },
  ],
  errors: [],
  warnings: [
    "transforms.probe: This step runs Lua code, so only a device checks it.",
    "Each device checks Lua code before applying this version.",
  ],
  vector_version: "0.58.0",
};
// The same for a draft with an enrichment table that reads a file: the isolated
// worker never opens an author's path.
const enrichmentSentence =
  "Enrichment tables are read on devices, so tests that use them run only on devices. Use Check on devices with Also run the pipeline's tests.";
const enrichmentTestReply = {
  ...luaTestReply,
  deferred_reasons: ["Enrichment tables are read on devices"],
  errors: [enrichmentSentence],
  warnings: [
    "Each device checks enrichment data files before applying this version.",
  ],
  diagnostics: [
    {
      severity: "error",
      section: "tests",
      code: "tests_on_devices",
      message: enrichmentSentence,
    },
  ],
};
const enrichmentValidation = {
  ...luaValidation,
  deferred_reasons: [
    "Enrichment tables are read on devices",
    "device enrichment data",
    "device-local paths or external code files",
  ],
  diagnostics: [
    {
      severity: "warning",
      section: "transforms",
      component: "enrich",
      code: "device_check",
      message:
        "This step looks up an enrichment table, which each device reads.",
    },
  ],
  warnings: [
    "transforms.enrich: This step looks up an enrichment table, which each device reads.",
    "Each device checks enrichment data files and local files and paths before applying this version.",
  ],
};
// And for a remap that loads its VRL program from a file: the worker never
// opens an author's path either.
const programSentence =
  "A VRL program in a file is read on devices, so tests that include it run only on devices. Use Check on devices with Also run the pipeline's tests.";
const programReasons = [
  "A VRL program in a file is read on devices",
  "device-local paths or external code files",
];
const programTestReply = {
  ...luaTestReply,
  deferred_reasons: programReasons,
  errors: [programSentence],
  warnings: [
    "Each device checks local files and paths before applying this version.",
  ],
  diagnostics: [
    {
      severity: "error",
      section: "tests",
      code: "tests_on_devices",
      message: programSentence,
    },
  ],
};
const programValidation = {
  ...luaValidation,
  deferred_reasons: programReasons,
  diagnostics: [
    {
      severity: "warning",
      section: "transforms",
      component: "enrich",
      code: "device_check",
      message: "This step loads its VRL program from a file on each device.",
    },
  ],
  warnings: [
    "transforms.enrich: This step loads its VRL program from a file on each device.",
    "Each device checks local files and paths before applying this version.",
  ],
};
function testReply(mode) {
  if (mode === "lua") return luaTestReply;
  if (mode === "enrichment") return enrichmentTestReply;
  if (mode === "program") return programTestReply;
  const tests = rows[mode];
  const stopped = tests.filter((t) => !t.passed).length;
  return {
    valid: !stopped,
    tests_run: true,
    tests,
    errors: stopped
      ? [`${stopped} of ${tests.length} pipeline tests failed.`]
      : [],
    warnings: [],
    output: `${tests.length - stopped} of ${tests.length} tests passed.`,
    vector_validated: false,
    vector_version: "0.58.0",
  };
}
function state(options = {}) {
  const names = options.names ?? ["first", "second"];
  return {
    actor: id(90),
    document: baseDocument(
      names.length
        ? names.map((name) =>
            testCase(
              name,
              name === "first" && options.mode === "refused"
                ? "nosuch"
                : "enrich",
            ),
          )
        : undefined,
      ["lua", "enrichment", "program"].includes(options.mode)
        ? options.mode
        : undefined,
    ),
    mode: options.mode || "passed",
    versions: [],
    tests: [],
    posts: [],
    requests: [],
    errors: [],
    raceOnPublish: false,
    ...options,
  };
}
function version(f, body, number = f.versions.length + 1) {
  const artifact = JSON.stringify(f.document.config);
  return {
    id: id(100 + number),
    configuration_id: f.document.id,
    request_id: body.request_id,
    number,
    source_revision: body.revision,
    config: clone(f.document.config),
    graph: clone(f.document.graph),
    artifact,
    sha256: createHash("sha256").update(artifact).digest("hex"),
    size: Buffer.byteLength(artifact),
    created_at: created,
    message: body.message,
    validation: {
      valid: true,
      vector_validated: false,
      errors: [],
      warnings: [],
    },
    author_id: f.actor,
    author: "Synthetic publisher",
  };
}
async function start(f, options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width || 1200, height: options.height || 950 },
    reducedMotion: "reduce",
    colorScheme: options.theme || "light",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
    localStorage.setItem("vectory-sidebar-collapsed", "true");
    localStorage.setItem("vectory.editor.auto-check", "off");
  }, options.theme || "light");
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    if (url.origin !== origin) {
      f.errors.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      body = method === "GET" ? null : req.postDataJSON();
    f.requests.push({ method, path, body: clone(body) });
    const reply = (json, status = 200) => route.fulfill({ json, status }),
      error = (code, message, status) =>
        reply({ error: { code, message } }, status);
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: f.actor,
            name: "Synthetic operator",
            email: "publish@example.test",
            role: "admin",
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic publish review fixture" });
      if (path === "/mfa") return reply({ enabled: false });
      if (path === "/devices") return reply([]);
      if (isPipelineTelemetry(path, f.document.id))
        return reply(pipelineTelemetry(f.document.id));
      if (path === `/configurations/${f.document.id}`) return reply(f.document);
      if (path === `/configurations/${f.document.id}/history`) {
        const page = Number(url.searchParams.get("page") || 1),
          size = Number(url.searchParams.get("page_size") || 12);
        const items = [...f.versions].reverse().map((v) => ({
          id: v.id,
          configuration_id: v.configuration_id,
          number: v.number,
          source_revision: v.source_revision,
          created_at: v.created_at,
          message: v.message,
        }));
        return reply({
          items: items.slice((page - 1) * size, page * size),
          total: items.length,
          page,
          page_size: size,
          kind: url.searchParams.get("kind") || "versions",
        });
      }
      if (path.startsWith("/versions/")) {
        const v = f.versions.find((v) => path === `/versions/${v.id}`);
        return v ? reply(v) : error("NOT_FOUND", "Version unavailable", 404);
      }
      if (path === "/configurations/publish-requests") {
        return reply({ items: [], total: 0, page: 1, page_size: 12 });
      }
      if (path.startsWith("/configurations/publish-requests/")) {
        const requestId = path.split("/").pop();
        const recorded = f.versions.find((v) => v.request_id === requestId);
        return reply(
          recorded
            ? { request_id: requestId, found: true, version: recorded }
            : { request_id: requestId, found: false },
        );
      }
    }
    if (req.headers()["x-csrf-token"] !== "synthetic") {
      f.errors.push("Missing CSRF");
      return error("FORBIDDEN", "Missing CSRF", 403);
    }
    if (method === "POST" && path === "/configurations/test") {
      f.tests.push(clone(body));
      if (f.mode === "unavailable")
        return error(
          "CAPABILITY_DENIED",
          "Isolated Vector pipeline test runner is unavailable",
          503,
        );
      return reply(testReply(f.mode));
    }
    if (
      method === "POST" &&
      path === `/configurations/${f.document.id}/validate`
    )
      return reply(
        f.mode === "lua"
          ? luaValidation
          : f.mode === "enrichment"
            ? enrichmentValidation
            : f.mode === "program"
              ? programValidation
              : {
                  valid: true,
                  vector_validated: true,
                  static_checked: true,
                  deferred: false,
                  diagnostics: [],
                  errors: [],
                  warnings: [],
                  vector_version: "0.58.0",
                },
      );
    if (
      method === "POST" &&
      path === `/configurations/${f.document.id}/publish`
    ) {
      f.posts.push({
        body: clone(body),
        stored_before_request: await req
          .frame()
          .evaluate(() =>
            Object.fromEntries(
              Object.entries(localStorage).filter(([key]) =>
                key.startsWith("vectory:publish-operation:"),
              ),
            ),
          ),
      });
      // The tests changed between the review and the publish: the server ran
      // them again and refuses without the acknowledgement.
      if (f.raceOnPublish && body.acknowledge_test_failures !== true) {
        f.mode = "failing";
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "TESTS_FAILED",
              message:
                "Pipeline tests didn't pass (1 failed, 2 passed). Nothing was published. Fix them, or publish again with acknowledge_test_failures set to true.",
            },
            tests: rows.failing,
            tests_run: true,
            counts: { passed: 2, failed: 1, refused: 0, not_run: 0 },
          },
        });
      }
      const v = version(f, body);
      f.versions.push(v);
      return reply(v);
    }
    f.errors.push(`${method} ${path}`);
    return error("UNEXPECTED", path, 500);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.setDefaultNavigationTimeout(30000);
  page.on("pageerror", (e) => f.errors.push(e.message));
  const open = async (query = "") => {
    await page.goto(
      `${origin}/__publish-tests#/configurations/${f.document.id}${query}`,
    );
    // The first page of a run compiles the whole App.
    if (!query)
      await expect(
        page.getByRole("region", { name: "Pipeline canvas", exact: true }),
      ).toBeVisible({ timeout: 60000 });
  };
  await open();
  return { f, page, context, open, close: () => context.close() };
}
const reviewDialog = (page) =>
  page.getByRole("dialog", { name: "Review & publish", exact: true });
const testsRegion = (page) =>
  reviewDialog(page).getByRole("region", {
    name: "Pipeline tests",
    exact: true,
  });
async function openReview(page) {
  await page
    .getByRole("button", { name: "Review & publish", exact: true })
    .click();
  await expect(reviewDialog(page)).toBeVisible();
}
const footer = (page) => reviewDialog(page).locator(".modal-footer .button");
// Vector accepted the configuration: the one thing "Checked" means.
async function runCheck(page) {
  await reviewDialog(page)
    .getByRole("button", { name: "Check now", exact: true })
    .click();
  await expect(reviewDialog(page)).toContainText("Checked");
}
async function scan(page, scenario, width, theme) {
  const filename = `publish-tests-${scenario}-${width}-${theme}.png`;
  await page.screenshot({ path: resolve(output, filename) });
  screenshots.push(filename);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({
    scenario,
    width,
    theme,
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    })),
  });
  expect(result.violations).toEqual([]);
}
async function run(name, fn) {
  const focus = process.env.VECTORY_PUBLISH_TESTS_FOCUS;
  if (focus && !name.includes(focus)) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration_ms: Date.now() - started });
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    throw error;
  }
}
const clean = (f) => expect(f.errors).toEqual([]);

let failure;
try {
  await run(
    "passing tests: 2 of 2 passed, and Publish version as ever",
    async () => {
      const s = await start(state());
      try {
        await openReview(s.page);
        await expect(testsRegion(s.page)).toContainText("Tests: 2 of 2 passed");
        await expect(testsRegion(s.page)).toHaveAttribute(
          "data-tests-state",
          "passed",
        );
        // One run when the review opened, of the draft as it stands.
        expect(s.f.tests).toHaveLength(1);
        expect(s.f.tests[0].config.tests).toHaveLength(2);
        await expect(footer(s.page)).toHaveText([
          "Back to draft",
          "Publish version",
        ]);
        await expect(reviewDialog(s.page).getByRole("checkbox")).toHaveCount(0);
        // The check keeps its own words.
        await runCheck(s.page);
        await reviewDialog(s.page)
          .getByRole("button", { name: "Publish version", exact: true })
          .click();
        await expect(
          s.page.getByRole("dialog", { name: "Version 1 published" }),
        ).toBeVisible();
        expect(s.f.posts).toHaveLength(1);
        expect(s.f.posts[0].body).not.toHaveProperty(
          "acknowledge_test_failures",
        );
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );

  // The published version predates variables, so it carries none.
  const published = (f) =>
    f.versions.push(
      version(f, { request_id: "first", revision: 1, message: "First" }),
    );
  const changesRegion = (page) =>
    reviewDialog(page).getByRole("region", { name: "Changes", exact: true });
  for (const [width, theme] of [
    [1200, "light"],
    [390, "dark"],
  ])
    await run(
      `a change to the variables alone is named in the review at ${width}px, ${theme}, never "No configuration changes" (Axe)`,
      async () => {
        const f = state({ names: [] });
        published(f);
        f.document.variables = [
          { name: "region", path: "/sources/demo/format", type: "string" },
        ];
        const s = await start(f, {
          width,
          height: width < 600 ? 900 : 950,
          theme,
        });
        try {
          await openReview(s.page);
          const changes = changesRegion(s.page);
          await expect(changes).toContainText("Changes since v1");
          await expect(changes).toContainText("Variables: region added");
          expect(await changes.innerText()).not.toContain(
            "No configuration changes",
          );
          expect(
            await s.page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
          await scan(s.page, "variables-review", width, theme);
          clean(f);
        } finally {
          await s.close();
        }
      },
    );

  await run(
    "a test Vector could not build: named, never Checked, Publish anyway beside Open tests",
    async () => {
      const s = await start(state({ mode: "refused" }));
      try {
        await openReview(s.page);
        const region = testsRegion(s.page);
        await expect(region).toContainText(
          "Tests: Vector couldn't build 1 of 2 tests (inputs[0]: no step named 'nosuch'); the other didn't run.",
        );
        // The steps a test can use, said once in the canvas's words.
        await expect(region).toContainText(
          "No step named 'nosuch'. Steps you can test: enrich.",
        );
        expect(await region.innerText()).not.toContain(
          "unable to locate target transform",
        );
        await expect(region.locator(".pipeline-test-list pre")).toHaveCount(0);
        // "Checked" belongs to the configuration, never to a refused test.
        await runCheck(s.page);
        expect(await region.innerText()).not.toMatch(/checked/i);
        // The primary action changes, with no extra checkbox.
        await expect(footer(s.page)).toHaveText([
          "Back to draft",
          "Open tests",
          "Publish anyway",
        ]);
        await expect(reviewDialog(s.page).getByRole("checkbox")).toHaveCount(0);
        await expect(
          reviewDialog(s.page).getByRole("button", { name: "Publish version" }),
        ).toHaveCount(0);
        // Never the default focus target.
        const onButton = await s.page.evaluate(
          () => document.activeElement?.closest("button")?.textContent ?? "",
        );
        expect(onButton).not.toBe("Publish anyway");
        await expect(
          reviewDialog(s.page).getByRole("button", { name: "Publish anyway" }),
        ).not.toBeFocused();
        await reviewDialog(s.page)
          .getByRole("button", { name: "Publish anyway", exact: true })
          .click();
        await expect(
          s.page.getByRole("dialog", { name: "Version 1 published" }),
        ).toBeVisible();
        expect(s.f.posts).toHaveLength(1);
        expect(s.f.posts[0].body.acknowledge_test_failures).toBe(true);
        // The saved request that survives a lost response carries it too.
        const [saved] = Object.values(s.f.posts[0].stored_before_request).map(
          (raw) => JSON.parse(raw),
        );
        expect(saved.request.acknowledge_test_failures).toBe(true);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );

  await run(
    "Open tests leaves for Pipeline settings on the failing test",
    async () => {
      const s = await start(
        state({ mode: "failing", names: ["first", "second", "third"] }),
      );
      try {
        await openReview(s.page);
        await expect(testsRegion(s.page)).toContainText(
          "Tests: 1 of 3 tests failed",
        );
        await expect(testsRegion(s.page)).toContainText(
          "condition 0 failed: .seen == true",
        );
        await reviewDialog(s.page)
          .getByRole("button", { name: "Open tests", exact: true })
          .click();
        const settings = s.page.getByRole("dialog", {
          name: "Pipeline settings",
        });
        await expect(settings).toBeVisible();
        await expect(reviewDialog(s.page)).toHaveCount(0);
        await expect(
          settings
            .getByRole("navigation", { name: "Pipeline settings sections" })
            .getByRole("button", { name: "Tests", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        const selected = settings.locator(
          ".pipeline-schema-array > .schema-array-entry[data-selected]",
        );
        await expect(selected).toHaveCount(1);
        await expect(selected).toContainText("Test 2");
        // The cursor is in it, ready to fix.
        await expect(selected.locator(":focus")).toHaveCount(1);
        // The section is always shown, but tests are optional: no asterisk.
        const heading = settings
          .locator(".schema-record-label")
          .filter({ has: s.page.locator("strong", { hasText: /^Tests$/ }) })
          .first();
        await expect(heading).toBeVisible();
        await expect(heading.locator(".schema-required")).toHaveCount(0);
        expect(s.f.posts).toHaveLength(0);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );

  await run("a link opens Pipeline settings on a test", async () => {
    const s = await start(
      state({ mode: "failing", names: ["first", "second", "third"] }),
    );
    try {
      await s.open("?panel=settings&section=tests&test=3");
      const settings = s.page.getByRole("dialog", {
        name: "Pipeline settings",
      });
      await expect(settings).toBeVisible();
      const selected = settings.locator(
        ".pipeline-schema-array > .schema-array-entry[data-selected]",
      );
      await expect(selected).toHaveCount(1);
      await expect(selected).toContainText("Test 3");
      // A link only opens a view: nothing ran, nothing was sent.
      expect(s.f.tests).toHaveLength(0);
      expect(s.f.posts).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  await run(
    "tests that changed after the review: the refusal shows the new verdict and Publish anyway sends the flag",
    async () => {
      const s = await start(state({ raceOnPublish: true }));
      try {
        await openReview(s.page);
        await expect(testsRegion(s.page)).toContainText("2 of 2 passed");
        await reviewDialog(s.page)
          .getByRole("button", { name: "Publish version", exact: true })
          .click();
        await expect(reviewDialog(s.page).getByRole("alert")).toContainText(
          "The pipeline tests didn't pass. Nothing was published.",
        );
        await expect(reviewDialog(s.page)).not.toContainText(
          "acknowledge_test_failures",
        );
        // The tests ran again, and the footer follows them.
        await expect(testsRegion(s.page)).toContainText(
          "Tests: 1 of 3 tests failed",
        );
        await expect(footer(s.page)).toHaveText([
          "Back to draft",
          "Open tests",
          "Publish anyway",
        ]);
        expect(s.f.versions).toHaveLength(0);
        expect(s.f.tests).toHaveLength(2);
        await reviewDialog(s.page)
          .getByRole("button", { name: "Publish anyway", exact: true })
          .click();
        await expect(
          s.page.getByRole("dialog", { name: "Version 1 published" }),
        ).toBeVisible();
        expect(s.f.posts).toHaveLength(2);
        expect(s.f.posts[1].body.acknowledge_test_failures).toBe(true);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );

  await run(
    "no answer from the test runner: say so, run again, and Publish anyway only while it is unknown",
    async () => {
      const s = await start(state({ mode: "unavailable" }));
      try {
        await openReview(s.page);
        await expect(testsRegion(s.page)).toContainText(
          "Tests: Couldn't run the 2 tests. Vector's test runner isn't available on this server.",
        );
        await expect(footer(s.page)).toHaveText([
          "Back to draft",
          "Open tests",
          "Publish anyway",
        ]);
        s.f.mode = "passed";
        await testsRegion(s.page)
          .getByRole("button", { name: "Run tests again", exact: true })
          .click();
        await expect(testsRegion(s.page)).toContainText("Tests: 2 of 2 passed");
        await expect(footer(s.page)).toHaveText([
          "Back to draft",
          "Publish version",
        ]);
        expect(s.f.tests).toHaveLength(2);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );

  await run(
    "a Lua step: the tests did not run here, the sentence says why and what to do, and Publish anyway sends the acknowledgement",
    async () => {
      const s = await start(state({ mode: "lua" }));
      try {
        await openReview(s.page);
        const region = testsRegion(s.page);
        await expect(region).toHaveAttribute("data-tests-state", "failing");
        await expect(region).toContainText(
          "Tests: Vector didn't run either of the 2 tests",
        );
        // Why, and what to do, in the server's own sentence.
        await expect(region).toContainText(luaSentence);
        expect(await region.innerText()).not.toContain("Lua runs on devices");
        // The check keeps its own words: a device checks the Lua.
        await runCheck(s.page);
        await expect(reviewDialog(s.page)).toContainText(
          "Vector 0.58 accepted this pipeline. Each device checks Lua code before applying it.",
        );
        expect(await reviewDialog(s.page).innerText()).not.toContain(
          "Lua runs on devices",
        );
        await expect(footer(s.page)).toHaveText([
          "Back to draft",
          "Open tests",
          "Publish anyway",
        ]);
        await reviewDialog(s.page)
          .getByRole("button", { name: "Publish anyway", exact: true })
          .click();
        await expect(
          s.page.getByRole("dialog", { name: "Version 1 published" }),
        ).toBeVisible();
        expect(s.f.posts).toHaveLength(1);
        expect(s.f.posts[0].body.acknowledge_test_failures).toBe(true);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );

  await run(
    "an enrichment table that reads a file: the tests did not run here, the sentence says why, and the check line names the files",
    async () => {
      const s = await start(state({ mode: "enrichment" }));
      try {
        await openReview(s.page);
        const region = testsRegion(s.page);
        await expect(region).toHaveAttribute("data-tests-state", "failing");
        await expect(region).toContainText(
          "Tests: Vector didn't run either of the 2 tests",
        );
        await expect(region).toContainText(enrichmentSentence);
        await runCheck(s.page);
        await expect(reviewDialog(s.page)).toContainText(
          "Vector 0.58 accepted this pipeline. Each device checks enrichment data files and local files and paths before applying it.",
        );
        // The check line keeps its own words, never the raw reason.
        expect(
          await reviewDialog(s.page)
            .locator(".publish-review-check")
            .innerText(),
        ).not.toContain("Enrichment tables are read on devices");
        await expect(footer(s.page)).toHaveText([
          "Back to draft",
          "Open tests",
          "Publish anyway",
        ]);
        await reviewDialog(s.page)
          .getByRole("button", { name: "Publish anyway", exact: true })
          .click();
        await expect(
          s.page.getByRole("dialog", { name: "Version 1 published" }),
        ).toBeVisible();
        expect(s.f.posts[0].body.acknowledge_test_failures).toBe(true);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );

  for (const [width, theme] of [
    [1200, "light"],
    [390, "dark"],
  ])
    await run(
      `a remap whose program is a file at ${width}px, ${theme}: the tests did not run here, the sentence says why, and the check line names local files (Axe)`,
      async () => {
        const s = await start(state({ mode: "program" }), {
          width,
          height: width < 600 ? 900 : 950,
          theme,
        });
        try {
          await openReview(s.page);
          const region = testsRegion(s.page);
          await expect(region).toHaveAttribute("data-tests-state", "failing");
          await expect(region).toContainText(
            "Tests: Vector didn't run either of the 2 tests",
          );
          await expect(region).toContainText(programSentence);
          await runCheck(s.page);
          await expect(reviewDialog(s.page)).toContainText(
            "Vector 0.58 accepted this pipeline. Each device checks local files and paths before applying it.",
          );
          // The check line keeps its own words, never the raw reason.
          expect(
            await reviewDialog(s.page)
              .locator(".publish-review-check")
              .innerText(),
          ).not.toContain("A VRL program in a file");
          expect(
            await s.page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
          await scan(s.page, "program-file-review", width, theme);
          // The editor's Tests panel says the same, and that the tests wait
          // for a device rather than failed.
          await reviewDialog(s.page)
            .getByRole("button", { name: "Open tests", exact: true })
            .click();
          const settings = s.page.getByRole("dialog", {
            name: "Pipeline settings",
          });
          await settings
            .getByRole("button", { name: "Run pipeline tests", exact: true })
            .click();
          const results = settings.locator(".pipeline-test-results");
          await expect(results).toHaveAttribute("data-state", "deferred");
          await expect(results).toContainText(
            "These tests need the device environment",
          );
          await expect(results).toContainText(programSentence);
          await scan(s.page, "program-file-tests-panel", width, theme);
          clean(s.f);
        } finally {
          await s.close();
        }
      },
    );

  await run("a pipeline without tests never asks for any", async () => {
    const s = await start(state({ names: [] }));
    try {
      await openReview(s.page);
      await expect(testsRegion(s.page)).toHaveCount(0);
      await expect(footer(s.page)).toHaveText([
        "Back to draft",
        "Publish version",
      ]);
      await reviewDialog(s.page)
        .getByRole("button", { name: "Publish version", exact: true })
        .click();
      await expect(
        s.page.getByRole("dialog", { name: "Version 1 published" }),
      ).toBeVisible();
      expect(s.f.tests).toHaveLength(0);
      expect(s.f.posts[0].body).not.toHaveProperty("acknowledge_test_failures");
      clean(s.f);
    } finally {
      await s.close();
    }
  });

  for (const [width, theme] of [
    [1200, "light"],
    [1200, "dark"],
    [390, "light"],
    [390, "dark"],
  ])
    await run(
      `the review at ${width}px, ${theme}, with a refused test and with passing ones (Axe)`,
      async () => {
        const s = await start(state({ mode: "refused" }), {
          width,
          height: width < 600 ? 900 : 950,
          theme,
        });
        try {
          await openReview(s.page);
          await expect(testsRegion(s.page)).toContainText(
            "couldn't build 1 of 2",
          );
          // The whole footer fits and stays inside the dialog.
          const box = await reviewDialog(s.page).boundingBox();
          for (const button of await footer(s.page).all()) {
            const at = await button.boundingBox();
            expect(at.x).toBeGreaterThanOrEqual(box.x - 1);
            expect(at.x + at.width).toBeLessThanOrEqual(box.x + box.width + 1);
          }
          expect(
            await s.page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
          await scan(s.page, "refused", width, theme);
          s.f.mode = "passed";
          await s.page.reload();
          await openReview(s.page);
          await expect(testsRegion(s.page)).toContainText("2 of 2 passed");
          await scan(s.page, "passed", width, theme);
          clean(s.f);
        } finally {
          await s.close();
        }
      },
    );

  for (const [width, theme] of [
    [1200, "light"],
    [1200, "dark"],
    [390, "light"],
    [390, "dark"],
  ])
    await run(
      `a Lua step at ${width}px, ${theme}: the review and the editor's Tests panel give the reason as a sentence (Axe)`,
      async () => {
        const s = await start(state({ mode: "lua" }), {
          width,
          height: width < 600 ? 900 : 950,
          theme,
        });
        try {
          await openReview(s.page);
          await expect(testsRegion(s.page)).toContainText(luaSentence);
          expect(
            await s.page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
          await scan(s.page, "lua-review", width, theme);
          // The editor's Tests panel says the same, and why it is not an error
          // to fix: the tests wait for a device.
          await reviewDialog(s.page)
            .getByRole("button", { name: "Open tests", exact: true })
            .click();
          const settings = s.page.getByRole("dialog", {
            name: "Pipeline settings",
          });
          await settings
            .getByRole("button", { name: "Run pipeline tests", exact: true })
            .click();
          const results = settings.locator(".pipeline-test-results");
          await expect(results).toHaveAttribute("data-state", "deferred");
          await expect(results).toContainText(
            "These tests need the device environment",
          );
          await expect(results).toContainText(luaSentence);
          expect(await results.innerText()).not.toContain(
            "Lua runs on devices",
          );
          await scan(s.page, "lua-tests-panel", width, theme);
          clean(s.f);
        } finally {
          await s.close();
        }
      },
    );
} catch (error) {
  failure = error.stack;
  console.error(error);
} finally {
  await browser.close();
  await server.close();
  const current = await hashes();
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        passed: !failure && results.length > 0,
        scope:
          "Actual App publish review with intercepted synthetic HTTP only. No native test run, real publication or device activation claimed.",
        results,
        accessibility,
        screenshots,
        error: failure || null,
        loaded_source_sha256: loaded,
        current_source_sha256: current,
        source_changed_during_run: Object.keys(current).filter(
          (p) => loaded[p] !== current[p],
        ),
      },
      null,
      2,
    ) + "\n",
  );
  if (failure || !results.length) process.exitCode = 1;
}
