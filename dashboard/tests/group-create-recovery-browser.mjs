// Actual App/Groups recovery; all HTTP uses explicitly synthetic isolated state.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_GROUP_CREATE_RECOVERY_OUTPUT ||
    ".local/group-create-recovery",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/GroupEditor.tsx",
  "dashboard/src/group-editor.css",
  "dashboard/src/groupRequests.ts",
  "dashboard/src/GroupRecovery.tsx",
  "dashboard/src/group-recovery.css",
  "dashboard/src/api.ts",
  "dashboard/src/Fleet.tsx",
  "dashboard/src/ui.tsx",
  "dashboard/tests/group-create-recovery-browser.mjs",
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
const virtual = "\0virtual:group-create-recovery";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "group-create-recovery",
      resolveId(id) {
        if (id === "virtual:group-create-recovery") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__group-create-recovery")
            return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic group-create recovery verification</title></head><body><div id="root"></div><script type="module">import "virtual:group-create-recovery";</script></body></html>',
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
const id = (n) => "11111111-2222-4333-8444-" + String(n).padStart(12, "0");
const createdAt = "2026-09-27T12:00:00Z";
const results = [],
  observations = [],
  scans = [],
  screenshots = [];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clone = (v) => structuredClone(v);
const group = (n = 10, revision = 1) => ({
  id: id(n),
  name: "Synthetic existing group",
  description: "Existing exact identity",
  device_ids: [id(1)],
  revision,
  created_at: createdAt,
});
const device = (n) => ({
  id: id(n),
  name: "Synthetic edge " + n,
  os: "windows",
  arch: "amd64",
  status: "verified",
  apply_state: "verified_applied",
  desired_generation: 1,
  reported_generation: 1,
  labels: {},
  last_seen: createdAt,
});
function state(options = {}) {
  return {
    actor: id(90),
    role: "operator",
    groups: [],
    devices: [device(1), device(2)],
    requests: [],
    errors: [],
    registry: new Map(),
    posts: [],
    puts: [],
    lookups: [],
    recent: [],
    createMode: "normal",
    lookupMode: "normal",
    capability: true,
    holds: [],
    ...options,
  };
}
function stripped(body) {
  const { request_id, ...result } = body;
  return result;
}
async function start(f = state(), options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width || 899, height: 950 },
    reducedMotion: "reduce",
    colorScheme: options.theme || "light",
  });
  await context.addInitScript(
    ({ theme, storageFailure, seed }) => {
      localStorage.setItem("vectory-theme", theme);
      localStorage.setItem("vectory-sidebar-collapsed", "true");
      for (const [key, value] of Object.entries(seed || {}))
        localStorage.setItem(key, value);
      const originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (
          this === localStorage &&
          window.fixture.failGroupStorage &&
          key.includes("group")
        )
          throw new DOMException(
            "Synthetic group storage is unavailable",
            "QuotaExceededError",
          );
        return originalSet.call(this, key, value);
      };
      window.fixture = {
        failGroupStorage: storageFailure,
        confirmResult: false,
        confirmations: [],
        accelerateDeadline: false,
      };
      window.confirm = (message) => {
        window.fixture.confirmations.push(message);
        return window.fixture.confirmResult;
      };
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) =>
        nativeSetTimeout(
          fn,
          window.fixture.accelerateDeadline && ms === 30000 ? 200 : ms,
          ...args,
        );
    },
    {
      theme: options.theme || "light",
      storageFailure: !!options.storageFailure,
      seed: options.seed,
    },
  );
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    if (url.origin !== origin) {
      f.errors.push("External request " + url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      body = method === "GET" ? null : request.postDataJSON(),
      actorId = f.actor;
    f.requests.push({
      actor: actorId,
      path,
      method,
      query: url.search,
      body: clone(body),
    });
    const reply = (json, status = 200) => route.fulfill({ json, status });
    const error = (code, message, status) =>
      reply({ error: { code, message } }, status);
    if (method === "GET" && path === "/status")
      return reply({ initialized: true, version: "synthetic" });
    if (method === "GET" && path === "/session")
      return reply({
        user: {
          id: f.actor,
          name: "Synthetic " + f.role,
          email: "fixture@example.test",
          role: f.role,
          enabled: true,
          revision: 1,
        },
        csrf_token: "synthetic",
      });
    if (method === "GET" && path === "/devices") return reply(f.devices);
    if (method === "GET" && path === "/groups") return reply(f.groups);
    if (method === "GET" && path === "/groups/requests") {
      const page = Number(url.searchParams.get("page") || 1),
        size = Number(url.searchParams.get("page_size") || 12);
      f.recent.push({ actor: actorId, page, size });
      if (!f.capability) return error("NOT_FOUND", "Update the server", 404);
      if (f.recentMode === "failed")
        return error(
          "UNAVAILABLE",
          "Synthetic recent requests unavailable",
          503,
        );
      if (f.recentMode === "hold")
        await new Promise((done) => f.holds.push(done));
      const items = [...f.registry.values()]
        .filter((r) => r.actor === actorId)
        .map((r) => ({
          request_id: r.body.request_id,
          group_id: r.groupId,
          group_name: f.groups.find((g) => g.id === r.groupId)?.name || null,
          created_at: createdAt,
        }));
      return reply({
        items: items.slice((page - 1) * size, page * size),
        total: items.length,
        page,
        page_size: size,
      });
    }
    if (method === "GET" && path.startsWith("/groups/requests/")) {
      const requestId = path.split("/").pop();
      f.lookups.push({ actor: actorId, requestId });
      if (f.sharedFault?.phase === "preflight" && f.lookups.length === 1) {
        await new Promise((done) => f.holds.push(done));
        const { code, status } = f.sharedFault;
        await error(
          code,
          "Synthetic original-tab rejection after peer commit",
          status,
        );
        f.sharedFault.returned = true;
        return;
      }
      if (!f.capability)
        return error(
          "NOT_FOUND",
          "This server does not support group request recovery.",
          404,
        );
      if (f.lookupMode === "failed")
        return error("UNAVAILABLE", "Synthetic lookup unavailable", 503);
      if (f.lookupMode === "hold")
        await new Promise((done) => f.holds.push(done));
      if (f.lookupMode === "malformed") return reply({ found: false });
      if (f.lookupMode === "wrong-request")
        return reply({ request_id: id(888), found: false });
      const found = f.registry.get(actorId + ":" + requestId);
      if (!found) return reply({ request_id: requestId, found: false });
      const saved = f.groups.find((g) => g.id === found.groupId);
      if (!saved)
        return error(
          "CONFLICT",
          "The original group is no longer available.",
          409,
        );
      return reply({
        request_id: requestId,
        found: true,
        group: { ...saved, request_id: requestId },
      });
    }
    if (method === "GET" && /^\/groups\/[0-9a-f-]+$/.test(path)) {
      const saved = f.groups.find((g) => g.id === path.split("/").pop());
      return saved ? reply(saved) : error("NOT_FOUND", "Group not found", 404);
    }
    if (method === "POST" && path === "/groups") {
      f.posts.push({
        actor: actorId,
        body: clone(body),
        stored_before_request: await request
          .frame()
          .evaluate(() =>
            Object.fromEntries(
              Object.entries(localStorage).filter(([k]) => k.includes("group")),
            ),
          ),
      });
      const mode = f.createMode;
      if (f.sharedFault?.phase === "post" && f.posts.length === 1) {
        await new Promise((done) => f.holds.push(done));
        const { code, status } = f.sharedFault;
        await error(
          code,
          "Synthetic pre-writer rejection after peer commit",
          status,
        );
        f.sharedFault.returned = true;
        return;
      }
      if (mode === "hold") await new Promise((done) => f.holds.push(done));
      if (mode === "invalid")
        return error("INVALID_INPUT", "Synthetic invalid group name", 400);
      if (mode === "conflict")
        return error(
          "IDEMPOTENCY_CONFLICT",
          "Request identity already used with different contents",
          409,
        );
      if (mode === "before-loss") return route.abort("failed");
      if (!uuid.test(body.request_id || "")) {
        f.errors.push("Create omitted request identity");
        return error("UNEXPECTED", "Missing request_id", 500);
      }
      const key = actorId + ":" + body.request_id;
      let recorded = f.registry.get(key);
      if (recorded && JSON.stringify(recorded.body) !== JSON.stringify(body))
        return error("IDEMPOTENCY_CONFLICT", "Immutable request changed", 409);
      if (!recorded) {
        const saved = {
          ...stripped(body),
          id: id(100 + f.registry.size),
          revision: 1,
          created_at: createdAt,
        };
        f.groups.push(saved);
        recorded = { actor: actorId, body: clone(body), groupId: saved.id };
        f.registry.set(key, recorded);
      }
      const saved = f.groups.find((g) => g.id === recorded.groupId);
      if (!saved)
        return error(
          "CONFLICT",
          "The original group is no longer available.",
          409,
        );
      if (mode === "lost") return route.abort("failed");
      if (mode === "server-failed")
        return error(
          "SYNTHETIC_SERVER",
          "Synthetic response could not be confirmed",
          503,
        );
      if (mode === "unreadable")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{",
        });
      if (mode === "wrong-request")
        return reply({ ...saved, request_id: id(888) });
      if (mode === "missing-request") return reply(saved);
      return reply({ ...saved, request_id: body.request_id });
    }
    if (method === "PUT" && /^\/groups\/[0-9a-f-]+$/.test(path)) {
      f.puts.push(clone(body));
      const saved = f.groups.find((g) => g.id === path.split("/").pop());
      if (!saved) return error("NOT_FOUND", "Group not found", 404);
      if (body.revision !== saved.revision)
        return error("STALE_REVISION", "This group changed", 409);
      Object.assign(saved, clone(body), { revision: saved.revision + 1 });
      return reply(saved);
    }
    f.errors.push("Unexpected " + method + " " + path);
    return error("UNEXPECTED", path, 500);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.setDefaultNavigationTimeout(30000);
  page.on("pageerror", (error) => f.errors.push(error.message));
  const open = async (p) => {
    await p.goto(origin + "/__group-create-recovery#/groups");
    await expect(
      p.getByRole("heading", { name: "Groups", exact: true }),
    ).toBeVisible();
  };
  await open(page);
  return {
    f,
    page,
    context,
    open,
    close: async () => {
      for (const done of f.holds.splice(0)) done();
      await context.close();
    },
  };
}
const createDialog = (page) =>
  page.getByRole("dialog", { name: "Create group", exact: true });
