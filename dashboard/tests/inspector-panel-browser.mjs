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
  process.env.VECTORY_INSPECTOR_PANEL_OUTPUT || ".local/inspector-panel",
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
const inspector = () => page.locator(".editor-inspector");
const button = (name) => page.getByRole("button", { name, exact: true });
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const rootPicker = () =>
  inspector()
    .locator(".editor-inspector-properties-toolbar")
    .getByRole("button", { name: "Add field", exact: true });
async function select(id) {
  await node(id).click();
  await expect(inspector()).toBeVisible();
  await expect(
    inspector().getByRole("button", { name: "Done", exact: true }),
  ).toHaveCount(0);
  await expect(inspector().locator(":scope > footer")).toHaveCount(0);
}
async function decision(action, accepted) {
  const next = page.waitForEvent("dialog");
  const run = action();
  const dialog = await next;
  expect(dialog.message()).toMatch(/Discard unapplied field changes/);
  if (accepted) await dialog.accept();
  else await dialog.dismiss();
  await run;
}
async function check(name, run) {
  if (
    process.env.VECTORY_INSPECTOR_PANEL_FOCUS === "readonly" &&
    !name.startsWith("read-only")
  )
    return;
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
function groupedDocument() {
  const doc = baseDocument();
  doc.name = "Synthetic inspector layout";
  doc.config.sinks.output = {
    type: "http",
    inputs: ["branch.accepted"],
    uri: "https://collector.example.test/events",
    method: "post",
    encoding: { codec: "json" },
    auth: { strategy: "bearer", token: "${TOKEN}" },
    buffer: { type: "memory", max_events: 500, when_full: "block" },
    batch: { max_events: 1000, timeout_secs: 1 },
    request: { timeout_secs: 30 },
    tls: { verify_certificate: true },
    future_extension: { nullable: null, values: [false, 0, "retained"] },
  };
  return doc;
}
try {
  await check(
    "X and Escape replace Done and preserve or explicitly discard unfinished fields",
    async () => {
      await load({ width: 899 });
      const initial = structuredClone(fixture.document.config);
      await select("sample");
      await button("Close component settings").click();
      await expect(inspector()).toHaveCount(0);
      await expect(node("sample")).toBeFocused();
      await select("sample");
      const rate = inspector().getByLabel("One in every", { exact: true });
      await rate.fill("-");
      await decision(() => button("Close component settings").click(), false);
      await expect(rate).toHaveValue("-");
      await decision(() => page.keyboard.press("Escape"), false);
      await expect(rate).toHaveValue("-");
      expect(fixture.mutations).toEqual([]);
      expect(fixture.document.config).toEqual(initial);
      await decision(() => page.keyboard.press("Escape"), true);
      await expect(inspector()).toHaveCount(0);
      await expect(node("sample")).toBeFocused();
      await select("sample");
      await expect(rate).toHaveValue("10");
      expect(fixture.mutations).toEqual([]);
    },
  );
  await check(
    "Escape dismisses field help actions and Add field before the inspector without writes",
    async () => {
      await load({ width: 899 });
      await select("sample");
      await inspector()
        .getByRole("button", { name: "Help for One in every", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", {
          name: "Help for One in every",
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("dialog", {
          name: "Help for One in every",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(inspector()).toBeVisible();
      await inspector()
        .getByRole("button", { name: "Actions for One in every", exact: true })
        .click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(inspector()).toBeVisible();
      await rootPicker().click();
      await expect(
        page.getByRole("dialog", { name: "Add a field", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("dialog", { name: "Add a field", exact: true }),
      ).toHaveCount(0);
      await expect(rootPicker()).toBeFocused();
      await expect(inspector()).toBeVisible();
      expect(fixture.mutations).toEqual([]);
    },
  );
  await check(
    "meaningful populated sections preserve pending edits until an explicit cross-section save",
    async () => {
      const doc = baseDocument();
      doc.config.transforms.sample = {
        type: "sample",
        inputs: ["seed"],
        rate: 10,
        key_field: "user_id",
        measure_cpu_usage: true,
      };
      await load({ document: doc, width: 899 });
      const initial = structuredClone(fixture.document.config);
      await select("sample");
      const headings = inspector().locator(".schema-property-section-heading");
      await expect(headings).toHaveText(["Sampling", "Settings"]);
      await expect(
        inspector().getByLabel("One in every", { exact: true }),
      ).toHaveCount(1);
      await expect(
        inspector().getByLabel("Key Field", { exact: true }),
      ).toHaveCount(1);
      await expect(
        inspector().getByLabel("Measure CPU Usage", { exact: true }),
      ).toHaveCount(1);
      await expect(
        inspector().getByRole("button", { name: "Add field", exact: true }),
      ).toHaveCount(1);
      await page.screenshot({
        path: resolve(output, "inspector-panel-sample-899-light.png"),
        animations: "disabled",
      });
      const rate = inspector().getByLabel("One in every", { exact: true });
      await rate.fill("-");
      const cpu = inspector().getByLabel("Measure CPU Usage", { exact: true });
      await cpu.selectOption({ label: "Disabled" });
      await expect(rate).toHaveValue("-");
      await expect(page.locator(".pipeline-save-status")).toHaveAttribute(
        "data-save-state",
        "unapplied",
      );
      await button("Save options").click();
      const save = page.getByRole("menuitem", {
        name: "Save draft",
        exact: true,
      });
      await expect(save).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(2300);
      expect(fixture.saveAttempts).toEqual([]);
      expect(fixture.document.config).toEqual(initial);
      await expect(rate).toHaveValue("-");
      await expect(page.locator(".pipeline-save-status")).toHaveAttribute(
        "data-save-state",
        "unapplied",
      );
      await rate.fill("11");
      await expect(page.locator(".pipeline-save-status")).toHaveAttribute(
        "data-save-state",
        "unsaved",
      );
      expect(fixture.saveAttempts).toEqual([]);
      await button("Save options").click();
      await expect(save).toBeEnabled();
      await save.click();
      await expect
        .poll(() => fixture.document.config.transforms.sample.rate)
        .toBe(11);
      expect(fixture.document.config.transforms.sample).toEqual({
        ...initial.transforms.sample,
        rate: 11,
        measure_cpu_usage: false,
      });
      expect(
        Object.keys(fixture.document.config.transforms.sample).sort(),
      ).toEqual(Object.keys(initial.transforms.sample).sort());
      expect(fixture.saveAttempts).toHaveLength(1);
    },
  );
  await check(
    "fixed Add field and scrolling sections remain contained at899/375 light and dark",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await load({ document: groupedDocument(), width, height: 1000 });
          await page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            theme,
          );
          const initial = structuredClone(fixture.document.config);
          await select("output");
          const urlGeometry = await inspector()
            .getByLabel("Destination URL", { exact: true })
            .evaluate((input) => {
              const rect = input.getBoundingClientRect(),
                style = getComputedStyle(input),
                icon = input.parentElement
                  .querySelector("svg")
                  .getBoundingClientRect();
              return {
                paddingLeft: parseFloat(style.paddingLeft),
                textStart:
                  rect.left +
                  parseFloat(style.borderLeftWidth) +
                  parseFloat(style.paddingLeft),
                iconRight: icon.right,
              };
            });
          expect(urlGeometry.paddingLeft).toBeGreaterThanOrEqual(34);
          expect(urlGeometry.textStart).toBeGreaterThan(
            urlGeometry.iconRight + 3,
          );
          measurements.push({
            label: `URL icon clearance ${width} ${theme}`,
            ...urlGeometry,
          });
          const headings = await inspector()
            .locator(".schema-property-section-heading")
            .allTextContents();
          expect(headings).not.toContain("Encoding");
          expect(headings).toContain("Delivery");
          expect(new Set(headings).size).toBe(headings.length);
          await expect(
            inspector()
              .getByRole("region", { name: "Encoding" })
              .getByText("Encoding", { exact: true }),
          ).toHaveCount(1);
          for (const group of await inspector()
            .locator(".schema-property-section")
            .all())
            expect(
              await group
                .locator(".schema-property-section-content")
                .innerText(),
            ).not.toBe("");
          const body = inspector().locator(".editor-inspector-body");
          const before = await rootPicker().boundingBox();
          const scroll = await body.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
            return {
              height: element.clientHeight,
              content: element.scrollHeight,
              top: element.scrollTop,
            };
          });
          expect(scroll.top).toBeGreaterThan(0);
          const after = await rootPicker().boundingBox();
          expect(Math.abs(before.y - after.y)).toBeLessThan(1);
          expect(after.x).toBeGreaterThanOrEqual(0);
          expect(after.x + after.width).toBeLessThanOrEqual(width);
          const close = await button("Close component settings").boundingBox();
          expect(close.y).toBeGreaterThanOrEqual(0);
          expect(close.x + close.width).toBeLessThanOrEqual(width);
          measurements.push({
            label: `fixed inspector ${width} ${theme}`,
            before,
            after,
            scroll,
            close,
            headings,
          });
          await rootPicker().click();
          await expect(
            page.getByRole("dialog", { name: "Add a field", exact: true }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(inspector()).toBeVisible();
          await body.evaluate((element) => (element.scrollTop = 0));
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await axe(`grouped inspector ${width} ${theme}`);
          await page.screenshot({
            path: resolve(output, `inspector-panel-${width}-${theme}.png`),
            animations: "disabled",
          });
          expect(fixture.mutations).toEqual([]);
          expect(fixture.document.config).toEqual(initial);
        }
    },
  );
  await check(
    "read-only inspector has no Done or Add field and X/Escape close without mutation",
    async () => {
      for (const options of [{ role: "viewer" }, { archived: true }]) {
        await load({ ...options, document: groupedDocument(), width: 899 });
        await select("output");
        await expect(rootPicker()).toHaveCount(0);
        await expect(
          inspector().getByLabel("Token reference", { exact: true }),
        ).toHaveAttribute("readonly", "");
        await page.keyboard.press("Escape");
        await expect(inspector()).toHaveCount(0);
        await expect(node("output")).toBeFocused();
        await select("output");
        await button("Close component settings").click();
        await expect(inspector()).toHaveCount(0);
        expect(fixture.mutations).toEqual([]);
      }
    },
  );
  expect(results).toHaveLength(
    process.env.VECTORY_INSPECTOR_PANEL_FOCUS === "readonly" ? 1 : 5,
  );
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const file of [
    "Editor.tsx",
    "PipelineSettings.tsx",
    "PipelineSchemaFields.tsx",
    "SchemaValueEditor.tsx",
    "SchemaFieldChrome.tsx",
    "schema-controls.css",
    "inspector.css",
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
          "Actual App/editor with isolated synthetic API. Inspector close/pending guards, popup Escape precedence, meaningful configured-field groups, fixed Add field and scrolling, readonly and 899/375 light/dark accessibility. Unfinished cross-section edits block Save draft, and one explicit save persists the resolved values without background writes. All writes are disposable fixture state; no preview/server/device requests.",
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
