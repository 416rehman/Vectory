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
const layoutOnly = process.env.VECTORY_EDITOR_DISCARD_FOCUS === "layout";
const output = resolve(
  repository,
  process.env.VECTORY_EDITOR_DISCARD_OUTPUT || ".local/editor-discard",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:editor-discard-fixture";
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
      name: "editor-discard-independent-fixture",
      resolveId(id) {
        if (id === "virtual:editor-discard-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__editor-discard-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic canvas verification</title></head><body><div id="root"></div><script type="module">import "virtual:editor-discard-fixture";</script></body></html>',
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
  theme = "light",
  collapsed = true,
  document = baseDocument(),
} = {}) {
  // Closing an old isolated context cannot affect the synthetic persisted fixture.
  if (page) await page.context().close();
  fixture = {
    document: structuredClone(document),
    mutations: [],
    validations: [],
    holdSave: false,
    holdReload: false,
    failSave: false,
    pendingSaves: [],
    pendingReloads: [],
    attempts: [],
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
    ({ theme, collapsed }) => {
      localStorage.setItem("vectory-sidebar-collapsed", String(collapsed));
      localStorage.setItem("vectory-theme", theme);
      localStorage.setItem("vectory.editor.auto-check", "off");
      window.__copiedCode = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => window.__copiedCode.push(text) },
      });
      window.__pendingFileReads = [];
      const originalRead = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        if (this.name.startsWith("delayed-"))
          return new Promise((resolve) =>
            window.__pendingFileReads.push({
              name: this.name,
              resolve: () => originalRead.call(this).then(resolve),
            }),
          );
        return originalRead.call(this);
      };
    },
    { theme, collapsed },
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
            email: "code-import@example.test",
            name: "Synthetic operator",
            role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic-code-csrf",
        });
      // The publish review shows where versions are assigned.
      if (path === "/devices") return reply([]);
      if (path === "/settings")
        return reply({ instance_name: "Synthetic isolated editor" });
      if (path === `/configurations/${pipelineId}`) {
        if (current.holdReload)
          await new Promise((resolve) => current.pendingReloads.push(resolve));
        return reply(current.document);
      }
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
    if (request.headers()["x-csrf-token"] !== "synthetic-code-csrf") {
      unexpected.push(`Missing CSRF ${method} ${path}`);
      return reject("FORBIDDEN", "Missing fixture CSRF", 403);
    }
    if (role === "viewer" || archived) {
      unexpected.push(`Read-only mutation ${method} ${path}`);
      return reject("FORBIDDEN", "Read-only fixture", 403);
    }
    if (method === "PUT" && path === `/configurations/${pipelineId}/draft`) {
      const body = request.postDataJSON();
      current.attempts.push(structuredClone(body));
      let fail = current.failSave;
      if (current.holdSave)
        fail = await new Promise((resolve) =>
          current.pendingSaves.push({ body, release: resolve }),
        );
      if (fail) return reject("SAVE_FAILED", "Synthetic save failure", 503);
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
    // The VRL studio tries a program against samples; no tester here.
    if (method === "POST" && path === "/vrl/test")
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "VRL tester unavailable" }),
      });
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
    `${origin}/__editor-discard-fixture#/configurations/${pipelineId}`,
  );
  await expect(
    page.getByRole("heading", { name: current.document.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".editor-draft-workspace")).toBeVisible();
  return current;
}
async function check(name, run) {
  if (layoutOnly && !name.startsWith("Compact discard")) return;
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
const button = (name) => page.getByRole("button", { name, exact: true });
async function fieldJSON(title) {
  await button(`Actions for ${title}`).click();
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
const codeInput = () =>
  page.getByRole("textbox", { name: "Vector configuration code", exact: true });
const replacement = () =>
  page.getByRole("dialog", {
    name: "Replace pipeline from file?",
    exact: true,
  });
function importedConfig() {
  return {
    sources: {
      imported_logs: { type: "demo_logs", format: "json", interval: 1 },
    },
    transforms: {
      keep: {
        type: "filter",
        inputs: ["imported_logs"],
        condition: ".message != null",
      },
    },
    sinks: { imported_output: { type: "blackhole", inputs: ["keep"] } },
  };
}
async function openCode(format = "json") {
  await button("Code").click();
  await expect(codeInput()).toBeVisible();
  await page.getByLabel("Format", { exact: true }).selectOption(format);
}
async function drop(files) {
  return page.locator(".editor-draft-workspace").evaluate((target, files) => {
    const transfer = new DataTransfer();
    for (const { name, text, size, bytes } of files)
      transfer.items.add(
        new File(
          [bytes ? new Uint8Array(bytes) : size ? " ".repeat(size) : text],
          name,
          {
            type: "application/octet-stream",
          },
        ),
      );
    target.dispatchEvent(
      new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
    target.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
    const event = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, files);
}
async function noOverflow(label) {
  const bounds = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(bounds.document, label).toBeLessThanOrEqual(bounds.viewport);
  measurements.push({ label, ...bounds });
}
async function axe(label) {
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

const discardButton = () =>
  page
    .locator(".editor-toolbar")
    .getByRole("button", { name: "Discard changes", exact: true });
const discardDialog = () =>
  page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
async function saveDraft() {
  await button("Save options").click();
  const save = page.getByRole("menuitem", { name: "Save draft", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
}
const rateInput = () =>
  page.locator(".editor-inspector").getByLabel("One in every", { exact: true });
async function selectSample() {
  await page.locator('.react-flow__node[data-id="sample"]').click();
  await expect(rateInput()).toBeVisible();
}
async function openDiscard() {
  await discardButton().click();
  await expect(discardDialog()).toBeVisible();
}
async function confirmDiscard() {
  await discardDialog()
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(discardDialog()).toHaveCount(0);
  await expect(discardButton()).toHaveCount(0);
}
async function expectClean() {
  await expect(discardButton()).toHaveCount(0);
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible();
}
async function completeCode() {
  await button("Copy code").click();
  return page.evaluate(() => window.__copiedCode.at(-1));
}
async function transforms() {
  return page
    .locator(".react-flow__node")
    .evaluateAll((nodes) =>
      Object.fromEntries(nodes.map((n) => [n.dataset.id, n.style.transform])),
    );
}
async function settle() {
  await page.waitForTimeout(2300);
}

try {
  await check(
    "Clean, viewer and archived drafts do not offer discard; code cancellation preserves pending text without writes",
    async () => {
      for (const options of [{}, { role: "viewer" }, { archived: true }]) {
        await load(options);
        await expect(discardButton()).toHaveCount(0);
        await openCode();
        await expect(discardButton()).toHaveCount(0);
        expect(fixture.attempts).toEqual([]);
      }
      await load({ width: 899 });
      await openCode();
      await codeInput().fill("{unfinished");
      await openDiscard();
      await discardDialog()
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(codeInput()).toHaveText("{unfinished");
      await expect(discardButton()).toBeVisible();
      await openDiscard();
      await page.keyboard.press("Escape");
      await expect(discardDialog()).toHaveCount(0);
      await expect(codeInput()).toHaveText("{unfinished");
      const before = requests.length;
      await openDiscard();
      await confirmDiscard();
      expect(JSON.parse(await completeCode())).toEqual(baseDocument().config);
      await expectClean();
      await settle();
      expect(requests.slice(before)).toEqual([]);
      expect(fixture.attempts).toEqual([]);
    },
  );
  await check(
    "Pending typed and field JSON drafts are discarded by unmounting the inspector without applying or saving them",
    async () => {
      await load();
      await selectSample();
      await rateInput().fill("-");
      await openDiscard();
      await confirmDiscard();
      await expect(page.locator(".editor-inspector")).toHaveCount(0);
      await selectSample();
      await expect(rateInput()).toHaveValue("10");
      const raw = await fieldJSON("Exclude");
      await raw.fill('{"unfinished":');
      await openDiscard();
      await confirmDiscard();
      await expect(page.locator(".editor-inspector")).toHaveCount(0);
      await selectSample();
      await expect(rateInput()).toHaveValue("10");
      expect(
        JSON.parse(await (await fieldJSON("Exclude")).textContent()),
      ).toEqual(baseDocument().config.transforms.sample.exclude);
      await expectClean();
      await settle();
      expect(fixture.attempts).toEqual([]);
      expect(fixture.document.config).toEqual(baseDocument().config);
    },
  );
  await check(
    "Renaming a route output asks before unmounting its pending field JSON condition and cancellation preserves both drafts",
    async () => {
      const document = baseDocument();
      document.config.transforms.branch.route.accepted = {
        type: "vrl",
        source: '.level == "info"',
      };
      await load({ document });
      await page
        .locator('.react-flow__node[data-id="branch"] .pipeline-node')
        .click();
      const raw = await fieldJSON("Condition for accepted");
      await raw.fill('{"unfinished":');
      const name = page.getByRole("textbox", {
        name: "Output name accepted",
        exact: true,
      });
      await name.fill("renamed");
      const prompts = [];
      page.once("dialog", async (dialog) => {
        prompts.push(dialog.message());
        await dialog.dismiss();
      });
      await button("Rename output").click();
      expect(prompts).toEqual(["Discard unapplied field changes?"]);
      await expect(raw).toHaveText('{"unfinished":');
      await expect(name).toHaveValue("renamed");
      expect(fixture.document.config.transforms.branch.route).toEqual(
        document.config.transforms.branch.route,
      );
      await openDiscard();
      await confirmDiscard();
      await expect(page.locator(".editor-inspector")).toHaveCount(0);
      await settle();
      expect(fixture.attempts).toEqual([]);
      expect(fixture.document.config).toEqual(document.config);
    },
  );
  await check(
    "Graph and configuration edits reset together, confirmation does not write, and stale file reads cannot restore discarded content",
    async () => {
      await load();
      await expect(page.locator(".react-flow__node")).toHaveCount(5);
      const original = await transforms();
      const sample = page.locator('.react-flow__node[data-id="sample"]');
      const box = await sample.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 35);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 65, box.y + 90, {
        steps: 6,
      });
      await page.mouse.up();
      await expect(discardButton()).toBeVisible();
      await openDiscard();
      await settle();
      expect(fixture.attempts).toEqual([]);
      await confirmDiscard();
      await expect.poll(transforms).toEqual(original);
      await selectSample();
      await rateInput().fill("20");
      await openDiscard();
      await settle();
      expect(fixture.attempts).toEqual([]);
      await confirmDiscard();
      await selectSample();
      await expect(rateInput()).toHaveValue("10");
      await page
        .getByRole("button", { name: "Close component settings", exact: true })
        .click();
      await expect(button("Undo")).toBeDisabled();
      await drop([
        { name: "delayed-stale.json", text: JSON.stringify(importedConfig()) },
      ]);
      await selectSample();
      await rateInput().fill("-");
      await openDiscard();
      await confirmDiscard();
      await page.evaluate(() =>
        window.__pendingFileReads.splice(0).forEach((x) => x.resolve()),
      );
      await page.waitForTimeout(150);
      await expect(replacement()).toHaveCount(0);
      await expectClean();
      await settle();
      expect(fixture.attempts).toEqual([]);
    },
  );
  await check(
    "Cancel retains unsaved edits, and a later failed explicit save discards to the latest successful revision",
    async () => {
      await load();
      await selectSample();
      await rateInput().fill("11");
      await openDiscard();
      await settle();
      expect(fixture.attempts).toEqual([]);
      await discardDialog()
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      expect(fixture.attempts).toEqual([]);
      await saveDraft();
      await expect
        .poll(() => fixture.document.config.transforms.sample.rate)
        .toBe(11);
      await expectClean();
      fixture.failSave = true;
      await rateInput().fill("12");
      await saveDraft();
      await expect(
        page.locator(".pipeline-save-status[data-save-state='failed']:visible"),
      ).toBeVisible();
      const before = requests.length,
        attempts = fixture.attempts.length,
        rev = fixture.document.revision;
      await openDiscard();
      await confirmDiscard();
      await selectSample();
      await expect(rateInput()).toHaveValue("11");
      await expectClean();
      await settle();
      expect(fixture.attempts).toHaveLength(attempts);
      expect(requests.slice(before)).toEqual([]);
      expect(fixture.document.revision).toBe(rev);
    },
  );
  await check(
    "Confirmation waits for an in-flight successful save, then restores its acknowledged snapshot and drops newer unsent edits",
    async () => {
      await load();
      fixture.holdSave = true;
      await selectSample();
      await rateInput().fill("11");
      await saveDraft();
      await expect.poll(() => fixture.pendingSaves.length).toBe(1);
      await rateInput().fill("12");
      await openDiscard();
      await discardDialog()
        .getByRole("button", { name: "Discard changes", exact: true })
        .click();
      await expect(discardDialog()).toBeVisible();
      await expect(
        discardDialog().getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(discardDialog()).toBeVisible();
      fixture.pendingSaves.shift().release(false);
      await expect(discardDialog()).toHaveCount(0);
      await expectClean();
      await selectSample();
      await expect(rateInput()).toHaveValue("11");
      await settle();
      expect(fixture.attempts).toHaveLength(1);
      expect(fixture.document.config.transforms.sample.rate).toBe(11);
    },
  );
  await check(
    "An in-flight failed save restores the earlier acknowledged draft and does not retry or leave a false dirty state",
    async () => {
      await load();
      fixture.holdSave = true;
      await selectSample();
      await rateInput().fill("11");
      await saveDraft();
      await expect.poll(() => fixture.pendingSaves.length).toBe(1);
      await rateInput().fill("12");
      await openDiscard();
      await discardDialog()
        .getByRole("button", { name: "Discard changes", exact: true })
        .click();
      fixture.pendingSaves.shift().release(true);
      await expect(discardDialog()).toHaveCount(0);
      await selectSample();
      await expect(rateInput()).toHaveValue("10");
      await expectClean();
      await settle();
      expect(fixture.attempts).toHaveLength(1);
      expect(fixture.document.revision).toBe(1);
      expect(fixture.mutations).toEqual([]);
    },
  );
  await check(
    "Compact discard and confirmation remain contained and accessible at 899px and mobile light/dark widths",
    async () => {
      for (const { width, theme } of [
        { width: 899, theme: "light" },
        { width: 800, theme: "light" },
        { width: 375, theme: "light" },
        { width: 375, theme: "dark" },
      ]) {
        await load({ width, height: 900, theme, collapsed: false });
        await openCode();
        await codeInput().fill("{pending");
        await noOverflow(width + " " + theme + " toolbar");
        for (const locator of [
          discardButton(),
          button("Graph"),
          button("Code"),
          page.locator(".editor-tools-menu summary"),
          page
            .locator(".editor-header-actions")
            .getByRole("button", { name: "Review & publish", exact: true }),
        ]) {
          await expect(locator).toBeInViewport();
          const box = await locator.boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        await page.screenshot({
          path: resolve(
            output,
            "discard-toolbar-" + width + "-" + theme + ".png",
          ),
          animations: "disabled",
        });
        await openDiscard();
        await noOverflow(width + " " + theme + " confirmation");
        await axe(width + " " + theme + " confirmation");
        await page.screenshot({
          path: resolve(
            output,
            "discard-confirmation-" + width + "-" + theme + ".png",
          ),
          animations: "disabled",
        });
        await confirmDiscard();
        await expectClean();
        expect(fixture.attempts).toEqual([]);
      }
    },
  );
  await check(
    "A stalled draft save releases the editor without discarding an unconfirmed write",
    async () => {
      await load();
      await page.clock.install();
      fixture.holdSave = true;
      await selectSample();
      await rateInput().fill("11");
      await saveDraft();
      await expect.poll(() => fixture.pendingSaves.length).toBe(1);
      await page.clock.fastForward(30_050);
      await page.clock.runFor(100);
      await expect(
        page.locator(".pipeline-save-status[data-save-state='uncertain']"),
      ).toBeVisible();
      await expect(rateInput()).toHaveValue("11");
      await discardButton().click();
      await expect(discardDialog()).toHaveCount(0);
      await expect(button("Retry Save draft")).toBeVisible();
      fixture.holdSave = false;
      fixture.pendingSaves.shift().release(false);
      await expect.poll(() => fixture.document.revision).toBe(2);
      await button("Retry Save draft").click();
      await expect(
        page.locator(".pipeline-save-status[data-save-state='conflict']"),
      ).toBeVisible();
      await expect(rateInput()).toHaveValue("11");
      await discardButton().click();
      await expect(discardDialog()).toHaveCount(0);
      await expect(button("Retry Save draft")).toHaveCount(0);
      await page
        .getByRole("button", { name: "Close component settings", exact: true })
        .click();
      page.once("dialog", (dialog) => dialog.accept());
      await button("Reload server draft").click();
      await expectClean();
      await selectSample();
      await expect(rateInput()).toHaveValue("11");

      // A reload can discard local edits without pretending that an earlier
      // timed-out write has definitely stopped when the revision has not moved.
      await load();
      await page.clock.install();
      fixture.holdSave = true;
      await selectSample();
      await rateInput().fill("12");
      await saveDraft();
      await expect.poll(() => fixture.pendingSaves.length).toBe(1);
      await page.clock.fastForward(30_050);
      await page.clock.runFor(100);
      await expect(button("Reload server draft")).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await button("Reload server draft").click();
      await expect(
        page.locator(".pipeline-save-status[data-save-state='uncertain']"),
      ).toBeVisible();
      await expect(discardButton()).toHaveCount(0);
      await expect(button("Retry Save draft")).toHaveCount(0);
      await expect(
        page.getByText("An earlier save may still finish and change it.", {
          exact: false,
        }),
      ).toBeVisible();
      await selectSample();
      await expect(rateInput()).toHaveValue("10");
      fixture.pendingSaves.shift().release(true);
      fixture.holdSave = false;
      await button("Confirm server draft").click();
      await expectClean();
      expect(fixture.document.revision).toBe(2);
      expect(fixture.document.config.transforms.sample.rate).toBe(10);

      // A held recovery read locks the workspace until its result is applied.
      await load();
      fixture.document.revision = 2;
      await selectSample();
      await rateInput().fill("11");
      await saveDraft();
      await expect(
        page.locator(".pipeline-save-status[data-save-state='conflict']"),
      ).toBeVisible();
      fixture.holdReload = true;
      page.once("dialog", (dialog) => dialog.accept());
      await button("Reload server draft").click();
      await expect.poll(() => fixture.pendingReloads.length).toBe(1);
      await expect(page.locator(".editor-draft-workspace")).toHaveAttribute(
        "inert",
        "",
      );
      expect(
        await rateInput().evaluate((input) => !!input.closest("[inert]")),
      ).toBe(true);
      await expect(rateInput()).toHaveValue("11");
      fixture.holdReload = false;
      fixture.pendingReloads.shift()();
      await expectClean();
      await selectSample();
      await expect(rateInput()).toHaveValue("10");
    },
  );
  expect(results).toHaveLength(layoutOnly ? 1 : 9);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const file of [
    "src/Editor.tsx",
    "src/editor.css",
    "src/editor-canvas.css",
    "src/SchemaValueEditor.tsx",
    "src/PipelineSchemaFields.tsx",
    "src/PipelineSettings.tsx",
    "src/ConfigurationCodeEditor.tsx",
  ])
    source_sha256["dashboard/" + file] = createHash("sha256")
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
        scope:
          "Actual App/editor with synthetic isolated in-memory draft responses, held and failed explicit saves. No real preview/server/device requests or publication. Discard itself must send no GET/PUT; saves are exercised only against the fixture.",
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
