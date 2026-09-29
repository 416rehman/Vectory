// Actual fleet/settings/review components; all HTTP is intercepted synthetic data.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { createHash } from "node:crypto";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_FLEET_TABLES_OUTPUT || ".local/fleet-tables-component",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:fleet-tables";
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const server = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "isolated-fleet-tables",
      resolveId(id) {
        if (id === "virtual:fleet-tables") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import{Devices,Groups}from'/src/Fleet.tsx';import{Policies}from'/src/Control.tsx';import{Enrollment}from'/src/Enrollment.tsx';import TargetDialog from'/src/TargetDialog.tsx';import ScheduledAssignmentRefresh from'/src/ScheduledAssignmentRefresh.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';setCSRF('synthetic');const root=createRoot(document.getElementById('root'));let key=0;window.mount=(name,props={})=>{window.notices=[];root.render(React.createElement(({devices:Devices,groups:Groups,policies:Policies,enrollment:Enrollment,target:TargetDialog,recovery:(p)=>React.createElement(ScheduledAssignmentRefresh,{deploymentId:p.deployment.id,actorId:p.user.id,allowed:true,open:true,onClose:p.onClose,onDone:p.onDone})})[name],{key:++key,userId:'00000000-0000-4000-8000-000000000090',user:{id:'admin',name:'Synthetic administrator',email:'fixture@example.test',role:'admin',enabled:true,revision:1},notify:x=>window.notices.push(x),navigate:x=>window.navigation=x,onDone:x=>window.notices.push(x),onClose:()=>window.closed=true,...props}));};window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__fleet-tables") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic table verification</title></head><body><main style="padding:20px"><div id="root"></div></main><script type="module">import "virtual:fleet-tables";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const results = [],
  requests = [],
  errors = [],
  accessibility = [];
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const devices = Array.from({ length: 1000 }, (_, i) => ({
  id: id(i),
  name: `Device ${String(i).padStart(4, "0")}`,
  os: "linux",
  arch: "amd64",
  status: i === 20 ? "revoked" : i % 2 ? "offline" : "verified",
  last_seen:
    i === 999 ? null : new Date(Date.UTC(2026, 8, 26, 0, i)).toISOString(),
  apply_state: i % 2 ? "failed" : "verified_applied",
  desired_generation: 1,
  reported_generation: 1,
  desired_version_id: id(3000),
  sync_paused: i === 2,
  local_paused: false,
  effective_policy: {
    heartbeat_seconds: 60,
    sync_paused: false,
    telemetry_enabled: true,
  },
  labels: {},
  configuration_mode: "full",
}));
const policies = [
  {
    id: id(2000),
    name: "Slow",
    policy: {
      heartbeat_seconds: 120,
      sync_paused: false,
      telemetry_enabled: false,
    },
  },
  {
    id: id(2001),
    name: "Fast",
    policy: {
      heartbeat_seconds: 10,
      sync_paused: true,
      telemetry_enabled: true,
    },
  },
];
const tokens = [
  {
    id: id(3000),
    name: "Available token",
    name_prefix: "edge",
    max_uses: 1,
    uses: 0,
    revoked: false,
    expires_at: "2030-01-01T00:00:00Z",
  },
  {
    id: id(3001),
    name: "Revoked token",
    name_prefix: "",
    uses: 0,
    max_uses: 1,
    revoked: true,
    expires_at: "2030-01-01T00:00:00Z",
  },
];
let context, page, state;
async function load(name, props = {}) {
  if (context) await context.close();
  context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
  });
  page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on("pageerror", (e) => errors.push(e.message));
  state = {
    groups: Array.from({ length: 26 }, (_, i) => ({
      id: id(1000 + i),
      name: `Group ${String(i).padStart(2, "0")}`,
      description: "Synthetic group",
      device_ids: devices.slice(0, i % 5).map((d) => d.id),
    })),
    writes: [],
    previews: [],
    failDevices: false,
  };
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) throw Error("External request blocked");
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = req.method();
    requests.push({ path, method });
    const reply = (json) => route.fulfill({ json });
    if (method === "GET") {
      if (path === "/devices")
        return state.failDevices
          ? route.fulfill({
              status: 503,
              json: {
                error: {
                  code: "FIXTURE_FAILURE",
                  message: "Synthetic device inventory unavailable",
                },
              },
            })
          : reply(devices);
      if (path === "/groups") return reply(state.groups);
      if (path === "/policies") return reply(policies);
      if (path === "/tokens") return reply(tokens);
      if (path === "/releases") return reply([]);
      if (path === "/agent-install")
        return reply({ agent_url: null, agent_url_configured: false, listener_enabled: false, dashboard_url: null, certificate: null, downloads_enabled: true, installer: null, default_install_dir: "/usr/local/bin", releases: [], catalog_problems: [] });
      if (/^\/groups\/requests\//.test(path) || /^\/deployments\/requests\//.test(path))
        return reply({ request_id: path.split("/").at(-1), found: false });
    }
    const body = req.postDataJSON();
    if (path === "/deployments/preview") {
      state.previews.push(body);
      const selected = devices.filter((d) => body.selector.device_ids.includes(d.id));
      return reply({
        devices: selected,
        warnings: [],
        conflicts: [],
        create_idempotency: true,
        request_correlation: true,
        ...(body.variable_bindings ? {
          artifact_previews: selected.map((device) => ({
            device_id: device.id,
            sha256: createHash("sha256").update(JSON.stringify({ device_id: device.id, bindings: body.variable_bindings })).digest("hex"),
            size: 128,
          })),
        } : {}),
      });
    }
    if (path.endsWith("/refresh-preview"))
      return reply({
        refresh_review: true,
        source_deployment_id: id(8000),
        source_status: "scheduled",
        resource: "configuration",
        scheduled_at: "2026-10-01T12:00:00Z",
        ready: true,
        review_token: "b".repeat(64),
        saved_devices: devices.slice(0, 1).map(({ id, name, status }) => ({ id, name, status })),
        devices: devices.slice(0, 3).map(({ id, name, status }) => ({ id, name, status })),
        warnings: [],
        blockers: [],
      });
    if (method === "POST" && path === "/groups") {
      const group = { id: id(1999), revision: 1, ...body };
      state.writes.push({ path, body });
      state.groups.push(group);
      return reply(group);
    }
    if (
      method === "POST" &&
      (path === "/deployments" || path.endsWith("/refresh"))
    ) {
      state.writes.push({ path, body });
      if (path === "/deployments") return reply({
        ...body, id: id(8001), operation: "create", source_deployment_id: null,
        request_correlation: true, status: "active", created_at: "2026-09-27T12:00:00Z",
        targets: body.expected_device_ids.map(device_id => ({ device_id, state: "pending", generation: 0 })),
      });
      expect(body.review_token).toBe("b".repeat(64));
      return reply({
        id: id(8000), version_id: id(3000), policy: null,
        selector: { device_ids: body.expected_device_ids, group_ids: [], exclude_ids: [] },
        priority: 0, target_mode: "snapshot", status: "scheduled",
        scheduled_at: "2026-10-01T12:00:00Z", created_at: "2026-09-27T12:00:00Z",
        rollout: { kind: "all", canary_size: 1, batch_size: 1, observation_seconds: 0, failure_threshold: 0 },
        targets: body.expected_device_ids.map(device_id => ({ device_id, state: "pending", generation: 0, error: null })),
      });
    }
    if (method === "POST" && path === "/deployments/binding-suggestions")
      return route.fulfill({ json: { devices: {}, sources: {} } });
    throw Error(`Unexpected synthetic request ${method} ${path}`);
  });
  await page.goto(origin + "/__fleet-tables");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(({ name, props }) => window.mount(name, props), {
    name,
    props,
  });
}
const table = (name) => page.getByRole("table", { name, exact: true });
const rows = (name) => table(name).locator("tbody tr");
async function filter(label, value) {
  await page
    .getByRole("button", {
      name: new RegExp(`^Filter ${label}(?: \\(active\\))?$`),
    })
    .click();
  await page.getByRole("radio", { name: value, exact: true }).click();
}
async function textFilter(label, value) {
  await page
    .getByRole("button", {
      name: new RegExp(`^Filter ${label}(?: \\(active\\))?$`),
    })
    .click();
  await page
    .getByRole("textbox", { name: `Filter ${label}`, exact: true })
    .fill(value);
  await page.keyboard.press("Escape");
}
async function sort(label) {
  await page
    .getByRole("button", { name: new RegExp(`^Sort by ${label}(?:,|$)`) })
    .click();
}
async function check(name, run) {
  if (process.env.VECTORY_FLEET_TABLES_ONLY && !name.includes(process.env.VECTORY_FLEET_TABLES_ONLY)) return;
  await run();
  results.push({ name, passed: true });
  console.log("PASS", name);
}
let failure;
try {
  await check(
    "1000-device headers filter before pagination and selection survives sorting and page changes",
    async () => {
      await load("devices");
      await expect(rows("Devices")).toHaveCount(12);
      await page.getByLabel("Select visible devices", { exact: true }).check();
      await expect(
        page.getByText("12 selected", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(rows("Devices").first()).toContainText("Device 0012");
      await page.getByLabel("Select Device 0012", { exact: true }).check();
      await sort("Device");
      await expect(rows("Devices").first()).toContainText("Device 0999");
      await expect(
        page.getByText("13 selected", { exact: true }),
      ).toBeVisible();
      await filter("Connection", "Revoked");
      await expect(rows("Devices")).toHaveCount(1);
      await expect(
        page.getByLabel("Select Device 0020", { exact: true }),
      ).toBeDisabled();
      await filter("Connection", "Online");
      await textFilter("Device", "nothing-matches");
      await expect(
        page.getByRole("heading", { name: "No matching devices" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Filter Connection (active)",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Clear filters", exact: true })
        .click();
      await expect(rows("Devices")).toHaveCount(12);
      await sort("Last seen");
      await sort("Last seen");
      await expect(rows("Devices").first()).toContainText("Device 0998");
      state.failDevices = true;
      await page
        .getByRole("button", { name: "Refresh devices", exact: true })
        .click();
      await expect(
        page.getByText("Synthetic device inventory unavailable", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(table("Devices").locator(".fleet-device-name")).toHaveCount(
        0,
      );
      await expect(
        page.getByLabel("Select visible devices", { exact: true }),
      ).toBeDisabled();
      state.failDevices = false;
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(rows("Devices").first()).toContainText("Device 0998");
      expect(state.writes).toEqual([]);
    },
  );
  await check(
    "groups sort numerically and a newly saved group remains discoverable after header filtering",
    async () => {
      await load("groups");
      await expect(rows("Groups")).toHaveCount(12);
      await sort("Members");
      await sort("Members");
      await expect(rows("Groups").first()).toContainText("4 devices");
      await filter("Members", "Has members");
      await page
        .getByRole("button", { name: "Create group", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Group name", { exact: true }).fill("ZZ Created");
      await dialog
        .getByRole("button", { name: "Create group", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "ZZ Created", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Filter Members", exact: true }),
      ).toBeVisible();
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0].body.device_ids).toEqual([]);
    },
  );
  await check(
    "deployment picker reaches devices beyond its first hundred without losing earlier selections",
    async () => {
      await load("target", {
        open: true,
        policy: {
          heartbeat_seconds: 60,
          sync_paused: false,
          telemetry_enabled: true,
        },
      });
      await expect(
        page.getByRole("navigation", { name: "Device selection pages" }),
      ).toContainText("Showing 1–100 of 999 devices");
      await page.getByRole("button", { name: "Next devices" }).click();
      await page.getByLabel("Select Device 0150", { exact: true }).check();
      await page.getByLabel("Find targets").fill("Device 0999");
      await page.getByLabel("Select Device 0999", { exact: true }).check();
      await page.getByLabel("Find targets").fill("");
      await expect(
        page.getByRole("navigation", { name: "Device selection pages" }),
      ).toContainText("Page 1 of 10");
      await expect(page.getByText("2 devices selected")).toBeVisible();
      await page.getByRole("button", { name: "Review deployment" }).click();
      expect(state.previews.at(-1).selector.device_ids).toEqual([
        devices[150].id,
        devices[999].id,
      ]);
      expect(state.writes).toEqual([]);
    },
  );
  await check(
    "version variables require typed values and freeze per-device overrides through review and create",
    async () => {
      await load("target", {
        open: true,
        version: {
          id: id(3000),
          configuration_id: id(4000),
          number: 2,
          sha256: "a".repeat(64),
          config: {
            api: { enabled: false, address: "127.0.0.1:8686" },
            sources: { input: { type: "demo_logs", format: "json" } },
            transforms: { sample: { type: "sample", inputs: ["input"], rate: 10 } },
            sinks: { discard: { type: "blackhole", inputs: ["sample"] } },
          },
          variables: [{ name: "SAMPLE_RATE", path: "/transforms/sample/rate", type: "integer" }],
        },
        initialDeviceIds: [devices[0].id, devices[1].id],
      });
      await expect(page.getByRole("button", { name: "Review deployment" })).toBeDisabled();
      await page.getByLabel("Set default for selected devices").check();
      await page.getByLabel("Default for SAMPLE_RATE").fill("10");
      await page.getByText("Device overrides", { exact: false }).click();
      await page.getByLabel("Device to customize").selectOption(devices[1].id);
      await page.getByLabel("Override SAMPLE_RATE").check();
      await page.getByLabel("SAMPLE_RATE for Device 0001").fill("20");
      await page.getByRole("button", { name: "Review deployment" }).click();
      const reviewed = state.previews.at(-1);
      expect(reviewed.variable_bindings).toEqual({
        defaults: { SAMPLE_RATE: 10 },
        devices: { [devices[1].id]: { SAMPLE_RATE: 20 } },
      });
      await expect(rows("Deployment review devices")).toHaveCount(2);
      await expect(rows("Deployment review devices").nth(1)).toContainText("Override");
      await expect(rows("Deployment review devices").nth(1)).toContainText("Rendered SHA-256");
      await page.getByRole("button", { name: "Deploy to devices" }).click();
      await expect.poll(() => state.writes.length).toBe(1);
      expect(state.writes.at(-1).body.variable_bindings).toEqual(reviewed.variable_bindings);
      expect(state.writes.at(-1).body.expected_device_ids).toEqual([devices[0].id, devices[1].id]);
    },
  );
  await check(
    "agent settings and enrollment tokens keep controls and meaningful header filters",
    async () => {
      await load("policies");
      await expect(rows("Agent settings")).toHaveCount(2);
      await sort("Check-in interval");
      await expect(rows("Agent settings").first()).toContainText("Fast");
      await filter("Metrics", "Off");
      await expect(rows("Agent settings")).toHaveCount(1);
      await expect(rows("Agent settings").first()).toContainText("Slow");
      expect(state.writes).toEqual([]);
      await load("enrollment");
      await page
        .locator("summary")
        .filter({ hasText: /^Manage enrollment tokens/ })
        .click();
      // Inactive tokens are hidden until asked for.
      await expect(rows("Enrollment tokens")).toHaveCount(1);
      await page
        .getByLabel("Show expired, used and revoked tokens", { exact: true })
        .check();
      await filter("Status", "Revoked");
      await expect(rows("Enrollment tokens")).toHaveCount(1);
      await expect(rows("Enrollment tokens").first()).toContainText(
        "Revoked token",
      );
      await expect(
        rows("Enrollment tokens").getByRole("button", {
          name: "Revoke",
          exact: true,
        }),
      ).toHaveCount(0);
      expect(state.writes).toEqual([]);
    },
  );
  await check(
    "filtering deployment reviews never narrows confirmed target payloads",
    async () => {
      await load("target", {
        open: true,
        policy: {
          heartbeat_seconds: 60,
          sync_paused: true,
          telemetry_enabled: true,
        },
        initialDeviceIds: devices.slice(0, 3).map((d) => d.id),
      });
      await page
        .getByRole("button", { name: "Review deployment", exact: true })
        .click();
      await expect(rows("Deployment review devices")).toHaveCount(3);
      await textFilter("Device", "Device 0001");
      await expect(rows("Deployment review devices")).toHaveCount(1);
      await expect(
        page.getByText(
          "Filters only change this view. All 3 reviewed devices stay included.",
          { exact: true },
        ),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Apply settings", exact: true })
        .click();
      expect(state.writes.at(-1).body.expected_device_ids).toEqual(
        devices.slice(0, 3).map((d) => d.id),
      );
    },
  );
  await check(
    "filtering scheduled device reviews never narrows confirmed target payloads",
    async () => {
      await load("recovery", {
        deployment: { id: id(8000), status: "scheduled" },
      });
      await expect(rows("Scheduled device selection")).toHaveCount(3);
      await textFilter("Device", "Device 0002");
      await expect(rows("Scheduled device selection")).toHaveCount(1);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Update scheduled devices", exact: true })
        .click();
      expect(state.writes.at(-1).body.expected_device_ids).toEqual(
        devices.slice(0, 3).map((d) => d.id),
      );
    },
  );
  await check(
    "mobile table headers remain available and filtering inside review dialogs preserves focus and contrast",
    async () => {
      await load("devices");
      await page.setViewportSize({ width: 390, height: 844 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (t) => (document.documentElement.dataset.theme = t),
          theme,
        );
        await filter("Connection", "Online");
        await expect(table("Devices").locator("thead")).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(390);
        const audit = await new AxeBuilder({ page }).analyze();
        accessibility.push({
          theme,
          view: "devices",
          violations: audit.violations.map((v) => v.id),
        });
        expect(audit.violations).toEqual([]);
        await page.screenshot({
          path: resolve(output, `devices-mobile-${theme}.png`),
          animations: "disabled",
        });
      }
      await load("target", {
        open: true,
        policy: {
          heartbeat_seconds: 60,
          sync_paused: true,
          telemetry_enabled: true,
        },
        initialDeviceIds: [devices[0].id],
      });
      await page
        .getByRole("button", { name: "Review deployment", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Filter Device", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "Filter Device", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "Filter Device", exact: true }),
      ).toBeFocused();
      expect(state.writes).toEqual([]);
    },
  );
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  console.error(error);
  if (page && !page.isClosed())
    await page.screenshot({ path: resolve(output, "failure.png") });
} finally {
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Actual fleet/settings/review components with1000 synthetic devices and intercepted HTTP only; no real server, preview, or device changes.",
        passed: !failure,
        selected_test: process.env.VECTORY_FLEET_TABLES_ONLY || null,
        results,
        accessibility,
        requests,
        errors,
        ...(failure ? { failure: failure.message } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await server.close();
  console.log("Evidence: " + relative(root, resolve(output, "report.json")));
}
if (failure) throw failure;
