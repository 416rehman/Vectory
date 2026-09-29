// Actual fleet/settings/review components; all HTTP is intercepted synthetic data.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import net from "node:net";
import { createHash } from "node:crypto";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_DEPLOYMENT_DISCOVERY_OUTPUT ||
    ".local/deployment-discovery",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:deployment-discovery";
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
      name: "isolated-deployment-discovery",
      resolveId(id) {
        if (id === "virtual:deployment-discovery") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import TargetDialog from'/src/TargetDialog.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';setCSRF('synthetic');const root=createRoot(document.getElementById('root'));let key=0;window.mount=(name,props={})=>{window.notices=[];window.fixtureClosed=false;root.render(name==='app'?React.createElement(App,{key:++key}):React.createElement(TargetDialog,{key:++key,onDone:x=>window.notices.push(x),onClose:()=>window.fixtureClosed=true,...props}));};window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__deployment-discovery") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic table verification</title></head><body><div id="root"></div><script type="module">import "virtual:deployment-discovery";</script></body></html>',
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
const rollout = {
  kind: "all",
  canary_size: 1,
  batch_size: 1,
  observation_seconds: 0,
  failure_threshold: 0,
};
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
function summaryFor(row) {
  return {
    request_id: row.body.request_id,
    operation: row.kind || "create",
    source_deployment_id: row.source || null,
    deployment_id: row.result.id,
    created_at: row.result.created_at,
    deployment_name: row.result.name || null,
    deployment_status: row.result.status,
    configuration_name: row.body.version_id ? pipeline.name : null,
    version_number: row.body.version_id ? 1 : null,
    resource: row.body.policy ? "policy" : "configuration",
    scheduled_at: row.result.scheduled_at || null,
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
  storageBlocked = false,
  extra = {},
  appRoute,
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
    actor: id(90),
    role: "admin",
    rollbacks: [],
    recentMode: "normal",
    recentItems: [],
    recentReads: [],
    requestHistory: true,
    createMode: "normal",
    lookupMode: "normal",
    committed: [],
    lookups: [],
    blockers: [],
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
  };
  const current = state;
  context = await browser.newContext({
    viewport: { width, height: 920 },
    reducedMotion: "reduce",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
    localStorage.setItem("vectory-sidebar-collapsed", "true");
  }, theme);
  if (storageBlocked)
    await context.addInitScript(() =>
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("Synthetic storage disabled", "SecurityError");
        },
      }),
    );
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
      if (path === "/deployments/requests") {
        const actor = current.actor;
        const query = Object.fromEntries(url.searchParams);
        current.recentReads.push({ actor, query });
        if (current.recentMode === "hold")
          await new Promise((resolve) => current.holds.push(resolve));
        if (current.recentMode === "failed")
          return reply(
            {
              error: {
                code: "SYNTHETIC_UNAVAILABLE",
                message: "Synthetic recent requests unavailable",
              },
            },
            503,
          );
        if (current.recentMode === "legacy")
          return reply(
            { error: { code: "NOT_FOUND", message: "Not supported" } },
            404,
          );
        const selected = [
          ...current.recentItems,
          ...current.committed.map((row) => ({
            actor: row.actor,
            ...summaryFor(row),
          })),
        ].filter(
          (row) =>
            row.actor === actor &&
            (!query.operation ||
              query.operation === "all" ||
              row.operation === query.operation),
        );
        const size = Number(query.page_size || 12),
          number = Number(query.page || 1);
        return reply({
          items: selected
            .slice((number - 1) * size, number * size)
            .map(({ actor, ...row }) => row),
          total: selected.length,
          page: number,
          page_size: size,
        });
      }
      if (path.startsWith("/deployments/requests/")) {
        const requestId = path.split("/").pop();
        const requestActor = current.actor;
        current.lookups.push({ actor: current.actor, requestId });
        if (current.lookupMode === "failed")
          return reply(
            {
              error: {
                code: "SYNTHETIC_UNAVAILABLE",
                message: "Synthetic lookup unavailable",
              },
            },
            503,
          );
        if (current.lookupMode === "hold")
          await new Promise((resolve) => current.holds.push(resolve));
        const match = current.committed.find(
          (x) => x.actor === requestActor && x.body.request_id === requestId,
        );
        return reply(
          match
            ? {
                request_id: requestId,
                found: true,
                operation: match.result.operation,
                source_deployment_id: match.result.source_deployment_id,
                deployment: match.result,
              }
            : { request_id: requestId, found: false },
        );
      }
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: current.actor,
            name: "Synthetic administrator",
            email: "fixture@example.test",
            role: current.role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic handoff" });
      if (path === "/devices") return reply(current.devices);
      if (path === `/devices/${id(1)}`) {
        current.detailReads++;
        return reply(current.devices[0]);
      }
      if (path === "/groups")
        return reply([
          {
            id: id(20),
            name: "Synthetic group",
            description: "Fixture only",
            device_ids: current.devices.map((d) => d.id),
          },
        ]);
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
          ...(current.requestHistory ? { request_history: true } : {}),
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
      if (/^\/deployments\/[^/]+\/summary$/.test(path))
        return reply({
          id: path.split("/")[2],
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
      if (/^\/deployments\/[^/]+\/targets$/.test(path))
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
      return reply({
        devices: current.devices.filter((d) => selected.has(d.id)),
        ...(!current.legacyPreview
          ? {
              create_idempotency: true,
              request_correlation: true,
              blockers: current.blockers,
            }
          : {}),
        warnings: [],
        conflicts: current.conflicts,
        ...(!current.legacyPreview
          ? {
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
    if (method === "POST" && /^\/deployments\/[^/]+\/rollback$/.test(path)) {
      const body = req.postDataJSON(),
        source = path.split("/")[2],
        actor = current.actor;
      current.rollbacks.push({ source, body: structuredClone(body) });
      if (current.holdCreate)
        await new Promise((resolve) => current.holds.push(resolve));
      const old = current.committed.find(
        (row) => row.actor === actor && row.body.request_id === body.request_id,
      );
      if (old) {
        expect(old.kind).toBe("rollback");
        expect(old.source).toBe(source);
        expect(old.body).toEqual(body);
      }
      const result = old?.result || {
        id: id(40 + current.committed.length),
        request_id: body.request_id,
        operation: "rollback",
        source_deployment_id: source,
        request_correlation: true,
        version_id: version.id,
        priority: 201,
        target_mode: "snapshot",
        status: "active",
        scheduled_at: null,
        created_at: created,
        rollout,
        selector: { device_ids: [], group_ids: [], exclude_ids: [] },
        targets: [],
      };
      if (!old)
        current.committed.push({
          actor,
          kind: "rollback",
          source,
          body: structuredClone(body),
          result,
        });
      return reply(result);
    }
    if (method === "POST" && path === "/deployments") {
      expect(req.headers()["x-csrf-token"]).toBe("synthetic");
      const body = req.postDataJSON();
      current.creates.push(body);
      if (current.holdCreate)
        await new Promise((resolve) => current.holds.push(resolve));
      if (current.createMode === "forbidden")
        return reply(
          { error: { code: "FORBIDDEN", message: "Synthetic access changed" } },
          403,
        );
      if (current.createMode === "definite400")
        return reply(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Synthetic request rejected before commit",
            },
          },
          400,
        );
      if (current.createMode === "server500")
        return reply(
          {
            error: {
              code: "SYNTHETIC_UNAVAILABLE",
              message: "Synthetic create unavailable",
            },
          },
          500,
        );
      if (current.createMode === "uncommitted") return route.abort("failed");
      const old = current.committed.find(
        (x) =>
          x.actor === current.actor &&
          x.body.request_id &&
          x.body.request_id === body.request_id,
      );
      if (old) expect(old.body).toEqual(body);
      const result = old?.result || {
        id: id(40 + current.committed.length),
        ...body,
        request_correlation: true,
        operation: "create",
        source_deployment_id: null,
        status: body.scheduled_at ? "scheduled" : "active",
        created_at: created,
        targets: body.expected_device_ids.map((device_id) => ({
          device_id,
          state: "pending",
          generation: 0,
        })),
      };
      if (!old)
        current.committed.push({
          actor: current.actor,
          body: structuredClone(body),
          result,
        });
      current.receipt = body;
      if (current.createMode === "lost") return route.abort("failed");
      if (current.createMode === "unparseable")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{lost successful response",
        });
      if (current.createMode === "unreadable400")
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: "{",
        });
      if (current.createMode === "errorShape400") return reply({}, 400);
      if (current.createMode === "malformed")
        return reply({ id: "not-a-uuid" });
      return reply(result);
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
      "/__deployment-discovery" +
      (app ? appRoute || `#/configurations/${pipeline.id}` : ""),
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
    await page
      .getByLabel("Start at", { exact: true })
      .fill("2030-01-01T12:30");
  }
  await page
    .getByRole("button", { name: "Review deployment", exact: true })
    .click();
  await expect(table()).toBeVisible();
}
async function check(name, run) {
  const focus = process.env.VECTORY_DEPLOYMENT_DISCOVERY_FOCUS;
  if (focus && !name.toLowerCase().includes(focus.toLowerCase())) return;
  const began = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - began });
  console.log("PASS", name);
}
const recovery = () =>
  page.getByRole("dialog", { name: "Confirm deployment", exact: true });
