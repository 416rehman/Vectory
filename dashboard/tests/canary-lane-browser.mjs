// The canary rollout page and the deploy review, in the real App and dialog.
// All HTTP is intercepted synthetic data; nothing here reaches a device.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_CANARY_LANE_OUTPUT || ".local/canary-lane",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:canary-lane";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "canary-lane",
      resolveId(id) {
        if (id === "virtual:canary-lane") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import TargetDialog from'/src/TargetDialog.tsx';import{setCSRF}from'/src/api.ts';import{applyTheme}from'/src/appearance.ts';import'/src/styles.css';setCSRF('synthetic-csrf');const root=createRoot(document.getElementById('root'));let key=0;window.mount=(name,props={})=>{applyTheme(localStorage.getItem('vectory-theme')==='dark'?'dark':'light');window.notices=[];root.render(name==='app'?React.createElement(App,{key:++key}):React.createElement(TargetDialog,{key:++key,onDone:x=>window.notices.push(x),onClose:()=>{window.closed=true},...props}));};window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__canary-lane") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic canary lane</title></head><body><div id="root"></div><script type="module">import "virtual:canary-lane";</script></body></html>',
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
const minutes = (n) => new Date(Date.now() + n * 60000).toISOString();
const user = (role) => ({
  id: id(99),
  name: role === "admin" ? "Synthetic administrator" : "Synthetic " + role,
  email: "synthetic@example.test",
  role,
  enabled: true,
  revision: 1,
});
const none = {
  superseded: 0,
  stale: 0,
  paused: 0,
  unverified: 0,
  unavailable: 0,
  measuring: 0,
  degraded: 0,
};
const reading = (events = 5.2, out = 5.1) => ({
  sampled_at: minutes(0),
  events_in_per_second: events,
  events_out_per_second: out,
  errors_per_minute: 0,
  buffer_utilization: 0.02,
});
const watchDevice = (n, name, changes = {}) => ({
  device_id: id(n),
  device_name: name,
  released_at: minutes(-12),
  gate_reason: "measuring",
  now: reading(),
  baseline: {
    minutes: 10,
    events_in_per_second: 5.5,
    events_out_per_second: 5.4,
    errors_per_minute: 0,
    buffer_utilization: 0.01,
  },
  samples: { measured: 2, needed: 3 },
  ...changes,
});
const laneDevice = (n, name, state) => ({
  device_id: id(n),
  device_name: name,
  state,
});
// One canary applied and being measured; two devices wait.
function measuringScene(extra = {}) {
  return {
    role: "operator",
    status: "active",
    gate: {
      state: "waiting",
      released_count: 1,
      verified_count: 0,
      pending_count: 2,
      reasons: { ...none, measuring: 1 },
      observation_started_at: null,
      observation_seconds: 3600,
      evaluated_at: minutes(0),
    },
    watch: {
      window_seconds: 600,
      evaluated_at: minutes(0),
      more: 0,
      devices: [watchDevice(1, "edge-nyc-02")],
    },
    stages: [
      {
        kind: "canary",
        index: 0,
        state: "verified",
        released_at: minutes(-12),
        verified_at: minutes(-11),
        released_early: null,
        size: 1,
        counts: { verified_applied: 1 },
        devices: [laneDevice(1, "edge-nyc-02", "verified_applied")],
        more: 0,
      },
      {
        kind: "batch",
        index: 1,
        state: "queued",
        released_at: null,
        verified_at: null,
        released_early: null,
        size: 2,
        counts: { pending: 2 },
        devices: [
          laneDevice(2, "edge-nyc-03", "pending"),
          laneDevice(3, "edge-fra-01", "pending"),
        ],
        more: 0,
      },
    ],
    nextAdmissionAt: null,
    stateCounts: { verified_applied: 1, pending: 2 },
    releaseError: null,
    posts: [],
    errors: [],
    ...extra,
  };
}
// A canary of two, both applied and being measured: one device with history and
// one that enrolled just before its release, so it has no baseline yet.
function twoCanaries() {
  const base = measuringScene();
  return measuringScene({
    canarySize: 2,
    targetCount: 4,
    gate: {
      ...base.gate,
      released_count: 2,
      reasons: { ...none, measuring: 2 },
    },
    stateCounts: { verified_applied: 2, pending: 2 },
    watch: {
      ...base.watch,
      devices: [
        watchDevice(1, "edge-nyc-02"),
        watchDevice(4, "edge-new-01", { baseline: null }),
      ],
    },
    stages: [
      {
        ...base.stages[0],
        size: 2,
        counts: { verified_applied: 2 },
        devices: [
          laneDevice(1, "edge-nyc-02", "verified_applied"),
          laneDevice(4, "edge-new-01", "verified_applied"),
        ],
      },
      base.stages[1],
    ],
  });
}
const summary = (f) => ({
  id: id(100),
  name: "Synthetic canary rollout",
  configuration_id: id(50),
  configuration_name: "Synthetic logs",
  version_id: id(51),
  version_number: 3,
  policy: null,
  priority: 100,
  target_mode: "snapshot",
  status: f.status,
  scheduled_at: null,
  created_at: "2026-09-27T00:00:00Z",
  rollout: {
    kind: "canary",
    canary_size: f.canarySize || 1,
    batch_size: 2,
    observation_seconds: 3600,
    failure_threshold: 0,
  },
  target_count: f.targetCount || 3,
  verified_count: f.stateCounts.verified_applied || 0,
  state_counts: f.stateCounts,
  canary_gate: f.gate,
});
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
async function launch(f, { width = 899, theme = "light" } = {}) {
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
      method = req.method();
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === "POST") {
      const post = {
        path,
        csrf: req.headers()["x-csrf-token"],
        body: req.postData(),
      };
      f.posts.push(post);
      if (path === `/deployments/${id(100)}/release-next-stage`) {
        if (f.releaseError)
          return reply(
            { error: { code: "CONFLICT", message: f.releaseError } },
            409,
          );
        f.release?.();
        return reply({
          ...summary(f),
          targets: [],
          selector: { device_ids: [], group_ids: [], exclude_ids: [] },
        });
      }
      if (f.previewFor && path === "/deployments/preview") {
        const body = JSON.parse(post.body);
        f.previews.push(body);
        return reply(f.previewFor(body));
      }
      if (f.previewFor && path === "/deployments") {
        const body = JSON.parse(post.body);
        f.creates.push(body);
        return reply({
          id: id(101),
          ...body,
          request_correlation: true,
          request_id: body.request_id,
          operation: "create",
          source_deployment_id: null,
          status: "active",
          created_at: minutes(0),
          targets: body.expected_device_ids.map((device_id) => ({
            device_id,
            state: "pending",
            generation: 0,
          })),
        });
      }
      f.errors.push("Unexpected POST " + path);
      return reply({ error: { code: "UNEXPECTED", message: path } }, 500);
    }
    if (path === "/status")
      return reply({ initialized: true, version: "synthetic" });
    if (path === "/session")
      return reply({ user: user(f.role), csrf_token: "synthetic-csrf" });
    if (path === "/deployments/history")
      return reply({
        items: [
          {
            ...summary(f),
            canary_gate: undefined,
          },
        ],
        total: 1,
        page: 1,
        page_size: 12,
      });
    if (path === `/deployments/${id(100)}/summary`) return reply(summary(f));
    if (path === `/deployments/${id(100)}/rollout`)
      return reply({
        deployment_id: id(100),
        status: f.status,
        evaluated_at: minutes(0),
        stages: f.stages,
        failures: [],
        removed_count: 0,
        check_in_seconds: 60,
        next_admission_at: f.nextAdmissionAt,
        canary_watch: f.watch,
      });
    if (path === `/deployments/${id(100)}/targets`)
      return reply({
        items: f.stages.flatMap((lane) =>
          lane.devices.map((device) => ({
            device_id: device.device_id,
            device_name: device.device_name,
            state: device.state,
            generation: device.state === "pending" ? 0 : 7,
            error: null,
            original: true,
          })),
        ),
        total: 3,
        page: 1,
        page_size: 12,
      });
    if (path === "/devices") return reply(f.devices || []);
    if (path === "/groups") return reply([]);
    if (path === "/issues/history" || path === "/audit/history")
      return reply({
        items: [],
        total: 0,
        page: 1,
        page_size: Number(url.searchParams.get("page_size") || 12),
      });
    if (path === "/agent/releases") return reply([]);
    if (path.startsWith("/devices/") && path.endsWith("/telemetry"))
      return reply({ device_id: path.split("/")[2], samples: [] });
    f.errors.push("Unexpected " + method + " " + path);
    return reply({ error: { code: "UNEXPECTED", message: path } }, 404);
  });
  return { page, context, close: () => context.close() };
}
async function openRollout(f, options) {
  const app = await launch(f, options);
  await app.page.goto(origin + "/__canary-lane#/deployments");
  await app.page.waitForFunction(() => window.ready);
  await app.page.evaluate(() => window.mount("app"));
  await app.page
    .getByRole("link", { name: "Synthetic canary rollout", exact: true })
    .click();
  await expect(
    app.page.getByRole("region", { name: "Deployment details", exact: true }),
  ).toBeVisible();
  return app;
}
const gatePanel = (page) =>
  page.getByRole("region", { name: "Canary gate", exact: true });