async function create(page, name = "Synthetic recovered group") {
  await page
    .getByRole("button", { name: "Create group", exact: true })
    .first()
    .click();
  const dialog = createDialog(page);
  await dialog
    .getByRole("textbox", { name: "Group name", exact: true })
    .fill(name);
  await dialog
    .getByRole("textbox", { name: "Description (optional)", exact: true })
    .fill("Synthetic immutable request contents");
  await dialog.getByRole("checkbox", { name: /Synthetic edge 1/ }).check();
  await dialog
    .getByRole("button", { name: "Create group", exact: true })
    .click();
}
async function closeUncertain(page) {
  await page
    .getByRole("button", { name: "Close and review request", exact: true })
    .click();
  await expect(createDialog(page)).toHaveCount(0);
}
const writes = (f) => f.requests.filter((r) => r.method !== "GET");
const groupStorage = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Object.entries(localStorage).filter(([key]) =>
        key.startsWith("vectory:group-"),
      ),
    ),
  );
const operationKey = (requestId, actorId = id(90)) =>
  `vectory:group-operation:${encodeURIComponent(actorId)}:${requestId}`;
const operation = (requestId = id(500), actorId = id(90)) => ({
  actor_id: actorId,
  id: requestId,
  recorded_at: createdAt,
  request: {
    request_id: requestId,
    name: "Synthetic frozen group",
    description: "Frozen before any request",
    device_ids: [id(1)],
  },
});
async function openReview(page) {
  await page
    .getByRole("button", { name: "Review group requests", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Saved group requests", exact: true }),
  ).toBeVisible();
  const unreadable = page.getByRole("button", {
    name: "Review unreadable reminder",
    exact: true,
  });
  if (await unreadable.count()) await unreadable.click();
  else await page.locator(".group-recovery-list > button").first().click();
  return page.getByRole("dialog");
}
async function confirmed(page) {
  await expect(
    page.getByRole("dialog", { name: "Group confirmed", exact: true }),
  ).toBeVisible();
}
async function ensureUncertain(page) {
  await expect(
    page.getByRole("region", { name: "Review group changes", exact: true }),
  ).toContainText("Save could not be confirmed");
  await expect(
    createDialog(page).getByRole("button", {
      name: "Create group",
      exact: true,
    }),
  ).toBeDisabled();
}
async function noResend(f, count = 1) {
  expect(f.posts).toHaveLength(count);
  expect(
    f.requests.filter((r) => !["GET", "POST", "PUT"].includes(r.method)),
  ).toEqual([]);
}
async function clean(f) {
  expect(f.errors).toEqual([]);
}
async function run(name, fn) {
  const focus = process.env.VECTORY_GROUP_CREATE_RECOVERY_FOCUS;
  if (focus && !name.includes(focus)) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration_ms: Date.now() - started });
    console.log("PASS " + name);
  } catch (error) {
    results.push({
      name,
      passed: false,
      duration_ms: Date.now() - started,
      error: error.stack,
    });
    throw error;
  }
}

