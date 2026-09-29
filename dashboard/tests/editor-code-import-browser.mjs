// Actual App/editor, isolated synthetic API. Never contacts preview or devices.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";
import YAML from "yaml";
import { stringify as stringifyToml } from "smol-toml";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_EDITOR_CODE_IMPORT_OUTPUT || ".local/editor-code-import",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:editor-code-import-fixture";
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "editor-code-import-independent-fixture",
      resolveId(id) {
        if (id === "virtual:editor-code-import-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__editor-code-import-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic canvas verification</title></head><body><div id="root"></div><script type="module">import "virtual:editor-code-import-fixture";</script></body></html>',
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
  theme = "light",
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
  await context.addInitScript(
    ({ theme }) => {
      localStorage.setItem("vectory-sidebar-collapsed", "true");
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
    { theme },
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
    `${origin}/__editor-code-import-fixture#/configurations/${pipelineId}`,
  );
  await expect(
    page.getByRole("heading", { name: current.document.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".editor-draft-workspace")).toBeVisible();
  return current;
}
async function check(name, run) {
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
const button = (name) => page.getByRole("button", { name, exact: true });
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
function emptyDocument() {
  return {
    ...baseDocument(),
    config: { sources: {}, transforms: {}, sinks: {} },
  };
}
async function codeValue() {
  return codeInput().innerText();
}
async function openCode(format = "json") {
  await button("Code").click();
  await expect(codeInput()).toBeVisible();
  await page.getByLabel("Format", { exact: true }).selectOption(format);
}
async function saved(config) {
  await button("Save options").click();
  await page.getByRole("menuitem", { name: "Save draft", exact: true }).click();
  await expect
    .poll(() => JSON.stringify(fixture.document.config), { timeout: 10000 })
    .toBe(JSON.stringify(config));
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
async function toast(pattern) {
  await expect(page.locator(".toast")).toContainText(pattern);
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

try {
  await check(
    "rich code has syntax colors and line diagnostics; format, exact copy and three formats preserve configuration",
    async () => {
      await load();
      await openCode();
      await expect(
        page.locator(".cm-lineNumbers .cm-gutterElement").nth(1),
      ).toBeVisible();
      await expect(page.locator(".cce-property").first()).toBeVisible();
      const colors = await page
        .locator(".cce-property, .cce-string, .cce-number")
        .evaluateAll((nodes) => [
          ...new Set(nodes.map((node) => getComputedStyle(node).color)),
        ]);
      expect(colors.length).toBeGreaterThan(1);
      await codeInput().fill(JSON.stringify(baseDocument().config));
      await codeInput().press("ControlOrMeta+Home");
      for (let i = 0; i < 6; i++) await codeInput().press("Shift+ArrowRight");
      const selectedText = await page.evaluate(() =>
        getSelection()?.toString(),
      );
      expect(selectedText.length).toBeGreaterThan(0);
      await page.waitForTimeout(450);
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(
        selectedText,
      );
      await button("Format code").click();
      expect(JSON.parse(await codeValue())).toEqual(baseDocument().config);
      expect(await codeValue()).toContain("\n");
      await button("Copy code").click();
      expect(await page.evaluate(() => window.__copiedCode.at(-1))).toBe(
        await codeValue(),
      );
      for (const format of ["yaml", "toml", "json"]) {
        await page.getByLabel("Format", { exact: true }).selectOption(format);
        await expect(codeInput()).not.toBeEmpty();
      }
      expect(JSON.parse(await codeValue())).toEqual(baseDocument().config);
      await codeInput().fill('{\n  "sources": !\n}');
      await expect(
        page.locator(".cm-lintRange-error, .cm-lintPoint-error").first(),
      ).toBeVisible();
      await expect(page.locator(".cm-lint-marker-error").first()).toBeVisible();
      await button("Graph").click();
      await expect(codeInput()).toBeVisible();
      expect(await codeValue()).toBe('{\n  "sources": !\n}');
      expect(fixture.mutations).toEqual([]);
    },
  );

  await check(
    "one valid uppercase-extension file dropped on an empty graph loads exact values and remains undoable",
    async () => {
      await load({ document: emptyDocument() });
      const incoming = {
        ...importedConfig(),
        x_fixture: { enabled: false, optional: null, order: [2, 1] },
      };
      expect(
        await drop([{ name: "pipeline.JSON", text: JSON.stringify(incoming) }]),
      ).toBe(true);
      await expect(replacement()).toHaveCount(0);
      await saved(incoming);
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
      await button("Undo").click();
      await saved(emptyDocument().config);
      await button("Redo").click();
      await saved(incoming);
      for (const [format, text] of [
        ["yml", YAML.stringify(importedConfig())],
        ["toml", stringifyToml(importedConfig())],
      ]) {
        await load({ document: emptyDocument() });
        await openCode(format === "yml" ? "yaml" : format);
        await drop([{ name: `code-view.${format}`, text }]);
        await saved(importedConfig());
        await expect(codeInput()).toBeVisible();
        await expect(replacement()).toHaveCount(0);
      }
    },
  );

  await check(
    "malformed, duplicate, unsafe and non-pipeline files explain refusal and leave draft bytes unchanged",
    async () => {
      await load();
      const before = structuredClone(fixture.document);
      const rejected = [
        {
          name: "invalid-utf8.json",
          bytes: [123, 34, 120, 34, 58, 34, 255, 34, 125],
          reason: /UTF-8|encoding|encoded/i,
        },
        {
          name: "bad.json",
          text: '{"sources":',
          reason: /parse|JSON|unexpected|expected|invalid/i,
        },
        {
          name: "duplicate.json",
          text: '{"sources":{},"sources":{}}',
          reason: /duplicate|unique/i,
        },
        {
          name: "duplicate.yml",
          text: "sources: {}\nsources: {}\n",
          reason: /duplicate|unique/i,
        },
        { name: "array.json", text: "[]", reason: /object/i },
        {
          name: "unsafe.json",
          text: '{"x":9007199254740993}',
          reason: /exact|safe|number/i,
        },
        {
          name: "cycle.yaml",
          text: "x: &loop\n  child: *loop\n",
          reason: /cycle|circular|alias/i,
        },
        {
          name: "missing.json",
          text: '{"sources":{"a":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["missing"]}}}',
          reason: /missing|input/i,
        },
      ];
      for (const { reason, ...file } of rejected) {
        await drop([file]);
        await toast(reason);
        await expect(replacement()).toHaveCount(0);
        expect(fixture.document).toEqual(before);
      }
      await page.waitForTimeout(2150);
      expect(fixture.mutations).toEqual([]);
    },
  );

  await check(
    "nonempty import requires a readable replacement diff; cancel is inert and confirmation is undoable",
    async () => {
      await load();
      const before = structuredClone(fixture.document.config),
        incoming = importedConfig();
      await drop([
        { name: "replacement.json", text: JSON.stringify(incoming, null, 2) },
      ]);
      await expect(replacement()).toBeVisible();
      await expect(
        page.getByLabel("Configuration changes", { exact: true }),
      ).toBeVisible();
      await expect(replacement()).toContainText("imported_logs");
      await expect(replacement()).toContainText("branch");
      await page
        .getByLabel("Diff format", { exact: true })
        .selectOption("yaml");
      await replacement()
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      expect(fixture.document.config).toEqual(before);
      expect(fixture.mutations).toEqual([]);
      await drop([
        { name: "replacement.json", text: JSON.stringify(incoming) },
      ]);
      await replacement()
        .getByRole("button", { name: "Replace pipeline", exact: true })
        .click();
      await saved(incoming);
      await button("Undo").click();
      await saved(before);
      expect(fixture.document.config.sinks.output.inputs).toEqual([
        "branch.accepted",
      ]);
      await load({
        document: { ...emptyDocument(), config: { timezone: "UTC" } },
      });
      await drop([
        { name: "globals-replacement.json", text: JSON.stringify(incoming) },
      ]);
      await expect(replacement()).toBeVisible();
      await replacement()
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      expect(fixture.document.config).toEqual({ timezone: "UTC" });
      expect(fixture.mutations).toEqual([]);
    },
  );

  await check(
    "pending code blocks dropped replacements and lossy TOML conversion without discarding typed text",
    async () => {
      await load();
      await openCode();
      const pending = '{\n  "pending-local":';
      await codeInput().fill(pending);
      await drop([
        { name: "replacement.json", text: JSON.stringify(importedConfig()) },
      ]);
      await toast(/apply|discard|pending|unapplied/i);
      await expect(replacement()).toHaveCount(0);
      expect(await codeValue()).toBe(pending);
      expect(fixture.mutations).toEqual([]);
      await button("Discard code changes").click();
      expect(JSON.parse(await codeValue())).toEqual(baseDocument().config);
      expect(fixture.mutations).toEqual([]);
      await drop([
        { name: "after-discard.json", text: JSON.stringify(importedConfig()) },
      ]);
      await expect(replacement()).toBeVisible();
      await replacement()
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      const nullable = {
        ...baseDocument().config,
        x_fixture: { optional: null, order: [1, 2], enabled: false },
      };
      await codeInput().fill(JSON.stringify(nullable));
      await page.getByLabel("Format", { exact: true }).selectOption("toml");
      await expect(page.getByLabel("Format", { exact: true })).toHaveValue(
        "json",
      );
      expect(JSON.parse(await codeValue())).toEqual(nullable);
      expect(fixture.mutations).toEqual([]);
      await load();
      await page.locator('.react-flow__node[data-id="sample"]').click();
      const rate = page
        .locator(".editor-inspector")
        .getByLabel("One in every", { exact: true });
      await rate.fill("-");
      await drop([
        { name: "pending-field.json", text: JSON.stringify(importedConfig()) },
      ]);
      await toast(/apply|discard|pending/i);
      await expect(rate).toHaveValue("-");
      await expect(replacement()).toHaveCount(0);
      expect(fixture.mutations).toEqual([]);
    },
  );

  await check(
    "delayed reads cannot overwrite newer code and multiple, oversized or unsupported files are refused",
    async () => {
      await load({ document: emptyDocument() });
      await openCode();
      await drop([
        {
          name: "delayed-candidate.json",
          text: JSON.stringify(importedConfig()),
        },
      ]);
      await expect
        .poll(() => page.evaluate(() => window.__pendingFileReads.length))
        .toBe(1);
      const pending = '{"newer-local-edit":';
      await codeInput().fill(pending);
      await page.evaluate(() => window.__pendingFileReads.shift().resolve());
      await toast(/changed|stale|again|pending/i);
      expect(await codeValue()).toBe(pending);
      expect(fixture.mutations).toEqual([]);
      await load({ document: emptyDocument() });
      const older = baseDocument().config,
        newer = importedConfig();
      await drop([{ name: "delayed-older.json", text: JSON.stringify(older) }]);
      await expect
        .poll(() => page.evaluate(() => window.__pendingFileReads.length))
        .toBe(1);
      await drop([{ name: "newer.json", text: JSON.stringify(newer) }]);
      await saved(newer);
      await page.evaluate(() => window.__pendingFileReads.shift().resolve());
      await page.waitForTimeout(250);
      expect(fixture.document.config).toEqual(newer);
      await expect(replacement()).toHaveCount(0);
      await load({ document: emptyDocument() });
      for (const [files, reason] of [
        [
          [
            { name: "a.json", text: "{}" },
            { name: "b.json", text: "{}" },
          ],
          /one|single/i,
        ],
        [[{ name: "large.json", size: 1048577 }], /1 MiB|large|size/i],
        [
          [{ name: "unsupported.txt", text: JSON.stringify(importedConfig()) }],
          /extension|format|json|yaml|toml/i,
        ],
      ]) {
        await drop(files);
        await toast(reason);
        await expect(replacement()).toHaveCount(0);
      }
      await page.waitForTimeout(2150);
      expect(fixture.mutations).toEqual([]);
      expect(fixture.document.config).toEqual(emptyDocument().config);
    },
  );

  await check(
    "read-only and archived code stays selectable while file drops cannot edit it",
    async () => {
      for (const options of [{ role: "viewer" }, { archived: true }]) {
        await load(options);
        await openCode();
        await expect(codeInput()).toHaveAttribute("aria-readonly", "true");
        await expect(codeInput()).toHaveAttribute("contenteditable", "false");
        const before = await codeValue();
        await codeInput().focus();
        await page.keyboard.insertText("read-only edit must not apply");
        expect(await codeValue()).toBe(before);
        await button("Copy code").click();
        expect(await page.evaluate(() => window.__copiedCode.at(-1))).toBe(
          await codeValue(),
        );
        await drop([
          { name: "blocked.json", text: JSON.stringify(importedConfig()) },
        ]);
        await expect(replacement()).toHaveCount(0);
        expect(fixture.mutations).toEqual([]);
        expect(JSON.parse(await codeValue())).toEqual(baseDocument().config);
      }
    },
  );

  await check(
    "mobile light/dark code and replacement review fit the viewport with keyboard-accessible controls",
    async () => {
      for (const theme of ["light", "dark"]) {
        await load({ width: 375, height: 900, theme });
        await openCode();
        await noOverflow(`375px ${theme} code`);
        await axe(`375px ${theme} code`);
        await page.screenshot({
          path: resolve(output, `editor-code-mobile-${theme}.png`),
          animations: "disabled",
        });
        await codeInput().focus();
        await page.keyboard.press("Tab");
        await expect(codeInput()).not.toBeFocused();
        await drop([
          {
            name: "mobile.json",
            text: JSON.stringify(importedConfig(), null, 2),
          },
        ]);
        await expect(replacement()).toBeVisible();
        await noOverflow(`375px ${theme} replacement`);
        await axe(`375px ${theme} replacement`);
        await page.screenshot({
          path: resolve(output, `editor-import-mobile-${theme}.png`),
          animations: "disabled",
        });
        await replacement()
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        expect(fixture.mutations).toEqual([]);
      }
    },
  );
  expect(results).toHaveLength(8);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const file of [
    "src/Editor.tsx",
    "src/ConfigurationCodeEditor.tsx",
    "src/configuration-code-editor.css",
    "src/ConfigurationImportDialog.tsx",
    "src/configuration-import.css",
    "src/configurationSource.ts",
    "src/configurationFormats.ts",
    "src/configurationNumbers.ts",
    "src/editor.css",
    "src/editor-code.css",
    "src/editor-canvas.css",
    "package.json",
    "package-lock.json",
  ]) {
    const bytes = await readFile(resolve(dashboard, file)).catch(() => null);
    if (bytes)
      source_sha256[`dashboard/${file}`] = createHash("sha256")
        .update(bytes)
        .digest("hex");
  }
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
          "Actual App/editor with isolated synthetic API and in-memory draft CAS. File drops, source editing and accessibility only; no preview, real server validation, publication, deployment or native activation.",
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
