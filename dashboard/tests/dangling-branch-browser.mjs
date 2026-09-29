// Actual App/editor, isolated synthetic API. Never contacts preview or devices.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_DANGLING_BRANCH_OUTPUT || ".local/dangling-branch",
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
function branchDocument() {
  const document = baseDocument();
  document.name = "Synthetic dangling branch";
  document.config = {
    sources: {
      seed: { type: "demo_logs", format: "json" },
      dead_source: { type: "demo_logs", format: "json" },
    },
    transforms: {
      guard: { type: "filter", inputs: ["dead_source"], condition: "true" },
      throttle: {
        type: "throttle",
        inputs: ["guard"],
        threshold: 10,
        window_secs: 1,
      },
    },
    sinks: { output: { type: "blackhole", inputs: ["seed"] } },
  };
  // A saved synthetic arrangement keeps the connected row away from the
  // dangling row so a crossing edge cannot look like a throttle output.
  document.graph.nodes = [
    { id: "seed", position: { x: 0, y: 0 } },
    { id: "output", position: { x: 720, y: 0 } },
    { id: "dead_source", position: { x: 0, y: 300 } },
    { id: "guard", position: { x: 360, y: 300 } },
    { id: "throttle", position: { x: 720, y: 300 } },
  ];
  return document;
}
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const card = (id) => node(id).locator(".pipeline-node");
const button = (name) => page.getByRole("button", { name, exact: true });
const menu = (id) =>
  page.getByRole("menu", { name: `Step: ${id}`, exact: true });
