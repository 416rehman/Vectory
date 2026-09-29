// Actual App/editor with an isolated synthetic API. Never contacts preview or devices.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(dashboard, "../.local/pipeline-check-schema");
await mkdir(output, { recursive: true });
const virtual = "\0virtual:pipeline-check-schema-fixture";
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
      name: "pipeline-check-schema-fixture",
      resolveId(id) {
        if (id === "virtual:pipeline-check-schema-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__pipeline-check-schema-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic pipeline check regression</title></head><body><div id="root"></div><script type="module">import "virtual:pipeline-check-schema-fixture";</script></body></html>',
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
  unexpected = [],
  pageErrors = [];
let page, fixture;

function pipeline(valid) {
  return {
    sources: { seed: { type: "demo_logs", format: "json" } },
    sinks: {
      discard_copy: {
        type: "blackhole",
        inputs: ["seed"],
        buffer: {
          type: "disk",
          ...(valid ? { max_size: 268435488 } : {}),
        },
      },
    },
  };
}

async function load(config, expectedNodes = 2) {
  if (page) await page.context().close();
  fixture = {
    document: {
      id: pipelineId,
      name: "Synthetic check consistency",
      description: "Isolated interaction fixture, never deployed.",
      revision: 1,
      archived: false,
      archived_at: null,
      created_at: created,
      updated_at: created,
      config,
      graph: { nodes: [], edges: [] },
    },
    validations: [],
    mutations: [],
  };
  const current = fixture;
  const context = await browser.newContext({
    viewport: { width: 899, height: 900 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(() => {
    localStorage.setItem("vectory-sidebar-collapsed", "true");
    localStorage.setItem("vectory-theme", "light");
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = request.method();
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: "11111111-1111-4111-8111-111111111111",
            email: "check@example.test",
            name: "Synthetic operator",
            role: "admin",
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic-check-csrf",
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
          page_size: 1,
          kind: "versions",
        });
      if (path === "/mfa") return reply({ enabled: false });
    }
    if (request.headers()["x-csrf-token"] !== "synthetic-check-csrf") {
      unexpected.push(`Missing CSRF ${method} ${path}`);
      return reply(
        { error: { code: "FORBIDDEN", message: "Missing CSRF" } },
        403,
      );
    }
    if (
      method === "POST" &&
      path === `/configurations/${pipelineId}/validate`
    ) {
      current.validations.push(request.postDataJSON());
      // Deliberately permissive, like the server's structural-only fallback.
      return reply({
        valid: true,
        errors: [],
        warnings: [],
        vector_validated: false,
        deferred: true,
      });
    }
    if (method === "PUT" && path === `/configurations/${pipelineId}/draft`) {
      current.mutations.push(request.postDataJSON());
      return reply({
        ...current.document,
        revision: current.document.revision + 1,
      });
    }
    unexpected.push(`${method} ${path}`);
    return reply(
      {
        error: {
          code: "UNEXPECTED_REQUEST",
          message: "Fixture refused request",
        },
      },
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(
    `${origin}/__pipeline-check-schema-fixture#/configurations/${pipelineId}`,
  );
  await expect(page.locator(".react-flow__node")).toHaveCount(expectedNodes);
  return current;
}

const button = (name) => page.getByRole("button", { name, exact: true });
const checkButton = () => button("Check pipeline");
const code = () =>
  page.getByRole("textbox", { name: "Vector configuration code", exact: true });
const sink = () => page.locator('.react-flow__node[data-id="discard_copy"]');
async function codeView() {
  await button("Code").click();
  await page.getByLabel("Format", { exact: true }).selectOption("json");
}
async function record(name, run) {
  const start = Date.now();
  try {
    await run();
    results.push({ name, passed: true, milliseconds: Date.now() - start });
    console.log("PASS", name);
  } catch (error) {
    results.push({
      name,
      passed: false,
      milliseconds: Date.now() - start,
      error: String(error),
    });
    console.error("FAIL", name, String(error));
  }
}

try {
  await record(
    "Code scalar/schema error cannot receive a structural green pass",
    async () => {
      const current = await load(pipeline(true));
      await codeView();
      const candidate = pipeline(true);
      candidate.sinks.discard_copy.buffer.max_size = "bad";
      await code().fill(JSON.stringify(candidate));
      await expect(page.locator(".editor-code-diagnostics")).toContainText(
        "max_size",
      );
      await checkButton().click();
      await expect(checkButton()).toHaveAttribute("data-check-state", "failed");
      expect(current.validations).toEqual([]);
      expect(current.mutations).toEqual([]);
    },
  );

  await record(
    "Discarding a checked Code repair invalidates the pass before returning to a red graph node",
    async () => {
      const current = await load(pipeline(false));
      await expect(sink().locator(".pipeline-node-issue")).toBeVisible();
      await codeView();
      await code().fill(JSON.stringify(pipeline(true)));
      await checkButton().click();
      await expect(checkButton()).toHaveAttribute("data-check-state", "partial");
      expect(current.validations).toHaveLength(1);
      expect(current.validations[0].config).toEqual(pipeline(true));
      expect(current.document.config).toEqual(pipeline(false));
      await button("Discard code changes").click();
      await button("Graph").click();
      await expect(sink().locator(".pipeline-node-issue")).toBeVisible();
      await page.screenshot({
        path: resolve(output, "discarded-code-check-state.png"),
        animations: "disabled",
      });
      await expect(checkButton()).toHaveAttribute("data-check-state", "stale");
      expect(current.validations).toHaveLength(1);
      expect(current.mutations).toEqual([]);
    },
  );

  await record(
    "Graph scalar/schema error marks the node and blocks Check and publication",
    async () => {
      const invalid = pipeline(true);
      invalid.sinks.discard_copy.buffer.max_size = "bad";
      const current = await load(invalid);
      await expect(sink().locator(".pipeline-node-issue")).toBeVisible();
      await expect(sink().locator(".pipeline-node-attention")).toHaveAttribute(
        "aria-label",
        /max_size/,
      );
      await checkButton().click();
      await expect(checkButton()).toHaveAttribute("data-check-state", "failed");
      expect(current.validations).toEqual([]);
      await button("Review & publish").click();
      const review = page.getByRole("dialog", {
        name: "Review & publish",
        exact: true,
      });
      await expect(review).toContainText("max_size");
      await expect(
        review.getByRole("button", { name: "Publish version", exact: true }),
      ).toBeDisabled();
      expect(current.validations).toEqual([]);
      expect(current.mutations).toEqual([]);
    },
  );

  await record(
    "Memory table scalar/schema error marks both graph roles, inspector and Check",
    async () => {
      const config = {
        sources: { seed: { type: "demo_logs", format: "json" } },
        enrichment_tables: {
          lookup: {
            type: "memory",
            inputs: ["seed"],
            source_config: {
              source_key: "cache_events",
              export_interval: "bad",
            },
          },
        },
        sinks: { output: { type: "blackhole", inputs: ["cache_events"] } },
      };
      const current = await load(config, 4);
      for (const id of ["lookup", "cache_events"]) {
        if (id === "cache_events") await button("Fit graph").click();
        const node = page.locator(`.react-flow__node[data-id="${id}"]`);
        await expect(node.locator(".pipeline-node-issue")).toBeVisible();
        await expect(node.locator(".pipeline-node-attention")).toHaveAttribute(
          "aria-label",
          /export_interval/,
        );
        await node.click();
        const inspector = page.locator(".editor-inspector");
        await expect(inspector.locator(".memory-table-settings")).toContainText(
          "shared by its input and export source",
        );
        const tableErrors = await inspector
          .locator(".pipeline-field-errors li")
          .allTextContents();
        expect(tableErrors.length).toBeGreaterThan(0);
        expect(new Set(tableErrors).size).toBe(tableErrors.length);
        expect(
          tableErrors.some((message) => message.includes("export_interval")),
        ).toBe(true);
      }
      await checkButton().click();
      await expect(checkButton()).toHaveAttribute("data-check-state", "failed");
      expect(current.validations).toEqual([]);
      expect(current.mutations).toEqual([]);
    },
  );
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
} finally {
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        scope:
          "Actual App/editor with isolated synthetic API and in-memory configuration. Code, graph and shared memory-table scalar/schema errors must not retain a passing Check. No real server, preview, draft, publication or device mutations.",
        passed: results.length === 4 && results.every((item) => item.passed),
        results,
        unexpected,
        pageErrors,
        validations: fixture?.validations.length || 0,
        mutations: fixture?.mutations.length || 0,
      },
      null,
      2,
    ) + "\n",
  );
  if (page) await page.context().close();
  await browser.close();
  await vite.close();
}
if (results.some((item) => !item.passed))
  throw new Error(
    `${results.filter((item) => !item.passed).length} pipeline check regression(s) failed`,
  );
console.log(`Evidence: ${resolve(output, "report.json")}`);
