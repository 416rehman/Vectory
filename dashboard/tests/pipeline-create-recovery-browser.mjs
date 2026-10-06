// Actual App pipeline creation/duplication recovery; synthetic intercepted HTTP only.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import AxeBuilder from "./axe.mjs";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_PIPELINE_CREATION_OUTPUT ||
    ".local/pipeline-creation-recovery",
);
await mkdir(output, { recursive: true });
const sources = [
  "dashboard/src/PipelineLibrary.tsx",
  "dashboard/src/PipelineActions.tsx",
  "dashboard/src/Editor.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/App.tsx",
  "dashboard/src/pipelineCreationRequests.ts",
  "dashboard/src/PipelineStartChoice.tsx",
  "dashboard/src/credentialFields.ts",
  "dashboard/src/configurationSource.ts",
  "dashboard/src/PipelineCreationRecovery.tsx",
  "dashboard/src/pipeline-creation-recovery.css",
  "dashboard/src/ui.tsx",
  "dashboard/tests/pipeline-create-recovery-browser.mjs",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(resolve(root, p)))
          .digest("hex"),
      ]),
    ),
  );
const loaded = await hashes();
const reserve = net.createServer();
await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
const port = reserve.address().port;
await new Promise((r) => reserve.close(r));
const virtual = "\0virtual:pipeline-creation-recovery";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "pipeline-creation-recovery",
      resolveId: (id) =>
        id === "virtual:pipeline-creation-recovery" ? virtual : undefined,
      load: (id) =>
        id === virtual
          ? "import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));"
          : undefined,
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__pipeline-creation-recovery")
            return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic pipeline request response-loss proof</title></head><body><div id="root"></div><script type="module">import "virtual:pipeline-creation-recovery";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch(),
  origin = `http://127.0.0.1:${port}`;
const id = (n) => `33333333-4444-4555-8666-${String(n).padStart(12, "0")}`,
  created = "2026-09-27T13:00:00Z",
  clone = (v) => structuredClone(v);
const keyPrefix = "vectory:pipeline-creation:";
const storageKey = (requestId, actor = id(90)) =>
  `${keyPrefix}${encodeURIComponent(actor)}:${requestId}`;
function baseDocument() {
  return {
    id: id(1),
    name: "Synthetic original pipeline",
    description: "Isolated source; never deployed.",
    revision: 7,
    config: {
      sources: { seed: { type: "demo_logs", format: "json" } },
      transforms: { sample: { type: "sample", inputs: ["seed"], rate: 10 } },
      sinks: { discard: { type: "blackhole", inputs: ["sample"] } },
    },
    graph: {
      nodes: [
        { id: "seed", position: { x: 0, y: 0 } },
        { id: "sample", position: { x: 390, y: 0 } },
        { id: "discard", position: { x: 780, y: 0 } },
      ],
      edges: [],
    },
    archived: false,
    archived_at: null,
    created_at: created,
    updated_at: created,
  };
}
const state = (changes = {}) => ({
  actor: id(90),
  role: "admin",
  documents: [baseDocument()],
  registry: new Map(),
  requests: [],
  posts: [],
  controls: [],
  puts: [],
  lookups: [],
  recent: [],
  holds: [],
  errors: [],
  capability: true,
  lookupMode: "normal",
  createMode: "normal",
  recentMode: "normal",
  holdSave: false,
  ...changes,
});
const results = [],
  accessibility = [],
  screenshots = [],
  observations = [];