const confirmed = () =>
  page.getByRole("dialog", { name: "Deployment confirmed", exact: true });
const operation = () =>
  page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith("vectory:deployment-operation:"))
      .map(([key, value]) => ({ key, value: JSON.parse(value) })),
  );
async function send(name = "Apply settings") {
  await page.getByRole("button", { name, exact: true }).click();
}
async function lost({
  kind = "policy",
  app = false,
  mode = "lost",
  scheduled = false,
  ...options
} = {}) {
  await load({ kind, app, ...options });
  if (app)
    await page
      .getByRole("button", { name: "Choose devices", exact: true })
      .click();
  await preview({ scheduled });
  state.createMode = mode;
  state.lookupMode = "failed";
  await send(
    scheduled
      ? "Schedule deployment"
      : kind === "policy"
        ? "Apply settings"
        : "Deploy to devices",
  );
  await expect(recovery()).toBeVisible();
  await expect(
    recovery().getByText("Synthetic lookup unavailable", { exact: true }),
  ).toBeVisible();
}
async function reloadApp() {
  await page.reload();
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => window.mount("app"));
  await expect(
    page.getByRole("button", { name: "Choose devices", exact: true }),
  ).toBeVisible();
}

const recent = () =>
  page.getByRole("dialog", { name: "Your recent requests", exact: true });
