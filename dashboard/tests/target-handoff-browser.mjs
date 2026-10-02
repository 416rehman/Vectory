// Actual fleet/settings/review components; all HTTP is intercepted synthetic data.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import net from "node:net";
import { createHash } from "node:crypto";
import {
  fleetReplies,
  fulfillFleetRead,
  nothingOffered,
} from "./fleet-replies.mjs";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_TARGET_HANDOFF_OUTPUT || ".local/target-handoff",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:target-handoff";
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
      name: "isolated-target-handoff",
      resolveId(id) {
        if (id === "virtual:target-handoff") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import TargetDialog from'/src/TargetDialog.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';setCSRF('synthetic');const root=createRoot(document.getElementById('root'));let key=0;window.mount=(name,props={})=>{window.notices=[];window.fixtureClosed=false;root.render(name==='app'?React.createElement(App,{key:++key}):React.createElement(TargetDialog,{key:++key,onDone:x=>window.notices.push(x),onClose:()=>window.fixtureClosed=true,...props}));};window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__target-handoff") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic table verification</title></head><body><div id="root"></div><script type="module">import "virtual:target-handoff";</script></body></html>',
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
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const created = "2026-09-27T12:00:00Z";
const policy = {
  heartbeat_seconds: 60,
  sync_paused: true,
  telemetry_enabled: true,
};
const config = {
  sources: { seed: { type: "demo_logs", format: "json" } },
  sinks: { discard: { type: "blackhole", inputs: ["seed"] } },
};
const pipeline = {
  id: id(10),
  name: "Synthetic deployment handoff",
  description: "Never sent to a real device",
  revision: 1,
  archived: false,
  archived_at: null,
  created_at: created,
  updated_at: created,
  config,
  graph: { nodes: [], edges: [] },
};
const version = {
  id: id(11),
  configuration_id: pipeline.id,
  number: 1,
  config,
  graph: pipeline.graph,
  sha256: "0".repeat(64),
  artifact: JSON.stringify(config),
  size: JSON.stringify(config).length,
  created_at: created,
  message: "Synthetic published version",
  validation: { valid: true },
};
function device(n, extra = {}) {
  return {
    id: id(n),
    name: n === 1 ? "Synthetic alpha" : "Synthetic beta",
    os: "linux",
    arch: "amd64",
    vector_version: "0.58.0",
    agent_version: "synthetic",
    status: "verified",
    apply_state: "verified_applied",
    desired_generation: 1,
    reported_generation: 1,
    desired_version_id: version.id,
    configuration_mode: "full",
    labels: {},
    sync_paused: false,
    local_paused: false,
    effective_policy: { ...policy, sync_paused: false },
    created_at: created,
    ...extra,
  };
}
const results = [],
  requests = [],
  unexpected = [],
  errors = [],
  accessibility = [],
  measurements = [];
let context, page, state, failure;
async function load({
  kind = "policy",
  app = false,
  width = 899,
  theme = "light",
  devices,
  extra = {},
} = {}) {
  if (context) await context.close();
  state = {
    devices: devices || [
      device(1, {
        assignment: {
          id: id(80),
          priority: 50,
          reason: "Synthetic configuration winner",
        },
        policy_assignment: {
          id: id(81),
          priority: 200,
          reason: "Synthetic policy winner",
        },
      }),
      device(2),
    ],
    previews: [],
    creates: [],
    holds: [],
    failCreate: false,
    holdCreate: false,
    holdPreview: false,
    conflicts: [],
    receipt: null,
    responseId: id(40),
    detailReads: 0,
    legacyPreview: false,
    outcomeOverride: null,
    // A whole preview response for the request, when a check needs one.
    previewFor: null,
  };
  const current = state;
  const groups = () => [
    {
      id: id(20),
      name: "Synthetic group",
      description: "Fixture only",
      device_ids: current.devices.map((d) => d.id),
    },
  ];
  const replies = fleetReplies({ devices: () => current.devices, groups });
  context = await browser.newContext({
    viewport: { width, height: 920 },
    reducedMotion: "reduce",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
    localStorage.setItem("vectory-sidebar-collapsed", "true");
  }, theme);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    if (url.origin !== origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7);
    requests.push({ method, path, query: url.search });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === "GET") {
      if (path.startsWith("/deployments/requests/"))
        return reply({ request_id: path.split("/").at(-1), found: false });
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: id(90),
            name: "Synthetic administrator",
            email: "fixture@example.test",
            role: "admin",
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic handoff" });
      if (path === `/devices/${id(1)}`) current.detailReads++;
      // A page of devices, one device, and the groups without their members.
      if (await fulfillFleetRead(replies, route)) return;
      if (path === "/devices") return reply(current.devices);
      if (path === "/groups") return reply(groups());
      if (path === "/mfa") return reply({ enabled: false });
      if (path === "/policies")
        return reply([
          {
            id: id(21),
            name: "Synthetic pause policy",
            policy,
            created_at: created,
          },
        ]);
      if (path === `/configurations/${pipeline.id}`) return reply(pipeline);
      if (path === `/configurations/${pipeline.id}/history`)
        return reply({
          items: [
            {
              id: version.id,
              configuration_id: pipeline.id,
              created_at: created,
            },
          ],
          total: 1,
          page: 1,
          page_size: Number(url.searchParams.get("page_size")),
          kind: "versions",
        });
      if (path === `/versions/${version.id}`) return reply(version);
      if (path === "/deployments/history")
        return reply({
          items: [],
          total: 0,
          page: Number(url.searchParams.get("page") || 1),
          page_size: 12,
        });
      if (/^\/deployments\/[^/]+\/rollout$/.test(path))
        return reply({
          deployment_id: path.split("/")[2],
          status: "active",
          evaluated_at: new Date().toISOString(),
          stages: [],
          failures: [],
          removed_count: 0,
          check_in_seconds: 60,
          next_admission_at: null,
        });
      if (path === `/deployments/${id(40)}/summary`)
        return reply({
          id: id(40),
          name: "Synthetic created rollout",
          configuration_id: current.receipt?.version_id ? pipeline.id : null,
          configuration_name: current.receipt?.version_id
            ? pipeline.name
            : null,
          version_id: current.receipt?.version_id || null,
          version_number: current.receipt?.version_id ? 1 : null,
          policy: current.receipt?.policy || null,
          priority: 100,
          target_mode: "snapshot",
          status: current.receipt?.scheduled_at ? "scheduled" : "active",
          scheduled_at: current.receipt?.scheduled_at || null,
          created_at: created,
          rollout: current.receipt?.rollout || { kind: "all" },
          target_count: 2,
          verified_count: 0,
          state_counts: { pending: 2 },
        });
      if (path === `/deployments/${id(40)}/targets`)
        return reply({ items: [], total: 0, page: 1, page_size: 12 });
    }
    if (method === "POST" && path === "/deployments/preview") {
      const body = req.postDataJSON();
      current.previews.push(body);
      if (current.holdPreview)
        await new Promise((resolve) => current.holds.push(resolve));
      const selected = new Set(
        [
          ...body.selector.device_ids,
          ...(body.selector.group_ids.length
            ? current.devices.map((d) => d.id)
            : []),
        ].filter((key) => !body.selector.exclude_ids.includes(key)),
      );
      if (current.previewFor)
        return reply({
          devices: current.devices.filter((d) => selected.has(d.id)),
          warnings: [],
          create_idempotency: true,
          request_correlation: true,
          blockers: [],
          ...current.previewFor(body),
        });
      return reply({
        devices: current.devices.filter((d) => selected.has(d.id)),
        warnings: [],
        conflicts: current.conflicts,
        ...(!current.legacyPreview
          ? {
              create_idempotency: true,
              request_correlation: true,
              blockers: [],
              outcomes:
                current.outcomeOverride ||
                current.devices
                  .filter((d) => selected.has(d.id))
                  .map((d) => {
                    const resource = body.policy ? "policy" : "configuration";
                    const assignment = body.policy
                      ? d.policy_assignment
                      : d.assignment;
                    return {
                      device_id: d.id,
                      resource,
                      outcome:
                        assignment && assignment.priority > body.priority
                          ? "higher_priority"
                          : "requested",
                      ...(assignment && assignment.priority > body.priority
                        ? { assignment }
                        : {}),
                    };
                  }),
            }
          : {}),
      });
    }
    if (method === "POST" && path === "/deployments") {
      expect(req.headers()["x-csrf-token"]).toBe("synthetic");
      const body = req.postDataJSON();
      current.creates.push(body);
      if (current.holdCreate)
        await new Promise((resolve) => current.holds.push(resolve));
      if (current.failCreate)
        return reply(
          {
            error: {
              code: "SYNTHETIC_FAILURE",
              message: "Synthetic deployment creation failed",
            },
          },
          400,
        );
      current.receipt = body;
      return reply({
        id: current.responseId,
        ...body,
        request_correlation: true,
        request_id: body.request_id,
        operation: "create",
        source_deployment_id: null,
        status: body.scheduled_at ? "scheduled" : "active",
        created_at: created,
        targets: body.expected_device_ids.map((device_id) => ({
          device_id,
          state: "pending",
          generation: 0,
        })),
      });
    }
    // The device page also shows telemetry, open issues and recent activity.
    if (method === "GET") {
      const telemetry = path.match(/^\/devices\/([^/]+)\/telemetry$/);
      if (telemetry) return reply({ device_id: telemetry[1], samples: [] });
      const configuration = path.match(/^\/devices\/([^/]+)\/configuration$/);
      if (configuration) return reply(nothingOffered(configuration[1]));
      if (path === "/issues/history" || path === "/audit/history")
        return reply({
          items: [],
          total: 0,
          page: 1,
          page_size: Number(url.searchParams.get("page_size") || 12),
        });
    }
    unexpected.push(`${method} ${path}`);
    return reply(
      {
        error: {
          code: "UNEXPECTED_REQUEST",
          message: "Synthetic transport rejected request",
        },
      },
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    origin +
      "/__target-handoff" +
      (app ? `#/configurations/${pipeline.id}` : ""),
  );
  await page.waitForFunction(() => window.ready);
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
  }, theme);
  await page.evaluate(
    ({ app, kind, policy, version, extra }) =>
      window.mount(app ? "app" : "target", {
        open: true,
        userId: "00000000-0000-4000-8000-000000000090",
        ...(kind === "policy" ? { policy } : { version }),
        ...extra,
      }),
    { app, kind, policy, version, extra },
  );
  if (!app)
    await expect(
      page.getByRole("checkbox", {
        name: "Select Synthetic alpha",
        exact: true,
      }),
    ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
const dialog = () =>
  page.getByRole("dialog").filter({ has: page.locator(".target-flow") });
const table = () =>
  page.getByRole("table", { name: "Deployment review devices", exact: true });
async function preview({ both = true, scheduled = false } = {}) {
  await page
    .getByRole("checkbox", { name: "Select Synthetic alpha", exact: true })
    .check();
  if (both)
    await page
      .getByRole("checkbox", { name: "Select Synthetic beta", exact: true })
      .check();
  if (scheduled) {
    await page.getByRole("radio", { name: "Scheduled", exact: true }).check();
    await page.getByLabel("Start at", { exact: true }).fill("2030-01-01T12:30");
  }
  await page
    .getByRole("button", { name: "Review deployment", exact: true })
    .click();
  await expect(table()).toBeVisible();
}
// Synthetic alpha's own settings (priority 200) outrank the request: the
// dialog says it stays behind and asks before sending to the other device.
const keptAlpha = () =>
  page.getByRole("checkbox", {
    name: /^Synthetic alpha keeps its current agent settings \(priority 200\)/,
  });
const applyToOthers = () =>
  page.getByRole("button", { name: "Apply to 1 of 2 devices", exact: true });
async function sendPolicy() {
  await keptAlpha().check();
  await applyToOthers().click();
}
async function check(name, run) {
  const focus = process.env.VECTORY_TARGET_HANDOFF_FOCUS;
  if (focus && !name.toLowerCase().includes(focus.toLowerCase())) return;
  const began = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - began });
  console.log("PASS", name);
}
try {
  await check(
    "Policy preview uses its own assignment priority, preserves requested priority, and distinguishes configuration priority",
    async () => {
      await load();
      await preview();
      const row = table()
        .locator("tbody tr")
        .filter({ hasText: "Synthetic alpha" });
      await expect(row).toContainText("Keeps current");
      await expect(row).toContainText("Priority 200 wins");
      expect(state.previews[0].priority).toBe(100);
      // Round-2 operator review P1-3: sending names the devices it changes
      // and waits until the person accepts what stays behind.
      await expect(applyToOthers()).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Apply settings", exact: true }),
      ).toHaveCount(0);
      await keptAlpha().check();
      await expect(applyToOthers()).toBeEnabled();
      expect(state.creates).toEqual([]);
      await load({ kind: "version" });
      await preview();
      const configRow = table()
        .locator("tbody tr")
        .filter({ hasText: "Synthetic alpha" });
      await expect(configRow).toContainText("Version 1");
      await expect(configRow).not.toContainText("Keeps current");
      await expect(configRow).toContainText("No pipeline assigned");
    },
  );
  await check(
    "Redeploying a fix after a rollback takes one review: the rolled-back rollout and its rollback are replaced at the rollback's priority; declining shows the real winner",
    async () => {
      const described = (n, extra) => ({
        id: id(n),
        name: null,
        resource: "configuration",
        target_mode: "snapshot",
        created_at: created,
        version_id: id(n + 10),
        configuration_id: id(n + 20),
        policy: null,
        policy_id: null,
        policy_name: null,
        ...extra,
      });
      // The canary of this pipeline's v1, rolled back on alpha, and the
      // rollback one priority up that alpha follows now.
      const cancelled = described(60, {
        priority: 100,
        status: "cancelled",
        configuration_name: pipeline.name,
        configuration_id: pipeline.id,
        version_number: 1,
      });
      const rollback = described(61, {
        priority: 101,
        status: "active",
        configuration_name: "Edge syslog processing",
        version_number: 1,
        rollback_of: id(60),
      });
      const lineage = [id(60), id(61)];
      const entries = [cancelled, rollback].map((assignment) => ({
        assignment,
        device_ids: [id(1)],
        retires_assignment: true,
      }));
      const previewFor = (body) =>
        lineage.every((x) => (body.replaces || []).includes(x))
          ? {
              conflicts: [],
              replacements: entries,
              outcomes: [
                {
                  device_id: id(1),
                  resource: "configuration",
                  outcome: "replace",
                  winner: rollback,
                  replaces: rollback,
                },
                {
                  device_id: id(2),
                  resource: "configuration",
                  outcome: "requested",
                },
              ],
            }
          : {
              conflicts: [
                {
                  device_id: id(1),
                  assignment_ids: [id(60), "preview"],
                  priority: body.priority,
                  resource: "configuration",
                  assignments: [cancelled],
                },
              ],
              outcomes: [
                {
                  device_id: id(1),
                  resource: "configuration",
                  outcome: "conflict",
                  winner: rollback,
                },
                {
                  device_id: id(2),
                  resource: "configuration",
                  outcome: "requested",
                },
              ],
              suggested_replaces: entries,
              suggested_priority: 101,
              replacements_needed: entries,
              winning_priority: 102,
            };
      await load({ kind: "version" });
      state.previewFor = previewFor;
      await preview();
      // One round: the dialog adopts the lineage and the rollback's priority.
      await expect.poll(() => state.previews.length).toBe(2);
      expect([...state.previews[1].replaces].sort()).toEqual(lineage);
      expect(state.previews[1].priority).toBe(101);
      await expect(page.getByRole("dialog")).toContainText(
        "Replaces the rollback to Edge syslog processing v1 and the rollout it stopped",
      );
      await expect(
        table().locator("tbody tr").filter({ hasText: "Synthetic alpha" }),
      ).toContainText("Replaces");
      await page
        .getByRole("button", { name: "Deploy to devices", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "View deployment", exact: true }),
      ).toBeVisible();
      expect([...state.creates[0].replaces].sort()).toEqual(lineage);
      expect(state.creates[0].priority).toBe(101);
      // Declined: the conflict names what alpha follows today and what else
      // is bound, and one Replace existing covers both tiers.
      await load({ kind: "version" });
      state.previewFor = previewFor;
      await preview();
      await page
        .getByRole("button", {
          name: "Keep the current assignments as well",
          exact: true,
        })
        .click();
      const conflicts = page.getByRole("table", {
        name: "Devices with a conflicting assignment",
      });
      await expect(conflicts).toContainText(
        "Rollback to Edge syslog processing v1",
      );
      await expect(conflicts).toContainText("Priority 101 · higher");
      await expect(conflicts).toContainText(
        `Also bound: ${pipeline.name} v1 (cancelled)`,
      );
      await page
        .getByRole("button", { name: "Replace existing", exact: true })
        .click();
      await expect
        .poll(() => [...(state.previews.at(-1).replaces || [])].sort())
        .toEqual(lineage);
      await expect(conflicts).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Deploy to devices", exact: true }),
      ).toBeEnabled();
      expect(state.creates).toEqual([]);
    },
  );
  await check(
    "Server outcome is authoritative, legacy missing outcomes stay explicit, and equal-priority conflicts cannot be confirmed",
    async () => {
      await load({
        devices: [
          device(1, {
            policy_assignment: {
              id: id(81),
              priority: 20,
              reason: "Current resolved policy",
            },
          }),
          device(2),
        ],
      });
      state.outcomeOverride = [
        {
          device_id: id(1),
          resource: "policy",
          outcome: "higher_priority",
          assignment: {
            id: id(82),
            priority: 300,
            reason: "Awaiting rollout admission",
          },
        },
        { device_id: id(2), resource: "policy", outcome: "requested" },
      ];
      await preview();
      const row = table()
        .locator("tbody tr")
        .filter({ hasText: "Synthetic alpha" });
      await expect(row).toContainText("Priority 300 wins");
      await expect(
        row.getByRole("link", { name: /^View assignment/ }),
      ).toHaveAttribute("href", `#/deployments/${id(82)}?page=1`);
      await load();
      state.legacyPreview = true;
      await preview();
      await expect(table().locator("tbody tr").first()).toContainText(
        "Outcome unavailable",
      );
      await expect(
        page.getByText(/This server doesn.t report outcomes/),
      ).toBeVisible();
      await expect(table()).not.toContainText("No settings assigned");
      await load();
      state.conflicts = [
        {
          device_id: id(1),
          assignment_ids: [id(81)],
          priority: 100,
          resource: "policy",
        },
      ];
      state.outcomeOverride = [
        { device_id: id(1), resource: "policy", outcome: "conflict" },
        { device_id: id(2), resource: "policy", outcome: "requested" },
      ];
      await preview();
      await expect(table().locator("tbody tr").first()).toContainText(
        "Conflict",
      );
      await expect(
        page.getByRole("button", { name: "Apply settings", exact: true }),
      ).toBeDisabled();
      expect(state.creates).toEqual([]);
    },
  );
  await check(
    "Filtered review submits every reviewed identity; pipeline, policy and scheduled receipts retain exact ID and never auto-navigate",
    async () => {
      for (const [kind, scheduled] of [
        ["version", false],
        ["policy", false],
        ["version", true],
      ]) {
        await load({ kind });
        await preview({ scheduled });
        await page
          .getByRole("button", { name: "Filter Device", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "Filter Device", exact: true })
          .fill("Synthetic alpha");
        await page.keyboard.press("Escape");
        await expect(table().locator("tbody tr")).toHaveCount(1);
        const before = page.url();
        if (kind === "policy") await keptAlpha().check();
        await page
          .getByRole("button", {
            name: scheduled
              ? "Schedule deployment"
              : kind === "policy"
                ? "Apply to 1 of 2 devices"
                : "Deploy to devices",
            exact: true,
          })
          .click();
        const link = page.getByRole("link", {
          name: scheduled ? "View schedule" : "View deployment",
          exact: true,
        });
        await expect(link).toHaveAttribute(
          "href",
          `#/${scheduled ? "schedules" : "deployments"}/${id(40)}?page=1`,
        );
        expect(page.url()).toBe(before);
        expect(state.creates).toHaveLength(1);
        expect(state.creates[0].expected_device_ids).toEqual([id(1), id(2)]);
        expect(state.creates[0].priority).toBe(100);
        if (scheduled) expect(state.creates[0].scheduled_at).toBeTruthy();
        expect(await page.evaluate(() => window.notices.length)).toBe(1);
        await expect(
          page.getByRole("button", { name: "Close", exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Close", exact: true }).click();
        expect(await page.evaluate(() => window.fixtureClosed)).toBe(true);
      }
    },
  );
  await check(
    "Definite pre-commit rejection retains the exact request; held retry blocks dismissal and duplicate submission",
    async () => {
      await load();
      await preview();
      state.failCreate = true;
      await sendPolicy();
      const recovery = page.getByRole("dialog", {
        name: "Confirm deployment",
        exact: true,
      });
      await expect(recovery).toBeVisible();
      await expect(recovery).toContainText(
        "No completed request was found yet",
      );
      await expect(
        page.getByRole("link", { name: "View deployment", exact: true }),
      ).toHaveCount(0);
      expect(state.creates).toHaveLength(1);
      expect(await page.evaluate(() => window.notices.length)).toBe(0);
      state.failCreate = false;
      state.holdCreate = true;
      await recovery
        .getByRole("button", { name: "Retry same request", exact: true })
        .click();
      await expect.poll(() => state.holds.length).toBe(1);
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => window.fixtureClosed)).toBe(false);
      await expect(recovery).toBeVisible();
      expect(state.creates).toHaveLength(2);
      state.holds.shift()();
      await expect(
        page.getByRole("link", { name: "View deployment", exact: true }),
      ).toBeVisible();
      expect(state.creates[0]).toEqual(state.creates[1]);
    },
  );
  await check(
    "Actual editor retains unapplied code and blocks publication; receipt respects navigation veto and opens the exact deployment despite prior list filters",
    async () => {
      await load({ kind: "version", app: true });
      await expect(
        page.getByRole("button", { name: "Choose devices", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        location.hash = "/deployments?search=unrelated&status=failed&page=4";
      });
      await expect(
        page.getByRole("heading", { name: "Deployments", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          requests.some(
            (r) =>
              r.path === "/deployments/history" &&
              r.query.includes("search=unrelated"),
          ),
        )
        .toBe(true);
      await page.evaluate((id) => {
        location.hash = "/configurations/" + id;
      }, pipeline.id);
      await expect(
        page.getByRole("button", { name: "Choose devices", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Code", exact: true }).click();
      const code = page.getByRole("textbox", {
        name: "Vector configuration code",
        exact: true,
      });
      const pending = '{"synthetic-unsaved-target":';
      await code.fill(pending);
      await page
        .getByRole("button", { name: "Review & publish", exact: true })
        .click();
      const publishReview = page.getByRole("dialog", {
        name: "Review & publish",
        exact: true,
      });
      await expect(
        publishReview.getByRole("button", {
          name: "Publish version",
          exact: true,
        }),
      ).toBeDisabled();
      await publishReview
        .getByRole("button", { name: "Back to draft", exact: true })
        .click();
      expect(await code.innerText()).toBe(pending);
      expect(state.previews).toEqual([]);
      expect(state.creates).toEqual([]);
      await page
        .getByRole("button", { name: "Discard code changes", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Choose devices", exact: true })
        .click();
      await preview();
      await page
        .getByRole("button", { name: "Deploy to devices", exact: true })
        .click();
      const link = page.getByRole("link", {
        name: "View deployment",
        exact: true,
      });
      await expect(link).toBeVisible();
      await page.evaluate(() => {
        window.handoffVeto = (event) => event.preventDefault();
        window.addEventListener("vectory:before-navigate", window.handoffVeto);
      });
      await link.click();
      await expect(page).toHaveURL(
        new RegExp(`#/configurations/${pipeline.id}$`),
      );
      await expect(link).toBeVisible();
      expect(state.creates).toHaveLength(1);
      await page.evaluate(() =>
        window.removeEventListener(
          "vectory:before-navigate",
          window.handoffVeto,
        ),
      );
      await link.click();
      await expect(page).toHaveURL(
        new RegExp(`#/deployments/${id(40)}\\?page=1$`),
      );
      await expect(
        page.getByRole("region", { name: "Deployment details", exact: true }),
      ).toBeVisible();
      expect(state.creates).toHaveLength(1);
    },
  );
  await check(
    "Pending actual-App creation holds assignment navigation until its exact receipt is ready",
    async () => {
      await load({
        kind: "version",
        app: true,
        devices: [
          device(1, {
            assignment: {
              id: id(81),
              priority: 200,
              reason: "Synthetic higher configuration",
            },
          }),
          device(2),
        ],
      });
      await page
        .getByRole("button", { name: "Choose devices", exact: true })
        .click();
      await preview();
      state.holdCreate = true;
      // Synthetic alpha's own assignment (priority 200) outranks this one.
      await page
        .getByRole("checkbox", {
          name: /^Synthetic alpha keeps .*\(priority 200\)/,
        })
        .check();
      await expect(page.locator(".target-left-behind")).toContainText(
        "Only the other device changes.",
      );
      await page
        .getByRole("button", { name: "Deploy to 1 of 2 devices", exact: true })
        .click();
      await expect.poll(() => state.holds.length).toBe(1);
      const assignmentLink = page.getByRole("link", {
        name: /^View assignment/,
      });
      await expect(assignmentLink).toHaveAttribute("aria-disabled", "true");
      await assignmentLink.click({ force: true });
      await expect(page).toHaveURL(
        new RegExp(`#/configurations/${pipeline.id}$`),
      );
      const prevented = await page.evaluate(() => {
        const beforeNavigate = new Event("vectory:before-navigate", {
          cancelable: true,
        });
        const beforeUnload = new Event("beforeunload", { cancelable: true });
        return {
          navigation: !window.dispatchEvent(beforeNavigate),
          unload: !window.dispatchEvent(beforeUnload),
        };
      });
      expect(prevented).toEqual({ navigation: true, unload: true });
      await page.evaluate((oldAssignment) => {
        location.hash = `/deployments/${oldAssignment}?page=1`;
      }, id(81));
      await expect(page).toHaveURL(
        new RegExp(`#/configurations/${pipeline.id}$`),
      );
      expect(state.creates).toHaveLength(1);
      state.holds.shift()();
      await expect(
        page.getByRole("link", { name: "View deployment", exact: true }),
      ).toHaveAttribute("href", `#/deployments/${id(40)}?page=1`);
      expect(state.creates).toHaveLength(1);
      await page
        .getByRole("link", { name: "View deployment", exact: true })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`#/deployments/${id(40)}\\?page=1$`),
      );
      await expect(
        page.getByRole("region", { name: "Deployment details", exact: true }),
      ).toBeVisible();
    },
  );
  await check(
    "Malformed accepted response retains the exact request and requires correlated reconciliation",
    async () => {
      await load();
      state.responseId = "../../invalid";
      await preview();
      await sendPolicy();
      await expect(
        page.getByRole("dialog", { name: "Confirm deployment", exact: true }),
      ).toContainText("No completed request was found yet");
      await expect(
        page.getByRole("link", {
          name: "View deployment history",
          exact: true,
        }),
      ).toHaveAttribute("href", "#/deployments?page=1");
      await expect(applyToOthers()).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Retry same request", exact: true }),
      ).toBeEnabled();
      expect(state.creates).toHaveLength(1);
    },
  );
  await check(
    "Device-detail pause receipt survives its parent data refresh and preserves unrelated effective policy settings",
    async () => {
      await load({
        app: true,
        devices: [
          device(1, {
            effective_policy: {
              heartbeat_seconds: 120,
              sync_paused: false,
              telemetry_enabled: false,
            },
          }),
          device(2),
        ],
      });
      await page.evaluate((deviceId) => {
        location.hash = `/devices/${deviceId}`;
      }, id(1));
      await page
        .getByText("Sync, recovery and access", { exact: true })
        .click();
      await page.getByRole("button", { name: /Review pause policy/ }).click();
      await page
        .getByRole("button", { name: "Review deployment", exact: true })
        .click();
      await expect(table()).toBeVisible();
      const initialReads = state.detailReads;
      await page
        .getByRole("button", { name: "Apply settings", exact: true })
        .click();
      await expect.poll(() => state.detailReads).toBeGreaterThan(initialReads);
      await expect(
        page.getByRole("link", { name: "View deployment", exact: true }),
      ).toHaveAttribute("href", `#/deployments/${id(40)}?page=1`);
      expect(state.creates).toHaveLength(1);
      expect(state.creates[0].policy).toEqual({
        heartbeat_seconds: 120,
        sync_paused: true,
        telemetry_enabled: false,
      });
      expect(state.creates[0].expected_device_ids).toEqual([id(1)]);
    },
  );
  await check(
    "899px and 375px light/dark review and receipt remain contained and accessible",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await load({ width, theme });
          await preview();
          for (const stage of ["review", "receipt"]) {
            if (stage === "receipt") await sendPolicy();
            if (stage === "receipt")
              await expect(
                page.getByRole("link", {
                  name: "View deployment",
                  exact: true,
                }),
              ).toBeVisible();
            const modal = page.getByRole("dialog");
            const box = await modal.boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
            const scan = await new AxeBuilder({ page })
              .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
              .analyze();
            accessibility.push({
              width,
              theme,
              stage,
              violations: scan.violations.map((v) => ({
                id: v.id,
                targets: v.nodes.map((n) => n.target),
              })),
            });
            expect(scan.violations).toEqual([]);
            measurements.push({ width, theme, stage, box });
            await page.screenshot({
              path: resolve(output, `target-${stage}-${width}-${theme}.png`),
            });
          }
        }
    },
  );
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const path of [
    "src/TargetDialog.tsx",
    "src/Editor.tsx",
    "src/Control.tsx",
    "src/Fleet.tsx",
    "src/deploymentRouting.ts",
    "src/api.ts",
    "src/control.css",
  ])
    source_sha256[`dashboard/${path}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, path)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Actual TargetDialog plus actual App/editor using intercepted synthetic API only. Browser evidence does not test the real SQL resolver or device activation. No preview sessions, native processes or real mutations.",
        passed: !failure,
        results,
        requests,
        unexpected,
        errors,
        accessibility,
        measurements,
        source_sha256,
        ...(failure
          ? {
              failure: failure.message,
              body_at_failure: await page.locator("body").innerText(),
            }
          : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await server.close();
  console.log("Evidence: " + relative(root, resolve(output, "report.json")));
}
