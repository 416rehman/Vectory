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
const focus = process.env.VECTORY_PIPELINE_CODE_CHECK_FOCUS || "";
if (focus && !["before", "after"].includes(focus))
  throw new Error("Unknown code-check focus");
const output = resolve(
  repository,
  process.env.VECTORY_PIPELINE_LOCAL_CHECK_OUTPUT ||
    ".local/pipeline-local-check",
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
      // The publish review shows where versions are assigned.
      if (path === "/devices") return reply([]);
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
const button = (name) => page.getByRole("button", { name, exact: true });
const checkButton = () => button("Check pipeline");
const tip = () => page.getByRole("dialog", { name: "Pipeline check results" });
const sink = () => page.locator('.react-flow__node[data-id="discard_copy"]');
const size = () => page.getByLabel("Max Size", { exact: true });
const code = () =>
  page.getByRole("textbox", { name: "Vector configuration code", exact: true });
function bufferDocument(valid = false) {
  const document = baseDocument();
  document.name = "Synthetic local check regression";
  document.config.sinks.discard_copy = {
    type: "blackhole",
    inputs: ["branch.accepted"],
    buffer: {
      type: "disk",
      when_full: "block",
      ...(valid ? { max_size: 268435488 } : {}),
    },
  };
  delete document.config.sinks.output;
  return document;
}
async function state(value) {
  await expect(checkButton()).toHaveAttribute("data-check-state", value);
}
async function showTip() {
  const count = fixture.validations.length;
  // Re-enter after a blocked check may replace feedback without moving the
  // pointer; this explicitly exercises viewing the cached result by hovering.
  await page.mouse.move(0, 0);
  await checkButton().hover();
  await expect(tip()).toBeVisible();
  expect(fixture.validations).toHaveLength(count);
}
async function hideTip() {
  await page.mouse.move(0, 0);
  await button("Graph").focus();
  await expect(tip()).toHaveCount(0);
}
async function runCheck(expected) {
  await checkButton().click();
  await state(expected);
  await showTip();
}
async function check(name, run, focused = false) {
  if (Boolean(focus) !== focused) return;
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
async function axe(label) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({ label, violations: result.violations });
  expect(result.violations).toEqual([]);
}

try {
  await check(
    "Blackhole disk-buffer node errors block both Check and publication; fixing the field recovers and pending input invalidates the pass",
    async () => {
      await load({ document: bufferDocument(), width: 899 });
      await expect(sink().locator(".pipeline-node-issue")).toBeVisible();
      await runCheck("failed");
      await expect(tip()).toContainText("discard_copy: Enter buffer.max_size.");
      await expect(tip()).not.toContainText("checks passed");
      expect(fixture.validations).toEqual([]);
      await axe("Local buffer error, desktop");
      await page.screenshot({
        path: resolve(output, "local-buffer-error-899-light.png"),
        animations: "disabled",
      });
      await hideTip();
      await button("Review & publish").click();
      const review = page.getByRole("dialog", {
        name: "Review & publish",
        exact: true,
      });
      await expect(review).toContainText(
        "discard_copy: Enter buffer.max_size.",
      );
      await expect(
        review.getByRole("button", { name: "Publish version", exact: true }),
      ).toBeDisabled();
      await review.getByRole("button", { name: "Back to draft" }).click();
      expect(fixture.saveAttempts).toEqual([]);
      await sink().click();
      await expect(size()).toBeVisible();
      await size().fill("268435488");
      await state("stale");
      await runCheck("partial");
      expect(fixture.validations).toHaveLength(1);
      expect(
        fixture.validations[0].config.sinks.discard_copy.buffer.max_size,
      ).toBe(268435488);
      await expect(tip()).toContainText("Device validation pending");
      await hideTip();
      await size().fill("-");
      await state("stale");
      await runCheck("failed");
      await expect(tip()).toContainText(
        "Resolve or apply pending field changes",
      );
      expect(fixture.validations).toHaveLength(1);
      await expect(size()).toHaveValue("-");
    },
  );

  await check(
    "Code checks use the exact candidate instead of the last valid graph and recover only after the missing buffer size is repaired",
    async () => {
      await load({ document: bufferDocument(true) });
      await runCheck("partial");
      await hideTip();
      await button("Code").click();
      await page.getByLabel("Format", { exact: true }).selectOption("json");
      await code().fill(JSON.stringify(bufferDocument().config));
      await state("stale");
      await runCheck("failed");
      await expect(tip()).toContainText("discard_copy: Enter buffer.max_size.");
      expect(fixture.validations).toHaveLength(1);
      await page.mouse.move(0, 0);
      await code().fill(JSON.stringify(bufferDocument(true).config));
      await runCheck("partial");
      expect(fixture.validations).toHaveLength(2);
      expect(fixture.validations.at(-1).config).toEqual(
        bufferDocument(true).config,
      );
      await page.mouse.move(0, 0);
      await code().fill('{"unfinished":');
      await state("stale");
      await runCheck("failed");
      expect(fixture.validations).toHaveLength(2);
      await expect(tip()).toContainText("Pipeline needs attention");
      await expect(tip().locator("li")).not.toHaveCount(0);
    },
  );

  await check(
    "Graph topology errors and validator failures remain actionable failures, including mobile dark display",
    async () => {
      const document = bufferDocument(true);
      document.config.sinks.discard_copy.inputs = ["missing_source"];
      await load({ document, width: 375 });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
      });
      await runCheck("failed");
      await expect(tip()).toContainText("missing_source");
      expect(fixture.validations).toEqual([]);
      const box = await tip().boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      measurements.push({ label: "Mobile local-error tip", box });
      await axe("Local topology error, mobile dark");
      await page.screenshot({
        path: resolve(output, "local-error-375-dark.png"),
        animations: "disabled",
      });
      await load({ document: bufferDocument(true) });
      fixture.validationError = true;
      await runCheck("failed");
      await expect(tip()).toContainText("Synthetic validator unavailable");
      expect(fixture.validations).toHaveLength(1);
      fixture.validationError = false;
      await runCheck("partial");
      expect(fixture.validations).toHaveLength(2);
    },
  );

  await check(
    "A held successful server response cannot overwrite a newer invalid or unapplied field generation",
    async () => {
      for (const value of ["", "-"]) {
        await load({ document: bufferDocument(true) });
        await sink().click();
        await expect(size()).toHaveValue("268435488");
        fixture.holdValidation = true;
        await checkButton().click();
        await state("checking");
        await expect.poll(() => fixture.pendingValidations.length).toBe(1);
        // Models a queued native input callback. Normal pointer edits are inert
        // while validation runs; generation protection must still reject this race.
        await size().evaluate((input, value) => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          ).set.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }, value);
        await expect(size()).toHaveValue(value);
        await state("stale");
        fixture.pendingValidations.shift()();
        await expect(checkButton()).toBeEnabled();
        await state("stale");
        await showTip();
        await expect(tip()).not.toContainText("checks passed");
        fixture.holdValidation = false;
        await runCheck("failed");
        expect(fixture.validations).toHaveLength(1);
        await expect(size()).toHaveValue(value);
      }
    },
  );
  await check(
    focus === "before"
      ? "BEFORE: checking unapplied invalid Code silently persists a failed candidate"
      : "checking unapplied invalid Code leaves the saved draft untouched until Apply",
    async () => {
      await load({ document: bufferDocument(true) });
      const original = structuredClone(fixture.document.config);
      await button("Code").click();
      await page.getByLabel("Format", { exact: true }).selectOption("json");
      await code().fill(JSON.stringify(bufferDocument().config));
      await expect(page.locator(".editor-code-footer")).toContainText(
        "Code changes have not been applied to the draft",
      );
      await runCheck("failed");
      await expect(tip()).toContainText("discard_copy: Enter buffer.max_size.");
      if (focus === "after")
        await expect(tip()).toContainText(
          "This check reviewed unapplied Code edits. Apply code changes to update the draft.",
        );
      expect(fixture.validations).toHaveLength(0);
      if (focus === "before") {
        await expect.poll(() => fixture.saveAttempts.length).toBe(1);
        expect(
          fixture.document.config.sinks.discard_copy.buffer.max_size,
        ).toBeUndefined();
        expect(fixture.document.revision).toBe(2);
      } else {
        await page.waitForTimeout(2700);
        expect(fixture.saveAttempts).toHaveLength(0);
        expect(fixture.document.config).toEqual(original);
        expect(fixture.document.revision).toBe(1);
        await expect(page.locator(".editor-code-footer")).toContainText(
          "Code changes have not been applied to the draft",
        );
        await hideTip();
        await button("Graph").click();
        await expect(button("Code")).toHaveAttribute("aria-pressed", "true");
        await expect(
          page.getByText(
            "Apply or discard your Code changes before switching to Graph.",
          ),
        ).toBeVisible();
        expect(fixture.saveAttempts).toHaveLength(0);
        await button("Apply code changes").click();
        await expect.poll(() => fixture.saveAttempts.length).toBe(1);
        expect(
          fixture.document.config.sinks.discard_copy.buffer.max_size,
        ).toBeUndefined();
        await button("Graph").click();
        await expect(button("Graph")).toHaveAttribute("aria-pressed", "true");
      }
    },
    true,
  );
  expect(results).toHaveLength(focus ? 1 : 4);
  expect(requests.filter(({ path }) => path.endsWith("/publish"))).toEqual([]);
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
    "catalog.ts",
    "pipelineSchema.ts",
    "configurationSource.ts",
  ])
    source_sha256[`dashboard/src/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, "src", file)))
      .digest("hex");
  source_sha256["dashboard/tests/pipeline-local-check-browser.mjs"] =
    createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
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
        scope: focus
          ? `Actual App/editor with isolated synthetic API. Focused ${focus} Code-check draft persistence observation. No preview, real server, native Vector, publication or device mutation.`
          : "Actual App/editor with isolated synthetic API. Missing blackhole disk buffer max_size and topology errors block Check before a permissive mocked validator is called. Exact Code candidates, recovery, pending fields, parse/network failures, held response generations and matching disabled publication UI are exercised. Synthetic draft saves only; no preview, real server, native Vector, publication or device mutation.",
        focus: focus || null,
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