async function check(name, run) {
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
async function badge(id, exists = true) {
  await expect(
    node(id).getByText("No destination", { exact: true }),
  ).toHaveCount(exists ? 1 : 0);
  if (exists) {
    await expect(card(id)).toHaveAttribute(
      "data-connectivity",
      "no-destination",
    );
    await expect(
      node(id).getByRole("img", {
        name: `${id}: This branch has no path to a destination. Connect an output to use its events.`,
        exact: true,
      }),
    ).toHaveCount(1);
  } else
    await expect(card(id)).not.toHaveAttribute(
      "data-connectivity",
      "no-destination",
    );
}
async function branchBadges(exists = true) {
  for (const id of ["dead_source", "guard", "throttle"])
    await badge(id, exists);
}
async function openMenu(id) {
  const trigger = node(id).getByRole("button", {
    name: `Actions for ${id}`,
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(menu(id)).toBeVisible();
  return trigger;
}
async function axe(label) {
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({ label, violations: scan.violations });
  expect(scan.violations).toEqual([]);
}
try {
  await check(
    "A terminal throttle and its entire disconnected upstream branch are indicated without blocking validation or changing the draft",
    async () => {
      await load({ document: branchDocument() });
      await branchBadges();
      await badge("seed", false);
      await badge("output", false);
      for (const id of ["dead_source", "guard", "throttle"]) {
        await expect(card(id)).toHaveCSS("opacity", "1");
        await expect(card(id)).toHaveCSS("border-top-style", "dashed");
        await expect(card(id)).not.toHaveClass(/pipeline-node-issue/);
      }
      await page.locator(".editor-check-button").click();
      await expect(page.locator(".editor-check-button")).toHaveAttribute(
        "data-check-state",
        "partial",
      );
      // Check opens the Problems panel; the branch stays a warning there.
      await expect(
        page.getByRole("region", { name: "Problems", exact: true }),
      ).toContainText(
        /throttle[\s\S]*This branch has no path to a destination\./,
      );
      expect(fixture.validations).toHaveLength(1);
      expect(fixture.validations[0].config).toEqual(branchDocument().config);
      expect(fixture.saveAttempts).toEqual([]);
    },
  );

  await check(
    "Keyboard connection, source-endpoint reconnection and Undo update only the affected branch reachability",
    async () => {
      await load({ document: branchDocument(), width: 1440 });
      const original = structuredClone(fixture.document.config);
      await button("throttle output").focus();
      await page.keyboard.press("Enter");
      await button("Input for output").focus();
      await page.keyboard.press("Enter");
      await branchBadges(false);
      const joined = structuredClone(original);
      joined.sinks.output.inputs.push("throttle");
      await saved(joined);
      await button("Undo").click();
      await branchBadges();
      await saved(original);
      const edge = page.locator(
        '.react-flow__edge[aria-label="Connection from seed to output"]',
      );
      await edge.focus();
      await page.keyboard.press("Enter");
      const action = button("Connection actions for seed to output");
      await expect(action).toBeVisible();
      await action.click();
      await expect(
        page.getByRole("menu", { name: "Connection actions", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(action).toBeFocused();
      const start = await edge
        .locator(".react-flow__edgeupdater-source")
        .boundingBox();
      const target = await button("throttle output").boundingBox();
      expect(start).not.toBeNull();
      expect(target).not.toBeNull();
      await page.mouse.move(
        start.x + start.width / 2,
        start.y + start.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        target.x + target.width / 2,
        target.y + target.height / 2,
        { steps: 18 },
      );
      await page.mouse.up();
      const rerouted = structuredClone(original);
      rerouted.sinks.output.inputs = ["throttle"];
      await saved(rerouted);
      await branchBadges(false);
      await badge("seed");
      await button("Undo").click();
      await saved(original);
      await branchBadges();
      await badge("seed", false);
    },
  );

  await check(
    "A dynamic sink input leaves uncertain producer reachability unlabelled rather than falsely declaring a dead branch",
    async () => {
      const document = branchDocument();
      document.config.sinks.output.inputs.push("app_*");
      await load({ document });
      for (const id of ["seed", "dead_source", "guard", "throttle", "output"])
        await badge(id, false);
      expect(fixture.document.config).toEqual(document.config);
      expect(fixture.saveAttempts).toEqual([]);
    },
  );

  await check(
    "A literal route output named output requires the exact named reference; primary source outputs use the bare component ID",
    async () => {
      for (const named of [false, true]) {
        const document = baseDocument();
        document.config = {
          sources: { seed: { type: "demo_logs", format: "json" } },
          transforms: {
            routes: {
              type: "route",
              inputs: ["seed"],
              route: { output: "true" },
              reroute_unmatched: false,
            },
          },
          sinks: {
            output: {
              type: "blackhole",
              inputs: [named ? "routes.output" : "routes"],
            },
          },
        };
        await load({ document });
        await badge("seed", !named);
        await badge("routes", !named);
        await badge("output", false);
        expect(fixture.saveAttempts).toEqual([]);
      }
      const document = baseDocument();
      document.config = {
        sources: { seed: { type: "demo_logs", format: "json" } },
        transforms: {},
        sinks: { output: { type: "blackhole", inputs: ["seed.output"] } },
      };
      await load({ document });
      await badge("seed");
      expect(fixture.saveAttempts).toEqual([]);
    },
  );

  await check(
    "Validation errors and selection retain their stronger cues; read-only nodes keep informative menus and disabled ports",
    async () => {
      const document = branchDocument();
      delete document.config.transforms.throttle.threshold;
      await load({ document });
      await badge("throttle");
      await expect(card("throttle")).toHaveClass(/pipeline-node-issue/);
      await expect(card("throttle")).toHaveCSS("border-top-style", "solid");
      const errorBorder = await card("throttle").evaluate(
        (element) => getComputedStyle(element).borderTopColor,
      );
      await node("throttle").click();
      await expect(card("throttle")).toHaveClass(/pipeline-node-selected/);
      await expect(card("throttle")).toHaveCSS("outline-style", "solid");
      await expect(card("throttle")).toHaveCSS("border-top-color", errorBorder);
      await expect(
        node("throttle").getByRole("img", { name: /threshold/i }),
      ).toBeVisible();
      await load({ document: branchDocument(), role: "viewer" });
      await branchBadges();
      const trigger = await openMenu("throttle");
      await expect(menu("throttle").getByRole("menuitem")).toHaveCount(1);
      await expect(
        menu("throttle").getByRole("menuitem", { name: /Open properties/ }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(button("throttle output")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await expect(button("Input for throttle")).toHaveAttribute(
        "tabindex",
        "-1",
      );
      expect(fixture.saveAttempts).toEqual([]);
    },
  );

  await check(
    "Dangling-state badges and menus remain readable and contained at899/375 light and dark",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await load({ document: branchDocument(), width, height: 1000 });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await branchBadges();
          await button("Fit graph").click();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          const bounds = await card("throttle").evaluate((element) => {
            const card = element.getBoundingClientRect();
            const badge = [...element.querySelectorAll("span")]
              .find((part) => part.textContent === "No destination")
              .getBoundingClientRect();
            return {
              card: {
                x: card.x,
                right: card.right,
                y: card.y,
                bottom: card.bottom,
              },
              badge: {
                x: badge.x,
                right: badge.right,
                y: badge.y,
                bottom: badge.bottom,
              },
              opacity: getComputedStyle(element).opacity,
            };
          });
          expect(bounds.badge.x).toBeGreaterThanOrEqual(bounds.card.x);
          expect(bounds.badge.right).toBeLessThanOrEqual(bounds.card.right);
          expect(bounds.badge.bottom).toBeLessThanOrEqual(bounds.card.bottom);
          measurements.push({ label: `${width} ${theme}`, ...bounds });
          await axe(`Dangling branch ${width} ${theme}`);
          await page.screenshot({
            path: resolve(output, `dangling-${width}-${theme}.png`),
            animations: "disabled",
          });
          const trigger = await openMenu("throttle");
          const box = await menu("throttle").boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          await page.keyboard.press("Escape");
          await expect(trigger).toBeFocused();
          expect(fixture.saveAttempts).toEqual([]);
        }
    },
  );
  expect(results).toHaveLength(6);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const file of [
    "Editor.tsx",
    "PipelineNode.tsx",
    "pipeline-node.css",
    "pipelineConnectivity.ts",
    "catalog.ts",
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
          "Actual App/editor with isolated synthetic API. Dangling source/transform branches, nonblocking validation, keyboard connect/source reconnect/undo, error and selection priorities, readonly actions and899/375 light/dark accessibility. Synthetic draft changes only; no preview, native Vector, real server or device mutations.",
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
