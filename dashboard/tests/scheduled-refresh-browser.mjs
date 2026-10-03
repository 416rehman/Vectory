// Actual App with isolated, explicitly synthetic HTTP. No preview or fleet access.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_SCHEDULED_REFRESH_OUTPUT || ".local/scheduled-refresh",
);
const before = process.env.VECTORY_SCHEDULED_REFRESH_BEFORE === "1";
await mkdir(output, { recursive: true });
const sources = [
  "dashboard/src/App.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/src/Deployments.tsx",
  "dashboard/src/RecoveryActions.tsx",
  "dashboard/src/control.css",
  "dashboard/src/deploymentRouting.ts",
  "dashboard/tests/scheduled-refresh-browser.mjs",
];
if (!before)
  sources.push(
    "dashboard/src/ScheduledAssignmentRefresh.tsx",
    "dashboard/src/scheduledAssignmentRefreshModel.ts",
    "dashboard/src/scheduled-assignment-refresh.css",
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (p) => [p, hash(await readFile(resolve(root, p)))]),
    ),
  );
const sourceStart = await hashes();
const reservation = net.createServer();
await new Promise((yes, no) => {
  reservation.once("error", no);
  reservation.listen(0, "127.0.0.1", yes);
});
const port = reservation.address().port;
await new Promise((yes) => reservation.close(yes));
let state, context, page, failure;
const virtual = "\0virtual:scheduled-refresh-fixture";
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "scheduled-refresh-independent-fixture",
      resolveId(id) {
        if (id === "virtual:scheduled-refresh-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';const root=createRoot(document.getElementById('root'));let key=0;window.mount=()=>root.render(React.createElement(App,{key:++key}));window.ready=true;`;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const stream = state?.streams.get(req.url);
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
          if (req.url !== "/__scheduled-refresh") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic scheduled refresh verification</title></head><body><div id="root"></div><script type="module">import "virtual:scheduled-refresh-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`,
  browser = await chromium.launch();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  sourceId = id(40),
  created = "2026-09-27T12:00:00Z";
const results = [],
  observations = [],
  requests = [],
  errors = [],
  unexpected = [],
  accessibility = [];
function device(n) {
  return {
    id: id(n),
    name: `Synthetic ${n === 1 ? "alpha" : n === 2 ? "beta" : n === 3 ? "gamma" : n}`,
    os: "linux",
    arch: "amd64",
    status: "online",
    apply_state: "verified_applied",
    desired_generation: 1,
    reported_generation: 1,
    desired_version_id: id(11),
    configuration_mode: "full",
    labels: {},
    sync_paused: false,
    local_paused: false,
    created_at: created,
  };
}
function summary() {
  return {
    id: sourceId,
    name: "Synthetic future scheduled rollout",
    configuration_id: id(10),
    configuration_name: "Synthetic pipeline",
    version_id: state.resource === "policy" ? null : id(11),
    version_number: 2,
    policy:
      state.resource === "policy"
        ? { heartbeat_seconds: 60, sync_paused: false, telemetry_enabled: true }
        : null,
    priority: 100,
    target_mode: "snapshot",
    status: state.status,
    scheduled_at: "2027-01-01T12:00:00Z",
    created_at: created,
    rollout: {
      kind: "all",
      canary_size: 1,
      batch_size: 10,
      observation_seconds: 0,
      failure_threshold: 0,
    },
    target_count: state.savedMembers.length,
    verified_count: 0,
    state_counts: { pending: state.savedMembers.length },
    rollback_idempotency: true,
    rollback_review: true,
    request_correlation: true,
  };
}
function deployment() {
  return {
    ...summary(),
    selector: { device_ids: [], group_ids: [id(20)], exclude_ids: [] },
    targets: state.savedMembers.map((n) => ({
      device_id: id(n),
      state: "pending",
      generation: 0,
      error: null,
    })),
  };
}
function preview() {
  const compact = (n) => ({
    id: id(n),
    name: device(n).name,
    status: device(n).status,
  });
  const blockers =
    state.status !== "scheduled"
      ? [
          {
            code: "SCHEDULE_INACTIVE",
            reason: "The schedule has started or is inactive.",
          },
        ]
      : state.blockers.length
        ? state.blockers
        : state.members.length
          ? []
          : [
              {
                code: "EMPTY_TARGETS",
                reason: "A schedule needs at least one proposed device.",
              },
            ];
  let value = {
    refresh_review: true,
    source_deployment_id: sourceId,
    source_status: state.status,
    resource: state.resource,
    scheduled_at: summary().scheduled_at,
    review_token: hash(
      JSON.stringify({
        actor: state.actor,
        id: sourceId,
        status: state.status,
        saved: [...state.savedMembers].sort(),
        proposed: [...state.members].sort(),
        revision: state.refreshRevision,
      }),
    ),
    ready: !blockers.length,
    blockers,
    warnings: [
      "Synthetic saved selection changes only; devices are not released or activated.",
    ],
    saved_devices: state.savedMembers.map(compact),
    devices: state.status === "scheduled" ? state.members.map(compact) : [],
  };
  if (state.previewFault === "legacy")
    value = { devices: state.members.map(device), conflicts: [], warnings: [] };
  if (state.previewFault === "source") value.source_deployment_id = id(99);
  if (state.previewFault === "token") value.review_token = "broken";
  if (state.previewFault === "duplicates") value.devices.push(value.devices[0]);
  if (state.previewFault === "status") value.source_status = "active";
  return value;
}
async function load({
  width = 899,
  theme = "light",
  role = "admin",
  status = "scheduled",
} = {}) {
  if (context) await context.close();
  state = {
    actor: id(90),
    role,
    status,
    members: [1, 2],
    savedMembers: [1],
    resource: "configuration",
    refreshRevision: 0,
    previewFault: null,
    blockers: [],
    audits: 0,
    inactiveConflict: false,
    previewMode: "normal",
    commitMode: "normal",
    summaryMode: "normal",
    previews: [],
    commits: [],
    summaryReads: 0,
    holds: [],
    streams: new Map(),
    bodyHolds: [],
    abortedBodies: 0,
  };
  const s = state;
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
    const path = url.pathname.slice(7),
      body = method === "POST" ? JSON.parse(req.postData() || "{}") : undefined;
    requests.push({
      method,
      path,
      query: url.search,
      ...(body ? { body } : {}),
    });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    const staged = async (value, mode) => {
      if (mode === "hold") await new Promise((yes) => s.holds.push(yes));
      if (mode === "heldBody") {
        s.streams.set(url.pathname, JSON.stringify(value));
        return route.continue();
      }
      if (mode === "failed")
        return reply(
          {
            error: {
              code: "SYNTHETIC_UNAVAILABLE",
              message: "Synthetic request unavailable",
            },
          },
          503,
        );
      return reply(value);
    };
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: s.actor,
            name: "Synthetic operator",
            email: "fixture@example.test",
            role: s.role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic scheduled refresh fixture" });
      if (path === "/mfa") return reply({ enabled: false });
      if (path === "/deployments/history")
        return reply({
          items: [summary()],
          total: 1,
          page: 1,
          page_size: 12,
          request_history: true,
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
      if (path === `/deployments/${sourceId}/summary`) {
        s.summaryReads++;
        const value = summary();
        if (s.summaryMode === "wrongSource") value.id = id(99);
        if (s.summaryMode === "malformed") delete value.status;
        return staged(value, s.summaryMode);
      }
      if (path === `/deployments/${sourceId}/targets`)
        return reply({
          items: s.savedMembers.map((n) => ({
            device_id: id(n),
            device_name: device(n).name,
            state: "pending",
            generation: 0,
            error: null,
            desired_generation: 1,
            reported_generation: 1,
          })),
          total: s.savedMembers.length,
          page: 1,
          page_size: 12,
        });
    }
    if (
      method === "POST" &&
      path === `/deployments/${sourceId}/refresh-preview`
    ) {
      if (!before && s.inactiveConflict)
        return reply(
          {
            error: {
              code: "CONFLICT",
              message:
                "Schedule activation already started or schedule is inactive",
            },
          },
          409,
        );
      const value = before
        ? {
            devices: s.members.map(device),
            warnings: [
              "Synthetic membership is reviewed before this future schedule runs.",
            ],
            conflicts: [],
          }
        : preview();
      s.previews.push(structuredClone(value));
      return staged(value, s.previewMode);
    }
    if (method === "POST" && path === `/deployments/${sourceId}/refresh`) {
      expect(req.headers()["x-csrf-token"]).toBe("synthetic");
      s.commits.push(body);
      if (s.commitMode === "hold")
        await new Promise((yes) => s.holds.push(yes));
      if (s.commitMode === "uncommitted") return route.abort("failed");
      if (s.commitMode === "forbidden")
        return reply(
          {
            error: {
              code: "FORBIDDEN",
              message: "Synthetic permission rejected",
            },
          },
          403,
        );
      if (
        !before &&
        (body.review_token !== preview().review_token ||
          s.status !== "scheduled")
      )
        return reply(
          {
            error: {
              code: "SCHEDULE_REFRESH_REVIEW_CHANGED",
              message:
                "The schedule review changed. Refresh review before confirming.",
            },
          },
          409,
        );
      if (
        JSON.stringify([...body.expected_device_ids].sort()) !==
        JSON.stringify(s.members.map(id).sort())
      )
        return reply(
          {
            error: {
              code: before ? "CONFLICT" : "SCHEDULE_REFRESH_REVIEW_CHANGED",
              message: "Scheduled device selection changed. Review again.",
            },
          },
          409,
        );
      if (
        JSON.stringify([...s.savedMembers].sort()) !==
        JSON.stringify([...s.members].sort())
      ) {
        s.refreshRevision++;
        s.audits++;
        s.savedMembers = [...s.members];
      }
      if (s.commitMode === "lost") return route.abort("failed");
      const value = deployment();
      if (s.commitMode === "wrongSource") value.id = id(99);
      if (s.commitMode === "wrongTargets") value.targets[0].device_id = id(99);
      if (s.commitMode === "released") value.targets[0].generation = 1;
      if (s.commitMode === "malformed") return reply({ id: sourceId });
      // Header holds are released above, before the synthetic writer step.
      return staged(value, s.commitMode === "hold" ? "normal" : s.commitMode);
    }
    unexpected.push(`${method} ${path}`);
    return reply(
      {
        error: {
          code: "UNEXPECTED_REQUEST",
          message: "Synthetic route not modeled",
        },
      },
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    `${origin}/__scheduled-refresh#/deployments/${sourceId}?page=1`,
  );
  await page.waitForFunction(() => window.ready, undefined, { timeout: 30000 });
  await page.evaluate(() => window.mount());
  await expect(details()).toBeVisible();
}
const details = () =>
  page.getByRole("region", { name: "Deployment details", exact: true });
const review = () =>
  page.getByRole("dialog", { name: "Update scheduled devices", exact: true });
const confirm = () =>
  review().getByRole("button", {
    name: /Update scheduled devices$/,
  });
const saved = () =>
  page.getByRole("dialog", { name: "Scheduled devices updated", exact: true });
const refresh = () => review().getByRole("button", { name: /Refresh review$/ });
const checkSelection = () =>
  review().getByRole("button", { name: /Check current selection$/ });
async function closeReview() {
  await review()
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(review()).toHaveCount(0);
  await expect(details()).toBeVisible();
}
async function openReview({ ready = true } = {}) {
  await details()
    .getByRole("button", { name: "Review scheduled devices", exact: true })
    .click();
  await expect(review()).toBeVisible();
  if (ready)
    await expect(
      review().getByRole("table", {
        name: before ? "Affected devices" : "Scheduled device selection",
        exact: true,
      }),
    ).toBeVisible();
}
async function check(name, run) {
  const focus = process.env.VECTORY_SCHEDULED_REFRESH_FOCUS;
  if (focus && !name.toLowerCase().includes(focus.toLowerCase())) return;
  const began = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - began });
  console.log("PASS", name);
}
try {
  if (before) {
    await check(
      "Before held preview remains loading beyond30seconds but can be cancelled",
      async () => {
        await load();
        await page.clock.install();
        state.previewMode = "hold";
        await openReview({ ready: false });
        await expect.poll(() => state.holds.length).toBe(1);
        await page.clock.fastForward(31000);
        await page.clock.runFor(100);
        await expect(review()).toContainText("Loading affected devices");
        await expect(confirm()).toBeDisabled();
        await expect(
          review().getByRole("button", { name: "Cancel", exact: true }),
        ).toBeEnabled();
        observations.push({
          stage: "preview",
          elapsedVirtualMilliseconds: 31100,
          loading: true,
          timeoutError: false,
          cancelAvailable: true,
          commits: state.commits.length,
        });
        await page.screenshot({
          path: resolve(output, "before-preview-stalled.png"),
        });
        await review()
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(review()).toHaveCount(0);
        state.holds.shift()();
      },
    );
    await check(
      "Before held commit keeps close and navigation blocked beyond30seconds",
      async () => {
        await load();
        await page.clock.install();
        await openReview();
        state.commitMode = "hold";
        await confirm().click();
        await expect.poll(() => state.holds.length).toBe(1);
        await page.clock.fastForward(31000);
        await page.clock.runFor(100);
        await expect(
          review().getByRole("button", { name: "Cancel", exact: true }),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(review()).toBeVisible();
        await review()
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        await expect(review()).toBeVisible();
        await page.evaluate(() => (location.hash = "#/deployments?page=1"));
        await expect(page).toHaveURL(new RegExp(sourceId));
        await expect(review()).toBeVisible();
        expect(state.commits).toHaveLength(1);
        expect(state.savedMembers).toEqual([1]);
        observations.push({
          stage: "commit",
          elapsedVirtualMilliseconds: 31100,
          cancelDisabled: true,
          escapeAndCloseIgnored: true,
          navigationVetoed: true,
          posts: 1,
          syntheticServerNotCommittedYet: true,
        });
        await page.screenshot({
          path: resolve(output, "before-commit-stalled.png"),
        });
        state.holds.shift()();
        await expect.poll(() => state.savedMembers).toEqual([1, 2]);
      },
    );
  } else {
    await check(
      "Saved and proposed differences remain complete when all but one reviewed row is filtered",
      async () => {
        await load();
        state.savedMembers = [1, 3];
        await openReview();
        await expect(details()).toHaveCount(0);
        for (const text of [
          "Synthetic alpha",
          "Synthetic beta",
          "Synthetic gamma",
          "Add device",
          "Keep device",
          "Remove device",
        ])
          await expect(review()).toContainText(text);
        const token = state.previews[0].review_token;
        await review()
          .getByRole("button", { name: "Filter Device", exact: true })
          .click();
        await page
          .getByPlaceholder("Find a reviewed device")
          .fill("Synthetic beta");
        await page.keyboard.press("Escape");
        await expect(
          review().getByRole("table", {
            name: "Scheduled device selection",
            exact: true,
          }),
        ).not.toContainText("Synthetic alpha");
        await confirm().click();
        await expect(saved()).toBeVisible();
        expect(state.commits).toEqual([
          { review_token: token, expected_device_ids: [id(1), id(2)] },
        ]);
        expect(state.savedMembers).toEqual([1, 2]);
        expect(state.audits).toBe(1);
        await expect(saved()).toContainText("does not activate");
      },
    );
    await check(
      "Membership and newer saved snapshot revisions require explicit refresh then separate confirmation",
      async () => {
        for (const drift of ["membership", "savedSnapshot", "aba"]) {
          await load();
          await openReview();
          const old = state.previews[0].review_token;
          if (drift === "membership") state.members = [1, 2, 3];
          else if (drift === "savedSnapshot") {
            state.savedMembers = [3];
            state.refreshRevision++;
          } else {
            state.savedMembers = [3];
            state.refreshRevision++;
            state.savedMembers = [1];
            state.refreshRevision++;
          }
          await confirm().click();
          await expect(review()).toContainText("review changed");
          await expect(confirm()).toBeDisabled();
          expect(state.previews).toHaveLength(1);
          expect(state.audits).toBe(0);
          await refresh().click();
          await expect(confirm()).toBeEnabled();
          expect(state.commits).toHaveLength(1);
          expect(state.previews[1].review_token).not.toBe(old);
          await confirm().click();
          await expect(saved()).toBeVisible();
          expect(state.commits).toHaveLength(2);
          expect(state.audits).toBe(1);
        }
      },
    );
    await check(
      "Legacy malformed mismatched duplicate and empty reviews fail closed while unchanged selection sends nothing",
      async () => {
        for (const fault of [
          "legacy",
          "source",
          "token",
          "duplicates",
          "status",
          "empty",
        ]) {
          await load();
          if (fault === "empty") state.members = [];
          else state.previewFault = fault;
          await openReview({ ready: false });
          await expect.poll(() => state.previews.length).toBe(1);
          await expect(confirm()).toBeDisabled();
          if (fault === "empty")
            await expect(review()).toContainText("Selection cannot be updated");
          else await expect(review().getByRole("alert")).toBeVisible();
          expect(state.commits).toHaveLength(0);
        }
        await load();
        state.members = [1];
        await openReview();
        await expect(review()).toContainText("Selection is already current");
        await expect(confirm()).toBeDisabled();
        expect(state.commits).toHaveLength(0);
        expect(state.audits).toBe(0);
      },
    );
    await check(
      "Lost malformed wrong-source and wrong-target commit results need exact current-selection observation without resend",
      async () => {
        for (const mode of [
          "lost",
          "malformed",
          "wrongSource",
          "wrongTargets",
          "released",
        ]) {
          await load();
          await openReview();
          state.commitMode = mode;
          await confirm().click();
          await expect(checkSelection()).toBeVisible();
          expect(state.commits).toHaveLength(1);
          await closeReview();
          await openReview({ ready: false });
          await expect(checkSelection()).toBeVisible();
          expect(state.previews).toHaveLength(1);
          state.previewFault = "source";
          await checkSelection().click();
          await expect(review().getByRole("alert")).toBeVisible();
          await expect(checkSelection()).toBeEnabled();
          expect(state.commits).toHaveLength(1);
          state.previewFault = null;
          state.previewMode = "failed";
          await checkSelection().click();
          await expect(review()).toContainText("Synthetic request unavailable");
          await expect(checkSelection()).toBeEnabled();
          state.previewMode = "normal";
          await checkSelection().click();
          await expect(review()).toContainText(
            "current saved selection matches",
          );
          await expect(review()).toContainText(
            "does not identify which request",
          );
          await expect(confirm()).toBeDisabled();
          expect(state.commits).toHaveLength(1);
          expect(state.audits).toBe(1);
        }
      },
    );
    await check(
      "Uncommitted uncertainty survives closing all details and requires current read plus new review before another send",
      async () => {
        await load();
        await openReview();
        state.commitMode = "uncommitted";
        await confirm().click();
        await expect(checkSelection()).toBeVisible();
        await closeReview();
        await details()
          .getByRole("navigation", { name: "Breadcrumb" })
          .getByRole("link", { name: /^(Deployments|Schedules)$/ })
          .click();
        await page
          .getByRole("button", {
            name: "View details for Synthetic future scheduled rollout",
            exact: true,
          })
          .click();
        await openReview({ ready: false });
        await expect(checkSelection()).toBeVisible();
        expect(state.previews).toHaveLength(1);
        state.previewMode = "hold";
        await checkSelection().click();
        await expect.poll(() => state.holds.length).toBe(1);
        expect(state.commits).toHaveLength(1);
        state.holds.shift()();
        await expect(review()).toContainText("current saved selection differs");
        await expect(confirm()).toBeDisabled();
        state.previewMode = "normal";
        state.commitMode = "normal";
        await refresh().click();
        await expect(confirm()).toBeEnabled();
        expect(state.commits).toHaveLength(1);
        await confirm().click();
        await expect(saved()).toBeVisible();
        expect(state.commits).toHaveLength(2);
        expect(state.audits).toBe(1);
      },
    );
    await check(
      "Started or cancelled schedules expose saved current selection or exact source status with no refresh authority",
      async () => {
        for (const mode of ["modern", "fallback"]) {
          await load();
          await openReview();
          state.commitMode = "lost";
          await confirm().click();
          await expect(checkSelection()).toBeVisible();
          state.status = mode === "modern" ? "active" : "cancelled";
          state.inactiveConflict = mode === "fallback";
          if (mode === "fallback") {
            state.summaryMode = "wrongSource";
            await checkSelection().click();
            await expect(review().getByRole("alert")).toBeVisible();
            await expect(checkSelection()).toBeEnabled();
            state.summaryMode = "normal";
          }
          await checkSelection().click();
          await expect(review()).toContainText("can no longer be updated");
          await expect(confirm()).toHaveCount(0);
          await expect(refresh()).toHaveCount(0);
          if (mode === "modern") {
            await expect(review()).toContainText("Current saved selection");
            await expect(review()).not.toContainText("Remove device");
          }
          expect(state.commits).toHaveLength(1);
        }
      },
    );
    await check(
      "Preview commit and current-selection body deadlines release controls and keep uncertainty without automatic retry",
      async () => {
        for (const phase of ["preview", "commit", "current", "fallback"]) {
          await load();
          await page.clock.install();
          if (phase === "preview") state.previewMode = "heldBody";
          await openReview({ ready: phase !== "preview" });
          if (phase === "commit") {
            state.commitMode = "heldBody";
            await confirm().click();
          }
          if (phase === "current" || phase === "fallback") {
            state.commitMode = "lost";
            await confirm().click();
            await expect(checkSelection()).toBeVisible();
            if (phase === "current") state.previewMode = "heldBody";
            else {
              state.inactiveConflict = true;
              state.status = "cancelled";
              state.summaryMode = "heldBody";
            }
            await checkSelection().click();
          }
          await expect.poll(() => state.bodyHolds.length).toBeGreaterThan(0);
          await page.clock.fastForward(30050);
          await page.clock.runFor(100);
          await expect(review()).toContainText("taking too long");
          if (phase === "preview") await expect(refresh()).toBeEnabled();
          else await expect(checkSelection()).toBeEnabled();
          await expect(
            review().getByRole("button", { name: "Cancel", exact: true }),
          ).toBeEnabled();
          expect(state.commits).toHaveLength(phase === "preview" ? 0 : 1);
          while (state.bodyHolds.length) state.bodyHolds.shift()();
        }
      },
    );
    await check(
      "Double activation and busy close or navigation cannot duplicate or abandon an in-flight confirmation",
      async () => {
        await load();
        await openReview();
        state.commitMode = "hold";
        await confirm().dblclick();
        await expect.poll(() => state.holds.length).toBe(1);
        expect(state.commits).toHaveLength(1);
        await page.keyboard.press("Escape");
        await expect(review()).toBeVisible();
        await review()
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        await expect(review()).toBeVisible();
        await page.evaluate(() => (location.hash = "#/deployments?page=1"));
        await expect(page).toHaveURL(new RegExp(sourceId));
        state.holds.shift()();
        await expect(saved()).toBeVisible();
        expect(state.audits).toBe(1);
      },
    );
    await check(
      "Viewer role actor replacement and session invalidation suppress stale review or commit outcomes",
      async () => {
        await load({ role: "viewer" });
        await expect(
          details().getByRole("button", {
            name: "Review scheduled devices",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(state.previews).toHaveLength(0);
        for (const stage of ["preview", "commit", "body"]) {
          await load();
          if (stage !== "commit")
            state.previewMode = stage === "body" ? "heldBody" : "hold";
          await openReview({ ready: stage === "commit" });
          if (stage === "commit") {
            state.commitMode = "hold";
            await confirm().click();
          }
          await expect
            .poll(() =>
              stage === "body" ? state.bodyHolds.length : state.holds.length,
            )
            .toBe(1);
          state.actor = id(91);
          state.role = "viewer";
          await page.evaluate(() =>
            window.dispatchEvent(
              new StorageEvent("storage", {
                key: "vectory-session-change",
                newValue: "synthetic-other-account",
              }),
            ),
          );
          await expect(page.locator(".session-renewal")).toContainText(
            "Your session ended",
          );
          await expect(confirm()).toHaveCount(0);
          if (stage === "body") {
            await expect.poll(() => state.abortedBodies).toBeGreaterThan(0);
            state.bodyHolds.shift()();
          } else state.holds.shift()();
          await expect(saved()).toHaveCount(0);
          await expect(
            page
              .getByRole("status")
              .filter({ hasText: "Scheduled device selection updated." }),
          ).toHaveCount(0);
          expect(state.commits).toHaveLength(stage === "commit" ? 1 : 0);
        }
        // Same-account downgrade must also invalidate a held mutation response.
        await load();
        await openReview();
        state.commitMode = "hold";
        await confirm().click();
        await expect.poll(() => state.holds.length).toBe(1);
        state.role = "viewer";
        await page.evaluate(() =>
          window.dispatchEvent(
            new StorageEvent("storage", {
              key: "vectory-session-change",
              newValue: "synthetic-role-change",
            }),
          ),
        );
        await expect(confirm()).toHaveCount(0);
        state.holds.shift()();
        await expect(saved()).toHaveCount(0);
        expect(state.commits).toHaveLength(1);
        await load();
        state.previewMode = "hold";
        await openReview({ ready: false });
        await expect.poll(() => state.holds.length).toBe(1);
        state.actor = id(91);
        state.role = "viewer";
        await page.evaluate(() => window.mount());
        await expect(details()).toBeVisible();
        state.holds.shift()();
        await expect(review()).toHaveCount(0);
        expect(state.commits).toHaveLength(0);
      },
    );
    await check(
      "Cancelling a schedule says nothing was released, and a schedule cancelled before it started offers no rollback",
      async () => {
        for (const width of [899, 390])
          for (const theme of ["light", "dark"]) {
            await load({ width, theme });
            await details()
              .getByRole("button", { name: "Cancel schedule", exact: true })
              .click();
            const cancel = page.getByRole("dialog", {
              name: "Cancel schedule",
              exact: true,
            });
            await expect(cancel).toContainText(
              "Nothing has been released. The schedule never starts, and no device changes.",
            );
            await expect(cancel).not.toContainText("already received it");
            await expect(cancel).not.toContainText("Rollback");
            const scan = await new AxeBuilder({ page })
              .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
              .analyze();
            expect(scan.violations).toEqual([]);
            accessibility.push({
              width,
              theme,
              view: "cancel schedule",
              violations: scan.violations,
            });
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth),
            ).toBeLessThanOrEqual(width);
            await page.screenshot({
              path: resolve(output, `schedule-cancel-${width}-${theme}.png`),
            });
            await cancel
              .getByRole("button", { name: "Keep current state", exact: true })
              .click();
            await expect(cancel).toHaveCount(0);

            await load({ width, theme, status: "cancelled" });
            await expect(
              details().getByRole("button", {
                name: "Remove assignment",
                exact: true,
              }),
            ).toBeVisible();
            await expect(
              details().getByRole("button", { name: /^Roll back/ }),
            ).toHaveCount(0);
            await expect(
              details().getByRole("button", {
                name: /^(Stop rollout|Roll back or remove)$/,
              }),
            ).toHaveCount(0);
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth),
            ).toBeLessThanOrEqual(width);
            await page.screenshot({
              path: resolve(output, `schedule-cancelled-${width}-${theme}.png`),
            });
          }
      },
    );
    await check(
      "A device the pipeline cannot reach is named by the blocker, in every theme and width, and nothing is sent",
      async () => {
        const reason =
          "This published configuration requires full Vector mode on the selected device. Only its host operator can enable that mode locally.";
        for (const width of [899, 390])
          for (const theme of ["light", "dark"]) {
            await load({ width, theme });
            state.members = [1, 2, 3];
            state.blockers = [
              {
                code: "FULL_VECTOR_MODE_REQUIRED",
                reason,
                resource: "configuration",
                device_ids: [id(2), id(3)],
              },
              {
                code: "VECTOR_VERSION_INCOMPATIBLE",
                reason:
                  "The selected device does not report a Vector 0.58.x version. Review its local Vector installation before deploying.",
                resource: "configuration",
                device_ids: [id(3)],
              },
            ];
            await openReview();
            await expect(review()).toContainText("Selection cannot be updated");
            await expect(review()).toContainText(reason);
            await expect(review()).toContainText(
              "2 affected devices: Synthetic beta, Synthetic gamma.",
            );
            await expect(review()).toContainText(
              "1 affected device: Synthetic gamma.",
            );
            await expect(review()).not.toContainText(
              "does not match this dashboard version",
            );
            await expect(review().getByRole("alert")).toHaveCount(0);
            await expect(confirm()).toBeDisabled();
            const scan = await new AxeBuilder({ page })
              .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
              .analyze();
            expect(scan.violations).toEqual([]);
            accessibility.push({
              width,
              theme,
              view: "blocked",
              violations: scan.violations,
            });
            const g = await review().evaluate((el) => {
              const box = el.getBoundingClientRect(),
                note = el
                  .querySelector(".scheduled-refresh-blocked")
                  .getBoundingClientRect();
              return {
                x: box.x,
                right: box.right,
                noteLeft: note.x,
                noteRight: note.right,
                scroll: document.documentElement.scrollWidth,
                width: innerWidth,
              };
            });
            expect(g.x).toBeGreaterThanOrEqual(0);
            expect(g.right).toBeLessThanOrEqual(g.width);
            expect(g.noteLeft).toBeGreaterThanOrEqual(g.x);
            expect(g.noteRight).toBeLessThanOrEqual(g.right);
            expect(g.scroll).toBeLessThanOrEqual(g.width);
            await page.screenshot({
              path: resolve(
                output,
                `scheduled-refresh-blocked-${width}-${theme}.png`,
              ),
            });
            expect(state.commits).toHaveLength(0);
          }
      },
    );
    await check(
      "Saved proposal differences keep usable keyboard focus and mobile light-dark accessible controls",
      async () => {
        for (const width of [899, 375])
          for (const theme of ["light", "dark"]) {
            await load({ width, theme });
            state.savedMembers = [1, 3];
            if (theme === "light") state.resource = "policy";
            await openReview();
            await expect(details()).toHaveCount(0);
            const scan = await new AxeBuilder({ page })
              .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
              .analyze();
            expect(scan.violations).toEqual([]);
            accessibility.push({ width, theme, violations: scan.violations });
            const g = await review().evaluate((el) => {
              const box = el.getBoundingClientRect(),
                footer = el
                  .querySelector(".modal-footer")
                  .getBoundingClientRect(),
                change = el
                  .querySelector(".scheduled-refresh-change")
                  .getBoundingClientRect();
              return {
                x: box.x,
                right: box.right,
                width: innerWidth,
                height: innerHeight,
                footerBottom: footer.bottom,
                changeLeft: change.x,
                changeRight: change.right,
              };
            });
            expect(g.x).toBeGreaterThanOrEqual(0);
            expect(g.right).toBeLessThanOrEqual(g.width);
            expect(g.footerBottom).toBeLessThanOrEqual(g.height);
            expect(g.changeLeft).toBeGreaterThanOrEqual(g.x);
            expect(g.changeRight).toBeLessThanOrEqual(g.right);
            await page.screenshot({
              path: resolve(output, `scheduled-refresh-${width}-${theme}.png`),
            });
            await page.keyboard.press("Escape");
            await expect(review()).toHaveCount(0);
            await expect(details()).toBeVisible();
            expect(state.commits).toHaveLength(0);
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
  const sourceEnd = await hashes();
  if (before) {
    await mkdir(resolve(output, "source"), { recursive: true });
    for (const p of sources)
      await copyFile(
        resolve(root, p),
        resolve(output, "source", p.replaceAll("/", "__")),
      );
  }
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Actual App with intercepted synthetic HTTP and accelerated browser timers. No native authority/activation claim, live credentials/fleet/backend/services/releases accessed or modified.",
        passed: !failure,
        classification: before
          ? "expected_defect_observation"
          : "focused_correctness_acceptance",
        correctness_acceptance: !before,
        results,
        observations,
        requests,
        unexpected,
        errors,
        accessibility,
        source_sha256: sourceEnd,
        source_sha256_at_start: sourceStart,
        source_changes_during_run: Object.keys(sourceStart).filter(
          (p) => sourceStart[p] !== sourceEnd[p],
        ),
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
  await vite.close();
  console.log("Evidence: " + relative(root, resolve(output, "report.json")));
}
