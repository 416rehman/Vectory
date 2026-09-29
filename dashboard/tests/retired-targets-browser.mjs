// Actual App/Deployments/device identity navigation; isolated synthetic API only.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_RETIRED_TARGETS_OUTPUT || ".local/retired-targets-ui",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/Deployments.tsx",
  "dashboard/src/deployments.css",
  "dashboard/src/deploymentRouting.ts",
  "dashboard/src/api.ts",
  "dashboard/src/Fleet.tsx",
  "dashboard/src/DataTable.tsx",
  "dashboard/tests/retired-targets-browser.mjs",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(resolve(root, p)))
          .digest("hex"),
      ]),
    ),
  );
const loaded = await hashes();
const reservation = net.createServer();
await new Promise((done, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:retired-targets";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "retired-targets",
      resolveId(id) {
        if (id === "virtual:retired-targets") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__retired-targets") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic retired deployment target verification</title></head><body><div id="root"></div><script type="module">import "virtual:retired-targets";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = "http://127.0.0.1:" + port;
const browser = await chromium.launch();
const results = [],
  accessibility = [],
  screenshots = [];
const id = (n) => "11111111-2222-4333-8444-" + String(n).padStart(12, "0");
const user = (role = "viewer") => ({
  id: id(99),
  name: "Synthetic reviewer",
  email: "synthetic@example.test",
  role,
  enabled: true,
  revision: 1,
});
const deployment = (n = 100, changes = {}) => ({
  id: id(n),
  name: "Synthetic retired rollout",
  configuration_id: id(50),
  configuration_name: "Synthetic logs",
  version_id: id(51),
  version_number: 3,
  policy: null,
  priority: 100,
  target_mode: "persistent",
  status: "completed",
  scheduled_at: null,
  created_at: "2026-09-27T00:00:00Z",
  rollout: {
    kind: "all",
    canary_size: 1,
    batch_size: 1,
    observation_seconds: 0,
    failure_threshold: 0,
  },
  target_count: 1,
  verified_count: 0,
  state_counts: { removed: 1 },
  ...changes,
});
const target = (n = 1, changes = {}) => ({
  device_id: id(n),
  device_name: "Synthetic retired edge",
  state: "removed",
  generation: 7,
  error: null,
  original: true,
  ...changes,
});
const device = (n = 1, changes = {}) => ({
  id: id(n),
  name: "Synthetic retired edge",
  os: "windows",
  arch: "amd64",
  status: "revoked",
  apply_state: "verified_applied",
  desired_generation: 7,
  reported_generation: 7,
  desired_version_id: null,
  labels: {},
  last_seen: "2026-09-27T00:00:00Z",
  ...changes,
});
function fixture(changes = {}) {
  return {
    summary: deployment(),
    targets: [target()],
    devices: [device(), device(2, { status: "online" })],
    calls: [],
    errors: [],
    failTargets: false,
    ...changes,
  };
}
async function start(
  f,
  { width = 899, theme = "light", role = "viewer", direct = false } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height: 950 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
    localStorage.setItem("vectory-sidebar-collapsed", "true");
  }, theme);
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (e) => f.errors.push(e.message));
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) {
      f.errors.push("External request " + url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = req.method(),
      query = Object.fromEntries(url.searchParams);
    f.calls.push({ path, method, query });
    const respond = (json) => route.fulfill({ json });
    if (method !== "GET") {
      f.errors.push("Unexpected mutation " + method + " " + path);
      return route.fulfill({
        status: 500,
        json: {
          error: {
            code: "SYNTHETIC_MUTATION_FORBIDDEN",
            message: "No mutation permitted",
          },
        },
      });
    }
    if (path === "/status")
      return respond({ initialized: true, version: "synthetic" });
    if (path === "/session")
      return respond({ user: user(role), csrf_token: "synthetic-csrf" });
    if (path === "/deployments/history")
      return respond({ items: [f.summary], total: 1, page: 1, page_size: 12 });
    if (/^\/deployments\/[^/]+\/rollout$/.test(path))
      return respond({
        deployment_id: path.split("/")[2],
        status: "active",
        evaluated_at: new Date().toISOString(),
        stages: [],
        failures: [],
        removed_count: 0,
        check_in_seconds: 60,
        next_admission_at: null,
      });
    if (path === `/deployments/${f.summary.id}/summary`)
      return respond(f.summary);
    if (path === `/deployments/${f.summary.id}/targets`) {
      if (f.failTargets)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "UNAVAILABLE",
              message: "Synthetic target history unavailable",
            },
          },
        });
      let rows = f.targets.filter(
        (t) =>
          (!query.search ||
            t.device_name.toLowerCase().includes(query.search.toLowerCase())) &&
          (!query.state || query.state === "all" || t.state === query.state),
      );
      if (query.sort === "state")
        rows.sort(
          (a, b) =>
            a.state.localeCompare(b.state) *
            (query.direction === "desc" ? -1 : 1),
        );
      const count = rows.length,
        page = Number(query.page || 1),
        size = Number(query.page_size || 12);
      return respond({
        items: rows.slice((page - 1) * size, page * size),
        total: count,
        page,
        page_size: size,
      });
    }
    if (path.startsWith("/devices/")) {
      const record = f.devices.find((d) => path === "/devices/" + d.id);
      if (record) return respond(record);
      // The device page also shows its telemetry.
      const telemetry = f.devices.find(
        (d) => path === "/devices/" + d.id + "/telemetry",
      );
      if (telemetry) return respond({ device_id: telemetry.id, samples: [] });
    }
    // ...and group names, open issues and recent activity.
    if (path === "/groups") return respond([]);
    if (path === "/issues/history" || path === "/audit/history")
      return respond({
        items: [],
        total: 0,
        page: 1,
        page_size: Number(query.page_size || 12),
      });
    if (path === "/agent/releases") return respond([]);
    f.errors.push("Unexpected GET " + path);
    return route.fulfill({
      status: 404,
      json: { error: { code: "UNEXPECTED_FIXTURE_ROUTE", message: path } },
    });
  });
  await page.goto(
    origin +
      "/__retired-targets#/" +
      (direct ? `deployments/${f.summary.id}?page=1` : "deployments"),
  );
  await expect(
    page.getByRole("heading", { name: "Deployments", exact: true }),
  ).toBeVisible();
  return { page, context, close: () => context.close() };
}
async function open(page) {
  await page
    .getByRole("link", { name: "Synthetic retired rollout", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Deployment details", exact: true }),
  ).toBeVisible();
}
const dialog = (page) =>
  page.getByRole("region", { name: "Deployment details", exact: true });
const table = (page) =>
  dialog(page).getByRole("table", { name: "Device results" });
async function noWrites(f) {
  expect(f.calls.filter((c) => c.method !== "GET")).toEqual([]);
  expect(f.errors).toEqual([]);
}
async function check(name, run) {
  const at = Date.now();
  try {
    await run();
    results.push({ name, passed: true, duration_ms: Date.now() - at });
  } catch (e) {
    results.push({
      name,
      passed: false,
      error: e.message,
      duration_ms: Date.now() - at,
    });
  }
  console.log((results.at(-1).passed ? "PASS " : "FAIL ") + name);
}
try {
  await check(
    "Completed persistent rollout distinguishes retained removed targets from current verified application",
    async () => {
      const f = fixture(),
        app = await start(f);
      try {
        const { page } = app;
        const row = page.getByRole("row").filter({
          has: page.getByRole("link", {
            name: "Synthetic retired rollout",
            exact: true,
          }),
        });
        await expect(row).toContainText("1 device no longer targeted");
        await expect(row).toContainText("Complete");
        await open(page);
        await expect(dialog(page)).toContainText("No devices follow this now");
        await expect(dialog(page)).toContainText(
          "Its devices stay in history.",
        );
        await expect(table(page)).toContainText("No longer targeted");
        await expect(table(page)).toContainText(
          "No longer included in this assignment. Kept in deployment history.",
        );
        await expect(table(page)).not.toContainText("No reported error");
        await expect(table(page)).not.toContainText("Waiting for check-in");
        await expect(
          table(page).locator(".rollout-chip", { hasText: "Verified" }),
        ).toHaveCount(0);
        await noWrites(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Old target identity remains exact through navigation veto, retired device view and Back; no same-name replacement is inferred",
    async () => {
      const f = fixture(),
        app = await start(f);
      try {
        const { page } = app;
        await open(page);
        const link = table(page).getByRole("link", {
          name: "Synthetic retired edge",
          exact: true,
        });
        await expect(link).toHaveAttribute("href", "#/devices/" + id(1));
        await expect(
          dialog(page).locator(`a[href="#/devices/${id(2)}"]`),
        ).toHaveCount(0);
        await page.evaluate(() => {
          window.blockRetiredNavigation = (e) => e.preventDefault();
          window.addEventListener(
            "vectory:before-navigate",
            window.blockRetiredNavigation,
          );
        });
        await link.click();
        await expect(dialog(page)).toBeVisible();
        await expect
          .poll(() => new URL(page.url()).hash)
          .toContain("deployments/");
        expect(f.calls.some((c) => c.path === "/devices/" + id(1))).toBe(false);
        await page.evaluate(() =>
          window.removeEventListener(
            "vectory:before-navigate",
            window.blockRetiredNavigation,
          ),
        );
        await link.click();
        await expect(
          page.getByRole("heading", {
            name: "Synthetic retired edge",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByText("Access revoked", { exact: true }),
        ).toBeVisible();
        expect(new URL(page.url()).hash).toBe("#/devices/" + id(1));
        expect(f.calls.some((c) => c.path === "/devices/" + id(2))).toBe(false);
        await page.goBack();
        await expect(dialog(page)).toBeVisible();
        await expect(table(page)).toContainText("No longer targeted");
        await noWrites(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Removed targets retain historical errors and mixed verification; rollback copy excludes removed members without sending an action",
    async () => {
      const f = fixture({
        summary: deployment(100, {
          target_count: 2,
          verified_count: 1,
          state_counts: { removed: 1, verified_applied: 1 },
        }),
        targets: [
          target(1, { generation: 7, error: "VALIDATION_FAILED (validation)" }),
          target(3, {
            device_name: "Synthetic active edge",
            state: "verified_applied",
            generation: 8,
          }),
        ],
      });
      const app = await start(f, { role: "operator" });
      try {
        const { page } = app;
        await open(page);
        await expect(dialog(page)).toContainText("1 of 1 device verified");
        await expect(dialog(page)).toContainText(
          "1 earlier device is no longer targeted and stays in history.",
        );
        const removed = table(page)
          .getByRole("row")
          .filter({
            has: page.getByRole("link", {
              name: "Synthetic retired edge",
              exact: true,
            }),
          });
        await expect(removed).toContainText(
          "No longer included in this assignment. Kept in deployment history.",
        );
        await expect(removed).toContainText("Last reported error:");
        await expect(removed).toContainText("VALIDATION_FAILED (validation)");
        await expect(
          removed.locator(".rollout-chip", { hasText: "Verified" }),
        ).toHaveCount(0);
        await expect(
          table(page)
            .getByRole("row")
            .filter({
              has: page.getByRole("link", {
                name: "Synthetic active edge",
                exact: true,
              }),
            }),
        ).toContainText("Verified");
        await dialog(page)
          .getByRole("button", { name: "Roll back", exact: true })
          .click();
        // This fixture's server does not offer reviewed rollback, so the
        // review says so and never sends anything.
        const confirmation = page.getByRole("dialog", {
          name: "Review rollback",
          exact: true,
        });
        await expect(confirmation).toContainText(
          "This server cannot provide a reviewed rollback.",
        );
        await expect(confirmation.locator(".modal-body")).not.toContainText(
          "2 devices",
        );
        await confirmation
          .getByRole("button", { name: "Keep current state" })
          .click();
        await expect(dialog(page)).toBeVisible();
        await noWrites(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Snapshot history and legacy desired rows are not reclassified by the browser",
    async () => {
      const f = fixture({
        summary: deployment(100, {
          target_mode: "snapshot",
          status: "active",
          state_counts: { desired: 1 },
        }),
        targets: [target(1, { state: "desired" })],
      });
      const app = await start(f);
      try {
        const { page } = app;
        await open(page);
        await expect(table(page)).toContainText("Waiting for check-in");
        await expect(
          dialog(page).locator(".deployment-removed-count"),
        ).toHaveCount(0);
        await expect(
          dialog(page).locator(".deployment-membership-note"),
        ).toHaveCount(0);
        await expect(dialog(page)).toContainText("0 of 1 device verified");
        await noWrites(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Removed filters and sort stay server-scoped across paging, empty search and retriable read failures",
    async () => {
      const f = fixture({
        summary: deployment(100, {
          target_count: 14,
          verified_count: 1,
          state_counts: { removed: 13, verified_applied: 1 },
        }),
        targets: [
          ...Array.from({ length: 13 }, (_, i) =>
            target(i + 1, {
              device_name: "Synthetic retired " + String(i).padStart(2, "0"),
            }),
          ),
          target(20, {
            device_name: "Synthetic active",
            state: "verified_applied",
          }),
        ],
      });
      const app = await start(f);
      try {
        const { page } = app;
        await open(page);
        await expect(table(page).locator("tbody tr")).toHaveCount(12);
        await dialog(page)
          .getByRole("button", { name: "Next", exact: true })
          .click();
        await expect(table(page).locator("tbody tr")).toHaveCount(2);
        await dialog(page)
          .getByRole("button", { name: "Filter Progress", exact: true })
          .click();
        await page
          .getByRole("radio", { name: "No longer targeted (13)", exact: true })
          .click();
        await expect(table(page).locator("tbody tr")).toHaveCount(12);
        await expect(dialog(page).locator(".pagination")).toContainText(
          "1 / 2",
        );
        await dialog(page)
          .getByRole("button", { name: "Sort by Progress", exact: true })
          .click();
        await expect
          .poll(
            () =>
              f.calls.filter((c) => c.path.endsWith("/targets")).at(-1).query
                .sort,
          )
          .toBe("state");
        expect(
          f.calls.filter((c) => c.path.endsWith("/targets")).at(-1).query,
        ).toMatchObject({ state: "removed", page: "1", sort: "state" });
        const search = dialog(page).getByRole("textbox", {
          name: "Search deployment devices",
          exact: true,
        });
        await search.fill("not present");
        await expect(dialog(page)).toContainText(
          "No devices match these filters.",
        );
        await expect(dialog(page)).toContainText("1 of 1 device verified");
        await expect(dialog(page)).toContainText(
          "13 earlier devices are no longer targeted",
        );
        f.failTargets = true;
        await search.fill("retired");
        await expect(dialog(page).getByRole("alert")).toContainText(
          "Synthetic target history unavailable",
        );
        await expect(table(page)).not.toContainText("Synthetic retired 00");
        f.failTargets = false;
        await dialog(page)
          .getByRole("button", { name: "Try again", exact: true })
          .click();
        await expect(table(page).locator("tbody tr")).toHaveCount(12);
        expect(
          f.calls.filter((c) => c.path.endsWith("/targets")).at(-1).query,
        ).toMatchObject({
          state: "removed",
          search: "retired",
          page: "1",
          sort: "state",
        });
        await noWrites(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Retained target history is readable on desktop/mobile in both themes without mutation controls for viewers",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          const f = fixture({
            targets: [target(1, { error: "VALIDATION_FAILED (validation)" })],
          });
          const app = await start(f, { width, theme });
          try {
            const { page } = app;
            await open(page);
            await expect(table(page)).toContainText("No longer targeted");
            await expect(
              dialog(page).getByRole("button", {
                name: "Roll back",
                exact: true,
              }),
            ).toHaveCount(0);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const box = await dialog(page).boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
            const axe = await new AxeBuilder({ page }).analyze();
            accessibility.push({
              width,
              theme,
              violations: axe.violations.map((v) => ({
                id: v.id,
                impact: v.impact,
                nodes: v.nodes.map((n) => n.target),
              })),
            });
            expect(axe.violations).toEqual([]);
            const file = `retired-targets-${width}-${theme}.png`;
            await page.screenshot({ path: resolve(output, file) });
            screenshots.push(file);
            await noWrites(f);
          } finally {
            await app.close();
          }
        }
    },
  );
} finally {
  await browser.close();
  await server.close();
  const current = await hashes();
  const report = {
    recorded_at: new Date().toISOString(),
    scope:
      "Actual App deployment history/detail and exact retired-device navigation, intercepted synthetic HTTP only. No live mutation, no backend target transition, no recovery or rollout action executed.",
    passed:
      results.length === 6 &&
      results.every((r) => r.passed) &&
      accessibility.length === 4 &&
      accessibility.every((s) => !s.violations.length),
    results,
    accessibility,
    screenshots,
    loaded_source_sha256: loaded,
    current_source_sha256: current,
    source_changed_during_run: Object.keys(current).filter(
      (p) => current[p] !== loaded[p],
    ),
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (!report.passed) process.exitCode = 1;
}
