// Actual App, private Vite/browser, entirely intercepted and explicitly synthetic HTTP.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { updatesOff } from "./agent-update-replies.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_AGENT_SETTINGS_RECOVERY_OUTPUT ||
    ".local/agent-settings-recovery",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/Control.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/src/AgentSettingsCreation.tsx",
  "dashboard/src/agentSettingsRequests.ts",
  "dashboard/src/agent-settings-creation.css",
  "dashboard/tests/agent-settings-recovery-browser.mjs",
];
const hash = (b) => createHash("sha256").update(b).digest("hex");
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (p) => [p, hash(await readFile(resolve(root, p)))]),
    ),
  );
const sourceStart = await hashes();
const reservation = net.createServer();
await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const streams = new Map();
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "agent-settings-held-body",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const stream = streams.get(req.url);
          if (!stream) return next();
          streams.delete(req.url);
          res.writeHead(200, { "Content-Type": "application/json" });
          const json = JSON.stringify(stream.value);
          res.write(json.slice(0, 5));
          stream.f.bodyHolds.push(() => res.end(json.slice(5)));
          res.on("close", () => {
            if (!res.writableEnded) stream.f.abortedBodies++;
          });
        });
      },
    },
  ],
});
await vite.listen();
const origin = `http://127.0.0.1:${port}`,
  browser = await chromium.launch();
const id = (n) => `33333333-4444-4555-8666-${String(n).padStart(12, "0")}`,
  at = "2026-09-27T12:00:00Z";
const settings = {
  heartbeat_seconds: 180,
  sync_paused: true,
  telemetry_enabled: false,
};
const clone = (v) => structuredClone(v),
  strip = (body) => {
    const { request_id, ...rest } = body;
    return rest;
  };
const key = (requestId, actor = id(90)) =>
  `vectory:agent-settings-operation:${encodeURIComponent(actor)}:${requestId}`;
const operation = (requestId = id(500), actor = id(90)) => ({
  actor_id: actor,
  id: requestId,
  recorded_at: at,
  request: {
    request_id: requestId,
    name: "Synthetic frozen settings",
    policy: clone(settings),
  },
});
const results = [],
  scans = [],
  screenshots = [],
  contexts = [];
