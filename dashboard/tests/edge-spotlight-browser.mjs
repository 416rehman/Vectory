// Actual App/editor, isolated synthetic API. Never contacts preview or devices.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_EDGE_SPOTLIGHT_OUTPUT || ".local/edge-spotlight",
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
      name: "editor-canvas-independent-fixture",
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
const created = "2026-09-26T12:00:00Z";
const results = [],
  requests = [],
  unexpected = [],
  errors = [],
  accessibility = [],
  measurements = [];
const contexts = [];
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
        sample: {
          type: "sample",
          inputs: ["seed"],
          rate: 10,
          exclude: { type: "vrl", source: "false" },
        },
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
  published = false,
  collapsed = true,
  document = baseDocument(),
} = {}) {
  // Closing an old isolated context cannot affect the synthetic persisted fixture.
  if (page) await page.context().close();
  fixture = {
    document: structuredClone(document),
    mutations: [],
    validations: [],
    validationValid: true,
    validationError: false,
    holdValidation: false,
    pendingValidations: [],
    holdSave: false,
    failSave: false,
    saveAttempts: [],
    pendingSaves: [],
  };
  fixture.document.archived = archived;
  fixture.document.archived_at = archived ? created : null;
  const current = fixture;
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  contexts.push(context);
  await context.addInitScript((collapsed) => {
    localStorage.setItem("vectory-sidebar-collapsed", String(collapsed));
    localStorage.setItem("vectory-theme", "light");
  }, collapsed);
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
            name: "Synthetic operator",
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
          items: published
            ? [
                {
                  id: "33333333-3333-4333-8333-333333333333",
                  configuration_id: pipelineId,
                  created_at: created,
                },
              ]
            : [],
          total: published ? 1 : 0,
          page: 1,
          page_size: Number(url.searchParams.get("page_size")),
          kind: "versions",
        });
      if (
        published &&
        path === "/versions/33333333-3333-4333-8333-333333333333"
      )
        return reply({
          id: "33333333-3333-4333-8333-333333333333",
          configuration_id: pipelineId,
          number: 1,
          graph: document.graph,
          config: document.config,
          artifact: JSON.stringify(document.config),
          sha256: "0".repeat(64),
          size: JSON.stringify(document.config).length,
          created_at: created,
          message: "Synthetic published version",
          validation: { valid: true },
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
      current.saveAttempts.push(structuredClone(body));
      let saveFailure = current.failSave;
      if (current.holdSave)
        saveFailure = await new Promise((resolve) =>
          current.pendingSaves.push(resolve),
        );
      if (saveFailure)
        return reject("SAVE_FAILED", "Synthetic draft save failed", 503);
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
      const valid = current.validationValid;
      const failed = current.validationError;
      if (current.holdValidation)
        await new Promise((resolve) =>
          current.pendingValidations.push(resolve),
        );
      if (failed)
        return reject(
          "VALIDATOR_UNAVAILABLE",
          "Synthetic validator unavailable",
          503,
        );
      return reply({
        valid,
        errors: valid ? [] : ["Synthetic configuration rejected"],
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
    `${origin}/__editor-canvas-fixture#/configurations/${pipelineId}`,
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
function spotlightDocument() {
  const document = baseDocument();
  document.name = "Synthetic edge spotlight";
  document.config.transforms.branch.route = {
    accepted: ".accepted == true",
    rejected: ".accepted == false",
  };
  document.config.sinks.output.inputs = ["branch.accepted", "branch.rejected"];
  document.graph.nodes = [
    { id: "seed", position: { x: 0, y: 250 } },
    { id: "branch", position: { x: 450, y: 0 } },
    { id: "output", position: { x: 900, y: 0 } },
    { id: "sample", position: { x: 450, y: 400 } },
    { id: "other", position: { x: 900, y: 400 } },
  ];
  return document;
}
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const button = (name) => page.getByRole("button", { name, exact: true });
const edge = (source, target) =>
  page.locator(
    `.react-flow__edge[aria-label="Connection from ${source} to ${target}"]`,
  );
const accepted = () => edge("branch.accepted", "output");
const rejected = () => edge("branch.rejected", "output");
async function hoverEdge(locator) {
  // Find a real pointer hit on this exact path: parallel named outputs may
  // share a target and overlap near it, so an edge bounding box is ambiguous.
  const point = await locator.evaluate((element) => {
    const path = element.querySelector(".react-flow__edge-path"),
      length = path.getTotalLength(),
      matrix = path.getScreenCTM();
    for (const fraction of [0.2, 0.1, 0.3, 0.4, 0.6, 0.8, 0.9]) {
      const local = path.getPointAtLength(length * fraction);
      const screen = new DOMPoint(local.x, local.y).matrixTransform(matrix);
      for (const yOffset of [0, -3, 3, -6, 6]) {
        const target = document.elementFromPoint(screen.x, screen.y + yOffset);
        if (target?.closest(".react-flow__edge") === element)
          return { x: screen.x, y: screen.y + yOffset };
      }
    }
    return null;
  });
  expect(
    point,
    "An unobstructed pointer hit must exist for the exact edge",
  ).not.toBeNull();
  await page.mouse.move(point.x, point.y);
  return point;
}
async function check(name, run) {
  const focus = process.env.VECTORY_EDGE_SPOTLIGHT_FOCUS;
  const prefix = {
    keyboard: "Keyboard",
    visual: "Active spotlight",
    interactions: "Dimmed",
    cleanup: "Code/history",
  }[focus];
  if (prefix && !name.startsWith(prefix)) return;
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
async function saved(config) {
  await button("Save options").click();
  const save = page.getByRole("menuitem", { name: "Save draft", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => fixture.document.config).toEqual(config);
}
async function axe(label) {
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({ label, violations: scan.violations });
  expect(scan.violations).toEqual([]);
}
const canvas = () =>
  page.getByRole("region", { name: "Pipeline canvas", exact: true });
async function idle() {
  await expect(canvas()).not.toHaveAttribute(
    "data-highlighted-connection",
    /.+/,
  );
  await expect(page.locator("[data-connection-highlight]")).toHaveCount(0);
}
async function spotlight(locator, endpoints) {
  const id = await locator.getAttribute("data-id");
  await expect(canvas()).toHaveAttribute("data-highlighted-connection", id);
  await expect(locator).toHaveAttribute("data-connection-highlight", "active");
  for (const nodeId of ["seed", "branch", "sample", "output", "other"]) {
    const active = endpoints.includes(nodeId);
    await expect(node(nodeId)).toHaveAttribute(
      "data-connection-highlight",
      active ? "endpoint" : "dimmed",
    );
    const opacity = await node(nodeId).evaluate((element) =>
      Number(getComputedStyle(element).opacity),
    );
    // Muted surfaces preserve readable text and controls at full opacity.
    expect(opacity).toBe(1);
    if (!active) {
      await expect(node(nodeId).locator(".pipeline-node")).toHaveCSS(
        "box-shadow",
        "none",
      );
      await expect(node(nodeId).locator(".pipeline-node")).toHaveCSS(
        "background-image",
        "none",
      );
    }
    expect(
      await node(nodeId).evaluate(
        (element) => getComputedStyle(element).pointerEvents,
      ),
    ).not.toBe("none");
  }
  await expect(
    page.locator('.react-flow__edge[data-connection-highlight="active"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('.react-flow__node[data-connection-highlight="endpoint"]'),
  ).toHaveCount(2);
  await expect(locator.locator(".react-flow__edge-path")).toHaveCSS(
    "stroke-width",
    "3.5px",
  );
}
async function keyboardFocus(locator) {
  await page.mouse.move(0, 0);
  await button("Graph").focus();
  await page.keyboard.press("Tab");
  await locator.evaluate((element) => {
    window.__spotlightFocusedElement = element;
    window.__spotlightFocusEvents = [];
    window.__spotlightFocusObserver?.disconnect();
    window.__spotlightFocusObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations)
        for (const removed of mutation.removedNodes)
          if (removed === element || removed.contains?.(element))
            window.__spotlightFocusEvents.push({
              kind: "removed",
              connected: element.isConnected,
              parent: mutation.target.nodeName,
            });
    });
    window.__spotlightFocusObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
  await locator.focus();
  try {
    await expect(locator).toBeFocused();
    expect(
      await locator.evaluate(
        (element) => element === window.__spotlightFocusedElement,
      ),
    ).toBe(true);
  } catch (error) {
    measurements.push({
      label: "Keyboard focus failure",
      ...(await locator.evaluate((element) => ({
        active: document.activeElement?.outerHTML.slice(0, 800),
        connected: element.isConnected,
        tabIndex: element.getAttribute("tabindex"),
        visibility: getComputedStyle(element).visibility,
        display: getComputedStyle(element).display,
        inert: !!element.closest("[inert]"),
        rect: element.getBoundingClientRect().toJSON(),
        sameElement: element === window.__spotlightFocusedElement,
        focusEvents: window.__spotlightFocusEvents,
      }))),
    });
    throw error;
  }
}
async function leave() {
  await page.mouse.move(0, 0);
  await button("Graph").focus();
  await idle();
}
async function dragEndpoint(locator, type, handle, cancel = false) {
  await locator.focus();
  await page.keyboard.press("Enter");
  const start = await locator
    .locator(`.react-flow__edgeupdater-${type}`)
    .boundingBox();
  const target = await handle.boundingBox();
  expect(start).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 15 },
  );
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
try {
  await check(
    "Hover spotlights one exact named edge and its endpoint nodes, including parallel edges, without edits or check invalidation",
    async () => {
      await load({ document: spotlightDocument() });
      await button("Check pipeline").click();
      await expect(button("Check pipeline")).toHaveAttribute(
        "data-check-state",
        "partial",
      );
      await page.mouse.move(0, 0);
      await button("Graph").focus();
      // A selected unrelated edge has a portaled action button, which must dim too.
      await edge("sample", "other").focus();
      await page.keyboard.press("Enter");
      await expect(
        button("Connection actions for sample to other"),
      ).toBeVisible();
      await button("Graph").focus();
      await hoverEdge(accepted());
      await spotlight(accepted(), ["branch", "output"]);
      await expect(rejected()).toHaveAttribute(
        "data-connection-highlight",
        "dimmed",
      );
      await expect(
        button("Connection actions for sample to other"),
      ).toHaveAttribute("data-connection-highlight", "dimmed");
      await hoverEdge(rejected());
      await spotlight(rejected(), ["branch", "output"]);
      await expect(accepted()).toHaveAttribute(
        "data-connection-highlight",
        "dimmed",
      );
      await page.mouse.move(0, 0);
      await idle();
      const point = await hoverEdge(accepted());
      await page.mouse.click(point.x, point.y);
      await page.mouse.move(0, 0);
      await idle();
      await expect(button("Check pipeline")).toHaveAttribute(
        "data-check-state",
        "partial",
      );
      expect(fixture.saveAttempts).toEqual([]);
      expect(fixture.validations).toHaveLength(1);
    },
  );

  await check(
    "Keyboard edge focus provides the same spotlight, pointer hover takes priority, and navigation or readonly focus restores correctly",
    async () => {
      for (const access of [
        { role: "admin" },
        { role: "viewer" },
        { role: "admin", archived: true },
      ]) {
        await load({ document: spotlightDocument(), ...access });
        await keyboardFocus(accepted());
        await spotlight(accepted(), ["branch", "output"]);
        await hoverEdge(edge("sample", "other"));
        await spotlight(edge("sample", "other"), ["sample", "other"]);
        await button("Graph").focus();
        await page.mouse.move(0, 0);
        await idle();
        await keyboardFocus(rejected());
        await spotlight(rejected(), ["branch", "output"]);
        await page.keyboard.press("Tab");
        await expect(edge("sample", "other")).toBeFocused();
        await spotlight(edge("sample", "other"), ["sample", "other"]);
        await page.keyboard.press("Tab");
        await idle();
        expect(fixture.saveAttempts).toEqual([]);
      }
    },
  );

  await check(
    "Dimmed nodes, menus and ports stay operable; connection cancellation and completion clear transient spotlight",
    async () => {
      await load({ document: spotlightDocument() });
      const original = structuredClone(fixture.document.config);
      await hoverEdge(accepted());
      await spotlight(accepted(), ["branch", "output"]);
      await node("sample").click();
      await expect(page.locator(".editor-inspector")).toBeVisible();
      await idle();
      await button("Close component settings").click();
      await expect(page.locator(".editor-inspector")).toHaveCount(0);
      await expect(node("sample")).toBeFocused();
      await hoverEdge(accepted());
      await node("sample")
        .getByRole("button", { name: "Actions for sample", exact: true })
        .click();
      await expect(
        page.getByRole("menu", { name: "Step: sample", exact: true }),
      ).toBeVisible();
      await idle();
      await page.keyboard.press("Escape");
      await hoverEdge(accepted());
      await button("sample output").click();
      await idle();
      await page.keyboard.press("Escape");
      await idle();
      expect(fixture.saveAttempts).toEqual([]);
      await hoverEdge(accepted());
      await button("sample output").focus();
      await page.keyboard.press("Enter");
      await idle();
      await button("Input for output").focus();
      await page.keyboard.press("Enter");
      const connected = structuredClone(original);
      connected.sinks.output.inputs.push("sample");
      await saved(connected);
      // The pointer is still physically over accepted(). A topology update may
      // generate a fresh mouseenter there; verify restoration after actual leave.
      await page.mouse.move(0, 0);
      await idle();
      await button("Undo").click();
      await saved(original);
      await idle();
    },
  );

  await check(
    "Code/history, endpoint cancellation, reconnect, deletion and Undo cannot leave stale spotlight state",
    async () => {
      await load({ document: spotlightDocument() });
      const original = structuredClone(fixture.document.config);
      await hoverEdge(accepted());
      await button("Code").click();
      await expect(canvas()).toHaveCount(0);
      await button("Graph").click();
      await idle();
      await hoverEdge(accepted());
      await page.locator(".editor-tools-menu > summary").click();
      await button("Version history").click();
      await expect(button("Back to editor")).toBeVisible();
      await button("Back to editor").click();
      await idle();
      await keyboardFocus(accepted());
      // Parallel edges share the target grip; the named source grips are
      // physically distinct, so this tests reconnection of the exact edge.
      await dragEndpoint(accepted(), "source", button("seed output"), true);
      await leave();
      expect(fixture.document.config).toEqual(original);
      await keyboardFocus(accepted());
      await dragEndpoint(accepted(), "source", button("seed output"));
      const reconnected = structuredClone(original);
      reconnected.sinks.output.inputs = ["seed", "branch.rejected"];
      await saved(reconnected);
      await leave();
      await expect(accepted()).toHaveCount(0);
      await button("Undo").click();
      await saved(original);
      await idle();
      await keyboardFocus(accepted());
      await page.keyboard.press("Enter");
      await page.keyboard.press("Delete");
      const removed = structuredClone(original);
      removed.sinks.output.inputs = ["branch.rejected"];
      await saved(removed);
      await idle();
      await expect(accepted()).toHaveCount(0);
      await button("Undo").click();
      await saved(original);
      await idle();
    },
  );

  await check(
    "Active spotlight preserves light/dark accessibility and viewport containment",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await load({ document: spotlightDocument(), width, height: 1000 });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await button("Fit graph").click();
          await keyboardFocus(accepted());
          await spotlight(accepted(), ["branch", "output"]);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await axe(`Active edge spotlight ${width} ${theme}`);
          await page.screenshot({
            path: resolve(output, `spotlight-${width}-${theme}.png`),
            animations: "disabled",
          });
          await button("Graph").focus();
          await idle();
          expect(fixture.saveAttempts).toEqual([]);
        }
      await page.emulateMedia({ contrast: "more" });
      await keyboardFocus(accepted());
      await spotlight(accepted(), ["branch", "output"]);
      await expect(rejected()).toHaveCSS("opacity", "1");
      await expect(node("branch").locator(".pipeline-node")).toHaveCSS(
        "outline-width",
        "2px",
      );
      await expect(node("branch").locator(".pipeline-node")).toHaveCSS(
        "outline-style",
        "solid",
      );
      await page.emulateMedia({ contrast: "no-preference" });
      await leave();
    },
  );
  expect(results).toHaveLength(
    process.env.VECTORY_EDGE_SPOTLIGHT_FOCUS ? 1 : 5,
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const file of [
    "Editor.tsx",
    "PipelineEdge.tsx",
    "editor-canvas.css",
    "pipeline-edge.css",
  ])
    source_sha256[`dashboard/src/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, "src", file)))
      .digest("hex");
  if (failure && page && !page.isClosed())
    await page
      .screenshot({
        path: resolve(output, "failure.png"),
        animations: "disabled",
      })
      .catch(() => {});
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Actual App/editor with isolated synthetic API. Exact parallel-edge hover and keyboard endpoint spotlight, transient-state cleanup, interactive dimmed nodes/ports, connection cancel/reconnect/delete/undo, readonly support and899/375 light/dark accessibility. Synthetic draft changes only; no preview, real server, native Vector or device mutations.",
        passed: !failure,
        results,
        accessibility,
        measurements,
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