const lane = (page, index) =>
  page.locator("ol.rollout-lanes > li.rollout-lane").nth(index);
const release = (page) =>
  page.getByRole("button", { name: "Release next stage now", exact: true });
async function noPageErrors(f) {
  expect(f.errors).toEqual([]);
}
/** Elements that reach past the right edge of the viewport. */
const overflowing = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 6)
      .map(
        (e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 60)}`,
      ),
  );

try {
  await check(
    "While delivery is measured the lane, the bar and the gate say the same thing",
    async () => {
      const f = measuringScene(),
        app = await openRollout(f);
      try {
        const { page } = app;
        await expect(gatePanel(page)).toContainText(
          "Measuring delivery on edge-nyc-02 (2 of 3 samples)",
        );
        await expect(lane(page, 0)).toContainText("1 of 1");
        await expect(lane(page, 0)).toContainText("applied");
        await expect(
          page.getByRole("region", { name: "Rollout progress" }),
        ).toContainText("1 of 3");
        await expect(
          page.getByRole("region", { name: "Rollout progress" }),
        ).toContainText("devices applied");
        const text = await page
          .getByRole("region", { name: "Deployment details" })
          .innerText();
        expect(text).not.toMatch(
          /currently verified|Waiting for current verification|Recorded progress/i,
        );
        // One refresh control (the page's) and nothing in the gate to press.
        await expect(
          page.getByRole("button", { name: /refresh/i }),
        ).toHaveCount(1);
        await expect(gatePanel(page).getByRole("button")).toHaveCount(0);
        // Nothing is counting down while delivery is being measured.
        await expect(page.locator('[role="timer"]')).toHaveCount(0);
        await noPageErrors(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "The canary lane shows what each canary delivers now against the minutes before its release",
    async () => {
      const f = measuringScene({
        watch: {
          window_seconds: 600,
          evaluated_at: minutes(0),
          more: 3,
          devices: [
            watchDevice(1, "edge-nyc-02"),
            watchDevice(4, "edge-new-01", {
              gate_reason: "unverified",
              baseline: null,
              samples: { measured: 0, needed: 3 },
            }),
            watchDevice(5, "edge-mute-01", {
              gate_reason: null,
              now: null,
              baseline: null,
              samples: null,
            }),
          ],
        },
      });
      const app = await openRollout(f);
      try {
        const { page } = app;
        const table = lane(page, 0).getByRole("table");
        await expect(table).toContainText("Canary delivery");
        await expect(table).toContainText(
          "Now, and the average of the 10 minutes before release",
        );
        const row = table.getByRole("row", { name: /edge-nyc-02/ });
        await expect(row).toContainText("5.2 → 5.1");
        await expect(row).toContainText("was 5.5 → 5.4");
        await expect(row).toContainText("2.0%");
        await expect(row).toContainText("was 1.0%");
        await expect(row).toContainText("Measuring delivery · 2 of 3 samples");
        // A device with nothing before its release says so, and never shows 0.
        const fresh = table.getByRole("row", { name: /edge-new-01/ });
        await expect(fresh).toContainText("No baseline yet");
        await expect(fresh).not.toContainText("was 0");
        await expect(fresh).toContainText("Waiting to apply");
        // A device that reports no metrics says that.
        const mute = table.getByRole("row", { name: /edge-mute-01/ });
        await expect(mute).toContainText("Metrics are off");
        await expect(mute).toContainText("No baseline yet");
        await expect(lane(page, 0)).toContainText(
          "3 more canary devices not shown",
        );
        // Names link to the devices; never a bare ID.
        await expect(
          table.getByRole("link", { name: "edge-nyc-02", exact: true }),
        ).toHaveAttribute("href", "#/devices/" + id(1));
        await expect(table).not.toContainText(id(1));
        // The queued stage carries no table.
        await expect(lane(page, 1).getByRole("table")).toHaveCount(0);
        await noPageErrors(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "While a stage is observed there is one countdown, in its lane, and the gate does not repeat it",
    async () => {
      const f = measuringScene({
        gate: {
          state: "observing",
          released_count: 1,
          verified_count: 1,
          pending_count: 2,
          reasons: { ...none },
          observation_started_at: minutes(-5),
          observation_seconds: 3600,
          evaluated_at: minutes(0),
        },
        watch: {
          window_seconds: 600,
          evaluated_at: minutes(0),
          more: 0,
          devices: [watchDevice(1, "edge-nyc-02", { gate_reason: null })],
        },
        nextAdmissionAt: minutes(55),
      });
      const app = await openRollout(f);
      try {
        const { page } = app;
        await expect(gatePanel(page)).toContainText("Observation in progress");
        await expect(page.locator('[role="timer"]')).toHaveCount(1);
        await expect(lane(page, 0).locator('[role="timer"]')).toHaveCount(1);
        await expect(gatePanel(page).locator('[role="timer"]')).toHaveCount(0);
        await expect(gatePanel(page)).toContainText("Observation started");
        await noPageErrors(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Release next stage now says what it releases and skips, asks first, and records the release",
    async () => {
      const f = measuringScene();
      f.release = () => {
        f.stages[1] = {
          ...f.stages[1],
          state: "in_progress",
          released_at: minutes(0),
          released_early: { by_name: "Synthetic operator", at: minutes(0) },
          counts: { desired: 2 },
          devices: f.stages[1].devices.map((d) => ({ ...d, state: "desired" })),
        };
        f.stateCounts = { verified_applied: 1, desired: 2 };
        f.gate = {
          ...f.gate,
          released_count: 3,
          verified_count: 1,
          pending_count: 0,
          reasons: { ...none, unverified: 2 },
        };
      };
      const app = await openRollout(f);
      try {
        const { page } = app;
        // The button is in the canary lane, not in the gate.
        await expect(lane(page, 0).getByRole("button")).toHaveCount(1);
        await expect(gatePanel(page).getByRole("button")).toHaveCount(0);
        await release(page).click();
        const dialog = page.getByRole("dialog", {
          name: "Release next stage now",
        });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(
          "Release to the remaining 2 devices now?",
        );
        await expect(dialog).toContainText(
          "The delivery check on edge-nyc-02 is still measuring.",
        );
        await expect(dialog).toContainText(
          "It is recorded on the rollout and in the audit log.",
        );
        // Asking changes nothing.
        expect(f.posts).toEqual([]);
        await dialog.getByRole("button", { name: "Release now" }).click();
        await expect(
          page.getByText("The next stage was released early"),
        ).toBeVisible();
        expect(f.posts).toHaveLength(1);
        expect(f.posts[0].path).toBe(
          `/deployments/${id(100)}/release-next-stage`,
        );
        expect(f.posts[0].csrf).toBe("synthetic-csrf");
        // The page reloads the lanes: the stage records who released it, and
        // nothing more can be released until it applies.
        await expect(lane(page, 1)).toContainText(
          "Released early by Synthetic operator",
        );
        await expect(release(page)).toHaveCount(0);
        await expect(gatePanel(page)).toContainText(
          "Waiting for 2 released devices to apply",
        );
        await noPageErrors(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Releasing while observing names the observation it skips and how many stages follow",
    async () => {
      const f = measuringScene({
        gate: {
          state: "observing",
          released_count: 1,
          verified_count: 1,
          pending_count: 4,
          reasons: { ...none },
          observation_started_at: minutes(-5),
          observation_seconds: 3600,
          evaluated_at: minutes(0),
        },
        targetCount: 5,
        nextAdmissionAt: minutes(55),
      });
      f.stages.push({
        ...f.stages[1],
        index: 2,
        size: 2,
        devices: [
          laneDevice(6, "edge-ams-01", "pending"),
          laneDevice(7, "edge-ams-02", "pending"),
        ],
      });
      const app = await openRollout(f);
      try {
        const { page } = app;
        await release(page).click();
        const dialog = page.getByRole("dialog", {
          name: "Release next stage now",
        });
        await expect(dialog).toContainText(
          "Release to the next 2 of 4 waiting devices now?",
        );
        await expect(dialog).toContainText(
          "The observation of edge-nyc-02 hasn't finished.",
        );
        await expect(dialog).toContainText(
          "Later stages still wait for their own checks.",
        );
        await dialog
          .getByRole("button", { name: "Keep current state" })
          .click();
        await expect(dialog).toHaveCount(0);
        // Closing hands focus back to the button that opened it.
        await expect(release(page)).toBeFocused();
        expect(f.posts).toEqual([]);
        await noPageErrors(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "A refused release leaves the rollout as it was and says why",
    async () => {
      const f = measuringScene({
        releaseError:
          "The canary hasn't applied on every released device yet. Wait until it has.",
      });
      const app = await openRollout(f);
      try {
        const { page } = app;
        await release(page).click();
        const dialog = page.getByRole("dialog", {
          name: "Release next stage now",
        });
        await dialog.getByRole("button", { name: "Release now" }).click();
        await expect(dialog).toContainText(
          "The canary hasn't applied on every released device yet. Wait until it has.",
        );
        await expect(dialog).toBeVisible();
        expect(f.posts).toHaveLength(1);
        await dialog
          .getByRole("button", { name: "Keep current state" })
          .click();
        await expect(lane(page, 1)).not.toContainText("Released early");
        await expect(gatePanel(page)).toContainText("Measuring delivery on");
        await noPageErrors(f.errors.length ? f : { errors: [] });
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Only an operator sees the button, and only while the next stage may go early",
    async () => {
      const cases = [
        { role: "viewer", offered: false },
        { role: "editor", offered: false },
        { role: "operator", offered: true },
        { role: "admin", offered: true },
        // A canary device that has not applied, is not delivering or has gone
        // quiet holds the rollout: nothing to skip.
        ...["unverified", "stale", "degraded", "paused"].map((reason) => ({
          role: "operator",
          offered: false,
          gate: {
            released_count: 1,
            verified_count: 0,
            reasons: { ...none, [reason]: 1 },
          },
        })),
        { role: "operator", offered: false, status: "paused" },
      ];
      for (const one of cases) {
        const f = measuringScene({ role: one.role });
        if (one.gate) f.gate = { ...f.gate, ...one.gate };
        if (one.status) {
          f.status = one.status;
          f.gate = { ...f.gate, state: "paused" };
        }
        const app = await openRollout(f);
        try {
          await expect(gatePanel(app.page)).toBeVisible();
          await expect(release(app.page)).toHaveCount(one.offered ? 1 : 0);
          await noPageErrors(f);
        } finally {
          await app.close();
        }
      }
    },
  );
  await check(
    "The rollout page names the canary and lists its delivery in both themes and on a phone",
    async () => {
      for (const width of [899, 390])
        for (const theme of ["light", "dark"]) {
          const f = twoCanaries();
          const app = await openRollout(f, { width, theme });
          try {
            const { page } = app;
            await expect(lane(page, 0).getByRole("table")).toBeVisible();
            await expect(
              page.getByText(
                "Canary of 2 (edge-nyc-02 and edge-new-01), then batches of 2",
              ),
            ).toBeVisible();
            await expect(
              lane(page, 0)
                .getByRole("table")
                .getByRole("row", { name: /edge-new-01/ }),
            ).toContainText("No baseline yet");
            // Keep the evidence even when a check below fails.
            const file = `canary-rollout-${width}-${theme}.png`;
            await page.screenshot({
              path: resolve(output, file),
              fullPage: true,
            });
            screenshots.push(file);
            expect(await overflowing(page)).toEqual([]);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const box = await lane(page, 0).boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
            const axe = await new AxeBuilder({ page }).analyze();
            accessibility.push({
              width,
              theme,
              page: "rollout",
              violations: axe.violations.map((v) => ({
                id: v.id,
                impact: v.impact,
                nodes: v.nodes.map((n) => n.target),
              })),
            });
            expect(axe.violations).toEqual([]);
            await noPageErrors(f);
          } finally {
            await app.close();
          }
        }
    },
  );

  // The deploy review.
  const devices = [
    ["edge-nyc-01", "online", true],
    ["edge-fra-01", "online", true],
    ["edge-lon-01", "online", false],
    ["edge-old-01", "offline", false],
  ].map(([name, status, telemetry], index) => ({
    id: id(10 + index),
    name,
    os: "linux",
    arch: "amd64",
    vector_version: "0.58.0",
    agent_version: "synthetic",
    status,
    apply_state: "unmanaged",
    desired_generation: 0,
    reported_generation: 0,
    configuration_mode: "full",
    labels: {},
    sync_paused: false,
    local_paused: false,
    pause_acknowledged: false,
    effective_policy: {
      heartbeat_seconds: 60,
      sync_paused: false,
      telemetry_enabled: true,
    },
    telemetry: telemetry
      ? {
          sampled_at: minutes(0),
          events_per_second: 5,
          events_out_per_second: 4.9,
        }
      : null,
    last_seen: minutes(0),
    created_at: "2026-09-27T00:00:00Z",
  }));
  const version = {
    id: id(51),
    configuration_id: id(50),
    number: 3,
    config: {
      sources: { seed: { type: "demo_logs", format: "json" } },
      sinks: { discard: { type: "blackhole", inputs: ["seed"] } },
    },
    sha256: "0".repeat(64),
    artifact: "{}",
    size: 2,
    created_at: "2026-09-27T00:00:00Z",
    message: "Synthetic version",
  };
  // What the server would answer: the most ready device first, or the chosen.
  const readiness = {
    [id(10)]: ["ready", "Online and healthy, and it reports metrics"],
    [id(11)]: ["ready", "Online and healthy, and it reports metrics"],
    [id(12)]: ["no_metrics", "Online and healthy, but it reports no metrics"],
    [id(13)]: ["away", "Not checking in"],
  };
  const previewFor = (body) => {
    const selected = devices.filter((d) =>
      body.selector.device_ids.includes(d.id),
    );
    const named = (body.rollout.canary_device_ids || []).filter((key) =>
      selected.some((d) => d.id === key),
    );
    const size = Math.min(body.rollout.canary_size, selected.length);
    const rest = ["ready", "no_metrics", "away"].flatMap((kind) =>
      selected
        .filter((d) => readiness[d.id][0] === kind && !named.includes(d.id))
        .map((d) => d.id),
    );
    const picked = [...named, ...rest].slice(0, size);
    return {
      devices: selected,
      warnings: [],
      conflicts: [],
      outcomes: selected.map((d) => ({
        device_id: d.id,
        resource: "configuration",
        outcome: "requested",
      })),
      create_idempotency: true,
      request_correlation: true,
      blockers: [],
      configuration_name: "Synthetic logs",
      canary:
        body.rollout.kind === "canary"
          ? {
              size,
              chosen_by_you: named.length > 0,
              device_ids: picked,
              devices: picked.map((key) => {
                const device = devices.find((d) => d.id === key);
                return {
                  device_id: key,
                  device_name: device.name,
                  chosen: named.includes(key),
                  readiness: named.includes(key) ? "ready" : readiness[key][0],
                  reason: named.includes(key)
                    ? "You chose it"
                    : readiness[key][1],
                };
              }),
            }
          : null,
    };
  };
  async function openReview(f, options) {
    const app = await launch(f, options);
    await app.page.goto(origin + "/__canary-lane");
    await app.page.waitForFunction(() => window.ready);
    await app.page.evaluate(
      ({ version }) =>
        window.mount("dialog", {
          open: true,
          userId: "11111111-2222-4333-8444-000000000099",
          version,
          pipelineName: "Synthetic logs",
        }),
      { version },
    );
    const dialog = app.page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    for (const device of devices)
      await dialog.getByLabel(`Select ${device.name}`).check();
    await dialog.getByRole("radio", { name: /Canary/ }).check();
    return { ...app, dialog };
  }
  const review = (dialog) =>
    dialog.getByRole("button", { name: "Review deployment" });
  await check(
    "The review names the canary and why, and the release step calls the number a size",
    async () => {
      const f = measuringScene({ devices, previewFor });
      f.previews = [];
      f.creates = [];
      const app = await openReview(f);
      try {
        const { page, dialog } = app;
        await expect(dialog.getByLabel("Canary size")).toHaveValue("1");
        await expect(dialog).toContainText(
          "You choose which devices when you review.",
        );
        await expect(dialog).not.toContainText("Canary devices");
        await review(dialog).click();
        // Nothing was chosen: the request leaves the choice to the server.
        expect(f.previews).toHaveLength(1);
        expect(f.previews[0].rollout).toEqual({
          kind: "canary",
          canary_size: 1,
          batch_size: 10,
          observation_seconds: 60,
          failure_threshold: 0,
        });
        const picker = dialog.getByRole("button", { name: /Canary devices:/ });
        await expect(picker).toContainText("edge-nyc-01");
        await expect(dialog).toContainText(
          "Chosen for you: online and healthy, and it reports metrics.",
        );
        // The Stage column says who goes first and who follows.
        const table = dialog.getByRole("table", {
          name: "Deployment review devices",
        });
        await expect(
          table.getByRole("columnheader", { name: /Stage/ }),
        ).toBeVisible();
        await expect(
          table.getByRole("row", { name: /edge-nyc-01/ }),
        ).toContainText("Canary");
        for (const other of ["edge-fra-01", "edge-lon-01", "edge-old-01"])
          await expect(
            table.getByRole("row", { name: new RegExp(other) }),
          ).toContainText("Then");
        await expect(page.locator("body")).not.toContainText(id(10));
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "The picker chooses among the reviewed devices by name, reviews again, and can hand the choice back",
    async () => {
      const f = measuringScene({ devices, previewFor });
      f.previews = [];
      f.creates = [];
      const app = await openReview(f);
      try {
        const { page, dialog } = app;
        await review(dialog).click();
        await dialog.getByRole("button", { name: /Canary devices:/ }).click();
        const menu = page.getByRole("dialog", { name: "Canary devices" });
        await expect(menu).toBeVisible();
        // Every reviewed device, by name, with how ready it is.
        for (const device of devices)
          await expect(
            menu.getByRole("radio", { name: new RegExp(device.name) }),
          ).toBeVisible();
        await expect(menu).toContainText("Offline");
        await expect(menu).toContainText("canary now");
        await expect(menu).not.toContainText(id(11));
        // Nothing is chosen until a device is.
        await expect(menu.getByRole("radio", { checked: true })).toHaveCount(0);
        await expect(
          menu.getByRole("button", { name: "Apply" }),
        ).toBeDisabled();
        await menu.getByRole("radio", { name: /edge-old-01/ }).check();
        await menu.getByRole("button", { name: "Apply" }).click();
        await expect.poll(() => f.previews.length).toBe(2);
        expect(f.previews[1].rollout.canary_device_ids).toEqual([id(13)]);
        await expect(
          dialog.getByRole("button", { name: /Canary devices:/ }),
        ).toContainText("edge-old-01");
        await expect(dialog).toContainText("You chose edge-old-01.");
        const table = dialog.getByRole("table", {
          name: "Deployment review devices",
        });
        await expect(
          table.getByRole("row", { name: /edge-old-01/ }),
        ).toContainText("Canary");
        await expect(
          table.getByRole("row", { name: /edge-nyc-01/ }),
        ).toContainText("Then");
        // Sending reviews what was chosen.
        await dialog.getByRole("button", { name: "Deploy to devices" }).click();
        await expect.poll(() => f.creates.length).toBe(1);
        expect(f.creates[0].rollout.canary_device_ids).toEqual([id(13)]);
        expect(f.creates[0].expected_device_ids).toHaveLength(4);
        await expect(dialog).toContainText("Deployment created");
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Handing the choice back reviews again without naming any device",
    async () => {
      const f = measuringScene({ devices, previewFor });
      f.previews = [];
      f.creates = [];
      const app = await openReview(f);
      try {
        const { page, dialog } = app;
        await review(dialog).click();
        await dialog.getByRole("button", { name: /Canary devices:/ }).click();
        const menu = page.getByRole("dialog", { name: "Canary devices" });
        await menu.getByRole("radio", { name: /edge-fra-01/ }).check();
        await menu.getByRole("button", { name: "Apply" }).click();
        await expect.poll(() => f.previews.length).toBe(2);
        await dialog.getByRole("button", { name: /Canary devices:/ }).click();
        await menu.getByRole("button", { name: "Let Vectory choose" }).click();
        await expect.poll(() => f.previews.length).toBe(3);
        expect(f.previews[2].rollout).not.toHaveProperty("canary_device_ids");
        await expect(dialog).toContainText("Chosen for you");
        // Going back to the selection forgets the choice: the review lists
        // the devices it is made from.
        await dialog.getByRole("button", { name: "Back to selection" }).click();
        await review(dialog).click();
        await expect.poll(() => f.previews.length).toBe(4);
        expect(f.previews[3].rollout).not.toHaveProperty("canary_device_ids");
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "The canary size caps the choice, a larger size lets the person name more, and a small list searches",
    async () => {
      const f = measuringScene({ devices, previewFor });
      f.previews = [];
      const app = await openReview(f);
      try {
        const { page, dialog } = app;
        await dialog.getByLabel("Canary size").fill("2");
        await review(dialog).click();
        await dialog.getByRole("button", { name: /Canary devices:/ }).click();
        const menu = page.getByRole("dialog", { name: "Canary devices" });
        await expect(menu).toContainText("Choose up to 2 devices");
        await menu.getByRole("checkbox", { name: /edge-old-01/ }).check();
        await menu.getByRole("checkbox", { name: /edge-lon-01/ }).check();
        // At the size, the others wait until one is unchecked.
        await expect(
          menu.getByRole("checkbox", { name: /edge-nyc-01/ }),
        ).toBeDisabled();
        await menu.getByRole("button", { name: "Apply" }).click();
        await expect.poll(() => f.previews.length).toBe(2);
        expect(f.previews[1].rollout.canary_size).toBe(2);
        expect(f.previews[1].rollout.canary_device_ids.sort()).toEqual(
          [id(12), id(13)].sort(),
        );
        await expect(dialog).toContainText(
          "You chose edge-old-01 and edge-lon-01",
        );
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "The review and its picker are readable and accessible in both themes and on a phone",
    async () => {
      for (const width of [899, 390])
        for (const theme of ["light", "dark"]) {
          const f = measuringScene({ devices, previewFor });
          f.previews = [];
          const app = await openReview(f, { width, theme });
          try {
            const { page, dialog } = app;
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );
            await review(dialog).click();
            await expect(
              dialog.getByRole("button", { name: /Canary devices:/ }),
            ).toBeVisible();
            for (const open of [false, true]) {
              if (open)
                await dialog
                  .getByRole("button", { name: /Canary devices:/ })
                  .click();
              expect(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth,
                ),
              ).toBe(true);
              const axe = await new AxeBuilder({ page }).analyze();
              accessibility.push({
                width,
                theme,
                page: open ? "review-picker" : "review",
                violations: axe.violations.map((v) => ({
                  id: v.id,
                  impact: v.impact,
                  nodes: v.nodes.map((n) => n.target),
                })),
              });
              expect(axe.violations).toEqual([]);
              const file = `canary-${open ? "picker" : "review"}-${width}-${theme}.png`;
              await page.screenshot({ path: resolve(output, file) });
              screenshots.push(file);
              if (open) await page.keyboard.press("Escape");
            }
            // Escape closed the picker, not the dialog.
            await expect(dialog).toBeVisible();
            expect(f.errors).toEqual([]);
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
      "The real rollout page and deploy review with intercepted synthetic HTTP. No device, heartbeat or gate computation is claimed.",
    passed:
      results.length === 13 &&
      results.every((r) => r.passed) &&
      accessibility.length === 12 &&
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