let failure;
function fixture(extra = {}) {
  return {
    actor: id(90),
    role: "operator",
    records: [],
    registry: new Map(),
    posts: [],
    lookups: [],
    recent: [],
    requests: [],
    unexpected: [],
    errors: [],
    holds: [],
    bodyHolds: [],
    abortedBodies: 0,
    createMode: "normal",
    lookupMode: "normal",
    recentMode: "normal",
    capability: true,
    ...extra,
  };
}
function commit(f, actor, body) {
  const registryKey = `${actor}:${body.request_id}`,
    previous = f.registry.get(registryKey);
  if (previous) {
    expect(previous.request).toEqual(body);
    return clone(previous.record);
  }
  const record = {
    id: id(100 + f.records.length),
    name: body.name,
    policy: clone(body.policy),
    created_at: at,
    request_id: body.request_id,
    create_idempotency: true,
  };
  f.records.push(record);
  f.registry.set(registryKey, { actor, request: clone(body), record });
  return clone(record);
}
async function start(f = fixture(), options = {}) {
  evidence.push(f);
  const context = await browser.newContext({
    viewport: { width: options.width || 899, height: 920 },
    reducedMotion: "reduce",
  });
  contexts.push(context);
  await context.addInitScript(
    ({ theme, seed, failSet, failRead }) => {
      localStorage.setItem("vectory-theme", theme);
      localStorage.setItem("vectory-sidebar-collapsed", "true");
      for (const [k, v] of Object.entries(seed || {}))
        localStorage.setItem(k, v);
      window.fixture = {
        failSet,
        failRead,
        failRemove: false,
        fastDeadline: false,
      };
      const set = Storage.prototype.setItem,
        get = Storage.prototype.getItem,
        remove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (k, v) {
        if (
          this === localStorage &&
          k.startsWith("vectory:agent-settings-operation:") &&
          window.fixture.failSet
        )
          throw new DOMException(
            "Synthetic storage full",
            "QuotaExceededError",
          );
        return set.call(this, k, v);
      };
      Storage.prototype.getItem = function (k) {
        if (
          this === localStorage &&
          k.startsWith("vectory:agent-settings-operation:") &&
          window.fixture.failRead
        )
          throw new DOMException(
            "Synthetic storage unavailable",
            "SecurityError",
          );
        return get.call(this, k);
      };
      Storage.prototype.removeItem = function (k) {
        if (
          this === localStorage &&
          k.startsWith("vectory:agent-settings-operation:") &&
          window.fixture.failRemove
        )
          throw new DOMException(
            "Synthetic cleanup unavailable",
            "SecurityError",
          );
        return remove.call(this, k);
      };
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) =>
        timeout(
          fn,
          window.fixture.fastDeadline && ms === 30000 ? 200 : ms,
          ...args,
        );
    },
    {
      theme: options.theme || "light",
      seed: options.seed,
      failSet: !!options.failSet,
      failRead: !!options.failRead,
    },
  );
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    if (url.origin !== origin) {
      f.unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      body = method === "GET" ? undefined : req.postDataJSON(),
      actor = f.actor;
    f.requests.push({
      method,
      path,
      query: url.search,
      actor,
      ...(body ? { body: clone(body) } : {}),
    });
    const reply = (value, status = 200) =>
        route.fulfill({ status, json: value }),
      error = (code, message, status) =>
        reply({ error: { code, message } }, status);
    const respond = async (value, mode) => {
      if (mode === "hold") await new Promise((r) => f.holds.push(r));
      if (mode === "body") {
        streams.set(url.pathname + url.search, { value, f });
        return route.continue();
      }
      if (mode === "failure")
        return error("UNAVAILABLE", "Synthetic status unavailable", 503);
      return reply(value);
    };
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: f.actor,
            name: "Synthetic operator",
            email: "fixture@example.test",
            role: f.role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/mfa") return reply({ enabled: false });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic saved settings recovery" });
      // Agent updates are off here, so the page is what it was without them.
      if (path === "/agent-updates") return reply(updatesOff());
      // The page looks for settings applied without saving in the history.
      if (path === "/deployments/history")
        return reply({ items: [], total: 0, page: 1, page_size: 50 });
      if (path === "/policies")
        return reply(
          f.records.map(
            ({ request_id, create_idempotency, ...record }) => record,
          ),
        );
      if (path === "/policies/requests") {
        const page = Number(url.searchParams.get("page")),
          size = Number(url.searchParams.get("page_size"));
        expect(page).toBeGreaterThanOrEqual(1);
        expect(size).toBe(12);
        f.recent.push({ page, size });
        const rows = [...f.registry.values()]
          .filter((r) => r.actor === actor)
          .map((r) => ({
            request_id: r.request.request_id,
            policy_id: r.record.id,
            policy_name: r.record.name,
            created_at: at,
          }));
        let value = {
          create_idempotency: true,
          items: rows.slice((page - 1) * size, page * size),
          total: rows.length,
          page,
          page_size: size,
        };
        if (f.recentMode === "malformed")
          value.items[0] = { ...value.items[0], policy_id: "bad" };
        return respond(value, f.recentMode);
      }
      const match = path.match(/^\/policies\/requests\/([^/]+)$/);
      if (match) {
        const requestId = match[1];
        f.lookups.push(requestId);
        if (f.sharedFault && !f.sharedFault.started) {
          f.sharedFault.started = true;
          await new Promise((r) => f.holds.push(r));
          f.sharedFault.returned = true;
          return error(
            f.sharedFault.code,
            "Synthetic original-tab rejection after peer commit",
            f.sharedFault.status,
          );
        }
        if (f.capability === false)
          return error("NOT_FOUND", "Synthetic old server", 404);
        const entry = f.registry.get(`${actor}:${requestId}`);
        let value = {
          create_idempotency: true,
          request_id: requestId,
          found: !!entry,
          ...(entry ? { policy: clone(entry.record) } : {}),
        };
        if (f.lookupMode === "wrongKey") value.request_id = id(999);
        if (f.lookupMode === "innerKey" && entry)
          value.policy.request_id = id(999);
        if (f.lookupMode === "wrongResult" && entry) value.policy.id = id(999);
        if (f.lookupMode === "missingMarker") delete value.create_idempotency;
        if (f.lookupMode === "malformed" && entry)
          value.policy.policy.heartbeat_seconds = 0;
        return respond(value, f.lookupMode);
      }
    }
    if (method === "POST" && path === "/policies") {
      expect(req.headers()["x-csrf-token"]).toBe("synthetic");
      expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
      f.posts.push(clone(body));
      if (f.createMode === "hold") await new Promise((r) => f.holds.push(r));
      if (f.createMode === "uncommitted") return route.abort("failed");
      if (f.createMode === "invalid")
        return error(
          "INVALID_INPUT",
          "Synthetic pre-writer input rejection",
          400,
        );
      if (f.createMode === "forbidden")
        return error("FORBIDDEN", "Synthetic authorization rejected", 403);
      let value = commit(f, actor, body);
      if (f.createMode === "lost") return route.abort("failed");
      if (f.createMode === "wrongPolicy") value.policy.heartbeat_seconds = 300;
      if (f.createMode === "wrongName")
        value.name = "Synthetic different request";
      if (f.createMode === "wrongKey") value.request_id = id(999);
      if (f.createMode === "missingMarker") delete value.create_idempotency;
      if (f.createMode === "malformed") delete value.policy;
      return respond(value, f.createMode === "hold" ? "normal" : f.createMode);
    }
    f.unexpected.push(`${method} ${path}`);
    return error("UNEXPECTED_REQUEST", "Synthetic route not modeled", 500);
  });
  const open = async (page) => {
    page.setDefaultTimeout(8000);
    page.on("pageerror", (e) => f.errors.push(e.message));
    await page.goto(`${origin}/#/policies`);
    await expect(
      page.getByRole("heading", { name: "Agent settings", exact: true }),
    ).toBeVisible();
  };
  const page = await context.newPage();
  await open(page);
  return { context, page, f, open };
}
const createDialog = (page) =>
  page.getByRole("dialog", { name: "New agent settings", exact: true });