async function storage(page) {
  return page.evaluate(
    (prefix) =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([k]) => k.startsWith(prefix)),
      ),
    keyPrefix,
  );
}
async function start(f = state(), options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width || 899, height: 950 },
    colorScheme: options.theme || "light",
  });
  await context.addInitScript(
    ({ theme, seed, failStorage, prefix }) => {
      localStorage.setItem("vectory-theme", theme);
      localStorage.setItem("vectory-sidebar-collapsed", "true");
      localStorage.setItem("vectory.editor.auto-check", "off");
      for (const [k, v] of Object.entries(seed || {}))
        localStorage.setItem(k, v);
      window.fixture = {
        failStorage,
        failCleanup: false,
        accelerateDeadline: false,
        confirmResult: false,
        confirmations: [],
        holdBody: false,
        bodyReads: 0,
      };
      const put = Storage.prototype.setItem,
        remove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (k, v) {
        if (
          this === localStorage &&
          window.fixture.failStorage &&
          k.startsWith(prefix)
        )
          throw new DOMException(
            "Synthetic local storage unavailable",
            "QuotaExceededError",
          );
        return put.call(this, k, v);
      };
      Storage.prototype.removeItem = function (k) {
        if (
          this === localStorage &&
          window.fixture.failCleanup &&
          k.startsWith(prefix)
        )
          throw new DOMException(
            "Synthetic reminder cleanup unavailable",
            "SecurityError",
          );
        return remove.call(this, k);
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
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        if (
          window.fixture.holdBody &&
          init?.method === "POST" &&
          /\/api\/v1\/configurations(?:$|\/[^/]+\/duplicate$)/.test(
            String(input),
          )
        ) {
          const text = response.text.bind(response);
          Object.defineProperty(response, "text", {
            value: async () => {
              window.fixture.bodyReads++;
              await new Promise((done) => {
                window.fixture.releaseBody = done;
              });
              return text();
            },
          });
        }
        return response;
      };
    },
    {
      theme: options.theme || "light",
      seed: options.seed,
      failStorage: !!options.failStorage,
      prefix: keyPrefix,
    },
  );
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    if (url.origin !== origin) {
      f.errors.push(`External request ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      body = method === "GET" ? null : req.postDataJSON(),
      actor = f.actor;
    f.requests.push({
      method,
      path,
      query: url.search,
      body: clone(body),
      actor,
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
            id: actor,
            name: "Synthetic " + f.role,
            email: "creation@example.test",
            role: f.role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic pipeline recovery fixture" });
      if (path === "/mfa") return reply({ enabled: false });
      if (path === "/configurations/library") {
        const page = Number(url.searchParams.get("page") || 1),
          size = Number(url.searchParams.get("page_size") || 12),
          archived = url.searchParams.get("state") === "archived",
          search = url.searchParams.get("search") || "";
        const rows = f.documents
          .filter(
            (x) =>
              x.archived === archived &&
              x.name.toLowerCase().includes(search.toLowerCase()),
          )
          .map((x) => ({
            ...clone(x),
            component_counts: {
              sources: Object.keys(x.config.sources || {}).length,
              transforms: Object.keys(x.config.transforms || {}).length,
              sinks: Object.keys(x.config.sinks || {}).length,
            },
            latest_version: null,
          }));
        return reply({
          items: rows.slice((page - 1) * size, page * size),
          total: rows.length,
          page,
          page_size: size,
        });
      }
      if (path === "/configurations/requests") {
        const page = Number(url.searchParams.get("page") || 1),
          size = Number(url.searchParams.get("page_size") || 12);
        f.recent.push({
          actor,
          page,
          size,
          query: Object.fromEntries(url.searchParams),
        });
        if (!f.capability) return error("NOT_FOUND", "Update server", 404);
        if (f.recentMode === "failed")
          return error(
            "UNAVAILABLE",
            "Synthetic recent requests unavailable",
            503,
          );
        if (f.recentMode === "hold")
          await new Promise((done) => f.holds.push(done));
        const rows = [...f.registry.values()]
          .filter((x) => x.actor === actor)
          .map((x) => ({
            request_id: x.body.request_id,
            operation: x.operation,
            source_configuration_id: x.source,
            source_revision: x.sourceRevision,
            configuration_id: x.resultId,
            configuration_name:
              f.documents.find((d) => d.id === x.resultId)?.name || null,
            created_at: created,
          }));
        return reply({
          items: rows.slice((page - 1) * size, page * size),
          total: rows.length,
          page,
          page_size: size,
        });
      }
      if (path.startsWith("/configurations/requests/")) {
        const requestId = path.split("/").pop();
        f.lookups.push({ actor, requestId });
        const mode = f.lookupMode;
        if (!f.capability)
          return error(
            "NOT_FOUND",
            "Update server to enable pipeline recovery",
            404,
          );
        if (mode === "hold") {
          await new Promise((done) => f.holds.push(done));
          if (f.lookupHoldFailure)
            return error(
              "UNAVAILABLE",
              "Held preflight response failed after peer commit",
              503,
            );
        }
        if (mode === "failed")
          return error("UNAVAILABLE", "Synthetic lookup unavailable", 503);
        if (mode === "malformed") return reply({ found: false });
        if (mode === "wrong-request")
          return reply({ request_id: id(999), found: false });
        const r = f.registry.get(actor + ":" + requestId);
        if (!r) return reply({ request_id: requestId, found: false });
        const saved = f.documents.find((x) => x.id === r.resultId);
        if (!saved)
          return error(
            "CONFLICT",
            "Original pipeline unavailable; this key cannot create another result",
            409,
          );
        const result = {
          request_id: requestId,
          found: true,
          operation: r.operation,
          source_configuration_id: r.source,
          source_revision: r.sourceRevision,
          configuration: { ...clone(saved), request_id: requestId },
        };
        if (mode === "wrong-operation")
          result.operation = r.operation === "create" ? "duplicate" : "create";
        if (mode === "wrong-source") result.source_configuration_id = id(888);
        if (mode === "wrong-revision")
          result.source_revision = (r.sourceRevision || 0) + 1;
        if (mode === "wrong-result") result.configuration.id = id(887);
        if (mode === "source-result") result.configuration.id = r.source;
        if (mode === "wrong-nested-key")
          result.configuration.request_id = id(886);
        return reply(result);
      }
      const current = f.documents.find(
        (x) => path === `/configurations/${x.id}`,
      );
      if (current) return reply(current);
      if (/^\/configurations\/[0-9a-f-]+\/history$/.test(path))
        return reply({
          items: [],
          total: 0,
          page: Number(url.searchParams.get("page") || 1),
          page_size: Number(url.searchParams.get("page_size") || 12),
          kind: url.searchParams.get("kind") || "versions",
        });
      if (/^\/configurations\/[0-9a-f-]+$/.test(path))
        return error("NOT_FOUND", "Pipeline not found", 404);
    }
    if (req.headers()["x-csrf-token"] !== "synthetic") {
      f.errors.push("Missing CSRF");
      return error("FORBIDDEN", "Missing CSRF", 403);
    }
    if (
      method === "PUT" &&
      /^\/configurations\/[0-9a-f-]+\/draft$/.test(path)
    ) {
      const current = f.documents.find(
        (x) => path === `/configurations/${x.id}/draft`,
      );
      f.puts.push({ path, body: clone(body) });
      if (f.holdSave) await new Promise((done) => f.holds.push(done));
      if (!current) return error("NOT_FOUND", "Pipeline unavailable", 404);
      if (body.revision !== current.revision)
        return error("STALE_REVISION", "Draft changed", 409);
      Object.assign(current, clone(body), { revision: current.revision + 1 });
      return reply(current);
    }
    if (
      method === "POST" &&
      /^\/configurations\/[0-9a-f-]+\/(?:archive|unarchive)$/.test(path)
    ) {
      f.controls.push({ path, body: clone(body) });
      const original = f.documents.find((x) =>
        path.startsWith(`/configurations/${x.id}/`),
      );
      if (f.controlMode === "hold")
        await new Promise((done) => f.holds.push(done));
      if (!original) return error("NOT_FOUND", "Pipeline unavailable", 404);
      if (body.revision !== original.revision)
        return error("STALE_REVISION", "Pipeline changed", 409);
      const result = {
        ...clone(original),
        revision: original.revision + 1,
        archived: path.endsWith("/archive"),
        archived_at: path.endsWith("/archive") ? created : null,
      };
      Object.assign(original, result);
      return reply(
        f.controlMode === "wrong-source" ? { ...result, id: id(888) } : result,
      );
    }
    if (
      method === "POST" &&
      (path === "/configurations" ||
        /^\/configurations\/[0-9a-f-]+\/duplicate$/.test(path))
    ) {
      const operation = path === "/configurations" ? "create" : "duplicate",
        source = operation === "create" ? null : path.split("/")[2],
        mode = f.createMode;
      f.posts.push({
        actor,
        path,
        operation,
        body: clone(body),
        stored_before_request: await req
          .frame()
          .evaluate(
            (prefix) =>
              Object.fromEntries(
                Object.entries(localStorage).filter(([k]) =>
                  k.startsWith(prefix),
                ),
              ),
            keyPrefix,
          ),
      });
      if (!/^[0-9a-f-]{36}$/.test(body.request_id || "")) {
        f.errors.push("Unsafe unkeyed request");
        return error("UNEXPECTED", "Missing request ID", 500);
      }
      if (mode === "hold") await new Promise((done) => f.holds.push(done));
      if (mode === "before-loss") return route.abort("failed");
      if (mode === "invalid")
        return error("INVALID_INPUT", "Synthetic input rejected", 400);
      if (mode === "credential")
        return reply(
          {
            error: {
              code: "INVALID_INPUT",
              message: "Synthetic credential refusal",
              reason: "plaintext_credential",
              problems: [
                {
                  code: "plaintext_credential",
                  path: "description",
                  field: "description",
                  message:
                    "Description holds what looks like a credential. Remove the value and try again.",
                  fix: "Remove the value and try again.",
                },
              ],
            },
          },
          400,
        );
      const old = f.registry.get(actor + ":" + body.request_id);
      let record;
      if (old) {
        if (
          old.operation !== operation ||
          old.source !== source ||
          JSON.stringify(old.body) !== JSON.stringify(body)
        )
          return error("IDEMPOTENCY_CONFLICT", "Original request differs", 409);
        record = f.documents.find((x) => x.id === old.resultId);
        if (!record)
          return error("CONFLICT", "Original pipeline unavailable", 409);
      } else {
        const original = f.documents.find((x) => x.id === source);
        if (
          operation === "duplicate" &&
          (!original || original.revision !== body.revision)
        )
          return error(
            "STALE_REVISION",
            "The source pipeline changed; review before duplicating",
            409,
          );
        record = {
          ...(original ? clone(original) : baseDocument()),
          id: id(100 + f.registry.size),
          name: body.name,
          description: body.description,
          revision: 1,
          archived: false,
          archived_at: null,
          config:
            operation === "create"
              ? clone(body.config)
              : clone(original.config),
          graph:
            operation === "create" ? clone(body.graph) : clone(original.graph),
        };
        f.documents.push(record);
        f.registry.set(actor + ":" + body.request_id, {
          actor,
          operation,
          source,
          sourceRevision: operation === "duplicate" ? body.revision : null,
          resultId: record.id,
          body: clone(body),
        });
      }
      if (mode === "lost") return route.abort("failed");
      if (mode === "503")
        return error("UNAVAILABLE", "Synthetic reply failed after commit", 503);
      if (mode === "unreadable")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{",
        });
      const receipt = { ...clone(record), request_id: body.request_id };
      if (mode === "missing-key") delete receipt.request_id;
      if (mode === "wrong-key") receipt.request_id = id(999);
      if (mode === "source-result") receipt.id = source;
      if (mode === "malformed") delete receipt.config;
      return reply(receipt);
    }
    f.errors.push(`Unexpected ${method} ${path}`);
    return error("UNEXPECTED", "Unexpected synthetic request", 500);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => f.errors.push(e.message));
  const open = async (p = page, editor = false) => {
    await p.goto(
      `${origin}/__pipeline-creation-recovery#/configurations${editor ? "/" + id(1) : ""}`,
    );
    await expect(
      editor
        ? p.getByRole("region", { name: "Pipeline canvas", exact: true })
        : p.getByRole("heading", { name: "Pipelines", exact: true }),
    ).toBeVisible();
  };
  await open(page, options.editor);
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
async function run(name, fn) {
  const focus = process.env.VECTORY_PIPELINE_CREATION_FOCUS || process.argv[2];
  if (focus && !name.includes(focus)) return;
  const begin = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration_ms: Date.now() - begin });
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    throw error;
  }
}
function clean(f) {
  expect(f.errors).toEqual([]);
  expect(
    f.requests.filter(
      (r) =>
        r.method !== "GET" &&
        r.path !== "/configurations" &&
        !r.path.endsWith("/duplicate") &&
        !r.path.endsWith("/archive") &&
        !r.path.endsWith("/unarchive") &&
        !r.path.endsWith("/draft"),
    ),
  ).toEqual([]);
}
const form = (page, kind) =>
  page.getByRole("dialog", {
    name: kind === "create" ? "Create pipeline" : "Duplicate pipeline",
    exact: true,
  });
