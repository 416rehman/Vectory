// Actual App/Editor; every HTTP request uses isolated synthetic state.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_PUBLISH_RECOVERY_OUTPUT || ".local/publish-recovery",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/Editor.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/App.tsx",
  "dashboard/src/PipelineHistory.tsx",
  "dashboard/src/publishRequests.ts",
  "dashboard/src/PublishRecovery.tsx",
  "dashboard/src/publish-recovery.css",
  "dashboard/src/ui.tsx",
  "dashboard/tests/publish-recovery-browser.mjs",
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
const virtual = "\0virtual:publish-recovery";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "publish-recovery-isolated",
      resolveId(id) {
        if (id === "virtual:publish-recovery") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__publish-recovery") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic publication recovery verification</title></head><body><div id="root"></div><script type="module">import "virtual:publish-recovery";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${port}`,
  browser = await chromium.launch();
const id = (n) => `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`,
  created = "2026-09-27T12:00:00Z",
  clone = (v) => structuredClone(v);
const results = [],
  accessibility = [],
  screenshots = [],
  observations = [];
function baseDocument() {
  return {
    id: id(1),
    name: "Synthetic publication recovery",
    description: "Isolated pipeline; never deployed.",
    revision: 1,
    archived: false,
    archived_at: null,
    created_at: created,
    updated_at: created,
    config: {
      sources: { seed: { type: "demo_logs", format: "json" } },
      transforms: { sample: { type: "sample", inputs: ["seed"], rate: 10 } },
      sinks: { discard: { type: "blackhole", inputs: ["sample"] } },
    },
    graph: { nodes: [], edges: [] },
  };
}
function state(options = {}) {
  return {
    actor: id(90),
    role: "admin",
    document: baseDocument(),
    versions: [],
    registry: new Map(),
    requests: [],
    posts: [],
    puts: [],
    lookups: [],
    recent: [],
    errors: [],
    holds: [],
    bootHolds: [],
    bootResponses: 0,
    capability: true,
    lookupMode: "normal",
    publishMode: "normal",
    holdSave: false,
    ...options,
  };
}
function version(f, body, number = f.versions.length + 1) {
  const artifact = JSON.stringify(f.document.config);
  return {
    id: id(100 + number),
    configuration_id: f.document.id,
    request_id: body.request_id,
    number,
    source_revision: body.revision,
    config: clone(f.document.config),
    graph: clone(f.document.graph),
    artifact,
    sha256: createHash("sha256").update(artifact).digest("hex"),
    size: Buffer.byteLength(artifact),
    created_at: created,
    message: body.message,
    validation: {
      valid: true,
      vector_validated: false,
      errors: [],
      warnings: [],
    },
    author_id: f.actor,
    author: "Synthetic publisher",
  };
}
const storageKey = (requestId, actor = id(90), configuration = id(1)) =>
  `vectory:publish-operation:${encodeURIComponent(actor)}:${configuration}:${requestId}`;
const storage = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Object.entries(localStorage).filter(([key]) =>
        key.startsWith("vectory:publish-operation:"),
      ),
    ),
  );