let failure = null;
try {
  for (const sharedFault of [
    { phase: "preflight", code: "UNAVAILABLE", status: 503 },
    { phase: "preflight", code: "FORBIDDEN", status: 403 },
    { phase: "post", code: "INVALID_INPUT", status: 400 },
    { phase: "post", code: "FORBIDDEN", status: 403 },
  ])
    await run(
      `Shared request: ${sharedFault.phase} ${sharedFault.code} cannot erase a peer committed group`,
      async () => {
        const before = process.env.VECTORY_EXPECT_SHARED_CLEANUP_LOSS === "1";
        const mobile = sharedFault.code === "INVALID_INPUT";
        const s = await start(
          state({ sharedFault: { ...sharedFault }, createMode: "lost" }),
          { width: mobile ? 375 : 899, theme: mobile ? "dark" : "light" },
        );
        try {
          await create(s.page);
          await expect.poll(() => s.f.holds.length).toBe(1);
          const stored = await groupStorage(s.page),
            [key] = Object.keys(stored);
          const original = JSON.parse(stored[key]);
          const peer = await s.context.newPage();
          await s.open(peer);
          await openReview(peer);
          await expect(
            peer.getByRole("button", {
              name: "Retry same request",
              exact: true,
            }),
          ).toBeEnabled();
          await peer
            .getByRole("button", { name: "Retry same request", exact: true })
            .click();
          await expect(
            peer.getByRole("dialog").getByRole("alert"),
          ).toBeVisible();
          expect(s.f.groups).toHaveLength(1);
          expect(s.f.registry.size).toBe(1);
          expect(s.f.posts.at(-1).body).toEqual(original.request);
          s.f.holds.shift()();
          await expect.poll(() => s.f.sharedFault.returned).toBe(true);
          if (before) {
            await expect
              .poll(async () => (await groupStorage(peer))[key])
              .toBeUndefined();
            await peer.reload();
            await expect(
              peer.getByRole("heading", { name: "Groups", exact: true }),
            ).toBeVisible();
            await expect(
              peer.getByRole("button", {
                name: "Review group requests",
                exact: true,
              }),
            ).toHaveCount(0);
          } else {
            await ensureUncertain(s.page);
            await expect(createDialog(s.page)).toContainText(
              sharedFault.phase === "preflight"
                ? "Synthetic original-tab rejection after peer commit"
                : "Synthetic pre-writer rejection after peer commit",
            );
            await expect(createDialog(s.page)).not.toContainText(
              "No group was created",
            );
            expect((await groupStorage(peer))[key]).toBe(stored[key]);
            if (sharedFault.code === "UNAVAILABLE" || mobile) {
              const filename = `group-shared-reminder-${mobile ? "375-dark" : "899-light"}.png`;
              await s.page.screenshot({ path: resolve(output, filename) });
              screenshots.push(filename);
              const scan = await new AxeBuilder({ page: s.page })
                .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
                .analyze();
              scans.push({
                scenario: "Retained peer request and original error",
                width: mobile ? 375 : 899,
                theme: mobile ? "dark" : "light",
                violations: scan.violations.map((v) => ({
                  id: v.id,
                  impact: v.impact,
                })),
              });
              expect(scan.violations).toEqual([]);
            }
            await peer.reload();
            await openReview(peer);
            await confirmed(peer);
            await expect(peer.getByRole("dialog")).toContainText(
              original.request.name,
            );
          }
          expect(s.f.posts).toHaveLength(sharedFault.phase === "post" ? 2 : 1);
          expect(s.f.groups).toHaveLength(1);
          await clean(s.f);
          observations.push({
            scenario: "shared-reminder-cleanup",
            ...sharedFault,
            expected_defect_observation: before,
            request_id: original.id,
            group_id: s.f.groups[0].id,
            posts: s.f.posts.map((p) => p.body),
            reminder_erased_after_peer_commit: before,
            no_automatic_retry: true,
          });
        } finally {
          await s.close();
        }
      },
    );
  await run(
    "Normal keyed create proves capability and saves a durable immutable request before POST; existing edits keep CAS",
    async () => {
      const s = await start(state({ groups: [group()] }));
      try {
        await create(s.page);
        await expect(createDialog(s.page)).toHaveCount(0);
        expect(s.f.posts).toHaveLength(1);
        expect(s.f.lookups[0].requestId).toBe(s.f.posts[0].body.request_id);
        expect(
          Object.values(s.f.posts[0].stored_before_request).join("\n"),
        ).toContain(s.f.posts[0].body.request_id);
        expect(s.f.groups).toHaveLength(2);
        const saved = s.f.groups.find((g) => g.id !== id(10));
        await expect(
          s.page.getByRole("button", { name: new RegExp(saved.name) }).first(),
        ).toBeVisible();
        await s.page
          .getByRole("button", { name: /Synthetic existing group/ })
          .first()
          .click();
        await s.page
          .getByRole("textbox", { name: "Group name", exact: true })
          .fill("Synthetic CAS edit");
        await s.page
          .getByRole("button", { name: "Save changes", exact: true })
          .click();
        expect(s.f.puts).toHaveLength(1);
        expect(s.f.puts[0].revision).toBe(1);
        expect(s.f.groups.find((g) => g.id === id(10)).revision).toBe(2);
        expect(s.f.posts).toHaveLength(1);
        await clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Lost committed response survives close and reload, then exact lookup recovers one current group without another POST",
    async () => {
      const s = await start(state({ createMode: "lost" }));
      try {
        await create(s.page);
        await ensureUncertain(s.page);
        expect(s.f.groups).toHaveLength(1);
        const requestId = s.f.posts[0].body.request_id;
        expect(
          (await groupStorage(s.page))[operationKey(requestId)],
        ).toBeTruthy();
        await closeUncertain(s.page);
        await s.page.reload();
        await expect(
          s.page.getByRole("heading", { name: "Groups", exact: true }),
        ).toBeVisible();
        await expect(
          s.page
            .getByRole("button", { name: "Create group", exact: true })
            .first(),
        ).toBeDisabled();
        s.f.groups[0].name = "Synthetic group renamed after creation";
        s.f.groups[0].revision = 2;
        await openReview(s.page);
        await confirmed(s.page);
        await expect(s.page.getByRole("dialog")).toContainText(
          s.f.groups[0].name,
        );
        expect(s.f.lookups.at(-1).requestId).toBe(requestId);
        await noResend(s.f);
        await s.page
          .getByRole("button", { name: "Open group", exact: true })
          .click();
        await expect(
          s.page.getByRole("textbox", { name: "Group name", exact: true }),
        ).toHaveValue(s.f.groups[0].name);
        await expect(s.page.getByRole("dialog")).toHaveCount(1);
        await expect
          .poll(() =>
            s.page.evaluate(
              () => !!document.activeElement?.closest('[role="dialog"]'),
            ),
          )
          .toBe(true);
        observations.push({
          scenario: "Open group keyboard handoff",
          focus: await s.page.evaluate(() => ({
            tag: document.activeElement?.tagName,
            label: document.activeElement?.getAttribute("aria-label"),
            text: document.activeElement?.textContent,
          })),
        });
        await s.page.keyboard.press("Tab");
        await expect(
          s.page.getByRole("textbox", { name: "Group name", exact: true }),
        ).toBeFocused();
        expect(s.f.groups).toHaveLength(1);
        await clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Not-found is uncertainty; only explicit retry sends the same immutable request identity and contents",
    async () => {
      const s = await start(state({ createMode: "before-loss" }));
      try {
        await create(s.page);
        await ensureUncertain(s.page);
        const first = clone(s.f.posts[0].body);
        await closeUncertain(s.page);
        s.f.lookupMode = "wrong-request";
        await openReview(s.page);
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeDisabled();
        await noResend(s.f);
        s.f.lookupMode = "failed";
        await s.page
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeDisabled();
        s.f.lookupMode = "normal";
        await s.page
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeEnabled();
        expect(s.f.groups).toHaveLength(0);
        await noResend(s.f);
        const key = operationKey(first.request_id);
        const original = (await groupStorage(s.page))[key];
        const peer = await s.context.newPage();
        await s.open(peer);
        await peer.evaluate(
          ({ key, original }) => {
            const changed = JSON.parse(original);
            changed.request.name = "Synthetic changed payload in another tab";
            localStorage.setItem(key, JSON.stringify(changed));
          },
          { key, original },
        );
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeDisabled();
        await noResend(s.f);
        await peer.evaluate(
          ({ key, original }) => localStorage.setItem(key, original),
          { key, original },
        );
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeEnabled();
        s.f.createMode = "normal";
        await s.page
          .getByRole("button", { name: "Retry same request", exact: true })
          .click();
        await confirmed(s.page);
        expect(s.f.posts).toHaveLength(2);
        expect(s.f.posts[1].body).toEqual(first);
        expect(s.f.groups).toHaveLength(1);
        await s.page
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(s.page.locator("#main-content")).toBeFocused();
        await clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Unsupported or malformed capability and unavailable/corrupt storage never cause an unkeyed or unsafe create",
    async () => {
      for (const mode of ["legacy", "malformed", "wrong-request", "storage"]) {
        const s = await start(
          state({
            capability: mode !== "legacy",
            lookupMode: ["malformed", "wrong-request"].includes(mode)
              ? mode
              : "normal",
          }),
          { storageFailure: mode === "storage" },
        );
        try {
          await create(s.page);
          await expect(createDialog(s.page).getByRole("alert")).toBeVisible();
          expect(s.f.posts).toHaveLength(0);
          expect(s.f.groups).toHaveLength(0);
          await clean(s.f);
        } finally {
          await s.close();
        }
      }
      const corrupt = await start(state(), {
        seed: { [operationKey(id(501))]: "{not valid JSON" },
      });
      try {
        await expect(
          corrupt.page
            .getByRole("button", { name: "Create group", exact: true })
            .first(),
        ).toBeDisabled();
        await openReview(corrupt.page);
        await expect(
          corrupt.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(corrupt.f.posts).toHaveLength(0);
        expect(corrupt.f.groups).toHaveLength(0);
        await clean(corrupt.f);
      } finally {
        await corrupt.close();
      }
      const race = await start(state({ lookupMode: "hold" }));
      try {
        await create(race.page);
        await expect.poll(() => race.f.lookups.length).toBe(1);
        const peer = await race.context.newPage();
        await race.open(peer);
        await peer.evaluate(() => {
          for (const key of Object.keys(localStorage))
            if (key.startsWith("vectory:group-operation:"))
              localStorage.removeItem(key);
        });
        for (const done of race.f.holds.splice(0)) done();
        await expect(createDialog(race.page).getByRole("alert")).toContainText(
          "saved request changed in another tab",
        );
        expect(race.f.posts).toHaveLength(0);
        expect(race.f.groups).toHaveLength(0);
        await clean(race.f);
      } finally {
        await race.close();
      }
    },
  );
  await run(
    "Rejected create requires explicit review and dismissal before corrected new intent; known success stays confirmed despite cleanup failure",
    async () => {
      const invalid = await start(state({ createMode: "invalid" }));
      try {
        await create(invalid.page);
        await expect(
          createDialog(invalid.page).getByRole("alert"),
        ).toContainText("Synthetic invalid group name");
        const firstId = invalid.f.posts[0].body.request_id;
        await ensureUncertain(invalid.page);
        expect(
          (await groupStorage(invalid.page))[operationKey(firstId)],
        ).toBeTruthy();
        await closeUncertain(invalid.page);
        await openReview(invalid.page);
        await expect(
          invalid.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeEnabled();
        await invalid.page
          .getByRole("button", { name: "Dismiss reminder", exact: true })
          .click();
        await expect(invalid.page.getByRole("dialog")).toContainText(
          "does not cancel a request or delete a group",
        );
        await invalid.page
          .getByRole("button", { name: "Dismiss reminder", exact: true })
          .click();
        await expect(invalid.page.getByRole("dialog")).toHaveCount(0);
        invalid.f.createMode = "normal";
        await create(invalid.page, "Synthetic corrected group");
        await expect(createDialog(invalid.page)).toHaveCount(0);
        expect(invalid.f.posts).toHaveLength(2);
        expect(invalid.f.posts[1].body.request_id).not.toBe(firstId);
        expect(invalid.f.groups).toHaveLength(1);
        await clean(invalid.f);
      } finally {
        await invalid.close();
      }
      for (const createMode of [
        "server-failed",
        "unreadable",
        "wrong-request",
        "missing-request",
      ]) {
        const s = await start(state({ createMode }));
        try {
          await create(s.page);
          await ensureUncertain(s.page);
          await closeUncertain(s.page);
          await openReview(s.page);
          await confirmed(s.page);
          await noResend(s.f);
          expect(s.f.groups).toHaveLength(1);
          await clean(s.f);
        } finally {
          await s.close();
        }
      }
      const cleanup = await start();
      try {
        await cleanup.page.evaluate(() => {
          const originalRemove = Storage.prototype.removeItem;
          window.fixture.failGroupCleanup = true;
          Storage.prototype.removeItem = function (key) {
            if (
              this === localStorage &&
              window.fixture.failGroupCleanup &&
              key.startsWith("vectory:group-operation:")
            )
              throw new DOMException(
                "Synthetic cleanup denied",
                "SecurityError",
              );
            return originalRemove.call(this, key);
          };
        });
        await create(cleanup.page);
        const notice = cleanup.page.getByRole("region", {
          name: "Review group changes",
          exact: true,
        });
        await expect(
          notice.getByRole("heading", { name: "Group saved", exact: true }),
        ).toBeVisible();
        await expect(notice).toContainText(
          "This group was created successfully.",
        );
        await expect(notice).toContainText(
          "could not clear its request reminder",
        );
        await expect(notice).not.toContainText("Save could not be confirmed");
        await expect(notice).not.toContainText("may have created");
        expect(cleanup.f.groups).toHaveLength(1);
        const savedKey = operationKey(cleanup.f.posts[0].body.request_id);
        expect((await groupStorage(cleanup.page))[savedKey]).toBeTruthy();
        await closeUncertain(cleanup.page);
        await expect(
          cleanup.page.getByRole("button", {
            name: "Create group",
            exact: true,
          }),
        ).toBeDisabled();
        await openReview(cleanup.page);
        await confirmed(cleanup.page);
        await expect(cleanup.page.getByRole("dialog")).toContainText(
          "group is confirmed, but this browser could not clear its reminder",
        );
        expect((await groupStorage(cleanup.page))[savedKey]).toBeTruthy();
        await cleanup.page.evaluate(() => {
          window.fixture.failGroupCleanup = false;
        });
        await cleanup.page.keyboard.press("Escape");
        await openReview(cleanup.page);
        await confirmed(cleanup.page);
        expect((await groupStorage(cleanup.page))[savedKey]).toBeUndefined();
        await noResend(cleanup.f);
        await clean(cleanup.f);
      } finally {
        await cleanup.close();
      }
    },
  );
  await run(
    "Current actor and role boundaries hide foreign pending intent and do not erase it",
    async () => {
      const s = await start(state({ createMode: "lost" }));
      try {
        await create(s.page);
        await ensureUncertain(s.page);
        await closeUncertain(s.page);
        const savedKey = operationKey(s.f.posts[0].body.request_id);
        s.f.actor = id(91);
        await s.page.reload();
        await expect(
          s.page.getByRole("heading", { name: "Groups", exact: true }),
        ).toBeVisible();
        await expect(
          s.page.getByRole("button", {
            name: "Review group requests",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(s.f.lookups.filter((x) => x.actor === id(91))).toEqual([]);
        expect((await groupStorage(s.page))[savedKey]).toBeTruthy();
        s.f.actor = id(90);
        s.f.role = "viewer";
        await s.page.reload();
        await expect(
          s.page.getByRole("heading", { name: "Groups", exact: true }),
        ).toBeVisible();
        await expect(
          s.page.getByRole("button", { name: "Create group", exact: true }),
        ).toHaveCount(0);
        await expect(
          s.page.getByRole("button", {
            name: "Review group requests",
            exact: true,
          }),
        ).toHaveCount(0);
        expect((await groupStorage(s.page))[savedKey]).toBeTruthy();
        s.f.role = "operator";
        await s.page.reload();
        await openReview(s.page);
        await confirmed(s.page);
        await noResend(s.f);
        await clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Held create guards duplicate input/navigation and timeout preserves the operation until read-only reconciliation",
    async () => {
      const s = await start(state({ createMode: "hold" }));
      try {
        await s.page.evaluate(() => {
          window.fixture.accelerateDeadline = true;
        });
        await create(s.page);
        await expect.poll(() => s.f.posts.length).toBe(1);
        await s.page.keyboard.press("Escape");
        await expect(createDialog(s.page)).toBeVisible();
        const blocked = await s.page.evaluate(() => {
          const e = new Event("vectory:before-navigate", { cancelable: true });
          window.dispatchEvent(e);
          return e.defaultPrevented;
        });
        expect(blocked).toBe(true);
        await ensureUncertain(s.page);
        await closeUncertain(s.page);
        s.f.createMode = "normal";
        for (const done of s.f.holds.splice(0)) done();
        await expect.poll(() => s.f.groups.length).toBe(1);
        await openReview(s.page);
        await confirmed(s.page);
        await noResend(s.f);
        await clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Recent actor-scoped metadata finds exact results after local reminder loss and deleted results never resurrect",
    async () => {
      const s = await start(state({ createMode: "lost" }));
      try {
        await create(s.page);
        await ensureUncertain(s.page);
        await closeUncertain(s.page);
        const requestId = s.f.posts[0].body.request_id;
        await s.page.evaluate(() => {
          for (const key of Object.keys(localStorage))
            if (key.startsWith("vectory:group-operation:"))
              localStorage.removeItem(key);
        });
        await s.page.reload();
        await s.page
          .getByRole("button", {
            name: "Your recent group requests",
            exact: true,
          })
          .click();
        await s.page
          .getByRole("button", { name: "View request", exact: true })
          .click();
        await confirmed(s.page);
        expect(s.f.lookups.at(-1).requestId).toBe(requestId);
        await noResend(s.f);
        await s.page
          .getByRole("button", { name: "Close", exact: true })
          .click();
        s.f.groups = [];
        await s.page
          .getByRole("button", {
            name: "Your recent group requests",
            exact: true,
          })
          .click();
        await s.page
          .getByRole("button", { name: "View request", exact: true })
          .click();
        await expect(
          s.page.getByRole("dialog").getByRole("alert"),
        ).toContainText("no longer available");
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toHaveCount(0);
        await noResend(s.f);
        expect(s.f.groups).toHaveLength(0);
        await clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Recovery intent and confirmed result use one keyboard-usable contained dialog in both themes and mobile widths",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          const saved = operation();
          saved.request.name = "Synthetic group recovery visual fixture";
          saved.request.description =
            width === 375
              ? "Synthetic original description. ".repeat(80).slice(0, 2000)
              : "Original details remain saved while the server result is uncertain.";
          saved.request.device_ids = Array.from({ length: 28 }, (_, i) =>
            id(i + 1),
          );
          const s = await start(state({ createMode: "before-loss" }), {
            width,
            theme,
            seed: { [operationKey(saved.id)]: JSON.stringify(saved) },
          });
          try {
            await openReview(s.page);
            await expect(
              s.page.getByRole("button", {
                name: "Retry same request",
                exact: true,
              }),
            ).toBeEnabled();
            await expect(s.page.getByRole("dialog")).toHaveCount(1);
            const box = await s.page.getByRole("dialog").boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(-1);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
            expect(
              await s.page.evaluate(() => document.documentElement.scrollWidth),
            ).toBeLessThanOrEqual(width);
            await expect(
              s.page.getByRole("button", {
                name: "Retry same request",
                exact: true,
              }),
            ).toBeInViewport();
            const result = await new AxeBuilder({ page: s.page }).analyze();
            scans.push({
              width,
              theme,
              violations: result.violations.map((v) => ({
                id: v.id,
                impact: v.impact,
                nodes: v.nodes.map((n) => n.target),
              })),
            });
            expect(result.violations).toEqual([]);
            const filename = `group-create-recovery-${width}-${theme}.png`;
            await s.page.screenshot({ path: resolve(output, filename) });
            screenshots.push(filename);
            await s.page
              .getByText("Original devices (28)", { exact: true })
              .click();
            await expect(
              s.page.locator(".group-recovery-members li"),
            ).toHaveCount(12);
            await s.page
              .getByRole("button", { name: "Next", exact: true })
              .click();
            await expect(
              s.page.locator(".group-recovery-members li").first(),
            ).toHaveText(id(13));
            await expect(
              s.page.getByRole("button", { name: "Close dialog", exact: true }),
            ).toBeInViewport();
            await expect(
              s.page.getByRole("button", {
                name: "Retry same request",
                exact: true,
              }),
            ).toBeInViewport();
            await s.page.keyboard.press("Escape");
            await expect(s.page.getByRole("dialog")).toHaveCount(0);
            await expect(
              s.page.getByRole("button", {
                name: "Review group requests",
                exact: true,
              }),
            ).toBeFocused();
            await noResend(s.f, 0);
            await clean(s.f);
          } finally {
            await s.close();
          }
        }
    },
  );
} catch (error) {
  failure = error.stack;
  console.error(error);
} finally {
  await browser.close();
  await server.close();
  const current = await hashes();
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        passed: !failure,
        scope:
          "Actual App group-create recovery and CAS checks with intercepted synthetic API. No native authorization, persistence, fleet changes or activation claimed.",
        results,
        accessibility: scans,
        observations,
        screenshots,
        error: failure,
        loaded_source_sha256: loaded,
        current_source_sha256: current,
        source_changed_during_run: Object.keys(current).filter(
          (p) => current[p] !== loaded[p],
        ),
      },
      null,
      2,
    ) + "\n",
  );
  if (failure) process.exitCode = 1;
}
