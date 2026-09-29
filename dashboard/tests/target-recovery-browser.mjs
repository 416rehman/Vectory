// Actual fleet/settings/review components; all HTTP is intercepted synthetic data.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import net from "node:net";
import { createHash } from "node:crypto";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_TARGET_RECOVERY_OUTPUT || ".local/target-recovery",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:target-recovery";
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
      name: "isolated-target-recovery",
      resolveId(id) {
        if (id === "virtual:target-recovery") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import TargetDialog from'/src/TargetDialog.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';setCSRF('synthetic');const root=createRoot(document.getElementById('root'));let key=0;window.mount=(name,props={})=>{window.notices=[];window.fixtureClosed=false;root.render(name==='app'?React.createElement(App,{key:++key}):React.createElement(TargetDialog,{key:++key,onDone:x=>window.notices.push(x),onClose:()=>window.fixtureClosed=true,...props}));};window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__target-recovery") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic table verification</title></head><body><div id="root"></div><script type="module">import "virtual:target-recovery";</script></body></html>',
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
function correlatedReceipt(record) {
  return {
    selector: { device_ids: [id(1), id(2)], group_ids: [], exclude_ids: [] },
    rollout: {
      kind: "all",
      canary_size: 1,
      batch_size: 1,
      observation_seconds: 0,
      failure_threshold: 0,
    },
    request_correlation: true,
    ...record.result,
    request_id: record.body.request_id,
    operation: record.path ? "rollback" : "create",
    source_deployment_id: record.path ? record.path.split("/")[2] : null,
  };
}
function corruptCorrelation(value, fault) {
  const changed = structuredClone(value);
  const receipt = changed.found ? changed.deployment : changed;
  if (fault === "missing") {
    for (const field of ["request_id", "operation", "source_deployment_id"]) {
      delete changed[field];
      delete receipt[field];
    }
  } else if (fault === "key") {
    changed.request_id = id(998);
    receipt.request_id = id(998);
  } else if (fault === "kind") {
    changed.operation = receipt.operation === "create" ? "rollback" : "create";
    receipt.operation = changed.operation;
  } else if (fault === "source") {
    changed.source_deployment_id = id(997);
    receipt.source_deployment_id = id(997);
  } else if (fault === "inner") {
    receipt.request_id = id(998);
  } else if (fault === "unrelated") {
    receipt.id = id(999);
    changed.request_id = id(998);
    receipt.request_id = id(998);
    changed.operation = receipt.operation === "create" ? "rollback" : "create";
    receipt.operation = changed.operation;
    changed.source_deployment_id = id(997);
    receipt.source_deployment_id = id(997);
  } else if (fault === "source-result") {
    receipt.id = id(40);
  }
  return changed;
}

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
  correlationObservations = [],
  cleanupObservations = [],
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
    correlationSupported: true,
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
      if (path.startsWith("/deployments/requests/")) {
        const requestId = path.split("/").pop();
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
          (x) => x.actor === current.actor && x.body.request_id === requestId,
        );
        const answer = match
          ? {
              found: true,
              request_id: requestId,
              operation: correlatedReceipt(match).operation,
              source_deployment_id:
                correlatedReceipt(match).source_deployment_id,
              deployment: correlatedReceipt(match),
            }
          : { found: false, request_id: requestId };
        if (current.correlationStage === "lookup") {
          current.substituted = corruptCorrelation(
            answer,
            current.correlationFault,
          );
          return reply(current.substituted);
        }
        return reply(answer);
      }
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: current.actor,
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
      return reply({
        devices: current.devices.filter((d) => selected.has(d.id)),
        ...(!current.legacyPreview
          ? {
              create_idempotency: true,
              ...(current.correlationSupported
                ? { request_correlation: true }
                : {}),
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
    if (method === "POST" && path === "/deployments") {
      expect(req.headers()["x-csrf-token"]).toBe("synthetic");
      const body = req.postDataJSON();
      current.creates.push(body);
      if (current.initialRejection && current.creates.length === 1) {
        const status = current.initialRejection;
        await new Promise((resolve) => current.holds.push(resolve));
        return reply(
          {
            error: {
              code: status === 403 ? "FORBIDDEN" : "INVALID_INPUT",
              message:
                "Synthetic initial request rejected. This intentionally long, synthetic server explanation verifies that the earlier attempt remains readable at narrow widths while request status is unavailable. It contains no real account, device, credential or production details.",
            },
          },
          status,
        );
      }
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
      const response = correlatedReceipt({ body, result });
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
      if (current.correlationStage === "post") {
        current.substituted = corruptCorrelation(
          response,
          current.correlationFault,
        );
        return reply(current.substituted);
      }
      return reply(response);
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
      "/__target-recovery" +
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
  if (!app && !storageBlocked)
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
  const focus = process.env.VECTORY_TARGET_RECOVERY_FOCUS;
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
// When an assignment outranks some reviewed devices, the dialog names the
// devices it changes ("Apply to 1 of 2 devices") and asks first what stays.
async function send(name = "Apply settings") {
  const kept = page.locator(".target-left-behind input[type=checkbox]");
  if (await kept.count()) {
    await kept.check();
    if (name !== "Schedule deployment")
      name = new RegExp(
        `^${name === "Apply settings" ? "Apply" : "Deploy"} to \\d+ of \\d+ devices$`,
      );
  }
  await page
    .getByRole("button", { name, exact: typeof name === "string" })
    .click();
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
try {
  await check(
    "Correlation rejects wrong keyed POST receipts without losing the frozen request",
    async () => {
      for (const fault of ["unrelated", "key", "kind", "source", "missing"]) {
        await load({ app: true, kind: "pipeline" });
        await page
          .getByRole("button", { name: "Choose devices", exact: true })
          .click();
        await preview();
        state.correlationStage = "post";
        state.correlationFault = fault;
        state.lookupMode = "failed";
        await send("Deploy to devices");
        await expect(recovery()).toBeVisible();
        await expect(recovery()).toContainText("Synthetic lookup unavailable");
        await expect(recovery()).toContainText(
          /identity|different deployment request|does not match this dashboard/i,
        );
        const saved = (await operation())[0].value;
        expect(saved.id).toBe(state.creates[0].request_id);
        expect(await operation()).toHaveLength(1);
        expect(state.creates).toHaveLength(1);
        expect(state.committed).toHaveLength(1);
        await expect(page.locator('a[href*="' + id(999) + '"]')).toHaveCount(0);
        if (fault === "unrelated") {
          const scan = await new AxeBuilder({ page }).analyze();
          expect(scan.violations).toEqual([]);
          accessibility.push({
            case: "correlation-post",
            width: 899,
            theme: "light",
            violations: scan.violations,
          });
          await page.screenshot({
            path: resolve(output, "correlation-post-899-light.png"),
          });
        }
        correlationObservations.push({
          stage: "post",
          fault,
          request_id: saved.id,
          reminder_preserved: true,
          post_count: 1,
          substituted_response: structuredClone(state.substituted),
        });
        state.correlationStage = null;
        state.lookupMode = "normal";
        await recovery()
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await expect(confirmed()).toBeVisible();
        await expect(
          confirmed().getByRole("link", {
            name: "View deployment",
            exact: true,
          }),
        ).toHaveAttribute("href", `#/deployments/${id(40)}?page=1`);
        expect(await operation()).toEqual([]);
        expect(state.creates).toHaveLength(1);
      }
    },
  );
  await check(
    "Correlation rejects wrong lookup envelopes and nested receipts then accepts only exact identity",
    async () => {
      for (const fault of [
        "unrelated",
        "key",
        "kind",
        "source",
        "missing",
        "inner",
      ]) {
        await lost({ app: true, kind: "pipeline" });
        const saved = (await operation())[0].value;
        state.lookupMode = "normal";
        state.correlationStage = "lookup";
        state.correlationFault = fault;
        await recovery()
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await expect(recovery()).toContainText(
          /identity|different deployment request|does not match this dashboard/i,
        );
        await expect(
          recovery().getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeDisabled();
        expect((await operation())[0].value).toEqual(saved);
        expect(state.creates).toHaveLength(1);
        await expect(confirmed()).toHaveCount(0);
        await expect(page.locator('a[href*="' + id(999) + '"]')).toHaveCount(0);
        if (fault === "unrelated") {
          await page.setViewportSize({ width: 375, height: 920 });
          await page.evaluate(
            () => (document.documentElement.dataset.theme = "dark"),
          );
          const scan = await new AxeBuilder({ page }).analyze();
          expect(scan.violations).toEqual([]);
          accessibility.push({
            case: "correlation-lookup",
            width: 375,
            theme: "dark",
            violations: scan.violations,
          });
          await page.screenshot({
            path: resolve(output, "correlation-lookup-375-dark.png"),
          });
        }
        correlationObservations.push({
          stage: "lookup",
          fault,
          request_id: saved.id,
          reminder_preserved: true,
          post_count: 1,
          substituted_response: structuredClone(state.substituted),
        });
        state.correlationStage = null;
        await recovery()
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await expect(confirmed()).toBeVisible();
        expect(await operation()).toEqual([]);
        expect(state.creates).toHaveLength(1);
      }
    },
  );
  await check(
    "Correlation requires an exact absent-result echo before frozen retry and rechecks after incompatibility",
    async () => {
      await lost({ app: true, kind: "pipeline", mode: "uncommitted" });
      const saved = (await operation())[0].value;
      for (const fault of ["key", "missing"]) {
        state.lookupMode = "normal";
        state.correlationStage = "lookup";
        state.correlationFault = fault;
        await recovery()
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await expect(recovery()).toContainText(
          /identity|different deployment request|does not match this dashboard/i,
        );
        await expect(
          recovery().getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeDisabled();
        expect((await operation())[0].value).toEqual(saved);
        expect(state.creates).toHaveLength(1);
        state.correlationStage = null;
        await recovery()
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await expect(
          recovery().getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeEnabled();
      }
      state.createMode = "normal";
      state.correlationStage = "post";
      state.correlationFault = "key";
      await recovery()
        .getByRole("button", { name: "Retry same request", exact: true })
        .click();
      await expect(recovery()).toContainText(/different deployment request/i);
      expect((await operation())[0].value).toEqual(saved);
      expect(state.creates).toHaveLength(2);
      expect(state.creates[0]).toEqual(state.creates[1]);
      await expect(
        recovery().getByRole("button", {
          name: "Retry same request",
          exact: true,
        }),
      ).toBeDisabled();
      state.correlationStage = null;
      await recovery()
        .getByRole("button", { name: "Check status", exact: true })
        .click();
      await expect(confirmed()).toBeVisible();
      expect(state.committed).toHaveLength(1);
      expect(state.creates).toHaveLength(2);
    },
  );
  await check(
    "Correlation accepts the current mutable result for the exact original request",
    async () => {
      await lost({ app: true, kind: "pipeline" });
      const saved = (await operation())[0].value;
      Object.assign(state.committed[0].result, {
        version_id: id(211),
        priority: 350,
        status: "cancelled",
        target_mode: "persistent",
        targets: [{ device_id: id(3), state: "removed", generation: 9 }],
      });
      state.lookupMode = "normal";
      await recovery()
        .getByRole("button", { name: "Check status", exact: true })
        .click();
      await expect(confirmed()).toBeVisible();
      await expect(
        confirmed().getByRole("link", { name: "View deployment", exact: true }),
      ).toHaveAttribute("href", `#/deployments/${id(40)}?page=1`);
      expect(await operation()).toEqual([]);
      expect(state.creates).toHaveLength(1);
      correlationObservations.push({
        stage: "current-result",
        request_id: saved.id,
        current_snapshot_changed: true,
        original_result_id: state.committed[0].result.id,
        post_count: 1,
      });
    },
  );
  await check(
    "Cleanup retains keyed target rejection and peer-commit uncertainty",
    async () => {
      const before = process.env.VECTORY_RECOVERY_CLEANUP_BEFORE === "1";
      for (const status of [400, 403]) {
        for (const peerCommit of [false, true]) {
          await load();
          await preview();
          state.initialRejection = status;
          await send();
          await expect.poll(() => state.holds.length).toBe(1);
          const originalPage = page;
          const saved = (await operation())[0].value;
          let peer;
          if (peerCommit) {
            // Invoke the production pagehide lease release: it cannot cancel a
            // POST already at the server. The peer still uses actual recovery UI.
            await page.evaluate(() =>
              window.dispatchEvent(new Event("pagehide")),
            );
            peer = await context.newPage();
            peer.setDefaultTimeout(7000);
            await peer.goto(origin + "/__target-recovery");
            await peer.waitForFunction(() => window.ready);
            await peer.evaluate(
              ({ policy, actor }) =>
                window.mount("target", {
                  open: true,
                  policy,
                  userId: actor,
                }),
              { policy, actor: id(90) },
            );
            page = peer;
            await expect(
              recovery().getByRole("button", {
                name: "Retry same request",
                exact: true,
              }),
            ).toBeEnabled();
            state.createMode = "lost";
            await recovery()
              .getByRole("button", { name: "Retry same request", exact: true })
              .click();
            await expect.poll(() => state.committed.length).toBe(1);
            await expect
              .poll(() =>
                peer.evaluate(
                  () =>
                    Object.keys(localStorage).filter((key) =>
                      key.startsWith("vectory:deployment-operation-lease:"),
                    ).length,
                ),
              )
              .toBe(0);
            expect(state.creates).toHaveLength(2);
            expect(state.creates.map((x) => x)).toEqual([
              saved.request,
              saved.request,
            ]);
            page = originalPage;
          }
          state.lookupMode = "failed";
          state.holds.shift()();
          if (before) {
            await expect(page.getByRole("dialog")).toContainText(
              "Synthetic initial request rejected",
            );
            await expect.poll(async () => (await operation()).length).toBe(0);
          } else {
            await expect(recovery()).toBeVisible();
            await expect(recovery()).toContainText(
              "Synthetic lookup unavailable",
            );
            await expect(recovery()).toContainText("Previous attempt");
            await expect(recovery()).toContainText(
              "Synthetic initial request rejected",
            );
            if (status === 400 && peerCommit) {
              for (const [width, theme] of [
                [375, "dark"],
                [899, "light"],
              ]) {
                await page.setViewportSize({ width, height: 920 });
                await page.evaluate((theme) => {
                  document.documentElement.dataset.theme = theme;
                }, theme);
                const screenshot =
                  "docs/screenshots/shared-request-target-" +
                  width +
                  "-" +
                  theme +
                  ".png";
                await mkdir(resolve(root, "docs/screenshots"), {
                  recursive: true,
                });
                await page.screenshot({
                  path: resolve(root, screenshot),
                  fullPage: true,
                });
                const bounds = await recovery().boundingBox();
                expect(bounds.x).toBeGreaterThanOrEqual(0);
                expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
                measurements.push({
                  stage: "long previous rejection with unavailable lookup",
                  width,
                  theme,
                  screenshot,
                  bounds,
                });
              }
            }
            expect((await operation())[0].value).toEqual(saved);
            state.lookupMode = "normal";
            await recovery()
              .getByRole("button", { name: "Check status", exact: true })
              .click();
            if (peerCommit) {
              await expect(confirmed()).toBeVisible();
              expect(await operation()).toEqual([]);
            } else {
              await expect(
                recovery().getByRole("button", {
                  name: "Retry same request",
                  exact: true,
                }),
              ).toBeEnabled();
              state.createMode = "normal";
              await recovery()
                .getByRole("button", {
                  name: "Retry same request",
                  exact: true,
                })
                .click();
              await expect(confirmed()).toBeVisible();
              expect(state.creates.map((x) => x)).toEqual([
                saved.request,
                saved.request,
              ]);
            }
          }
          if (!before)
            await expect(confirmed()).not.toContainText(
              "Synthetic initial request rejected",
            );
          cleanupObservations.push({
            original_rejection_visible_during_uncertainty: !before,
            original_rejection_hidden_after_confirmation: !before,
            status,
            peer_commit: peerCommit,
            expected_defect_before: before,
            operation: saved,
            posts: structuredClone(state.creates),
            post_count: state.creates.length,
            committed_count: state.committed.length,
            lookups: structuredClone(state.lookups),
            reminder_count_after: (await operation()).length,
            peer_result_recovered_by_read_only_lookup: !before && peerCommit,
          });
          if (peer) await peer.close();
        }
      }
    },
  );
  await check(
    "Lost committed response resolves its original ID; no resend or changed scope",
    async () => {
      await lost();
      expect(state.creates).toHaveLength(1);
      expect(state.committed).toHaveLength(1);
      const saved = (await operation())[0].value;
      expect(saved.request).toEqual(state.creates[0]);
      expect(saved.actor_id).toBe(id(90));
      expect(saved.request.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(saved)).not.toMatch(
        /csrf|password|cookie|authorization/i,
      );
      state.lookupMode = "normal";
      await recovery()
        .getByRole("button", { name: "Check status", exact: true })
        .click();
      await expect(
        confirmed().getByRole("link", { name: "View deployment", exact: true }),
      ).toHaveAttribute("href", `#/deployments/${id(40)}?page=1`);
      expect(state.creates).toHaveLength(1);
      expect(await operation()).toEqual([]);
    },
  );
  await check(
    "Unreadable and malformed successful responses reconcile without a second create",
    async () => {
      for (const mode of [
        "unparseable",
        "malformed",
        "unreadable400",
        "errorShape400",
      ]) {
        await lost({ mode });
        state.lookupMode = "normal";
        await recovery()
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await expect(confirmed()).toBeVisible();
        expect(state.creates).toHaveLength(1);
        expect(state.committed).toHaveLength(1);
      }
    },
  );
  await check(
    "Unknown uncommitted result retries the identical frozen operation and guards held retry",
    async () => {
      await lost({ mode: "uncommitted" });
      const before = structuredClone(state.creates[0]);
      state.lookupMode = "normal";
      await recovery()
        .getByRole("button", { name: "Check status", exact: true })
        .click();
      await expect(recovery()).toContainText(
        "No completed request was found yet",
      );
      expect(state.committed).toHaveLength(0);
      state.createMode = "forbidden";
      await recovery()
        .getByRole("button", { name: "Retry same request", exact: true })
        .click();
      await expect(recovery()).toContainText("Synthetic access changed");
      expect((await operation())[0].value.request).toEqual(before);
      expect(state.creates).toHaveLength(2);
      state.devices[0].name = "Changed fleet display";
      state.createMode = "normal";
      state.holdCreate = true;
      await recovery()
        .getByRole("button", { name: "Check status", exact: true })
        .click();
      await recovery()
        .getByRole("button", { name: "Retry same request", exact: true })
        .click();
      await expect.poll(() => state.holds.length).toBe(1);
      await page.keyboard.press("Escape");
      await expect(recovery()).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            !window.dispatchEvent(
              new Event("vectory:before-navigate", { cancelable: true }),
            ),
        ),
      ).toBe(true);
      expect(state.creates).toHaveLength(3);
      expect(state.creates[1]).toEqual(before);
      expect(state.creates[2]).toEqual(before);
      state.holds.shift()();
      await expect(confirmed()).toBeVisible();
      expect(state.committed).toHaveLength(1);
    },
  );
  await check(
    "Structured rejection and server failure remain recoverable with the same ID",
    async () => {
      await load();
      await preview();
      state.createMode = "definite400";
      await send();
      await expect(recovery()).toBeVisible();
      await expect(recovery()).toContainText(
        "No completed request was found yet",
      );
      expect(await operation()).toHaveLength(1);
      expect(state.committed).toHaveLength(0);
      state.createMode = "normal";
      await recovery()
        .getByRole("button", { name: "Retry same request", exact: true })
        .click();
      await expect(confirmed()).toBeVisible();
      expect(state.creates[0]).toEqual(state.creates[1]);
      await lost({ mode: "server500" });
      const request = structuredClone(state.creates[0]);
      state.createMode = "normal";
      state.lookupMode = "normal";
      await recovery()
        .getByRole("button", { name: "Check status", exact: true })
        .click();
      await recovery()
        .getByRole("button", { name: "Retry same request", exact: true })
        .click();
      await expect(confirmed()).toBeVisible();
      expect(state.creates[1]).toEqual(request);
    },
  );
  await check(
    "Legacy capability absence blocks first send and unkeyed reminders remain history-only",
    async () => {
      for (const absent of ["legacyPreview", "correlationSupported"]) {
        await load();
        state[absent] = absent === "legacyPreview";
        await preview();
        await expect(page.getByRole("dialog")).toContainText(
          "Update the server",
        );
        // Synthetic alpha's own settings outrank these when outcomes exist.
        await expect(
          page.getByRole("button", {
            name: /^Apply (settings|to 1 of 2 devices)$/,
          }),
        ).toBeDisabled();
        expect(state.creates).toHaveLength(0);
        expect(state.lookups).toHaveLength(0);
        expect(await operation()).toEqual([]);
      }
      await load({ app: true, kind: "pipeline" });
      const record = {
        kind: "create",
        actor_id: id(90),
        id: id(97),
        label: "Older unkeyed deployment",
        recorded_at: created,
        retry_supported: false,
        request: {
          policy,
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
      };
      await page.evaluate(
        (record) =>
          localStorage.setItem(
            `vectory:deployment-operation:${record.actor_id}:${record.id}`,
            JSON.stringify(record),
          ),
        record,
      );
      await reloadApp();
      await page
        .getByRole("button", { name: "Confirm deployment", exact: true })
        .click();
      await expect(recovery()).toContainText("cannot safely retry");
      await expect(
        recovery().getByRole("button", {
          name: "Retry same request",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        recovery().getByRole("button", { name: "Check status", exact: true }),
      ).toHaveCount(0);
      expect(state.creates).toHaveLength(0);
      expect(state.lookups).toHaveLength(0);
      await recovery()
        .getByRole("button", { name: "Dismiss reminder", exact: true })
        .click();
      const dismiss = page.getByRole("dialog", {
        name: "Dismiss this reminder?",
        exact: true,
      });
      await expect(dismiss).toContainText("does not cancel");
      await dismiss.getByRole("button", { name: "Back", exact: true }).click();
      expect(await operation()).toHaveLength(1);
    },
  );
  await check(
    "Actual App close/reload retains reminder, isolates signed-in actors, and resolves the original receipt",
    async () => {
      await lost({ app: true, kind: "version" });
      const original = structuredClone(state.creates[0]);
      await recovery()
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(recovery()).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Confirm deployment", exact: true }),
      ).toBeVisible();
      await reloadApp();
      expect(state.creates).toHaveLength(1);
      await expect(
        page.getByRole("button", { name: "Confirm deployment", exact: true }),
      ).toBeVisible();
      state.actor = id(91);
      await reloadApp();
      await expect(
        page.getByRole("button", { name: "Confirm deployment", exact: true }),
      ).toHaveCount(0);
      expect(state.creates).toHaveLength(1);
      expect(state.lookups.every((x) => x.actor === id(90))).toBe(true);
      state.actor = id(90);
      await reloadApp();
      state.lookupMode = "normal";
      await page
        .getByRole("button", { name: "Confirm deployment", exact: true })
        .click();
      await expect(confirmed()).toBeVisible();
      expect(state.creates).toEqual([original]);
      expect(await operation()).toEqual([]);
    },
  );
  await check(
    "Canary admission blockers stop creation and link the exact blocking rollout",
    async () => {
      await load();
      state.blockers = [
        {
          deployment_id: id(83),
          device_ids: [id(1)],
          resource: "policy",
          code: "ACTIVE_CANARY_OVERLAP",
          reason:
            "An active canary overlaps these targets; pause or cancel it before superseding",
        },
      ];
      await preview();
      await expect(
        page.getByText(/An active canary overlaps these devices/).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Apply settings", exact: true }),
      ).toBeDisabled();
      await expect(
        page.locator(`a[href="#/deployments/${id(83)}?page=1"]`),
      ).toBeVisible();
      expect(state.creates).toHaveLength(0);
    },
  );
  await check(
    "Full-mode capability note explains non-loopback API without asking already-full devices to change modes",
    async () => {
      await load({
        kind: "version",
        extra: {
          version: {
            ...version,
            config: {
              ...config,
              api: { enabled: true, address: "0.0.0.0:8686" },
            },
          },
        },
      });
      // Before anyone is chosen the note says what the version needs.
      await expect(
        dialog().getByText("This version needs Full Vector mode", { exact: true }),
      ).toBeVisible();
      await expect(dialog().getByText(/API listener outside loopback/)).toBeVisible();
      await expect(dialog().getByText(/All selected devices/)).toHaveCount(0);
      await page
        .getByRole("checkbox", { name: "Select Synthetic alpha", exact: true })
        .check();
      await expect(
        dialog().getByText("This pipeline uses full Vector capabilities", { exact: true }),
      ).toBeVisible();
      await expect(dialog().getByText(/API listener outside loopback/)).toBeVisible();
      await expect(dialog().getByText(/All selected devices currently report full Vector mode/)).toBeVisible();
      await expect(dialog().getByText(/have the host operator enable it/)).toHaveCount(0);
      await preview();
      await expect(dialog().getByRole("button", { name: "Deploy to devices" })).toBeEnabled();
      expect(state.creates).toHaveLength(0);
    },
  );
  await check(
    "Compatibility blockers name affected devices and never masquerade as canary overlap",
    async () => {
      await load({
        kind: "version",
        width: 375,
        extra: {
          version: {
            ...version,
            config: {
              ...config,
              api: { enabled: true, address: "0.0.0.0:8686" },
            },
          },
        },
        devices: [
          device(1, { configuration_mode: "restricted", vector_version: "0.57.0" }),
          device(2, { vector_version: "0.57.0" }),
        ],
      });
      const fullModeReason =
        "This published configuration requires full Vector mode on the selected device. Only its host operator can enable that mode locally.";
      const versionReason =
        "The selected device does not report the required Vector 0.58.0 version. Review its local Vector installation before deploying.";
      state.blockers = [
        {
          code: "FULL_VECTOR_MODE_REQUIRED",
          reason: fullModeReason,
          resource: "configuration",
          device_ids: [id(1)],
        },
        {
          code: "VECTOR_VERSION_INCOMPATIBLE",
          reason: versionReason,
          resource: "configuration",
          device_ids: [id(1), id(2)],
        },
      ];
      await preview();
      await expect(
        dialog().getByText("Synthetic alpha runs in restricted mode and will refuse this version", { exact: true }),
      ).toBeVisible();
      await expect(dialog().getByText(/API listener outside loopback/)).toBeVisible();
      await expect(dialog().getByText(/have the host operator enable it/)).toBeVisible();
      await expect(
        dialog().getByText("Full Vector mode is required on these devices", { exact: true }),
      ).toBeVisible();
      await expect(dialog().getByText(fullModeReason)).toBeVisible();
      await expect(
        dialog().getByText("1 affected device: Synthetic alpha."),
      ).toBeVisible();
      await expect(
        dialog().getByText("These devices have an incompatible Vector version", { exact: true }),
      ).toBeVisible();
      await expect(dialog().getByText(versionReason)).toBeVisible();
      await expect(
        dialog().getByText("2 affected devices: Synthetic alpha, Synthetic beta."),
      ).toBeVisible();
      const alpha = table().locator("tbody tr").filter({ hasText: "Synthetic alpha" });
      const beta = table().locator("tbody tr").filter({ hasText: "Synthetic beta" });
      await expect(alpha).toContainText("Blocked: Full Vector mode required; Vector version incompatible");
      await expect(beta).toContainText("Blocked: Vector version incompatible");
      // A device the server won't release to is "Blocked", never a green "New".
      await expect(alpha.locator(".target-outcome")).toContainText("Blocked");
      await expect(alpha.locator(".target-outcome")).not.toContainText("New");
      await expect(beta.locator(".target-outcome")).toContainText("Blocked");
      await expect(beta.locator(".target-outcome")).toContainText(
        "Vector version incompatible",
      );
      await expect(
        dialog().getByRole("link", { name: "View active canary" }),
      ).toHaveCount(0);
      await expect(
        dialog().getByRole("button", { name: "Deploy to devices" }),
      ).toBeDisabled();
      expect(state.creates).toHaveLength(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(375);
      const scan = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      accessibility.push({
        label: "compatibility blockers at 375px",
        violations: scan.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
      });
      expect(scan.violations).toEqual([]);
      await page.screenshot({
        path: resolve(output, "compatibility-blockers-375.png"),
        fullPage: true,
        animations: "disabled",
      });
      await alpha.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(output, "compatibility-review-rows-375.png"),
        animations: "disabled",
      });
    },
  );
  await check(
    "Unavailable durable browser storage blocks sending before any create",
    async () => {
      await load({ storageBlocked: true });
      await expect(
        page.getByRole("dialog", { name: "Review saved deployment reminder" }),
      ).toBeVisible();
      await expect(page.getByText(/Browser storage is unavailable/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Review deployment" })).toHaveCount(0);
      expect(state.creates).toHaveLength(0);
    },
  );
  await check(
    "Recovery and scheduled confirmation fit 899/375 light/dark with accessible controls",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await lost({ width, theme, kind: "version", scheduled: true });
          for (const stage of ["uncertain", "confirmed"]) {
            if (stage === "confirmed") {
              state.lookupMode = "normal";
              await recovery()
                .getByRole("button", { name: "Check status", exact: true })
                .click();
              await expect(
                confirmed().getByRole("link", {
                  name: "View schedule",
                  exact: true,
                }),
              ).toHaveAttribute("href", `#/schedules/${id(40)}?page=1`);
            }
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
              path: resolve(
                output,
                `target-recovery-${stage}-${width}-${theme}.png`,
              ),
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
    "src/deploymentRequests.ts",
    "src/DeploymentRecovery.tsx",
    "src/deploymentReceipt.ts",
    "src/deployment-recovery.css",
    "src/App.tsx",
    "src/Editor.tsx",
    "src/Control.tsx",
    "src/Fleet.tsx",
    "src/deploymentRouting.ts",
    "src/api.ts",
    "src/control.css",
    "tests/target-recovery-browser.mjs",
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
        cleanup_observations: cleanupObservations,
        correlation_observations: correlationObservations,
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
