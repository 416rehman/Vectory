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
  process.env.VECTORY_CANARY_GATE_OUTPUT || ".local/canary-gate-ui",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/Deployments.tsx",
  "dashboard/src/deployments.css",
  "dashboard/src/deploymentRouting.ts",
  "dashboard/src/api.ts",
  "dashboard/src/Fleet.tsx",
  "dashboard/src/CanaryGate.tsx",
  "dashboard/src/canaryGateModel.ts",
  "dashboard/src/canary-gate.css",
  "dashboard/src/DataTable.tsx",
  "dashboard/tests/canary-gate-browser.mjs",
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
const virtual = "\0virtual:canary-gate";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "canary-gate",
      resolveId(id) {
        if (id === "virtual:canary-gate") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__canary-gate") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic current canary gate verification</title></head><body><div id="root"></div><script type="module">import "virtual:canary-gate";</script></body></html>',
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
const reasons = ["superseded", "stale", "paused", "unverified", "unavailable"];
const reasonLabels = {
  superseded: "Another assignment is effective",
  stale: "Waiting for a check-in",
  paused: "Configuration sync is paused",
  unverified: "Waiting for the device to confirm",
  unavailable: "Device is unavailable",
};
const gate = (extra = {}) => ({
  state: "waiting",
  released_count: 1,
  verified_count: 0,
  pending_count: 1,
  reasons: {
    superseded: 1,
    stale: 0,
    paused: 0,
    unverified: 0,
    unavailable: 0,
  },
  observation_started_at: null,
  observation_seconds: 60,
  evaluated_at: "2026-09-27T12:00:00Z",
  ...extra,
});
const deployment = (n = 100, changes = {}) => ({
  id: id(n),
  name: "Synthetic canary observation",
  configuration_id: id(50),
  configuration_name: "Synthetic logs",
  version_id: id(51),
  version_number: 3,
  policy: null,
  priority: 100,
  target_mode: "persistent",
  status: "active",
  scheduled_at: null,
  created_at: "2026-09-27T00:00:00Z",
  rollout: {
    kind: "canary",
    canary_size: 1,
    batch_size: 1,
    observation_seconds: 60,
    failure_threshold: 0,
  },
  target_count: 2,
  verified_count: 1,
  state_counts: { verified_applied: 1, pending: 1 },
  canary_gate: gate(),
  ...changes,
});
const target = (n = 1, changes = {}) => ({
  device_id: id(n),
  device_name: "Synthetic canary device",
  state: "verified_applied",
  generation: 7,
  error: null,
  original: true,
  ...changes,
});
const device = (n = 1, changes = {}) => ({
  id: id(n),
  name: "Synthetic canary device",
  os: "windows",
  arch: "amd64",
  status: "online",
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
    targets: [
      target(1, { gate_reason: "superseded" }),
      target(2, { state: "pending", generation: 0, gate_reason: null }),
    ],
    devices: [device(), device(2, { status: "online" })],
    calls: [],
    errors: [],
    failTargets: false,
    failSummary: false,
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
    if (path === "/deployments/history") {
      const { canary_gate: _, ...historical } = f.summary;
      return respond({ items: [historical], total: 1, page: 1, page_size: 12 });
    }
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
    if (path === `/deployments/${f.summary.id}/summary`) {
      if (f.failSummary)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "UNAVAILABLE",
              message: "Synthetic summary unavailable",
            },
          },
        });
      return respond(f.summary);
    }
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
    }
    if (path === "/agent/releases") return respond([]);
    f.errors.push("Unexpected GET " + path);
    return route.fulfill({
      status: 404,
      json: { error: { code: "UNEXPECTED_FIXTURE_ROUTE", message: path } },
    });
  });
  await page.goto(
    origin +
      "/__canary-gate#/" +
      (direct ? `deployments/${f.summary.id}?page=1` : "deployments"),
  );
  await expect(
    page.getByRole("heading", { name: "Deployments", exact: true }),
  ).toBeVisible();
  return { page, context, close: () => context.close() };
}
async function open(page) {
  await page
    .getByRole("link", { name: "Synthetic canary observation", exact: true })
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
const panel = (page) =>
  dialog(page).getByRole("region", { name: "Canary gate", exact: true });
try {
  await check(
    "Current gate evidence is separate from unchanged historical verification and exact device identity",
    async () => {
      const f = fixture(),
        app = await start(f);
      try {
        const { page } = app;
        await open(page);
        await expect(panel(page)).toBeVisible();
        await expect(panel(page)).toContainText("0 of 1");
        await expect(dialog(page)).toContainText("1 of 2");
        await expect(table(page)).toContainText("Verified");
        await expect(table(page)).toContainText(
          "Canary gate: Another assignment is effective",
        );
        await expect(dialog(page)).toContainText(
          "Recorded progress: historical results; current readiness is shown below.",
        );
        const link = table(page).locator(`a[href="#/devices/${id(1)}"]`);
        await expect(link).toHaveCount(1);
        await link.focus();
        await page.keyboard.press("Enter");
        await expect
          .poll(() => new URL(page.url()).hash)
          .toBe("#/devices/" + id(1));
        await expect(
          page.getByRole("heading", {
            name: "Synthetic canary device",
            exact: true,
          }),
        ).toBeVisible();
        await page.goBack();
        await expect(dialog(page)).toBeVisible();
        await expect(panel(page)).toContainText("0 of 1");
        expect(
          f.calls.filter((c) => c.path === "/devices/" + id(2)),
        ).toHaveLength(0);
        await noWrites(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Each fixed gate reason is read-only and independent of historical result text",
    async () => {
      for (const reason of reasons) {
        const f = fixture({
            summary: deployment(100, {
              canary_gate: gate({
                reasons: Object.fromEntries(
                  reasons.map((key) => [key, key === reason ? 1 : 0]),
                ),
              }),
            }),
            targets: [
              target(1, { gate_reason: reason }),
              target(2, { state: "pending", generation: 0, gate_reason: null }),
            ],
          }),
          app = await start(f);
        try {
          await open(app.page);
          await expect(panel(app.page)).toBeVisible();
          await expect(panel(app.page)).toContainText("0 of 1");
          await expect(table(app.page)).toContainText("Verified");
          await expect(panel(app.page)).toContainText(reasonLabels[reason]);
          await expect(table(app.page)).toContainText(
            "Canary gate: " + reasonLabels[reason],
          );
          await expect(
            panel(app.page).getByRole("button", {
              name: /retry|resume|release|pause|cancel/i,
            }),
          ).toHaveCount(0);
          await noWrites(f);
        } finally {
          await app.close();
        }
      }
    },
  );
  await check(
    "Observing and paused states obey supplied current evidence rather than historical counts or client countdown",
    async () => {
      for (const state of ["observing", "paused"]) {
        const f = fixture({
            summary: deployment(100, {
              status: state === "paused" ? "paused" : "active",
              canary_gate: gate({
                state,
                verified_count: 1,
                reasons: Object.fromEntries(reasons.map((key) => [key, 0])),
                observation_started_at:
                  state === "observing" ? "2026-09-27T11:59:30Z" : null,
              }),
            }),
            targets: [
              target(1, { gate_reason: null }),
              target(2, { state: "pending", generation: 0, gate_reason: null }),
            ],
          }),
          app = await start(f);
        try {
          await open(app.page);
          await expect(panel(app.page)).toContainText("1 of 1");
          await expect(panel(app.page)).toContainText(
            state === "observing" ? /observ/i : /paused/i,
          );
          await expect(panel(app.page)).not.toContainText(
            /rollout complete|ready to release now/i,
          );
          await expect(table(app.page)).not.toContainText(
            /current.*superseded/i,
          );
          await noWrites(f);
        } finally {
          await app.close();
        }
      }
    },
  );
  await check(
    "Legacy and malformed gate information is unavailable, never inferred as current verification",
    async () => {
      const invalid = [
        undefined,
        { ...gate(), verified_count: 2 },
        { ...gate(), state: "ready" },
        { ...gate(), reasons: { ...gate().reasons, superseded: -1 } },
        {
          ...gate(),
          state: "observing",
          observation_started_at: "2026-09-27T12:01:00Z",
        },
      ];
      for (const value of invalid) {
        const f = fixture({ summary: deployment(100, { canary_gate: value }) }),
          app = await start(f);
        try {
          await open(app.page);
          await expect(panel(app.page)).toContainText(/unavailable/i);
          await expect(panel(app.page)).not.toContainText("1 of 1");
          await expect(dialog(app.page)).toContainText("1 of 2");
          await noWrites(f);
        } finally {
          await app.close();
        }
      }
    },
  );
  await check(
    "Summary read failure cannot retain cached gate readiness; terminal and all-at-once histories have no current canary claim",
    async () => {
      const f = fixture({
          summary: deployment(100, {
            canary_gate: gate({
              state: "observing",
              verified_count: 1,
              reasons: Object.fromEntries(reasons.map((key) => [key, 0])),
              observation_started_at: "2026-09-27T11:59:30Z",
            }),
          }),
        }),
        app = await start(f);
      try {
        await open(app.page);
        await expect(panel(app.page)).toContainText("1 of 1");
        f.failSummary = true;
        await panel(app.page)
          .getByRole("button", { name: "Refresh canary gate", exact: true })
          .click();
        await expect(
          app.page.getByText("Synthetic summary unavailable", { exact: true }),
        ).toBeVisible();
        await expect(panel(app.page)).toContainText(/unavailable|could not/i);
        await expect(panel(app.page)).not.toContainText("1 of 1");
        f.failSummary = false;
        await app.page
          .getByRole("button", { name: "Try again", exact: true })
          .click();
        await expect(panel(app.page)).toContainText("1 of 1");
        await noWrites(f);
      } finally {
        await app.close();
      }
      for (const extra of [
        { status: "completed" },
        { status: "failed" },
        { status: "cancelled" },
        { rollout: { ...deployment().rollout, kind: "all" } },
      ]) {
        const f = fixture({ summary: deployment(100, extra) }),
          app = await start(f);
        try {
          await open(app.page);
          await expect(panel(app.page)).toHaveCount(0);
          await noWrites(f);
        } finally {
          await app.close();
        }
      }
    },
  );
  await check(
    "Target paging and search do not change whole-gate counts or introduce writes",
    async () => {
      const f = fixture({
          summary: deployment(100, {
            target_count: 14,
            state_counts: { verified_applied: 1, pending: 13 },
            canary_gate: gate({ pending_count: 13 }),
          }),
          targets: Array.from({ length: 14 }, (_, i) =>
            target(i + 1, {
              device_name: `Synthetic device ${i + 1}`,
              state: i ? "pending" : "verified_applied",
              generation: i ? 0 : 7,
              gate_reason: i ? null : "superseded",
            }),
          ),
        }),
        app = await start(f);
      try {
        await open(app.page);
        await expect(panel(app.page)).toContainText("0 of 1");
        await dialog(app.page)
          .getByRole("button", { name: "Next", exact: true })
          .click();
        await expect
          .poll(() =>
            f.calls.some(
              (c) => c.path.endsWith("/targets") && c.query.page === "2",
            ),
          )
          .toBe(true);
        await expect(panel(app.page)).toContainText("0 of 1");
        await dialog(app.page)
          .getByRole("textbox", { name: "Search deployment devices" })
          .fill("device 14");
        await expect
          .poll(() =>
            f.calls.some(
              (c) =>
                c.path.endsWith("/targets") &&
                c.query.search === "device 14" &&
                c.query.page === "1",
            ),
          )
          .toBe(true);
        await expect(table(app.page)).toContainText("Synthetic device 14");
        await expect(panel(app.page)).toContainText("0 of 1");
        await noWrites(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Current gate reasons remain readable and accessible at899/375 in both themes",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          const f = fixture({
              summary: deployment(100, {
                target_count: 7,
                verified_count: 5,
                state_counts: { verified_applied: 5, pending: 2 },
                canary_gate: gate({
                  released_count: 5,
                  pending_count: 2,
                  reasons: Object.fromEntries(reasons.map((key) => [key, 1])),
                }),
              }),
              targets: [
                ...reasons.map((reason, index) =>
                  target(index + 1, {
                    device_name: `Synthetic ${reason} device`,
                    gate_reason: reason,
                  }),
                ),
                target(6, {
                  state: "pending",
                  generation: 0,
                  gate_reason: null,
                }),
                target(7, {
                  state: "pending",
                  generation: 0,
                  gate_reason: null,
                }),
              ],
            }),
            app = await start(f, { width, theme });
          try {
            const { page } = app;
            await open(page);
            await expect(panel(page)).toBeVisible();
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const box = await panel(page).boundingBox();
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
            const file = `canary-gate-${width}-${theme}.png`;
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
      "Actual App read-only canary detail/current evidence and historical target UI with intercepted synthetic HTTP. No native gate computation, heartbeat or activation is claimed.",
    passed:
      results.length === 7 &&
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
