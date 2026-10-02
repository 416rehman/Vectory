// A device whose newest version failed but which keeps running and delivering
// on an earlier one is held, amber, and counted on its own: the Devices page
// and the Overview, real components, intercepted synthetic HTTP.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { configuredChannels } from "./notification-fixtures.mjs";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_HEALTH_HELD_OUTPUT || ".local/health-held",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:health-held";
const admin = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Morgan Lee",
  email: "synthetic@example.test",
  role: "admin",
  enabled: true,
  revision: 1,
};
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "health-held",
      resolveId(id) {
        if (id === "virtual:health-held") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import{Devices}from'/src/Fleet.tsx';import{Overview}from'/src/Overview.tsx';import{setCSRF}from'/src/api.ts';import{applyTheme}from'/src/appearance.ts';import'/src/styles.css';setCSRF('synthetic');applyTheme(localStorage.getItem('vectory-theme')==='dark'?'dark':'light');const root=createRoot(document.getElementById('root'));const user=${JSON.stringify(admin)};window.mount=(name)=>{root.render(React.createElement('main',{className:'page-content'},name==='devices'?React.createElement(Devices,{user,navigate:x=>{window.navigation=x},notify:x=>{}}):React.createElement(Overview,{user,navigate:path=>{window.location.hash='/'+path}})));};window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__health-held") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic held devices</title></head><body><div id="root"></div><script type="module">import "virtual:health-held";</script></body></html>',
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
  screenshots = [],
  errors = [];
const uuid = (n) =>
  `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const now = Date.now();
const ago = (seconds) => new Date(now - seconds * 1000).toISOString();
const pipeline = uuid(40),
  newest = uuid(41),
  earlier = uuid(42),
  rollout = uuid(50);
const issue = {
  code: "DATA_PLANE_SINK_ERRORS",
  component_id: "out",
  title: "out can't deliver events",
};
const device = (n, name, extra = {}) => ({
  id: uuid(n),
  name,
  os: "linux",
  arch: "amd64",
  agent_version: "0.1.0",
  vector_version: "0.58.0",
  labels: {},
  status: "verified",
  apply_state: "verified_applied",
  desired_version_id: newest,
  desired_version: {
    id: newest,
    number: 3,
    configuration_id: pipeline,
    configuration_name: "Edge syslog",
  },
  desired_generation: 2,
  reported_generation: 2,
  sync_paused: false,
  local_paused: false,
  pause_acknowledged: false,
  last_seen: ago(8),
  created_at: ago(86400),
  configuration_mode: "full",
  effective_policy: {
    heartbeat_seconds: 15,
    sync_paused: false,
    telemetry_enabled: true,
  },
  telemetry: { sampled_at: ago(9), events_per_second: 20 },
  ...extra,
});
const held = (n, name, status) =>
  device(n, name, {
    status,
    apply_state: status,
    held_on_previous_version: true,
    running_version: {
      id: earlier,
      number: 2,
      configuration_id: pipeline,
      configuration_name: "Edge syslog",
    },
  });
const devices = [
  device(2, "edge-fra-01"),
  device(3, "edge-nyc-01"),
  held(4, "edge-nyc-02", "rolled_back"),
  device(5, "edge-lon-01", { status: "failed", apply_state: "failed" }),
  device(6, "edge-ams-01", {
    data_plane: { version_id: newest, issues: [issue] },
  }),
  device(7, "edge-syd-01", { status: "offline", last_seen: ago(7200) }),
  device(8, "lab-01", {
    status: "unmanaged",
    apply_state: "unmanaged",
    desired_version_id: null,
    desired_version: null,
    desired_generation: 0,
    reported_generation: 0,
  }),
];
const overview = {
  devices_total: devices.length,
  devices_online: 6,
  configurations_total: 1,
  deployments_active: 1,
  issues_open: 1,
  devices,
  recent_activity: [],
  devices_managed: 6,
  devices_on_desired: 3,
  versions_total: 3,
  versions: {},
  rollouts: [],
  attention: [
    {
      cause: "failed",
      severity: "danger",
      count: 1,
      device_ids: [uuid(5)],
      device_names: ["edge-lon-01"],
      version_id: newest,
      version_number: 3,
      configuration_id: pipeline,
      configuration_name: "Edge syslog",
      state: "failed",
      since: null,
      reason: "data_dir does not exist",
    },
    {
      cause: "held",
      severity: "warning",
      count: 1,
      device_ids: [uuid(4)],
      device_names: ["edge-nyc-02"],
      version_id: newest,
      version_number: 3,
      configuration_id: pipeline,
      configuration_name: "Edge syslog",
      state: "held",
      since: null,
      reason: "Address already in use",
      deployment_id: rollout,
      rollback_available: false,
    },
  ],
  fleet_activity: [],
  security_events_hidden: 0,
};
async function open(name, { width = 1280, theme = "light" } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
    localStorage.setItem("vectory-sidebar-collapsed", "true");
  }, theme);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errors.push(e.message));
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) {
      errors.push("External request " + url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7);
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (req.method() !== "GET") {
      errors.push("Unexpected " + req.method() + " " + path);
      return reply({ error: { code: "UNEXPECTED", message: path } }, 500);
    }
    if (path === "/devices") return reply(devices);
    if (path === "/groups") return reply([]);
    if (path === "/overview") return reply(overview);
    if (path === "/notifications/channels") return reply(configuredChannels);
    if (path === "/telemetry/summary")
      return reply({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    if (path === "/releases") return reply([]);
    if (path === "/deployments/history")
      return reply({ items: [], total: 0, page: 1, page_size: 5 });
    if (path === "/policies" || path === "/tokens") return reply([]);
    if (
      /^\/deployments\/requests\//.test(path) ||
      /^\/groups\/requests\//.test(path)
    )
      return reply({ request_id: path.split("/").at(-1), found: false });
    errors.push("Unexpected GET " + path);
    return reply({ error: { code: "UNEXPECTED", message: path } }, 404);
  });
  await page.goto(origin + "/__health-held");
  await page.waitForFunction(() => window.ready);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.evaluate((name) => window.mount(name), name);
  return { page, close: () => context.close() };
}
const check = async (name, run) => {
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
};
async function accessible(page, width, theme, label) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const axe = await new AxeBuilder({ page }).analyze();
  accessibility.push({
    width,
    theme,
    page: label,
    violations: axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target),
    })),
  });
  const file = `held-${label}-${width}-${theme}.png`;
  await page.screenshot({ path: resolve(output, file), fullPage: true });
  screenshots.push(file);
  expect(axe.violations).toEqual([]);
}

try {
  await check(
    "The Devices page says held, not failed, for a device that keeps a working version",
    async () => {
      const app = await open("devices");
      try {
        const { page } = app;
        const table = page.getByRole("table").first();
        const row = (name) =>
          table.getByRole("row", { name: new RegExp(name) });
        await expect(row("edge-nyc-02")).toContainText(
          "Held on previous version",
        );
        await expect(row("edge-nyc-02")).not.toContainText("Rolled back");
        await expect(row("edge-nyc-02")).toContainText(
          "Previous version running",
        );
        // A real failure keeps its word and its red.
        await expect(row("edge-lon-01")).toContainText("Failed");
        await expect(row("edge-lon-01")).not.toContainText("Held");
        await expect(row("edge-ams-01")).toContainText("Not delivering");
        // The status filter offers the state by its badge's words.
        await page
          .getByRole("button", { name: /^Filter Status(?: \(active\))?$/ })
          .click();
        await page
          .getByRole("radio", {
            name: /^Held on previous version(?: [\d,]+)?$/,
          })
          .click();
        await expect(row("edge-nyc-02")).toHaveCount(1);
        for (const other of ["edge-lon-01", "edge-ams-01", "edge-fra-01"])
          await expect(row(other)).toHaveCount(0);
        expect(new URL(page.url()).hash).toContain("status=held");
        expect(errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "The quick filter reads Needs attention, lists what it holds and includes the held device",
    async () => {
      const app = await open("devices");
      try {
        const { page } = app;
        const chips = page.getByRole("group", { name: "Quick filters" });
        await expect(
          chips.getByRole("button", { name: /Failing/ }),
        ).toHaveCount(0);
        const chip = chips.getByRole("button", { name: /Needs attention/ });
        await expect(chip).toBeVisible();
        // Failed, held, and not delivering (the rolled-back device is the held one).
        await expect(chip).toContainText("3");
        await chip.hover();
        await expect(page.getByRole("tooltip")).toContainText(
          "held on the previous version",
        );
        await expect(page.getByRole("tooltip")).toContainText("not delivering");
        await chip.click();
        const table = page.getByRole("table").first();
        for (const name of ["edge-lon-01", "edge-nyc-02", "edge-ams-01"])
          await expect(
            table.getByRole("row", { name: new RegExp(name) }),
          ).toHaveCount(1);
        await expect(
          table.getByRole("row", { name: /edge-fra-01/ }),
        ).toHaveCount(0);
        expect(errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Fleet health counts the held device as a segment of its own, with the same words",
    async () => {
      const app = await open("overview");
      try {
        const { page } = app;
        const legend = page.getByRole("list", { name: "Devices by state" });
        await expect(legend).toContainText("Held on previous version");
        await expect(
          legend.getByRole("link", { name: /Held on previous version/ }),
        ).toHaveAttribute("href", "#/devices?status=held");
        const bar = page.getByRole("img", { name: /devices?:/ }).first();
        await expect(bar).toHaveAttribute(
          "aria-label",
          /1 held on previous version/,
        );
        // The device is in exactly one segment: held, and no longer failed.
        await expect(
          legend.getByRole("link", { name: /^Failed\s*1$/ }),
        ).toHaveCount(1);
        await expect(
          legend.getByRole("link", { name: /Failed/ }),
        ).toContainText("1");
        expect(errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "The Overview says how many devices are held instead of not yet verified",
    async () => {
      const app = await open("overview");
      try {
        const { page } = app;
        const tile = page.locator(".overview-kpi-tile", {
          hasText: "On desired version",
        });
        await expect(tile).toContainText("3");
        await expect(tile).toContainText("/ 6");
        await expect(tile).toContainText("1 held on previous version");
        // The others are still behind, and are not called held.
        await expect(tile).toContainText("2 not yet verified");
        const needs = page.locator(".overview-attention-item");
        const heldRow = needs.filter({ hasText: "held on previous version" });
        await expect(heldRow).toContainText(
          "1 device held on previous version",
        );
        await expect(heldRow).toContainText("Address already in use");
        await expect(heldRow).toHaveAttribute("data-severity", "warning");
        await expect(
          heldRow.getByRole("link", { name: "Open rollout" }),
        ).toHaveAttribute("href", `#/deployments/${rollout}`);
        // Amber, not red: the failed device is the only danger row.
        await expect(
          needs.filter({ has: page.locator('[data-severity="danger"]') }),
        ).toHaveCount(0);
        await expect(
          page.locator('.overview-attention-item[data-severity="danger"]'),
        ).toHaveCount(1);
        expect(errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Held devices read the same and stay accessible in both themes and on a phone",
    async () => {
      for (const width of [1280, 390])
        for (const theme of ["light", "dark"])
          for (const name of ["devices", "overview"]) {
            const app = await open(name, { width, theme });
            try {
              const { page } = app;
              await expect(
                page.getByText("Held on previous version").first(),
              ).toBeVisible();
              await accessible(page, width, theme, name);
              expect(errors).toEqual([]);
            } finally {
              await app.close();
            }
          }
    },
  );
} finally {
  await browser.close();
  await server.close();
  const report = {
    recorded_at: new Date().toISOString(),
    scope:
      "The real Devices page and Overview with intercepted synthetic HTTP. No device or server computation is claimed; the server's held rule is tested in its own suite.",
    passed:
      results.length === 5 &&
      results.every((r) => r.passed) &&
      accessibility.length === 8 &&
      accessibility.every((s) => !s.violations.length),
    results,
    accessibility,
    screenshots,
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (!report.passed) process.exitCode = 1;
}
