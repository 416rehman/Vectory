// Actual App/editor, isolated synthetic API. Never contacts preview or devices.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import {
  isPipelineTelemetry,
  pipelineTelemetry,
} from "./telemetry-replies.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const menuLayoutOnly =
  process.env.VECTORY_EDITOR_CANVAS_FOCUS === "menu-layout";
const checksLayoutOnly =
  process.env.VECTORY_EDITOR_CANVAS_FOCUS === "check-results";
const checkStateOnly =
  process.env.VECTORY_EDITOR_CANVAS_FOCUS === "check-state";
const splitSaveOnly = process.env.VECTORY_EDITOR_CANVAS_FOCUS === "split-save";
const connectionStyleOnly =
  process.env.VECTORY_EDITOR_CANVAS_FOCUS === "connection-style";
const editorHeaderOnly =
  process.env.VECTORY_EDITOR_CANVAS_FOCUS === "editor-header";
const editorHeaderLayoutOnly =
  editorHeaderOnly && process.env.VECTORY_EDITOR_HEADER_LAYOUT_ONLY === "true";
const splitSaveFollowup =
  splitSaveOnly && process.env.VECTORY_EDITOR_SPLIT_SAVE_FOLLOWUP === "true";
const nodeActionsOnly =
  process.env.VECTORY_EDITOR_CANVAS_FOCUS === "node-actions";
