// Real Overview component, isolated synthetic HTTP transport. No preview state.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { configuredChannels } from "./notification-fixtures.mjs";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_OVERVIEW_OUTPUT || ".local/overview-component",
);
await mkdir(output, { recursive: true });
const uuid = (n) =>
  `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const user = {
  id: uuid(1),
  name: "Morgan Lee",
  email: "synthetic@example.test",
  role: "admin",
  enabled: true,
  revision: 1,
};
const now = Date.now();
const ago = (seconds) => new Date(now - seconds * 1000).toISOString();
const pipeline = uuid(40),
  version = uuid(41),
  rolloutId = uuid(50),
  scheduledId = uuid(51);
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
  desired_version_id: version,
  desired_generation: 2,
  reported_generation: 2,
  sync_paused: false,
  local_paused: false,
  pause_acknowledged: false,
  last_seen: ago(8),
  created_at: ago(86400),
  effective_policy: {
    heartbeat_seconds: 15,
    sync_paused: false,
    telemetry_enabled: true,
  },
  ...extra,
});
const devices = [
  device(2, "edge-fra-01", {
    telemetry: { sampled_at: ago(9), events_per_second: 120.5 },
  }),
  device(3, "edge-nyc-01", {
    telemetry: { sampled_at: ago(12), events_per_second: 80 },
  }),
  device(4, "web-ams-01", {
    telemetry: { sampled_at: ago(700), events_per_second: 999 },
  }),
  device(5, "edge-lon-01", {
    status: "failed",
    apply_state: "failed",
    reported_generation: 1,
  }),
  device(6, "edge-syd-01", { status: "offline", last_seen: ago(7200) }),
  device(7, "lab-01", {
    status: "unmanaged",
    apply_state: "unmanaged",
    desired_version_id: null,
    desired_generation: 0,
    reported_generation: 0,
  }),
  device(8, "retired-01", { status: "revoked" }),
];
const activity = (n, extra) => ({
  id: uuid(100 + n),
  actor_id: user.id,
  actor: user.name,
  actor_kind: "user",
  action: "configuration.create",
  target: pipeline,
  target_id: pipeline,
  target_kind: "configuration",
  target_name: "Orders",
  target_exists: true,
  device_id: null,
  outcome: "success",
  created_at: ago(60 * n),
  request_id: null,
  ...extra,
});
const fleetActivity = [
  activity(1, {
    action: "device.apply_state",
    actor_kind: "device",
    actor: "edge-fra-01",
    actor_id: uuid(2),
    target: uuid(2),
    target_id: uuid(2),
    target_kind: "device",
    target_name: "edge-fra-01",
    device_id: uuid(2),
    outcome: "verified_applied",
    repeat: 3,
    device_names: ["edge-fra-01", "edge-nyc-01", "web-ams-01"],
  }),
  activity(2, {
    action: "device.apply_state",
    actor_kind: "device",
    actor: "edge-lon-01",
    actor_id: uuid(5),
    target: uuid(5),
    target_id: uuid(5),
    target_kind: "device",
    target_name: "edge-lon-01",
    device_id: uuid(5),
    outcome: "failed",
    repeat: 1,
    device_names: ["edge-lon-01"],
  }),
  activity(3, {
    action: "deployment.create",
    target: rolloutId,
    target_id: rolloutId,
    target_kind: "deployment",
    target_name: null,
    deployment: {
      configuration_name: "Orders",
      version_number: 3,
      policy: false,
      rollout_kind: "canary",
      priority: 100,
      target_count: 7,
    },
  }),
  activity(4, {
    action: "configuration.publish",
    target: version,
    version_number: 3,
  }),
  activity(5, {
    action: "configuration.archive",
    target_name: "Deleted pipeline",
    target_exists: false,
  }),
  activity(6, {
    action: "device.revoke",
    target_kind: "device",
    target_id: "javascript:alert(1)",
    target_name: "Malformed device",
  }),
];
const overview = (extra = {}) => ({
  devices_total: devices.length,
  devices_online: 5,
  configurations_total: 2,
  deployments_active: 1,
  issues_open: 2,
  devices,
  recent_activity: [
    activity(20, { action: "login", outcome: "success", target_kind: "user" }),
  ],
  devices_managed: 5,
  devices_on_desired: 3,
  versions_total: 4,
  versions: {
    [version]: {
      number: 3,
      configuration_id: pipeline,
      configuration_name: "Orders",
    },
  },
  rollouts: [
    {
      id: rolloutId,
      name: null,
      configuration_id: pipeline,
      configuration_name: "Orders",
      version_id: version,
      version_number: 3,
      policy: false,
      status: "active",
      scheduled_at: null,
      created_at: ago(300),
      priority: 100,
      rollout_kind: "canary",
      canary_size: 1,
      batch_size: 2,
      target_count: 7,
      state_counts: {
        verified_applied: 3,
        written: 1,
        failed: 1,
        pending: 2,
      },
    },
    {
      id: scheduledId,
      name: null,
      configuration_id: null,
      configuration_name: null,
      version_id: null,
      version_number: null,
      policy: true,
      status: "scheduled",
      scheduled_at: new Date(now + 3 * 3600 * 1000).toISOString(),
      created_at: ago(600),
      priority: 50,
      rollout_kind: "all",
      canary_size: null,
      batch_size: null,
      target_count: 4,
      state_counts: {},
    },
  ],
  attention: [
    {
      cause: "failed",
      severity: "danger",
      count: 1,
      device_ids: [uuid(5)],
      device_names: ["edge-lon-01"],
      version_id: version,
      version_number: 3,
      configuration_id: pipeline,
      configuration_name: "Orders",
      state: "failed",
      since: null,
      reason: 'data_dir "/var/lib/vector/" does not exist',
    },
    {
      cause: "offline",
      severity: "warning",
      count: 1,
      device_ids: [uuid(6)],
      device_names: ["edge-syd-01"],
      version_id: null,
      version_number: null,
      configuration_id: null,
      configuration_name: null,
      state: null,
      since: ago(7200),
      reason: null,
    },
    {
      cause: "unmanaged",
      severity: "neutral",
      count: 1,
      device_ids: [uuid(7)],
      device_names: ["lab-01"],
      version_id: null,
      version_number: null,
      configuration_id: null,
      configuration_name: null,
      state: null,
      since: null,
      reason: null,
    },
  ],
  fleet_activity: fleetActivity,
  security_events_hidden: 4,
  ...extra,
});
const empty = () => ({
  devices_total: 0,
  devices_online: 0,
  configurations_total: 0,
  deployments_active: 0,
  issues_open: 0,
  devices: [],
  recent_activity: [],
  devices_managed: 0,
  devices_on_desired: 0,
  versions_total: 0,
  versions: {},
  rollouts: [],
  attention: [],
  fleet_activity: [],
  security_events_hidden: 1,
});
const series = Array.from({ length: 30 }, (_, index) => ({
  bucket: index,
  at: new Date(now - (29 - index) * 60000).toISOString(),
  devices_reporting: 2,
  events_in_per_second: 180 + (index % 5) * 6,
  events_out_per_second: index === 12 ? null : 170 + (index % 4) * 5,
  errors_per_minute: 0,
  dropped_per_minute: 0,
  buffer_utilization_max: 0.1,
}));
const summary = {
  generated_at: new Date(now).toISOString(),
  range: "1h",
  step_seconds: 60,
  from: series[0].at,
  devices_total: 6,
  devices_reporting: 2,
  devices_metrics_disabled: 1,
  devices_without_metrics_endpoint: 0,
  fresh_seconds: 180,
  newest_sample_at: ago(9),
  events_in_per_second: 200.5,
  events_out_per_second: 190.25,
  bytes_in_per_second: null,
  bytes_out_per_second: null,
  errors_per_minute: 1.5,
  filtered_per_minute: 0,
  dropped_per_minute: 0,
  buffer_utilization_max: 0.1,
  coverage: {},
  series,
};

const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const virtual = "\0virtual:overview-fixture";
const server = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "overview-component-fixture",
      resolveId(id) {
        if (id === "virtual:overview-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import{Overview}from'/src/Fleet.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement('main',{className:'page-content'},React.createElement(Overview,{user:${JSON.stringify(user)},navigate:path=>{window.location.hash='/'+path}})));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__overview") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Overview verification</title></head><body><div id="root"></div><script type="module">import "virtual:overview-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const results = [],
  errors = [],
  unexpected = [],
  requests = [],
  accessibility = [];
let state;
async function open(options = {}) {
  state = {
    overview: overview(),
    summary: null,
    releases: [],
    // Deployment history by status, for stopped and rolled-back rollouts.
    history: {},
    ...options,
  };
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.replace("/api/v1", "");
    requests.push({ method: req.method(), path: path + url.search });
    if (req.method() === "GET" && path === "/overview")
      return route.fulfill({ json: state.overview });
    // An administrator's Overview asks whether a notification channel exists.
    if (req.method() === "GET" && path === "/notifications/channels")
      return route.fulfill({ json: configuredChannels });
    if (req.method() === "GET" && path === "/telemetry/summary")
      return state.summary
        ? route.fulfill({ json: state.summary })
        : route.fulfill({
            status: 404,
            json: { error: { code: "NOT_FOUND", message: "Not found" } },
          });
    if (req.method() === "GET" && path === "/releases")
      return route.fulfill({ json: state.releases });
    if (req.method() === "GET" && path === "/deployments/history") {
      const items = state.history[url.searchParams.get("status")] || [];
      return route.fulfill({
        json: { items, total: items.length, page: 1, page_size: 5 },
      });
    }
    unexpected.push(`${req.method()} ${path}`);
    return route.fulfill({
      status: 500,
      json: {
        error: { code: "UNEXPECTED", message: "Unexpected fixture request" },
      },
    });
  });
  await page.goto(`${origin}/__overview`);
  return { context, page };
}
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
  console.log("PASS", name);
}
let failure;
try {
  await check(
    "KPI tiles and the health strip count live devices honestly and link to filtered lists",
    async () => {
      const { context, page } = await open();
      const tiles = page.locator(".overview-kpi-tile");
      await expect(tiles).toHaveCount(4);
      // Six live devices; the revoked identity is left out everywhere.
      await expect(tiles.nth(0)).toContainText("Devices online");
      await expect(tiles.nth(0).locator(".overview-kpi-value")).toHaveText(
        "5 / 6",
      );
      await expect(tiles.nth(0)).toContainText("1 offline");
      await expect(tiles.nth(1).locator(".overview-kpi-value")).toHaveText(
        "3 / 5",
      );
      await expect(tiles.nth(1)).toContainText("2 not yet verified");
      await expect(tiles.nth(1)).toContainText("1 without a pipeline");
      await expect(tiles.nth(1)).toHaveAttribute(
        "href",
        "#/devices?view=drift",
      );
      await expect(tiles.nth(2).locator(".overview-kpi-value")).toHaveText("1");
      await expect(tiles.nth(2)).toContainText("1 scheduled in the next 24h");
      await expect(tiles.nth(3).locator(".overview-kpi-value")).toHaveText("2");
      await expect(tiles.nth(3).locator(".overview-kpi-value")).toHaveAttribute(
        "data-tone",
        "danger",
      );
      const legend = page.getByRole("list", { name: "Devices by state" });
      await expect(
        legend.getByRole("link", { name: /Applied\s*3/ }),
      ).toHaveAttribute("href", "#/devices?status=applied");
      await expect(
        legend.getByRole("link", { name: /Failed\s*1/ }),
      ).toHaveAttribute("href", "#/devices?status=failed");
      await expect(page.locator(".overview-health-bar")).toHaveAttribute(
        "aria-label",
        /6 devices: 3 applied, 1 failed, 1 offline, 1 no pipeline/,
      );
      await context.close();
    },
  );
  await check(
    "Needs you groups problems by cause with the reported reason and typed next steps",
    async () => {
      const { context, page } = await open();
      const items = page.locator(".overview-attention-item");
      await expect(items).toHaveCount(3);
      await expect(items.nth(0)).toContainText("Orders v3 failed on 1 device");
      await expect(
        items.nth(0).locator(".overview-attention-reason"),
      ).toHaveText('data_dir "/var/lib/vector/" does not exist');
      await expect(
        items.nth(0).getByRole("link", { name: "Review devices" }),
      ).toHaveAttribute("href", `#/devices?status=failed&version=${version}`);
      await expect(
        items.nth(0).getByRole("link", { name: "Open pipeline" }),
      ).toHaveAttribute("href", `#/configurations/${pipeline}`);
      await expect(items.nth(1)).toContainText("1 device offline");
      await expect(items.nth(1)).toContainText(
        "Longest without a check-in: 2h",
      );
      await expect(
        items.nth(2).getByRole("link", { name: "Deploy a pipeline" }),
      ).toHaveAttribute("href", "#/configurations");
      await context.close();
    },
  );
  await check(
    "Rollouts show stacked progress, scheduled starts and deployment links",
    async () => {
      const { context, page } = await open();
      const rollouts = page.locator(".overview-rollout-item");
      await expect(rollouts).toHaveCount(2);
      await expect(rollouts.nth(0)).toHaveAttribute(
        "href",
        `#/deployments/${rolloutId}`,
      );
      await expect(rollouts.nth(0)).toContainText("Orders v3");
      await expect(rollouts.nth(0)).toContainText("Canary");
      await expect(
        rollouts.nth(0).locator(".overview-rollout-meta"),
      ).toHaveText("3 of 7 devices applied · 1 failed");
      await expect(
        rollouts.nth(0).locator(".overview-rollout-bar"),
      ).toHaveAttribute(
        "aria-label",
        "7 devices: 3 applied, 1 applying, 1 failed, 2 waiting",
      );
      await expect(rollouts.nth(1)).toContainText("Agent settings");
      await expect(
        rollouts.nth(1).locator(".overview-rollout-meta"),
      ).toContainText(/Starts in (2h 5\dm|3h)/);
      await context.close();
    },
  );
  await check(
    "A rollout that stopped stays in Needs you with a way into it",
    async () => {
      const stoppedId = uuid(77);
      const { context, page } = await open({
        history: {
          failed: [
            {
              id: stoppedId,
              name: null,
              version_id: uuid(78),
              policy: null,
              scheduled_at: null,
              configuration_id: pipeline,
              configuration_name: "Orders",
              version_number: 4,
              status: "failed",
              failure_reason: "threshold",
              failed_at: new Date(Date.now() - 120000).toISOString(),
              created_at: new Date(Date.now() - 180000).toISOString(),
              target_count: 3,
              verified_count: 0,
              state_counts: { rolled_back: 1, pending: 2 },
              priority: 100,
              target_mode: "snapshot",
              rollout: {
                kind: "canary",
                canary_size: 1,
                batch_size: 1,
                observation_seconds: 60,
                failure_threshold: 0,
              },
            },
          ],
        },
      });
      const item = page
        .locator(".needs-you .overview-attention-item")
        .filter({ hasText: "Orders v4 stopped after a failure" });
      await expect(item).toContainText("1 failed · 2 not released");
      await expect(
        item.getByRole("link", { name: "Open rollout", exact: true }),
      ).toHaveAttribute("href", `#/deployments/${stoppedId}`);
      await expect(page.locator(".overview-kpis")).toContainText("1 stopped");
      // The card never claims nothing is failing above a stopped rollout.
      await expect(page.locator(".needs-you")).toContainText(
        "1 rollout stopped",
      );
      await expect(page.locator(".needs-you")).not.toContainText(
        "Nothing is failing",
      );
      await context.close();
    },
  );
  await check(
    "Recent changes read as sentences, link only typed identities and keep sign-ins out",
    async () => {
      const { context, page } = await open();
      const rows = page.locator(".overview-activity-item");
      await expect(rows).toHaveCount(6);
      await expect(rows.nth(0)).toContainText(
        "edge-fra-01, edge-nyc-01 and 1 more applied their pipeline",
      );
      await expect(rows.nth(0).locator(".activity-glyph")).toHaveAttribute(
        "data-tone",
        "success",
      );
      await expect(rows.nth(1).locator(".activity-glyph")).toHaveAttribute(
        "data-tone",
        "danger",
      );
      await expect(
        rows.nth(1).getByRole("link", { name: "edge-lon-01" }),
      ).toHaveAttribute("href", `#/devices/${uuid(5)}`);
      await expect(rows.nth(2)).toContainText(
        "Morgan Lee deployed Orders v3 to 7 devices as a canary",
      );
      await expect(
        rows.nth(2).getByRole("link", { name: "Orders v3" }),
      ).toHaveAttribute("href", `#/deployments/${rolloutId}`);
      await expect(
        rows.nth(3).getByRole("link", { name: "Orders v3" }),
      ).toHaveAttribute("href", `#/configurations/${pipeline}`);
      // Deleted and malformed identities stay plain text.
      await expect(
        rows.nth(4).locator(".overview-activity-text a"),
      ).toHaveCount(0);
      await expect(
        rows.nth(5).locator(".overview-activity-text a"),
      ).toHaveCount(0);
      await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
      await expect(
        rows.nth(0).locator("a.overview-activity-time"),
      ).toHaveAttribute("href", `#/audit/${uuid(101)}?page=1`);
      await expect(page.locator(".recent-changes")).not.toContainText(
        "Signed in",
      );
      const security = page.getByRole("link", { name: "Security activity" });
      await expect(security).toHaveAttribute("href", "#/audit?scope=security");
      await expect(page.locator(".overview-activity-footer")).toContainText(
        "4 recent",
      );
      // Entity links are quiet until hover or focus.
      const link = rows.nth(2).getByRole("link", { name: "Orders v3" });
      expect(
        await link.evaluate(
          (node) => getComputedStyle(node).textDecorationLine,
        ),
      ).toBe("none");
      await link.hover();
      expect(
        await link.evaluate(
          (node) => getComputedStyle(node).textDecorationLine,
        ),
      ).toBe("underline");
      await context.close();
    },
  );
  await check(
    "Throughput uses fresh device samples, never zeros, and says how to enable metrics",
    async () => {
      let { context, page } = await open();
      const card = page.locator(".throughput");
      await expect(card).toContainText("2 of 6 devices reporting");
      // Only fresh samples count: 120.5 + 80, not the stale 999.
      await expect(
        card.locator(".overview-throughput-stats dd").first(),
      ).toHaveText("201/s");
      await expect(card.locator(".overview-throughput-stats")).toContainText(
        "Not reported",
      );
      await expect(card.locator(".overview-busiest li")).toHaveCount(2);
      await expect(card.locator(".overview-busiest li").first()).toContainText(
        "edge-fra-01",
      );
      await expect(card.locator(".overview-chart-legend")).toHaveCount(0);
      await context.close();
      const silent = devices.map(({ telemetry, ...rest }) => rest);
      silent[1].effective_policy = {
        ...silent[1].effective_policy,
        telemetry_enabled: false,
      };
      ({ context, page } = await open({
        overview: overview({ devices: silent }),
      }));
      const howTo = page.locator(".overview-throughput-howto");
      await expect(howTo).toContainText("No device is reporting metrics");
      await expect(howTo).toContainText(
        "1 device has metrics turned off in Agent settings.",
      );
      await expect(howTo).toContainText("internal_metrics");
      await expect(
        howTo.getByRole("link", { name: /Enable metrics step by step/ }),
      ).toHaveAttribute("href", "/help/telemetry/#enable-real-metrics");
      await expect(page.locator(".overview-throughput-stats")).toHaveCount(0);
      await context.close();
    },
  );
  await check(
    "The fleet summary drives a two-series chart with a legend and a keyboard readout",
    async () => {
      const { context, page } = await open({ summary });
      const card = page.locator(".throughput");
      await expect(card.locator(".fleet-chart-line")).toHaveCount(2);
      await expect(card.getByRole("list", { name: "Series" })).toContainText(
        "Events in",
      );
      await expect(card.getByRole("list", { name: "Series" })).toContainText(
        "Events out",
      );
      await expect(card.locator(".overview-throughput-stats")).toContainText(
        "201/s",
      );
      await expect(card.locator(".overview-throughput-stats")).toContainText(
        "190/s",
      );
      await expect(card.locator(".overview-throughput-stats")).toContainText(
        "1.5/min",
      );
      // A missing point breaks the line instead of dropping to zero.
      const out = await card
        .locator('.fleet-chart-line[data-series="2"]')
        .getAttribute("d");
      expect(out.match(/M/g)).toHaveLength(2);
      const frame = card.getByRole("group", { name: /Fleet throughput/ });
      await frame.focus();
      await page.keyboard.press("End");
      // The newest bucket (204/s) is still collecting devices' samples, so
      // the line ends at the last complete one instead of dipping.
      await expect(card.locator('[aria-live="polite"]')).toContainText(
        "in 198/s",
      );
      await page.keyboard.press("ArrowLeft");
      await expect(card.locator(".fleet-chart-tooltip")).toBeVisible();
      await context.close();
    },
  );
  await check(
    "The first-run checklist follows real state and disappears when setup is complete",
    async () => {
      let { context, page } = await open({ overview: empty(), releases: [] });
      const list = page.locator(".overview-checklist");
      await expect(list).toContainText("0 of 5 done");
      await expect(list.locator('li[data-state="current"]')).toContainText(
        "Make agent downloads available",
      );
      await expect(
        list.getByRole("link", { name: /How to add releases/ }),
      ).toHaveAttribute("href", "/help/administer/#start-a-new-server");
      await expect(
        page.getByRole("button", { name: "Add device", exact: true }),
      ).toHaveCount(1);
      await expect(page.locator(".page-actions")).toHaveCount(0);
      await context.close();
      ({ context, page } = await open({
        overview: empty(),
        releases: [
          {
            name: "vectory-linux-amd64",
            os: "linux",
            arch: "amd64",
            sha256: "a".repeat(64),
            url: "/api/v1/releases/vectory-linux-amd64",
            signed: true,
          },
        ],
      }));
      await expect(page.locator(".overview-checklist")).toContainText(
        "1 of 5 done",
      );
      await expect(
        page.locator('.overview-checklist li[data-state="current"]'),
      ).toContainText("Connect your first device");
      await context.close();
      ({ context, page } = await open());
      await expect(page.locator(".overview-kpis")).toBeVisible();
      await expect(page.locator(".overview-checklist")).toHaveCount(0);
      await context.close();
    },
  );
  await check(
    "Desktop and mobile Overview stay readable and accessible in both themes",
    async () => {
      const { context, page } = await open();
      for (const width of [1280, 390]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        for (const theme of ["light", "dark"]) {
          await page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
          }, theme);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          const axe = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
          const violations = axe.violations.map((item) => ({
            id: item.id,
            impact: item.impact,
            targets: item.nodes.map((node) => node.target),
          }));
          accessibility.push({ width, theme, violations });
          expect(violations).toEqual([]);
          await page.screenshot({
            path: resolve(
              output,
              `overview-${width === 390 ? "mobile" : "desktop"}-${theme}.png`,
            ),
            fullPage: true,
            animations: "disabled",
          });
        }
      }
      await context.close();
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Actual Overview component with isolated synthetic transport. Server aggregates are fixtures; no backend, preview state or real fleet is used.",
        passed: !failure,
        results,
        accessibility,
        requests,
        errors,
        unexpected,
        ...(failure ? { failure: failure.message } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await server.close();
  console.log(
    `Evidence: ${relative(repository, resolve(output, "report.json"))}`,
  );
}
if (failure) throw failure;
