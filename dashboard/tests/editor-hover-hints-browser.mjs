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
  process.env.VECTORY_EDITOR_HINT_OUTPUT || ".local/editor-hover-hints",
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
  touch = false,
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
    hasTouch: touch,
    isMobile: touch,
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
const control = () =>
  page.getByRole("button", { name: "Check pipeline", exact: true });
const resultsTip = () => page.locator(".editor-checks-popover");
const fieldHelp = () =>
  page.getByRole("button", { name: "Help for One in every", exact: true });
const fieldTip = () =>
  page.getByRole("dialog", { name: "Help for One in every", exact: true });
const button = (name) => page.getByRole("button", { name, exact: true });
async function sample() {
  await page.locator('.react-flow__node[data-id="sample"]').click();
  await expect(fieldHelp()).toBeVisible();
}
async function leave() {
  await page.mouse.move(5, 5);
}
async function pass() {
  await control().click();
  await expect(control()).toHaveAttribute("data-check-state", "partial");
}
async function check(name, run) {
  if (
    process.env.VECTORY_EDITOR_HINT_FOCUS === "keyboard" &&
    !name.startsWith("check keyboard")
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
try {
  await check(
    "check result hover bridge works and pointer click never pins cached results",
    async () => {
      await load({ width: 899 });
      await control().hover();
      await expect(resultsTip()).toBeVisible();
      expect(fixture.validations).toEqual([]);
      await pass();
      await expect(resultsTip()).toContainText("Device validation pending");
      await expect(
        page.getByRole("button", {
          name: "Close pipeline checks",
          exact: true,
        }),
      ).toHaveCount(0);
      await resultsTip().hover();
      await page.waitForTimeout(250);
      await expect(resultsTip()).toBeVisible();
      await leave();
      await expect(resultsTip()).toHaveCount(0);
      const count = fixture.validations.length;
      await control().hover();
      await expect(resultsTip()).toContainText("Device validation pending");
      expect(fixture.validations).toHaveLength(count);
      fixture.validationValid = false;
      await control().click();
      await expect(control()).toHaveAttribute("data-check-state", "failed");
      await expect(resultsTip()).toContainText(
        "Synthetic configuration rejected",
      );
      await leave();
      await expect(resultsTip()).toHaveCount(0);
      expect(fixture.mutations).toEqual([]);
    },
  );
  await check(
    "late validation completion cannot open a tip after pointer leave and last result reopens without a request",
    async () => {
      await load({ width: 899 });
      fixture.holdValidation = true;
      await control().click();
      await expect(control()).toHaveAttribute("data-check-state", "checking");
      await expect.poll(() => fixture.pendingValidations.length).toBe(1);
      await leave();
      await expect(resultsTip()).toHaveCount(0);
      fixture.pendingValidations.shift()();
      await expect(control()).toHaveAttribute("data-check-state", "partial");
      await page.waitForTimeout(300);
      await expect(resultsTip()).toHaveCount(0);
      await control().hover();
      await expect(resultsTip()).toContainText("Device validation pending");
      expect(fixture.validations).toHaveLength(1);
      await leave();
      await expect(resultsTip()).toHaveCount(0);
      fixture.holdValidation = false;
      fixture.validationError = true;
      await control().click();
      await expect(control()).toHaveAttribute("data-check-state", "failed");
      await leave();
      await expect(resultsTip()).toHaveCount(0);
      await control().hover();
      await expect(resultsTip()).toContainText(/unavailable|failed|could not/i);
      expect(fixture.validations).toHaveLength(2);
      expect(fixture.mutations).toEqual([]);
    },
  );
  await check(
    "shared field help closes after pointer click and leave while keyboard focus and Escape remain usable",
    async () => {
      await load({ width: 899 });
      await sample();
      await fieldHelp().hover();
      await expect(fieldTip()).toBeVisible();
      await fieldTip().hover();
      await page.waitForTimeout(250);
      await expect(fieldTip()).toBeVisible();
      await fieldHelp().click();
      await expect(fieldTip()).toBeVisible();
      await leave();
      await expect(fieldTip()).toHaveCount(0);
      await fieldHelp().focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(fieldHelp()).toBeFocused();
      await expect(fieldTip()).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect(fieldTip()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(fieldTip()).toHaveCount(0);
      await expect(fieldHelp()).toBeFocused();
      await expect(page.locator(".editor-inspector")).toBeVisible();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(fieldTip()).toBeVisible();
      await page.keyboard.press("Escape");
      expect(fixture.mutations).toEqual([]);
      expect(fixture.validations).toEqual([]);
    },
  );
  await check(
    "check keyboard and touch activation dismiss without losing focus or requiring a manual close control",
    async () => {
      await load({ width: 899 });
      await control().focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(control()).toBeFocused();
      await expect(resultsTip()).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(control()).toHaveAttribute("data-check-state", "partial");
      measurements.push({
        label: "keyboard check completion focus",
        ...(await page.evaluate(() => ({
          active: document.activeElement?.outerHTML.slice(0, 600),
          inert: document.querySelector(".editor-draft-workspace")?.inert,
        }))),
      });
      await expect(control()).toBeFocused();
      await expect(resultsTip()).toContainText("Device validation pending");
      await page.keyboard.press("ArrowDown");
      await expect(resultsTip()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(resultsTip()).toHaveCount(0);
      await expect(control()).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(resultsTip()).toContainText("Device validation pending");
      expect(fixture.validations).toHaveLength(1);
      for (const cancellation of ["escape", "outside-focus"]) {
        fixture.holdValidation = true;
        await control().focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => fixture.pendingValidations.length).toBe(1);
        if (cancellation === "escape") await page.keyboard.press("Escape");
        else await page.locator(".sidebar-search").focus();
        fixture.pendingValidations.shift()();
        await expect(control()).toHaveAttribute("data-check-state", "partial");
        await expect(resultsTip()).toHaveCount(0);
        await expect(control()).not.toBeFocused();
        if (cancellation === "outside-focus")
          await expect(page.locator(".sidebar-search")).toBeFocused();
      }
      await load({ width: 375, touch: true });
      await control().tap();
      await expect(control()).toHaveAttribute("data-check-state", "partial");
      await expect(resultsTip()).toContainText("Device validation pending");
      await page.locator(".editor-header").tap({ position: { x: 3, y: 3 } });
      await expect(resultsTip()).toHaveCount(0);
      await sample();
      await fieldHelp().tap();
      await expect(fieldTip()).toBeVisible();
      await page
        .locator(".editor-inspector > header")
        .tap({ position: { x: 3, y: 3 } });
      await expect(fieldTip()).toHaveCount(0);
      await expect(page.locator(".editor-inspector")).toBeVisible();
      expect(fixture.mutations).toEqual([]);
    },
  );
  await check(
    "toolbar actions stay adjacent and anchored tips fit899/375 light and dark without accessibility failures",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await load({ width, height: 1000 });
          await page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            theme,
          );
          const checkBox = await control().boundingBox(),
            settings = await button("Pipeline settings").boundingBox(),
            actions = await page
              .locator(".editor-tools-menu > summary")
              .boundingBox();
          const gapCheckSettings = settings.x - (checkBox.x + checkBox.width),
            gapSettingsActions = actions.x - (settings.x + settings.width);
          expect(Math.abs(settings.y - checkBox.y)).toBeLessThan(6);
          expect(gapCheckSettings).toBeGreaterThanOrEqual(-1);
          expect(gapCheckSettings).toBeLessThanOrEqual(16);
          if (Math.abs(actions.y - settings.y) < 10) {
            expect(gapSettingsActions).toBeGreaterThanOrEqual(-1);
            expect(gapSettingsActions).toBeLessThanOrEqual(24);
          } else {
            // At phone width the two intact action groups may wrap, with a
            // compact row gap instead of separating controls across the bar.
            expect(width).toBeLessThan(600);
            expect(actions.y).toBeGreaterThan(settings.y);
            expect(
              actions.y - (settings.y + settings.height),
            ).toBeLessThanOrEqual(14);
          }
          await pass();
          await expect(resultsTip()).toBeVisible();
          const tip = await resultsTip().boundingBox();
          expect(tip.x).toBeGreaterThanOrEqual(0);
          expect(tip.x + tip.width).toBeLessThanOrEqual(width);
          expect(tip.y).toBeGreaterThanOrEqual(0);
          expect(tip.y + tip.height).toBeLessThanOrEqual(1000);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          measurements.push({
            label: `toolbar and tip ${width} ${theme}`,
            checkBox,
            settings,
            actions,
            tip,
            gapCheckSettings,
            gapSettingsActions,
          });
          await axe(`check tip ${width} ${theme}`);
          await page.screenshot({
            path: resolve(output, `check-tip-${width}-${theme}.png`),
            animations: "disabled",
          });
          await leave();
          await expect(resultsTip()).toHaveCount(0);
          await sample();
          await fieldHelp().hover();
          await expect(fieldTip()).toBeVisible();
          const help = await fieldTip().boundingBox();
          expect(help.x).toBeGreaterThanOrEqual(0);
          expect(help.x + help.width).toBeLessThanOrEqual(width);
          await axe(`field help ${width} ${theme}`);
          await page.screenshot({
            path: resolve(output, `field-tip-${width}-${theme}.png`),
            animations: "disabled",
          });
          await leave();
          await expect(fieldTip()).toHaveCount(0);
          expect(fixture.mutations).toEqual([]);
        }
    },
  );
  expect(results).toHaveLength(
    process.env.VECTORY_EDITOR_HINT_FOCUS === "keyboard" ? 1 : 5,
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
    "PipelineCheckButton.tsx",
    "editor-canvas.css",
    "SchemaFieldChrome.tsx",
    "schema-controls.css",
    "useHoverDisclosure.ts",
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
          "Actual App/editor with isolated synthetic API. Hover bridging/unpinning, async validation completion, cached results without requests, keyboard/focus/Escape and touch dismissal, toolbar adjacency and899/375 light/dark accessibility. Validation responses are synthetic; no preview/server/device/configuration writes.",
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