const queue = () =>
  page.getByRole("dialog", {
    name: "Requests needing confirmation",
    exact: true,
  });
async function newAppPage(hash = `#/configurations/${pipeline.id}`) {
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/__deployment-discovery" + hash);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => window.mount("app"));
  return page;
}
function syntheticOperation(n, kind = "create", actor = id(90)) {
  const requestId = id(n);
  return {
    actor_id: actor,
    id: requestId,
    label: `Synthetic ${kind} request ${n}`,
    recorded_at: new Date(Date.now() + n).toISOString(),
    retry_supported: true,
    kind,
    ...(kind === "rollback"
      ? { deployment_id: id(80), request: { request_id: requestId } }
      : {
          request: {
            request_id: requestId,
            version_id: version.id,
            selector: { device_ids: [id(1)], group_ids: [], exclude_ids: [] },
            expected_device_ids: [id(1)],
            priority: 100,
            target_mode: "snapshot",
            scheduled_at: null,
            rollout: {
              kind: "all",
              canary_size: 1,
              batch_size: 1,
              observation_seconds: 0,
              failure_threshold: 0,
            },
          },
        }),
  };
}
async function putOperation(target, op, legacy = false) {
  await target.evaluate(
    ({ op, legacy }) => {
      const key = legacy
        ? `vectory:deployment-request:${op.actor_id}`
        : `vectory:deployment-operation:${encodeURIComponent(op.actor_id)}:${op.id}`;
      (legacy ? sessionStorage : localStorage).setItem(key, JSON.stringify(op));
      window.dispatchEvent(new Event("vectory:deployment-request"));
    },
    { op, legacy },
  );
}
function recentRow(n, extra = {}) {
  return {
    actor: id(90),
    request_id: id(1000 + n),
    operation: "create",
    source_deployment_id: null,
    deployment_id: id(2000 + n),
    created_at: created,
    deployment_name: `Synthetic request ${n}`,
    deployment_status: "active",
    configuration_name: pipeline.name,
    version_number: 1,
    resource: "configuration",
    scheduled_at: null,
    ...extra,
  };
}
async function openRecent() {
  await page
    .getByRole("button", { name: "Your recent requests", exact: true })
    .click();
  await expect(recent()).toBeVisible();
  await expect(
    recent().getByText("Only requests saved by the server appear here.", {
      exact: false,
    }),
  ).toBeVisible();
}
async function remountApp() {
  await page.evaluate(() => window.mount("app"));
}