async function start(f = state(), options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width || 899, height: 950 },
    reducedMotion: "reduce",
    colorScheme: options.theme || "light",
  });
  await context.addInitScript(
    ({ theme, seed, failStorage }) => {
      localStorage.setItem("vectory-theme", theme);
      localStorage.setItem("vectory-sidebar-collapsed", "true");
      localStorage.setItem("vectory.editor.auto-check", "off");
      for (const [key, value] of Object.entries(seed || {}))
        localStorage.setItem(key, value);
      window.fixture = {
        failStorage,
        failCleanup: false,
        accelerateDeadline: false,
        confirmResult: false,
        confirmations: [],
      };
      const put = Storage.prototype.setItem,
        remove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (key, value) {
        if (
          this === localStorage &&
          window.fixture.failStorage &&
          key.startsWith("vectory:publish-operation:")
        )
          throw new DOMException(
            "Synthetic storage unavailable",
            "QuotaExceededError",
          );
        return put.call(this, key, value);
      };
      Storage.prototype.removeItem = function (key) {
        if (
          this === localStorage &&
          window.fixture.failCleanup &&
          key.startsWith("vectory:publish-operation:")
        )
          throw new DOMException(
            "Synthetic cleanup unavailable",
            "SecurityError",
          );
        return remove.call(this, key);
      };
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) =>
        timeout(
          fn,
          window.fixture.accelerateDeadline && ms === 30000 ? 200 : ms,
          ...args,
        );
      window.confirm = (message) => {
        window.fixture.confirmations.push(message);
        return window.fixture.confirmResult;
      };
    },
    {
      theme: options.theme || "light",
      seed: options.seed,
      failStorage: !!options.failStorage,
    },
  );
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    if (url.origin !== origin) {
      f.errors.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      body = method === "GET" ? null : req.postDataJSON(),
      actor = f.actor;
    f.requests.push({
      method,
      path,
      body: clone(body),
      actor,
      query: url.search,
    });
    const reply = (json, status = 200) => route.fulfill({ json, status }),
      error = (code, message, status) =>
        reply({ error: { code, message } }, status);
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: f.actor,
            name: "Synthetic " + f.role,
            email: "publish@example.test",
            role: f.role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic publication fixture" });
      if (path === "/mfa") return reply({ enabled: false });
      // The publish review shows where versions are assigned; no devices here.
      if (path === "/devices") return reply([]);
      if (path === `/configurations/${f.document.id}`) return reply(f.document);
      if (path === `/configurations/${f.document.id}/history`) {
        const page = Number(url.searchParams.get("page") || 1),
          size = Number(url.searchParams.get("page_size") || 12),
          kind = url.searchParams.get("kind") || "versions";
        const items =
          kind === "versions"
            ? [...f.versions].reverse().map((v) => ({
                id: v.id,
                configuration_id: v.configuration_id,
                number: v.number,
                source_revision: v.source_revision,
                created_at: v.created_at,
                message: v.message,
              }))
            : [];
        const response = {
          items: items.slice((page - 1) * size, page * size),
          total: items.length,
          page,
          page_size: size,
          kind,
        };
        if (f.holdBootHistory && size === 1) {
          await new Promise((done) => f.bootHolds.push(done));
          await reply(response);
          f.bootResponses++;
          return;
        }
        return reply(response);
      }
      if (path.startsWith("/versions/")) {
        const v = f.versions.find((v) => path === `/versions/${v.id}`);
        if (v && f.snapshotMode === "wrong-parent")
          return reply({ ...v, configuration_id: id(888) });
        if (v && f.snapshotMode === "wrong-id")
          return reply({ ...v, id: id(888) });
        return v ? reply(v) : error("NOT_FOUND", "Version unavailable", 404);
      }
      if (path === "/configurations/publish-requests") {
        const configuration = url.searchParams.get("configuration_id"),
          page = Number(url.searchParams.get("page") || 1),
          size = Number(url.searchParams.get("page_size") || 12);
        f.recent.push({ configuration, page, size, actor });
        if (!f.capability) return error("NOT_FOUND", "Update server", 404);
        const items = [...f.registry.values()]
          .filter((r) => r.actor === actor && r.configuration === configuration)
          .map((r) => ({
            request_id: r.body.request_id,
            configuration_id: r.configuration,
            version_id: r.version.id,
            number: r.version.number,
            source_revision: r.version.source_revision,
            created_at: created,
          }));
        return reply({
          items: items.slice((page - 1) * size, page * size),
          total: items.length,
          page,
          page_size: size,
        });
      }
      if (path.startsWith("/configurations/publish-requests/")) {
        const requestId = path.split("/").pop();
        f.lookups.push({ actor, requestId });
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
        if (!f.capability) return error("NOT_FOUND", "Update server", 404);
        const mode = f.lookupMode;
        if (mode === "hold") await new Promise((done) => f.holds.push(done));
        if (mode === "failed")
          return error(
            "UNAVAILABLE",
            "Synthetic publication status unavailable",
            503,
          );
        if (mode === "malformed") return reply({ found: false });
        if (mode === "wrong-request")
          return reply({ request_id: id(999), found: false });
        const recorded = f.registry.get(actor + ":" + requestId);
        if (!recorded) return reply({ request_id: requestId, found: false });
        if (!f.versions.some((v) => v.id === recorded.version.id))
          return error(
            "CONFLICT",
            "Original publication unavailable; request cannot create another version",
            409,
          );
        const v = clone(recorded.version);
        if (mode === "wrong-parent") v.configuration_id = id(888);
        if (mode === "wrong-revision") v.source_revision++;
        if (mode === "wrong-message") v.message = "Different message";
        if (mode === "wrong-version") v.id = id(889);
        return reply({ request_id: requestId, found: true, version: v });
      }
    }
    if (req.headers()["x-csrf-token"] !== "synthetic") {
      f.errors.push("Missing CSRF");
      return error("FORBIDDEN", "Missing CSRF", 403);
    }
    if (method === "PUT" && path === `/configurations/${f.document.id}/draft`) {
      f.puts.push(clone(body));
      if (f.holdSave) await new Promise((done) => f.holds.push(done));
      if (body.revision !== f.document.revision)
        return error("STALE_REVISION", "Synthetic draft changed", 409);
      Object.assign(f.document, clone(body), {
        revision: f.document.revision + 1,
        updated_at: created,
      });
      return reply(f.document);
    }
    // After a validation rejection the editor re-checks the draft to show
    // Vector's findings; this synthetic draft itself is valid.
    if (
      method === "POST" &&
      path === `/configurations/${f.document.id}/validate`
    ) {
      f.validations = (f.validations || 0) + 1;
      return reply({
        valid: true,
        vector_validated: true,
        static_checked: true,
        deferred: false,
        diagnostics: [],
        errors: [],
        warnings: [],
        vector_version: "0.58.0",
      });
    }
    if (
      method === "POST" &&
      path === `/configurations/${f.document.id}/publish`
    ) {
      f.posts.push({
        actor,
        body: clone(body),
        stored_before_request: await req
          .frame()
          .evaluate(() =>
            Object.fromEntries(
              Object.entries(localStorage).filter(([key]) =>
                key.startsWith("vectory:publish-operation:"),
              ),
            ),
          ),
      });
      const mode = f.publishMode;
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
      if (mode === "before-loss") return route.abort("failed");
      if (mode === "invalid")
        return error(
          "VALIDATION_FAILED",
          "Synthetic native validation rejected this draft",
          422,
        );
      if (mode === "stale")
        return error(
          "STALE_REVISION",
          "Draft changed; review before publishing",
          409,
        );
      if (!/^[0-9a-f-]{36}$/.test(body.request_id || "")) {
        f.errors.push("Unkeyed publish");
        return error("UNEXPECTED", "Missing request_id", 500);
      }
      const key = actor + ":" + body.request_id;
      let recorded = f.registry.get(key);
      if (
        recorded &&
        (recorded.configuration !== f.document.id ||
          JSON.stringify(recorded.body) !== JSON.stringify(body))
      )
        return error(
          "IDEMPOTENCY_CONFLICT",
          "Immutable publication request changed",
          409,
        );
      if (!recorded) {
        if (body.revision !== f.document.revision)
          return error(
            "STALE_REVISION",
            "Draft changed; review before publishing",
            409,
          );
        const v = version(f, body);
        f.versions.push(v);
        recorded = {
          actor,
          configuration: f.document.id,
          body: clone(body),
          version: v,
        };
        f.registry.set(key, recorded);
      }
      if (!f.versions.some((v) => v.id === recorded.version.id))
        return error("CONFLICT", "Original publication unavailable", 409);
      if (mode === "lost") return route.abort("failed");
      if (mode === "server-failed")
        return error("UNAVAILABLE", "Synthetic response unavailable", 503);
      if (mode === "unreadable")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{",
        });
      const v = clone(recorded.version);
      if (mode === "wrong-request") v.request_id = id(888);
      if (mode === "wrong-parent") v.configuration_id = id(888);
      if (mode === "wrong-revision") v.source_revision++;
      if (mode === "wrong-message") v.message = "Unexpected message";
      if (mode === "missing-request") delete v.request_id;
      return reply(v);
    }
    f.errors.push(`${method} ${path}`);
    return error("UNEXPECTED", path, 500);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.setDefaultNavigationTimeout(30000);
  page.on("pageerror", (e) => f.errors.push(e.message));
  const open = async (p = page) => {
    await p.goto(
      `${origin}/__publish-recovery#/configurations/${f.document.id}`,
    );
    await expect(
      p.getByRole("region", { name: "Pipeline canvas", exact: true }),
    ).toBeVisible();
  };
  await open();
  return {
    f,
    page,
    context,
    open,
    close: async () => {
      for (const done of f.holds.splice(0)) done();
      for (const done of f.bootHolds.splice(0)) done();
      await context.close();
    },
  };
}
const reviewDialog = (page) =>
  page.getByRole("dialog", { name: "Review & publish", exact: true });