async function openForm(page, kind, options = {}) {
  if (kind === "create")
    await page
      .getByRole("button", { name: "Create pipeline", exact: true })
      .click();
  else if (options.editor) {
    await page.locator(".editor-tools-menu > summary").click();
    await page
      .getByRole("button", { name: "Duplicate pipeline", exact: true })
      .click();
  } else {
    await page
      .getByRole("button", {
        name: "Actions for Synthetic original pipeline",
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: "Duplicate pipeline", exact: true })
      .click();
  }
  const dialog = form(page, kind);
  await expect(dialog).toBeVisible();
  return dialog;
}
async function submit(page, kind, options = {}) {
  const dialog = await openForm(page, kind, options);
  await dialog
    .getByLabel("Pipeline name", { exact: true })
    .fill(options.name || "Synthetic recovered " + kind);
  if (kind === "create" && options.starter)
    await dialog
      .getByRole("radio", { name: /Try a synthetic example/ })
      .check();
  await dialog
    .getByLabel(kind === "create" ? "Description (optional)" : "Description", {
      exact: true,
    })
    .fill(options.description || "Synthetic original request; never deployed.");
  await dialog
    .getByRole("button", {
      name: kind === "create" ? "Create pipeline" : "Duplicate pipeline",
      exact: true,
    })
    .click();
  return dialog;
}
async function uncertain(page, kind) {
  const dialog = form(page, kind);
  await expect(dialog).toContainText(/needs confirmation/);
  await expect(
    dialog.getByRole("button", {
      name: kind === "create" ? "Create pipeline" : "Duplicate pipeline",
      exact: true,
    }),
  ).toBeDisabled();
}
async function closeForm(page, kind) {
  await form(page, kind)
    .getByRole("button", { name: "Close and review request", exact: true })
    .click();
  await expect(form(page, kind)).toHaveCount(0);
}
async function openRecovery(page) {
  if (
    !(await page
      .getByRole("dialog", { name: "Saved pipeline requests", exact: true })
      .isVisible())
  ) {
    await page
      .getByRole("button", { name: "Review pipeline requests", exact: true })
      .click();
  }
  await expect(
    page.getByRole("dialog", { name: "Saved pipeline requests", exact: true }),
  ).toBeVisible();
  await page
    .locator(".pipeline-creation-recovery-list > button")
    .first()
    .click();
}
async function confirmed(page) {
  await expect(
    page.getByRole("dialog", { name: "Pipeline saved", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Saved pipeline", exact: true }),
  ).toBeVisible();
}
async function checkStatus(page) {
  await page.getByRole("button", { name: "Check status", exact: true }).click();
}
async function recent(page, editor = false) {
  if (editor) {
    await page.locator(".editor-tools-menu > summary").click();
  }
  await page
    .getByRole("button", { name: "Your pipeline requests", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Your pipeline requests", exact: true }),
  ).toBeVisible();
}
const operation = (kind = "create", requestId = id(701), actor = id(90)) => ({
  actor_id: actor,
  id: requestId,
  recorded_at: created,
  operation: kind,
  source_configuration_id: kind === "duplicate" ? id(1) : null,
  request: {
    name: "Synthetic pending " + kind,
    description: "Synthetic preserved request",
    request_id: requestId,
    ...(kind === "duplicate"
      ? { revision: 7 }
      : { config: baseDocument().config, graph: baseDocument().graph }),
  },
});
async function peerWrite(page, key, value) {
  await page.evaluate(
    ({ key, value }) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue: value,
          storageArea: localStorage,
        }),
      );
    },
    { key, value },
  );
}
let failure;
try {
  await run(
    "Blank pipeline names explain the required input without sending a request, then allow creation",
    async () => {
      const s = await start();
      try {
        const dialog = await openForm(s.page, "create"),
          name = dialog.getByLabel("Pipeline name", { exact: true }),
          create = dialog.getByRole("button", {
            name: "Create pipeline",
            exact: true,
          });
        await expect(create).toBeEnabled();
        await create.click();
        await expect(dialog.getByRole("alert")).toHaveText(
          "Enter a pipeline name to create a draft.",
        );
        await expect(name).toBeFocused();
        await expect(name).toHaveAttribute("aria-invalid", "true");
        await expect(name).toHaveAttribute(
          "aria-describedby",
          /pipeline-name-error/,
        );
        expect(s.f.posts).toHaveLength(0);
        expect(s.f.lookups).toHaveLength(0);
        expect(await storage(s.page)).toEqual({});
        await name.fill("   ");
        await create.click();
        await expect(dialog.getByRole("alert")).toHaveText(
          "Enter a pipeline name to create a draft.",
        );
        expect(s.f.posts).toHaveLength(0);
        await name.fill("Synthetic named pipeline");
        await expect(dialog.getByRole("alert")).toHaveCount(0);
        await create.click();
        await expect(
          s.page.getByRole("region", { name: "Pipeline canvas", exact: true }),
        ).toBeVisible();
        expect(s.f.posts).toHaveLength(1);
        expect(s.f.posts[0].body.name).toBe("Synthetic named pipeline");
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Multibyte pipeline names show the server limit before creating a saved request",
    async () => {
      const s = await start();
      try {
        const dialog = await openForm(s.page, "create"),
          name = dialog.getByLabel("Pipeline name", { exact: true }),
          create = dialog.getByRole("button", {
            name: "Create pipeline",
            exact: true,
          });
        await name.fill("é".repeat(61));
        await expect(dialog.getByRole("alert")).toContainText(
          "120 UTF-8 bytes",
        );
        await expect(name).toHaveAttribute("aria-invalid", "true");
        await create.click();
        expect(s.f.lookups).toHaveLength(0);
        expect(s.f.posts).toHaveLength(0);
        expect(await storage(s.page)).toEqual({});
        await name.fill("é".repeat(60));
        await expect(dialog.getByRole("alert")).toHaveCount(0);
        await create.click();
        await expect(
          s.page.getByRole("region", { name: "Pipeline canvas", exact: true }),
        ).toBeVisible();
        expect(s.f.posts).toHaveLength(1);
        expect(s.f.posts[0].body.name).toBe("é".repeat(60));
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "A shared preflight failure cannot erase an operation explicitly retried and committed by another tab",
    async () => {
      for (const kind of ["create", "duplicate"]) {
        const s = await start(
          state({
            lookupMode: "hold",
            createMode: "lost",
            lookupHoldFailure: true,
          }),
        );
        try {
          await submit(s.page, kind);
          await expect.poll(() => s.f.lookups.length).toBe(1);
          const key = storageKey(s.f.lookups[0].requestId),
            raw = (await storage(s.page))[key];
          expect(raw).toBeTruthy();
          s.f.lookupMode = "normal";
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
          expect(s.f.documents).toHaveLength(2);
          expect(s.f.posts).toHaveLength(1);
          s.f.holds.shift()();
          await expect(form(s.page, kind).getByRole("alert")).toBeVisible();
          expect((await storage(s.page))[key]).toBe(raw);
          await checkStatus(peer);
          await confirmed(peer);
          expect(s.f.posts).toHaveLength(1);
          clean(s.f);
        } finally {
          await s.close();
        }
      }
    },
  );
  await run(
    "Normal create and duplicate retain a durable keyed request before mutation and preserve source/configuration boundaries",
    async () => {
      for (const settings of [
        { kind: "create" },
        { kind: "create", starter: true },
        { kind: "duplicate" },
      ]) {
        const s = await start();
        try {
          const before = clone(s.f.documents[0]);
          await submit(s.page, settings.kind, settings);
          await expect.poll(() => s.f.posts.length).toBe(1);
          await expect(
            s.page.getByRole("region", {
              name: "Pipeline canvas",
              exact: true,
            }),
          ).toBeVisible();
          expect(s.f.documents).toHaveLength(2);
          const p = s.f.posts[0];
          expect(s.f.lookups[0].requestId).toBe(p.body.request_id);
          expect(
            p.stored_before_request[storageKey(p.body.request_id)],
          ).toBeTruthy();
          expect(await storage(s.page)).toEqual({});
          expect(s.f.documents[0]).toEqual(before);
          expect(s.f.documents[1].revision).toBe(1);
          expect(s.f.documents[1].archived).toBe(false);
          if (settings.kind === "duplicate") {
            expect(p.body.revision).toBe(7);
            expect(s.f.documents[1].config).toEqual(before.config);
          } else if (settings.starter)
            expect(Object.keys(p.body.config.sources).length).toBeGreaterThan(
              0,
            );
          else
            expect(p.body.config).toEqual({
              sources: {},
              transforms: {},
              sinks: {},
            });
          clean(s.f);
        } finally {
          await s.close();
        }
      }
      for (const kind of ["create", "duplicate"]) {
        const s = await start(state({ createMode: "invalid" }));
        try {
          const dialog = await submit(s.page, kind);
          await expect(dialog.getByRole("alert")).toContainText(
            "Synthetic input rejected",
          );
          await expect(dialog).toContainText("needs confirmation");
          await expect(
            dialog.getByRole("button", {
              name:
                kind === "create" ? "Create pipeline" : "Duplicate pipeline",
              exact: true,
            }),
          ).toBeDisabled();
          await expect(
            dialog.getByLabel("Pipeline name", { exact: true }),
          ).toHaveValue("Synthetic recovered " + kind);
          const key = storageKey(s.f.posts[0].body.request_id);
          expect((await storage(s.page))[key]).toBeTruthy();
          expect(s.f.documents).toHaveLength(1);
          await dialog
            .getByRole("button", {
              name: "Close and review request",
              exact: true,
            })
            .click();
          await expect(form(s.page, kind)).toHaveCount(0);
          await expect(
            s.page.getByRole("dialog", { name: "Saved pipeline requests" }),
          ).toBeVisible();
          expect(s.f.posts).toHaveLength(1);
          clean(s.f);
        } finally {
          await s.close();
        }
      }
    },
  );
  await run(
    "Credential import stays in Create and structured refusal shows the field without uncertain recovery on mobile",
    async () => {
      const s = await start(state({ createMode: "credential" }), {
        width: 390,
        theme: "dark",
      });
      try {
        const dialog = await openForm(s.page, "create");
        await dialog
          .getByLabel("Pipeline name", { exact: true })
          .fill("Synthetic credential check");
        await dialog
          .getByText("Import a Vector config", { exact: true })
          .click();
        await dialog.getByRole("button", { name: "Paste instead" }).click();
        await dialog
          .getByLabel("Vector configuration", { exact: true })
          .fill(
            "sources:\n  demo:\n    type: demo_logs\n    format: json\nsinks:\n  out:\n    type: http\n    inputs: [demo]\n    uri: https://example.test/ingest\n    request:\n      headers:\n        Authorization: Bearer synthetic-only\n    encoding:\n      codec: json\n",
          );
        await dialog
          .getByRole("button", { name: "Use this configuration" })
          .click();
        await expect(
          dialog.locator(".pipeline-start-import-result[role=alert]"),
        ).toContainText("Line 12: sinks.out.request.headers.Authorization");
        expect(s.f.posts).toHaveLength(0);
        await expect(dialog).not.toContainText("needs confirmation");

        await dialog.getByText("Build a pipeline", { exact: true }).click();
        await dialog
          .getByRole("button", { name: "Create pipeline", exact: true })
          .click();
        await expect(dialog.getByRole("alert")).toContainText(
          "The server refused this configuration",
        );
        await expect(
          dialog.getByRole("list", { name: "Configuration problems" }),
        ).toContainText(/description/i);
        await expect(
          dialog.getByLabel("Pipeline name", { exact: true }),
        ).toBeEnabled();
        await expect(dialog).not.toContainText("needs confirmation");
        expect(s.f.posts).toHaveLength(1);
        expect(
          (await storage(s.page))[storageKey(s.f.posts[0].body.request_id)],
        ).toBeUndefined();
        expect(
          await s.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const scan = await new AxeBuilder({ page: s.page }).analyze();
        expect(scan.violations).toEqual([]);
        await s.page.screenshot({
          path: resolve(output, "pipeline-creation-credential-390-dark.png"),
          animations: "disabled",
        });
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Credential-shaped creation and duplicate metadata never reaches browser storage or POST",
    async () => {
      for (const kind of ["create", "duplicate"]) {
        const s = await start(state());
        try {
          const dialog = await openForm(s.page, kind);
          await dialog
            .getByLabel("Pipeline name", { exact: true })
            .fill("ghp_syntheticcredential123");
          await dialog
            .getByRole("button", {
              name:
                kind === "create" ? "Create pipeline" : "Duplicate pipeline",
              exact: true,
            })
            .click();
          await expect(dialog.getByRole("alert")).toContainText("name");
          expect(s.f.posts).toHaveLength(0);
          expect(await storage(s.page)).toEqual({});
          await dialog
            .getByLabel("Pipeline name", { exact: true })
            .fill("Synthetic safe name");
          await dialog
            .getByLabel(
              kind === "create" ? "Description (optional)" : "Description",
              { exact: true },
            )
            .fill("https://collector.example/?api_key=short");
          await dialog
            .getByRole("button", {
              name:
                kind === "create" ? "Create pipeline" : "Duplicate pipeline",
              exact: true,
            })
            .click();
          await expect(dialog.getByRole("alert")).toContainText("description");
          expect(s.f.posts).toHaveLength(0);
          expect(await storage(s.page)).toEqual({});
          clean(s.f);
        } finally {
          await s.close();
        }
      }
    },
  );
  await run(
    "Committed response loss survives close/reload and recovers the exact current edited or archived pipeline even after duplicate source changes or disappears",
    async () => {
      for (const kind of ["create", "duplicate"]) {
        const s = await start(state({ createMode: "lost" }));
        try {
          await submit(s.page, kind);
          await uncertain(s.page, kind);
          const first = clone(s.f.posts[0]),
            saved = s.f.documents[1];
          await closeForm(s.page, kind);
          Object.assign(saved, {
            name: "Edited original result",
            description: "Later independent result edit",
            revision: 4,
            archived: true,
            archived_at: created,
          });
          saved.config.transforms.sample = {
            type: "sample",
            inputs: ["seed"],
            rate: 27,
          };
          if (kind === "duplicate")
            s.f.documents = s.f.documents.filter((x) => x.id !== id(1));
          await s.page.reload();
          await openRecovery(s.page);
          await confirmed(s.page);
          await expect(
            s.page.getByRole("region", { name: "Saved pipeline", exact: true }),
          ).toContainText(saved.id);
          await expect(s.page.getByRole("dialog")).toContainText(
            "Archived / Draft 4",
          );
          await s.page
            .getByRole("button", { name: "Open pipeline", exact: true })
            .click();
          await expect(
            s.page.getByRole("region", {
              name: "Pipeline canvas",
              exact: true,
            }),
          ).toBeVisible();
          expect(s.page.url()).toContain(saved.id);
          expect(s.f.posts).toHaveLength(1);
          expect(s.f.posts[0].body).toEqual(first.body);
          expect(s.f.puts).toHaveLength(0);
          expect(saved.revision).toBe(4);
          expect(await storage(s.page)).toEqual({});
          clean(s.f);
        } finally {
          await s.close();
        }
      }
    },
  );
  await run(
    "Only exact found:false lookup enables deliberate same-key retry; peer changes and removed reminders never mutate frozen intent",
    async () => {
      for (const kind of ["create", "duplicate"]) {
        const s = await start(state({ createMode: "before-loss" }));
        try {
          await submit(s.page, kind);
          await uncertain(s.page, kind);
          const original = clone(s.f.posts[0].body),
            key = storageKey(original.request_id),
            raw = (await storage(s.page))[key];
          await closeForm(s.page, kind);
          s.f.lookupMode = "failed";
          await openRecovery(s.page);
          await expect(
            s.page.getByRole("dialog").getByRole("alert"),
          ).toBeVisible();
          await expect(
            s.page.getByRole("button", {
              name: "Retry same request",
              exact: true,
            }),
          ).toBeDisabled();
          s.f.lookupMode = "wrong-request";
          await checkStatus(s.page);
          await expect(
            s.page.getByRole("button", {
              name: "Retry same request",
              exact: true,
            }),
          ).toBeDisabled();
          s.f.lookupMode = "normal";
          await checkStatus(s.page);
          await expect(s.page.getByRole("dialog")).toContainText(
            "may still be in flight",
          );
          const retry = s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          });
          await expect(retry).toBeEnabled();
          const changed = JSON.parse(raw);
          changed.request.name = "Different frozen intent";
          await peerWrite(s.page, key, JSON.stringify(changed));
          await expect(retry).toBeDisabled();
          await peerWrite(s.page, key, null);
          await expect(retry).toBeDisabled();
          await peerWrite(s.page, key, raw);
          await expect(retry).toBeEnabled();
          s.f.createMode = "normal";
          await retry.click();
          await confirmed(s.page);
          expect(s.f.posts).toHaveLength(2);
          expect(s.f.posts[1].body).toEqual(original);
          expect(s.f.documents).toHaveLength(2);
          clean(s.f);
        } finally {
          await s.close();
        }
      }
    },
  );
  await run(
    "Malformed or mismatched receipts and lookup metadata cannot accept another operation, source revision or result",
    async () => {
      for (const [kind, mode] of [
        ["create", "unreadable"],
        ["create", "missing-key"],
        ["create", "wrong-key"],
        ["duplicate", "source-result"],
        ["duplicate", "malformed"],
        ["duplicate", "503"],
      ]) {
        const s = await start(state({ createMode: mode }));
        try {
          await submit(s.page, kind);
          await uncertain(s.page, kind);
          await closeForm(s.page, kind);
          s.f.lookupMode = "wrong-nested-key";
          await openRecovery(s.page);
          await expect(
            s.page.getByRole("dialog").getByRole("alert"),
          ).toBeVisible();
          await expect(
            s.page.getByRole("region", { name: "Saved pipeline", exact: true }),
          ).toHaveCount(0);
          if (kind === "duplicate") {
            for (const wrong of [
              "wrong-operation",
              "wrong-source",
              "wrong-revision",
              "source-result",
            ]) {
              s.f.lookupMode = wrong;
              await checkStatus(s.page);
              await expect(
                s.page.getByRole("region", {
                  name: "Saved pipeline",
                  exact: true,
                }),
              ).toHaveCount(0);
            }
          }
          s.f.lookupMode = "normal";
          await checkStatus(s.page);
          await confirmed(s.page);
          expect(s.f.posts).toHaveLength(1);
          expect(s.f.documents).toHaveLength(2);
          clean(s.f);
        } finally {
          await s.close();
        }
      }
    },
  );
  await run(
    "Definite duplicate stale-source rejection preserves proposed metadata and requires reviewed latest revision with a new key",
    async () => {
      const s = await start();
      try {
        const dialog = await openForm(s.page, "duplicate");
        await dialog
          .getByLabel("Pipeline name", { exact: true })
          .fill("Preserved copy title");
        await dialog
          .getByLabel("Description", { exact: true })
          .fill("Preserved description");
        s.f.documents[0].revision = 8;
        s.f.documents[0].config.transforms.sample.rate = 29;
        await dialog
          .getByRole("button", { name: "Duplicate pipeline", exact: true })
          .click();
        await expect(
          dialog.getByRole("button", {
            name: "Load latest for review",
            exact: true,
          }),
        ).toBeVisible();
        const old = clone(s.f.posts[0].body);
        expect(old.revision).toBe(7);
        expect(await storage(s.page)).toEqual({});
        await dialog
          .getByRole("button", { name: "Load latest for review", exact: true })
          .click();
        await expect(dialog).toContainText("Loaded draft revision 8");
        await expect(
          dialog.getByLabel("Pipeline name", { exact: true }),
        ).toHaveValue("Preserved copy title");
        await expect(
          dialog.getByLabel("Description", { exact: true }),
        ).toHaveValue("Preserved description");
        expect(s.f.posts).toHaveLength(1);
        await dialog
          .getByRole("button", { name: "Duplicate pipeline", exact: true })
          .click();
        await expect(
          s.page.getByRole("region", { name: "Pipeline canvas", exact: true }),
        ).toBeVisible();
        expect(s.f.posts[1].body.request_id).not.toBe(old.request_id);
        expect(s.f.posts[1].body.revision).toBe(8);
        expect(s.f.documents[1].config.transforms.sample.rate).toBe(29);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Known saved receipt plus browser cleanup failure stays confirmed and retained recovery never duplicates the result",
    async () => {
      for (const kind of ["create", "duplicate"]) {
        const s = await start();
        try {
          await s.page.evaluate(() => (window.fixture.failCleanup = true));
          await submit(s.page, kind);
          await expect(form(s.page, kind)).toContainText("Pipeline saved");
          await expect(form(s.page, kind)).not.toContainText(
            "needs confirmation",
          );
          const key = storageKey(s.f.posts[0].body.request_id);
          expect((await storage(s.page))[key]).toBeTruthy();
          await closeForm(s.page, kind);
          await openRecovery(s.page);
          await confirmed(s.page);
          await expect(s.page.getByRole("dialog")).toContainText(
            "could not clear",
          );
          await s.page.evaluate(() => (window.fixture.failCleanup = false));
          await s.page.keyboard.press("Escape");
          await openRecovery(s.page);
          await confirmed(s.page);
          expect((await storage(s.page))[key]).toBeUndefined();
          await s.page
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(s.page.locator("#main-content")).toBeFocused();
          expect(s.f.posts).toHaveLength(1);
          clean(s.f);
        } finally {
          await s.close();
        }
      }
    },
  );
  await run(
    "Legacy server, unavailable or corrupt storage, capacity and removed preflight records fail closed before unsafe mutation",
    async () => {
      for (const settings of [
        { capability: false },
        { lookupMode: "malformed" },
        { lookupMode: "wrong-request" },
        { failStorage: true },
      ]) {
        const s = await start(state(settings), settings);
        try {
          await submit(s.page, "create");
          await expect(form(s.page, "create").getByRole("alert")).toBeVisible();
          expect(s.f.posts).toHaveLength(0);
          clean(s.f);
        } finally {
          await s.close();
        }
      }
      for (const seed of [
        { [storageKey(id(710))]: "{broken" },
        Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => {
            const op = operation("create", id(720 + i));
            return [storageKey(op.id), JSON.stringify(op)];
          }),
        ),
      ]) {
        const s = await start(state(), { seed });
        try {
          const entry = s.page.getByRole("button", {
            name: "Review saved requests",
            exact: true,
          });
          await expect(entry.first()).toBeEnabled();
          await expect(
            s.page.getByText(/before creating or duplicating another/),
          ).toBeVisible();
          await entry.first().click();
          await expect(
            s.page.getByRole("dialog", {
              name: "Saved pipeline requests",
              exact: true,
            }),
          ).toBeVisible();
          if (Object.values(seed)[0] === "{broken") {
            await s.page
              .getByRole("button", {
                name: "Review unreadable reminder",
                exact: true,
              })
              .click();
            await expect(
              s.page.getByRole("button", {
                name: "Retry same request",
                exact: true,
              }),
            ).toHaveCount(0);
          }
          expect(s.f.posts).toHaveLength(0);
          clean(s.f);
        } finally {
          await s.close();
        }
      }
      const s = await start(state({ lookupMode: "hold" }));
      try {
        await submit(s.page, "create");
        await expect.poll(() => s.f.lookups.length).toBe(1);
        const key = storageKey(s.f.lookups[0].requestId);
        await peerWrite(s.page, key, null);
        s.f.lookupMode = "normal";
        s.f.holds.shift()();
        await expect(form(s.page, "create").getByRole("alert")).toBeVisible();
        expect(s.f.posts).toHaveLength(0);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Held response headers and body both reach uncertainty without cancellation claims, duplicate sends or premature dismissal",
    async () => {
      for (const bodyHold of [false, true]) {
        const s = await start(
          state({ createMode: bodyHold ? "normal" : "hold" }),
        );
        try {
          await s.page.evaluate((bodyHold) => {
            window.fixture.accelerateDeadline = true;
            window.fixture.holdBody = bodyHold;
          }, bodyHold);
          await submit(s.page, "duplicate");
          await expect.poll(() => s.f.posts.length).toBe(1);
          if (bodyHold)
            await expect
              .poll(() => s.page.evaluate(() => window.fixture.bodyReads))
              .toBe(1);
          await uncertain(s.page, "duplicate");
          expect(s.f.posts).toHaveLength(1);
          await closeForm(s.page, "duplicate");
          if (bodyHold)
            await s.page.evaluate(() => window.fixture.releaseBody());
          else s.f.holds.shift()();
          await expect.poll(() => s.f.documents.length).toBe(2);
          await openRecovery(s.page);
          await confirmed(s.page);
          expect(s.f.posts).toHaveLength(1);
          clean(s.f);
        } finally {
          await s.close();
        }
      }
      const s = await start(state({ createMode: "hold" }));
      try {
        await submit(s.page, "create");
        await expect.poll(() => s.f.posts.length).toBe(1);
        await expect(
          form(s.page, "create").getByRole("button", {
            name: "Cancel",
            exact: true,
          }),
        ).toBeDisabled();
        await s.page.keyboard.press("Escape");
        await expect(form(s.page, "create")).toBeVisible();
        expect(
          await s.page.evaluate(() =>
            window.dispatchEvent(
              new Event("vectory:before-navigate", { cancelable: true }),
            ),
          ),
        ).toBe(false);
        s.f.holds.shift()();
        await expect(
          s.page.getByRole("region", { name: "Pipeline canvas", exact: true }),
        ).toBeVisible();
        expect(s.f.posts).toHaveLength(1);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Account and role switches hide foreign intent and discard late callbacks without erasing the original actor request",
    async () => {
      const s = await start(state({ createMode: "hold" }));
      try {
        await submit(s.page, "create");
        await expect.poll(() => s.f.posts.length).toBe(1);
        const key = storageKey(s.f.posts[0].body.request_id);
        s.f.actor = id(91);
        await s.page.reload();
        await expect(
          s.page.getByRole("heading", { name: "Pipelines", exact: true }),
        ).toBeVisible();
        s.f.holds.shift()();
        await expect.poll(() => s.f.documents.length).toBe(2);
        await expect(
          s.page.getByRole("button", {
            name: "Review pipeline requests",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(s.page.url()).toMatch(/#\/configurations$/);
        expect((await storage(s.page))[key]).toBeTruthy();
        for (const role of ["operator", "viewer"]) {
          s.f.actor = id(90);
          s.f.role = role;
          await s.page.reload();
          await expect(
            s.page.getByRole("heading", { name: "Pipelines", exact: true }),
          ).toBeVisible();
          await expect(
            s.page.getByRole("button", {
              name: "Review pipeline requests",
              exact: true,
            }),
          ).toHaveCount(0);
          await expect(
            s.page.getByRole("button", {
              name: "Create pipeline",
              exact: true,
            }),
          ).toHaveCount(0);
        }
        s.f.role = "editor";
        await s.page.reload();
        await openRecovery(s.page);
        await confirmed(s.page);
        expect(s.f.posts).toHaveLength(1);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Bounded recent metadata finds exact current results after browser loss but cannot reconstruct replay or resurrect a missing result",
    async () => {
      const s = await start(state({ createMode: "lost" }));
      try {
        await submit(s.page, "duplicate");
        await uncertain(s.page, "duplicate");
        await closeForm(s.page, "duplicate");
        const original = clone([...s.f.registry.values()][0]);
        await peerWrite(s.page, storageKey(original.body.request_id), null);
        for (let i = 1; i < 14; i++) {
          const r = {
            ...clone(original),
            resultId: id(200 + i),
            body: { ...clone(original.body), request_id: id(800 + i) },
          };
          s.f.documents.push({
            ...clone(s.f.documents[1]),
            id: r.resultId,
            name: `Synthetic historical copy ${i}`,
          });
          s.f.registry.set(s.f.actor + ":" + r.body.request_id, r);
        }
        await recent(s.page);
        await expect(
          s.page
            .getByRole("table", { name: "Your pipeline requests", exact: true })
            .locator("tbody tr"),
        ).toHaveCount(12);
        expect(s.f.recent.at(-1).size).toBe(12);
        s.f.lookupMode = "wrong-result";
        await s.page
          .getByRole("button", { name: "View request", exact: true })
          .first()
          .click();
        await expect(
          s.page.getByRole("dialog").getByRole("alert"),
        ).toBeVisible();
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toHaveCount(0);
        s.f.lookupMode = "normal";
        await checkStatus(s.page);
        await confirmed(s.page);
        await s.page.keyboard.press("Escape");
        s.f.documents = s.f.documents.filter((x) => x.id !== original.resultId);
        await recent(s.page);
        await s.page
          .getByRole("button", { name: "View request", exact: true })
          .first()
          .click();
        await expect(
          s.page.getByRole("dialog").getByRole("alert"),
        ).toBeVisible();
        await expect(
          s.page.getByRole("button", {
            name: "Retry same request",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(s.f.posts).toHaveLength(1);
        clean(s.f);
      } finally {
        await s.close();
      }
    },
  );
  await run(
    "Editor duplicate waits for saved source revision; recovered navigation respects pending field/code veto and explicit discard",
    async () => {
      const s = await start(state({ holdSave: true }), { editor: true });
      try {
        await s.page.locator('.react-flow__node[data-id="sample"]').click();
        await s.page.getByLabel("One in every", { exact: true }).fill("21");
        // Drafts save explicitly (there is no autosave); the duplicate below
        // must wait for this held save to finish.
        await s.page.keyboard.press("ControlOrMeta+s");
        await expect.poll(() => s.f.puts.length).toBe(1);
        await s.page.locator(".editor-tools-menu > summary").click();
        await s.page
          .getByRole("button", { name: "Duplicate pipeline", exact: true })
          .click();
        expect(s.f.posts).toHaveLength(0);
        s.f.holds.shift()();
        await expect(form(s.page, "duplicate")).toBeVisible();
        s.f.createMode = "lost";
        await form(s.page, "duplicate")
          .getByRole("button", { name: "Duplicate pipeline", exact: true })
          .click();
        await uncertain(s.page, "duplicate");
        expect(s.f.posts[0].body.revision).toBe(8);
        await closeForm(s.page, "duplicate");
        await s.page.keyboard.press("Escape");
        await expect(s.page.getByRole("dialog")).toHaveCount(0);
        await s.page.locator('.react-flow__node[data-id="sample"]').click();
        await s.page.getByLabel("One in every", { exact: true }).fill("-");
        await openRecovery(s.page);
        await confirmed(s.page);
        await s.page
          .getByRole("button", { name: "Open pipeline", exact: true })
          .click();
        await expect(
          s.page.getByRole("dialog", { name: "Pipeline saved", exact: true }),
        ).toBeVisible();
        await expect
          .poll(() =>
            s.page.evaluate(() => window.fixture.confirmations.length),
          )
          .toBeGreaterThan(0);
        await expect(s.page).toHaveURL(new RegExp(id(1)));
        await expect(
          s.page.getByLabel("One in every", { exact: true }),
        ).toHaveValue("-");
        await s.page.evaluate(() => (window.fixture.confirmResult = true));
        await s.page
          .getByRole("button", { name: "Open pipeline", exact: true })
          .click();
        await expect(
          s.page.getByRole("region", { name: "Pipeline canvas", exact: true }),
        ).toBeVisible();
        await expect(s.page).toHaveURL(new RegExp(s.f.documents[1].id));
        expect(s.f.puts).toHaveLength(1);
        clean(s.f);
      } finally {
        await s.close();
      }
      const code = await start(state({ createMode: "lost" }), { editor: true });
      try {
        await submit(code.page, "duplicate", { editor: true });
        await uncertain(code.page, "duplicate");
        await closeForm(code.page, "duplicate");
        await code.page.keyboard.press("Escape");
        await code.page
          .getByRole("button", { name: "Code", exact: true })
          .click();
        await code.page
          .locator(".configuration-code-editor .cm-content")
          .fill("{ unfinished synthetic code");
        await openRecovery(code.page);
        await confirmed(code.page);
        await code.page
          .getByRole("button", { name: "Open pipeline", exact: true })
          .click();
        await expect
          .poll(() =>
            code.page.evaluate(() => window.fixture.confirmations.length),
          )
          .toBeGreaterThan(0);
        await expect(code.page).toHaveURL(new RegExp(id(1)));
        await expect(
          code.page.getByRole("dialog", {
            name: "Pipeline saved",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          code.page.locator(".configuration-code-editor .cm-content"),
        ).toContainText("unfinished synthetic code");
        await code.page.evaluate(() => (window.fixture.confirmResult = true));
        await code.page
          .getByRole("button", { name: "Open pipeline", exact: true })
          .click();
        await expect(code.page).toHaveURL(new RegExp(code.f.documents[1].id));
        expect(code.f.puts).toHaveLength(0);
        expect(code.f.posts).toHaveLength(1);
        clean(code.f);
      } finally {
        await code.close();
      }
    },
  );
  await run(
    "Archive guard is bounded and rejects a wrong-source receipt without trapping navigation indefinitely",
    async () => {
      for (const mode of ["hold", "wrong-source"]) {
        const s = await start(state({ controlMode: mode }));
        try {
          await s.page.evaluate(
            () => (window.fixture.accelerateDeadline = true),
          );
          await s.page
            .getByRole("button", {
              name: "Actions for Synthetic original pipeline",
              exact: true,
            })
            .click();
          await s.page
            .getByRole("menuitem", { name: "Archive pipeline", exact: true })
            .click();
          const dialog = s.page.getByRole("dialog", {
            name: "Archive pipeline",
            exact: true,
          });
          await dialog
            .getByRole("button", { name: "Archive pipeline", exact: true })
            .click();
          await expect.poll(() => s.f.controls.length).toBe(1);
          await expect(dialog.getByRole("alert")).toBeVisible();
          await expect(
            dialog.getByRole("button", { name: "Cancel", exact: true }),
          ).toBeEnabled();
          expect(
            await s.page.evaluate(() =>
              window.dispatchEvent(
                new Event("vectory:before-navigate", { cancelable: true }),
              ),
            ),
          ).toBe(true);
          await dialog
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await expect(dialog).toHaveCount(0);
          if (mode === "hold") s.f.holds.shift()();
          expect(s.f.posts).toHaveLength(0);
          clean(s.f);
        } finally {
          await s.close();
        }
      }
    },
  );
  await run(
    "Long preserved create and duplicate requests keep status and fixed controls visible in desktop/mobile light/dark with accessible focus",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          const op = operation(
            width === 375 ? "duplicate" : "create",
            id(900 + width),
          );
          op.request.description = "Synthetic original description. "
            .repeat(70)
            .slice(0, 2000);
          const s = await start(state(), {
            width,
            theme,
            seed: { [storageKey(op.id)]: JSON.stringify(op) },
          });
          try {
            await openRecovery(s.page);
            await expect(
              s.page.getByRole("button", {
                name: "Retry same request",
                exact: true,
              }),
            ).toBeEnabled();
            const dialog = s.page.getByRole("dialog");
            await expect(dialog).toContainText("may still be in flight");
            const status = await dialog.getByRole("status").boundingBox(),
              original = await s.page
                .getByRole("region", {
                  name: "Original pipeline request",
                  exact: true,
                })
                .boundingBox();
            expect(status.y).toBeLessThan(original.y);
            for (const name of ["Close dialog", "Retry same request"]) {
              const box = await dialog
                .getByRole("button", { name, exact: true })
                .boundingBox();
              expect(box.y).toBeGreaterThanOrEqual(0);
              expect(box.y + box.height).toBeLessThanOrEqual(951);
            }
            expect(
              await s.page.evaluate(() => document.documentElement.scrollWidth),
            ).toBeLessThanOrEqual(width);
            const scan = await new AxeBuilder({ page: s.page }).analyze();
            accessibility.push({ width, theme, violations: scan.violations });
            expect(scan.violations).toEqual([]);
            const image = `pipeline-creation-${width}-${theme}.png`;
            await s.page.screenshot({
              path: resolve(output, image),
              animations: "disabled",
            });
            screenshots.push(image);
            await s.page.keyboard.press("Escape");
            await expect(
              s.page.getByRole("button", {
                name: "Review pipeline requests",
                exact: true,
              }),
            ).toBeFocused();
            expect(s.f.posts).toHaveLength(0);
            clean(s.f);
          } finally {
            await s.close();
          }
        }
    },
  );
} catch (error) {
  failure = error;
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
          "Actual App/library/editor synthetic HTTP fault injection. No native persistence, real pipeline/deployment/activation or preview mutation claimed.",
        results,
        accessibility,
        screenshots,
        observations,
        error: failure?.stack || null,
        loaded_source_sha256: loaded,
        current_source_sha256: current,
        source_changed_during_run: sources.filter(
          (p) => loaded[p] !== current[p],
        ),
      },
      null,
      2,
    ) + "\n",
  );
}
if (failure) process.exitCode = 1;