try {
  await check(
    "Closing the original tab preserves the frozen request and exact recovered result",
    async () => {
      await lost({ app: true, kind: "version" });
      const original = structuredClone(state.creates[0]),
        saved = (await operation())[0].value;
      expect(saved.request).toEqual(original);
      await page.close();
      await newAppPage();
      await expect(
        page.getByRole("button", { name: "Confirm deployment", exact: true }),
      ).toBeVisible();
      expect((await operation())[0].value).toEqual(saved);
      state.lookupMode = "normal";
      await page
        .getByRole("button", { name: "Confirm deployment", exact: true })
        .click();
      await expect(
        confirmed().getByRole("link", { name: "View deployment", exact: true }),
      ).toHaveAttribute("href", `#/deployments/${id(40)}?page=1`);
      expect(state.creates).toEqual([original]);
      expect(state.committed).toHaveLength(1);
      expect(await operation()).toEqual([]);
    },
  );
  await check(
    "Two tabs share distinct pending requests and remove only the resolved identity",
    async () => {
      await lost({ app: true, kind: "version" });
      const original = (await operation())[0].value;
      await recovery()
        .getByRole("button", { name: "Close", exact: true })
        .click();
      const first = page;
      await newAppPage();
      await expect(
        page.getByRole("button", { name: "Confirm deployment", exact: true }),
      ).toBeVisible();
      const rollback = syntheticOperation(301, "rollback");
      await putOperation(first, rollback);
      await expect(
        page.getByRole("button", { name: "Review requests", exact: true }),
      ).toBeVisible();
      await expect(
        first.getByText("2 requests need confirmation.", { exact: true }),
      ).toBeVisible();
      state.lookupMode = "normal";
      await first
        .getByRole("button", { name: "Review requests", exact: true })
        .click();
      await first
        .getByRole("dialog", {
          name: "Requests needing confirmation",
          exact: true,
        })
        .getByRole("button", { name: new RegExp(rollback.label) })
        .click();
      const otherDialog = first.getByRole("dialog", {
        name: "Confirm rollback",
        exact: true,
      });
      await expect(otherDialog).toContainText(
        "No completed request was found yet",
      );
      await page
        .getByRole("button", { name: "Review requests", exact: true })
        .click();
      await queue()
        .getByRole("button", { name: new RegExp(rollback.label) })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Confirm rollback",
        exact: true,
      });
      await expect(dialog).toContainText("No completed request was found yet");
      expect(state.rollbacks).toHaveLength(0);
      state.holdCreate = true;
      await dialog
        .getByRole("button", { name: "Retry same request", exact: true })
        .click();
      await expect.poll(() => state.rollbacks.length).toBe(1);
      await expect(otherDialog).toContainText(
        "Another tab may still be checking or sending this request",
      );
      await expect(
        otherDialog.getByRole("button", {
          name: "Retry same request",
          exact: true,
        }),
      ).toBeDisabled();
      state.holdCreate = false;
      state.holds.splice(0).forEach((resolve) => resolve());
      const receipt = page.getByRole("dialog", {
        name: "Rollback confirmed",
        exact: true,
      });
      await expect(
        receipt.getByRole("link", {
          name: "View rollback deployment",
          exact: true,
        }),
      ).toHaveAttribute("href", `#/deployments/${id(41)}?page=1`);
      expect(state.rollbacks).toEqual([
        { source: rollback.deployment_id, body: rollback.request },
      ]);
      expect((await operation()).map((x) => x.value.id)).toEqual([original.id]);
      await expect(
        otherDialog.getByRole("button", {
          name: "Retry same request",
          exact: true,
        }),
      ).toBeDisabled();
      await otherDialog
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(
        first.getByRole("button", { name: "Confirm deployment", exact: true }),
      ).toBeVisible();
      await receipt.getByRole("button", { name: "Close", exact: true }).click();
      await page
        .getByRole("button", { name: "Confirm deployment", exact: true })
        .click();
      await expect(confirmed()).toBeVisible();
      expect(await operation()).toEqual([]);
      await expect(
        first.getByRole("button", { name: "Confirm deployment", exact: true }),
      ).toHaveCount(0);
      expect(state.creates).toHaveLength(1);
      expect(state.rollbacks).toHaveLength(1);
    },
  );
  await check(
    "Legacy session migration and storage refusal preserve recoverability before any send",
    async () => {
      await load({ app: true });
      const old = syntheticOperation(302);
      await putOperation(page, old, true);
      await reloadApp();
      await expect(
        page.getByRole("button", { name: "Confirm deployment", exact: true }),
      ).toBeVisible();
      expect((await operation())[0].value).toEqual(old);
      expect(
        await page.evaluate(() =>
          Object.keys(sessionStorage).filter((k) =>
            k.startsWith("vectory:deployment-request:"),
          ),
        ),
      ).toEqual([]);
      expect(state.creates).toHaveLength(0);
      await load({ storageBlocked: true });
      await preview();
      await send();
      await expect(
        page
          .getByText(
            /Browser.*storage.*unavailable|could not.*save|cannot.*save/i,
          )
          .first(),
      ).toBeVisible();
      expect(state.creates).toHaveLength(0);
      expect(state.rollbacks).toHaveLength(0);
      await lost({ app: true, kind: "version" });
      await page.evaluate(() => {
        const remove = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function (key) {
          if (key.startsWith("vectory:deployment-operation:"))
            throw new DOMException(
              "Synthetic cleanup refusal",
              "SecurityError",
            );
          return remove.call(this, key);
        };
      });
      state.lookupMode = "normal";
      await recovery()
        .getByRole("button", { name: "Check status", exact: true })
        .click();
      await expect(
        confirmed().getByRole("link", { name: "View deployment", exact: true }),
      ).toBeVisible();
      await expect(confirmed()).toContainText(
        "could not clear its recovery reminder",
      );
      expect(await operation()).toHaveLength(1);
      expect(state.creates).toHaveLength(1);
    },
  );
  await check(
    "Persistent reminders and delayed discovery responses stay scoped to the signed-in actor",
    async () => {
      await load({ app: true, appRoute: "#/deployments?page=1" });
      const op = syntheticOperation(303);
      await putOperation(page, op);
      await expect(
        page.getByRole("button", { name: "Confirm deployment", exact: true }),
      ).toBeVisible();
      state.recentItems = [
        recentRow(1, { deployment_name: "Prior actor private request" }),
        recentRow(2, {
          actor: id(91),
          deployment_name: "Current actor request",
        }),
      ];
      state.recentMode = "hold";
      await openRecent();
      await expect.poll(() => state.holds.length).toBe(1);
      state.actor = id(91);
      state.recentMode = "normal";
      await remountApp();
      await expect(
        page.getByRole("button", { name: "Confirm deployment", exact: true }),
      ).toHaveCount(0);
      await openRecent();
      await expect(
        recent().getByRole("link", {
          name: "Current actor request",
          exact: true,
        }),
      ).toBeVisible();
      state.holds.splice(0).forEach((resolve) => resolve());
      await expect(recent()).not.toContainText("Prior actor private request");
      expect((await operation())[0].value.actor_id).toBe(id(90));
      state.role = "viewer";
      await remountApp();
      await expect(
        page.getByRole("heading", { name: "Deployments", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Your recent requests", exact: true }),
      ).toHaveCount(0);
      await expect(recent()).toHaveCount(0);
      expect(state.creates).toHaveLength(0);
    },
  );
  await check(
    "Recent requests page globally, filter and link exact scheduled and rollback results without replay",
    async () => {
      await load({
        app: true,
        appRoute: "#/deployments?search=unrelated&status=failed&page=3",
      });
      state.recentItems = Array.from({ length: 25 }, (_, n) =>
        recentRow(n + 1),
      );
      state.recentItems[0] = recentRow(1, {
        deployment_name: null,
        resource: "policy",
        configuration_name: null,
        version_number: null,
        scheduled_at: "2030-01-01T12:30:00Z",
      });
      state.recentItems[1] = recentRow(2, {
        operation: "rollback",
        source_deployment_id: id(80),
      });
      await openRecent();
      await expect(
        recent()
          .getByRole("table", { name: "Your saved requests", exact: true })
          .locator("tbody tr"),
      ).toHaveCount(12);
      await expect(
        recent().getByRole("link", { name: "Agent settings", exact: true }),
      ).toHaveAttribute("href", `#/schedules/${id(2001)}?page=1`);
      await expect(
        recent().getByRole("link", { name: "Original rollout", exact: true }),
      ).toHaveAttribute("href", `#/deployments/${id(80)}?page=1`);
      await recent().getByRole("button", { name: "Next", exact: true }).click();
      await expect.poll(() => state.recentReads.at(-1).query.page).toBe("2");
      await expect(
        recent().getByRole("link", {
          name: "Synthetic request 13",
          exact: true,
        }),
      ).toBeVisible();
      await recent()
        .getByLabel("Request type", { exact: true })
        .selectOption("rollback");
      await expect
        .poll(() => state.recentReads.at(-1).query)
        .toEqual({ operation: "rollback", page: "1", page_size: "12" });
      await expect(
        recent().getByRole("link", {
          name: "Synthetic request 2",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        recent().getByRole("button", {
          name: "Retry same request",
          exact: true,
        }),
      ).toHaveCount(0);
      await recent()
        .getByRole("link", { name: "Synthetic request 2", exact: true })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`#/deployments/${id(2002)}\\?page=1$`),
      );
      await expect(
        page.getByRole("region", { name: "Deployment details", exact: true }),
      ).toBeVisible();
      expect(state.creates).toHaveLength(0);
      expect(state.rollbacks).toHaveLength(0);
    },
  );
  await check(
    "Discovery failures, deadlines, stale filters and older servers stay read-only and recoverable",
    async () => {
      await load({ app: true, appRoute: "#/deployments?page=1" });
      state.recentMode = "hold";
      await page.clock.install();
      await openRecent();
      await expect.poll(() => state.holds.length).toBe(1);
      await page.clock.fastForward(30001);
      await expect(
        recent().getByText(/response is taking too long/),
      ).toBeVisible();
      expect(state.recentReads).toHaveLength(1);
      state.recentMode = "normal";
      state.recentItems = [
        recentRow(1),
        recentRow(2, { operation: "rollback", source_deployment_id: id(80) }),
      ];
      await recent()
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(
        recent().getByRole("link", {
          name: "Synthetic request 1",
          exact: true,
        }),
      ).toBeVisible();
      state.holds.splice(0).forEach((resolve) => resolve());
      state.recentMode = "hold";
      await recent()
        .getByLabel("Request type", { exact: true })
        .selectOption("create");
      await expect.poll(() => state.holds.length).toBe(1);
      state.recentMode = "normal";
      await recent()
        .getByLabel("Request type", { exact: true })
        .selectOption("rollback");
      await expect(
        recent().getByRole("link", {
          name: "Synthetic request 2",
          exact: true,
        }),
      ).toBeVisible();
      state.holds.splice(0).forEach((resolve) => resolve());
      await expect(recent()).not.toContainText("Synthetic request 1");
      expect(state.creates).toHaveLength(0);
      expect(state.rollbacks).toHaveLength(0);
      await load({ app: true, appRoute: "#/deployments?page=1" });
      state.requestHistory = false;
      await remountApp();
      await expect(
        page.getByRole("heading", { name: "Deployments", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Your recent requests", exact: true }),
      ).toHaveCount(0);
      expect(state.recentReads).toHaveLength(0);
    },
  );
  await check(
    "Recovery discovery fits desktop and mobile themes with keyboard focus and accessible tables",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await load({
            app: true,
            appRoute: "#/deployments?page=1",
            width,
            theme,
          });
          state.recentItems = [
            recentRow(1),
            recentRow(2, {
              operation: "rollback",
              source_deployment_id: id(80),
            }),
          ];
          await openRecent();
          await expect(
            recent().getByRole("link", {
              name: "Synthetic request 1",
              exact: true,
            }),
          ).toBeVisible();
          const box = await recent().boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width + 1);
          const scan = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
          accessibility.push({
            width,
            theme,
            surface: "recent",
            violations: scan.violations.map((v) => ({
              id: v.id,
              targets: v.nodes.map((n) => n.target),
            })),
          });
          expect(scan.violations).toEqual([]);
          await page.screenshot({
            path: resolve(output, `recent-${width}-${theme}.png`),
          });
          await page.keyboard.press("Escape");
          await expect(recent()).toHaveCount(0);
          await expect(
            page.getByRole("button", {
              name: "Your recent requests",
              exact: true,
            }),
          ).toBeFocused();
          if (
            (width === 899 && theme === "light") ||
            (width === 375 && theme === "dark")
          ) {
            await putOperation(page, syntheticOperation(304));
            await putOperation(page, syntheticOperation(305, "rollback"));
            await page
              .getByRole("button", { name: "Review requests", exact: true })
              .click();
            await expect(queue()).toBeVisible();
            const a = await new AxeBuilder({ page })
              .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
              .analyze();
            accessibility.push({
              width,
              theme,
              surface: "pending_queue",
              violations: a.violations.map((v) => ({
                id: v.id,
                targets: v.nodes.map((n) => n.target),
              })),
            });
            expect(a.violations).toEqual([]);
            await page.screenshot({
              path: resolve(output, `queue-${width}-${theme}.png`),
            });
            const review = page.getByRole("button", {
              name: "Review requests",
              exact: true,
            });
            await page.keyboard.press("Escape");
            await expect(queue()).toHaveCount(0);
            await expect(review).toBeFocused();
            await page.keyboard.press("Enter");
            const choice = queue().getByRole("button", {
              name: /Synthetic rollback request 305/,
            });
            await choice.focus();
            await page.keyboard.press("Enter");
            const rollback = page.getByRole("dialog", {
              name: "Confirm rollback",
              exact: true,
            });
            await expect(rollback).toContainText(
              "No completed request was found yet",
            );
            await expect
              .poll(() =>
                rollback.evaluate((element) =>
                  element.contains(document.activeElement),
                ),
              )
              .toBe(true);
            await expect(queue()).toHaveCount(0);
            await rollback
              .getByRole("button", { name: "Close", exact: true })
              .click();
            await expect(review).toBeFocused();
            await page.keyboard.press("Enter");
            await expect(queue()).toBeVisible();
            const originalPage = page;
            const peer = await newAppPage("#/deployments?page=1");
            page = originalPage;
            await peer.evaluate(() => {
              for (const key of Object.keys(localStorage))
                if (key.startsWith("vectory:deployment-operation:"))
                  localStorage.removeItem(key);
            });
            await expect(queue()).toHaveCount(0);
            await expect(review).toHaveCount(0);
            await expect(page.locator("#main-content")).toBeFocused();
            await peer.close();
          }
          expect(state.creates).toHaveLength(0);
          expect(state.rollbacks).toHaveLength(0);
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
    "src/deploymentRequests.ts",
    "src/deploymentReceipt.ts",
    "src/DeploymentRecovery.tsx",
    "src/RecentDeploymentRequests.tsx",
    "src/Deployments.tsx",
    "src/deployment-recovery.css",
    "src/App.tsx",
    "src/Editor.tsx",
    "src/Control.tsx",
    "src/Fleet.tsx",
    "src/deploymentRouting.ts",
    "src/api.ts",
    "src/control.css",
    "tests/deployment-discovery-browser.mjs",
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
          "Actual TargetDialog/recovery and App using intercepted synthetic API and an in-memory actor/request-ID replay fixture. Does not prove real SQL idempotency or activation. No live sessions, native processes or real mutations.",
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