const reviewDialog = (page) =>
  page.getByRole("dialog", { name: "Review settings request", exact: true });
const savedDialog = (page) =>
  page.getByRole("dialog", { name: "Agent settings saved", exact: true });
const save = (page) =>
  createDialog(page).getByRole("button", {
    name: "Save settings",
    exact: true,
  });
const retry = (page) =>
  page.getByRole("button", { name: "Retry same request", exact: true });
const checkStatus = (page) =>
  page.getByRole("button", { name: "Check status", exact: true });
async function fill(page, name = "Synthetic reviewed settings") {
  await page
    .getByRole("button", { name: /^(New settings|Create settings)$/ })
    .first()
    .click();
  const d = createDialog(page);
  await d
    .getByRole("textbox", { name: "Settings name", exact: true })
    .fill(name);
  await d
    .getByRole("spinbutton", {
      name: "Check-in interval (seconds)",
      exact: true,
    })
    .fill("180");
  await d.getByRole("switch", { name: /Pause configuration sync/ }).check();
  await d
    .getByRole("switch", { name: /Collect operational metrics/ })
    .uncheck();
}
async function send(page, name) {
  await fill(page, name);
  await save(page).click();
}
const storage = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Object.entries(localStorage).filter(([k]) =>
        k.startsWith("vectory:agent-settings-operation:"),
      ),
    ),
  );
