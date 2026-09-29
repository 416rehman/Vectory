// Actual App connection editing against intercepted synthetic API only.
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import net from "node:net";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  dashboard = resolve(repository, "dashboard");
const require = createRequire(resolve(dashboard, "package.json"));
const { chromium, expect } = require("@playwright/test");
const { default: AxeBuilder } = require("@axe-core/playwright");
const { createServer } = await import(
  pathToFileURL(resolve(dashboard, "node_modules/vite/dist/node/index.js"))
);
const output = resolve(
  repository,
  process.env.VECTORY_CONNECTIONS_OUTPUT || ".local/editor-connections-browser",
);
await mkdir(output, { recursive: true });
const screenshots = resolve(repository, "docs/screenshots");
await mkdir(screenshots, { recursive: true });
const reservation = net.createServer();
await new Promise((res, rej) => {
  reservation.once("error", rej);
  reservation.listen(0, "127.0.0.1", res);
});
const port = reservation.address().port;
await new Promise((res) => reservation.close(res));
const virtual = "\0virtual:editor-connections-fixture";
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "editor-connections-fixture",
      resolveId(id) {
        if (id === "virtual:editor-connections-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__editor-connections-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic connection editing verification</title></head><body><div id="root"></div><script type="module">import "virtual:editor-connections-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const origin = `http://127.0.0.1:${port}`,
  browser = await chromium.launch();
const pipelineId = "22222222-2222-4222-8222-222222222222";
const created = "2026-09-26T12:00:00Z";
const results = [],
  requests = [],
  unexpected = [],
  errors = [],
  measurements = [],
  accessibility = [];
const contexts = [];
let page, fixture, failure;

function baseDocument() {
  return {
    id: pipelineId,
    name: "Synthetic connection pipeline",
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

async function load({
  role = "admin",
  archived = false,
  width = 1440,
  height = 1000,
  document = baseDocument(),
} = {}) {
  // Closing an old isolated context cannot affect the synthetic persisted fixture.
  if (page) await page.context().close();
  fixture = {
    document: structuredClone(document),
    mutations: [],
    validations: [],
  };
  fixture.document.archived = archived;
  fixture.document.archived_at = archived ? created : null;
  const current = fixture;
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  contexts.push(context);
  await context.addInitScript(() => {
    localStorage.setItem("vectory-sidebar-collapsed", "true");
    localStorage.setItem("vectory-theme", "light");
  });
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
    requests.push({ method, path, role, archived });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    const reject = (code, message, status) =>
      reply({ error: { code, message } }, status);
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: "11111111-1111-4111-8111-111111111111",
            email: "canvas@example.test",
            name: "Synthetic connection editor",
            role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic-canvas-csrf",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic isolated editor" });
      if (path === `/configurations/${pipelineId}`)
        return reply(current.document);
      if (path === `/configurations/${pipelineId}/history`)
        return reply({
          items: [],
          total: 0,
          page: 1,
          page_size: Number(url.searchParams.get("page_size")),
          kind: "versions",
        });
      if (path === "/mfa") return reply({ enabled: false });
    }
    if (request.headers()["x-csrf-token"] !== "synthetic-canvas-csrf") {
      unexpected.push(`Missing CSRF ${method} ${path}`);
      return reject("FORBIDDEN", "Missing fixture CSRF", 403);
    }
    if (role === "viewer" || archived) {
      unexpected.push(`Read-only mutation ${method} ${path}`);
      return reject("FORBIDDEN", "Read-only fixture", 403);
    }
    if (method === "PUT" && path === `/configurations/${pipelineId}/draft`) {
      const body = request.postDataJSON();
      if (body.revision !== current.document.revision)
        return reject("STALE_REVISION", "Synthetic draft changed", 409);
      current.mutations.push(structuredClone(body));
      current.document = {
        ...current.document,
        config: body.config,
        graph: body.graph,
        name: body.name ?? current.document.name,
        description: body.description ?? current.document.description,
        revision: current.document.revision + 1,
        updated_at: created,
      };
      return reply(current.document);
    }
    if (
      method === "POST" &&
      path === `/configurations/${pipelineId}/validate`
    ) {
      current.validations.push(request.postDataJSON());
      return reply({
        valid: true,
        errors: [],
        warnings: [],
        vector_validated: false,
        deferred: true,
      });
    }
    unexpected.push(`${method} ${path}`);
    return reject(
      "UNEXPECTED_REQUEST",
      "Synthetic transport refuses this request",
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${origin}/__editor-connections-fixture#/configurations/${pipelineId}`,
  );
  await expect(page.locator(".react-flow__node")).toHaveCount(
    Object.values(current.document.config).reduce(
      (count, section) => count + Object.keys(section).length,
      0,
    ),
  );
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  return current;
}
async function screenshotAndAxe(label, file) {
  await page.screenshot({
    path: resolve(screenshots, file),
    animations: "disabled",
  });
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({
    label,
    violations: result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  });
  expect(result.violations, label).toEqual([]);
}
async function check(name, run) {
  const began = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - began });
  console.log("PASS", name);
}
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const edge = (source = "branch.accepted", target = "output") =>
  page.locator(
    `.react-flow__edge[aria-label="Connection from ${source} to ${target}"]`,
  );
