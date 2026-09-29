// Actual App/editor, isolated synthetic API. Never contacts preview or devices.
// Covers the canvas work: placement and auto-connect, typed picker, insert on
// a connection, multi-select, copy and paste, find, wildcard edges, live
// numbers, minimap, and the inspector fixes (Esc, sample tester width).
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_CANVAS_TOOLS_OUTPUT || ".local/canvas-tools",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:editor-canvas-fixture";
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const vite = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "canvas-tools-fixture",
      resolveId(id) {
        if (id === "virtual:editor-canvas-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__editor-canvas-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic canvas verification</title></head><body><div id="root"></div><script type="module">import "virtual:editor-canvas-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch();
const pipelineId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const userId = "11111111-1111-4111-8111-111111111111";
const created = "2026-09-26T12:00:00Z";
const results = [],
  requests = [],
  unexpected = [],
  errors = [];
let page, fixture, failure;

function baseDocument() {
  return {
    id: pipelineId,
    name: "Synthetic canvas pipeline",
    description: "Isolated interaction fixture, never deployed.",
    revision: 1,
    archived: false,
    archived_at: null,
    created_at: created,
    updated_at: created,
    config: {
      sources: { seed: { type: "demo_logs", format: "json" } },
      transforms: {
        branch: {
          type: "route",
          inputs: ["seed"],
          route: { accepted: '.level == "info"' },
        },
        sample: { type: "sample", inputs: ["seed"], rate: 10 },
      },
      sinks: {
        output: { type: "blackhole", inputs: ["branch.accepted"] },
        other: { type: "blackhole", inputs: ["sample"] },
      },
    },
    graph: { nodes: [], edges: [] },
  };
}
/** The server returns sorted keys; a draft keeps insertion order. */
function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .reverse()
        .map((key) => [key, sortedKeys(value[key])]),
    );
  return value;
}
const emptyTelemetry = {
  devices_running: 0,
  devices_reporting: 0,
  components: [],
  versions: [],
};

