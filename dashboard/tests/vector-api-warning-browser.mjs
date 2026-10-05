// Synthetic browser proof for Vector API warnings and deploy acknowledgement.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const virtual = "\0virtual:vector-api-warning";
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const server = await createServer({
  root: dashboard,
  cacheDir: resolve(dashboard, "../.local/vector-api-warning-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, hmr: false, proxy: {} },
  plugins: [
    {
      name: "isolated-vector-api-warning",
      resolveId(id) {
        if (id === "virtual:vector-api-warning") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import PipelineGlobals from '/src/PipelineGlobals.tsx';
          import PublishReview from '/src/PublishReview.tsx';
          import TargetDialog from '/src/TargetDialog.tsx';
          import { setCSRF } from '/src/api.ts';
          import '/src/styles.css';
          setCSRF('synthetic');
          const root = createRoot(document.getElementById('root'));
          const base = {
            sources: { seed: { type: 'demo_logs', format: 'json' } },
            sinks: { out: { type: 'blackhole', inputs: ['seed'] } },
          };
          const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
          const device = {
            id: id(1), name: 'Synthetic full-mode device', os: 'linux',
            configuration_mode: 'full', check_in_seconds: 60,
            status: 'verified', sync_paused: false,
          };
          window.mountVectorApiFixture = (kind, api) => {
            const config = api === null ? base : { ...base, api };
            if (kind === 'editor') {
              root.render(React.createElement(PipelineGlobals, {
                key: Math.random(), config, variables: [], editable: true,
                onChange: () => {}, onVariablesChange: () => {}, onClose: () => {},
              }));
            } else if (kind === 'publish') {
              root.render(React.createElement(PublishReview, {
                key: Math.random(), config, variables: [], published: null,
                reach: null, status: 'passed', statusLabel: 'Checked',
                verdict: 'Synthetic validation passed.', problems: [],
                rejection: null, tests: { state: 'none' },
                onRunTests: () => {}, onGoToProblem: () => {},
              }));
            } else {
              const version = {
                id: id(2), configuration_id: id(3), number: 1,
                config, graph: { nodes: [], edges: [] },
                sha256: '0'.repeat(64), artifact: JSON.stringify(config),
                size: JSON.stringify(config).length,
                created_at: '2026-01-01T00:00:00Z', message: '', validation: {},
              };
              root.render(React.createElement(TargetDialog, {
                key: Math.random(), open: true, userId: id(90), version,
                initialDeviceIds: [device.id], initialDevices: [device],
                onClose: () => {}, onDone: () => {},
              }));
            }
          };
          window.vectorApiFixtureReady = true;
        `;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__vector-api-warning") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import "virtual:vector-api-warning";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});

let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const deviceId = "00000000-0000-4000-8000-000000000001";
  let previews = 0;
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(7);
    if (request.method() === "GET" && path === "/groups")
      return route.fulfill({ json: [] });
    if (request.method() === "POST" && path === "/deployments/preview") {
      previews++;
      return route.fulfill({
        json: {
          devices: [
            {
              id: deviceId,
              name: "Synthetic full-mode device",
              os: "linux",
              configuration_mode: "full",
              check_in_seconds: 60,
              status: "verified",
              sync_paused: false,
            },
          ],
          warnings: [],
          conflicts: [],
          blockers: [],
          outcomes: [
            {
              device_id: deviceId,
              resource: "configuration",
              outcome: "requested",
            },
          ],
          create_idempotency: true,
          request_correlation: true,
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: `No synthetic reply for ${path}` } },
    });
  });
  await page.goto(`${origin}/__vector-api-warning`);
  await page.waitForFunction(() => window.vectorApiFixtureReady);

  async function editor(api) {
    await page.evaluate(
      (value) => window.mountVectorApiFixture("editor", value),
      api,
    );
    return page.getByRole("dialog", { name: "Pipeline settings" });
  }
  let dialog = await editor({ enabled: true });
  let field = dialog.locator('[data-field-path="api.enabled"]');
  await expect(field).toHaveAttribute("data-field-problem", "warning");
  await expect(field).toContainText("127.0.0.1:8686");
  await expect(field).toContainText("Only clients on each device");

  dialog = await editor({ enabled: true, address: "0.0.0.0:8686" });
  field = dialog.locator('[data-field-path="api.enabled"]');
  await expect(field).toContainText("listens on every interface");
  dialog = await editor({ enabled: true, address: "192.0.2.10:8686" });
  await expect(dialog.locator('[data-field-path="api.enabled"]')).toContainText(
    "not a verified loopback address",
  );
  dialog = await editor({ enabled: false, address: "0.0.0.0:8686" });
  await expect(
    dialog.locator('[data-field-path="api.enabled"]'),
  ).not.toHaveAttribute("data-field-problem", "warning");
  await expect(dialog).not.toContainText("stream live events");
  dialog = await editor(null);
  await expect(dialog).not.toContainText("stream live events");

  await page.evaluate(() =>
    window.mountVectorApiFixture("publish", {
      enabled: true,
      address: "[::]:8686",
    }),
  );
  await expect(
    page.getByText("Vector API exposure", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".publish-review-api")).toContainText(
    "listens on every interface",
  );
  await page.evaluate(() =>
    window.mountVectorApiFixture("publish", {
      enabled: false,
      address: "[::]:8686",
    }),
  );
  await expect(page.locator(".publish-review-api")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  dialog = await editor({ enabled: true, address: "0.0.0.0:8686" });
  await expect(dialog.locator('[data-field-path="api.enabled"]')).toContainText(
    "listens on every interface",
  );
  await dialog.screenshot({
    path: resolve(dashboard, "../.local/vector-api-warning-mobile.png"),
  });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.evaluate(() =>
    window.mountVectorApiFixture("deploy", { enabled: true }),
  );
  await page.getByRole("button", { name: "Review deployment" }).click();
  const acknowledgement = page.getByRole("checkbox", {
    name: /Confirm Vector API exposure/,
  });
  await expect(acknowledgement).toBeVisible();
  await expect(acknowledgement).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Deploy to devices" }),
  ).toBeDisabled();
  await acknowledgement.check();
  await expect(
    page.getByRole("button", { name: "Deploy to devices" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Back to selection" }).click();
  await page.getByRole("button", { name: "Review deployment" }).click();
  await expect(acknowledgement).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Deploy to devices" }),
  ).toBeDisabled();
  expect(previews).toBe(2);

  await page.evaluate(() =>
    window.mountVectorApiFixture("deploy", { enabled: false }),
  );
  await page.getByRole("button", { name: "Review deployment" }).click();
  await expect(
    page.getByRole("checkbox", { name: /Confirm Vector API exposure/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Deploy to devices" }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
  console.log("Vector API editor and deploy review browser proof passed.");
} finally {
  await browser?.close();
  await server.close();
}
