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
  process.env.VECTORY_CORRUPT_REMINDERS_OUTPUT ||
    ".local/deployment-corrupt-reminders",
);
await mkdir(output, { recursive: true });
const trackedSources = [
  "src/TargetDialog.tsx",
  "src/Deployments.tsx",
  "src/deploymentRequests.ts",
  "src/RollbackReviewPanel.tsx",
  "src/rollbackReview.ts",
  "src/DeploymentRecovery.tsx",
  "src/DeploymentStorageRecovery.tsx",
  "src/deployment-storage-recovery.css",
  "src/deploymentReceipt.ts",
  "src/deployment-recovery.css",
  "src/App.tsx",
  "src/Editor.tsx",
  "src/Control.tsx",
  "src/Fleet.tsx",
  "src/ui.tsx",
  "src/deploymentRouting.ts",
  "src/api.ts",
  "src/control.css",
  "tests/deployment-corrupt-reminders-browser.mjs",
];
const sourceAtStart = Object.fromEntries(
  await Promise.all(
    trackedSources.map(async (path) => [
      `dashboard/${path}`,
      createHash("sha256")
        .update(await readFile(resolve(dashboard, path)))
        .digest("hex"),
    ]),
  ),
);
const virtual = "\0virtual:rollback-recovery";
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
      name: "isolated-rollback-recovery",
      resolveId(id) {
        if (id === "virtual:rollback-recovery") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import TargetDialog from'/src/TargetDialog.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';setCSRF('synthetic');const root=createRoot(document.getElementById('root'));let key=0;window.mount=(name,props={})=>{window.notices=[];window.fixtureClosed=false;root.render(name==='app'?React.createElement(App,{key:++key}):React.createElement(TargetDialog,{key:++key,onDone:x=>window.notices.push(x),onClose:()=>window.fixtureClosed=true,...props}));};window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const stream = state?.streams?.get(req.url);
          if (stream) {
            state.streams.delete(req.url);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write(stream.slice(0, 5));
            state.bodyHolds.push(() => res.end(stream.slice(5)));
            res.on("close", () => {
              if (!res.writableEnded) state.abortedBodies++;
            });
            return;
          }
          if (req.url !== "/__rollback-recovery") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic table verification</title></head><body><div id="root"></div><script type="module">import "virtual:rollback-recovery";</script></body></html>',
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

const reviewToken = "a".repeat(64);
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
  app = true,
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
    role: "admin",
    rollbackSupported: true,
    rollbackReviewSupported: true,
    rollbackMode: "normal",
    rollbacks: [],
    streams: new Map(),
    bodyHolds: [],
    abortedBodies: 0,
    createMode: "normal",
    lookupMode: "normal",
    committed: [],
    lookups: [],
    completedLookups: [],
    blockers: [],
    previews: [],
    creates: [],
    holds: [],
    failCreate: false,
    holdCreate: false,
    holdPreview: false,
    conflicts: [],
    receipt: { version_id: version.id },
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
        const lookupActor = current.actor;
        if (!["admin", "operator"].includes(current.role))
          return reply(
            {
              error: {
                code: "FORBIDDEN",
                message: "Synthetic role cannot recover",
              },
            },
            403,
          );
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
          (x) => x.actor === lookupActor && x.body.request_id === requestId,
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
        if (current.lookupMode === "heldBody") {
          current.streams.set(url.pathname, JSON.stringify(answer));
          return route.continue();
        }
        await reply(answer);
        current.completedLookups.push({ requestId, actor: lookupActor });
        return;
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
          items: [],
          total: 0,
          page: Number(url.searchParams.get("page") || 1),
          page_size: 12,
        });
      if (path === `/deployments/${id(40)}/rollback-preview`)
        return reply({
          source_deployment_id: id(40),
          source_version_id: version.id,
          source_status: "active",
          source_action: "cancel",
          previous_version_id: version.id,
          previous_version_number: 1,
          previous_configuration_id: pipeline.id,
          previous_configuration_name: pipeline.name,
          priority: 101,
          eligible_devices: current.devices.map((d) => ({
            device_id: d.id,
            device_name: d.name,
            artifact_sha256: "a".repeat(64),
          })),
          excluded_devices: [],
          blockers: [],
          review_token: reviewToken,
          ready: true,
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
      const summaryMatch = /^\/deployments\/([^/]+)\/summary$/.exec(path);
      if (summaryMatch) {
        const deploymentId = summaryMatch[1];
        const replacement = current.committed.find(
          (x) => x.result.id === deploymentId,
        )?.result;
        return reply({
          id: deploymentId,
          name: replacement
            ? "Synthetic rollback replacement"
            : "Synthetic original deployment",
          configuration_id: pipeline.id,
          configuration_name: pipeline.name,
          version_id: version.id,
          version_number: replacement ? 1 : 2,
          policy: null,
          priority: replacement ? 101 : 100,
          target_mode: "snapshot",
          status: replacement
            ? "active"
            : current.rollbacks.length
              ? "cancelled"
              : "active",
          scheduled_at: null,
          created_at: created,
          rollout: { kind: "all" },
          target_count: 2,
          verified_count: 0,
          state_counts: { pending: 2 },
          ...(current.rollbackSupported ? { rollback_idempotency: true } : {}),
          ...(current.correlationSupported
            ? { request_correlation: true }
            : {}),
          ...(current.rollbackReviewSupported ? { rollback_review: true } : {}),
        });
      }
      if (/^\/deployments\/[^/]+\/targets$/.test(path))
        return reply({ items: [], total: 0, page: 1, page_size: 12 });
    }
    const rollbackMatch = /^\/deployments\/([^/]+)\/rollback$/.exec(path);
    if (method === "POST" && rollbackMatch) {
      expect(req.headers()["x-csrf-token"]).toBe("synthetic");
      const body = req.postDataJSON();
      current.rollbacks.push({ path, body: structuredClone(body) });
      if (current.initialRejection && current.rollbacks.length === 1) {
        const status = current.initialRejection;
        await new Promise((resolve) => current.holds.push(resolve));
        return reply(
          {
            error: {
              code: status === 403 ? "FORBIDDEN" : "INVALID_INPUT",
              message:
                "Synthetic initial rollback rejected. This intentionally long, synthetic server explanation verifies that the earlier attempt remains readable at narrow widths while request status is unavailable. It contains no real account, device, credential or production details.",
            },
          },
          status,
        );
      }
      if (current.rollbackMode === "definite400")
        return reply(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "Synthetic rollback rejected",
            },
          },
          400,
        );
      if (current.rollbackMode === "forbidden")
        return reply(
          { error: { code: "FORBIDDEN", message: "Synthetic role changed" } },
          403,
        );
      if (current.rollbackMode === "uncommitted") return route.abort("failed");
      const old = current.committed.find(
        (x) =>
          x.actor === current.actor &&
          x.body.request_id &&
          x.body.request_id === body.request_id,
      );
      if (old) {
        expect(old.path).toBe(path);
        expect(old.body).toEqual(body);
      }
      const result = old?.result || {
        id: id(50 + current.committed.length),
        version_id: version.id,
        priority: 101,
        status: "active",
        target_mode: "snapshot",
        created_at: created,
        targets: [
          { device_id: id(1), state: "desired", generation: 2 },
          { device_id: id(2), state: "desired", generation: 2 },
        ],
      };
      if (!old)
        current.committed.push({
          actor: current.actor,
          path,
          body: structuredClone(body),
          result,
        });
      const response = correlatedReceipt({ body, result, path });
      if (current.rollbackMode === "heldBody") {
        current.streams.set(url.pathname, JSON.stringify(response));
        return route.continue();
      }
      if (current.rollbackMode === "hold")
        await new Promise((resolve) => current.holds.push(resolve));
      if (current.rollbackMode === "lost") return route.abort("failed");
      if (current.rollbackMode === "unparseable")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{lost reply",
        });
      if (current.rollbackMode === "malformed") return reply({ id: "invalid" });
      if (current.correlationStage === "post") {
        current.substituted = corruptCorrelation(
          response,
          current.correlationFault,
        );
        return reply(current.substituted);
      }
      return reply(response);
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
      if (current.createMode === "heldBody") {
        current.streams.set(url.pathname, JSON.stringify(response));
        return route.continue();
      }
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
      return reply(response);
    }
    // The editor checks the draft as it opens; this fixture accepts it.
    if (method === "POST" && path === `/configurations/${pipeline.id}/validate`)
      return reply({
        valid: true,
        errors: [],
        warnings: [],
        vector_validated: false,
        deferred: true,
      });
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
  // A cold Vite transform on a busy host can outlast the 7 s action timeout.
  await page.goto(
    origin +
      "/__rollback-recovery" +
      (app ? `#/deployments/${id(40)}?page=1` : ""),
    { timeout: 60000 },
  );
  await page.waitForFunction(() => window.ready, undefined, { timeout: 30000 });
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
  // The routed deployment opens in its dialog once the page has loaded;
  // checks that leave it must not race that first render.
  else await expect(details()).toBeVisible();
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
  const focus = process.env.VECTORY_CORRUPT_REMINDERS_FOCUS;
  if (focus && !name.toLowerCase().includes(focus.toLowerCase())) return;
  const began = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - began });
  console.log("PASS", name);
}
const details = () =>
  page.getByRole("region", { name: "Deployment details", exact: true });
