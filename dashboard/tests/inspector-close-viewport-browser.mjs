// Actual App/editor, isolated synthetic API. Never contacts preview or devices.
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
  process.env.VECTORY_INSPECTOR_CLOSE_OUTPUT ||
    ".local/inspector-close-viewport",
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
  reducedMotion = "reduce",
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
    reducedMotion,
  });
  contexts.push(context);
  await context.addInitScript((collapsed) => {
    localStorage.setItem("vectory-sidebar-collapsed", String(collapsed));
    localStorage.setItem("vectory-theme", "light");
    localStorage.setItem("vectory.editor.auto-check", "off");
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

function positionedDocument() {
  const doc = baseDocument();
  doc.name = "Synthetic inspector-close viewport";
  doc.graph.nodes = [
    { id: "seed", position: { x: 0, y: 250 } },
    { id: "branch", position: { x: 450, y: 0 } },
    { id: "sample", position: { x: 450, y: 400 } },
    { id: "output", position: { x: 900, y: 0 } },
    { id: "other", position: { x: 900, y: 400 } },
  ];
  return doc;
}
const node = () => page.locator('.react-flow__node[data-id="sample"]');
const action = () =>
  page.getByRole("button", { name: "Actions for sample", exact: true });
const closeButton = () =>
  page.getByRole("button", { name: "Close component settings", exact: true });
const menu = () =>
  page.getByRole("menu", { name: "Step: sample", exact: true });
const viewport = () =>
  page.locator(".react-flow__viewport").evaluate((e) => {
    const m = new DOMMatrix(getComputedStyle(e).transform);
    return { x: m.e, y: m.f, zoom: m.a };
  });
const positions = () =>
  page
    .locator(".react-flow__node")
    .evaluateAll((es) =>
      es
        .map((e) => ({ id: e.dataset.id, transform: e.style.transform }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
async function opened(options = {}) {
  await load({ document: positionedDocument(), ...options });
  // Complete initial framing and inspector opening before observing the closing transaction.
  await page.waitForTimeout(380);
  await node().click();
  await expect(
    page.getByRole("complementary", { name: "Component settings" }),
  ).toBeVisible();
  await page.waitForTimeout(380);
  return {
    viewport: await viewport(),
    positions: await positions(),
    document: structuredClone(fixture.document),
  };
}
async function unchanged(before, label) {
  const after = await viewport();
  measurements.push({ label, before: before.viewport, after });
  for (const key of ["x", "y", "zoom"])
    expect(
      Math.abs(after[key] - before.viewport[key]),
      label + " " + key,
    ).toBeLessThan(0.01);
  expect(await positions()).toEqual(before.positions);
  expect(fixture.document).toEqual(before.document);
  expect(fixture.saveAttempts).toEqual([]);
}
async function pointerAction() {
  const bounds = await action().boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  // A real held click crosses the former delayed fitView window. Waiting here
  // must never move the intended target away before pointerup.
  await page.waitForTimeout(180);
  await page.mouse.up();
  await expect(menu()).toBeVisible();
}
async function check(name, run) {
  const filter = process.env.VECTORY_INSPECTOR_CLOSE_FILTER;
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
try {
  await check(
    "Pointer close preserves viewport through an immediate held action click",
    async () => {
      const before = await opened();
      await closeButton().click();
      await pointerAction();
      await page.waitForTimeout(180);
      await unchanged(before, "pointer close");
    },
  );
  await check(
    "Keyboard close restores focus and immediately opens node actions without reframing",
    async () => {
      const before = await opened();
      await closeButton().focus();
      await page.keyboard.press("Escape");
      await expect(node()).toBeFocused();
      await action().focus();
      await page.keyboard.press("ArrowDown");
      await expect(menu()).toBeVisible();
      await page.waitForTimeout(360);
      await unchanged(before, "keyboard close");
      await page.keyboard.press("Escape");
      await expect(action()).toBeFocused();
    },
  );
  await check(
    "Closing during animated inspector centering freezes the current viewport",
    async () => {
      await load({
        document: positionedDocument(),
        reducedMotion: "no-preference",
      });
      await page.waitForTimeout(400);
      const initial = await viewport();
      await node().click();
      await expect(closeButton()).toBeVisible();
      await expect
        .poll(async () => {
          const current = await viewport();
          return (
            Math.abs(current.x - initial.x) + Math.abs(current.y - initial.y)
          );
        })
        .toBeGreaterThan(1);
      // Close while the 220 ms centering animation is still in progress.
      await closeButton().click();
      const before = {
        viewport: await viewport(),
        positions: await positions(),
        document: structuredClone(fixture.document),
      };
      await pointerAction();
      await page.waitForTimeout(300);
      await unchanged(before, "in-flight center cancelled");
    },
  );
  await check(
    "Viewer and archived inspectors preserve focus, viewport and saved geometry",
    async () => {
      for (const access of [
        { role: "viewer" },
        { role: "admin", archived: true },
      ]) {
        const before = await opened(access);
        await closeButton().focus();
        await page.keyboard.press("Escape");
        await expect(node()).toBeFocused();
        await pointerAction();
        await page.waitForTimeout(180);
        await unchanged(before, access.archived ? "archived" : "viewer");
        await expect(
          menu().getByRole("menuitem", { name: "Remove step", exact: true }),
        ).toHaveCount(0);
      }
    },
  );
  await check(
    "Declined pending-field close retains the draft and accepting close stays stationary",
    async () => {
      const before = await opened();
      const rate = page.getByRole("textbox", {
        name: "One in every",
        exact: true,
      });
      await rate.fill("-");
      const denied = page.waitForEvent("dialog");
      const firstClick = closeButton().click();
      await (await denied).dismiss();
      await firstClick;
      await expect(rate).toHaveValue("-");
      await unchanged(before, "declined pending close");
      const accepted = page.waitForEvent("dialog");
      const secondClick = closeButton().click();
      await (await accepted).accept();
      await secondClick;
      await pointerAction();
      await page.waitForTimeout(180);
      await unchanged(before, "accepted pending close");
    },
  );
  expect(results.length).toBe(
    process.env.VECTORY_INSPECTOR_CLOSE_FILTER ? 1 : 5,
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const file of ["Editor.tsx", "CanvasActionMenu.tsx", "PipelineNode.tsx"])
    source_sha256["dashboard/src/" + file] = createHash("sha256")
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
          "Actual App/editor isolated synthetic API. Inspector-close viewport stability, immediate held pointer and keyboard actions, in-flight centering cancellation, readonly and pending-field preservation. No real server, device or saved configuration mutations.",
        passed: !failure,
        results,
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
