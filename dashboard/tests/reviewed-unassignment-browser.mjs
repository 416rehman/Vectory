// Actual App; intercepted, explicitly synthetic assignment-removal transport only.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_UNASSIGNMENT_OUTPUT || ".local/reviewed-unassignment",
);
await mkdir(output, { recursive: true });
const sources = [
  "src/App.tsx",
  "src/Deployments.tsx",
  "src/RecoveryActions.tsx",
  "src/ui.tsx",
  "src/api.ts",
  "src/control.css",
  "src/deploymentRouting.ts",
  "src/Editor.tsx",
  "src/ConfigurationCodeEditor.tsx",
  "tests/reviewed-unassignment-browser.mjs",
];
const beforeMode = process.env.VECTORY_UNASSIGNMENT_BEFORE === "1";
const sessionBefore = process.env.VECTORY_UNASSIGNMENT_SESSION_BEFORE === "1";
if (!beforeMode)
  sources.push(
    "src/AssignmentRemoval.tsx",
    "src/assignmentRemovalModel.ts",
    "src/assignment-removal.css",
  );
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceAtStart = Object.fromEntries(
  await Promise.all(
    sources.map(async (p) => [
      `dashboard/${p}`,
      sha(await readFile(resolve(dashboard, p))),
    ]),
  ),
);
const reservation = net.createServer();
await new Promise((yes, no) => {
  reservation.once("error", no);
  reservation.listen(0, "127.0.0.1", yes);
});
const port = reservation.address().port;
await new Promise((yes) => reservation.close(yes));
const virtual = "\0virtual:reviewed-unassignment";
let state;
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "synthetic-reviewed-unassignment",
      resolveId(id) {
        if (id === "virtual:reviewed-unassignment") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';const root=createRoot(document.getElementById('root'));let key=0;window.mount=()=>root.render(React.createElement(App,{key:++key}));window.ready=true;`;
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
          if (req.url !== "/__reviewed-unassignment") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic assignment removal verification</title></head><body><div id="root"></div><script type="module">import "virtual:reviewed-unassignment";</script></body></html>',
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
const sourceId = id(40),
  configId = id(10),
  versionId = id(11);
const results = [],
  requests = [],
  unexpected = [],
  errors = [],
  observations = [],
  accessibility = [];
let context, page, failure;
function device(n, extra = {}) {
  return {
    id: id(n),
    name: `Synthetic ${n === 1 ? "alpha" : "beta"}`,
    os: "linux",
    arch: "amd64",
    status: "verified",
    apply_state: "verified_applied",
    desired_generation: 1,
    reported_generation: 1,
    desired_version_id: versionId,
    configuration_mode: "full",
    labels: {},
    sync_paused: false,
    local_paused: false,
    created_at: created,
    ...extra,
  };
}
function summary() {
  return {
    id: sourceId,
    name: "Synthetic persistent assignment",
    configuration_id: configId,
    configuration_name: "Synthetic pipeline",
    version_id: versionId,
    version_number: 2,
    policy:
      state.resource === "policy"
        ? { heartbeat_seconds: 60, sync_paused: false, telemetry_enabled: true }
        : null,
    priority: 100,
    target_mode: "persistent",
    status: state.status,
    scheduled_at: null,
    created_at: created,
    rollout: { kind: "all" },
    target_count: state.members.length,
    verified_count: 0,
    state_counts: { desired: state.members.length },
    rollback_idempotency: true,
    rollback_review: true,
    request_correlation: true,
    removal_review: true,
  };
}
const policy = {
  heartbeat_seconds: 60,
  sync_paused: false,
  telemetry_enabled: true,
};
function delivered(extra = {}) {
  return {
    assignment_id: sourceId,
    assignment_name: "Synthetic current assignment",
    version_id: versionId,
    configuration_name: "Synthetic pipeline",
    version_number: 2,
    generation: 4,
    policy: null,
    ...extra,
  };
}
function modernPreview() {
  const rows =
    state.rows ||
    state.members.map((n) => ({
      device_id: id(n),
      device_name: device(n).name,
      effect: state.fallback
        ? "fallback"
        : state.resource === "policy"
          ? "default_policy"
          : "unmanaged",
      before:
        state.resource === "policy"
          ? delivered({
              version_id: null,
              configuration_name: null,
              version_number: null,
              policy: { ...policy, heartbeat_seconds: 180 },
            })
          : delivered(),
      after:
        state.resource === "policy"
          ? delivered({
              assignment_id: null,
              assignment_name: null,
              version_id: null,
              configuration_name: null,
              version_number: null,
              generation: 5,
              policy,
            })
          : state.fallback
            ? delivered({
                assignment_id: state.fallback.id,
                assignment_name: "Synthetic fallback",
                version_id: state.fallback.version_id,
                version_number: 1,
                generation: 5,
              })
            : delivered({
                assignment_id: null,
                assignment_name: null,
                version_id: null,
                configuration_name: null,
                version_number: null,
                generation: 5,
              }),
      pending_assignment_id: null,
      pending_assignment_name: null,
    }));
  const token = sha(
    JSON.stringify({
      source: sourceId,
      actor: state.actor,
      status: state.status,
      resource: state.resource,
      rows: rows.map(
        ({
          device_name,
          pending_assignment_name,
          before,
          after,
          ...identity
        }) => ({
          ...identity,
          before:
            before &&
            (({
              assignment_name,
              configuration_name,
              version_number,
              ...meaningful
            }) => meaningful)(before),
          after:
            after &&
            (({
              assignment_name,
              configuration_name,
              version_number,
              ...meaningful
            }) => meaningful)(after),
        }),
      ),
      sequence: state.sequence,
    }),
  );
  let value = {
    removal_review: true,
    source_deployment_id: sourceId,
    source_status: state.status,
    resource: state.resource,
    ready: !state.blockers.length,
    review_token: token,
    blockers: state.blockers,
    devices: rows,
  };
  if (state.previewFault === "legacy")
    value = { devices: [device(1)], conflicts: [], warnings: [] };
  if (state.previewFault === "source") value.source_deployment_id = id(99);
  if (state.previewFault === "token") value.review_token = "broken";
  if (state.previewFault === "state")
    value.devices[0].after.generation = Number.MAX_SAFE_INTEGER + 1;
  if (state.previewFault === "resource") value.devices[0].after.policy = policy;
  if (state.previewFault === "effect") value.devices[0].effect = "fallback";
  if (state.previewFault === "missing-state") value.devices[0].before = null;
  return value;
}
async function load({
  width = 899,
  theme = "light",
  role = "admin",
  editor = false,
} = {}) {
  if (context) await context.close();
  state = {
    role,
    actor: id(90),
    csrf: "synthetic",
    status: "active",
    members: [1],
    fallback: null,
    previews: [],
    commits: [],
    effects: [],
    resource: "configuration",
    rows: null,
    sequence: 1,
    blockers: [],
    previewFault: null,
    previewMode: "normal",
    commitMode: "normal",
    summaryMode: "normal",
    summaryReads: 0,
    streams: new Map(),
    bodyHolds: [],
    abortedBodies: 0,
    holds: [],
    sessionEnded: false,
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
      body =
        method === "POST"
          ? req.postData()
            ? req.postDataJSON()
            : {}
          : undefined;
    requests.push({
      method,
      path,
      query: url.search,
      ...(body ? { body } : {}),
    });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    const stagedReply = async (value, mode) => {
      if (mode === "hold") await new Promise((yes) => current.holds.push(yes));
      if (mode === "heldBody") {
        current.streams.set(url.pathname, JSON.stringify(value));
        return route.continue();
      }
      if (mode === "failed")
        return reply(
          {
            error: {
              code: "SYNTHETIC_UNAVAILABLE",
              message: "Synthetic status unavailable",
            },
          },
          503,
        );
      return reply(value);
    };
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      // An ended session answers 401, so the shell cannot adopt it again.
      if (path === "/session" && current.sessionEnded)
        return reply(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "Synthetic session ended",
            },
          },
          401,
        );
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
          csrf_token: current.csrf,
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic removal fixture" });
      if (path === "/mfa") return reply({ enabled: false });
      if (path === `/configurations/${id(10)}`)
        return reply({
          id: id(10),
          name: "Synthetic preserved draft",
          description: "No deployment or real writes.",
          revision: 1,
          archived: false,
          archived_at: null,
          created_at: created,
          updated_at: created,
          config: {
            sources: { seed: { type: "demo_logs", format: "json" } },
            transforms: {
              sample: { type: "sample", inputs: ["seed"], rate: 10 },
            },
            sinks: { discard: { type: "blackhole", inputs: ["sample"] } },
          },
          graph: { nodes: [], edges: [] },
        });
      if (path === `/configurations/${id(10)}/history`)
        return reply({
          items: [],
          total: 0,
          page: 1,
          page_size: Number(url.searchParams.get("page_size") || 12),
          kind: url.searchParams.get("kind") || "versions",
        });
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
        current.summaryReads++;
        const value = summary();
        if (current.summaryMode === "wrongSource") value.id = id(99);
        if (current.summaryMode === "malformed") delete value.status;
        return stagedReply(value, current.summaryMode);
      }
      if (path === `/deployments/${sourceId}/targets`)
        return reply({
          items: current.members.map((n) => ({
            device_id: id(n),
            device_name: device(n).name,
            state: "desired",
            generation: 1,
            error: null,
            desired_generation: 1,
            reported_generation: 1,
          })),
          total: current.members.length,
          page: 1,
          page_size: 12,
        });
    }
    if (method === "POST" && path === "/login") {
      current.csrf = "synthetic-reauthenticated";
      return reply({
        user: {
          id: current.actor,
          name: "Synthetic reauthenticated operator",
          email: "fixture@example.test",
          role: current.role,
          enabled: true,
          revision: 1,
        },
        csrf_token: current.csrf,
      });
    }
    if (
      method === "POST" &&
      path === `/deployments/${sourceId}/unassign-preview`
    ) {
      const response = beforeMode
        ? {
            devices: current.members.map((n) =>
              device(n, {
                desired_version_id: current.fallback?.version_id || null,
                assignment: current.fallback
                  ? {
                      id: current.fallback.id,
                      priority: 50,
                      reason: "Synthetic fallback",
                    }
                  : null,
              }),
            ),
            conflicts: [],
            warnings: [
              "Removing the last configuration assignment marks a device unmanaged while retaining its running Vector workload. Lower-priority released assignments may become effective.",
            ],
          }
        : modernPreview();
      current.previews.push(structuredClone(response));
      return stagedReply(response, current.previewMode);
    }
    if (method === "POST" && path === `/deployments/${sourceId}/unassign`) {
      expect(req.headers()["x-csrf-token"]).toBe(current.csrf);
      current.commits.push(structuredClone(body));
      if (!beforeMode && body.review_token !== modernPreview().review_token)
        return reply(
          {
            error: {
              code: "ASSIGNMENT_REMOVAL_REVIEW_CHANGED",
              message:
                "The assignment removal review changed. Refresh the review before confirming.",
            },
          },
          409,
        );
      if (!beforeMode && !modernPreview().ready)
        return reply(
          {
            error: {
              code: "CONFLICT",
              message: "Synthetic removal effects are blocked.",
            },
          },
          409,
        );
      if (current.commitMode === "hold")
        await new Promise((yes) => current.holds.push(yes));
      if (current.commitMode === "uncommitted") return route.abort("failed");
      if (current.commitMode === "forbidden")
        return reply(
          {
            error: {
              code: "FORBIDDEN",
              message: "Synthetic permission rejected",
            },
          },
          403,
        );
      current.effects = current.members.map((n) => ({
        device_id: id(n),
        next_assignment_id: current.fallback?.id || null,
        next_version_id: current.fallback?.version_id || null,
        mode: current.fallback ? "managed" : "unmanaged_keep_local",
      }));
      current.status = "unassigned";
      const answer = {
        ...summary(),
        selector: { device_ids: [], group_ids: [id(20)], exclude_ids: [] },
        targets: current.members.map((n) => ({
          device_id: id(n),
          state: "desired",
          generation: 1,
          error: null,
        })),
      };
      if (current.commitMode === "lost") return route.abort("failed");
      if (current.commitMode === "wrongSource") answer.id = id(99);
      if (current.commitMode === "malformed") return reply({ id: sourceId });
      return stagedReply(answer, current.commitMode);
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
    `${origin}/__reviewed-unassignment#/${editor ? `configurations/${id(10)}` : `deployments/${sourceId}?page=1`}`,
  );
  await page.waitForFunction(() => window.ready, undefined, { timeout: 30000 });
  await page.evaluate(() => window.mount());
  if (editor)
    await expect(
      page.getByRole("button", { name: "Code", exact: true }),
    ).toBeVisible();
  else await expect(details()).toBeVisible();
}
const details = () =>
  page.getByRole("region", { name: "Deployment details", exact: true });
