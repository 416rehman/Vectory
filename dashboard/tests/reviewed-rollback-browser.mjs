// Actual App reviewed rollback and durable recovery; isolated synthetic API only.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_REVIEWED_ROLLBACK_OUTPUT || ".local/reviewed-rollback-ui",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/Deployments.tsx",
  "dashboard/src/deployments.css",
  "dashboard/src/deploymentRouting.ts",
  "dashboard/src/api.ts",
  "dashboard/src/Fleet.tsx",
  "dashboard/src/DeploymentRecovery.tsx",
  "dashboard/src/deploymentRequests.ts",
  "dashboard/src/deploymentReceipt.ts",
  "dashboard/src/rollbackReview.ts",
  "dashboard/src/RollbackReviewPanel.tsx",
  "dashboard/src/rollback-review.css",
  "dashboard/src/DataTable.tsx",
  "dashboard/tests/reviewed-rollback-browser.mjs",
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
const virtual = "\0virtual:reviewed-rollback";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "reviewed-rollback",
      resolveId(id) {
        if (id === "virtual:reviewed-rollback") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__reviewed-rollback") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic reviewed rollback verification</title></head><body><div id="root"></div><script type="module">import "virtual:reviewed-rollback";</script></body></html>',
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
const deployment = (n = 100, changes = {}) => ({
  id: id(n),
  name: "Synthetic reviewed rollback",
  configuration_id: id(50),
  configuration_name: "Synthetic logs",
  version_id: id(51),
  version_number: 3,
  policy: null,
  priority: 100,
  target_mode: "snapshot",
  status: "completed",
  scheduled_at: null,
  created_at: "2026-09-27T00:00:00Z",
  rollout: {
    kind: "all",
    canary_size: 1,
    batch_size: 1,
    observation_seconds: 0,
    failure_threshold: 0,
  },
  target_count: 1,
  verified_count: 0,
  state_counts: { removed: 1 },
  ...changes,
});
const target = (n = 1, changes = {}) => ({
  device_id: id(n),
  device_name: "Synthetic retired edge",
  state: "removed",
  generation: 7,
  error: null,
  original: true,
  ...changes,
});
const device = (n = 1, changes = {}) => ({
  id: id(n),
  name: "Synthetic retired edge",
  os: "windows",
  arch: "amd64",
  status: "revoked",
  apply_state: "verified_applied",
  desired_generation: 7,
  reported_generation: 7,
  desired_version_id: null,
  labels: {},
  last_seen: "2026-09-27T00:00:00Z",
  ...changes,
});
const preview = (changes = {}) => ({
  source_deployment_id: id(100),
  source_version_id: id(51),
  source_status: "completed",
  source_action: "cancel",
  previous_version_id: id(52),
  previous_version_number: 2,
  previous_configuration_id: id(50),
  previous_configuration_name: "Synthetic logs",
  priority: 101,
  eligible_devices: [
    {
      device_id: id(1),
      device_name: "Synthetic live alpha",
      artifact_sha256: "a".repeat(64),
    },
    {
      device_id: id(3),
      device_name: "Synthetic offline beta",
      artifact_sha256: "b".repeat(64),
    },
  ],
  excluded_devices: [
    {
      device_id: id(2),
      device_name: "Synthetic retired alpha",
      reason: "revoked",
    },
    {
      device_id: id(4),
      device_name: "Synthetic removed gamma",
      reason: "removed",
    },
  ],
  blockers: [],
  review_token: "a".repeat(64),
  ready: true,
  ...changes,
});
function fixture(changes = {}) {
  return {
    summary: deployment(100, {
      rollback_idempotency: true,
      rollback_review: true,
      request_correlation: true,
      target_count: 4,
      verified_count: 0,
      state_counts: { desired: 3, removed: 1 },
    }),
    preview: preview(),
    previewMode: "normal",
    rollbackMode: "normal",
    lookupMode: "normal",
    rollbacks: [],
    cancels: [],
    afterCancel: null,
    lookups: [],
    committed: [],
    reviews: new Map(),
    holds: [],
    role: "operator",
    actor: id(99),
    targets: [
      target(1, { device_name: "Synthetic live alpha", state: "desired" }),
      target(2, { device_name: "Synthetic retired alpha", state: "desired" }),
      target(3, { device_name: "Synthetic offline beta", state: "desired" }),
      target(4, {
        device_name: "Synthetic removed gamma",
        state: "removed",
        generation: 7,
      }),
    ],
    devices: [device(), device(2, { status: "online" })],
    calls: [],
    errors: [],
    failTargets: false,
    ...changes,
  };
}
async function start(
  f,
  { width = 899, theme = "light", role = "operator", direct = false } = {},
) {
  f.role = role;
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
    const respond = (json, status = 200) => route.fulfill({ status, json });
    const reject = (code, message, status = 400) =>
      respond({ error: { code, message } }, status);
    if (method === "POST" && path === `/deployments/${f.summary.id}/rollback`) {
      const body = req.postDataJSON();
      expect(req.headers()["x-csrf-token"]).toBe("synthetic-csrf");
      f.rollbacks.push({ path, body: structuredClone(body) });
      if (f.rollbackMode === "changed")
        return reject(
          "ROLLBACK_REVIEW_CHANGED",
          "The rollback scope changed. Review it again.",
          409,
        );
      if (f.rollbackMode === "definite")
        return reject("CONFLICT", "Synthetic competing assignment", 409);
      if (f.rollbackMode === "uncommitted") return route.abort("failed");
      const prior = f.committed.find(
        (x) => x.actor === f.actor && x.body.request_id === body.request_id,
      );
      if (prior) expect(prior.body).toEqual(body);
      const scope = f.reviews.get(body.review_token) || f.preview;
      const result = prior?.result || {
        id: id(200),
        request_id: body.request_id,
        operation: "rollback",
        source_deployment_id: f.summary.id,
        request_correlation: true,
        version_id: scope.previous_version_id,
        priority: scope.priority,
        status: "active",
        target_mode: "snapshot",
        created_at: "2026-09-27T00:00:00Z",
        rollout: deployment().rollout,
        selector: {
          device_ids: scope.eligible_devices.map((device) => device.device_id),
          group_ids: [],
          exclude_ids: [],
        },
        targets: scope.eligible_devices.map((x) => ({
          device_id: x.device_id,
          state: "desired",
          generation: 9,
        })),
      };
      if (!prior)
        f.committed.push({
          actor: f.actor,
          path,
          body: structuredClone(body),
          result,
        });
      if (f.rollbackMode === "hold")
        await new Promise((done) => f.holds.push(done));
      if (f.rollbackMode === "lost") return route.abort("failed");
      if (f.rollbackMode === "unparseable")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{lost",
        });
      if (f.rollbackMode === "wrongReceipt")
        return respond({
          ...result,
          request_id: id(999),
        });
      return respond(result);
    }
    if (method === "POST" && path === `/deployments/${f.summary.id}/cancel`) {
      expect(req.headers()["x-csrf-token"]).toBe("synthetic-csrf");
      f.cancels.push(path);
      f.summary = {
        ...f.summary,
        status: "cancelled",
        cancelled_at: "2026-09-27T00:05:00Z",
      };
      if (f.afterCancel) f.preview = f.afterCancel;
      return respond(f.summary);
    }
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
    if (path === `/deployments/${f.summary.id}/rollback-preview`) {
      if (f.previewMode === "hold")
        await new Promise((done) => f.holds.push(done));
      if (f.previewMode === "failed")
        return reject("UNAVAILABLE", "Synthetic preview unavailable", 503);
      if (f.previewMode === "missing")
        return reject("NOT_FOUND", "Preview unavailable on this server", 404);
      if (f.previewMode === "malformed")
        return respond({ ...f.preview, review_token: "broken" });
      f.reviews.set(f.preview.review_token, structuredClone(f.preview));
      return respond(structuredClone(f.preview));
    }
    if (path.startsWith("/deployments/requests/")) {
      f.lookups.push(path);
      if (f.lookupMode === "failed")
        return reject("UNAVAILABLE", "Synthetic lookup unavailable", 503);
      const requestId = path.split("/").at(-1);
      const found = f.committed.find(
        (x) => x.actor === f.actor && x.body.request_id === requestId,
      );
      return respond(
        found
          ? {
              request_id: requestId,
              found: true,
              operation: found.result.operation,
              source_deployment_id: found.result.source_deployment_id,
              deployment: found.result,
            }
          : { request_id: requestId, found: false },
      );
    }
    if (path === "/status")
      return respond({ initialized: true, version: "synthetic" });
    if (path === "/session")
      return respond({
        user: { ...user(f.role), id: f.actor },
        csrf_token: "synthetic-csrf",
      });
    if (path === "/deployments/history")
      return respond({ items: [f.summary], total: 1, page: 1, page_size: 12 });
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
    if (path === `/deployments/${id(200)}/summary`)
      return respond(
        deployment(200, {
          name: "Synthetic rollback replacement",
          version_id: id(52),
          version_number: 2,
          target_count: 2,
          state_counts: { desired: 2 },
          status: "active",
        }),
      );
    if (path === `/deployments/${id(200)}/targets`)
      return respond({
        items: f.preview.eligible_devices.map((x) => ({
          ...x,
          state: "desired",
          generation: 9,
        })),
        total: 2,
        page: 1,
        page_size: 12,
      });
    if (path === `/deployments/${f.summary.id}/summary`)
      return respond(f.summary);
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
      "/__reviewed-rollback#/" +
      (direct ? `deployments/${f.summary.id}?page=1` : "deployments"),
  );
  await expect(
    page.getByRole("heading", { name: "Deployments", exact: true }),
  ).toBeVisible();
  return { page, context, close: () => context.close() };
}
async function open(page) {
  await page
    .getByRole("link", { name: "Synthetic reviewed rollback", exact: true })
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
const review = (page) =>
  page.getByRole("dialog", { name: "Review rollback", exact: true });
const recovery = (page) =>
  page.getByRole("dialog", { name: "Confirm rollback", exact: true });
const receipt = (page) =>
  page.getByRole("dialog", { name: "Rollback confirmed", exact: true });
const confirm = (page) =>
  review(page).getByRole("button", { name: /^Roll back(?: \d+ devices?)?$/ });
const previewCalls = (f) =>
  f.calls.filter((c) => c.path.endsWith("/rollback-preview"));
const operations = (page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith("vectory:deployment-operation:"))
      .map((k) => JSON.parse(localStorage.getItem(k))),
  );