async function closeUncertain(page) {
  await reviewDialog(page)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function openReview(page) {
  await page
    .getByRole("button", { name: "Review settings requests", exact: true })
    .click();
  const d = page.getByRole("dialog", {
    name: "Saved settings requests",
    exact: true,
  });
  await expect(d).toBeVisible();
  const corrupt = d.getByRole("button", { name: /Review unreadable reminder/ });
  if (await corrupt.count()) await corrupt.first().click();
  else
    await d
      .getByRole("button")
      .filter({ hasText: /Synthetic/ })
      .first()
      .click();
}
async function closeDialog(page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function clean(s) {
  expect(s.f.unexpected).toEqual([]);
  expect(s.f.errors).toEqual([]);
  expect(
    s.f.requests.filter((r) => r.method !== "GET" && r.path !== "/policies"),
  ).toEqual([]);
  await s.context.close();
}
async function run(name, fn) {
  const focus = process.env.VECTORY_AGENT_SETTINGS_RECOVERY_FOCUS;
  if (focus && !name.toLowerCase().includes(focus.toLowerCase())) return;
  const t = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, milliseconds: Date.now() - t });
    console.log("PASS", name);
  } catch (e) {
    results.push({ name, passed: false, error: e.stack });
    throw e;
  }
}
const evidence = [];
try {
  await run(
    "Normal save and lost committed reply reload confirm the exact settings without applying to devices",
    async () => {
      for (const mode of ["normal", "lost"]) {
        const s = await start(fixture({ createMode: mode }));
        await send(s.page);
        await expect.poll(() => s.f.posts.length).toBe(1);
        expect(s.f.posts[0].policy).toEqual(settings);
        if (mode === "lost") {
          await expect(reviewDialog(s.page).getByRole("alert")).toBeVisible();
          expect(Object.keys(await storage(s.page))).toHaveLength(1);
          await s.page.reload();
          await openReview(s.page);
        }
        await expect(savedDialog(s.page)).toBeVisible();
        expect(s.f.records).toHaveLength(1);
        expect(await storage(s.page)).toEqual({});
        expect(s.f.posts).toHaveLength(1);
        await expect(savedDialog(s.page)).toContainText("180");
        await clean(s);
      }
    },
  );
  await run(
    "Found false permits only deliberate same-key frozen retry while lookup failures never resend",
    async () => {
      const s = await start(fixture({ createMode: "uncommitted" }));
      await send(s.page);
      await expect(reviewDialog(s.page).getByRole("alert")).toBeVisible();
      const original = clone(s.f.posts[0]);
      await closeUncertain(s.page);
      s.f.lookupMode = "wrongKey";
      await openReview(s.page);
      await expect(reviewDialog(s.page).getByRole("alert")).toBeVisible();
      await expect(retry(s.page)).toBeDisabled();
      expect(s.f.posts).toHaveLength(1);
      s.f.lookupMode = "normal";
      await checkStatus(s.page).click();
      await expect(retry(s.page)).toBeEnabled();
      s.f.createMode = "normal";
      await retry(s.page).click();
      await expect(savedDialog(s.page)).toBeVisible();
      expect(s.f.posts).toEqual([original, original]);
      expect(s.f.records).toHaveLength(1);
      await clean(s);
    },
  );
  await run(
    "Old capability preflight auth and input errors retain intent and block fresh blind creation",
    async () => {
      for (const variant of [
        "old",
        "wrongKey",
        "missingMarker",
        "invalid",
        "forbidden",
      ]) {
        const f = fixture();
        if (variant === "old") f.capability = false;
        else if (["wrongKey", "missingMarker"].includes(variant))
          f.lookupMode = variant;
        else f.createMode = variant;
        const s = await start(f);
        await send(s.page);
        await expect(reviewDialog(s.page).getByRole("alert")).toBeVisible();
        expect(Object.keys(await storage(s.page))).toHaveLength(1);
        await expect(reviewDialog(s.page)).not.toContainText(
          "No settings were saved",
        );
        await expect(retry(s.page)).toBeDisabled();
        expect(f.posts).toHaveLength(
          ["invalid", "forbidden"].includes(variant) ? 1 : 0,
        );
        await closeUncertain(s.page);
        await s.page
          .getByRole("button", { name: "New settings", exact: true })
          .click();
        await expect(createDialog(s.page)).toHaveCount(0);
        await expect(
          s.page.getByRole("dialog", {
            name: "Saved settings requests",
            exact: true,
          }),
        ).toBeVisible();
        await clean(s);
      }
    },
  );
  await run(
    "An original tab preflight rejection cannot erase a peer committed shared request",
    async () => {
      for (const status of [503, 403]) {
        const f = fixture({
            sharedFault: {
              code: status === 503 ? "UNAVAILABLE" : "FORBIDDEN",
              status,
            },
            createMode: "lost",
          }),
          s = await start(f);
        await send(s.page);
        await expect.poll(() => f.holds.length).toBe(1);
        const before = await storage(s.page),
          [recordKey] = Object.keys(before),
          original = JSON.parse(before[recordKey]);
        const peer = await s.context.newPage();
        await s.open(peer);
        await openReview(peer);
        await expect(retry(peer)).toBeEnabled();
        await retry(peer).click();
        await expect(reviewDialog(peer).getByRole("alert")).toBeVisible();
        expect(f.records).toHaveLength(1);
        f.holds.shift()();
        await expect(reviewDialog(s.page)).toContainText(
          "Synthetic original-tab rejection",
        );
        expect((await storage(peer))[recordKey]).toBe(before[recordKey]);
        expect(f.posts).toEqual([original.request]);
        f.createMode = "normal";
        await checkStatus(peer).click();
        await expect(savedDialog(peer)).toBeVisible();
        await clean(s);
      }
    },
  );
  await run(
    "Malformed and wrong-key success receipts remain uncertain until exact lookup confirms",
    async () => {
      for (const mode of [
        "wrongKey",
        "missingMarker",
        "malformed",
        "wrongPolicy",
        "wrongName",
      ]) {
        const s = await start(fixture({ createMode: mode }));
        await send(s.page);
        await expect(reviewDialog(s.page).getByRole("alert")).toBeVisible();
        expect(Object.keys(await storage(s.page))).toHaveLength(1);
        await closeUncertain(s.page);
        s.f.lookupMode = "innerKey";
        await openReview(s.page);
        await expect(reviewDialog(s.page).getByRole("alert")).toBeVisible();
        await expect(retry(s.page)).toBeDisabled();
        expect(Object.keys(await storage(s.page))).toHaveLength(1);
        s.f.lookupMode = "normal";
        await checkStatus(s.page).click();
        await expect(savedDialog(s.page)).toBeVisible();
        expect(s.f.posts).toHaveLength(1);
        await clean(s);
      }
    },
  );
  await run(
    "Storage write read corrupt foreign and capacity states do not produce unsafe settings",
    async () => {
      const write = await start(fixture(), { failSet: true });
      await send(write.page);
      await expect(createDialog(write.page).getByRole("alert")).toBeVisible();
      expect(write.f.posts).toHaveLength(0);
      await clean(write);
      for (const variant of ["read", "corrupt", "capacity", "foreign"]) {
        const op = operation(),
          seed = {};
        if (variant === "corrupt") seed[key(op.id)] = "{ broken";
        if (variant === "read") seed[key(op.id)] = JSON.stringify(op);
        if (variant === "foreign")
          seed[key(op.id, id(91))] = JSON.stringify(operation(op.id, id(91)));
        if (variant === "capacity")
          for (let n = 0; n < 10; n++)
            seed[key(id(500 + n))] = JSON.stringify(operation(id(500 + n)));
        const s = await start(fixture(), {
          seed,
          failRead: variant === "read",
        });
        const newButton = s.page.getByRole("button", {
          name: "New settings",
          exact: true,
        });
        if (variant === "foreign") {
          await expect(newButton).toBeEnabled();
          await expect(
            s.page.getByRole("button", {
              name: "Review settings requests",
              exact: true,
            }),
          ).toHaveCount(0);
        } else {
          await newButton.click();
          await expect(createDialog(s.page)).toHaveCount(0);
          await expect(
            s.page.getByRole("dialog", {
              name: "Saved settings requests",
              exact: true,
            }),
          ).toBeVisible();
          await closeDialog(s.page);
        }
        if (variant === "corrupt") {
          await openReview(s.page);
          await expect(checkStatus(s.page)).toBeVisible();
          await expect(retry(s.page)).toHaveCount(0);
          expect(s.f.lookups).toEqual([op.id]);
        }
        expect(s.f.posts).toHaveLength(0);
        await clean(s);
      }
    },
  );
  await run(
    "Unreadable exact-byte dismissal preserves a repaired peer record and known receipt survives cleanup failure",
    async () => {
      const op = operation(),
        s = await start(fixture(), { seed: { [key(op.id)]: "{ bad" } });
      await openReview(s.page);
      await s.page
        .getByRole("button", { name: "Dismiss reminder", exact: true })
        .click();
      await s.page.evaluate(({ k, v }) => localStorage.setItem(k, v), {
        k: key(op.id),
        v: JSON.stringify(op),
      });
      await s.page
        .getByRole("button", { name: "Dismiss reminder", exact: true })
        .click();
      await expect(s.page.getByRole("dialog").getByRole("alert")).toBeVisible();
      expect((await storage(s.page))[key(op.id)]).toBe(JSON.stringify(op));
      expect(s.f.posts).toHaveLength(0);
      await clean(s);
      for (const mode of ["normal", "lost"]) {
        const a = await start(fixture({ createMode: mode }));
        await a.page.evaluate(() => (window.fixture.failRemove = true));
        await send(a.page);
        if (mode === "lost") {
          await expect(reviewDialog(a.page).getByRole("alert")).toBeVisible();
          await closeUncertain(a.page);
          await openReview(a.page);
        }
        await expect(savedDialog(a.page)).toBeVisible();
        await expect(savedDialog(a.page)).toContainText("saved");
        expect(Object.keys(await storage(a.page))).toHaveLength(1);
        expect(a.f.records).toHaveLength(1);
        await clean(a);
      }
    },
  );
  await run(
    "Recent metadata reads exact request results after local loss but cannot reconstruct retry",
    async () => {
      const f = fixture();
      for (let n = 0; n < 13; n++)
        commit(f, id(90), operation(id(700 + n)).request);
      commit(f, id(91), operation(id(800), id(91)).request);
      const s = await start(f);
      await s.page
        .getByRole("button", { name: "Your settings requests", exact: true })
        .click();
      await expect.poll(() => f.recent.length).toBe(1);
      await expect(s.page.getByRole("dialog")).not.toContainText(id(800));
      await s.page.getByRole("button", { name: "Next", exact: true }).click();
      await expect.poll(() => f.recent.at(-1).page).toBe(2);
      await s.page
        .getByRole("button", { name: "View request", exact: true })
        .first()
        .click();
      await expect(savedDialog(s.page)).toBeVisible();
      await expect(retry(s.page)).toHaveCount(0);
      expect(f.posts).toHaveLength(0);
      await clean(s);
    },
  );
  await run(
    "Headers and response-body deadlines unblock waiting without automatic send or retry",
    async () => {
      for (const phase of ["preflight", "post", "lookup", "recent"])
        for (const wait of ["hold", "body"]) {
          const f = fixture(),
            s = await start(f);
          await s.page.evaluate(() => (window.fixture.fastDeadline = true));
          if (phase === "preflight") f.lookupMode = wait;
          if (phase === "post") f.createMode = wait;
          if (phase === "recent") {
            f.recentMode = wait;
            await s.page
              .getByRole("button", {
                name: "Your settings requests",
                exact: true,
              })
              .click();
          } else {
            if (phase === "lookup") f.createMode = "lost";
            await send(s.page);
            if (phase === "lookup") {
              await expect(
                reviewDialog(s.page).getByRole("alert"),
              ).toBeVisible();
              await closeUncertain(s.page);
              f.lookupMode = wait;
              await openReview(s.page);
            }
          }
          await expect(s.page.getByRole("dialog")).toContainText(
            "taking too long",
          );
          if (phase !== "recent")
            expect(Object.keys(await storage(s.page))).toHaveLength(1);
          expect(f.posts).toHaveLength(
            phase === "preflight" || phase === "recent" ? 0 : 1,
          );
          if (wait === "body")
            await expect.poll(() => f.abortedBodies).toBeGreaterThan(0);
          else {
            await expect.poll(() => f.holds.length).toBe(1);
            f.holds.shift()();
            if (phase === "post")
              await expect.poll(() => f.records.length).toBe(1);
            await expect(savedDialog(s.page)).toHaveCount(0);
          }
          await clean(s);
        }
    },
  );
  await run(
    "Double-click busy guards and same-actor or account changes cannot accept stale save outcomes",
    async () => {
      const s = await start(fixture({ createMode: "hold" }));
      await fill(s.page);
      await save(s.page).dblclick();
      await expect.poll(() => s.f.holds.length).toBe(1);
      await s.page.keyboard.press("Escape");
      await expect(reviewDialog(s.page)).toBeVisible();
      await s.page.evaluate(() => (location.hash = "#/deployments"));
      await expect(s.page).toHaveURL(/#\/policies$/);
      await reviewDialog(s.page)
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await expect(reviewDialog(s.page)).toBeVisible();
      expect(s.f.posts).toHaveLength(1);
      s.f.holds.shift()();
      await expect(savedDialog(s.page)).toBeVisible();
      await clean(s);
      for (const different of [false, true])
        for (const wait of ["hold", "body"]) {
          const a = await start(fixture({ createMode: wait }));
          await send(a.page);
          await expect
            .poll(() =>
              wait === "body" ? a.f.bodyHolds.length : a.f.holds.length,
            )
            .toBe(1);
          if (different) a.f.actor = id(91);
          a.f.role = "viewer";
          await a.page.evaluate(() =>
            window.dispatchEvent(
              new StorageEvent("storage", {
                key: "vectory-session-change",
                newValue: "synthetic-changed-context",
              }),
            ),
          );
          if (different)
            await expect(a.page.locator(".session-renewal")).toBeVisible();
          await expect(
            a.page.getByRole("button", { name: "New settings", exact: true }),
          ).toHaveCount(0);
          await expect(reviewDialog(a.page)).toHaveCount(0);
          if (wait === "body") {
            await expect.poll(() => a.f.abortedBodies).toBeGreaterThan(0);
            a.f.bodyHolds.shift()();
          } else a.f.holds.shift()();
          await expect.poll(() => a.f.records.length).toBe(1);
          await expect(savedDialog(a.page)).toHaveCount(0);
          expect(Object.keys(await storage(a.page))).toHaveLength(1);
          await clean(a);
        }
    },
  );
  await run(
    "Mobile desktop light dark recovery preserves status-first layout keyboard focus and accessible controls",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          const s = await start(fixture({ createMode: "uncommitted" }), {
            width,
            theme,
          });
          await send(
            s.page,
            "Synthetic reviewed settings " + "extended name ".repeat(4),
          );
          await expect(reviewDialog(s.page).getByRole("alert")).toBeVisible();
          await closeUncertain(s.page);
          await openReview(s.page);
          await expect(retry(s.page)).toBeEnabled();
          const scan = await new AxeBuilder({ page: s.page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
          expect(scan.violations).toEqual([]);
          scans.push({ width, theme, violations: scan.violations });
          const geometry = await s.page.getByRole("dialog").evaluate((el) => {
            const d = el.getBoundingClientRect(),
              f = el.querySelector(".modal-footer").getBoundingClientRect();
            return {
              left: d.left,
              right: d.right,
              bottom: f.bottom,
              width: innerWidth,
              height: innerHeight,
            };
          });
          expect(geometry.left).toBeGreaterThanOrEqual(0);
          expect(geometry.right).toBeLessThanOrEqual(geometry.width);
          expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
          const filename = `agent-settings-recovery-${width}-${theme}.png`;
          await s.page.screenshot({ path: resolve(output, filename) });
          screenshots.push(filename);
          await s.page.keyboard.press("Escape");
          await expect(s.page.getByRole("dialog")).toHaveCount(0);
          await expect(
            s.page.getByRole("button", {
              name: "Review settings requests",
              exact: true,
            }),
          ).toBeFocused();
          expect(s.f.posts).toHaveLength(1);
          await clean(s);
        }
    },
  );
} catch (e) {
  failure = e;
  throw e;
} finally {
  for (const context of contexts) {
    try {
      await context.close();
    } catch {}
  }
  await browser.close();
  await vite.close();
  const sourceEnd = await hashes();
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        passed: !failure,
        scope:
          "Actual App synthetic transport only; no actual accounts, credentials, fleet mutations, native server activation, preview restart or release changes.",
        results,
        accessibility: scans,
        screenshots,
        transport: evidence.map((f) => ({
          requests: f.requests,
          unexpected: f.unexpected,
          errors: f.errors,
          posts: f.posts,
          lookups: f.lookups,
          recent: f.recent,
          records: f.records,
          registry: [...f.registry.entries()],
        })),
        source_sha256: sourceEnd,
        source_sha256_at_start: sourceStart,
        source_changes_during_run: Object.keys(sourceStart).filter(
          (p) => sourceStart[p] !== sourceEnd[p],
        ),
        error: failure?.stack,
      },
      null,
      2,
    ),
  );
  console.log("Evidence:", resolve(output, "report.json"));
}