async function load({
  document = baseDocument(),
  published = null,
  telemetry = emptyTelemetry,
  vrl = null,
  samples = null,
  width = 1440,
  height = 1000,
} = {}) {
  if (page) await page.context().close();
  fixture = {
    document: structuredClone(document),
    mutations: [],
    vrlRequests: [],
  };
  const current = fixture;
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.addInitScript(
    ({ samples, key }) => {
      localStorage.setItem("vectory-sidebar-collapsed", "true");
      localStorage.setItem("vectory-theme", "light");
      localStorage.setItem("vectory.editor.auto-check", "off");
      if (samples) localStorage.setItem(key, JSON.stringify(samples));
    },
    {
      samples,
      key: `vectory.samples.v1:${userId}:${pipelineId}`,
    },
  );
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = request.method();
    requests.push({ method, path });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: userId,
            email: "canvas@example.test",
            name: "Synthetic operator",
            role: "admin",
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic-canvas-csrf",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic isolated editor" });
      if (path === "/mfa") return reply({ enabled: false });
      if (path === "/devices") return reply([]);
      if (path === `/configurations/${pipelineId}`)
        return reply(current.document);
      if (path === `/configurations/${pipelineId}/history`)
        return reply({
          items: published ? [{ id: versionId, configuration_id: pipelineId, created_at: created }] : [],
          total: published ? 1 : 0,
          page: 1,
          page_size: Number(url.searchParams.get("page_size")),
          kind: "versions",
        });
      if (published && path === `/versions/${versionId}`)
        return reply({
          id: versionId,
          configuration_id: pipelineId,
          number: 1,
          graph: { nodes: [], edges: [] },
          config: sortedKeys(published),
          artifact: JSON.stringify(published),
          sha256: "0".repeat(64),
          size: JSON.stringify(published).length,
          created_at: created,
          message: "Synthetic published version",
          validation: { valid: true },
        });
      if (path === `/configurations/${pipelineId}/telemetry`)
        return reply(telemetry);
    }
    if (request.headers()["x-csrf-token"] !== "synthetic-canvas-csrf") {
      unexpected.push(`Missing CSRF ${method} ${path}`);
      return reply({ error: { code: "FORBIDDEN", message: "csrf" } }, 403);
    }
    if (method === "PUT" && path === `/configurations/${pipelineId}/draft`) {
      const body = request.postDataJSON();
      current.mutations.push(structuredClone(body));
      current.document = {
        ...current.document,
        config: body.config,
        graph: body.graph,
        revision: current.document.revision + 1,
        updated_at: created,
      };
      return reply(current.document);
    }
    if (method === "POST" && path === `/configurations/${pipelineId}/validate`)
      return reply({
        valid: true,
        errors: [],
        warnings: [],
        vector_validated: false,
        deferred: true,
      });
    if (method === "POST" && path === "/vrl/test" && vrl) {
      current.vrlRequests.push(request.postData());
      // Answered as raw text so epoch nanoseconds keep every digit.
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: vrl,
      });
    }
    unexpected.push(`${method} ${path}`);
    return reply(
      { error: { code: "UNEXPECTED_REQUEST", message: "Synthetic transport refuses this request" } },
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${origin}/__editor-canvas-fixture#/configurations/${pipelineId}`,
  );
  await expect(page.locator(".react-flow__node")).toHaveCount(
    Object.values(current.document.config).reduce(
      (count, section) =>
        count + (section && typeof section === "object" ? Object.keys(section).length : 0),
      0,
    ),
    { timeout: 30000 },
  );
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  return current;
}
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const button = (name) => page.getByRole("button", { name, exact: true });
const inspector = () => page.locator(".editor-inspector");
const picker = () => page.getByRole("dialog", { name: "Add component" });
async function saved(predicate) {
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => predicate(fixture.document), { timeout: 10000 })
    .toBe(true);
}
async function check(name, run) {
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
/** Screen rectangles of every card, to prove nothing overlaps. */
const cards = () =>
  page.locator(".react-flow__node").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        id: element.dataset.id,
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      };
    }),
  );
function overlaps(list) {
  const found = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i],
        b = list[j];
      if (
        a.left < b.right - 1 &&
        b.left < a.right - 1 &&
        a.top < b.bottom - 1 &&
        b.top < a.bottom - 1
      )
        found.push([a.id, b.id]);
    }
  return found;
}
const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