const rollbackConfirm = () =>
  page.getByRole("dialog", { name: "Review rollback", exact: true });
const recovery = () =>
  page.getByRole("dialog", { name: "Confirm rollback", exact: true });
const confirmed = () =>
  page.getByRole("dialog", { name: "Rollback confirmed", exact: true });
const operations = () =>
  page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith("vectory:deployment-operation:"))
      .map(([key, value]) => ({ key, value: JSON.parse(value) })),
  );
async function beginRollback() {
  await details()
    .getByRole("button", { name: "Roll back", exact: true })
    .click();
  await expect(rollbackConfirm()).toBeVisible();
}
async function sendRollback() {
  await rollbackConfirm()
    .getByRole("button", { name: "Roll back 2 devices", exact: true })
    .click();
}
async function lost({ mode = "lost", ...options } = {}) {
  await load(options);
  await beginRollback();
  state.rollbackMode = mode;
  state.lookupMode = "failed";
  await sendRollback();
  await expect(recovery()).toBeVisible();
  await expect(recovery()).toContainText("Synthetic lookup unavailable");
}
async function reloadApp() {
  await page.reload();
  await page.waitForFunction(() => window.ready, undefined, { timeout: 30000 });
  await page.evaluate(() => window.mount("app"));
  await expect(
    page.getByRole("heading", { name: "Deployments", exact: true }),
  ).toBeVisible();
}
async function leaveDetails() {
  await expect(details()).toBeVisible();
  await details()
    .getByRole("button", { name: /^Back to (deployments|schedules)$/ })
    .click();
  await expect(details()).toHaveCount(0);
  await expect(page).toHaveURL(/#\/deployments\?page=1$/);
}
async function reloadCurrentApp() {
  await page.reload();
  await page.waitForFunction(() => window.ready, undefined, { timeout: 30000 });
  await page.evaluate(() => window.mount("app"));
  if (page.url().includes("#/deployments/"))
    await expect(details()).toBeVisible();
  else
    await expect(
      page.getByRole("button", { name: "Choose devices", exact: true }),
    ).toBeVisible();
}
async function openCreate() {
  if (await details().count()) await leaveDetails();
  await page.evaluate(
    (id) => (location.hash = `#/configurations/${id}`),
    pipeline.id,
  );
  await expect(
    page.getByRole("button", { name: "Choose devices", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose devices", exact: true })
    .click();
  await preview();
}
async function loseOriginal(kind, options = {}) {
  await load(options);
  state.lookupMode = "failed";
  if (kind === "create") {
    await openCreate();
    state.createMode = "lost";
    await page
      .getByRole("button", { name: "Deploy to devices", exact: true })
      .click();
  } else {
    await beginRollback();
    state.rollbackMode = "lost";
    await sendRollback();
  }
  const shown = page.getByRole("dialog", {
    name: kind === "create" ? "Confirm deployment" : "Confirm rollback",
    exact: true,
  });
  await expect(shown).toContainText("Synthetic lookup unavailable");
  const saved = (await operations())[0];
  saved.raw = await page.evaluate(
    (key) => localStorage.getItem(key),
    saved.key,
  );
  await shown.getByRole("button", { name: "Close", exact: true }).click();
  return saved;
}
async function corruptRecord(saved, variant) {
  let raw = JSON.stringify(saved.value),
    key = saved.key;
  if (variant === "invalid-json" || variant === "legacy")
    raw = "{incomplete synthetic request";
  if (variant === "oversized") raw = " ".repeat(2000001) + raw;
  if (variant === "actor-mismatch")
    raw = JSON.stringify({ ...saved.value, actor_id: id(91) });
  if (variant === "key-mismatch")
    raw = JSON.stringify({ ...saved.value, id: id(998) });
  await page.evaluate(
    ({ key, raw, variant, actor }) => {
      if (variant === "legacy") {
        localStorage.removeItem(key);
        sessionStorage.setItem(`vectory:deployment-request:${actor}`, raw);
      } else localStorage.setItem(key, raw);
      window.dispatchEvent(new Event("vectory:deployment-request"));
    },
    { key, raw, variant, actor: id(90) },
  );
  return {
    storage: variant === "legacy" ? "sessionStorage" : "localStorage",
    key: variant === "legacy" ? `vectory:deployment-request:${id(90)}` : key,
    raw_length: raw.length,
    raw_sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

const storageDialog = () =>
  page.getByRole("dialog", {
    name: "Review saved deployment reminder",
    exact: true,
  });
const storageFound = (kind) =>
  page.getByRole("dialog", {
    name: kind === "rollback" ? "Rollback confirmed" : "Deployment confirmed",
    exact: true,
  });
const chooser = () =>
  page.getByRole("dialog", {
    name: "Requests needing confirmation",
    exact: true,
  });
const raw = (key, storage = "localStorage") =>
  page.evaluate(({ key, storage }) => window[storage].getItem(key), {
    key,
    storage,
  });
async function openChooser() {
  if (await details().count()) await leaveDetails();
  await page
    .getByRole("button", { name: "Review requests", exact: true })
    .click();
  await expect(chooser()).toBeVisible();
}
async function openIssue() {
  await openChooser();
  await chooser()
    .getByRole("button", { name: "Review unreadable reminder", exact: true })
    .first()
    .click();
}
async function peerWrite(key, value) {
  const peer = await context.newPage();
  await peer.goto(origin + "/__rollback-recovery");
  await peer.waitForFunction(() => window.ready, undefined, { timeout: 30000 });
  await peer.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key,
    value,
  });
  await peer.close();
}

try {
  if (process.env.VECTORY_CORRUPT_REMINDERS_BEFORE === "1") {
    await check(
      "Before corrupt deployment records disappear and permit a distinct new mutation",
      async () => {
        if (process.env.VECTORY_CORRUPT_REMINDERS_BEFORE !== "1")
          throw Error(
            "Before observation mode only; final UI assertions await design",
          );
        for (const [kind, variant] of [
          ["create", "invalid-json"],
          ["rollback", "invalid-json"],
          ["create", "oversized"],
          ["rollback", "actor-mismatch"],
          ["create", "key-mismatch"],
          ["rollback", "legacy"],
        ]) {
          const saved = await loseOriginal(kind);
          const corruption = await corruptRecord(saved, variant);
          await reloadCurrentApp();
          await expect(
            page.getByRole("button", {
              name: /^Confirm (deployment|rollback)$/,
            }),
          ).toHaveCount(0);
          await expect(page.locator(".deployment-recovery-notice")).toHaveCount(
            0,
          );
          expect(state.committed).toHaveLength(1);
          const postsBefore = state.creates.length + state.rollbacks.length;
          state.createMode = "normal";
          state.rollbackMode = "normal";
          state.lookupMode = "normal";
          if (kind === "create") {
            await openCreate();
            await page
              .getByRole("button", { name: "Deploy to devices", exact: true })
              .click();
            await expect(
              page.getByRole("dialog", {
                name: "Deployment created",
                exact: true,
              }),
            ).toBeVisible();
          } else {
            await beginRollback();
            await sendRollback();
            await expect(confirmed()).toBeVisible();
          }
          expect(state.committed).toHaveLength(2);
          expect(state.creates.length + state.rollbacks.length).toBe(
            postsBefore + 1,
          );
          const second = state.committed[1];
          expect(second.body.request_id).not.toBe(saved.value.id);
          correlationObservations.push({
            kind,
            variant,
            expected_defect_observation: true,
            correctness_acceptance: false,
            original_key: saved.value.id,
            original_result_id: state.committed[0].result.id,
            corruption,
            notice_hidden: true,
            new_request_id: second.body.request_id,
            new_result_id: second.result.id,
            committed_count: 2,
            unsafe_payload_reconstruction: false,
          });
        }
      },
    );
    await check(
      "Before unreadable local storage hides the reminder but blocks a new POST",
      async () => {
        if (process.env.VECTORY_CORRUPT_REMINDERS_BEFORE !== "1") return;
        const saved = await loseOriginal("create");
        await context.addInitScript(() => {
          const original = Storage.prototype.getItem;
          Storage.prototype.getItem = function (key) {
            if (
              this === localStorage &&
              key.startsWith("vectory:deployment-operation:")
            )
              throw new DOMException("Synthetic read denied", "SecurityError");
            return original.call(this, key);
          };
        });
        await reloadCurrentApp();
        await expect(
          page.getByRole("button", { name: "Confirm deployment", exact: true }),
        ).toHaveCount(0);
        await openCreate();
        await page
          .getByRole("button", { name: "Deploy to devices", exact: true })
          .click();
        await expect(dialog()).toContainText("Browser storage is unavailable");
        expect(state.creates).toHaveLength(1);
        expect(state.committed).toHaveLength(1);
        correlationObservations.push({
          kind: "create",
          variant: "read-failure",
          expected_defect_observation: false,
          existing_guard: true,
          original_key: saved.value.id,
          notice_hidden: true,
          new_post_blocked: true,
          committed_count: 1,
        });
      },
    );
  } else {
    await check(
      "Unreadable records retain visible review and block new create or rollback",
      async () => {
        for (const [kind, variant] of [
          ["create", "invalid-json"],
          ["rollback", "invalid-json"],
          ["create", "oversized"],
          ["rollback", "actor-mismatch"],
          ["create", "key-mismatch"],
          ["rollback", "legacy"],
        ]) {
          const saved = await loseOriginal(kind);
          const corruption = await corruptRecord(saved, variant);
          await reloadCurrentApp();
          await expect(
            page.locator(".deployment-recovery-notice"),
          ).toContainText("Saved deployment requests need review.");
          if (kind === "create") {
            await page
              .getByRole("button", { name: "Choose devices", exact: true })
              .click();
          } else {
            await details()
              .getByRole("button", { name: "Roll back", exact: true })
              .click();
          }
          await expect(storageDialog()).toBeVisible();
          await expect(page.getByRole("dialog")).toHaveCount(1);
          await expect(
            storageDialog().getByRole("button", {
              name: "Retry same request",
              exact: true,
            }),
          ).toHaveCount(0);
          if (variant === "legacy") {
            await expect(storageDialog()).toContainText("no usable request ID");
            await expect(
              storageDialog().getByRole("button", {
                name: "Check status",
                exact: true,
              }),
            ).toHaveCount(0);
          } else {
            await expect(storageDialog()).toContainText(
              "Synthetic lookup unavailable",
            );
            expect(state.lookups.at(-1).requestId).toBe(saved.value.id);
          }
          expect(state.creates.length + state.rollbacks.length).toBe(1);
          expect(state.committed).toHaveLength(1);
          await expect(storageDialog()).not.toContainText(
            "{incomplete synthetic request",
          );
          correlationObservations.push({
            kind,
            variant,
            corruption,
            reminder_visible: true,
            new_post_blocked: true,
            committed_count: 1,
            lookup_id: variant === "legacy" ? null : saved.value.id,
          });
        }
      },
    );
    await check(
      "Exact storage-key lookup recovers create and rollback without reconstructing damaged contents",
      async () => {
        for (const kind of ["create", "rollback"]) {
          const saved = await loseOriginal(kind);
          await corruptRecord(saved, "actor-mismatch");
          await reloadCurrentApp();
          state.lookupMode = "normal";
          await openIssue();
          await expect(storageFound(kind)).toBeVisible();
          await expect(storageFound(kind)).toContainText("current result");
          await expect(
            storageFound(kind).getByRole("link", {
              name: "Open deployment",
              exact: true,
            }),
          ).toHaveAttribute(
            "href",
            `#/deployments/${state.committed[0].result.id}?page=1`,
          );
          expect(await raw(saved.key)).toBeNull();
          expect(state.creates.length + state.rollbacks.length).toBe(1);
          await expect(
            storageFound(kind).getByRole("button", { name: /Retry/ }),
          ).toHaveCount(0);
          await expect(
            storageFound(kind).getByRole("link", {
              name: "Open deployment",
              exact: true,
            }),
          ).toBeFocused();
        }
      },
    );
    await check(
      "Absent mismatched and failed status responses never enable a reconstructed retry",
      async () => {
        const saved = await loseOriginal("create");
        await corruptRecord(saved, "key-mismatch");
        await reloadCurrentApp();
        state.committed = [];
        state.lookupMode = "normal";
        await openIssue();
        await expect(storageDialog()).toContainText(
          "No committed result was found yet",
        );
        expect(state.lookups.at(-1).requestId).toBe(saved.value.id);
        for (const fault of ["key", "missing"]) {
          state.correlationStage = "lookup";
          state.correlationFault = fault;
          await storageDialog()
            .getByRole("button", { name: "Check status", exact: true })
            .click();
          await expect(storageDialog()).toContainText(
            /identity|different deployment request/,
          );
          await expect(
            storageDialog().getByRole("button", { name: /Retry/ }),
          ).toHaveCount(0);
          expect(await raw(saved.key)).not.toBeNull();
        }
        state.correlationStage = null;
        state.lookupMode = "failed";
        await storageDialog()
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await expect(storageDialog()).toContainText(
          "Synthetic lookup unavailable",
        );
        expect(state.creates).toHaveLength(1);
        expect(state.committed).toHaveLength(0);
      },
    );
    await check(
      "Deliberate exact-byte dismissal cannot erase a peer repaired reminder",
      async () => {
        const saved = await loseOriginal("create");
        await corruptRecord(saved, "invalid-json");
        await reloadCurrentApp();
        await openIssue();
        await expect(storageDialog()).toContainText(
          "Synthetic lookup unavailable",
        );
        await storageDialog()
          .getByRole("button", { name: "Dismiss reminder", exact: true })
          .click();
        const dismiss = page.getByRole("dialog", {
          name: "Dismiss this reminder?",
          exact: true,
        });
        await expect(dismiss).toContainText("does not cancel");
        await peerWrite(saved.key, saved.raw);
        await dismiss
          .getByRole("button", { name: "Dismiss reminder", exact: true })
          .click();
        await expect(dismiss).toContainText(/changed|could not/);
        expect(await raw(saved.key)).toBe(saved.raw);
        expect(state.creates).toHaveLength(1);
        await dismiss
          .getByRole("button", { name: "Back", exact: true })
          .click();
        await storageDialog()
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Confirm deployment", exact: true }),
        ).toBeVisible();
        // A new reviewed snapshot can be deliberately removed, without a server write.
        await corruptRecord(saved, "invalid-json");
        await reloadCurrentApp();
        await openIssue();
        await expect(storageDialog()).toContainText(
          "Synthetic lookup unavailable",
        );
        await storageDialog()
          .getByRole("button", { name: "Dismiss reminder", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Dismiss this reminder?", exact: true })
          .getByRole("button", { name: "Dismiss reminder", exact: true })
          .click();
        await expect(storageDialog()).toHaveCount(0);
        expect(await raw(saved.key)).toBeNull();
        expect(state.creates).toHaveLength(1);
        await expect(page.locator("#main-content")).toBeFocused();
      },
    );
    await check(
      "Unrelated valid requests remain recoverable while conflicting legacy aliases are status-only",
      async () => {
        const saved = await loseOriginal("create");
        await corruptRecord(saved, "invalid-json");
        const valid = {
          ...saved.value,
          id: id(95),
          label: "Unrelated valid request",
          request: { ...saved.value.request, request_id: id(95) },
        };
        const validKey = `vectory:deployment-operation:${id(90)}:${id(95)}`;
        await page.evaluate(
          ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
          { key: validKey, value: valid },
        );
        await reloadCurrentApp();
        state.lookupMode = "normal";
        await openChooser();
        await chooser()
          .getByRole("button", { name: /Unrelated valid request/ })
          .click();
        const normal = page.getByRole("dialog", {
          name: "Confirm deployment",
          exact: true,
        });
        await expect(normal).toContainText(
          "No completed request was found yet",
        );
        state.createMode = "normal";
        await normal
          .getByRole("button", { name: "Retry same request", exact: true })
          .click();
        await expect(storageFound("create")).toBeVisible();
        expect(state.creates[1].request_id).toBe(valid.id);
        expect(await raw(saved.key)).not.toBeNull();
        // Two valid aliases with one key but different payloads must not pick a retry body.
        const alias = await loseOriginal("rollback");
        await page.evaluate(
          ({ key, record }) =>
            sessionStorage.setItem(key, JSON.stringify(record)),
          {
            key: `vectory:deployment-request:${id(90)}`,
            record: {
              ...alias.value,
              label: "Conflicting alias",
              request: { ...alias.value.request, review_token: "b".repeat(64) },
            },
          },
        );
        await reloadCurrentApp();
        await openIssue();
        await expect(storageDialog()).toContainText("disagree");
        await expect(
          storageDialog().getByRole("button", { name: /Retry/ }),
        ).toHaveCount(0);
        expect(state.rollbacks).toHaveLength(1);
        expect(await raw(alias.key)).toBe(alias.raw);
      },
    );
    await check(
      "Account role and late-read boundaries keep another actor's reminder private",
      async () => {
        const saved = await loseOriginal("create");
        await corruptRecord(saved, "invalid-json");
        await reloadCurrentApp();
        state.lookupMode = "hold";
        await openIssue();
        await expect.poll(() => state.holds.length).toBe(1);
        const reads = state.lookups.length;
        state.actor = id(91);
        await page.evaluate(() => window.mount("app"));
        await expect(
          page.getByRole("button", { name: "Choose devices", exact: true }),
        ).toBeVisible();
        state.holds.shift()();
        await expect(storageFound("create")).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Review requests", exact: true }),
        ).toHaveCount(0);
        expect(await raw(saved.key)).not.toBeNull();
        state.actor = id(90);
        state.role = "viewer";
        state.lookupMode = "normal";
        await page.evaluate(() => window.mount("app"));
        await expect(
          page.getByRole("heading", { name: pipeline.name, exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Review requests", exact: true }),
        ).toHaveCount(0);
        expect(state.lookups).toHaveLength(reads);
        expect(state.creates).toHaveLength(1);
      },
    );

    await check(
      "Same-account role downgrade aborts held target rollback and global-center lookup",
      async () => {
        for (const entry of ["target", "rollback", "center"]) {
          const kind = entry === "rollback" ? "rollback" : "create";
          const saved = await loseOriginal(kind);
          await corruptRecord(saved, "invalid-json");
          await reloadCurrentApp();
          state.lookupMode = "hold";
          if (entry === "target")
            await page
              .getByRole("button", { name: "Choose devices", exact: true })
              .click();
          else if (entry === "rollback")
            await details()
              .getByRole("button", { name: "Roll back", exact: true })
              .click();
          else await openIssue();
          await expect(storageDialog()).toBeVisible();
          await expect.poll(() => state.holds.length).toBe(1);
          const stored = await raw(saved.key);
          state.role = "viewer";
          await page.evaluate(() =>
            window.dispatchEvent(
              new StorageEvent("storage", {
                key: "vectory-session-change",
                newValue: "synthetic-role-change",
              }),
            ),
          );
          await expect(storageDialog()).toHaveCount(0);
          state.holds.shift()();
          await expect.poll(() => state.completedLookups.length).toBe(1);
          await expect(storageFound(kind)).toHaveCount(0);
          expect(await raw(saved.key)).toBe(stored);
          expect(state.creates.length + state.rollbacks.length).toBe(1);
        }
      },
    );
    await check(
      "Confirmed status remains known when cleanup fails or a peer replaces the original bytes",
      async () => {
        for (const mode of ["denied", "peer"]) {
          const saved = await loseOriginal("rollback");
          await corruptRecord(saved, "invalid-json");
          await reloadCurrentApp();
          if (mode === "denied")
            await page.evaluate((key) => {
              const original = Storage.prototype.removeItem;
              Storage.prototype.removeItem = function (k) {
                if (this === localStorage && k === key)
                  throw new DOMException(
                    "Synthetic cleanup denied",
                    "SecurityError",
                  );
                return original.call(this, k);
              };
            }, saved.key);
          state.lookupMode = mode === "peer" ? "hold" : "normal";
          await openIssue();
          if (mode === "peer") {
            await expect.poll(() => state.holds.length).toBe(1);
            await peerWrite(saved.key, saved.raw);
            state.holds.shift()();
          }
          await expect(storageFound("rollback")).toBeVisible();
          await expect(storageFound("rollback")).toContainText(
            "could not be cleared",
          );
          await expect(
            storageFound("rollback").getByRole("link", {
              name: "Open deployment",
              exact: true,
            }),
          ).toHaveAttribute("href", `#/deployments/${id(50)}?page=1`);
          expect(await raw(saved.key)).not.toBeNull();
          if (mode === "peer") expect(await raw(saved.key)).toBe(saved.raw);
          expect(state.rollbacks).toHaveLength(1);
          await expect(
            storageFound("rollback").getByRole("button", { name: /Retry/ }),
          ).toHaveCount(0);
        }
      },
    );
    await check(
      "Unknown keys storage read failures and bounded reads do not permit a blind send",
      async () => {
        const saved = await loseOriginal("create");
        await corruptRecord(saved, "invalid-json");
        const badKey = `vectory:deployment-operation:${id(90)}:not-a-request-id`;
        await page.evaluate(
          ({ old, key }) => {
            localStorage.removeItem(old);
            localStorage.setItem(key, "{unreadable");
          },
          { old: saved.key, key: badKey },
        );
        await reloadCurrentApp();
        const reads = state.lookups.length;
        await openIssue();
        await expect(storageDialog()).toContainText("no usable request ID");
        await expect(
          storageDialog().getByRole("button", {
            name: "Check status",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(state.lookups).toHaveLength(reads);
        expect(state.creates).toHaveLength(1);
        await loseOriginal("create");
        await context.addInitScript(() => {
          const original = Storage.prototype.getItem;
          Storage.prototype.getItem = function (key) {
            if (
              this === localStorage &&
              key.startsWith("vectory:deployment-operation:")
            )
              throw new DOMException("Synthetic read denied", "SecurityError");
            return original.call(this, key);
          };
        });
        await reloadCurrentApp();
        await openChooser();
        await expect(chooser()).toContainText("Browser storage is unavailable");
        await expect(
          chooser().getByRole("button", {
            name: "Refresh reminders",
            exact: true,
          }),
        ).toBeVisible();
        expect(state.creates).toHaveLength(1);
        const timed = await loseOriginal("create");
        await corruptRecord(timed, "invalid-json");
        await reloadCurrentApp();
        await page.clock.install();
        state.lookupMode = "heldBody";
        await openIssue();
        await expect.poll(() => state.bodyHolds.length).toBe(1);
        await page.clock.fastForward(30050);
        await page.clock.runFor(100);
        await expect(storageDialog()).toContainText(
          "server may still be processing",
        );
        await expect(
          storageDialog().getByRole("button", {
            name: "Check status",
            exact: true,
          }),
        ).toBeEnabled();
        expect(await raw(timed.key)).not.toBeNull();
        expect(state.creates).toHaveLength(1);
        state.bodyHolds.shift()();
      },
    );
    await check(
      "Capacity exposes bounded reminders and Refresh reminders rereads restored storage",
      async () => {
        await load();
        const keys = Array.from(
          { length: 11 },
          (_, i) => `vectory:deployment-operation:${id(90)}:${id(100 + i)}`,
        );
        await page.evaluate((keys) => {
          for (const key of keys)
            localStorage.setItem(key, "{synthetic-unreadable");
          window.dispatchEvent(new Event("vectory:deployment-request"));
        }, keys);
        await openChooser();
        await expect(chooser()).toContainText(
          "Additional deployment reminders remain",
        );
        await expect(
          chooser().getByRole("button", {
            name: "Review unreadable reminder",
            exact: true,
          }),
        ).toHaveCount(10);
        await chooser()
          .getByRole("button", {
            name: "Review unreadable reminder",
            exact: true,
          })
          .first()
          .click();
        await expect(storageDialog()).toContainText(
          "No committed result was found yet",
        );
        await storageDialog()
          .getByRole("button", { name: "Dismiss reminder", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Dismiss this reminder?", exact: true })
          .getByRole("button", { name: "Dismiss reminder", exact: true })
          .click();
        await openChooser();
        await expect(chooser()).not.toContainText(
          "Additional deployment reminders remain",
        );
        await expect(
          chooser().getByRole("button", {
            name: "Review unreadable reminder",
            exact: true,
          }),
        ).toHaveCount(10);
        expect(await raw(keys[10])).toBe("{synthetic-unreadable");
        expect(state.creates.length + state.rollbacks.length).toBe(0);

        await load();
        const key = keys[0];
        await page.evaluate((key) => {
          localStorage.setItem(key, "{synthetic-unreadable");
          window.syntheticStorageDenied = true;
          const original = Storage.prototype.getItem;
          Storage.prototype.getItem = function (name) {
            if (
              this === localStorage &&
              name.startsWith("vectory:deployment-operation:") &&
              window.syntheticStorageDenied
            )
              throw new DOMException(
                "Synthetic storage unavailable",
                "SecurityError",
              );
            return original.call(this, name);
          };
          window.dispatchEvent(new Event("vectory:deployment-request"));
        }, key);
        await details()
          .getByRole("button", { name: "Roll back", exact: true })
          .click();
        await expect(storageDialog()).toContainText(
          "Browser storage is unavailable",
        );
        await storageDialog()
          .getByRole("button", { name: "Refresh reminders", exact: true })
          .click();
        await expect(storageDialog()).toContainText(
          "Browser storage is unavailable",
        );
        await page.evaluate(() => (window.syntheticStorageDenied = false));
        await storageDialog()
          .getByRole("button", { name: "Refresh reminders", exact: true })
          .click();
        await expect(storageDialog()).toContainText("cannot be read safely");
        await page.evaluate((key) => localStorage.removeItem(key), key);
        await storageDialog()
          .getByRole("button", { name: "Refresh reminders", exact: true })
          .click();
        await expect(storageDialog()).toContainText(
          "Browser storage is available. No saved deployment reminders need review.",
        );
        await expect(storageDialog()).toBeVisible();
        expect(state.lookups).toHaveLength(0);
        expect(state.creates.length + state.rollbacks.length).toBe(0);
      },
    );
    await check(
      "Unreadable reminder and confirmed result stay usable in 899 and375 light/dark layouts",
      async () => {
        for (const width of [899, 375])
          for (const theme of ["light", "dark"]) {
            const saved = await loseOriginal("rollback", { width, theme });
            await corruptRecord(saved, "invalid-json");
            await reloadCurrentApp();
            await openChooser();
            const chooserScan = await new AxeBuilder({ page })
              .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
              .analyze();
            expect(chooserScan.violations).toEqual([]);
            accessibility.push({
              width,
              theme,
              stage: "chooser",
              violations: chooserScan.violations,
            });
            await page.screenshot({
              path: resolve(
                output,
                `corrupt-reminder-chooser-${width}-${theme}.png`,
              ),
            });
            await chooser()
              .getByRole("button", {
                name: "Review unreadable reminder",
                exact: true,
              })
              .first()
              .click();
            await expect(storageDialog()).toContainText(
              "Synthetic lookup unavailable",
            );
            for (const stage of ["unreadable", "confirmed"]) {
              if (stage === "confirmed") {
                state.lookupMode = "normal";
                await storageDialog()
                  .getByRole("button", { name: "Check status", exact: true })
                  .click();
                await expect(storageFound("rollback")).toBeVisible();
              }
              const shown =
                stage === "unreadable"
                  ? storageDialog()
                  : storageFound("rollback");
              const geometry = await shown.evaluate((el) => {
                const r = el.getBoundingClientRect();
                const f = el
                  .querySelector(".modal-footer")
                  .getBoundingClientRect();
                return {
                  x: r.x,
                  right: r.right,
                  top: r.top,
                  bottom: r.bottom,
                  footerBottom: f.bottom,
                  viewportWidth: innerWidth,
                  viewportHeight: innerHeight,
                };
              });
              expect(geometry.x).toBeGreaterThanOrEqual(0);
              expect(geometry.right).toBeLessThanOrEqual(width + 1);
              expect(geometry.top).toBeGreaterThanOrEqual(0);
              expect(geometry.footerBottom).toBeLessThanOrEqual(
                geometry.viewportHeight + 1,
              );
              const scan = await new AxeBuilder({ page })
                .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
                .analyze();
              expect(scan.violations).toEqual([]);
              accessibility.push({
                width,
                theme,
                stage,
                violations: scan.violations,
              });
              measurements.push({ width, theme, stage, ...geometry });
              await page.screenshot({
                path: resolve(
                  output,
                  `corrupt-reminder-${stage}-${width}-${theme}.png`,
                ),
              });
              if (stage === "confirmed") {
                await expect(page.locator(".toast")).toHaveCount(0, {
                  timeout: 6500,
                });
                await page.screenshot({
                  path: resolve(
                    output,
                    `corrupt-reminder-confirmed-clear-${width}-${theme}.png`,
                  ),
                });
              }
            }
          }
      },
    );
  }
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const path of trackedSources)
    source_sha256[`dashboard/${path}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, path)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Actual App unreadable deployment reminder review, lookup and dismissal with intercepted synthetic API and private browser storage. No live credentials, fleet/API mutations, native processes, services, activation or release changes. Native request mapping is not alleged incorrect.",
        passed: !failure,
        results,
        requests,
        unexpected,
        errors,
        accessibility,
        measurements,
        cleanup_observations: cleanupObservations,
        corrupt_record_observations: correlationObservations,
        source_sha256,
        source_sha256_at_start: sourceAtStart,
        source_changes_during_run: Object.keys(sourceAtStart).filter(
          (path) => sourceAtStart[path] !== source_sha256[path],
        ),
        ...(failure
          ? {
              failure: failure.message,
              body_at_failure: await page.locator("body").innerText(),
              active_at_failure: await page.evaluate(
                () => document.activeElement?.outerHTML,
              ),
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
