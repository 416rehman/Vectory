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
  process.env.VECTORY_PIPELINE_NODE_OUTPUT || ".local/pipeline-node-redesign",
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
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const button = (name) => page.getByRole("button", { name, exact: true });
const actionMenu = (id) =>
  page.getByRole("menu", { name: `Step: ${id}`, exact: true });
async function openActions(id, keyboard = false) {
  const trigger = node(id).getByRole("button", {
    name: `Actions for ${id}`,
    exact: true,
  });
  if (keyboard) {
    await trigger.focus();
    await page.keyboard.press("Enter");
  } else await trigger.click();
  await expect(actionMenu(id)).toBeVisible();
  return trigger;
}
async function saved(predicate) {
  // Drafts save when asked (Save draft / Ctrl+S); nothing autosaves.
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => predicate(fixture.document), { timeout: 10000 })
    .toBe(true);
  await expect(page.locator(".pipeline-save-status")).toContainText(
    "All changes saved",
  );
}
async function closeInspector() {
  const close = button("Close component settings");
  if (await close.isVisible()) await close.click();
  await expect(page.locator(".editor-inspector")).toHaveCount(0);
}
async function check(name, run) {
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
async function axe(label) {
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({
    label,
    violations: scan.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((n) => n.target),
    })),
  });
  expect(scan.violations, label).toEqual([]);
}
async function geometry(id) {
  return node(id).evaluate((element) => {
    const inner = element.querySelector(".pipeline-node");
    const body = element.querySelector(".pipeline-node-body");
    const bounds = inner.getBoundingClientRect();
    const scale = bounds.width / inner.offsetWidth;
    const handles = [...element.querySelectorAll(".react-flow__handle")].map(
      (handle) => {
        const r = handle.getBoundingClientRect();
        return {
          id: handle.dataset.handleid,
          centerX: (r.x + r.width / 2 - bounds.x) / scale,
          centerY: (r.y + r.height / 2 - bounds.y) / scale,
          width: r.width / scale,
          height: r.height / scale,
        };
      },
    );
    return {
      width: inner.offsetWidth,
      bodyHeight: body.offsetHeight,
      scale,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      handles,
      shadow: getComputedStyle(inner).boxShadow,
    };
  });
}
try {
  await check(
    "ellipsis menu keyboard, dismissal and mutation actions preserve exact undo and pending input guards",
    async () => {
      await load({ width: 899 });
      const original = structuredClone(fixture.document.config);
      const trigger = await openActions("sample", true);
      await expect(actionMenu("sample").getByRole("menuitem")).toHaveCount(4);
      for (const label of [
        "Open properties",
        "Duplicate step",
        "Disconnect connections",
        "Remove step",
      ])
        await expect(
          actionMenu("sample").getByRole("menuitem", {
            name: label,
            exact: false,
          }),
        ).toBeVisible();
      await page.keyboard.press("End");
      await expect(
        page.getByRole("menuitem", { name: "Remove step", exact: false }),
      ).toBeFocused();
      await page.keyboard.press("Home");
      await expect(
        page.getByRole("menuitem", { name: "Open properties", exact: false }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(actionMenu("sample")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await openActions("sample");
      await page.locator(".editor-title").click();
      await expect(actionMenu("sample")).toHaveCount(0);
      expect(fixture.mutations).toEqual([]);
      await openActions("sample");
      await page
        .getByRole("menuitem", { name: "Duplicate step", exact: false })
        .click();
      await expect(node("sample_copy")).toHaveCount(1);
      await saved(
        (doc) =>
          JSON.stringify(doc.config.transforms.sample_copy) ===
          JSON.stringify(original.transforms.sample),
      );
      await closeInspector();
      await button("Undo").click();
      await saved(
        (doc) => JSON.stringify(doc.config) === JSON.stringify(original),
      );
      await openActions("sample");
      await page
        .getByRole("menuitem", { name: "Open properties", exact: false })
        .click();
      const rate = page
        .locator(".editor-inspector")
        .getByLabel("One in every", { exact: true });
      await rate.fill("-");
      await openActions("sample");
      const decision = page.waitForEvent("dialog");
      const remove = page
        .getByRole("menuitem", { name: "Remove step", exact: false })
        .click();
      const dialog = await decision;
      expect(dialog.message()).toMatch(/Discard unapplied field changes/);
      await dialog.dismiss();
      await remove;
      await expect(rate).toHaveValue("-");
      await expect(node("sample")).toHaveCount(1);
      expect(fixture.document.config).toEqual(original);
      await rate.fill("10");
      await closeInspector();
      await openActions("sample");
      await page
        .getByRole("menuitem", { name: "Remove step", exact: false })
        .click();
      await expect(node("sample")).toHaveCount(0);
      await saved((doc) => !doc.config.transforms.sample);
      await button("Undo").click();
      await saved(
        (doc) => JSON.stringify(doc.config) === JSON.stringify(original),
      );
    },
  );
  await check(
    "new card dimensions align main and named ports; keyboard connections preserve exact output identity and undo",
    async () => {
      await load();
      for (const id of ["seed", "sample", "output", "branch"]) {
        const result = await geometry(id);
        measurements.push({ label: `node geometry ${id}`, ...result });
        expect(result.width).toBe(300);
        expect(result.bodyHeight).toBeGreaterThanOrEqual(182);
        expect(result.bodyHeight).toBeLessThanOrEqual(184);
        for (const handle of result.handles.filter(
          (h) => h.id === "input" || h.id === "output",
        ))
          expect(Math.abs(handle.centerY - 80)).toBeLessThan(2);
      }
      const branch = await geometry("branch");
      const accepted = branch.handles.find((h) => h.id === "accepted");
      const unmatched = branch.handles.find((h) => h.id === "_unmatched");
      expect(accepted.centerY).toBeGreaterThanOrEqual(184);
      expect(unmatched.centerY).toBeGreaterThan(accepted.centerY);
      const original = structuredClone(fixture.document.config);
      await button("branch _unmatched output").focus();
      await page.keyboard.press("Enter");
      await button("Input for other").focus();
      await page.keyboard.press("Enter");
      await saved((doc) =>
        doc.config.sinks.other.inputs.includes("branch._unmatched"),
      );
      expect(fixture.document.config.sinks.other.inputs).toEqual([
        "sample",
        "branch._unmatched",
      ]);
      expect(fixture.document.config.sinks.output.inputs).toEqual([
        "branch.accepted",
      ]);
      await button("Undo").click();
      await saved(
        (doc) => JSON.stringify(doc.config) === JSON.stringify(original),
      );
    },
  );
  await check(
    "long identities and summaries remain contained while selected and invalid nodes retain explicit cues",
    async () => {
      const document = baseDocument();
      const id =
        "sample_with_a_very_long_component_identity_that_must_not_cover_the_menu_or_ports";
      document.config.transforms[id] = {
        ...document.config.transforms.sample,
        inputs: ["missing_source"],
      };
      delete document.config.transforms.sample;
      document.config.sinks.other.inputs = [id];
      document.config.sources.seed = {
        type: "file",
        include: [
          "/var/log/very-long-directory-name/another-long-directory/application-json-events-*.log",
        ],
      };
      await load({ document, width: 899 });
      await expect(node(id).locator(".pipeline-node-identity")).toHaveText(id);
      await expect(node(id).locator(".pipeline-node-identity")).toHaveAttribute(
        "title",
        `Component ID: ${id}`,
      );
      await expect(node(id).locator(".pipeline-node-issue")).toHaveCount(1);
      await expect(node(id).getByRole("img", { name: /./ })).toBeVisible();
      await node(id).click();
      await expect(node(id).locator(".pipeline-node-selected")).toHaveCount(1);
      const widths = await node(id).evaluate((element) => {
        const card = element
          .querySelector(".pipeline-node")
          .getBoundingClientRect();
        const identity = element
          .querySelector(".pipeline-node-identity")
          .getBoundingClientRect();
        const menu = element
          .querySelector('[data-node-action="menu"]')
          .getBoundingClientRect();
        return {
          card: { x: card.x, right: card.right },
          identity: { x: identity.x, right: identity.right },
          menu: { x: menu.x, right: menu.right },
        };
      });
      measurements.push({ label: "long component identity", ...widths });
      expect(widths.identity.x).toBeGreaterThanOrEqual(widths.card.x);
      expect(widths.identity.right).toBeLessThanOrEqual(widths.card.right);
      expect(widths.menu.right).toBeLessThanOrEqual(widths.card.right);
      await closeInspector();
      await openActions(id);
      const menuBox = await actionMenu(id).boundingBox();
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(899);
      await page.keyboard.press("Escape");
      expect(fixture.mutations).toEqual([]);
    },
  );
  await check(
    "source transform and destination cards plus menus remain accessible at899/375 light and dark",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await load({ width, height: 1000 });
          await page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            theme,
          );
          for (const [id, label] of [
            ["seed", "Source"],
            ["sample", "Transform"],
            ["output", "Destination"],
          ])
            await expect(node(id).locator(".pipeline-node-kind")).toHaveText(
              label,
            );
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await axe(`node cards ${width} ${theme}`);
          await page.screenshot({
            path: resolve(output, `node-cards-${width}-${theme}.png`),
            animations: "disabled",
          });
          const opener = await openActions("sample");
          const r = await actionMenu("sample").boundingBox();
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.x + r.width).toBeLessThanOrEqual(width);
          expect(r.y + r.height).toBeLessThanOrEqual(1000);
          await axe(`node menu ${width} ${theme}`);
          await page.screenshot({
            path: resolve(output, `node-menu-${width}-${theme}.png`),
            animations: "disabled",
          });
          await page.keyboard.press("Escape");
          await expect(opener).toBeFocused();
          expect(fixture.mutations).toEqual([]);
        }
    },
  );
  await check(
    "viewer and archived cards expose properties only and cannot connect or mutate",
    async () => {
      for (const options of [{ role: "viewer" }, { archived: true }]) {
        await load(options);
        const opener = await openActions("sample", true);
        await expect(actionMenu("sample").getByRole("menuitem")).toHaveCount(1);
        await page
          .getByRole("menuitem", { name: "Open properties", exact: false })
          .click();
        await expect(
          page
            .locator(".editor-inspector")
            .getByLabel("One in every", { exact: true }),
        ).toHaveAttribute("readonly", "");
        await closeInspector();
        await expect(button("branch accepted output")).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await expect(button("branch accepted output")).toHaveAttribute(
          "tabindex",
          "-1",
        );
        await opener.focus();
        expect(fixture.mutations).toEqual([]);
      }
    },
  );
  expect(results).toHaveLength(5);
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
    "pipelineNodeModel.ts",
    "pipelineEditing.ts",
    "CanvasActionMenu.tsx",
    "canvas-action-menu.css",
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
          "Actual App/editor with isolated synthetic API. Node presentation, ellipsis/keyboard actions, undo and pending input protection, exact named-output connection identity, readonly and responsive accessibility. All writes remain disposable fixture state; no preview/server/device requests.",
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