const handle = (id, port) =>
  node(id).locator(`.react-flow__handle[data-handleid="${port}"]`);
const menu = (kind) => page.locator(`.canvas-action-menu[data-kind="${kind}"]`);
const button = (name) => page.getByRole("button", { name, exact: true });
const picker = () =>
  page.getByRole("dialog", { name: "Add component", exact: true });
async function center(locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function edgePoint(locator) {
  return locator.locator(".react-flow__edge-path").evaluate((path) => {
    const p = path.getPointAtLength(path.getTotalLength() / 2),
      m = path.getScreenCTM();
    const out = new DOMPoint(p.x, p.y).matrixTransform(m);
    return { x: out.x, y: out.y };
  });
}
async function clickEdge(locator, options = {}) {
  const p = await edgePoint(locator);
  await page.mouse.click(p.x, p.y, options);
}
async function saved(predicate) {
  await expect
    .poll(() => predicate(fixture.document), { timeout: 12000 })
    .toBe(true);
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toContainText("Saved");
}
async function settledUnchanged(before) {
  // Exceed the production 2-second autosave debounce when proving no write.
  await page.waitForTimeout(2250);
  expect(fixture.mutations.length).toBe(before);
  await expect(picker()).toHaveCount(0);
}
async function undo(predicate) {
  await button("Undo").click();
  await saved(predicate);
}
async function closeInspector() {
  const close = button("Close component settings");
  if (await close.isVisible()) await close.click();
  await expect(page.locator(".editor-inspector")).toHaveCount(0);
}
async function blankPoint() {
  return page.locator(".react-flow").evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (const dy of [0.8, 0.7, 0.6, 0.5])
      for (const dx of [0.75, 0.6, 0.5, 0.3, 0.2]) {
        const x = r.x + r.width * dx,
          y = r.y + r.height * dy;
        if (
          document
            .elementFromPoint(x, y)
            ?.classList.contains("react-flow__pane")
        )
          return { x, y };
      }
    throw Error("No blank canvas point");
  });
}
async function beginReconnect(which) {
  await clickEdge(edge());
  await edge().focus();
  const updater = edge().locator(`.react-flow__edgeupdater-${which}`);
  await expect(updater).toHaveCount(1);
  const p = await center(updater);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + (which === "target" ? -35 : 35), p.y + 25, {
    steps: 5,
  });
  return p;
}
async function dropAt(locator) {
  const p = await center(locator);
  await page.mouse.move(p.x, p.y, { steps: 12 });
  await page.mouse.up();
}
async function dismissPending(action) {
  const pending = page.waitForEvent("dialog");
  const active = action();
  const dialog = await pending;
  expect(dialog.message()).toMatch(/Discard unapplied field changes/);
  await dialog.dismiss();
  await active;
}
try {
  await check(
    "Node and edge context menus operate on their exact object without opening Add component",
    async () => {
      await load();
      await node("branch").click({ button: "right" });
      await expect(menu("node")).toBeVisible();
      await expect(picker()).toHaveCount(0);
      await expect(
        menu("node").getByRole("menuitem", {
          name: "Duplicate step",
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu("node")).toHaveCount(0);
      await node("branch").focus();
      await page.keyboard.press("Shift+F10");
      await expect(menu("node")).toBeVisible();
      await menu("node")
        .getByRole("menuitem", { name: "Duplicate step", exact: true })
        .click();
      await saved((doc) => !!doc.config.transforms.branch_copy);
      expect(fixture.document.config.transforms.branch_copy).toEqual(
        fixture.document.config.transforms.branch,
      );
      await expect(picker()).toHaveCount(0);
      await undo((doc) => !doc.config.transforms.branch_copy);
      await closeInspector();
      await clickEdge(edge());
      await clickEdge(edge(), { button: "right" });
      await expect(menu("edge")).toBeVisible();
      await screenshotAndAxe(
        "Selected edge menu, light",
        "editor-connection-menu-light.png",
      );
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "dark"),
      );
      await screenshotAndAxe(
        "Selected edge menu, dark",
        "editor-connection-menu-dark.png",
      );
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "light"),
      );
      await expect(
        menu("edge").getByRole("menuitem", {
          name: "Source properties",
          exact: true,
        }),
      ).toBeVisible();
      await menu("edge")
        .getByRole("menuitem", { name: "Disconnect", exact: true })
        .click();
      await saved((doc) => doc.config.sinks.output.inputs.length === 0);
      expect(Object.keys(fixture.document.config.transforms)).toEqual([
        "branch",
        "sample",
      ]);
      await expect(picker()).toHaveCount(0);
      await undo(
        (doc) => doc.config.sinks.output.inputs[0] === "branch.accepted",
      );
    },
  );
  await check(
    "Selecting an edge then Delete removes only that named connection and Undo restores it",
    async () => {
      await load();
      await clickEdge(edge());
      await edge().focus();
      await page.keyboard.press("Delete");
      await saved((doc) => doc.config.sinks.output.inputs.length === 0);
      expect(fixture.document.config.sinks.other.inputs).toEqual(["sample"]);
      await expect(page.locator(".react-flow__node")).toHaveCount(5);
      await undo(
        (doc) => doc.config.sinks.output.inputs[0] === "branch.accepted",
      );
      await expect(edge()).toHaveCount(1);
      await clickEdge(edge(), { button: "middle" });
      await saved((doc) => doc.config.sinks.output.inputs.length === 0);
      expect(fixture.document.config.sinks.other.inputs).toEqual(["sample"]);
      await undo(
        (doc) => doc.config.sinks.output.inputs[0] === "branch.accepted",
      );
    },
  );
  await check(
    "Target reconnection highlights compatible input ports and preserves the named source output",
    async () => {
      await load();
      await beginReconnect("target");
      await expect(handle("other", "input")).toHaveAttribute(
        "data-port-state",
        "valid",
      );
      await expect(handle("branch", "input")).toHaveAttribute(
        "data-port-state",
        "invalid",
      );
      await screenshotAndAxe(
        "Compatible ports, light",
        "editor-connection-candidates-light.png",
      );
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "dark"),
      );
      await screenshotAndAxe(
        "Compatible ports, dark",
        "editor-connection-candidates-dark.png",
      );
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "light"),
      );
      await dropAt(handle("other", "input"));
      await saved(
        (doc) =>
          doc.config.sinks.output.inputs.length === 0 &&
          doc.config.sinks.other.inputs.includes("branch.accepted"),
      );
      expect(fixture.document.config.sinks.other.inputs).toEqual([
        "sample",
        "branch.accepted",
      ]);
      await expect(picker()).toHaveCount(0);
      await undo(
        (doc) =>
          doc.config.sinks.output.inputs[0] === "branch.accepted" &&
          doc.config.sinks.other.inputs.length === 1,
      );
    },
  );
  await check(
    "Source reconnection highlights actual output ports and Undo retains the old named output",
    async () => {
      await load();
      await beginReconnect("source");
      await expect(handle("seed", "output")).toHaveAttribute(
        "data-port-state",
        "valid",
      );
      await expect(handle("branch", "accepted")).toHaveAttribute(
        "data-port-state",
        "valid",
      );
      await dropAt(handle("seed", "output"));
      await saved((doc) => doc.config.sinks.output.inputs[0] === "seed");
      expect(fixture.document.config.transforms.branch.inputs).toEqual([
        "seed",
      ]);
      await undo(
        (doc) => doc.config.sinks.output.inputs[0] === "branch.accepted",
      );
    },
  );
  await check(
    "Invalid drops and Escape retain the edge; blank reconnect drops disconnect with Undo",
    async () => {
      await load();
      let before = fixture.mutations.length;
      await beginReconnect("target");
      await dropAt(handle("branch", "input"));
      await expect(edge()).toHaveCount(1);
      await settledUnchanged(before);
      expect(fixture.document.config.sinks.output.inputs).toEqual([
        "branch.accepted",
      ]);
      await beginReconnect("target");
      const other = await center(handle("other", "input"));
      await page.mouse.move(other.x, other.y, { steps: 10 });
      await page.keyboard.press("Escape");
      await expect(page.locator(".react-flow__connection")).toHaveCount(0);
      await page.mouse.up();
      await expect(edge()).toHaveCount(1);
      await settledUnchanged(before);
      expect(fixture.document.config.sinks.output.inputs).toEqual([
        "branch.accepted",
      ]);
      await beginReconnect("target");
      const blank = await blankPoint();
      await page.mouse.move(blank.x, blank.y, { steps: 12 });
      await page.mouse.up();
      await saved((doc) => doc.config.sinks.output.inputs.length === 0);
      await expect(picker()).toHaveCount(0);
      await undo(
        (doc) => doc.config.sinks.output.inputs[0] === "branch.accepted",
      );
      before = fixture.mutations.length;
      await handle("branch", "accepted").focus();
      await page.keyboard.press("Enter");
      await expect(handle("other", "input")).toHaveAttribute(
        "data-port-state",
        "valid",
      );
      await page.keyboard.press("Escape");
      await expect(page.locator(".react-flow__connection")).toHaveCount(0);
      await expect(handle("other", "input")).toHaveAttribute(
        "data-port-state",
        "idle",
      );
      await handle("other", "input").focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      await settledUnchanged(before);
      expect(fixture.document.config.sinks.other.inputs).toEqual(["sample"]);
      expect(fixture.document.config.sinks.output.inputs).toEqual([
        "branch.accepted",
      ]);
    },
  );
  await check(
    "Node keyboard nudge, coarse nudge, duplicate and deletion persist and support Undo",
    async () => {
      await load();
      const initial = await node("sample").evaluate((el) => {
        const matrix = new DOMMatrix(getComputedStyle(el).transform);
        return { x: matrix.e, y: matrix.f };
      });
      await node("sample").focus();
      await page.keyboard.press("ArrowRight");
      await saved((doc) =>
        doc.graph.nodes.some(
          (n) => n.id === "sample" && n.position.x === initial.x + 10,
        ),
      );
      await node("sample").focus();
      await page.keyboard.press("Shift+ArrowDown");
      await saved((doc) =>
        doc.graph.nodes.some(
          (n) => n.id === "sample" && n.position.y === initial.y + 50,
        ),
      );
      await node("sample").focus();
      await page.keyboard.press("Control+z");
      await saved((doc) =>
        doc.graph.nodes.some(
          (n) =>
            n.id === "sample" &&
            n.position.y === initial.y &&
            n.position.x === initial.x + 10,
        ),
      );
      await node("sample").focus();
      await page.keyboard.press("Control+d");
      await saved((doc) => !!doc.config.transforms.sample_copy);
      expect(fixture.document.config.transforms.sample_copy).toEqual({
        type: "sample",
        inputs: ["seed"],
        rate: 10,
      });
      await node("sample_copy").focus();
      await page.keyboard.press("Delete");
      await saved((doc) => !doc.config.transforms.sample_copy);
      await undo((doc) => !!doc.config.transforms.sample_copy);
      await expect(picker()).toHaveCount(0);
    },
  );
  await check(
    "Pending scalar drafts block contextual destructive changes when discard is declined",
    async () => {
      await load();
      await node("sample").click();
      const field = page.getByRole("textbox", {
        name: "One in every",
        exact: true,
      });
      await field.fill("-");
      const before = fixture.mutations.length;
      await node("branch").click({ button: "right" });
      await dismissPending(() =>
        menu("node")
          .getByRole("menuitem", { name: "Duplicate step", exact: true })
          .click(),
      );
      await expect(field).toHaveValue("-");
      expect(fixture.document.config.transforms.branch_copy).toBeUndefined();
      await settledUnchanged(before);
      await clickEdge(edge(), { button: "right" });
      await dismissPending(() =>
        menu("edge")
          .getByRole("menuitem", { name: "Disconnect", exact: true })
          .click(),
      );
      await expect(field).toHaveValue("-");
      await settledUnchanged(before);
      expect(fixture.document.config.sinks.output.inputs).toEqual([
        "branch.accepted",
      ]);
    },
  );
  await check(
    "Read-only users may inspect context menus but cannot mutate with keyboard or reconnect",
    async () => {
      await load({ role: "viewer" });
      await node("branch").click({ button: "right" });
      await expect(menu("node")).toBeVisible();
      await expect(menu("node").getByRole("menuitem")).toHaveCount(1);
      await expect(
        menu("node").getByRole("menuitem", {
          name: "Open properties",
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await node("sample").focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Control+d");
      await page.keyboard.press("Delete");
      await expect(page.locator(".react-flow__node")).toHaveCount(5);
      await clickEdge(edge(), { button: "right" });
      await expect(
        menu("edge").getByRole("menuitem", { name: "Disconnect", exact: true }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await edge().focus();
      await page.keyboard.press("Delete");
      await expect(edge()).toHaveCount(1);
      await expect(page.locator(".react-flow__edgeupdater")).toHaveCount(0);
      await expect(handle("branch", "accepted")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await settledUnchanged(0);
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
} catch (error) {
  failure = error;
  console.error(error);
  if (page && !page.isClosed()) {
    await page.screenshot({
      path: resolve(output, "failure.png"),
      fullPage: true,
    });
    console.error((await page.locator("body").innerText()).slice(0, 5000));
  }
  process.exitCode = 1;
} finally {
  const files = [
    "dashboard/src/Editor.tsx",
    "dashboard/src/PipelineNode.tsx",
    "dashboard/src/PipelineEdge.tsx",
    "dashboard/src/pipeline-node.css",
    "dashboard/src/pipeline-edge.css",
    "dashboard/src/catalog.ts",
    "dashboard/src/CanvasActionMenu.tsx",
    "dashboard/src/pipelineEditing.ts",
  ];
  const source_sha256 = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(repository, file)))
          .digest("hex"),
      ]),
    ),
  );
  const report = {
    recorded_at: new Date().toISOString(),
    scope:
      "Actual App/editor with synthetic API interception, real pointer/keyboard input and persisted draft assertions. No live API, fleet or deployment writes.",
    results,
    requests,
    unexpected,
    errors,
    source_sha256,
    accessibility,
    ...(failure ? { failure: failure.message } : {}),
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    resolve(repository, "docs/evidence/editor-connections-browser.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
  await vite.close();
  console.log(
    "Evidence: " + relative(repository, resolve(output, "report.json")),
  );
}