async function chooseRollBack(page) {
  await dialog(page)
    .getByRole("button", { name: /^(Stop rollout|Roll back or remove)$/ })
    .click();
  await page.getByRole("menuitem", { name: "Roll back", exact: true }).click();
}
async function begin(page) {
  await open(page);
  await chooseRollBack(page);
  await expect(review(page)).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
}
async function ready(page) {
  await expect(
    review(page).getByRole("button", { name: "Included (2)", exact: true }),
  ).toBeVisible();
  await expect(confirm(page)).toBeEnabled();
}
async function clean(f) {
  expect(f.errors).toEqual([]);
  expect(
    f.calls
      .filter((c) => c.method !== "GET")
      .every(
        (c) =>
          c.method === "POST" &&
          c.path === `/deployments/${f.summary.id}/rollback`,
      ),
  ).toBe(true);
}
try {
  await check(
    "Explicit included/excluded review identifies prior version and source effect; Cancel never allocates an operation or sends rollback",
    async () => {
      const f = fixture(),
        app = await start(f);
      try {
        const { page } = app;
        await begin(page);
        await ready(page);
        await expect(
          review(page).locator(".rollback-review-heading strong"),
        ).toHaveText("Synthetic logs v2");
        await expect(
          review(page).getByRole("list", { name: "What changes" }),
        ).toContainText(
          "Synthetic live alpha and Synthetic offline beta return to Synthetic logs v2.",
        );
        // A completed rollout has nothing left to stop.
        await expect(review(page)).not.toContainText("The rollout stops here.");
        await expect(review(page)).toContainText(
          "The restored version takes over one priority above this rollout.",
        );
        await expect(review(page)).toContainText(
          "Offline ones stay included and apply it when they reconnect.",
        );
        // Rows name devices; the identity is on the name, never a raw UUID line.
        for (const n of [1, 3])
          await expect(
            review(page)
              .getByRole("list", { name: "Included devices" })
              .locator(`strong[title="${id(n)}"]`),
          ).toBeVisible();
        await expect(
          review(page).getByRole("list", { name: "Included devices" }),
        ).not.toContainText(id(1));
        // The row shows a short digest; the exact one is on the element.
        await expect(
          review(page)
            .getByRole("list", { name: "Included devices" })
            .locator(`code[data-digest="${"a".repeat(64)}"]`),
        ).toHaveAttribute("title", "a".repeat(64));
        await review(page)
          .getByRole("button", { name: "Excluded (2)", exact: true })
          .click();
        await expect(
          review(page).getByRole("list", { name: "Excluded devices" }),
        ).toContainText("Device revoked");
        await expect(
          review(page).getByRole("list", { name: "Excluded devices" }),
        ).toContainText("No longer follows it");
        await expect(review(page)).toContainText(
          "The rollback leaves them out; each one says what it runs afterwards.",
        );
        expect(await operations(page)).toEqual([]);
        expect(f.rollbacks).toEqual([]);
        await page.keyboard.press("Escape");
        await expect(review(page)).toHaveCount(0);
        await expect(dialog(page)).toBeVisible();
        await expect
          .poll(() =>
            dialog(page).evaluate((el) => el.contains(document.activeElement)),
          )
          .toBe(true);
        expect(f.rollbacks).toEqual([]);
        await clean(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "A live canary rolls back in one reviewed step naming who returns and who keeps what; a blocked one offers Cancel rollout, then review rollback",
    async () => {
      const edge = {
        configuration_name: "Edge syslog processing",
        version_number: 1,
      };
      const canary = (changes = {}) =>
        deployment(100, {
          rollback_idempotency: true,
          rollback_review: true,
          request_correlation: true,
          status: "active",
          rollout: {
            kind: "canary",
            canary_size: 1,
            batch_size: 1,
            observation_seconds: 900,
            failure_threshold: 0,
          },
          target_count: 3,
          verified_count: 1,
          state_counts: { verified_applied: 1, pending: 2 },
          ...changes,
        });
      const observing = (changes = {}) =>
        preview({
          source_status: "active",
          previous_configuration_name: "Edge syslog processing",
          previous_version_number: 1,
          eligible_devices: [
            {
              device_id: id(1),
              device_name: "edge-nyc-02",
              artifact_sha256: "a".repeat(64),
            },
          ],
          excluded_devices: [
            {
              device_id: id(2),
              device_name: "edge-fra-01",
              reason: "not_released",
              effect: "unchanged",
              current: edge,
              next: null,
            },
            {
              device_id: id(3),
              device_name: "edge-nyc-01",
              reason: "not_released",
              effect: "unchanged",
              current: edge,
              next: null,
            },
          ],
          ...changes,
        });
      let f = fixture({ summary: canary(), preview: observing() }),
        app = await start(f);
      try {
        const { page } = app;
        // The Overview's Roll back asks (in memory only) for this review; the
        // rollout page opens it once it loads, still unconfirmed.
        await page.evaluate(
          (id) =>
            import("/src/deploymentStatus.ts").then((m) =>
              m.requestRollbackReview(id),
            ),
          f.summary.id,
        );
        await page
          .getByRole("link", {
            name: "Synthetic reviewed rollback",
            exact: true,
          })
          .click();
        await expect(review(page)).toBeVisible();
        expect(f.rollbacks).toEqual([]);
        const story = review(page).getByRole("list", { name: "What changes" });
        await expect(story).toContainText(
          "edge-nyc-02 returns to Edge syslog processing v1.",
        );
        await expect(story).toContainText(
          "edge-fra-01 and edge-nyc-01 never received Synthetic logs v3 and keep Edge syslog processing v1 (no change).",
        );
        await expect(story).toContainText("The rollout stops here.");
        await expect(confirm(page)).toHaveText("Roll back 1 device");
        await expect(confirm(page)).toBeEnabled();
        await review(page)
          .getByRole("button", { name: "Excluded (2)", exact: true })
          .click();
        await expect(
          review(page).getByRole("list", { name: "Excluded devices" }),
        ).toContainText(
          "Never received Synthetic logs v3 · keeps Edge syslog processing v1 (no change)",
        );
        await confirm(page).click();
        await expect(receipt(page)).toBeVisible();
        expect(f.rollbacks).toHaveLength(1);
        expect(f.cancels).toEqual([]);
        await clean(f);
      } finally {
        await app.close();
      }
      // Blocked: a device it never reached would switch once it stops.
      const web = { configuration_name: "Web access logs", version_number: 2 };
      f = fixture({
        summary: canary(),
        preview: observing({
          ready: false,
          excluded_devices: [
            {
              device_id: id(2),
              device_name: "edge-fra-01",
              reason: "not_released",
              effect: "fallback",
              current: edge,
              next: web,
            },
          ],
          blockers: [
            {
              code: "UNSAFE_SOURCE_REMOVAL",
              reason:
                "Stopping this rollout would also switch edge-fra-01 to Web access logs v2, which this rollback doesn't cover. Cancel the rollout first, then review the rollback.",
            },
          ],
        }),
        afterCancel: observing({
          source_status: "cancelled",
          review_token: "e".repeat(64),
          excluded_devices: [
            {
              device_id: id(2),
              device_name: "edge-fra-01",
              reason: "not_released",
              effect: null,
              current: null,
              next: null,
            },
          ],
        }),
      });
      app = await start(f, { width: 390, theme: "dark" });
      try {
        const { page } = app;
        await begin(page);
        await expect(
          review(page).getByRole("list", { name: "What changes" }),
        ).toContainText(
          "edge-fra-01 never received Synthetic logs v3 but would switch to Web access logs v2 once the rollout stops.",
        );
        await expect(review(page)).toContainText("Rollback isn't ready");
        await expect(review(page)).toContainText(
          "Cancel keeps edge-nyc-02 on Synthetic logs v3 until you roll it back.",
        );
        await expect(confirm(page)).toBeDisabled();
        const scan = await new AxeBuilder({ page }).analyze();
        expect(scan.violations).toEqual([]);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const file = resolve(
          output,
          "reviewed-rollback-cancel-first-390-dark.png",
        );
        await page.screenshot({ path: file });
        screenshots.push(file);
        expect(f.rollbacks).toEqual([]);
        await review(page)
          .getByRole("button", {
            name: "Cancel rollout, then review rollback",
            exact: true,
          })
          .click();
        // The review reads again for the stopped rollout: nothing blocks.
        await expect(confirm(page)).toBeEnabled();
        await expect(review(page)).not.toContainText("Rollback isn't ready");
        await expect(review(page)).not.toContainText("The rollout stops here.");
        expect(f.cancels).toHaveLength(1);
        expect(f.rollbacks).toEqual([]);
        await confirm(page).click();
        await expect(receipt(page)).toBeVisible();
        expect(f.rollbacks).toHaveLength(1);
        expect(f.rollbacks[0].body.review_token).toBe("e".repeat(64));
        expect(f.errors).toEqual([]);
        expect(
          f.calls.filter((c) => c.method !== "GET").map((c) => c.path),
        ).toEqual([
          `/deployments/${f.summary.id}/cancel`,
          `/deployments/${f.summary.id}/rollback`,
        ]);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Explicit confirm sends exact token and one durable key; receipt links the exact reviewed replacement without modifying original history",
    async () => {
      const f = fixture(),
        app = await start(f);
      const original = structuredClone(f.summary);
      try {
        const { page } = app;
        await begin(page);
        await ready(page);
        await confirm(page).click();
        await expect(receipt(page)).toBeVisible();
        expect(f.rollbacks).toHaveLength(1);
        expect(Object.keys(f.rollbacks[0].body).sort()).toEqual([
          "request_id",
          "review_token",
        ]);
        expect(f.rollbacks[0].body.review_token).toBe("a".repeat(64));
        expect(f.rollbacks[0].body.request_id).toMatch(/^[\da-f-]{36}$/);
        expect(f.committed[0].result.targets.map((t) => t.device_id)).toEqual([
          id(1),
          id(3),
        ]);
        expect(f.summary).toEqual(original);
        expect(await operations(page)).toEqual([]);
        const link = receipt(page).getByRole("link", {
          name: "View rollback deployment",
        });
        await expect(link).toHaveAttribute(
          "href",
          `#/deployments/${id(200)}?page=1`,
        );
        await link.click();
        await expect(dialog(page)).toContainText(
          "Synthetic rollback replacement",
        );
        expect(f.rollbacks).toHaveLength(1);
        await clean(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Changed review retains the request until explicit dismissal; a new confirmation uses a new key and freshly reviewed token",
    async () => {
      const f = fixture({ rollbackMode: "changed" }),
        app = await start(f, { width: 375, theme: "dark" });
      try {
        const { page } = app;
        await begin(page);
        await ready(page);
        await confirm(page).click();
        await expect(recovery(page)).toContainText(
          "The rollback scope changed. Review it again.",
        );
        await expect(review(page)).toHaveCount(0);
        expect(previewCalls(f)).toHaveLength(1);
        expect(f.rollbacks).toHaveLength(1);
        const [saved] = await operations(page);
        expect(saved.request).toEqual(f.rollbacks[0].body);
        await recovery(page)
          .getByRole("button", { name: "Dismiss reminder", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Dismiss this reminder?" })
          .getByRole("button", { name: /checked history$/ })
          .click();
        expect(await operations(page)).toEqual([]);
        f.preview = { ...f.preview, review_token: "b".repeat(64) };
        f.rollbackMode = "normal";
        await chooseRollBack(page);
        await ready(page);
        expect(f.rollbacks).toHaveLength(1);
        await confirm(page).click();
        await expect(receipt(page)).toBeVisible();
        expect(f.rollbacks).toHaveLength(2);
        expect(f.rollbacks[1].body.review_token).toBe("b".repeat(64));
        expect(f.rollbacks[1].body.request_id).not.toBe(
          f.rollbacks[0].body.request_id,
        );
        await clean(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Lost, unreadable and mismatched committed responses recover the original exact receipt without applying a fresh preview",
    async () => {
      for (const mode of ["lost", "unparseable", "wrongReceipt"]) {
        const f = fixture({
            rollbackMode: mode,
            lookupMode: "failed",
            ...(mode === "lost"
              ? {
                  preview: preview({
                    previous_configuration_name: null,
                    previous_version_number: null,
                  }),
                }
              : {}),
          }),
          app = await start(
            f,
            mode === "lost" ? { width: 375, theme: "dark" } : {},
          );
        try {
          const { page } = app;
          await begin(page);
          await ready(page);
          if (mode === "lost") {
            await expect(review(page)).toContainText("Version ID");
            await expect(review(page)).toContainText(id(52));
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
          }
          await confirm(page).click();
          await expect(recovery(page)).toContainText(
            "Synthetic lookup unavailable",
          );
          if (mode === "lost") {
            await expect(recovery(page)).toContainText("Version ID");
            await expect(recovery(page)).toContainText(id(52));
          }
          const [op] = await operations(page);
          expect(op.request).toEqual(f.rollbacks[0].body);
          expect(op.review.device_ids).toEqual([id(1), id(3)]);
          expect(op.review.excluded_count).toBe(2);
          f.preview = {
            ...f.preview,
            review_token: "c".repeat(64),
            eligible_devices: [
              {
                device_id: id(4),
                device_name: "Changed scope",
                artifact_sha256: "a".repeat(64),
              },
            ],
          };
          f.lookupMode = "normal";
          await recovery(page)
            .getByRole("button", { name: "Check status", exact: true })
            .click();
          await expect(receipt(page)).toBeVisible();
          if (mode === "lost") {
            await expect(receipt(page)).toContainText("Version ID");
            await expect(receipt(page)).toContainText(id(52));
          }
          expect(f.rollbacks).toHaveLength(1);
          expect(previewCalls(f)).toHaveLength(1);
          expect(f.committed).toHaveLength(1);
          await clean(f);
        } finally {
          await app.close();
        }
      }
    },
  );
  await check(
    "Unknown not-found result and reload retain frozen reviewed body; role and actor boundaries hide recovery; explicit same-key retry never refreshes scope",
    async () => {
      const f = fixture({ rollbackMode: "uncommitted" }),
        app = await start(f);
      try {
        const { page } = app;
        await begin(page);
        await ready(page);
        await confirm(page).click();
        await expect(recovery(page)).toContainText(
          "No completed request was found yet.",
        );
        const [saved] = await operations(page);
        expect(saved.request.review_token).toBe("a".repeat(64));
        await recovery(page)
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await dialog(page)
          .getByRole("navigation", { name: "Breadcrumb" })
          .getByRole("link", { name: /^(Deployments|Schedules)$/ })
          .click();
        f.role = "viewer";
        await page.reload();
        await expect(
          page.getByRole("heading", { name: "Deployments", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Confirm rollback", exact: true }),
        ).toHaveCount(0);
        expect(f.rollbacks).toHaveLength(1);
        f.role = "operator";
        f.actor = id(98);
        await page.reload();
        await expect(
          page.getByRole("heading", { name: "Deployments", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Confirm rollback", exact: true }),
        ).toHaveCount(0);
        expect(f.rollbacks).toHaveLength(1);
        f.actor = id(99);
        await page.reload();
        await page
          .getByRole("button", { name: "Confirm rollback", exact: true })
          .click();
        await expect(recovery(page)).toContainText(
          "No completed request was found yet.",
        );
        f.preview = { ...f.preview, review_token: "d".repeat(64) };
        f.rollbackMode = "normal";
        await recovery(page)
          .getByRole("button", { name: "Retry same request", exact: true })
          .click();
        await expect(receipt(page)).toBeVisible();
        expect(f.rollbacks).toHaveLength(2);
        expect(f.rollbacks[1]).toEqual(f.rollbacks[0]);
        expect(previewCalls(f)).toHaveLength(1);
        expect(f.committed).toHaveLength(1);
        await clean(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Definite rejection preserves review; invalid or legacy new previews fail closed while an old committed rollback reminder still resolves",
    async () => {
      const cases = [
        { previewMode: "normal", rollbackMode: "definite" },
        {
          preview: preview({
            ready: false,
            excluded_devices: [
              {
                device_id: id(4),
                device_name: "Synthetic unreleased gamma",
                reason: "not_released",
              },
            ],
            blockers: [
              {
                code: "UNSAFE_SOURCE_REMOVAL",
                reason:
                  "Stopping the original rollout could change delivery on an excluded live device. Review a separate deployment instead.",
              },
            ],
          }),
        },
        {
          preview: preview({
            ready: false,
            blockers: [
              {
                code: "HIGHER_PRIORITY",
                reason:
                  "A higher-priority assignment would prevent these devices receiving the rollback.",
              },
            ],
          }),
        },
        {
          preview: preview({
            ready: false,
            eligible_devices: [],
            previous_version_id: null,
            blockers: [
              {
                code: "NO_ELIGIBLE_DEVICES",
                reason: "No eligible released devices remain.",
              },
            ],
          }),
        },
        { summary: deployment(100, { rollback_idempotency: true }) },
        { previewMode: "malformed" },
        { previewMode: "failed" },
      ];
      for (const setup of cases) {
        const f = fixture(setup),
          app = await start(f);
        try {
          const { page } = app;
          await begin(page);
          if (setup.rollbackMode === "definite") {
            await ready(page);
            await confirm(page).click();
            await expect(recovery(page)).toContainText(
              "Synthetic competing assignment",
            );
            await expect(review(page)).toHaveCount(0);
            expect(f.rollbacks).toHaveLength(1);
            expect(previewCalls(f)).toHaveLength(1);
            const [saved] = await operations(page);
            expect(saved.request).toEqual(f.rollbacks[0].body);
          } else {
            if (setup.preview?.blockers)
              await expect(review(page)).toContainText(
                setup.preview.blockers[0].reason,
              );
            else if (setup.summary) {
              await expect(review(page)).toContainText(
                "This server cannot provide a reviewed rollback.",
              );
              expect(previewCalls(f)).toHaveLength(0);
            } else if (setup.previewMode === "failed")
              await expect(review(page)).toContainText(
                "Synthetic preview unavailable",
              );
            else await expect(review(page).locator(".error-box")).toBeVisible();
            await expect(confirm(page)).toBeDisabled();
            expect(f.rollbacks).toHaveLength(0);
          }
          await clean(f);
        } finally {
          await app.close();
        }
      }
      const f = fixture(),
        app = await start(f);
      try {
        const { page } = app,
          requestId = id(900);
        const old = {
          actor_id: id(99),
          id: requestId,
          kind: "rollback",
          deployment_id: id(100),
          label: "Synthetic older rollback reminder",
          recorded_at: "2026-09-27T00:00:00Z",
          retry_supported: true,
          request: { request_id: requestId },
        };
        f.committed.push({
          actor: id(99),
          body: old.request,
          result: {
            id: id(200),
            request_id: requestId,
            operation: "rollback",
            source_deployment_id: id(100),
            request_correlation: true,
            version_id: id(52),
            priority: 101,
            status: "active",
            target_mode: "snapshot",
            created_at: "2026-09-27T00:00:00Z",
            rollout: deployment().rollout,
            selector: { device_ids: [id(1)], group_ids: [], exclude_ids: [] },
            targets: [{ device_id: id(1), state: "desired", generation: 9 }],
          },
        });
        await page.evaluate(
          (op) =>
            localStorage.setItem(
              `vectory:deployment-operation:${op.actor_id}:${op.id}`,
              JSON.stringify(op),
            ),
          old,
        );
        await page.reload();
        await page
          .getByRole("button", { name: "Confirm rollback", exact: true })
          .click();
        await expect(receipt(page)).toBeVisible();
        expect(previewCalls(f)).toHaveLength(0);
        expect(f.rollbacks).toHaveLength(0);
        await clean(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Held preview can close safely; held commit blocks duplicate submission and navigation; read-only roles never fetch previews",
    async () => {
      let f = fixture({ previewMode: "hold" }),
        app = await start(f);
      try {
        const { page } = app;
        await begin(page);
        await expect.poll(() => f.holds.length).toBe(1);
        await expect(
          review(page).locator(".modal-footer button").last(),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(review(page)).toHaveCount(0);
        f.holds.shift()();
        await expect(dialog(page)).toBeVisible();
        expect(f.rollbacks).toEqual([]);
        await clean(f);
      } finally {
        await app.close();
      }
      f = fixture({ rollbackMode: "hold" });
      app = await start(f);
      try {
        const { page } = app;
        await begin(page);
        await ready(page);
        await confirm(page).click();
        await expect.poll(() => f.holds.length).toBe(1);
        await expect(
          review(page).locator(".modal-footer button").last(),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(review(page)).toBeVisible();
        const prevented = await page.evaluate(() => {
          const e = new Event("vectory:before-navigate", { cancelable: true });
          window.dispatchEvent(e);
          return e.defaultPrevented;
        });
        expect(prevented).toBe(true);
        expect(f.rollbacks).toHaveLength(1);
        f.holds.shift()();
        await expect(receipt(page)).toBeVisible();
        await clean(f);
      } finally {
        await app.close();
      }
      for (const role of ["viewer", "editor"]) {
        f = fixture();
        app = await start(f, { role });
        try {
          await open(app.page);
          await expect(
            dialog(app.page).getByRole("button", {
              name: "Roll back",
              exact: true,
            }),
          ).toHaveCount(0);
          expect(previewCalls(f)).toHaveLength(0);
          await clean(f);
        } finally {
          await app.close();
        }
      }
    },
  );
  await check(
    "Review list search and paging preserve complete scope; desktop/mobile themes contain included/excluded views with clean accessibility",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          const f = fixture(),
            app = await start(f, { width, theme });
          try {
            const { page } = app;
            await begin(page);
            await ready(page);
            await review(page)
              .getByRole("button", { name: "Excluded (2)", exact: true })
              .click();
            await expect(
              review(page).getByRole("list", { name: "Excluded devices" }),
            ).toContainText("Device revoked");
            const scan = await new AxeBuilder({ page }).analyze();
            accessibility.push({ width, theme, violations: scan.violations });
            expect(scan.violations).toEqual([]);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const file = resolve(
              output,
              `reviewed-rollback-${width}-${theme}.png`,
            );
            await page.screenshot({ path: file });
            screenshots.push(file);
            await clean(f);
          } finally {
            await app.close();
          }
        }
      const f = fixture({
          preview: preview({
            eligible_devices: Array.from({ length: 10 }, (_, i) => ({
              device_id: id(10 + i),
              device_name: "Synthetic eligible " + i,
              artifact_sha256: "a".repeat(64),
            })),
          }),
        }),
        app = await start(f, { width: 375, theme: "dark" });
      try {
        const { page } = app;
        await begin(page);
        await expect(
          review(page).getByRole("button", {
            name: "Included (10)",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          review(page)
            .getByRole("list", { name: "Included devices" })
            .getByRole("listitem"),
        ).toHaveCount(8);
        const footer = await review(page)
          .locator(".modal-footer")
          .boundingBox();
        const heading = await review(page)
          .getByRole("heading", { name: "Review rollback", exact: true })
          .boundingBox();
        expect(footer.y + footer.height).toBeLessThanOrEqual(951);
        expect(heading.y).toBeGreaterThanOrEqual(0);
        await review(page)
          .getByRole("list", { name: "Included devices" })
          .getByRole("listitem")
          .last()
          .scrollIntoViewIfNeeded();
        await expect(review(page).locator(".modal-footer")).toBeVisible();
        expect(
          (
            await review(page)
              .getByRole("heading", { name: "Review rollback", exact: true })
              .boundingBox()
          ).y,
        ).toBe(heading.y);
        await review(page)
          .getByRole("button", { name: "Next", exact: true })
          .click();
        await expect(
          review(page)
            .getByRole("list", { name: "Included devices" })
            .getByRole("listitem"),
        ).toHaveCount(2);
        await review(page)
          .getByPlaceholder("Find reviewed devices")
          .fill("eligible 4");
        await expect(
          review(page)
            .getByRole("list", { name: "Included devices" })
            .getByRole("listitem"),
        ).toHaveCount(1);
        await expect(
          review(page).getByRole("button", {
            name: "Included (10)",
            exact: true,
          }),
        ).toBeVisible();
        expect(f.rollbacks).toEqual([]);
        await clean(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "A rollout that released nothing says so in the server's words, with no restore story and nothing to confirm",
    async () => {
      const sentence =
        "Nothing was released, so there is nothing to roll back.";
      for (const [width, theme] of [
        [899, "light"],
        [390, "dark"],
      ]) {
        const f = fixture({
          preview: preview({
            source_status: "cancelled",
            previous_version_id: null,
            previous_version_number: null,
            previous_configuration_id: null,
            previous_configuration_name: null,
            eligible_devices: [],
            excluded_devices: [
              {
                device_id: id(1),
                device_name: "Synthetic live alpha",
                reason: "not_released",
              },
            ],
            blockers: [{ code: "NOTHING_RELEASED", reason: sentence }],
            ready: false,
          }),
        });
        const app = await start(f, { width, theme });
        try {
          const { page } = app;
          await begin(page);
          await expect(review(page)).toContainText("Nothing to roll back");
          await expect(review(page)).toContainText(sentence);
          await expect(review(page)).not.toContainText("Restores");
          await expect(
            review(page).getByRole("list", { name: "What changes" }),
          ).toHaveCount(0);
          await expect(
            review(page).getByRole("button", {
              name: "Roll back",
              exact: true,
            }),
          ).toBeDisabled();
          const axe = await new AxeBuilder({ page }).analyze();
          accessibility.push({
            width,
            theme,
            view: "nothing released",
            violations: axe.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              nodes: v.nodes.map((n) => n.target),
            })),
          });
          expect(axe.violations).toEqual([]);
          const file = `rollback-nothing-released-${width}-${theme}.png`;
          await page.screenshot({ path: resolve(output, file) });
          screenshots.push(file);
          expect(f.rollbacks).toEqual([]);
          await clean(f);
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
      "Actual App with intercepted synthetic rollback preview, commit and lookup. No live API, native transition or agent activation executed.",
    passed:
      results.length === 10 &&
      results.every((r) => r.passed) &&
      accessibility.length === 6 &&
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