async function publish(page, message = "Synthetic original publication note") {
  await page
    .getByRole("button", { name: "Review & publish", exact: true })
    .click();
  await reviewDialog(page)
    .getByRole("textbox", { name: "Version note (optional)", exact: true })
    .fill(message);
  await reviewDialog(page)
    .getByRole("button", { name: "Publish version", exact: true })
    .click();
}
async function run(name, fn) {
  const focus = process.env.VECTORY_PUBLISH_RECOVERY_FOCUS;
  if (focus && !name.includes(focus)) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration_ms: Date.now() - started });
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    throw error;
  }
}
async function clean(f) {
  expect(f.errors).toEqual([]);
  expect(
    f.requests.filter(
      (r) =>
        r.method !== "GET" &&
        !r.path.endsWith("/publish") &&
        !r.path.endsWith("/draft") &&
        // Read-only re-check after a validation rejection.
        !r.path.endsWith("/validate"),
    ),
  ).toEqual([]);
}
async function uncertain(page) {
  await expect(reviewDialog(page)).toContainText(
    "Publish result needs confirmation",
  );
  await expect(
    reviewDialog(page).getByRole("button", {
      name: "Publish version",
      exact: true,
    }),
  ).toBeDisabled();
}
async function closePublish(page) {
  await reviewDialog(page)
    .getByRole("button", { name: "Close and review request", exact: true })
    .click();
  await expect(reviewDialog(page)).toHaveCount(0);
}
async function openRecovery(page) {
  await page
    .getByRole("button", { name: "Review publish requests", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Saved publish requests", exact: true }),
  ).toBeVisible();
  const corrupt = page.getByRole("button", {
    name: "Review unreadable reminder",
    exact: true,
  });
  if (await corrupt.count()) await corrupt.click();
  else await page.locator(".publish-recovery-list > button").first().click();
}
async function published(page) {
  await expect(
    page.getByRole("dialog", { name: "Published", exact: true }),
  ).toBeVisible();
}
async function noResend(f, count = 1) {
  expect(f.posts).toHaveLength(count);
  await clean(f);
}
async function recent(page) {
  await page.locator(".editor-tools-menu > summary").click();
  await page
    .getByRole("button", { name: "Your publish requests", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Your recent publications", exact: true }),
  ).toBeVisible();
}
let failure;
try {
  for (const sharedFault of [
    { phase: "preflight", code: "UNAVAILABLE", status: 503 },
    { phase: "preflight", code: "FORBIDDEN", status: 403 },
    { phase: "post", code: "INVALID_INPUT", status: 400 },
    { phase: "post", code: "FORBIDDEN", status: 403 },
    { phase: "post", code: "STALE_REVISION", status: 409 },
  ])
    await run(
      `Shared request: ${sharedFault.phase} ${sharedFault.code} cannot erase a peer committed publication`,
      async () => {
        const before = process.env.VECTORY_EXPECT_SHARED_CLEANUP_LOSS === "1";
        const mobile = sharedFault.code === "INVALID_INPUT";
        const s = await start(
          state({ sharedFault: { ...sharedFault }, publishMode: "lost" }),
          { width: mobile ? 375 : 899, theme: mobile ? "dark" : "light" },
        );
        try {
          await publish(s.page);
          await expect.poll(() => s.f.holds.length).toBe(1);
          const stored = await storage(s.page),
            [key] = Object.keys(stored);
          const original = JSON.parse(stored[key]);
          const peer = await s.context.newPage();
          await s.open(peer);
          await openRecovery(peer);
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
          expect(s.f.versions).toHaveLength(1);
          expect(s.f.registry.size).toBe(1);
          expect(s.f.posts.at(-1).body).toEqual(original.request);
          s.f.holds.shift()();
          await expect.poll(() => s.f.sharedFault.returned).toBe(true);
          if (before) {
            await expect
              .poll(async () => (await storage(peer))[key])
              .toBeUndefined();
            await peer.reload();
            await expect(
              peer.getByRole("region", {
                name: "Pipeline canvas",
                exact: true,
              }),
            ).toBeVisible();
            await expect(
              peer.getByRole("button", {
                name: "Review publish requests",
                exact: true,
              }),
            ).toHaveCount(0);
          } else {
            await uncertain(s.page);
            await expect(reviewDialog(s.page)).toContainText(
              sharedFault.phase === "preflight"
                ? "Synthetic original-tab rejection after peer commit"
                : "Synthetic pre-writer rejection after peer commit",
            );
            await expect(reviewDialog(s.page)).not.toContainText(
              "No version was published",
            );
            expect((await storage(peer))[key]).toBe(stored[key]);
            if (sharedFault.code === "UNAVAILABLE" || mobile) {
              const filename = `publication-shared-reminder-${mobile ? "375-dark" : "899-light"}.png`;
              await s.page.screenshot({ path: resolve(output, filename) });
              screenshots.push(filename);
              const scan = await new AxeBuilder({ page: s.page })
                .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
                .analyze();
              accessibility.push({
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
            await openRecovery(peer);
            await published(peer);
            await expect(peer.getByRole("dialog")).toContainText(
              original.request.message,
            );
          }
          expect(s.f.posts).toHaveLength(sharedFault.phase === "post" ? 2 : 1);
          expect(s.f.versions).toHaveLength(1);
          await clean(s.f);
          observations.push({
            scenario: "shared-reminder-cleanup",
            ...sharedFault,
            expected_defect_observation: before,
            request_id: original.id,
            version_id: s.f.versions[0].id,
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
    "Publication waits for an acknowledged explicit save, preserves the exact saved revision and does not deploy",
    async () => {
      const s = await start(state({ holdSave: true }));
      try {
        await s.page.locator('.react-flow__node[data-id="sample"]').click();
        await s.page.getByLabel("One in every", { exact: true }).fill("21");
        await s.page
          .getByRole("button", {
            name: "Close component settings",
            exact: true,
          })
          .click();
        await s.page.getByRole("button", { name: "Save options" }).click();
        await s.page
          .getByRole("menuitem", { name: "Save draft", exact: true })
          .click();
        await expect.poll(() => s.f.puts.length).toBe(1);
        await publish(s.page);
        expect(s.f.posts).toHaveLength(0);
        expect(s.f.lookups).toHaveLength(0);
        for (const done of s.f.holds.splice(0)) done();
        await expect(reviewDialog(s.page)).toHaveCount(0);
        expect(s.f.posts).toHaveLength(1);
        expect(s.f.posts[0].body.revision).toBe(2);
        expect(s.f.versions[0].config.transforms.sample.rate).toBe(21);
        expect(s.f.lookups[0].requestId).toBe(s.f.posts[0].body.request_id);
        expect(
          Object.values(s.f.posts[0].stored_before_request).join("\n"),
        ).toContain(s.f.posts[0].body.request_id);
        await expect(
          s.page.getByRole("button", { name: "Choose devices", exact: true }),
        ).toBeVisible();
        await noResend(s.f);
      } finally {
        await s.close();
      }
      const boot = await start(state({ holdBootHistory: true }));
      try {
        await expect.poll(() => boot.f.bootHolds.length).toBe(1);
        // Until the published version is known, publishing waits.
        await expect(
          boot.page.getByRole("button", {
            name: "Checking version",
            exact: true,
          }),
        ).toBeDisabled();
        for (const done of boot.f.bootHolds.splice(0)) done();
        await expect.poll(() => boot.f.bootResponses).toBe(1);
        await publish(boot.page);
        await expect(reviewDialog(boot.page)).toHaveCount(0);
        // The next step offers deployment; the toolbar now matches the version.
        await boot.page
          .getByRole("dialog", { name: /^Version \d+ published$/ })
          .getByRole("button", { name: "Done", exact: true })
          .click();
        await expect(
          boot.page.getByRole("button", {
            name: "Choose devices",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          boot.page.getByRole("button", {
            name: "Review & publish",
            exact: true,
          }),
        ).toHaveCount(0);
        await noResend(boot.f);
      } finally {
        await boot.close();
      }
    },
  );
  await run(
    "Lost committed response survives reload and recovers the exact older immutable version without changing the current draft",
    async () => {
      const s = await start(state({ publishMode: "lost" }));
      try {
        await publish(s.page);
        await uncertain(s.page);
        await closePublish(s.page);
        const original = clone(s.f.versions[0]),
          key = storageKey(s.f.posts[0].body.request_id);
        expect((await storage(s.page))[key]).toBeTruthy();
        s.f.document.revision = 2;
        s.f.document.config.transforms.sample.rate = 23;
        for (let n = 2; n <= 15; n++)
          s.f.versions.push(
            version(
              s.f,
              {
                request_id: id(500 + n),
                revision: 2,
                message: `Later synthetic version ${n}`,
              },
              n,
            ),
          );
        const latestDraft = clone(s.f.document);
        await s.page.reload();
        await expect(
          s.page.getByRole("region", { name: "Pipeline canvas", exact: true }),
        ).toBeVisible();
        await openRecovery(s.page);
        await published(s.page);
        await expect(
          s.page.getByRole("region", {
            name: "Published version",
            exact: true,
          }),
        ).toContainText(original.id);
        await expect(s.page.getByRole("dialog")).toContainText(
          "current draft stays unchanged",
        );
        s.f.snapshotMode = "wrong-parent";
        await s.page
          .getByRole("button", {
            name: "Review published version",
            exact: true,
          })
          .click();
        await expect(s.page.getByRole("dialog")).toHaveCount(0);
        await expect(s.page.locator(".history-snapshot-heading h3")).toHaveText(
          "Version 1",
        );
        await expect(
          s.page.locator(".pipeline-history").getByRole("alert"),
        ).toContainText("different snapshot");
        await expect(
          s.page.getByRole("button", {
            name: "Deploy this version",
            exact: true,
          }),
        ).toBeDisabled();
        s.f.snapshotMode = "normal";
        await s.page
          .locator(".history-heading-actions")
          .getByRole("button", { name: "Refresh history", exact: true })
          .click();
        await s.page.getByText("Snapshot details", { exact: true }).click();
        await expect(s.page.locator(".history-provenance")).toContainText(
          original.id,
        );
        expect(s.f.document).toEqual(latestDraft);
        expect(s.f.puts).toHaveLength(0);
        await expect(
          s.page
            .locator(".editor-message")
            .filter({ hasText: "publish result could not be confirmed" }),
        ).toHaveCount(0);
        expect(
          s.f.requests.filter((r) => r.path === `/versions/${original.id}`)
            .length,
        ).toBeGreaterThan(0);
        await noResend(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Only a successful absent exact lookup permits explicit same-key retry; changed local intent is never replayed",
    async () => {
      const s = await start(state({ publishMode: "before-loss" }));
      try {
        await publish(s.page);
        await uncertain(s.page);
        await closePublish(s.page);
        const body = clone(s.f.posts[0].body),
          key = storageKey(body.request_id),
          raw = (await storage(s.page))[key];
        s.f.lookupMode = "failed";
        await openRecovery(s.page);
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeDisabled();
        s.f.lookupMode = "wrong-request";
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
        await expect(s.page.getByRole("dialog")).toContainText(
          "It may still be in flight",
        );
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeEnabled();
        const peer = await s.context.newPage();
        await s.open(peer);
        await peer.evaluate(
          ({ key, raw }) => {
            const op = JSON.parse(raw);
            op.request.message = "Peer changed contents";
            localStorage.setItem(key, JSON.stringify(op));
          },
          { key, raw },
        );
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeDisabled();
        await peer.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
          key,
          raw,
        });
        await peer.close();
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toBeEnabled();
        s.f.publishMode = "normal";
        await s.page
          .getByRole("button", { name: "Retry same request", exact: true })
          .click();
        await published(s.page);
        expect(s.f.posts[1].body).toEqual(body);
        expect(s.f.versions).toHaveLength(1);
        await noResend(s.f, 2);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Malformed or mismatched receipts retain uncertainty and lookup must match the frozen pipeline, revision and message",
    async () => {
      for (const mode of [
        "unreadable",
        "missing-request",
        "wrong-request",
        "wrong-parent",
        "wrong-revision",
        "wrong-message",
        "server-failed",
      ]) {
        const s = await start(state({ publishMode: mode }));
        try {
          await publish(s.page);
          await uncertain(s.page);
          await closePublish(s.page);
          for (const lookupMode of [
            "wrong-parent",
            "wrong-revision",
            "wrong-message",
          ]) {
            s.f.lookupMode = lookupMode;
            await openRecovery(s.page);
            await expect(
              s.page.getByRole("dialog", { name: "Published", exact: true }),
            ).toHaveCount(0);
            await expect(
              s.page.getByRole("button", {
                name: "Retry same request",
                exact: true,
              }),
            ).toBeDisabled();
            await s.page.keyboard.press("Escape");
          }
          s.f.lookupMode = "normal";
          await openRecovery(s.page);
          await published(s.page);
          await noResend(s.f);
        } finally {
          await s.close();
        }
      }
    },
  );
  await run(
    "A valid receipt with failed browser cleanup remains explicitly published and never sends a duplicate",
    async () => {
      const s = await start();
      try {
        await s.page.evaluate(() => {
          window.fixture.failCleanup = true;
        });
        await publish(s.page);
        await expect(reviewDialog(s.page)).toContainText("Version published");
        await expect(reviewDialog(s.page)).not.toContainText(
          "Publish result needs confirmation",
        );
        await expect(reviewDialog(s.page)).toContainText(
          "could not clear its reminder",
        );
        const key = storageKey(s.f.posts[0].body.request_id);
        expect((await storage(s.page))[key]).toBeTruthy();
        await closePublish(s.page);
        await openRecovery(s.page);
        await published(s.page);
        await expect(s.page.getByRole("dialog")).toContainText(
          "could not clear",
        );
        await s.page.evaluate(() => {
          window.fixture.failCleanup = false;
        });
        await s.page.keyboard.press("Escape");
        await openRecovery(s.page);
        await published(s.page);
        expect((await storage(s.page))[key]).toBeUndefined();
        await s.page
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(s.page.getByRole("dialog")).toHaveCount(0);
        await expect(s.page.locator("#main-content")).toBeFocused();
        await noResend(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Validation/stale rejections are definitive once no version exists under the key: the review keeps the reason and a fresh intent follows; held publication cannot silently retry after a deadline",
    async () => {
      for (const publishMode of ["invalid", "stale"]) {
        const s = await start(state({ publishMode }));
        try {
          await publish(s.page);
          const alert = reviewDialog(s.page).getByRole("alert");
          await expect(alert).toContainText(
            publishMode === "invalid"
              ? "Vector rejected this version. Nothing was published."
              : "The draft changed while you reviewed it. Nothing was published.",
          );
          // The server confirmed that no version exists under the request key
          // before the saved reminder was cleared.
          await expect
            .poll(() => s.f.lookups.at(-1)?.requestId)
            .toBe(s.f.posts[0].body.request_id);
          expect(s.f.lookups).toHaveLength(2);
          expect(Object.keys(await storage(s.page))).toHaveLength(0);
          await expect(
            reviewDialog(s.page).getByText("Publish result needs confirmation"),
          ).toHaveCount(0);
          expect(s.f.versions).toHaveLength(0);
          expect(s.f.posts).toHaveLength(1);
          const first = s.f.posts[0].body.request_id;
          s.f.publishMode = "normal";
          await reviewDialog(s.page)
            .getByRole("button", { name: "Publish version", exact: true })
            .click();
          await expect(reviewDialog(s.page)).toHaveCount(0);
          expect(s.f.posts[1].body.request_id).not.toBe(first);
          expect(s.f.posts[1].body.revision).toBe(1);
          await noResend(s.f, 2);
        } finally {
          await s.close();
        }
      }
      const held = await start(state({ publishMode: "hold" }));
      try {
        await held.page.evaluate(() => {
          window.fixture.accelerateDeadline = true;
        });
        await publish(held.page);
        await expect.poll(() => held.f.posts.length).toBe(1);
        await expect(
          reviewDialog(held.page).getByRole("button", {
            name: "Back to draft",
            exact: true,
          }),
        ).toBeDisabled();
        await held.page.keyboard.press("Escape");
        await expect(reviewDialog(held.page)).toBeVisible();
        expect(
          await held.page.evaluate(() => {
            const e = new Event("vectory:before-navigate", {
              cancelable: true,
            });
            window.dispatchEvent(e);
            return e.defaultPrevented;
          }),
        ).toBe(true);
        await uncertain(held.page);
        await closePublish(held.page);
        for (const done of held.f.holds.splice(0)) done();
        await expect.poll(() => held.f.versions.length).toBe(1);
        await openRecovery(held.page);
        await published(held.page);
        await noResend(held.f);
      } finally {
        await held.close();
      }
    },
  );
  await run(
    "Incompatible servers, unavailable/corrupt storage and a record removed during preflight never send an unsafe publication",
    async () => {
      for (const mode of ["legacy", "malformed", "wrong-request", "storage"]) {
        const s = await start(
          state({
            capability: mode !== "legacy",
            lookupMode: ["malformed", "wrong-request"].includes(mode)
              ? mode
              : "normal",
          }),
          { failStorage: mode === "storage" },
        );
        try {
          await publish(s.page);
          await expect(reviewDialog(s.page).getByRole("alert")).toBeVisible();
          expect(s.f.posts).toHaveLength(0);
          expect(s.f.versions).toHaveLength(0);
          await clean(s.f);
        } finally {
          await s.close();
        }
      }
      const key = storageKey(id(701)),
        corrupt = await start(state(), { seed: { [key]: "{unreadable" } });
      try {
        await openRecovery(corrupt.page);
        await expect(
          corrupt.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toHaveCount(0);
        await noResend(corrupt.f, 0);
      } finally {
        await corrupt.close();
      }
      const race = await start(state({ lookupMode: "hold" }));
      try {
        await publish(race.page);
        await expect.poll(() => race.f.lookups.length).toBe(1);
        const peer = await race.context.newPage();
        await race.open(peer);
        await peer.evaluate(() => {
          for (const key of Object.keys(localStorage))
            if (key.startsWith("vectory:publish-operation:"))
              localStorage.removeItem(key);
        });
        await peer.close();
        for (const done of race.f.holds.splice(0)) done();
        await expect(reviewDialog(race.page).getByRole("alert")).toBeVisible();
        await noResend(race.f, 0);
      } finally {
        await race.close();
      }
    },
  );
  await run(
    "Foreign accounts, editor/viewer roles and archived drafts never gain publication authority or erase existing intent",
    async () => {
      const s = await start(state({ publishMode: "lost" }));
      try {
        await publish(s.page);
        await uncertain(s.page);
        await closePublish(s.page);
        const key = storageKey(s.f.posts[0].body.request_id);
        for (const access of [
          { actor: id(91), role: "admin" },
          { actor: id(90), role: "viewer" },
          { actor: id(90), role: "editor" },
        ]) {
          Object.assign(s.f, access);
          await s.page.reload();
          await expect(
            s.page.getByRole("region", {
              name: "Pipeline canvas",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            s.page.getByRole("button", {
              name: "Review publish requests",
              exact: true,
            }),
          ).toHaveCount(0);
          expect((await storage(s.page))[key]).toBeTruthy();
        }
        s.f.actor = id(90);
        s.f.role = "operator";
        s.f.document.archived = true;
        s.f.document.archived_at = created;
        await s.page.reload();
        await openRecovery(s.page);
        await published(s.page);
        await noResend(s.f);
      } finally {
        await s.close();
      }
      const pending = await start(state({ publishMode: "lost" }));
      try {
        await publish(pending.page);
        await uncertain(pending.page);
        await closePublish(pending.page);
        await pending.page
          .locator('.react-flow__node[data-id="sample"]')
          .click();
        const rate = pending.page.getByLabel("One in every", { exact: true });
        await rate.fill("-");
        await openRecovery(pending.page);
        await published(pending.page);
        await pending.page
          .getByRole("button", {
            name: "Review published version",
            exact: true,
          })
          .click();
        await expect(
          pending.page.getByRole("dialog", { name: "Published", exact: true }),
        ).toBeVisible();
        expect(
          await pending.page.evaluate(() => window.fixture.confirmations),
        ).toContain("Discard unapplied field changes?");
        await pending.page.keyboard.press("Escape");
        await expect(rate).toHaveValue("-");
        expect(pending.f.document.config.transforms.sample.rate).toBe(10);
        expect(pending.f.puts).toHaveLength(0);
        await noResend(pending.f);
      } finally {
        await pending.close();
      }
    },
  );
  await run(
    "Recent requests find exact immutable results after local reminder loss, reject wrong selected identity, and never reconstruct a replay",
    async () => {
      const s = await start(state({ publishMode: "lost" }));
      try {
        await publish(s.page);
        await uncertain(s.page);
        await closePublish(s.page);
        await s.page.evaluate(() => {
          for (const key of Object.keys(localStorage))
            if (key.startsWith("vectory:publish-operation:"))
              localStorage.removeItem(key);
        });
        await recent(s.page);
        expect(s.f.recent.at(-1).configuration).toBe(id(1));
        s.f.lookupMode = "wrong-version";
        await s.page
          .getByRole("button", { name: "View request", exact: true })
          .first()
          .click();
        await expect(
          s.page.getByRole("dialog", { name: "Published", exact: true }),
        ).toHaveCount(0);
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toHaveCount(0);
        s.f.lookupMode = "normal";
        await s.page
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await published(s.page);
        await s.page.keyboard.press("Escape");
        s.f.versions = [];
        await recent(s.page);
        await s.page
          .getByRole("button", { name: "View request", exact: true })
          .first()
          .click();
        await expect(
          s.page.getByRole("dialog").getByRole("alert"),
        ).toContainText("unavailable");
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toHaveCount(0);
        await noResend(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Recovery dialogs preserve status-first content, fixed controls, keyboard focus and light/dark mobile accessibility",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          const requestId = id(703),
            operation = {
              actor_id: id(90),
              configuration_id: id(1),
              id: requestId,
              recorded_at: created,
              request: {
                request_id: requestId,
                revision: 1,
                message: "Synthetic original publication note. "
                  .repeat(60)
                  .slice(0, 2000),
              },
            };
          const s = await start(state(), {
            width,
            theme,
            seed: { [storageKey(requestId)]: JSON.stringify(operation) },
          });
          try {
            await openRecovery(s.page);
            const dialog = s.page.getByRole("dialog", {
              name: "Review publication",
              exact: true,
            });
            await expect(dialog).toContainText("It may still be in flight");
            await expect(
              dialog.getByRole("button", { name: "Close dialog", exact: true }),
            ).toBeInViewport();
            await expect(
              dialog.getByRole("button", {
                name: "Retry same request",
                exact: true,
              }),
            ).toBeInViewport();
            const status = await dialog
              .getByText(
                "No completed request was found yet. It may still be in flight.",
                { exact: true },
              )
              .boundingBox();
            const original = await dialog
              .getByRole("region", {
                name: "Original publication request",
                exact: true,
              })
              .boundingBox();
            expect(status.y).toBeLessThan(original.y);
            expect(
              await s.page.evaluate(() => document.documentElement.scrollWidth),
            ).toBeLessThanOrEqual(width);
            const scan = await new AxeBuilder({ page: s.page })
              .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
              .analyze();
            accessibility.push({
              width,
              theme,
              violations: scan.violations.map((v) => ({
                id: v.id,
                impact: v.impact,
                nodes: v.nodes.map((n) => n.target),
              })),
            });
            expect(scan.violations).toEqual([]);
            const filename = `publish-recovery-${width}-${theme}.png`;
            await s.page.screenshot({ path: resolve(output, filename) });
            screenshots.push(filename);
            await s.page.keyboard.press("Escape");
            await expect(
              s.page.getByRole("button", {
                name: "Review publish requests",
                exact: true,
              }),
            ).toBeFocused();
            await noResend(s.f, 0);
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
        passed: !failure && results.length > 0,
        scope:
          "Actual App immutable publication recovery with intercepted synthetic HTTP only. No native persistence, real publication/deployment or device activation claimed.",
        results,
        accessibility,
        screenshots,
        observations,
        error: failure || null,
        loaded_source_sha256: loaded,
        current_source_sha256: current,
        source_changed_during_run: Object.keys(current).filter(
          (p) => loaded[p] !== current[p],
        ),
      },
      null,
      2,
    ) + "\n",
  );
  if (failure || !results.length) process.exitCode = 1;
}