try {
  await check(
    "Esc inside the VRL editor dismisses completion, then leaves the inspector open",
    async () => {
      const document = baseDocument();
      document.config.transforms.parse = {
        type: "remap",
        inputs: ["seed"],
        source: ".a = 1",
      };
      await load({ document });
      await node("parse").click();
      await expect(inspector()).toBeVisible();
      const editor = inspector().locator(".cm-content").first();
      await editor.click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("\n.b = parse_j");
      await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
      await expect(inspector()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(inspector()).toBeVisible();
      // From the inspector's own chrome, Escape closes it as before.
      await inspector().locator("h2").click();
      await page.keyboard.press("Escape");
      await expect(inspector()).toHaveCount(0);
    },
  );

  await check(
    "sample events never widen the inspector and keep epoch nanoseconds exact",
    async () => {
      const document = baseDocument();
      document.config.transforms.parse = {
        type: "remap",
        inputs: ["seed"],
        source: ".a = 1",
      };
      const line = JSON.stringify({
        message: "x".repeat(600),
        ns: "NS",
      }).replace('"NS"', "1790669601180123456");
      await load({
        document,
        samples: {
          version: 1,
          sets: [{ id: "default", name: "Sample events", text: line }],
          active: {},
        },
        vrl: '{"valid":true,"compiled":true,"output":null,"errors":[],"results":[{"sample":0,"outcome":"emitted","outputs":[{"port":"","event":{"message":"x","ns":1790669601180123457,"a":1},"timestamps":[]}]}]}',
      });
      await node("parse").click();
      await expect(inspector().locator(".sample-result")).toHaveCount(1);
      await expect(inspector().locator(".sample-error")).toHaveCount(0);
      // The sample's value and the step's result differ only in the last digit.
      const diff = inspector().locator(".sample-diff");
      await expect(diff).toContainText("1790669601180123456");
      await expect(diff).toContainText("1790669601180123457");
      const width = await inspector()
        .locator(".editor-inspector-body")
        .evaluate((element) => [element.scrollWidth, element.clientWidth]);
      expect(width[0]).toBeLessThanOrEqual(width[1] + 1);
      expect(fixture.vrlRequests[0]).toContain("1790669601180123456");
    },
  );

  await check(
    "a new step lands in free space, fed by the selection, and the picker explains what cannot connect",
    async () => {
      await load();
      await node("sample").click();
      await button("Add component").click();
      await expect(picker()).toBeVisible();
      await expect(picker()).toContainText("Connect from sample");
      // A step that cannot read logs stays listed, greyed, with the reason.
      await picker().getByLabel("Search components").fill("statsd");
      const statsd = picker().locator(".canvas-component-result");
      await expect(statsd).toHaveCount(1);
      await expect(statsd).toHaveAttribute("aria-disabled", "true");
      await expect(statsd).toContainText("Accepts metrics; sample sends logs.");
      await statsd.click();
      await expect(picker()).toBeVisible();
      await picker().getByLabel("Search components").fill("filter");
      await page.keyboard.press("Enter");
      await expect(node("keep")).toBeVisible();
      expect(overlaps(await cards())).toEqual([]);
      await saved((doc) => !!doc.config.transforms.keep);
      expect(fixture.document.config.transforms.keep.inputs).toEqual([
        "sample",
      ]);
      expect(fixture.document.config.sinks.other.inputs).toEqual(["sample"]);
      // Source-side steps need no input: "Don't connect" is offered instead.
      await node("keep").click();
      await button("Add component").click();
      await expect(picker()).toContainText("Connect from keep");
      await picker().getByRole("button", { name: "Don't connect" }).click();
      await expect(picker()).not.toContainText("Connect from");
    },
  );

  await check(
    "+ on a selected connection inserts a step between its ends",
    async () => {
      await load();
      const edge = page.locator(
        '.react-flow__edge[aria-label="Connection from sample to other"]',
      );
      await edge.focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("button", {
          name: "Insert a step between sample and other",
          exact: true,
        })
        .click();
      await expect(picker()).toBeVisible();
      await expect(picker()).toContainText("Insert after sample");
      // Only transformations can sit on a connection.
      await expect(
        picker().getByRole("button", { name: "Destinations", exact: true }),
      ).toHaveCount(0);
      await picker().getByLabel("Search components").fill("remap");
      await page.keyboard.press("Enter");
      await expect(node("parse")).toBeVisible();
      expect(overlaps(await cards())).toEqual([]);
      await saved((doc) => !!doc.config.transforms.parse);
      expect(fixture.document.config.transforms.parse.inputs).toEqual([
        "sample",
      ]);
      expect(fixture.document.config.sinks.other.inputs).toEqual(["parse"]);
      expect(fixture.document.config.sinks.output.inputs).toEqual([
        "branch.accepted",
      ]);
    },
  );

  await check(
    "several steps select without opening the inspector; copy, paste, duplicate and delete work on all of them",
    async () => {
      await load();
      await node("branch").click();
      await node("sample").click({ modifiers: ["Control"] });
      const toolbar = page.getByRole("toolbar", { name: "Selected steps" });
      await expect(toolbar).toContainText("2 steps selected");
      await expect(inspector()).toHaveCount(0);
      // Copy as Vector YAML from the toolbar.
      await toolbar.getByRole("button", { name: "Copy YAML" }).click();
      const yaml = await clipboard();
      expect(yaml).toContain("branch:");
      expect(yaml).toContain("sample:");
      expect(yaml).not.toContain("output:");
      // Ctrl+V pastes them next to the originals, reading the same source.
      await node("branch").focus();
      await page.keyboard.press("ControlOrMeta+v");
      await expect(node("branch_copy")).toBeVisible();
      await expect(node("sample_copy")).toBeVisible();
      expect(overlaps(await cards())).toEqual([]);
      await saved((doc) => !!doc.config.transforms.branch_copy);
      expect(fixture.document.config.transforms.branch_copy.inputs).toEqual([
        "seed",
      ]);
      expect(fixture.document.config.transforms.sample_copy.inputs).toEqual([
        "seed",
      ]);
      // The pasted pair stays selected: duplicate, then delete them.
      await expect(toolbar).toContainText("2 steps selected");
      await toolbar.getByRole("button", { name: "Duplicate" }).click();
      await expect(node("branch_copy_copy")).toBeVisible();
      await expect(page.locator(".react-flow__node")).toHaveCount(9);
      await toolbar.getByRole("button", { name: "Delete" }).click();
      await expect(page.locator(".react-flow__node")).toHaveCount(7);
      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.locator(".react-flow__node")).toHaveCount(9);
    },
  );

  await check(
    "Ctrl+F finds a step by ID and Escape closes it",
    async () => {
      await load();
      await node("seed").click();
      await inspector().locator("h2").click();
      await page.keyboard.press("ControlOrMeta+f");
      const find = page.getByRole("combobox", { name: "Find a step" });
      await expect(find).toBeFocused();
      await find.fill("oth");
      await expect(page.getByRole("option")).toHaveCount(1);
      await expect(page.getByRole("option")).toContainText("other");
      await page.keyboard.press("Enter");
      await expect(find).toHaveCount(0);
      await expect(inspector().locator("h2")).toContainText("Discard events");
      await page.keyboard.press("ControlOrMeta+f");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("combobox", { name: "Find a step" })).toHaveCount(0);
    },
  );

  await check(
    "wildcard inputs draw dashed edges with a pattern chip and only warn when nothing matches",
    async () => {
      const document = baseDocument();
      document.config.sources = {
        a1: { type: "demo_logs" },
        a2: { type: "demo_logs" },
        b1: { type: "demo_logs" },
      };
      document.config.transforms = {};
      document.config.sinks = {
        out: { type: "blackhole", inputs: ["a*"] },
        lonely: { type: "blackhole", inputs: ["zzz*", "b1"] },
      };
      await load({ document });
      await expect(page.locator(".pipeline-edge-pattern-chip")).toHaveCount(3);
      await expect(
        page.locator(".pipeline-edge-pattern-chip").first(),
      ).toHaveText("a*");
      await expect(page.locator(".pipeline-connection-pattern")).toHaveCount(2);
      await node("out").click();
      await expect(inspector().locator(".pipeline-input-patterns")).toContainText(
        "a* matches a1 and a2. Vector resolves the pattern on each device.",
      );
      await page.getByRole("button", { name: /warning/ }).first().click();
      const panel = page.getByRole("region", { name: "Problems", exact: true });
      await expect(panel).toContainText("zzz* matches no step in this pipeline.");
      await expect(panel).not.toContainText("dynamic input pattern");
    },
  );

  await check(
    "a publish review lists only the steps that changed, whatever the key order",
    async () => {
      const draft = baseDocument();
      const publishedConfig = structuredClone(draft.config);
      draft.config.transforms.sample.rate = 20;
      await load({ document: draft, published: publishedConfig });
      await button("Review & publish").click();
      const dialog = page.getByRole("dialog", { name: "Review & publish" });
      await expect(dialog).toBeVisible();
      const rows = dialog.locator(".publish-change-row");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("sample");
      await expect(rows.first()).toContainText("rate changed");
    },
  );

  await check(
    "Live shows events per second, and says why there is nothing to show",
    async () => {
      const document = baseDocument();
      await load({
        document,
        published: structuredClone(document.config),
        telemetry: {
          devices_running: 2,
          devices_reporting: 2,
          components: [
            {
              id: "seed",
              devices_reporting: 2,
              sent_events_per_second: 12,
              sent_by_output: { _default: 12 },
            },
            {
              id: "sample",
              devices_reporting: 2,
              received_events_per_second: 12,
              sent_events_per_second: 1.2,
              errors_per_minute: 3,
            },
          ],
          versions: [
            {
              version_id: versionId,
              version_number: 1,
              devices_running: 2,
              devices_reporting: 2,
            },
          ],
        },
      });
      await button("Live").click();
      const status = page.locator(".editor-live-status");
      await expect(status).toContainText("Live for v1 · 2 devices");
      await expect(page.locator(".pipeline-edge-rate").first()).toBeVisible();
      await expect(
        page.locator(".pipeline-edge-rate").filter({ hasText: "12/s" }).first(),
      ).toBeVisible();
      await expect(node("sample")).toContainText("in 12/s");
      await expect(node("sample")).toContainText("3.0/min errors");
      await expect(node("output")).toContainText("No device reports this step");
      await button("Live").click();
      await expect(status).toHaveCount(0);
      await expect(page.locator(".pipeline-edge-rate")).toHaveCount(0);
    },
  );

  await check(
    "Live without metrics offers Add monitoring instead of zeros",
    async () => {
      const document = baseDocument();
      await load({
        document,
        published: structuredClone(document.config),
        telemetry: {
          devices_running: 1,
          devices_reporting: 0,
          components: [],
          versions: [
            {
              version_id: versionId,
              version_number: 1,
              devices_running: 1,
              devices_reporting: 0,
            },
          ],
        },
      });
      await button("Live").click();
      const status = page.locator(".editor-live-status");
      await expect(status).toContainText(
        "No device reports metrics for v1 yet.",
      );
      await status.getByRole("button", { name: "Add monitoring" }).click();
      await expect(node("vectory_internal_metrics")).toBeVisible();
    },
  );

  await check(
    "the minimap fits its docked frame",
    async () => {
      const document = baseDocument();
      document.config.sources = Object.fromEntries(
        Array.from({ length: 14 }, (_, index) => [
          `s${index}`,
          { type: "demo_logs" },
        ]),
      );
      document.config.transforms = {};
      document.config.sinks = {
        out: { type: "blackhole", inputs: ["s0", "s1"] },
      };
      await load({ document });
      const minimap = page.locator(".react-flow__minimap");
      await expect(minimap).toBeVisible();
      const [frame, drawing] = await Promise.all([
        minimap.boundingBox(),
        minimap.locator("svg").boundingBox(),
      ]);
      expect(Math.abs(drawing.width - frame.width)).toBeLessThan(3);
      expect(Math.abs(drawing.height - frame.height)).toBeLessThan(3);
    },
  );
  expect(results).toHaveLength(10);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const file of [
    "Editor.tsx",
    "CanvasComponentMenu.tsx",
    "CanvasFind.tsx",
    "canvasClipboard.ts",
    "inputPatterns.ts",
    "liveGraph.ts",
    "pipelineEditing.ts",
    "PipelineEdge.tsx",
  ])
    source_sha256[`dashboard/src/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, "src", file)))
      .digest("hex");
  if (failure && page && !page.isClosed())
    await page
      .screenshot({ path: resolve(output, "failure.png"), animations: "disabled" })
      .catch(() => {});
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Actual App/editor with isolated synthetic API. Canvas placement, typed picker, insert on connection, multi-select, clipboard, find, wildcard edges, live numbers, minimap and inspector fixes. All writes remain disposable fixture state; no preview/server/device requests.",
        passed: !failure,
        results,
        requests,
        errors,
        unexpected,
        source_sha256,
        ...(failure ? { failure: failure.message } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await vite.close();
  console.log(
    "Evidence:",
    relative(repository, resolve(output, "report.json")),
  );
}
