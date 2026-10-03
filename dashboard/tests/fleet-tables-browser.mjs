// Actual fleet/settings/review components; all HTTP is intercepted synthetic data.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { createHash } from "node:crypto";
import { fleetReplies, fulfillFleetRead } from "./fleet-replies.mjs";
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
async function load(name, props = {}, seed = {}) {
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
    refreshProposed: 3,
    refreshBlockers: [],
    history: [],
    ...seed,
  };
  const replies = fleetReplies({ devices, groups: () => state.groups });
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) throw Error("External request blocked");
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = req.method();
    requests.push({ path, method, search: url.search });
    const reply = (json) => route.fulfill({ json });
    if (method === "GET") {
      if (state.failDevices && path === "/devices/inventory")
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "FIXTURE_FAILURE",
              message: "Synthetic device inventory unavailable",
            },
          },
        });
      if (await fulfillFleetRead(replies, route)) return;
      // Add device still lists the fleet once to know which devices are new.
      if (path === "/devices") return reply(devices);
      if (path === "/groups") return reply(state.groups);
      if (path === "/policies") return reply(policies);
      if (path === "/tokens") return reply(tokens);
      if (path === "/releases") return reply([]);
      if (path === "/agent-install")
        return reply({
          agent_url: null,
          agent_url_configured: false,
          listener_enabled: false,
          dashboard_url: null,
          certificate: null,
          downloads_enabled: true,
          installer: null,
          default_install_dir: "/usr/local/bin",
          releases: [],
          catalog_problems: [],
        });
      if (
        /^\/groups\/requests\//.test(path) ||
        /^\/deployments\/requests\//.test(path)
      )
        return reply({ request_id: path.split("/").at(-1), found: false });
    }
    const body = req.postDataJSON();
    if (path === "/deployments/preview") {
      state.previews.push(body);
      const selected = devices.filter((d) =>
        body.selector.device_ids.includes(d.id),
      );
      return reply({
        devices: selected,
        warnings: [],
        conflicts: [],
        create_idempotency: true,
        request_correlation: true,
        ...(body.variable_bindings
          ? {
              artifact_previews: selected.map((device) => ({
                device_id: device.id,
                sha256: createHash("sha256")
                  .update(
                    JSON.stringify({
                      device_id: device.id,
                      bindings: body.variable_bindings,
                    }),
                  )
                  .digest("hex"),
                size: 128,
              })),
            }
          : {}),
      });
    }
    if (path.endsWith("/refresh-preview"))
      return reply({
        refresh_review: true,
        source_deployment_id: id(8000),
        source_status: "scheduled",
        resource: "configuration",
        scheduled_at: "2026-10-01T12:00:00Z",
        ready: state.refreshBlockers.length === 0,
        review_token: "b".repeat(64),
        saved_devices: devices
          .slice(0, 1)
          .map(({ id, name, status }) => ({ id, name, status })),
        devices: devices
          .slice(0, state.refreshProposed)
          .map(({ id, name, status }) => ({ id, name, status })),
        warnings: [],
        blockers: state.refreshBlockers,
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
      if (path === "/deployments")
        return reply({
          ...body,
          id: id(8001),
          operation: "create",
          source_deployment_id: null,
          request_correlation: true,
          status: "active",
          created_at: "2026-09-27T12:00:00Z",
          targets: body.expected_device_ids.map((device_id) => ({
            device_id,
            state: "pending",
            generation: 0,
          })),
        });
      expect(body.review_token).toBe("b".repeat(64));
      return reply({
        id: id(8000),
        version_id: id(3000),
        policy: null,
        selector: {
          device_ids: body.expected_device_ids,
          group_ids: [],
          exclude_ids: [],
        },
        priority: 0,
        target_mode: "snapshot",
        status: "scheduled",
        scheduled_at: "2026-10-01T12:00:00Z",
        created_at: "2026-09-27T12:00:00Z",
        rollout: {
          kind: "all",
          canary_size: 1,
          batch_size: 1,
          observation_seconds: 0,
          failure_threshold: 0,
        },
        targets: body.expected_device_ids.map((device_id) => ({
          device_id,
          state: "pending",
          generation: 0,
          error: null,
        })),
      });
    }
    if (method === "POST" && path === "/deployments/binding-suggestions")
      return route.fulfill({ json: { devices: {}, sources: {} } });
    // Agent settings also lists settings that were applied without saving.
    if (method === "GET" && path === "/deployments/history")
      return route.fulfill({
        json: {
          items: state.history,
          total: state.history.length,
          page: 1,
          page_size: 50,
        },
      });
    // Add device lists the last day's enrollment attempts.
    if (method === "GET" && path === "/agent-install/activity")
      return route.fulfill({
        json: { events: [], now: "2026-09-27T12:00:00Z" },
      });
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
  // Options may carry a match count after the label ("Revoked 1").
  await page
    .getByRole("radio", { name: new RegExp(`^${value}(?: [\\d,]+)?$`) })
    .click();
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
/**
 * A page of devices in a picker scrolls inside its own box: the box is no
 * taller than 22rem, its rows are clipped by it, and the pager and buttons
 * under it are never covered by them.
 */
async function pickerScrollsInsideItsBox() {
  const box = await page.evaluate(() => {
    const scroller = document.querySelector(
      ".device-picker .data-table-scroll",
    );
    const rect = scroller.getBoundingClientRect();
    const below = [".data-table-pagination", ".device-picker-actions"].map(
      (selector) => {
        const element = document.querySelector(`.device-picker ${selector}`);
        return element ? element.getBoundingClientRect().top : Infinity;
      },
    );
    return {
      overflowY: getComputedStyle(scroller).overflowY,
      height: rect.height,
      scrolls: scroller.scrollHeight > scroller.clientHeight,
      bottom: rect.bottom,
      nextTop: Math.min(...below),
    };
  });
  expect(["auto", "scroll"]).toContain(box.overflowY);
  expect(box.height).toBeLessThanOrEqual(22 * 16 + 2);
  expect(box.scrolls).toBe(true);
  expect(box.bottom).toBeLessThanOrEqual(box.nextTop + 1);
}
async function check(name, run) {
  if (
    process.env.VECTORY_FLEET_TABLES_ONLY &&
    !name.includes(process.env.VECTORY_FLEET_TABLES_ONLY)
  )
    return;
  await run();
  results.push({ name, passed: true });
  console.log("PASS", name);
}
let failure;
try {
  await check(
    "1000 devices: the server pages, filters and sorts them; the URL keeps the view and selection survives sorting and pages",
    async () => {
      const first = requests.length;
      await load("devices");
      // The server hides the revoked device unless asked, so the first page is
      // 25 live devices and the fleet is 999.
      await expect(rows("Devices")).toHaveCount(25);
      await expect(
        page.getByText("999 devices", { exact: true }),
      ).toBeVisible();
      await page.getByLabel("Select visible devices", { exact: true }).check();
      await expect(
        page.getByText("25 selected", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(rows("Devices").first()).toContainText("Device 0026");
      await page.getByLabel("Select Device 0026", { exact: true }).check();
      await sort("Device");
      await expect(rows("Devices").first()).toContainText("Device 0999");
      await expect(
        page.getByText("26 selected", { exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).hash).toContain("dir=desc");
      // The page asked for one page at a time, never the whole list.
      expect(
        requests.slice(first).filter((r) => r.path === "/devices").length,
        "the Devices page never lists every device",
      ).toBe(0);
      expect(
        requests
          .slice(first)
          .filter((r) => r.path === "/devices/inventory")
          .every((r) => /page_size=25/.test(r.search)),
        "each read asks for one page",
      ).toBe(true);
      await filter("Status", "Revoked");
      await expect(rows("Devices")).toHaveCount(1);
      await expect(
        page.getByLabel("Select Device 0020", { exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Remove filter Status Revoked" }),
      ).toBeVisible();
      await filter("Status", "Applied");
      await page
        .getByRole("textbox", { name: "Search devices", exact: true })
        .fill("nothing-matches");
      await expect(
        page.getByRole("heading", { name: "No matching devices" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Filter Status (active)",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Clear filters", exact: true })
        .click();
      await expect(rows("Devices")).toHaveCount(25);
      // Quick views narrow the list and show their counts.
      const offline = page.getByRole("button", { name: /^Offline\s*500$/ });
      await offline.click();
      await expect(offline).toHaveAttribute("aria-pressed", "true");
      await expect(rows("Devices").first()).toContainText("Offline");
      await offline.click();
      // Time columns sort newest first on the first click.
      await sort("Last seen");
      await expect(rows("Devices").first()).toContainText("Device 0998");
      // Page size is a URL-synced choice.
      await page.getByLabel("Rows per page").selectOption("50");
      await expect(rows("Devices")).toHaveCount(50);
      expect(new URL(page.url()).hash).toContain("size=50");
      state.failDevices = true;
      await page
        .getByRole("button", { name: "Refresh now", exact: true })
        .click();
      // A failed refresh keeps the last list visible but not actionable.
      await expect(
        page.getByText("Couldn't refresh devices.", { exact: true }),
      ).toBeVisible();
      await expect(rows("Devices").first()).toContainText("Device 0998");
      await expect(
        page.getByLabel("Select visible devices", { exact: true }),
      ).toBeDisabled();
      state.failDevices = false;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(
        page.getByText("Couldn't refresh devices.", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByLabel("Select visible devices", { exact: true }),
      ).toBeEnabled();
      expect(state.writes).toEqual([]);
    },
  );
  await check(
    "groups sort numerically and a newly saved group remains discoverable after header filtering",
    async () => {
      await load("groups");
      await expect(rows("Groups")).toHaveCount(25);
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
    "deployment picker pages through the fleet on the server, keeps picks across pages and searches, and selects everything a search finds",
    async () => {
      const first = requests.length;
      await load("target", {
        open: true,
        policy: {
          heartbeat_seconds: 60,
          sync_paused: false,
          telemetry_enabled: true,
        },
      });
      await expect(rows("Devices")).toHaveCount(25);
      await expect(
        page.getByText("1–25 of 999", { exact: true }),
      ).toBeVisible();
      await pickerScrollsInsideItsBox();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(rows("Devices").first()).toContainText("Device 0026");
      await page.getByLabel("Select Device 0030", { exact: true }).check();
      await page.getByLabel("Find targets").fill("Device 0999");
      await page.getByLabel("Select Device 0999", { exact: true }).check();
      await page.getByLabel("Find targets").fill("");
      await expect(
        page.getByText("1–25 of 999", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("2 devices selected")).toBeVisible();
      // Everything a search finds is chosen in one step and says so.
      await page.getByLabel("Find targets").fill("Device 010");
      await expect(rows("Devices")).toHaveCount(10);
      await page
        .getByRole("button", { name: "Select all 10 matching", exact: true })
        .click();
      await expect(page.getByText("12 devices selected")).toBeVisible();
      await expect(
        page.getByText("Selected all 10 matching devices.", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Review deployment" }).click();
      expect(state.previews.at(-1).selector.device_ids).toEqual([
        devices[30].id,
        devices[999].id,
        ...devices.slice(100, 110).map((device) => device.id),
      ]);
      expect(state.writes).toEqual([]);
      // Only pages were read: no request carried the fleet.
      expect(
        requests.slice(first).filter((r) => r.path === "/devices").length,
      ).toBe(0);
      expect(
        requests
          .slice(first)
          .filter((r) => r.path === "/devices/inventory")
          .every((r) => /page_size=25/.test(r.search)),
      ).toBe(true);
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
            transforms: {
              sample: { type: "sample", inputs: ["input"], rate: 10 },
            },
            sinks: { discard: { type: "blackhole", inputs: ["sample"] } },
          },
          variables: [
            {
              name: "SAMPLE_RATE",
              path: "/transforms/sample/rate",
              type: "integer",
            },
          ],
        },
        initialDeviceIds: [devices[0].id, devices[1].id],
      });
      // No red error before anyone tries; trying names what's missing.
      await expect(page.getByText(/needs a value/)).toHaveCount(0);
      const previews = state.previews.length;
      await page.getByRole("button", { name: "Review deployment" }).click();
      await expect(
        page.getByText("SAMPLE_RATE needs a value for 2 selected devices."),
      ).toBeVisible();
      expect(state.previews.length).toBe(previews);
      await page.getByLabel("Set default for selected devices").check();
      await page.getByLabel("Default for SAMPLE_RATE").fill("10");
      // Every selected device has its own cell; an empty one uses the default.
      await expect(
        page.getByLabel("SAMPLE_RATE for Device 0000", { exact: true }),
      ).toHaveAttribute("placeholder", "Default: 10");
      await page
        .getByLabel("SAMPLE_RATE for Device 0001", { exact: true })
        .fill("20");
      await page.getByRole("button", { name: "Review deployment" }).click();
      const reviewed = state.previews.at(-1);
      expect(reviewed.variable_bindings).toEqual({
        defaults: { SAMPLE_RATE: 10 },
        devices: { [devices[1].id]: { SAMPLE_RATE: 20 } },
      });
      await expect(rows("Deployment review devices")).toHaveCount(2);
      await expect(rows("Deployment review devices").nth(1)).toContainText(
        "Override",
      );
      await expect(rows("Deployment review devices").nth(1)).toContainText(
        "Rendered SHA-256",
      );
      await page.getByRole("button", { name: "Deploy to devices" }).click();
      await expect.poll(() => state.writes.length).toBe(1);
      expect(state.writes.at(-1).body.variable_bindings).toEqual(
        reviewed.variable_bindings,
      );
      expect(state.writes.at(-1).body.expected_device_ids).toEqual([
        devices[0].id,
        devices[1].id,
      ]);
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
    "agent settings applied without saving list every deployment that applies the same values",
    async () => {
      const applied = (n, count, policy, by) => ({
        id: id(9000 + n),
        name: null,
        version_id: null,
        policy,
        policy_id: null,
        status: "completed",
        target_count: count,
        verified_count: count,
        state_counts: { verified_applied: count },
        created_by_name: by,
        created_at: `2026-09-${20 + n}T10:15:00Z`,
      });
      const fast = {
        heartbeat_seconds: 15,
        sync_paused: false,
        telemetry_enabled: true,
      };
      // Three devices run the fast values through two deployments; a third
      // deployment applies other values.
      const history = [
        applied(3, 1, fast, "Demo operator"),
        applied(
          2,
          4,
          {
            heartbeat_seconds: 300,
            sync_paused: true,
            telemetry_enabled: false,
          },
          "Demo operator",
        ),
        applied(1, 2, fast, "Demo operator"),
      ];
      for (const width of [1280, 390])
        for (const theme of ["light", "dark"]) {
          await load("policies", {}, { history });
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(
            (t) => (document.documentElement.dataset.theme = t),
            theme,
          );
          const card = page.getByRole("region", {
            name: "Applied without saving",
            exact: true,
          });
          await expect(card.getByRole("listitem")).toHaveCount(2);
          const fastEntry = card.getByRole("listitem").first();
          await expect(fastEntry).toContainText("Check-ins every 15 s");
          await expect(
            fastEntry.getByRole("link", { name: "Applied to 1 device" }),
          ).toHaveAttribute("href", `#/deployments/${id(9003)}?page=1`);
          await expect(
            fastEntry.getByRole("link", { name: "Applied to 2 devices" }),
          ).toHaveAttribute("href", `#/deployments/${id(9001)}?page=1`);
          await expect(
            fastEntry.getByRole("button", { name: "Save as settings…" }),
          ).toHaveCount(1);
          await expect(card.getByRole("listitem").nth(1)).toContainText(
            "Applied to 4 devices",
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          const audit = await new AxeBuilder({ page }).analyze();
          accessibility.push({
            theme,
            view: `unsaved-settings-${width}`,
            violations: audit.violations.map((v) => v.id),
          });
          expect(audit.violations).toEqual([]);
          await page.screenshot({
            path: resolve(
              output,
              `agent-settings-unsaved-${width}-${theme}.png`,
            ),
            animations: "disabled",
          });
        }
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
    "a scheduled device review names the devices a blocker affects, as many as fit, and offers no update",
    async () => {
      await load("recovery", {
        deployment: { id: id(8000), status: "scheduled" },
      });
      await expect(rows("Scheduled device selection")).toHaveCount(3);
      state.refreshProposed = 30;
      state.refreshBlockers = [
        {
          code: "FULL_VECTOR_MODE_REQUIRED",
          reason:
            "This published configuration requires full Vector mode on the selected device. Only its host operator can enable that mode locally.",
          resource: "configuration",
          device_ids: devices.slice(0, 30).map((d) => d.id),
        },
      ];
      await page
        .getByRole("button", { name: "Refresh review", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("Selection cannot be updated");
      await expect(dialog).toContainText(
        "30 affected devices: Device 0000, Device 0001,",
      );
      await expect(dialog).toContainText("Device 0024, and 5 more.");
      await expect(dialog).not.toContainText("Device 0025");
      await expect(dialog).not.toContainText("does not match this dashboard");
      await expect(
        dialog.getByRole("button", {
          name: "Update scheduled devices",
          exact: true,
        }),
      ).toBeDisabled();
      expect(state.writes).toEqual([]);
    },
  );
  await check(
    "a status badge carries its meaning as an accessible description and a hover tooltip, not a title",
    async () => {
      await load("devices");
      const badge = rows("Devices").first().locator(".status-badge");
      const meaning = await badge.getAttribute("aria-description");
      expect(meaning, "the badge describes its state").toBeTruthy();
      await expect(badge).toHaveAccessibleDescription(meaning);
      expect(await badge.getAttribute("title")).toBeNull();
      await badge.hover();
      await expect(page.getByRole("tooltip")).toHaveText(meaning);
      await page.mouse.move(1, 1);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
    },
  );
  await check(
    "mobile devices render as a stacked list with quick filters and filtering inside review dialogs preserves focus and contrast",
    async () => {
      await load("devices");
      await page.setViewportSize({ width: 390, height: 844 });
      const list = page.getByRole("list", { name: "Devices", exact: true });
      await expect(list).toBeVisible();
      await expect(table("Devices")).toHaveCount(0);
      await page.getByRole("button", { name: /^Offline\s*500$/ }).click();
      await expect(list.locator(".data-list-item").first()).toContainText(
        "Offline",
      );
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (t) => (document.documentElement.dataset.theme = t),
          theme,
        );
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