const review = () =>
  page.getByRole("dialog", { name: "Remove assignment", exact: true });
const removed = () =>
  page.getByRole("dialog", { name: "Assignment removed", exact: true });
// The shell's one re-sign-in dialog. It covers the page, which stays mounted,
// so the page's own dialogs are inspected after a person dismisses it.
const sessionDialog = () =>
  page.getByRole("dialog", { name: "Your session ended", exact: true });
const signedOut = () =>
  page
    .getByRole("status")
    .filter({ hasText: "You're signed out. Your work is still here." });
async function openReview({ ready = true } = {}) {
  // Remove assignment lives in the header's Stop rollout / Roll back or
  // remove menu; alone, it is a plain button.
  const control = details()
    .getByRole("button", {
      name: /^(Stop rollout|Roll back or remove|Remove assignment)$/,
    })
    .first();
  await control.waitFor();
  const alone = (await control.innerText()).trim() === "Remove assignment";
  await control.click();
  if (!alone)
    await page
      .getByRole("menuitem", { name: "Remove assignment", exact: true })
      .click();
  await expect(review()).toBeVisible();
  if (ready)
    await expect(
      review().getByRole("table", { name: "Affected devices", exact: true }),
    ).toBeVisible();
}
async function check(name, run) {
  const focus = process.env.VECTORY_UNASSIGNMENT_FOCUS;
  if (focus && !name.toLowerCase().includes(focus.toLowerCase())) return;
  const began = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - began });
  console.log("PASS", name);
}
try {
  if (sessionBefore)
    await check(
      "Before changed account accepts the held old-session removal review",
      async () => {
        await load();
        state.previewMode = "hold";
        await openReview({ ready: false });
        await expect.poll(() => state.holds.length).toBe(1);
        state.actor = id(91);
        state.role = "viewer";
        await page.evaluate(() =>
          window.dispatchEvent(
            new StorageEvent("storage", {
              key: "vectory-session-change",
              newValue: "synthetic-different-account",
            }),
          ),
        );
        await expect(page.locator(".session-renewal")).toContainText(
          "Your session ended",
        );
        state.holds.shift()();
        await expect(
          review().getByRole("table", {
            name: "Affected devices",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          review().getByRole("button", {
            name: "Remove assignment",
            exact: true,
          }),
        ).toBeEnabled();
        observations.push({
          type: "expected_defect",
          oldActor: id(90),
          observedSessionActor: id(91),
          observedRole: "viewer",
          oldHeldReviewAccepted: true,
          confirmStillEnabled: true,
          commitNotAttempted: true,
          scope:
            "Synthetic held authorized response; no claim native authorization bypass",
        });
        await page.screenshot({
          path: resolve(output, "session-mismatch-before.png"),
        });
      },
    );
  else if (beforeMode)
    await check(
      "Before stale assignment removal review does not bind membership or fallback effects",
      async () => {
        for (const drift of ["membership", "fallback"]) {
          await load();
          if (drift === "fallback")
            state.fallback = { id: id(50), version_id: id(12) };
          await openReview();
          await expect(review()).toContainText("1 affected device");
          await expect(review()).toContainText("Synthetic alpha");
          await expect(review()).not.toContainText("Synthetic beta");
          const reviewed = structuredClone(state.previews[0]);
          if (drift === "membership") state.members = [1, 2];
          else state.fallback = { id: id(51), version_id: id(13) };
          await page.screenshot({
            path: resolve(output, `before-${drift}-review.png`),
          });
          await review()
            .getByRole("button", { name: "Remove assignment", exact: true })
            .click();
          await expect.poll(() => state.commits.length).toBe(1);
          await expect(review()).toHaveCount(0);
          expect(state.commits[0]).toEqual({});
          if (drift === "membership")
            expect(state.effects.map((x) => x.device_id)).toEqual([
              id(1),
              id(2),
            ]);
          else expect(state.effects[0].next_assignment_id).toBe(id(51));
          observations.push({
            drift,
            reviewed_device_ids: reviewed.devices.map((d) => d.id),
            reviewed_fallback: reviewed.devices[0].assignment?.id || null,
            commit_body: state.commits[0],
            modeled_current_effects: state.effects,
            ui_review_closed: true,
            authority_scope:
              "Synthetic transport follows source-observed current unguarded semantics. Separate backend native proof is required to establish real server effects.",
          });
        }
      },
    );
  else {
    const confirm = () =>
      review().getByRole("button", { name: "Remove assignment", exact: true });
    const refresh = () =>
      review().getByRole("button", { name: "Refresh review", exact: true });
    const status = () =>
      review().getByRole("button", {
        name: "Check current status",
        exact: true,
      });
    const closeReview = async () => {
      await review()
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await expect(review()).toHaveCount(0);
      await expect(details()).toBeVisible();
    };
    await check(
      "Exact device effects and view filters preserve the complete reviewed commit",
      async () => {
        await load();
        state.members = [1, 2];
        state.fallback = { id: id(50), version_id: id(12) };
        await openReview();
        await expect(details()).toHaveCount(0);
        await expect(review()).toContainText("Synthetic fallback");
        await expect(review()).toContainText("Synthetic alpha");
        await expect(review()).toContainText("Synthetic beta");
        const token = state.previews[0].review_token;
        await review()
          .getByRole("button", { name: "Filter Device", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "Filter Device", exact: true })
          .fill("alpha");
        await page.keyboard.press("Escape");
        await expect(
          review().getByRole("table", {
            name: "Affected devices",
            exact: true,
          }),
        ).not.toContainText("Synthetic beta");
        await confirm().click();
        await expect.poll(() => state.commits.length).toBe(1);
        expect(state.commits[0]).toEqual({ review_token: token });
        expect(state.effects.map((x) => x.device_id)).toEqual([id(1), id(2)]);
        expect(state.previews).toHaveLength(1);
        observations.push({
          case: "filtered reviewed scope",
          commit: state.commits[0],
          affected: state.effects,
        });
      },
    );
    await check(
      "Membership and fallback drift require explicit refresh and a separate new confirmation",
      async () => {
        for (const drift of ["membership", "fallback"]) {
          await load();
          state.fallback = { id: id(50), version_id: id(12) };
          await openReview();
          const old = state.previews[0].review_token;
          if (drift === "membership") state.members = [1, 2];
          else state.fallback = { id: id(51), version_id: id(13) };
          await confirm().click();
          await expect(review()).toContainText("review changed");
          expect(state.previews).toHaveLength(1);
          expect(state.effects).toEqual([]);
          expect(state.status).toBe("active");
          await expect(confirm()).toBeDisabled();
          await refresh().click();
          await expect.poll(() => state.previews.length).toBe(2);
          await expect(confirm()).toBeEnabled();
          expect(state.commits).toHaveLength(1);
          expect(state.previews[1].review_token).not.toBe(old);
          if (drift === "membership")
            await expect(review()).toContainText("Synthetic beta");
          await confirm().click();
          await expect.poll(() => state.commits.length).toBe(2);
          expect(state.commits[1]).toEqual({
            review_token: state.previews[1].review_token,
          });
          expect(state.status).toBe("unassigned");
        }
      },
    );
    await check(
      "Legacy malformed wrong-source and blocked previews fail closed without an unreviewed POST",
      async () => {
        for (const fault of [
          "legacy",
          "source",
          "token",
          "state",
          "resource",
          "effect",
          "missing-state",
          "blocked",
        ]) {
          await load();
          if (fault === "blocked")
            state.blockers = [
              {
                code: "UNSAFE_COLLATERAL",
                reason:
                  "Synthetic unrelated devices would change; refresh after resolving assignments.",
              },
            ];
          else state.previewFault = fault;
          await openReview({ ready: false });
          await expect.poll(() => state.previews.length).toBe(1);
          await expect(confirm()).toBeDisabled();
          if (fault === "blocked")
            await expect(review()).toContainText("Removal is not ready");
          else await expect(review().getByRole("alert")).toBeVisible();
          expect(state.commits).toHaveLength(0);
          await closeReview();
        }
      },
    );
    await check(
      "Lost or invalid commit responses stay uncertain through close and exact current-status review",
      async () => {
        for (const mode of ["lost", "wrongSource", "malformed"]) {
          await load();
          await openReview();
          state.commitMode = mode;
          await confirm().click();
          await expect(status()).toBeEnabled();
          expect(state.commits).toHaveLength(1);
          await closeReview();
          await openReview({ ready: false });
          await expect(status()).toBeVisible();
          expect(state.previews).toHaveLength(1);
          state.summaryMode = "wrongSource";
          await status().click();
          await expect(status()).toBeEnabled();
          await expect(review()).not.toContainText(
            "Assignment is currently removed",
          );
          expect(state.commits).toHaveLength(1);
          state.summaryMode = "failed";
          await status().click();
          await expect(review()).toContainText("Synthetic status unavailable");
          state.summaryMode = "normal";
          await status().click();
          await expect(removed()).toContainText(
            "Assignment is currently removed",
          );
          expect(state.commits).toHaveLength(1);
          expect(state.previews).toHaveLength(1);
        }
      },
    );
    await check(
      "Uncommitted uncertainty requires a successful read then fresh review before another send",
      async () => {
        await load();
        await openReview();
        state.commitMode = "uncommitted";
        await confirm().click();
        await expect(status()).toBeEnabled();
        await closeReview();
        await details()
          .getByRole("navigation", { name: "Breadcrumb" })
          .getByRole("link", { name: /^(Deployments|Schedules)$/ })
          .click();
        await expect(details()).toHaveCount(0);
        await page.evaluate(
          (id) => (location.hash = `#/deployments/${id}?page=1`),
          sourceId,
        );
        await expect(details()).toBeVisible();
        await openReview({ ready: false });
        await expect(status()).toBeEnabled();
        expect(state.previews).toHaveLength(1);
        state.summaryMode = "hold";
        await status().click();
        await expect.poll(() => state.holds.length).toBe(1);
        await expect(confirm()).toHaveCount(0);
        expect(state.commits).toHaveLength(1);
        state.holds.shift()();
        await expect(refresh()).toBeVisible();
        expect(state.previews).toHaveLength(1);
        expect(state.commits).toHaveLength(1);
        state.summaryMode = "normal";
        state.commitMode = "normal";
        await refresh().click();
        await expect(confirm()).toBeEnabled();
        expect(state.commits).toHaveLength(1);
        expect(state.previews).toHaveLength(2);
        await confirm().click();
        await expect.poll(() => state.commits.length).toBe(2);
      },
    );
    await check(
      "Double activation and pending navigation do not duplicate or abandon a committing removal",
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
        await expect(review()).toBeVisible();
        state.holds.shift()();
        await expect.poll(() => state.status).toBe("unassigned");
        expect(state.commits).toHaveLength(1);
      },
    );
    await check(
      "Role and actor changes ignore stale review or commit completion",
      async () => {
        await load({ role: "viewer" });
        await expect(
          details().getByRole("button", {
            name: "Remove assignment",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(state.previews).toHaveLength(0);
        for (const stage of ["preview", "commit"]) {
          await load();
          if (stage === "preview") state.previewMode = "hold";
          await openReview({ ready: stage !== "preview" });
          if (stage === "commit") {
            state.commitMode = "hold";
            await confirm().click();
          }
          await expect.poll(() => state.holds.length).toBe(1);
          state.role = "viewer";
          await page.evaluate(() =>
            window.dispatchEvent(
              new StorageEvent("storage", {
                key: "vectory-session-change",
                newValue: "synthetic-changed-role",
              }),
            ),
          );
          await expect(review()).toContainText("You no longer have permission");
          await expect(confirm()).toHaveCount(0);
          state.holds.shift()();
          await expect(removed()).toHaveCount(0);
          await expect(
            page.getByRole("status").filter({ hasText: /Assignment removed/ }),
          ).toHaveCount(0);
          expect(state.commits).toHaveLength(stage === "commit" ? 1 : 0);
        }
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
        await expect(
          details().getByRole("button", {
            name: "Remove assignment",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(state.commits).toHaveLength(0);
        for (const stage of ["preview", "commit"]) {
          await load();
          if (stage === "preview") state.previewMode = "hold";
          await openReview({ ready: stage !== "preview" });
          if (stage === "commit") {
            state.commitMode = "hold";
            await confirm().click();
          }
          await expect.poll(() => state.holds.length).toBe(1);
          state.actor = id(91);
          state.role = "viewer";
          await page.evaluate(() =>
            window.dispatchEvent(
              new StorageEvent("storage", {
                key: "vectory-session-change",
                newValue: "synthetic-different-account",
              }),
            ),
          );
          await expect(page.locator(".session-renewal")).toContainText(
            "Your session ended",
          );
          state.holds.shift()();
          await sessionDialog()
            .getByRole("button", { name: "Close dialog", exact: true })
            .click();
          await expect(sessionDialog()).toHaveCount(0);
          await expect(review()).toContainText(
            /session.*ended|no longer have permission/i,
          );
          await expect(removed()).toHaveCount(0);
          if (stage === "preview") {
            await expect(
              review().getByRole("table", {
                name: "Affected devices",
                exact: true,
              }),
            ).toHaveCount(0);
            await expect(confirm()).toHaveCount(0);
          }
          await expect(confirm()).toHaveCount(0);
          await review()
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await details()
            .getByRole("navigation", { name: "Breadcrumb" })
            .getByRole("link", { name: /^(Deployments|Schedules)$/ })
            .click();
          const requestsBefore = requests.length;
          await page
            .getByRole("button", { name: "Refresh now", exact: true })
            .click();
          // The shell reports the ended session once; the page sends nothing.
          await expect(signedOut()).toBeVisible();
          await page.waitForTimeout(1000);
          expect(requests.length).toBe(requestsBefore);
          expect(state.commits).toHaveLength(stage === "commit" ? 1 : 0);
          observations.push({
            case: "changed-account late response",
            stage,
            lateSuccessRejected: true,
            newProtectedRequestSent: false,
          });
        }
        await load();
        state.previewMode = "heldBody";
        await openReview({ ready: false });
        await expect.poll(() => state.bodyHolds.length).toBe(1);
        const previewsBefore = state.previews.length;
        // End the session on the server too; otherwise the shell's check
        // finds it still valid and resumes, as it should.
        state.sessionEnded = true;
        await page.evaluate(() =>
          window.dispatchEvent(new Event("vectory:session-ended")),
        );
        await expect.poll(() => state.abortedBodies).toBeGreaterThan(0);
        await sessionDialog()
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        await expect(review()).toContainText(
          /session.*ended|no longer have permission/i,
        );
        await expect(confirm()).toHaveCount(0);
        expect(state.previews).toHaveLength(previewsBefore);
        expect(state.commits).toHaveLength(0);
        while (state.bodyHolds.length) state.bodyHolds.shift()();
      },
    );
    await check(
      "Session invalidation preserves an unsaved editor draft and explicit sign-in establishes fresh protected work",
      async () => {
        await load({ editor: true });
        await page.getByRole("button", { name: "Code", exact: true }).click();
        const code = page.getByRole("textbox", {
          name: "Vector configuration code",
          exact: true,
        });
        await expect(code).toBeVisible();
        await page.getByLabel("Format", { exact: true }).selectOption("json");
        const pending = '{\n  "sources": { "synthetic_pending":';
        await code.fill(pending);
        const original = await code.elementHandle();
        state.actor = id(91);
        await page.evaluate(() =>
          window.dispatchEvent(
            new StorageEvent("storage", {
              key: "vectory-session-change",
              newValue: "synthetic-editor-new-account",
            }),
          ),
        );
        await expect(page.locator(".session-renewal")).toContainText(
          "Your session ended",
        );
        // The same editor element, read directly: the session dialog covers it.
        expect(await original.evaluate((el) => el.isConnected)).toBe(true);
        expect(await original.innerText()).toBe(pending);
        let allowDiscard = false;
        const prompts = [];
        page.on("dialog", async (dialog) => {
          prompts.push(dialog.message());
          if (allowDiscard) await dialog.accept();
          else await dialog.dismiss();
        });
        const someoneElse = () =>
          sessionDialog().getByRole("button", {
            name: "Sign in as someone else",
            exact: true,
          });
        await someoneElse().click();
        expect(prompts.length).toBeGreaterThan(0);
        expect(await original.evaluate((el) => el.isConnected)).toBe(true);
        expect(await original.innerText()).toBe(pending);
        expect(requests.filter((x) => x.method === "PUT")).toEqual([]);
        allowDiscard = true;
        await someoneElse().click();
        await expect(
          page.getByRole("textbox", { name: "Email address", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("textbox", { name: "Email address", exact: true })
          .fill("fixture@example.test");
        await page
          .getByLabel("Password", { exact: true })
          .fill("synthetic-fixture-only");
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Code", exact: true }),
        ).toBeVisible();
        await expect(page.locator(".session-renewal")).toHaveCount(0);
        await page.evaluate(
          (id) => (location.hash = `#/deployments/${id}?page=1`),
          sourceId,
        );
        await expect(details()).toBeVisible();
        await openReview();
        await expect(confirm()).toBeEnabled();
        expect(state.commits).toHaveLength(0);
        observations.push({
          case: "explicit reauthentication",
          oldDraftPreservedUntilExplicitDiscard: true,
          newActor: state.actor,
          freshPreviewReceived: true,
          removalNotSent: true,
        });
      },
    );
    await check(
      "Preview commit and status body deadlines release controls without automatic resend",
      async () => {
        for (const phase of ["preview", "commit", "status"]) {
          await load();
          await page.clock.install();
          if (phase === "preview") state.previewMode = "heldBody";
          await openReview({ ready: phase !== "preview" });
          if (phase === "commit") {
            state.commitMode = "heldBody";
            await confirm().click();
          }
          if (phase === "status") {
            state.commitMode = "lost";
            await confirm().click();
            await expect(status()).toBeVisible();
            state.summaryMode = "heldBody";
            await status().click();
          }
          await expect.poll(() => state.bodyHolds.length).toBeGreaterThan(0);
          await page.clock.fastForward(30050);
          await page.clock.runFor(100);
          if (phase === "preview") await expect(refresh()).toBeEnabled();
          else await expect(status()).toBeEnabled();
          expect(state.commits).toHaveLength(phase === "preview" ? 0 : 1);
          state.previewMode = "normal";
          state.summaryMode = "normal";
          while (state.bodyHolds.length) state.bodyHolds.shift()();
        }
      },
    );
    await check(
      "Policy defaults pending winners non-targeted rows and empty scope have honest effects",
      async () => {
        await load();
        state.resource = "policy";
        await openReview();
        await expect(review()).toContainText(/default/i);
        await expect(review()).not.toContainText("become unmanaged");
        await closeReview();
        await load();
        state.rows = [
          {
            device_id: id(1),
            device_name: "Synthetic alpha",
            effect: "retained_pending",
            before: delivered(),
            after: delivered(),
            pending_assignment_id: id(80),
            pending_assignment_name: "Synthetic waiting winner",
          },
          ...["unchanged", "revoked", "missing", "not_targeted"].map(
            (effect, i) => ({
              device_id: id(3 + i),
              device_name: `Synthetic ${effect}`,
              effect,
              before: effect === "missing" ? null : delivered(),
              after: effect === "missing" ? null : delivered(),
              pending_assignment_id: null,
              pending_assignment_name: null,
            }),
          ),
        ];
        await openReview();
        await expect(review()).toContainText("Synthetic waiting winner");
        for (const text of [
          "Synthetic unchanged",
          "Synthetic revoked",
          "Synthetic missing",
          "Synthetic not_targeted",
        ])
          await expect(review()).toContainText(text);
        await closeReview();
        await load();
        state.members = [];
        await openReview({ ready: false });
        await expect(confirm()).toBeEnabled();
        await confirm().click();
        await expect.poll(() => state.commits.length).toBe(1);
        expect(state.effects).toEqual([]);
      },
    );
    await check(
      "Review effects retain usable header footer and keyboard navigation in light and dark narrow views",
      async () => {
        for (const width of [899, 375])
          for (const theme of ["light", "dark"]) {
            await load({ width, theme });
            state.members = [1, 2];
            state.fallback = { id: id(50), version_id: id(12) };
            await openReview();
            await expect(details()).toHaveCount(0);
            const a = await new AxeBuilder({ page })
              .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
              .analyze();
            expect(a.violations).toEqual([]);
            accessibility.push({ width, theme, violations: a.violations });
            const g = await review().evaluate((el) => {
              const r = el.getBoundingClientRect(),
                f = el.querySelector(".modal-footer").getBoundingClientRect();
              return {
                x: r.x,
                right: r.right,
                y: r.y,
                bottom: r.bottom,
                footerTop: f.top,
                footerBottom: f.bottom,
                width: innerWidth,
                height: innerHeight,
              };
            });
            expect(g.x).toBeGreaterThanOrEqual(0);
            expect(g.right).toBeLessThanOrEqual(g.width);
            expect(g.footerBottom).toBeLessThanOrEqual(g.height);
            const effect = await review()
              .locator(".assignment-removal-effect")
              .first()
              .boundingBox();
            expect(effect.x).toBeGreaterThanOrEqual(g.x);
            expect(effect.x + effect.width).toBeLessThanOrEqual(g.right);
            await page.screenshot({
              path: resolve(
                output,
                `reviewed-unassignment-${width}-${theme}.png`,
              ),
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
} catch (e) {
  failure = e;
  throw e;
} finally {
  const source_sha256 = Object.fromEntries(
    await Promise.all(
      sources.map(async (p) => [
        `dashboard/${p}`,
        sha(await readFile(resolve(dashboard, p))),
      ]),
    ),
  );
  if (process.env.VECTORY_UNASSIGNMENT_BEFORE === "1") {
    await mkdir(resolve(output, "source"), { recursive: true });
    for (const p of sources)
      await copyFile(
        resolve(dashboard, p),
        resolve(output, "source", p.replaceAll("/", "__")),
      );
  }
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Actual App isolated synthetic HTTP/browser storage only. Expected before behavior is a transport model, not native proof. No live credentials, fleet, server process, services, package or release changes.",
        passed: !failure,
        classification:
          beforeMode || sessionBefore
            ? "expected_defect_observation"
            : "focused_correctness_acceptance",
        correctness_acceptance: !beforeMode && !sessionBefore,
        results,
        observations,
        requests,
        unexpected,
        errors,
        accessibility,
        source_sha256,
        source_sha256_at_start: sourceAtStart,
        source_changes_during_run: Object.keys(sourceAtStart).filter(
          (p) => sourceAtStart[p] !== source_sha256[p],
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
  await server.close();
  console.log("Evidence: " + relative(root, resolve(output, "report.json")));
}