const variablesOnly = process.env.VECTORY_EDITOR_CANVAS_FOCUS === "variables";
const output = resolve(
  repository,
  process.env.VECTORY_EDITOR_CANVAS_OUTPUT ||
    (editorHeaderOnly
      ? ".local/editor-header"
      : connectionStyleOnly
        ? ".local/editor-connection-style"
        : splitSaveOnly
          ? ".local/editor-split-save"
          : checkStateOnly
            ? ".local/editor-check-state"
            : nodeActionsOnly
              ? ".local/inspector-node-actions"
              : variablesOnly
                ? ".local/editor-variables"
                : checksLayoutOnly
                  ? ".local/editor-canvas-check-results"
                  : menuLayoutOnly
                    ? ".local/editor-canvas-menu-layout"
                    : ".local/editor-canvas-component"),
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
    variables: [],
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
  autoCheck = false,
  document = baseDocument(),
} = {}) {
  // Closing an old isolated context cannot affect the synthetic persisted fixture.
  if (page) await page.context().close();
  fixture = {
    document: structuredClone(document),
    mutations: [],
    validations: [],
    validationValid: true,
    validationNative: false,
    validationError: false,
    holdValidation: false,
    pendingValidations: [],
    holdSave: false,
    failSave: false,
    readsUnavailable: false,
    holdReads: false,
    pendingReads: [],
    published,
    historyUnavailable: false,
    holdHistory: false,
    pendingHistory: [],
    versionUnavailable: false,
    holdVersion: false,
    pendingVersion: [],
    versionIdentityMismatch: false,
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
  await context.addInitScript(
    ({ collapsed, autoCheck }) => {
      localStorage.setItem("vectory-sidebar-collapsed", String(collapsed));
      localStorage.setItem("vectory-theme", "light");
      // Checks run only when a case asks, so request counts stay exact.
      if (!localStorage.getItem("vectory.editor.auto-check"))
        localStorage.setItem("vectory.editor.auto-check", autoCheck);
    },
    { collapsed, autoCheck: autoCheck ? "on" : "off" },
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
      // The publish review shows where versions are assigned.
      if (path === "/devices") return reply([]);
      // The editor reads whether a device runs a published pipeline.
      if (isPipelineTelemetry(path, pipelineId))
        return reply(pipelineTelemetry(pipelineId));
      if (path === "/settings")
        return reply({ instance_name: "Synthetic isolated editor" });
      if (path === `/configurations/${pipelineId}`) {
        if (current.readsUnavailable) {
          return reject("TEMPORARY_FAILURE", "Synthetic read unavailable", 503);
        }
        if (current.holdReads) {
          const snapshot = structuredClone(current.document);
          await new Promise((resolve) => current.pendingReads.push(resolve));
          return reply(snapshot);
        }
        return reply(current.document);
      }
      if (path === `/configurations/${pipelineId}/history`) {
        const hasPublishedVersion = current.published;
        if (current.historyUnavailable)
          return reject(
            "TEMPORARY_FAILURE",
            "Version history unavailable",
            503,
          );
        if (current.holdHistory)
          await new Promise((resolve) => current.pendingHistory.push(resolve));
        return reply({
          items: hasPublishedVersion
            ? [
                {
                  id: "33333333-3333-4333-8333-333333333333",
                  configuration_id: pipelineId,
                  created_at: created,
                },
              ]
            : [],
          total: hasPublishedVersion ? 1 : 0,
          page: 1,
          page_size: Number(url.searchParams.get("page_size")),
          kind: "versions",
        });
      }
      if (path === "/versions/33333333-3333-4333-8333-333333333333") {
        if (current.versionUnavailable)
          return reject(
            "TEMPORARY_FAILURE",
            "Published version unavailable",
            503,
          );
        if (current.holdVersion)
          await new Promise((resolve) => current.pendingVersion.push(resolve));
        return reply({
          id: current.versionIdentityMismatch
            ? "44444444-4444-4444-8444-444444444444"
            : "33333333-3333-4333-8333-333333333333",
          configuration_id: current.versionIdentityMismatch
            ? "55555555-5555-4555-8555-555555555555"
            : pipelineId,
          number: 1,
          graph: document.graph,
          config: document.config,
          variables: document.variables || [],
          artifact: JSON.stringify(document.config),
          sha256: "0".repeat(64),
          size: JSON.stringify(document.config).length,
          created_at: created,
          message: "Synthetic published version",
          // What the server stores with a version that Vector accepted.
          validation: {
            valid: true,
            vector_validated: true,
            static_checked: true,
            deferred: false,
            vector_version: "0.58.0",
            errors: [],
            warnings: [],
            diagnostics: [],
          },
        });
      }
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
        variables: body.variables ?? current.document.variables,
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
      const native = current.validationNative;
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
        vector_validated: valid && native,
        static_checked: true,
        deferred: !native,
        deferred_reasons: native ? [] : ["environment variables"],
        placeholders: [],
        diagnostics: valid
          ? []
          : [
              {
                severity: "error",
                section: "transforms",
                component: "sample",
                field: "rate",
                code: "invalid_value",
                message: "Synthetic configuration rejected",
              },
            ],
        errors: valid ? [] : ["sample: Synthetic configuration rejected"],
        warnings: [],
        vector_version: "0.58.0",
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
async function check(name, run) {
  if (editorHeaderLayoutOnly && !name.startsWith("read-only metadata")) return;
  if (
    splitSaveFollowup &&
    !name.startsWith("explicit saves") &&
    !name.startsWith("split controls")
  )
    return;
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
async function fieldJSON(title) {
  await page
    .getByRole("button", { name: `Actions for ${title}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: `Edit ${title} as JSON`, exact: true })
    .click();
  const input = page.getByRole("textbox", {
    name: `${title} (JSON)`,
    exact: true,
  });
  await expect(input).toBeVisible();
  return input;
}
async function noOverflow(label) {
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  measurements.push({ label, ...dimensions });
  expect(dimensions.scroll, label).toBeLessThanOrEqual(dimensions.viewport + 1);
}
async function axe(label) {
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({
    label,
    violations: scan.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  });
  expect(scan.violations, label).toEqual([]);
}
async function blankPoint() {
  return page.locator(".react-flow").evaluate((element) => {
    const r = element.getBoundingClientRect();
    // On a phone an open menu spans the width; the strips at the edges stay canvas.
    for (const dy of [0.75, 0.65, 0.55, 0.35, 0.25, 0.85])
      for (const dx of [0.72, 0.84, 0.55, 0.4, 0.2, 0.008, 0.99]) {
        const x = r.x + r.width * dx,
          y = r.y + r.height * dy;
        if (
          document
            .elementFromPoint(x, y)
            ?.classList.contains("react-flow__pane")
        )
          return { x, y };
      }
    throw Error("No unobstructed canvas point in the synthetic fixture");
  });
}
async function dragHandle(node, handle, target) {
  const locator = page.locator(
    `.react-flow__node[data-id="${node}"] .react-flow__handle[data-handleid="${handle}"]`,
  );
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();
}
async function saved(predicate) {
  await button("Save options").click();
  await page.getByRole("menuitem", { name: "Save draft", exact: true }).click();
  await expect
    .poll(() => predicate(fixture.document), { timeout: 10000 })
    .toBe(true);
  await expect(page.locator(".pipeline-save-status")).toContainText(
    "All changes saved",
  );
}
const menu = () =>
  page.getByRole("dialog", { name: "Add component", exact: true });
const button = (name) => page.getByRole("button", { name, exact: true });
// The Check button's name carries its state: "Check pipeline: 3 problems".
const checkButton = () =>
  page
    .locator('.editor-toolbar[aria-label="Pipeline toolbar"]')
    .getByRole("button", { name: /^Check pipeline: / });
const problemsPanel = () =>
  page.getByRole("region", { name: "Problems", exact: true });
async function choose(type, category) {
  if (category)
    await menu().getByRole("button", { name: category, exact: true }).click();
  await menu().getByRole("textbox", { name: "Search components" }).fill(type);
  await expect(menu().locator(".canvas-component-result")).toHaveCount(1);
  await menu()
    .getByRole("textbox", { name: "Search components" })
    .press("Enter");
  await expect(menu()).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator(".editor-inspector")
        .evaluate((inspector) => inspector.contains(document.activeElement)),
    )
    .toBe(true);
}
async function flowPoint(point) {
  return page.locator(".react-flow").evaluate((element, point) => {
    const rect = element.getBoundingClientRect();
    const transform = new DOMMatrix(
      getComputedStyle(element.querySelector(".react-flow__viewport"))
        .transform,
    );
    return {
      x: (point.x - rect.left - transform.e) / transform.a,
      y: (point.y - rect.top - transform.f) / transform.d,
    };
  }, point);
}
async function positioned(id, expected) {
  const node = fixture.document.graph.nodes.find((node) => node.id === id);
  expect(node).toBeTruthy();
  // Chromium quantizes dispatched client coordinates to CSS pixels; at the
  // exercised zoom levels this is less than 2.5 flow units, not a layout shift.
  expect(Math.abs(node.position.x - expected.x)).toBeLessThan(2.5);
  expect(Math.abs(node.position.y - expected.y)).toBeLessThan(2.5);
  measurements.push({
    label: "persisted drop coordinates",
    id,
    expected,
    actual: node.position,
  });
}
async function closeInspector() {
  const close = button("Close component settings");
  if (await close.isVisible()) await close.click();
  await expect(page.locator(".editor-inspector")).toHaveCount(0);
}
async function dismissConfirmation(action) {
  const nextDialog = page.waitForEvent("dialog", { timeout: 5000 });
  const clicked = action();
  const dialog = await nextDialog;
  expect(dialog.message()).toMatch(/Discard unapplied field changes/);
  await dialog.dismiss();
  await clicked;
}

try {
  if (editorHeaderOnly) {
    const details = () =>
      page.getByRole("dialog", { name: "Pipeline details", exact: true });
    const nameButton = () =>
      page.getByRole("button", { name: /^(Edit|View) pipeline details: / });
    const descriptionButton = () =>
      page.getByRole("button", { name: /^(Edit|View) pipeline description$/ });
    const status = () => page.locator(".pipeline-save-status");
    const state = (value) =>
      expect(status()).toHaveAttribute("data-save-state", value);
    const rate = () =>
      page
        .locator(".editor-inspector")
        .getByRole("textbox", { name: "One in every", exact: true });
    async function sample() {
      await page.locator('.react-flow__node[data-id="sample"]').click();
      await expect(rate()).toBeVisible();
    }
    async function cancelChanged() {
      const decision = page.waitForEvent("dialog");
      const action = details()
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      const dialog = await decision;
      expect(dialog.message()).toBe("Discard changes to pipeline details?");
      await dialog.accept();
      await action;
      await expect(details()).toHaveCount(0);
    }
    async function explicitSave() {
      await button("Save options").click();
      await page
        .getByRole("menuitem", { name: "Save draft", exact: true })
        .click();
    }
    await check(
      "name and description are keyboard-accessible prefilled detail controls; cancellation preserves metadata",
      async () => {
        await load();
        const original = structuredClone(fixture.document);
        await nameButton().focus();
        await page.keyboard.press("Enter");
        await expect(details()).toBeVisible();
        await expect(
          details().getByLabel("Pipeline name", { exact: true }),
        ).toHaveValue(original.name);
        await expect(
          details().getByLabel("Description", { exact: true }),
        ).toHaveValue(original.description);
        await details()
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(nameButton()).toBeFocused();
        await descriptionButton().click();
        await details()
          .getByLabel("Description", { exact: true })
          .fill("Do not save this cancelled text");
        const pendingDecision = page.waitForEvent("dialog");
        const escape = page.keyboard.press("Escape");
        const decision = await pendingDecision;
        expect(decision.message()).toBe("Discard changes to pipeline details?");
        await decision.dismiss();
        await escape;
        await expect(details()).toBeVisible();
        await expect(
          details().getByLabel("Description", { exact: true }),
        ).toHaveValue("Do not save this cancelled text");
        await cancelChanged();
        expect(fixture.document).toEqual(original);
        expect(fixture.saveAttempts).toEqual([]);
        await load({ document: { ...baseDocument(), description: "" } });
        await expect(descriptionButton()).toHaveText("Add description");
        await descriptionButton().click();
        await expect(
          details().getByLabel("Description", { exact: true }),
        ).toHaveValue("");
        await details()
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        expect(fixture.saveAttempts).toEqual([]);
      },
    );
    await check(
      "metadata saves preserve configuration and CAS; busy, failure and stale responses retain entered details",
      async () => {
        await load();
        const original = structuredClone(fixture.document.config);
        await nameButton().click();
        await details()
          .getByLabel("Pipeline name", { exact: true })
          .fill("  Renamed synthetic pipeline  ");
        await details()
          .getByLabel("Description", { exact: true })
          .fill("A saved synthetic description");
        fixture.holdSave = true;
        await details()
          .getByRole("button", { name: "Save details", exact: true })
          .click();
        await expect.poll(() => fixture.pendingSaves.length).toBe(1);
        await expect(
          details().getByLabel("Pipeline name", { exact: true }),
        ).toBeDisabled();
        await expect(
          details().getByRole("button", { name: "Cancel", exact: true }),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(details()).toBeVisible();
        fixture.pendingSaves.shift()(false);
        await expect(details()).toHaveCount(0);
        expect(fixture.document.name).toBe("Renamed synthetic pipeline");
        expect(fixture.document.description).toBe(
          "A saved synthetic description",
        );
        expect(fixture.document.config).toEqual(original);
        expect(fixture.saveAttempts).toHaveLength(1);
        expect(fixture.saveAttempts[0].revision).toBe(1);
        fixture.holdSave = false;
        fixture.failSave = true;
        await descriptionButton().click();
        await details()
          .getByLabel("Description", { exact: true })
          .fill("Retry me without losing input");
        await details()
          .getByRole("button", { name: "Save details", exact: true })
          .click();
        await expect(details()).toContainText("Your changes are still here");
        await expect(
          details().getByLabel("Description", { exact: true }),
        ).toHaveValue("Retry me without losing input");
        expect(fixture.document.revision).toBe(2);
        fixture.failSave = false;
        await details()
          .getByRole("button", { name: "Save details", exact: true })
          .click();
        await expect(details()).toHaveCount(0);
        expect(fixture.document.description).toBe(
          "Retry me without losing input",
        );
        await expect(
          page.getByText("Synthetic draft save failed", { exact: true }),
        ).toHaveCount(0);
        await nameButton().click();
        await details()
          .getByLabel("Pipeline name", { exact: true })
          .fill("Stale local title");
        fixture.document = {
          ...fixture.document,
          revision: fixture.document.revision + 1,
          name: "Concurrent server title",
        };
        const actual = structuredClone(fixture.document);
        await details()
          .getByRole("button", { name: "Save details", exact: true })
          .click();
        await expect(details()).toContainText("Your changes are still here");
        await expect(
          details().getByLabel("Pipeline name", { exact: true }),
        ).toHaveValue("Stale local title");
        expect(fixture.document).toEqual(actual);
        expect(fixture.mutations).toHaveLength(2);
        await cancelChanged();
      },
    );
    await check(
      "header opening respects pending fields; segmented Graph and Code retain parsing guards and connection preference",
      async () => {
        await load();
        await sample();
        await rate().fill("-");
        await dismissConfirmation(() => nameButton().click());
        await expect(details()).toHaveCount(0);
        await expect(rate()).toHaveValue("-");
        await rate().fill("10");
        await closeInspector();
        await button("Connection style").click();
        await page
          .getByRole("menuitemradio", { name: "Straight", exact: true })
          .click();
        await button("Code").click();
        await expect(button("Code")).toHaveAttribute("aria-pressed", "true");
        await page.getByLabel("Format", { exact: true }).selectOption("json");
        const code = page.getByRole("textbox", {
          name: "Vector configuration code",
          exact: true,
        });
        await code.fill("{invalid fixture");
        await button("Graph").click();
        await expect(button("Code")).toHaveAttribute("aria-pressed", "true");
        await expect(code).toHaveText("{invalid fixture");
        await expect(button("Graph")).toHaveAttribute("aria-pressed", "false");
        await button("Discard code changes").click();
        await button("Graph").click();
        await expect(button("Graph")).toHaveAttribute("aria-pressed", "true");
        await expect(
          page.locator(".react-flow__edge-path").first(),
        ).toHaveAttribute("data-connection-style", "straight");
        expect(fixture.document.config).toEqual(baseDocument().config);
      },
    );
    await check(
      "quiet save indicator follows saved, pending, unsaved, saving and failure transitions outside the title",
      async () => {
        await load();
        await state("saved");
        await expect(
          page.locator(".editor-title .pipeline-save-status"),
        ).toHaveCount(0);
        await expect(
          page.locator(".editor-header-actions .pipeline-save-status"),
        ).toBeVisible();
        await sample();
        await rate().fill("-");
        await state("unapplied");
        await rate().fill("20");
        await state("unsaved");
        fixture.holdSave = true;
        await explicitSave();
        await expect.poll(() => fixture.pendingSaves.length).toBe(1);
        await state("saving");
        fixture.pendingSaves.shift()(true);
        await state("failed");
        await expect(rate()).toHaveValue("20");
        fixture.holdSave = false;
        await explicitSave();
        await state("saved");
        expect(fixture.document.config.transforms.sample.rate).toBe(20);
        await load({ published: true });
        await state("saved");
        await expect(status()).toHaveAttribute("title", /Published version 1/);
        await load({ archived: true });
        await state("saved");
        await expect(status()).toHaveAttribute("title", /Archived/);
      },
    );
    await check(
      "read-only metadata and responsive header controls preserve permission boundaries and accessible layout",
      async () => {
        for (const test of [{ role: "viewer" }, { archived: true }]) {
          await load(test);
          await nameButton().click();
          await expect(
            details().getByLabel("Pipeline name", { exact: true }),
          ).toHaveAttribute("readonly", "");
          await expect(
            details().getByLabel("Description", { exact: true }),
          ).toHaveAttribute("readonly", "");
          await expect(
            details().getByRole("button", {
              name: "Save details",
              exact: true,
            }),
          ).toHaveCount(0);
          await details()
            .getByRole("button", { name: "Close", exact: true })
            .click();
          expect(fixture.saveAttempts).toEqual([]);
        }
        for (const sample of [
          { width: 899, theme: "light" },
          { width: 899, theme: "dark" },
          { width: 375, theme: "light" },
          { width: 375, theme: "dark" },
        ]) {
          await load({ width: sample.width, height: 900 });
          await page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            sample.theme,
          );
          await noOverflow(`editor header ${sample.width} ${sample.theme}`);
          const geometry = await page.evaluate(() =>
            Object.fromEntries(
              [
                ".editor-title",
                ".page-title-row",
                ".page-title-row h1",
                ".editor-name-trigger",
                ".editor-name-trigger > span",
                ".editor-name-trigger > svg",
              ].map((selector) => {
                const element = document.querySelector(selector),
                  box = element.getBoundingClientRect(),
                  css = getComputedStyle(element);
                return [
                  selector,
                  {
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                    display: css.display,
                    maxWidth: css.maxWidth,
                    gridTemplateColumns: css.gridTemplateColumns,
                    flex: css.flex,
                    whiteSpace: css.whiteSpace,
                    margin: css.margin,
                  },
                ];
              }),
            ),
          );
          measurements.push({
            label: `header geometry ${sample.width} ${sample.theme}`,
            geometry,
          });
          await expect(status()).toBeVisible();
          await expect(nameButton()).toBeVisible();
          await expect(descriptionButton()).toBeVisible();
          await axe(`editor header ${sample.width} ${sample.theme}`);
          await page.screenshot({
            path: resolve(
              output,
              `editor-header-${sample.width}-${sample.theme}.png`,
            ),
            animations: "disabled",
          });
          await nameButton().click();
          await axe(`pipeline details ${sample.width} ${sample.theme}`);
          await page.screenshot({
            path: resolve(
              output,
              `pipeline-details-${sample.width}-${sample.theme}.png`,
            ),
            animations: "disabled",
          });
          await details()
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
        }
      },
    );
    expect(results).toHaveLength(editorHeaderLayoutOnly ? 1 : 5);
  } else if (connectionStyleOnly) {
    const styles = [
      { value: "curved", label: "Curved" },
      { value: "orthogonal", label: "Right-angle" },
      { value: "straight", label: "Straight" },
    ];
    const selector = () => button("Connection style");
    const paths = () => page.locator(".react-flow__edge-path");
    const preview = () => page.locator(".react-flow__connection-path");
    async function setStyle(style) {
      await selector().click();
      await page
        .getByRole("menuitemradio", { name: style.label, exact: true })
        .click();
      await expect(paths().first()).toHaveAttribute(
        "data-connection-style",
        style.value,
      );
    }
    function assertShape(path, style) {
      expect(path).toMatch(/^M/);
      if (style === "curved") expect(path).toMatch(/C/);
      else if (style === "straight") {
        expect(path.match(/[MLCQHVSAZT]/gi)).toEqual(["M", "L"]);
      } else {
        expect(path).toMatch(/L/);
        expect(path).not.toMatch(/[CA]/i);
      }
    }
    async function beginConnection() {
      const handle = page.locator(
        '.react-flow__node[data-id="branch"] .react-flow__handle[data-handleid="accepted"]',
      );
      const box = await handle.boundingBox();
      expect(box).not.toBeNull();
      const destination = await blankPoint();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(destination.x, destination.y, { steps: 10 });
      await expect(preview()).toBeVisible();
    }
    await check(
      "three real edge shapes persist locally without saving or invalidating the checked draft",
      async () => {
        await load();
        const initial = structuredClone(fixture.document);
        await expect(paths().first()).toHaveAttribute(
          "data-connection-style",
          "curved",
        );
        await checkButton().click();
        await expect(checkButton()).toHaveAttribute(
          "data-check-state",
          "device",
        );
        const shapeSets = [];
        for (const style of styles) {
          await setStyle(style);
          const actual = await paths().evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("d")),
          );
          actual.forEach((path) => assertShape(path, style.value));
          shapeSets.push(actual);
          expect(
            await page.evaluate(() =>
              localStorage.getItem("vectory-connection-style"),
            ),
          ).toBe(style.value);
          await expect(checkButton()).toHaveAttribute(
            "data-check-state",
            "device",
          );
          await expect(button("Discard changes")).toHaveCount(0);
          await expect(button("Undo")).toBeDisabled();
        }
        expect(
          new Set(shapeSets.map((paths) => JSON.stringify(paths))).size,
        ).toBe(3);
        // Observe beyond the draft autosave debounce; a presentation preference
        // must not queue a delayed draft write.
        await page.waitForTimeout(2250);
        expect(fixture.document).toEqual(initial);
        expect(fixture.mutations).toEqual([]);
        expect(fixture.saveAttempts).toEqual([]);
        expect(fixture.validations).toHaveLength(1);
        await page.reload();
        await expect(paths().first()).toHaveAttribute(
          "data-connection-style",
          "straight",
        );
        expect(fixture.document).toEqual(initial);
        expect(fixture.saveAttempts).toEqual([]);
        await page.evaluate(() =>
          localStorage.setItem(
            "vectory-connection-style",
            "invalid-fixture-value",
          ),
        );
        await page.reload();
        await expect(paths().first()).toHaveAttribute(
          "data-connection-style",
          "curved",
        );
        measurements.push({
          label: "actual edge path commands",
          shapes: shapeSets,
        });
      },
    );
    await check(
      "live connection preview matches each style and Escape cancels without a graph write",
      async () => {
        await load();
        const initial = structuredClone(fixture.document);
        for (const style of styles) {
          await setStyle(style);
          await beginConnection();
          const path = await preview().getAttribute("d");
          assertShape(path, style.value);
          measurements.push({ label: style.label + " drag preview", path });
          await page.keyboard.press("Escape");
          await page.mouse.up();
          await expect(preview()).toHaveCount(0);
          await expect(menu()).toHaveCount(0);
        }
        expect(fixture.document).toEqual(initial);
        expect(fixture.saveAttempts).toEqual([]);
      },
    );
    await check(
      "styled selected connection retains its action menu, endpoint reconnect and exact undo",
      async () => {
        await load();
        await setStyle(styles[1]);
        const original = structuredClone(fixture.document.config);
        const edge = page.locator(
          '.react-flow__edge[aria-label="Connection from branch.accepted to output"]',
        );
        await edge.focus();
        await page.keyboard.press("Enter");
        const action = button("Connection actions for branch to output");
        await expect(action).toBeVisible();
        await action.click();
        const actions = page.getByRole("menu", {
          name: "Connection actions",
          exact: true,
        });
        await expect(
          actions.getByRole("menuitem", { name: "Disconnect", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(action).toBeFocused();
        const endpoint = edge.locator(".react-flow__edgeupdater-target");
        const start = await endpoint.boundingBox();
        const target = await page
          .locator(
            '.react-flow__node[data-id="other"] .react-flow__handle[data-handleid="input"]',
          )
          .boundingBox();
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
          { steps: 15 },
        );
        await page.mouse.up();
        await saved(
          (doc) =>
            doc.config.sinks.output.inputs.length === 0 &&
            doc.config.sinks.other.inputs.includes("branch.accepted"),
        );
        expect(fixture.document.config.sinks.other.inputs).toEqual([
          "sample",
          "branch.accepted",
        ]);
        await button("Undo").click();
        await saved(
          (doc) => JSON.stringify(doc.config) === JSON.stringify(original),
        );
        await expect(paths().first()).toHaveAttribute(
          "data-connection-style",
          "orthogonal",
        );
      },
    );
    await check(
      "read-only users may choose local line style; neutral Add picker and responsive controls stay accessible",
      async () => {
        await load({ role: "viewer" });
        await setStyle(styles[2]);
        expect(fixture.saveAttempts).toEqual([]);
        await expect(button("Add component")).toHaveCount(0);
        for (const sample of [
          { width: 899, theme: "light" },
          { width: 899, theme: "dark" },
          { width: 375, theme: "light" },
          { width: 375, theme: "dark" },
        ]) {
          await load({ width: sample.width, height: 900 });
          await page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            sample.theme,
          );
          await setStyle(styles[1]);
          await noOverflow(
            `connection controls ${sample.width} ${sample.theme}`,
          );
          const fab = button("Add component");
          await expect(fab).toHaveCSS("border-radius", "6px");
          await selector().click();
          await expect(
            page.getByRole("menuitemradio", {
              name: "Right-angle",
              exact: true,
            }),
          ).toHaveAttribute("aria-checked", "true");
          await axe(`connection style ${sample.width} ${sample.theme}`);
          await page.screenshot({
            path: resolve(
              output,
              `connection-style-${sample.width}-${sample.theme}.png`,
            ),
            animations: "disabled",
          });
          await page.keyboard.press("Escape");
          await expect(selector()).toBeFocused();
          await fab.click();
          await expect(menu()).toBeVisible();
          await expect(
            menu().getByRole("textbox", { name: "Search components" }),
          ).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(fab).toBeFocused();
          expect(fixture.saveAttempts).toEqual([]);
        }
      },
    );
    expect(results).toHaveLength(4);
  } else if (variablesOnly) {
    const settings = () =>
      page.getByRole("dialog", { name: "Pipeline settings" });
    const openVariables = async () => {
      await button("Pipeline settings").click();
      await settings()
        .getByRole("button", { name: "Variables", exact: true })
        .click();
    };
    await check(
      "variable declarations join explicit draft save, discard, and read-only boundaries",
      async () => {
        await load();
        await openVariables();
        await settings()
          .getByRole("combobox", { name: "Pipeline field" })
          .selectOption("/sources/seed/format");
        await settings()
          .getByRole("textbox", { name: "Variable name" })
          .fill("LOG_FORMAT");
        await settings().getByRole("button", { name: "Add variable" }).click();
        await expect(
          settings().getByRole("list", { name: "Pipeline variables" }),
        ).toContainText("LOG_FORMAT");
        await settings().getByRole("button", { name: "Done" }).click();
        await expect(button("Discard changes")).toBeVisible();
        await saved((doc) => doc.variables?.[0]?.name === "LOG_FORMAT");
        expect(fixture.saveAttempts.at(-1).variables).toEqual([
          { name: "LOG_FORMAT", path: "/sources/seed/format", type: "string" },
        ]);
        await openVariables();
        await settings()
          .getByRole("button", { name: "Remove variable LOG_FORMAT" })
          .click();
        await settings().getByRole("button", { name: "Done" }).click();
        await button("Discard changes").click();
        await page
          .getByRole("dialog", { name: "Discard unsaved changes?" })
          .getByRole("button", { name: "Discard changes" })
          .click();
        await openVariables();
        await expect(
          settings().getByRole("list", { name: "Pipeline variables" }),
        ).toContainText("LOG_FORMAT");
        await axe("variable declarations light");
        await settings().getByRole("button", { name: "Done" }).click();
        expect(fixture.saveAttempts).toHaveLength(1);
      },
    );
    await check(
      "viewers can inspect declarations without changing them",
      async () => {
        const document = baseDocument();
        document.variables = [
          { name: "LOG_FORMAT", path: "/sources/seed/format", type: "string" },
        ];
        await load({ role: "viewer", document, width: 899 });
        await openVariables();
        await expect(
          settings().getByRole("list", { name: "Pipeline variables" }),
        ).toContainText("LOG_FORMAT");
        await expect(
          settings().getByRole("button", { name: "Add variable" }),
        ).toHaveCount(0);
        await expect(
          settings().getByRole("button", {
            name: "Remove variable LOG_FORMAT",
          }),
        ).toHaveCount(0);
        await page.evaluate(
          () => (document.documentElement.dataset.theme = "dark"),
        );
        await axe("variable declarations viewer dark");
        expect(fixture.saveAttempts).toEqual([]);
      },
    );
    expect(results).toHaveLength(2);
  } else if (splitSaveOnly) {
    // While saving, the button shows a loading indicator in its name.
    const saveButton = () =>
      page.locator(".editor-toolbar .editor-save-button");
    const trigger = () => button("Save options");
    const saveMenu = () =>
      page.getByRole("menu", { name: "Save options", exact: true });
    const saveItem = () =>
      saveMenu().getByRole("menuitem", { name: "Save draft", exact: true });
    const noteItem = () =>
      saveMenu().getByRole("menuitem", {
        name: "Save with note…",
        exact: true,
      });
    const openSave = async () => {
      await trigger().click();
      await expect(saveMenu()).toBeVisible();
    };
    const sample = async () => {
      await page.locator('.react-flow__node[data-id="sample"]').click();
      await expect(
        page
          .locator(".editor-inspector")
          .getByLabel("One in every", { exact: true }),
      ).toBeVisible();
    };
    const rate = () =>
      page
        .locator(".editor-inspector")
        .getByLabel("One in every", { exact: true });
    const assertSaveOnly = () => {
      expect(fixture.validations).toEqual([]);
      expect(requests.filter((r) => r.method === "POST")).toEqual([]);
    };
    await check(
      "Save is visible beside publication, disabled until an edit, and Ctrl/Cmd+S saves with a summary note",
      async () => {
        for (const published of [false, true]) {
          await load({ published });
          await expect(
            button(published ? "Choose devices" : "Review & publish"),
          ).toBeVisible();
          await expect(saveButton()).toBeDisabled();
          await expect(saveButton()).toHaveAccessibleName("Save");
          await expect(saveButton()).toHaveAttribute(
            "aria-keyshortcuts",
            "Control+S Meta+S",
          );
          // Nothing to save: the shortcut is swallowed and sends nothing.
          await page.keyboard.press("ControlOrMeta+s");
          await sample();
          await rate().fill("11");
          await expect(saveButton()).toBeEnabled();
          await rate().press("ControlOrMeta+s");
          await expect.poll(() => fixture.document.revision).toBe(2);
          await expect(page.locator(".pipeline-save-status")).toContainText(
            "All changes saved",
          );
          await expect(saveButton()).toBeDisabled();
          expect(fixture.saveAttempts).toHaveLength(1);
          expect(fixture.saveAttempts[0].message).toBe("sample: rate changed");
          expect(fixture.document.config.transforms.sample.rate).toBe(11);
          assertSaveOnly();
        }
      },
    );
    await check(
      "Save options open with the keyboard, close on Escape or outside, and save with an edited note",
      async () => {
        await load();
        await openSave();
        await expect(saveItem()).toBeDisabled();
        await expect(noteItem()).toBeDisabled();
        await page.keyboard.press("Escape");
        await sample();
        await rate().fill("12");
        await trigger().focus();
        await page.keyboard.press("ArrowDown");
        await expect(saveMenu()).toBeVisible();
        await expect(saveItem()).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(saveMenu()).toHaveCount(0);
        await expect(trigger()).toBeFocused();
        await openSave();
        const heading = await page.locator(".editor-title").boundingBox();
        await page.mouse.click(heading.x + 8, heading.y + 8);
        await expect(saveMenu()).toHaveCount(0);
        expect(fixture.saveAttempts).toEqual([]);
        await openSave();
        await noteItem().click();
        const dialog = page.getByRole("dialog", {
          name: "Save draft",
          exact: true,
        });
        const note = dialog.getByLabel("Note", { exact: true });
        await expect(note).toHaveValue("sample: rate changed");
        await note.fill("Sample one in twelve during the launch");
        await dialog
          .getByRole("button", { name: "Save draft", exact: true })
          .click();
        await expect(dialog).toHaveCount(0);
        await expect.poll(() => fixture.document.revision).toBe(2);
        expect(fixture.saveAttempts).toHaveLength(1);
        expect(fixture.saveAttempts[0].message).toBe(
          "Sample one in twelve during the launch",
        );
        assertSaveOnly();
      },
    );
    await check(
      "typed fields and field JSON disable saving, and code that does not parse is refused with its place, without discarding or applying the text",
      async () => {
        for (const kind of ["code", "scalar", "raw"]) {
          await load();
          let input;
          if (kind === "code") {
            await button("Code").click();
            input = page.getByRole("textbox", {
              name: "Vector configuration code",
              exact: true,
            });
            await input.fill("{pending");
          } else {
            await sample();
            if (kind === "scalar") {
              input = rate();
              await input.fill("-");
            } else {
              input = await fieldJSON("Exclude");
              await input.fill("{pending");
            }
          }
          // Code is applied by saving; a field draft must be applied first.
          if (kind === "code") {
            await expect(saveButton()).toBeEnabled();
            await expect(page.locator(".pipeline-save-status")).toContainText(
              "Unapplied code changes",
            );
          } else {
            await expect(saveButton()).toBeDisabled();
            await expect(page.locator(".pipeline-save-status")).toContainText(
              "Unapplied field changes",
            );
          }
          await input.press("ControlOrMeta+s");
          await expect(
            kind === "code"
              ? page.getByText(/Not saved\. Line 1:\d+: /).first()
              : page
                  .getByText(
                    "Apply or discard unfinished code and field edits before saving the draft.",
                    { exact: true },
                  )
                  .first(),
          ).toBeVisible();
          await openSave();
          if (kind === "code") await expect(saveItem()).toBeEnabled();
          else await expect(saveItem()).toBeDisabled();
          await expect(noteItem()).toBeDisabled();
          await page.keyboard.press("Escape");
          await expect(trigger()).toBeFocused();
          if (kind === "scalar") await expect(input).toHaveValue("-");
          else await expect(input).toHaveText("{pending");
          await page.waitForTimeout(1200);
          expect(fixture.saveAttempts).toEqual([]);
          expect(fixture.document.config).toEqual(baseDocument().config);
        }
      },
    );
    await check(
      "explicit saves use current draft CAS, disable duplicate requests while held, and retain edits across failure/retry",
      async () => {
        await load();
        await sample();
        fixture.holdSave = true;
        await rate().fill("20");
        await saveButton().click();
        await expect.poll(() => fixture.pendingSaves.length).toBe(1);
        await expect(saveButton()).toBeDisabled();
        await expect(trigger()).toBeDisabled();
        await saveButton().evaluate((element) => element.click());
        await rate().press("ControlOrMeta+s");
        expect(fixture.saveAttempts).toHaveLength(1);
        expect(fixture.saveAttempts[0].revision).toBe(1);
        expect(fixture.saveAttempts[0].config.transforms.sample.rate).toBe(20);
        fixture.pendingSaves.shift()(true);
        await expect(saveButton()).toBeEnabled();
        await expect(page.locator(".pipeline-save-status")).toContainText(
          "Save failed",
        );
        await expect(rate()).toHaveValue("20");
        expect(fixture.document.revision).toBe(1);
        fixture.holdSave = false;
        await saveButton().click();
        await expect.poll(() => fixture.document.revision).toBe(2);
        await expect(page.locator(".pipeline-save-status")).toContainText(
          "All changes saved",
        );
        await expect(rate()).toHaveValue("20");
        expect(fixture.saveAttempts).toHaveLength(2);
        await expect(
          page.getByText("Synthetic draft save failed", { exact: true }),
        ).toHaveCount(0);
        expect(fixture.mutations).toHaveLength(1);
        assertSaveOnly();
      },
    );
    await check(
      "editors save without publication while operators, viewers and archived pipelines have no draft-save affordance",
      async () => {
        await load({ role: "editor" });
        await expect(button("Review & publish")).toHaveCount(0);
        await expect(saveButton()).toBeDisabled();
        await sample();
        await rate().fill("20");
        await saveButton().click();
        await expect.poll(() => fixture.document.revision).toBe(2);
        expect(fixture.document.config.transforms.sample.rate).toBe(20);
        assertSaveOnly();
        await rate().fill("-");
        await expect(saveButton()).toBeDisabled();
        for (const options of [
          { role: "operator" },
          { role: "viewer" },
          { role: "admin", archived: true },
          { role: "editor", archived: true },
        ]) {
          await load(options);
          await expect(trigger()).toHaveCount(0);
          await expect(saveButton()).toHaveCount(0);
          await page.keyboard.press("ControlOrMeta+s");
          await page.locator(".editor-tools-menu summary").click();
          await expect(
            page
              .locator(".editor-tools-menu")
              .getByRole("button", { name: /^Save draft/ }),
          ).toHaveCount(0);
          expect(fixture.saveAttempts).toEqual([]);
          await page.keyboard.press("Escape");
        }
      },
    );
    await check(
      "split controls and popup stay contained at 899px, 800px and mobile light/dark with accessible focus",
      async () => {
        for (const [width, theme] of [
          [899, "light"],
          [800, "light"],
          [375, "light"],
          [375, "dark"],
        ]) {
          await load({ width, height: 900, collapsed: false });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await expect(trigger()).toBeVisible();
          const a = await saveButton().boundingBox(),
            b = await trigger().boundingBox(),
            primary = await button("Review & publish").boundingBox();
          // Save and its options read as one control beside publication.
          expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
          expect(Math.abs(a.x + a.width - b.x)).toBeLessThanOrEqual(1);
          expect(b.x + b.width).toBeLessThanOrEqual(width);
          expect(primary.x + primary.width).toBeLessThanOrEqual(width);
          await noOverflow("split toolbar " + width + " " + theme);
          await openSave();
          const bounds = await saveMenu().boundingBox();
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          measurements.push({
            label: "split save " + width + " " + theme,
            save: a,
            trigger: b,
            primary,
            menu: bounds,
          });
          await axe("split save " + width + " " + theme);
          await page.screenshot({
            path: resolve(output, "split-save-" + width + "-" + theme + ".png"),
            animations: "disabled",
          });
          await page.keyboard.press("Escape");
          await expect(trigger()).toBeFocused();
          expect(fixture.saveAttempts).toEqual([]);
        }
      },
    );
    await check(
      "unsaved edits survive a reload in this browser and can be restored or discarded",
      async () => {
        await load();
        page.on("dialog", (dialog) => dialog.accept());
        await sample();
        await rate().fill("33");
        await expect
          .poll(() =>
            page.evaluate(() =>
              Object.keys(localStorage).some((key) =>
                key.startsWith("vectory.draft.v1:"),
              ),
            ),
          )
          .toBe(true);
        await page.reload();
        const banner = page.locator(".editor-recovery");
        await expect(banner).toContainText(
          "are still in this browser. Restore them to keep editing, or discard them.",
        );
        await axe("draft recovery offer");
        await page.screenshot({
          path: resolve(output, "draft-recovery.png"),
          animations: "disabled",
        });
        await banner
          .getByRole("button", { name: "Restore changes", exact: true })
          .click();
        await expect(banner).toHaveCount(0);
        await expect(saveButton()).toBeEnabled();
        await sample();
        await expect(rate()).toHaveValue("33");
        await page.reload();
        await banner
          .getByRole("button", { name: "Discard", exact: true })
          .click();
        await expect(banner).toHaveCount(0);
        expect(
          await page.evaluate(() =>
            Object.keys(localStorage).filter((key) =>
              key.startsWith("vectory.draft.v1:"),
            ),
          ),
        ).toEqual([]);
        await page.reload();
        await expect(page.locator(".react-flow__node").first()).toBeVisible();
        await expect(banner).toHaveCount(0);
        expect(fixture.saveAttempts).toEqual([]);
      },
    );
    expect(results).toHaveLength(splitSaveFollowup ? 2 : 7);
  } else if (checkStateOnly) {
    const control = () => checkButton();
    const verdict = () => problemsPanel().locator(".problems-verdict");
    const rate = () =>
      page
        .locator(".editor-inspector")
        .getByLabel("One in every", { exact: true });
    const state = async (value) => {
      await expect(control()).toHaveAttribute("data-check-state", value);
    };
    const pass = async () => {
      fixture.validationValid = true;
      fixture.validationNative = false;
      fixture.validationError = false;
      fixture.holdValidation = false;
      await control().click();
      await state("device");
      await expect(control()).toHaveAccessibleName("Check pipeline: Checked");
      await expect(verdict()).toHaveText(
        "Vector 0.58 accepted this pipeline. Each device checks environment variables before applying it.",
      );
    };
    const sample = async () => {
      await page.locator('.react-flow__node[data-id="sample"]').click();
      await expect(rate()).toBeVisible();
    };
    const discard = async () => {
      await page
        .locator(".editor-toolbar")
        .getByRole("button", { name: "Discard changes", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Discard unsaved changes?",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Discard changes", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
    };
    await check(
      "check names device-pending, native pass, problems and an unavailable checker",
      async () => {
        await load();
        await state("unchecked");
        await expect(control()).toHaveAccessibleName(
          "Check pipeline: Not checked",
        );
        expect(fixture.validations).toEqual([]);
        await pass();
        fixture.validationNative = true;
        await control().click();
        await state("passed");
        await expect(verdict()).toHaveText(
          "Vector 0.58 accepted this pipeline.",
        );
        fixture.validationValid = false;
        await control().click();
        await state("problems");
        await expect(control()).toHaveAccessibleName(
          "Check pipeline: 1 problem",
        );
        await expect(problemsPanel()).toContainText(
          "Synthetic configuration rejected.",
        );
        await expect(
          page.locator(
            '.react-flow__node[data-id="sample"] .pipeline-node-attention',
          ),
        ).toHaveAttribute(
          "aria-label",
          "rate: Synthetic configuration rejected.",
        );
        fixture.validationError = true;
        await control().click();
        await state("unavailable");
        await expect(control()).toHaveAccessibleName(
          "Check pipeline: Couldn't check",
        );
        await expect(verdict()).toHaveText(
          "Vector's checker isn't reachable, so this draft hasn't been checked. Publishing waits for a successful check.",
        );
        // The last findings stay listed while the checker is unreachable.
        await expect(problemsPanel()).toContainText(
          "Synthetic configuration rejected.",
        );
        await pass();
        await expect(
          page.locator(
            '.react-flow__node[data-id="sample"] .pipeline-node-issue',
          ),
        ).toHaveCount(0);
        expect(fixture.validations).toHaveLength(5);
      },
    );
    await check(
      "an operator can check an accessible draft without editing it",
      async () => {
        await load({ role: "operator" });
        await expect(control()).toBeVisible();
        await pass();
        expect(fixture.validations).toHaveLength(1);
        expect(fixture.mutations).toEqual([]);
      },
    );
    await check(
      "a person who can't run a check reads what is true about the draft, never an instruction",
      async () => {
        const instruction =
          "Run a check to validate this pipeline with Vector.";
        // A viewer, or anyone on an archived pipeline, sees the check the
        // published version passed when its steps equal the draft.
        for (const options of [
          { role: "viewer", published: true },
          { role: "admin", published: true, archived: true },
        ]) {
          await load(options);
          await expect(control()).toHaveCount(0);
          await expect(verdict()).toHaveText(
            "Version 1 was checked by Vector 0.58 when it was published.",
          );
          await expect(problemsPanel()).toContainText("No problems");
          await expect(problemsPanel()).not.toContainText("Run a check");
          expect(fixture.validations).toEqual([]);
        }
        // Without a published version nothing is known to them, and nothing
        // is asked of them.
        for (const options of [
          { role: "viewer" },
          { role: "admin", archived: true },
        ]) {
          await load(options);
          await expect(verdict()).toHaveText(
            "Not checked since the last edit.",
          );
          await expect(problemsPanel()).toContainText("Not checked");
          await expect(problemsPanel()).not.toContainText("Run a check");
          expect(fixture.validations).toEqual([]);
        }
        // The people who can check are still told how.
        await load({ role: "editor" });
        await expect(verdict()).toHaveText(instruction);
        await load({
          role: "viewer",
          published: true,
          width: 375,
          height: 900,
        });
        // On a phone the bar leaves the sentence out; the open panel has it.
        await problemsPanel()
          .getByRole("button", { name: "No problems", exact: true })
          .click();
        await expect(problemsPanel()).toContainText(
          "Nothing to fix. Version 1 was checked by Vector 0.58 when it was published.",
        );
        await noOverflow("viewer check verdict 375");
        await page.screenshot({
          path: resolve(output, "viewer-check-verdict-375.png"),
          animations: "disabled",
        });
        await axe("viewer check verdict");
      },
    );
    await check(
      "unparsed code and unfinished fields are never sent or shown as checked",
      async () => {
        await load();
        await pass();
        await button("Code").click();
        await page.getByLabel("Format", { exact: true }).selectOption("json");
        const code = page.getByRole("textbox", {
          name: "Vector configuration code",
          exact: true,
        });
        await code.fill("{invalid");
        // The syntax error in the unapplied text is the problem that counts.
        await state("problems");
        await expect(control()).toHaveAccessibleName(
          "Check pipeline: 1 problem",
        );
        const before = fixture.validations.length;
        await control().click();
        await expect(
          page.getByText("Fix the code syntax before checking it.", {
            exact: true,
          }),
        ).toBeVisible();
        await state("problems");
        expect(fixture.validations).toHaveLength(before);
        // A code problem leads to where the text breaks.
        await problemsPanel().locator(".problems-item").first().click();
        await expect(code).toBeFocused();
        await discard();
        await button("Graph").click();
        await pass();
        await sample();
        await rate().fill("-");
        await state("stale");
        await expect(verdict()).toHaveText(
          "Apply or discard the field you're editing, then check again.",
        );
        const count = fixture.validations.length;
        await control().click();
        await state("stale");
        expect(fixture.validations).toHaveLength(count);
        await expect(rate()).toHaveValue("-");
      },
    );
    await check(
      "applied configuration, raw JSON and code edits make the last check stale until checked again",
      async () => {
        await load();
        await pass();
        await sample();
        await rate().fill("20");
        await state("stale");
        await expect(verdict()).toHaveText("Changed since the last check.");
        await pass();
        expect(fixture.validations.at(-1).config.transforms.sample.rate).toBe(
          20,
        );
        await rate().fill("10");
        await state("stale");
        // Returning to the checked draft needs no new check.
        await rate().fill("20");
        await state("device");
        await (await fieldJSON("Exclude")).fill('{"unfinished":');
        await state("stale");
        await discard();
        await pass();
        await button("Code").click();
        await page.getByLabel("Format", { exact: true }).selectOption("json");
        const next = structuredClone(fixture.document.config);
        next.transforms.sample.rate = 30;
        await page
          .getByRole("textbox", {
            name: "Vector configuration code",
            exact: true,
          })
          .fill(JSON.stringify(next));
        await state("stale");
        await pass();
        // The check reviewed the unapplied Code text, not the saved draft.
        expect(fixture.validations.at(-1).config.transforms.sample.rate).toBe(
          30,
        );
        expect(fixture.mutations).toEqual([]);
      },
    );
    await check(
      "a result for an earlier draft never marks newer edits checked, and the editor stays usable while checking",
      async () => {
        await load();
        await pass();
        await sample();
        fixture.holdValidation = true;
        await control().click();
        await state("checking");
        await expect.poll(() => fixture.pendingValidations.length).toBe(1);
        // Checking never locks the editor.
        await rate().fill("30");
        await expect(rate()).toHaveValue("30");
        fixture.pendingValidations.shift()();
        await state("stale");
        await expect(verdict()).toHaveText("Changed since the last check.");
        expect(fixture.validations.at(-1).config.transforms.sample.rate).toBe(
          10,
        );
        await pass();
        expect(fixture.validations.at(-1).config.transforms.sample.rate).toBe(
          30,
        );
      },
    );
    await check(
      "auto-check runs once after an edit pause, stays quiet on failure and can be turned off",
      async () => {
        await load({ autoCheck: true });
        await expect.poll(() => fixture.validations.length).toBe(1);
        await state("device");
        await sample();
        await rate().fill("40");
        await state("stale");
        await expect.poll(() => fixture.validations.length).toBe(2);
        expect(fixture.validations.at(-1).config.transforms.sample.rate).toBe(
          40,
        );
        await state("device");
        fixture.validationError = true;
        await rate().fill("41");
        await expect.poll(() => fixture.validations.length).toBe(3);
        // An automatic attempt that fails keeps the last result and waits
        // for the next edit instead of retrying in a loop.
        await state("stale");
        await page.waitForTimeout(2500);
        expect(fixture.validations).toHaveLength(3);
        const toggle = problemsPanel().getByRole("checkbox", {
          name: "Auto-check",
          exact: true,
        });
        await expect(toggle).toBeChecked();
        await toggle.uncheck();
        fixture.validationError = false;
        await rate().fill("42");
        await page.waitForTimeout(2500);
        expect(fixture.validations).toHaveLength(3);
        expect(
          await page.evaluate(() =>
            localStorage.getItem("vectory.editor.auto-check"),
          ),
        ).toBe("off");
      },
    );
    await check(
      "check outcome colors are distinct and accessible in light and dark mobile views",
      async () => {
        for (const theme of ["light", "dark"]) {
          await load({ width: 375, height: 900 });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          const colors = {};
          const color = () =>
            control().evaluate((element) => getComputedStyle(element).color);
          const icon = () =>
            control()
              .locator("svg")
              .evaluate((element) => getComputedStyle(element).color);
          colors.unchecked = await color();
          await pass();
          colors.device = await icon();
          await page.screenshot({
            path: resolve(
              output,
              "pipeline-check-device-375-" + theme + ".png",
            ),
            animations: "disabled",
          });
          await axe("checked pipeline " + theme);
          fixture.validationValid = false;
          await control().click();
          await state("problems");
          colors.problems = await color();
          expect(colors.problems).not.toBe(colors.unchecked);
          expect(colors.device).not.toBe(colors.problems);
          measurements.push({ label: "check colors " + theme, ...colors });
          await noOverflow("check " + theme);
          await axe("pipeline problems " + theme);
          await page.screenshot({
            path: resolve(
              output,
              "pipeline-check-problems-375-" + theme + ".png",
            ),
            animations: "disabled",
          });
        }
      },
    );
    expect(results).toHaveLength(8);
  } else if (nodeActionsOnly) {
    const nodeMenu = () =>
      page.getByRole("menu", { name: "Step: sample", exact: true });
    const sampleActions = () =>
      page
        .locator('.react-flow__node[data-id="sample"]')
        .getByRole("button", { name: "Actions for sample", exact: true });
    async function openSampleActions() {
      await sampleActions().click();
      await expect(nodeMenu()).toBeVisible();
      await expect(sampleActions()).toHaveAttribute("aria-expanded", "true");
    }
    await check(
      "node actions duplicate and remove through the real editor with exact undo and pending-field protection",
      async () => {
        await load({ width: 899, height: 1000 });
        const original = structuredClone(fixture.document.config);
        const sample = page.locator('.react-flow__node[data-id="sample"]');
        await openSampleActions();
        await expect(page.locator(".editor-inspector")).toHaveCount(0);
        await nodeMenu()
          .getByRole("menuitem", { name: "Duplicate step", exact: true })
          .click();
        await expect(
          page.locator('.react-flow__node[data-id="sample_copy"]'),
        ).toHaveCount(1);
        await saved(
          (doc) =>
            JSON.stringify(doc.config.transforms.sample_copy) ===
            JSON.stringify(original.transforms.sample),
        );
        await expect(
          page
            .locator(".editor-inspector")
            .getByRole("button", { name: /^(Duplicate step|Remove step)$/ }),
        ).toHaveCount(0);
        await closeInspector();
        await button("Undo").click();
        await saved(
          (doc) => JSON.stringify(doc.config) === JSON.stringify(original),
        );
        await expect(
          page.locator('.react-flow__node[data-id="sample_copy"]'),
        ).toHaveCount(0);

        await sample.click();
        const rate = page
          .locator(".editor-inspector")
          .getByLabel("One in every", { exact: true });
        await rate.fill("-");
        await openSampleActions();
        await dismissConfirmation(() =>
          nodeMenu()
            .getByRole("menuitem", { name: "Remove step", exact: true })
            .click(),
        );
        await expect(rate).toHaveValue("-");
        await expect(sample).toHaveCount(1);
        expect(fixture.document.config).toEqual(original);
        await rate.fill("10");
        await closeInspector();
        await sampleActions().focus();
        await page.keyboard.press("Enter");
        await expect(nodeMenu()).toBeVisible();
        await nodeMenu()
          .getByRole("menuitem", { name: "Remove step", exact: true })
          .focus();
        await page.keyboard.press("Enter");
        await expect(sample).toHaveCount(0);
        await saved((doc) => !doc.config.transforms.sample);
        await button("Undo").click();
        await saved(
          (doc) => JSON.stringify(doc.config) === JSON.stringify(original),
        );
        await expect(sample).toHaveCount(1);
      },
    );
    await check(
      "node menus have keyboard access and fit 899px/375px light and dark; viewer and archived graphs expose properties only",
      async () => {
        for (const [width, theme] of [
          [899, "light"],
          [375, "light"],
          [375, "dark"],
        ]) {
          await load({ width, height: 1000 });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          const sample = page.locator('.react-flow__node[data-id="sample"]');
          const trigger = sampleActions();
          await expect(trigger).toBeVisible();
          await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
          await trigger.focus();
          await expect(trigger).toBeFocused();
          await page.keyboard.press("Enter");
          await expect(nodeMenu()).toBeVisible();
          await expect(
            nodeMenu().getByRole("menuitem", {
              name: "Open properties",
              exact: true,
            }),
          ).toBeFocused();
          await expect(
            nodeMenu().getByRole("menuitem", {
              name: "Duplicate step",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            nodeMenu().getByRole("menuitem", {
              name: "Remove step",
              exact: true,
            }),
          ).toBeVisible();
          await expect(page.locator(".editor-inspector")).toHaveCount(0);
          await page.keyboard.press("Escape");
          await expect(nodeMenu()).toHaveCount(0);
          await expect(trigger).toBeFocused();
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
          await openSampleActions();
          await trigger.click();
          await expect(nodeMenu()).toHaveCount(0);
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
          await openSampleActions();
          const bounds = await trigger.boundingBox();
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          await noOverflow(`node actions ${width}px ${theme}`);
          await axe(`node actions ${width}px ${theme}`);
          await page.screenshot({
            path: resolve(output, `node-actions-${width}-${theme}.png`),
            animations: "disabled",
          });
          expect(fixture.mutations).toEqual([]);
        }
        for (const options of [{ role: "viewer" }, { archived: true }]) {
          await load(options);
          await openSampleActions();
          await expect(nodeMenu().getByRole("menuitem")).toHaveCount(1);
          await expect(
            nodeMenu().getByRole("menuitem", {
              name: "Open properties",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            nodeMenu().getByRole("menuitem", {
              name: /Duplicate|Remove|Disconnect/,
            }),
          ).toHaveCount(0);
          await nodeMenu()
            .getByRole("menuitem", { name: "Open properties", exact: true })
            .click();
          await expect(page.locator(".editor-inspector")).toBeVisible();
          await expect(
            page
              .locator(".editor-inspector")
              .getByRole("button", { name: /^(Duplicate step|Remove step)$/ }),
          ).toHaveCount(0);
          expect(fixture.mutations).toEqual([]);
        }
      },
    );
    expect(results).toHaveLength(2);
  } else if (checksLayoutOnly) {
    await check(
      "check results stay in the Problems panel, contained and accessible at 375px and 899px, and lead to the field",
      async () => {
        await load({ width: 375, height: 900 });
        const trigger = checkButton();
        await expect(trigger).toHaveAttribute("data-check-state", "unchecked");
        await expect(problemsPanel()).toBeVisible();
        expect(fixture.validations).toHaveLength(0);
        fixture.validationValid = false;
        await trigger.click();
        await expect.poll(() => fixture.validations.length).toBe(1);
        await expect(trigger).toHaveAttribute("data-check-state", "problems");
        await expect(trigger).toHaveAccessibleName("Check pipeline: 1 problem");
        const list = problemsPanel().locator("#pipeline-problems-list");
        await expect(list).toContainText("Synthetic configuration rejected.");
        for (const width of [375, 899]) {
          await page.setViewportSize({ width, height: 900 });
          const bounds = await problemsPanel().boundingBox();
          measurements.push({
            label: `problems panel ${width}px`,
            viewport_width: width,
            panel: bounds,
          });
          await page.screenshot({
            path: resolve(output, `editor-check-results-${width}-light.png`),
            animations: "disabled",
          });
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          await noOverflow(`check results ${width}px`);
        }
        await page.setViewportSize({ width: 375, height: 900 });
        await axe("mobile pipeline problems");
        const toggle = problemsPanel().locator(".problems-toggle");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(list).toHaveCount(0);
        await page.keyboard.press("Enter");
        await expect(list).toBeVisible();
        // A finding opens its step and focuses the option it names. The
        // mobile component sheet covers the list until it closes.
        await list
          .getByRole("button", { name: /Synthetic configuration rejected/ })
          .click();
        const rate = page
          .locator(".editor-inspector")
          .getByLabel("One in every", { exact: true });
        await expect(rate).toBeFocused();
        await expect(
          page.locator('.editor-inspector [data-field-path="rate"]'),
        ).toContainText("Synthetic configuration rejected.");
        await expect(problemsPanel()).toBeHidden();
        await button("Close component settings").click();
        await expect(problemsPanel()).toBeVisible();
        expect(fixture.validations).toHaveLength(1);
        expect(fixture.mutations).toEqual([]);
      },
    );
    expect(results).toHaveLength(1);
  } else if (menuLayoutOnly) {
    for (const sample of [
      {
        width: 899,
        height: 1000,
        theme: "light",
        label: "899-light",
        overview: "editor-canvas-menu-899-light.png",
      },
      {
        width: 375,
        height: 900,
        theme: "light",
        label: "mobile-light",
        overview: "editor-canvas-mobile-light.png",
      },
      {
        width: 375,
        height: 900,
        theme: "dark",
        label: "mobile-dark",
        overview: "editor-canvas-mobile-dark.png",
      },
    ])
      await check(
        `S3 picker icons and two-result height at ${sample.label}`,
        async () => {
          await load(sample);
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, sample.theme);
          const tools = page.locator(".editor-tools-menu");
          const toolsTrigger = tools.locator("summary");
          await toolsTrigger.click();
          await expect(tools).toHaveAttribute("open", "");
          const blank = await blankPoint();
          await page.mouse.click(blank.x, blank.y);
          await expect(tools).not.toHaveAttribute("open", "");
          await toolsTrigger.click();
          await page.keyboard.press("Escape");
          await expect(tools).not.toHaveAttribute("open", "");
          await expect(toolsTrigger).toBeFocused();
          await button("Add component").click();
          await expect(menu()).toBeVisible();
          const search = menu().getByRole("textbox", {
            name: "Search components",
          });
          await expect(search).toBeFocused();
          await expect(search).toHaveCSS("outline-style", "none");
          await expect(search).toHaveCSS("box-shadow", "none");
          const searchFocus = await menu()
            .locator(".canvas-component-search")
            .evaluate((element) => ({
              underline: getComputedStyle(element).borderBottomColor,
              width: getComputedStyle(element).borderBottomWidth,
              muted: getComputedStyle(element).color,
            }));
          expect(searchFocus.width).toBe("2px");
          expect(searchFocus.underline).toBe(searchFocus.muted);
          const categoryColors = {};
          for (const category of ["sources", "transforms", "sinks"]) {
            const node = page
              .locator(`.pipeline-node[data-pipeline-category="${category}"]`)
              .first();
            const color = await node
              .locator(".pipeline-node-kind")
              .evaluate((element) => getComputedStyle(element).color);
            await expect(
              menu()
                .locator(
                  `.canvas-component-result[data-pipeline-category="${category}"] .canvas-component-kind`,
                )
                .first(),
            ).toHaveCSS("color", color);
            await expect(
              menu().locator(
                `nav button[data-pipeline-category="${category}"]`,
              ),
            ).toHaveCSS("color", color);
            categoryColors[category] = color;
          }
          expect(new Set(Object.values(categoryColors)).size).toBe(3);
          measurements.push({
            label: `${sample.label} category and focus styles`,
            categoryColors,
            searchFocus,
          });
          await page.screenshot({
            path: resolve(output, sample.overview),
            animations: "disabled",
          });
          await menu()
            .getByRole("textbox", { name: "Search components" })
            .fill("s3");
          await expect(menu().locator(".canvas-component-result")).toHaveCount(
            2,
          );
          const bounds = await menu().boundingBox();
          expect(bounds.height).toBeLessThan(350);
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.y).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(sample.width);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(sample.height);
          const rows = await menu()
            .locator(".canvas-component-result")
            .evaluateAll((elements) =>
              elements.map((element) => {
                const icon = element
                  .querySelector(".pipeline-component-icon")
                  .getBoundingClientRect();
                const text = element
                  .querySelector("strong")
                  .getBoundingClientRect();
                return {
                  icon_width: icon.width,
                  icon_height: icon.height,
                  text_gap: text.left - icon.right,
                  row_height: element.getBoundingClientRect().height,
                };
              }),
            );
          for (const row of rows) {
            expect(row.icon_width).toBeGreaterThanOrEqual(24);
            expect(row.icon_width).toBeLessThanOrEqual(26);
            expect(row.text_gap).toBeGreaterThanOrEqual(8);
            expect(row.text_gap).toBeLessThanOrEqual(14);
          }
          measurements.push({ label: sample.label, menu: bounds, rows });
          await noOverflow(sample.label);
          await axe(`two-result S3 picker ${sample.label}`);
          await page.screenshot({
            path: resolve(output, `editor-canvas-s3-${sample.label}.png`),
            animations: "disabled",
          });
          await menu()
            .getByRole("textbox", { name: "Search components" })
            .fill("");
          const expanded = await menu().boundingBox();
          expect(expanded.height).toBeLessThanOrEqual(481);
          expect(expanded.y + expanded.height).toBeLessThanOrEqual(
            sample.height,
          );
          await page.keyboard.press("Escape");
          await page.locator('.react-flow__node[data-id="sample"]').click();
          const inspector = page.locator(
            '.editor-inspector[data-pipeline-category="transforms"]',
          );
          await expect(inspector).toBeVisible();
          // The category tone lives on the inspector icon; its small
          // category label stays muted beside the component name.
          await expect(inspector.locator(".editor-inspector-icon")).toHaveCSS(
            "color",
            categoryColors.transforms,
          );
          await expect(page.locator(".pipeline-node-selected")).toHaveCSS(
            "outline-style",
            "solid",
          );
          await axe(`category inspector ${sample.label}`);
          await page.screenshot({
            path: resolve(
              output,
              `editor-category-inspector-${sample.label}.png`,
            ),
            animations: "disabled",
          });
          await closeInspector();
          expect(fixture.mutations).toEqual([]);
          expect(fixture.validations).toEqual([]);
        },
      );
    expect(results).toHaveLength(3);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  } else {
    await check(
      "one toolbar above the graph retains Graph/Code, check, settings, Actions and publication; old Steps and graph footer are absent",
      async () => {
        await load();
        const toolbar = page.locator(
          '.editor-toolbar[aria-label="Pipeline toolbar"]',
        );
        await expect(toolbar).toHaveCount(1);
        for (const name of [
          "Graph",
          "Code",
          "Pipeline settings",
          "Review & publish",
        ])
          await expect(
            toolbar.getByRole("button", { name, exact: true }),
          ).toBeVisible();
        await expect(checkButton()).toHaveAccessibleName(
          "Check pipeline: Not checked",
        );
        await expect(
          toolbar.locator("summary").filter({ hasText: "Actions" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Steps", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.locator(
            ".editor-graph-toolbar, .editor-footer, .editor-graph-footer",
          ),
        ).toHaveCount(0);
        const bounds = {
          header: await page.locator(".editor-header").boundingBox(),
          toolbar: await toolbar.boundingBox(),
          canvas: await page.locator(".editor-graph").boundingBox(),
        };
        expect(bounds.toolbar.y).toBeGreaterThanOrEqual(
          bounds.header.y + bounds.header.height - 1,
        );
        expect(bounds.canvas.y).toBeGreaterThanOrEqual(
          bounds.toolbar.y + bounds.toolbar.height - 1,
        );
        for (const name of [
          "Add component",
          "Undo",
          "Redo",
          "Zoom in",
          "Zoom out",
          "Fit graph",
          "Arrange graph",
        ])
          await expect(button(name)).toBeVisible();
        await button("Code").click();
        await expect(
          page.getByRole("textbox", { name: "Vector configuration code" }),
        ).toBeVisible();
        await button("Graph").click();
        await expect(page.locator(".react-flow__node")).toHaveCount(5);
        expect(fixture.mutations).toEqual([]);
        await noOverflow("desktop toolbar");
      },
    );
    await check(
      "keyboard and blank-canvas menus are searchable, cancel without mutation, and add an unconnected source at the selected flow point",
      async () => {
        await load();
        await button("Add component").focus();
        await page.keyboard.press("Enter");
        await expect(
          menu().getByRole("textbox", { name: "Search components" }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(button("Add component")).toBeFocused();
        expect(fixture.mutations).toEqual([]);
        const point = await blankPoint(),
          expected = await flowPoint(point);
        await page.mouse.click(point.x, point.y, { button: "right" });
        await expect(menu()).toBeVisible();
        const bounds = await menu().boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000);
        await choose("demo_logs", "Sources");
        await expect(page.locator(".react-flow__node")).toHaveCount(6);
        await saved((doc) => Object.keys(doc.config.sources).length === 2);
        const added = Object.keys(fixture.document.config.sources).find(
          (id) => id !== "seed",
        );
        expect(fixture.document.config.transforms).toEqual(
          baseDocument().config.transforms,
        );
        expect(fixture.document.config.sinks).toEqual(
          baseDocument().config.sinks,
        );
        expect(
          fixture.document.graph.edges.some(
            (edge) => edge.source === added || edge.target === added,
          ),
        ).toBe(false);
        await positioned(added, expected);
        await button("Undo").click();
        await saved((doc) => Object.keys(doc.config.sources).length === 1);
        expect(fixture.document.config).toEqual(baseDocument().config);
        await button("Redo").click();
        await saved((doc) => Object.keys(doc.config.sources).length === 2);
        await closeInspector();
        const outside = await blankPoint();
        await button("Add component").click();
        await page.mouse.click(outside.x, outside.y);
        await expect(menu()).toHaveCount(0);
      },
    );
    await check(
      "dragging a named output to blank space filters compatible components and adds a positioned branch without rewiring existing consumers",
      async () => {
        await load();
        await button("Zoom out").click();
        const point = await blankPoint(),
          expected = await flowPoint(point);
        await dragHandle("branch", "accepted", point);
        await expect(menu()).toBeVisible();
        await expect(menu()).toContainText("branch.accepted");
        await expect(
          menu().getByRole("button", { name: "Sources", exact: true }),
        ).toHaveCount(0);
        await menu()
          .getByRole("textbox", { name: "Search components" })
          .fill("prometheus_exporter");
        // Incompatible steps stay listed, greyed, with the reason.
        await expect(menu().locator(".canvas-component-result")).toHaveCount(1);
        await expect(
          menu().locator(".canvas-component-result"),
        ).toHaveAttribute("aria-disabled", "true");
        await expect(menu()).toContainText(
          "Accepts metrics; branch.accepted sends logs.",
        );
        await choose("sample", "Transforms");
        await saved((doc) => Object.keys(doc.config.transforms).length === 3);
        const added = Object.keys(fixture.document.config.transforms).find(
          (id) => !["branch", "sample"].includes(id),
        );
        expect(fixture.document.config.transforms[added].inputs).toEqual([
          "branch.accepted",
        ]);
        expect(fixture.document.config.sinks).toEqual(
          baseDocument().config.sinks,
        );
        expect(
          fixture.document.graph.edges.some(
            (edge) =>
              edge.source === "branch" &&
              edge.sourceHandle === "accepted" &&
              edge.target === added,
          ),
        ).toBe(true);
        await positioned(added, expected);
        await closeInspector();
        const before = structuredClone(fixture.document.config);
        await button("Arrange graph").click();
        await saved((doc) => doc.revision >= 3);
        expect(fixture.document.config).toEqual(before);
        await page.screenshot({
          path: resolve(output, "editor-canvas-desktop-light.png"),
          animations: "disabled",
        });
      },
    );
    await check(
      "successful handle connections do not open a creation menu; input-handle drops and rejected node drops do not add components",
      async () => {
        await load();
        const input = await page
          .locator(
            '.react-flow__node[data-id="other"] .react-flow__handle[data-handleid="input"]',
          )
          .boundingBox();
        await dragHandle("branch", "accepted", {
          x: input.x + input.width / 2,
          y: input.y + input.height / 2,
        });
        await saved((doc) =>
          doc.config.sinks.other.inputs.includes("branch.accepted"),
        );
        expect(fixture.document.config.sinks.other.inputs).toEqual([
          "sample",
          "branch.accepted",
        ]);
        await expect(menu()).toHaveCount(0);
        await page
          .getByRole("button", {
            name: "branch _unmatched output",
            exact: true,
          })
          .focus();
        await page.keyboard.press("Enter");
        await page
          .getByRole("button", { name: "Input for other", exact: true })
          .focus();
        await page.keyboard.press("Enter");
        await saved((doc) =>
          doc.config.sinks.other.inputs.includes("branch._unmatched"),
        );
        await expect(menu()).toHaveCount(0);
        const point = await blankPoint();
        await dragHandle("other", "input", point);
        await expect(menu()).toHaveCount(0);
        const seed = await page
          .locator('.react-flow__node[data-id="seed"]')
          .boundingBox();
        await dragHandle("branch", "accepted", {
          x: seed.x + seed.width / 2,
          y: seed.y + seed.height / 2,
        });
        await expect(menu()).toHaveCount(0);
        await expect(page.locator(".react-flow__node")).toHaveCount(5);
      },
    );
    await check(
      "pending scalar drafts survive declined canvas actions and block checking; valid edits then check the persisted candidate",
      async () => {
        await load();
        await page.locator('.react-flow__node[data-id="sample"]').click();
        const rate = page
          .locator(".editor-inspector")
          .getByLabel("One in every", { exact: true });
        await rate.fill("-");
        await checkButton().click();
        await expect(page.locator(".editor-inspector")).toContainText(
          "Resolve or apply pending field changes",
        );
        expect(fixture.validations).toEqual([]);
        await dismissConfirmation(() => button("Add component").click());
        await expect(menu()).toHaveCount(0);
        await expect(rate).toHaveValue("-");
        await dismissConfirmation(() => button("Arrange graph").click());
        await expect(rate).toHaveValue("-");
        expect(fixture.mutations).toEqual([]);
        await rate.fill("20");
        await closeInspector();
        await saved((doc) => doc.config.transforms.sample.rate === 20);
        await checkButton().click();
        await expect.poll(() => fixture.validations.length).toBe(1);
        expect(fixture.validations[0].config.transforms.sample.rate).toBe(20);
        await button("Code").click();
        const code = page.getByRole("textbox", {
          name: "Vector configuration code",
        });
        await page.getByLabel("Format", { exact: true }).selectOption("json");
        await page
          .context()
          .grantPermissions(["clipboard-read", "clipboard-write"]);
        await code.press("ControlOrMeta+a");
        await code.press("ControlOrMeta+c");
        const initial = await page.evaluate(() =>
          navigator.clipboard.readText(),
        );
        const writes = fixture.mutations.length;
        await code.fill("{invalid");
        await button("Graph").click();
        await expect.poll(() => code.innerText()).toBe("{invalid");
        expect(fixture.mutations).toHaveLength(writes);
        await code.fill(initial);
        await button("Graph").click();
        await expect(page.locator(".react-flow__node")).toHaveCount(5);
      },
    );
    await check(
      "viewer and archived pipelines expose view controls but no canvas creation or layout writes",
      async () => {
        for (const options of [{ role: "viewer" }, { archived: true }]) {
          await load(options);
          for (const name of ["Add component", "Undo", "Redo", "Arrange graph"])
            await expect(button(name)).toHaveCount(0);
          const point = await blankPoint();
          await page.mouse.click(point.x, point.y, { button: "right" });
          await expect(menu()).toHaveCount(0);
          await dragHandle("branch", "accepted", point);
          await expect(menu()).toHaveCount(0);
          await button("Zoom out").click();
          await button("Fit graph").click();
          await button("Code").click();
          await expect(
            page.getByRole("textbox", { name: "Vector configuration code" }),
          ).toHaveAttribute("aria-readonly", "true");
          await expect(
            page.getByRole("textbox", { name: "Vector configuration code" }),
          ).toHaveAttribute("contenteditable", "false");
          expect(fixture.mutations).toEqual([]);
        }
      },
    );
    await check(
      "keyboard context menu, responsive toolbar and mobile picker remain accessible and within the viewport",
      async () => {
        await load({ width: 899, height: 1000 });
        await noOverflow("899px toolbar");
        await page
          .locator('.editor-graph[aria-label="Pipeline canvas"]')
          .focus();
        await page.keyboard.press("Shift+F10");
        await expect(menu()).toBeVisible();
        await page.screenshot({
          path: resolve(output, "editor-canvas-menu-899-light.png"),
          animations: "disabled",
        });
        await page.keyboard.press("ArrowUp");
        await expect(
          menu().locator(".canvas-component-result").last(),
        ).toBeFocused();
        await menu()
          .getByRole("textbox", { name: "Search components" })
          .focus();
        await menu()
          .getByRole("textbox", { name: "Search components" })
          .fill("demo_logs");
        await page.keyboard.press("ArrowDown");
        await expect(menu().locator(".canvas-component-result")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(
          page.locator('.editor-graph[aria-label="Pipeline canvas"]'),
        ).toBeFocused();
        await axe("899px canvas");
        await page.locator('.react-flow__node[data-id="sample"]').click();
        await expect(page.locator(".editor-inspector")).toBeVisible();
        await expect
          .poll(() =>
            page.locator(".react-flow").evaluate((canvas) => {
              const c = canvas.getBoundingClientRect();
              const n = canvas
                .querySelector('.react-flow__node[data-id="sample"]')
                .getBoundingClientRect();
              return (
                n.left >= c.left &&
                n.right <= c.right &&
                n.top >= c.top &&
                n.bottom <= c.bottom
              );
            }),
          )
          .toBe(true);
        await page.screenshot({
          path: resolve(output, "editor-canvas-inspector-899-light.png"),
          animations: "disabled",
        });
        await closeInspector();
        await page.setViewportSize({ width: 375, height: 900 });
        await noOverflow("375px toolbar");
        await button("Fit graph").click();
        await expect
          .poll(async () => {
            return page.locator(".react-flow").evaluate((canvas) => {
              const r = canvas.getBoundingClientRect();
              return Array.from(
                canvas.querySelectorAll(".react-flow__node"),
              ).every((node) => {
                const n = node.getBoundingClientRect();
                return (
                  n.left >= r.left - 1 &&
                  n.right <= r.right + 1 &&
                  n.top >= r.top - 1 &&
                  n.bottom <= r.bottom + 1
                );
              });
            });
          })
          .toBe(true);
        await button("Add component").click();
        await expect(menu()).toBeVisible();
        const bounds = await menu().boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
        await axe("mobile component menu");
        await page.screenshot({
          path: resolve(output, "editor-canvas-mobile-light.png"),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        expect(fixture.mutations).toEqual([]);
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "dark";
        });
        await button("Add component").click();
        await axe("mobile dark component menu");
        await noOverflow("375px dark picker");
        await page.screenshot({
          path: resolve(output, "editor-canvas-mobile-dark.png"),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
      },
    );
    await check(
      "a failed pipeline read offers retry without writing or losing the editor route",
      async () => {
        await load();
        fixture.readsUnavailable = true;
        await page.reload();
        await expect(button("Retry opening pipeline")).toBeVisible();
        await expect(
          page.getByText("Synthetic read unavailable", { exact: false }),
        ).toBeVisible();
        await axe("pipeline load error");
        await page.screenshot({
          path: resolve(output, "pipeline-load-error.png"),
          animations: "disabled",
        });
        fixture.readsUnavailable = false;
        await button("Retry opening pipeline").click();
        await expect(page.locator(".react-flow__node")).toHaveCount(5);
        expect(fixture.mutations).toEqual([]);
        expect(fixture.saveAttempts).toEqual([]);
      },
    );
    await check(
      "a stalled pipeline read times out and a late response cannot replace a retried draft",
      async () => {
        await load();
        await page.clock.install();
        fixture.holdReads = true;
        await page.reload();
        await expect.poll(() => fixture.pendingReads.length).toBeGreaterThan(0);
        await page.clock.fastForward(15_050);
        await page.clock.runFor(100);
        await expect(button("Retry opening pipeline")).toBeVisible();
        fixture.document.revision = 2;
        fixture.document.config.transforms.sample.rate = 20;
        fixture.holdReads = false;
        await button("Retry opening pipeline").click();
        await expect(page.locator(".react-flow__node")).toHaveCount(5);
        await page.locator('.react-flow__node[data-id="sample"]').click();
        await expect(
          page.locator(".editor-inspector").getByLabel("One in every", {
            exact: true,
          }),
        ).toHaveValue("20");
        for (const release of fixture.pendingReads.splice(0)) release();
        await page.clock.runFor(100);
        await expect(
          page.locator(".editor-inspector").getByLabel("One in every", {
            exact: true,
          }),
        ).toHaveValue("20");
        expect(fixture.saveAttempts).toEqual([]);
      },
    );
    await check(
      "a stalled published-version lookup can retry without losing unsaved edits or accepting a late response",
      async () => {
        await load({ published: true });
        await expect(button("Choose devices")).toBeVisible();
        await page.clock.install();
        fixture.holdHistory = true;
        await page.reload();
        await expect
          .poll(() => fixture.pendingHistory.length)
          .toBeGreaterThan(0);
        await expect(button("Checking version")).toBeDisabled();
        await page.clock.fastForward(15_050);
        await page.clock.runFor(100);
        await expect(button("Retry version check")).toBeVisible();
        await expect(
          page.locator(".editor-published-status-error"),
        ).toContainText("response is taking too long");
        await page.locator('.react-flow__node[data-id="sample"]').click();
        await page
          .locator(".editor-inspector")
          .getByLabel("One in every", { exact: true })
          .fill("23");
        fixture.published = false;
        fixture.holdHistory = false;
        await button("Retry version check").click();
        await expect(button("Review & publish")).toBeVisible();
        await expect(
          page.locator(".editor-published-status-error"),
        ).toHaveCount(0);
        await expect(
          page.locator(".editor-inspector").getByLabel("One in every", {
            exact: true,
          }),
        ).toHaveValue("23");
        for (const release of fixture.pendingHistory.splice(0)) release();
        await page.clock.runFor(100);
        await expect(button("Review & publish")).toBeVisible();
        expect(fixture.mutations).toEqual([]);
      },
    );
    await check(
      "a stalled published-version detail read times out without enabling publication",
      async () => {
        await load({ published: true });
        await expect(button("Choose devices")).toBeVisible();
        await page.clock.install();
        fixture.holdVersion = true;
        await page.reload();
        await expect
          .poll(() => fixture.pendingVersion.length)
          .toBeGreaterThan(0);
        await expect(button("Checking version")).toBeDisabled();
        await page.clock.fastForward(15_050);
        await page.clock.runFor(100);
        await expect(button("Retry version check")).toBeVisible();
        fixture.published = false;
        fixture.holdVersion = false;
        await button("Retry version check").click();
        await expect(button("Review & publish")).toBeVisible();
        for (const release of fixture.pendingVersion.splice(0)) release();
        await page.clock.runFor(100);
        await expect(button("Review & publish")).toBeVisible();
        expect(fixture.mutations).toEqual([]);
      },
    );
    await check(
      "archived pipelines retry failed and mismatched published-version reads without republishing",
      async () => {
        await load({ published: true, archived: true });
        await expect(button("Choose devices")).toBeVisible();
        fixture.versionUnavailable = true;
        await page.reload();
        await expect(button("Retry version check")).toBeVisible();
        await expect(
          page.locator(".editor-published-status-error"),
        ).toContainText("Published version unavailable");
        fixture.versionUnavailable = false;
        fixture.versionIdentityMismatch = true;
        await button("Retry version check").click();
        await expect(button("Retry version check")).toBeVisible();
        await expect(
          page.locator(".editor-published-status-error"),
        ).toContainText("did not match this pipeline");
        fixture.versionIdentityMismatch = false;
        await button("Retry version check").click();
        await expect(button("Choose devices")).toBeVisible();
        expect(fixture.mutations).toEqual([]);
      },
    );
    await check(
      "editor-only users can retry publication status without reloading their unsaved draft",
      async () => {
        await load({ role: "editor" });
        fixture.historyUnavailable = true;
        await page.reload();
        await expect(button("Retry version check")).toBeVisible();
        await page.locator('.react-flow__node[data-id="sample"]').click();
        await page
          .locator(".editor-inspector")
          .getByLabel("One in every", { exact: true })
          .fill("23");
        fixture.historyUnavailable = false;
        await button("Retry version check").click();
        await expect(
          page.locator(".editor-published-status-error"),
        ).toHaveCount(0);
        await expect(
          page.locator(".editor-inspector").getByLabel("One in every", {
            exact: true,
          }),
        ).toHaveValue("23");
        await expect(
          page
            .locator(".editor-toolbar")
            .getByRole("button", { name: "Save", exact: true }),
        ).toBeEnabled();
        expect(fixture.mutations).toEqual([]);
      },
    );
    await check(
      "a link that names a step and a field opens the pipeline with that step selected and the field in view; a step or field this draft lacks opens it with one line saying so",
      async () => {
        await load();
        // Each visit is a fresh load of the link, as when it is followed.
        const visit = async (query) => {
          await page.goto(
            `${origin}/__editor-canvas-fixture#/configurations/${pipelineId}${query}`,
          );
          await page.reload();
          await expect(page.locator(".react-flow__node")).toHaveCount(5);
        };
        const inspector = () => page.locator(".editor-inspector");
        const rate = () =>
          inspector().getByRole("textbox", {
            name: "One in every",
            exact: true,
          });
        // The toast: the same words also sit in the screen-reader live region.
        const note = (text) =>
          page
            .getByRole("region", { name: "Notifications" })
            .getByText(text, { exact: true });
        await visit("?select=sample&field=rate");
        await expect(inspector()).toBeVisible();
        await expect(rate()).toBeFocused();
        await expect(page.locator(".pipeline-node-selected")).toHaveCount(1);
        await expect(
          page.locator(
            '.react-flow__node[data-id="sample"] .pipeline-node-selected, .react-flow__node[data-id="sample"].pipeline-node-selected',
          ),
        ).toHaveCount(1);
        await expect(
          page.locator(".toast-stack, [role=status]"),
        ).not.toContainText("in this draft");
        // The step alone selects it.
        await visit("?select=branch");
        await expect(inspector()).toBeVisible();
        await expect(inspector()).toContainText("branch");
        await expect(page.locator(".pipeline-node-selected")).toHaveCount(1);
        // A VRL setting: the cursor goes into its program.
        await visit("?select=branch&field=route.accepted");
        await expect(inspector().locator(".cm-content").first()).toBeFocused();
        await expect(page.getByText(/no “route.accepted” setting/)).toHaveCount(
          0,
        );
        // A step this draft does not have: the pipeline opens, nothing is
        // selected, and one line says why.
        await visit("?select=missing&field=rate");
        await expect(
          note("There is no step called “missing” in this draft."),
        ).toBeVisible();
        await expect(inspector()).toHaveCount(0);
        await expect(page.locator(".react-flow__node")).toHaveCount(5);
        // A field the step does not have: the step opens, with that line.
        await visit("?select=sample&field=nothing");
        await expect(
          note("sample has no “nothing” setting in this draft."),
        ).toBeVisible();
        await expect(inspector()).toBeVisible();
        await expect(page.locator(".pipeline-node-selected")).toHaveCount(1);
        expect(fixture.mutations).toEqual([]);
        // Moving to another step and field inside the open editor works too.
        await page.evaluate((id) => {
          location.hash = `#/configurations/${id}?select=branch`;
        }, pipelineId);
        await expect(inspector()).toContainText("branch");
        await page.evaluate((id) => {
          location.hash = `#/configurations/${id}?select=sample&field=rate`;
        }, pipelineId);
        await expect(rate()).toBeFocused();
        expect(fixture.mutations).toEqual([]);
      },
    );
    expect(results).toHaveLength(14);
  }
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const file of [
    "src/App.tsx",
    "src/Editor.tsx",
    "src/editor.css",
    "src/editor-canvas.css",
    "src/styles.css",
    "src/CanvasComponentMenu.tsx",
    "src/PipelineNode.tsx",
    "src/PipelineEdge.tsx",
    "src/PipelineDetails.tsx",
    "src/PipelineSaveStatus.tsx",
    "src/pipeline-save-status.css",
    "src/PipelineCheckButton.tsx",
    "src/useHoverDisclosure.ts",
    "src/connectionStyle.ts",
    "src/ConnectionStylePicker.tsx",
    "src/useDismissibleDetails.ts",
    "src/ComponentIcon.tsx",
    "src/pipelineNodeModel.ts",
    "src/pipeline-node.css",
    "src/pipeline-categories.css",
    "src/PipelineSettings.tsx",
    "src/PipelineGlobals.tsx",
    "src/PipelineVariables.tsx",
    "src/variableFields.ts",
    "src/SchemaValueEditor.tsx",
    "src/catalog.ts",
    "src/pipelineEditing.ts",
  ])
    source_sha256[`dashboard/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, file)))
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
        generated_at: new Date().toISOString(),
        scope: editorHeaderOnly
          ? editorHeaderLayoutOnly
            ? "Focused header layout follow-up after title sizing CSS: read-only metadata, computed899/375px geometry, light/dark screenshots and eight accessibility scans. Earlier metadata-write/status/guard groups were not rerun; no real preview/server/device mutations."
            : "Actual App/editor with isolated synthetic API: metadata entry and CAS failures, pending field/code guards, status transitions, readonly boundaries and responsive accessibility. All writes remain in the disposable in-memory fixture; no real preview/server/device mutations."
          : connectionStyleOnly
            ? "Actual App/editor with isolated synthetic API: local connection style path/preview/persistence, unchanged configuration/check state, selected-edge reconnect/undo, readonly preferences and responsive accessibility. Only reconnect/undo writes the disposable in-memory fixture; no preview/server/device mutations."
            : variablesOnly
              ? "Actual App/editor with isolated synthetic API: version-variable declaration editing, explicit draft CAS save, discard, read-only boundaries, and focused accessibility scans. All writes remain in the disposable in-memory fixture; no real publication, deployment, or device changes."
              : splitSaveOnly
                ? splitSaveFollowup
                  ? "Final split-save follow-up: held-save failure/retry and 899/800/375px popup geometry/accessibility after nonmodal menu and error-reset changes; other earlier behavioral groups were not rerun. Synthetic in-memory API only."
                  : "Focused actual App/editor save controls: visible Save, Ctrl/Cmd+S, save options and notes, held/failed saves, role boundaries and browser draft recovery, with isolated synthetic draft CAS and published-version fixtures. No real preview validation, save, publication or deployment requests."
                : checkStateOnly
                  ? "Focused actual App/editor check states: labels, stale, pending and Code checks, unavailable checker, auto-check and color contrast, with isolated synthetic validation and draft responses. No real server/preview validation or device/publication mutations."
                  : nodeActionsOnly
                    ? "Focused node-action and inspector ownership review using the actual App/editor with isolated synthetic API: duplicate/remove, exact undo, declined pending-field removal, keyboard access, read-only guards and three viewport/theme accessibility scans. No real server, preview or native device mutations."
                    : checksLayoutOnly
                      ? "Focused actual-App Problems panel containment, keyboard toggle and problem-to-field navigation at 375px and 899px with a mocked validation response. No real server validation or draft/publication/device mutations; earlier interaction groups were not rerun."
                      : menuLayoutOnly
                        ? "Focused CSS follow-up on actual App/editor: S3 icon sizing, compact two-result height, viewport containment and light/dark accessibility. Isolated GET-only synthetic API; the earlier seven interaction groups were not rerun for this CSS follow-up."
                        : "Actual App/editor with isolated synthetic API and in-memory draft CAS; no preview, publication, enrollment, deployment, or native activation. Accessibility scope is limited to scanned states.",
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
    "Evidence: " + relative(repository, resolve(output, "report.json")),
  );
}
