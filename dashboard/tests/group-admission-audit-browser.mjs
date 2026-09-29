// Actual Groups/GroupEditor, AuditLog and destination App; synthetic transport only.
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
  process.env.VECTORY_GROUP_ADMISSION_AUDIT_OUTPUT ||
    ".local/group-admission-audit",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/AuditLog.tsx",
  "dashboard/src/App.tsx",
  "dashboard/src/Deployments.tsx",
  "dashboard/src/deploymentRouting.ts",
  "dashboard/src/audit.css",
  "dashboard/src/GroupEditor.tsx",
  "dashboard/src/group-editor.css",
  "dashboard/src/Fleet.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/tests/group-admission-audit-browser.mjs",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(root, file)))
          .digest("hex"),
      ]),
    ),
  );
const loadedSource = await hashes();
const virtual = "\0virtual:group-admission-audit";
const reservation = net.createServer();
await new Promise((done, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "group-admission-audit",
      resolveId(id) {
        if (id === "virtual:group-admission-audit") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return [
          "import React,{useState} from 'react';import{createRoot}from'react-dom/client';",
          "import{Groups}from'/src/Fleet.tsx';import{AuditLog}from'/src/AuditLog.tsx';import App from'/src/App.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';",
          "setCSRF('synthetic-csrf');",
          "function Fixture(){const[user,setUser]=useState(window.testUser);window.fixture.setUser=setUser;",
          "return location.hash.startsWith('#/deployments')?React.createElement(App):window.testMode==='audit'?React.createElement(AuditLog):React.createElement(Groups,{user,notify:message=>window.fixture.notices.push({message,actor:user.id})});}",
          "createRoot(document.getElementById('root')).render(React.createElement(Fixture));",
        ].join("\n");
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__group-admission-audit")
            return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic group concurrency verification</title></head><body><main id="main-content" tabindex="-1" style="padding:20px"><div id="root"></div></main><script type="module">import "virtual:group-admission-audit";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = "http://127.0.0.1:" + port;
const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const actor = (role = "operator", n = 90) => ({
  id: id(n),
  role,
  name: "Synthetic " + role,
  email: role + "@example.test",
  enabled: true,
  revision: 1,
});
const group = (revision = 1) => ({
  id: id(10),
  name: "Synthetic production group",
  description: "Original description",
  device_ids: [id(1)],
  revision,
  created_at: "2026-09-27T00:00:00Z",
});
const device = (n, name = "Synthetic edge " + n) => ({
  id: id(n),
  name,
  os: "windows",
  arch: "amd64",
  status: "verified",
  apply_state: "verified_applied",
  desired_generation: 1,
  reported_generation: 1,
  labels: {},
  last_seen: "2026-09-27T00:00:00Z",
});
function fixture(initial = group()) {
  return {
    groups: new Map(initial ? [[initial.id, structuredClone(initial)]] : []),
    devices: [device(1), device(2), device(3)],
    requests: [],
    writes: [],
    commits: 0,
    releases: [],
    nextError: null,
    replyMode: null,
    detailError: null,
    holdWrite: false,
    errors: [],
  };
}
const browser = await chromium.launch();
const results = [],
  scans = [],
  screenshots = [];
async function start(f, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 899, height: 900 },
    reducedMotion: "reduce",
    colorScheme: options.theme || "light",
  });
  await context.addInitScript(() => {
    const nativeTimeout = window.setTimeout.bind(window),
      nativeClear = window.clearTimeout.bind(window);
    const deadlines = new Map();
    let sequence = 900000;
    window.fixture = {
      notices: [],
      confirmations: [],
      confirmResult: false,
      holdBodyPath: "",
      heldBodies: [],
    };
    window.confirm = (message) => {
      fixture.confirmations.push(message);
      return fixture.confirmResult;
    };
    window.setTimeout = (callback, ms, ...args) => {
      if (ms !== 30000) return nativeTimeout(callback, ms, ...args);
      const id = ++sequence;
      deadlines.set(id, () => callback(...args));
      return id;
    };
    window.clearTimeout = (id) => {
      if (!deadlines.delete(id)) nativeClear(id);
    };
    fixture.expire = () => {
      for (const [id, callback] of [...deadlines]) {
        deadlines.delete(id);
        callback();
      }
    };
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (
        fixture.holdBodyPath &&
        String(args[0]).split("?")[0] === fixture.holdBodyPath
      )
        return {
          ok: response.ok,
          status: response.status,
          text: () =>
            new Promise((resolve) =>
              fixture.heldBodies.push(() =>
                response.text().then(resolve, () => resolve("")),
              ),
            ),
        };
      return response;
    };
  });
  const reject = (route, status, code, message) =>
    route.fulfill({ status, json: { error: { code, message } } });
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      f.errors.push("External request: " + url.origin);
      return route.abort();
    }
    if (request.isNavigationRequest() && url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Synthetic navigation destination</title><p>Synthetic read-only destination</p>",
      });
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = request.method();
    f.requests.push({
      path,
      method,
      query: Object.fromEntries(url.searchParams),
    });
    if (method === "GET" && path === "/status")
      return route.fulfill({
        json: { initialized: true, version: "synthetic" },
      });
    if (method === "GET" && path === "/session")
      return route.fulfill({
        json: { user: actor(), csrf_token: "synthetic-csrf" },
      });
    if (method === "GET" && path === "/deployments/history")
      return route.fulfill({
        json: { items: [], total: 0, page: 1, page_size: 12 },
      });
    if (method === "GET" && path === "/audit/history") {
      const { details, ...summary } = f.audit;
      return route.fulfill({
        json: { items: [summary], total: 1, page: 1, page_size: 12 },
      });
    }
    if (method === "GET" && path === "/audit/" + f.audit?.id)
      return route.fulfill({ json: f.audit });

    if (method === "GET" && path === "/devices")
      return route.fulfill({ json: f.devices });
    if (method === "GET" && path === "/groups")
      return route.fulfill({ json: [...f.groups.values()] });
    if (method === "GET" && path.startsWith("/groups/")) {
      if (f.detailError)
        return reject(
          route,
          f.detailError,
          f.detailError === 404 ? "NOT_FOUND" : "UNAVAILABLE",
          "Synthetic review read failed",
        );
      const current = f.groups.get(path.slice(8));
      return current
        ? route.fulfill({ json: current })
        : reject(route, 404, "NOT_FOUND", "Group unavailable");
    }
    if (
      (method === "PUT" && path.startsWith("/groups/")) ||
      (method === "POST" && path === "/groups")
    ) {
      const body = request.postDataJSON();
      f.writes.push({ method, path, body: structuredClone(body) });
      if (f.nextError) {
        const next = f.nextError;
        f.nextError = null;
        return reject(route, ...next);
      }
      const old = method === "PUT" ? f.groups.get(path.slice(8)) : null;
      if (method === "PUT" && !old)
        return reject(route, 404, "NOT_FOUND", "Group unavailable");
      if (old && body.revision !== old.revision)
        return reject(
          route,
          409,
          "STALE_REVISION",
          "Group changed; review it before saving",
        );
      let saved = {
        ...body,
        id: old?.id || id(100 + f.commits),
        revision: old ? old.revision + 1 : 1,
        created_at: old?.created_at || "2026-09-27T00:00:00Z",
      };
      f.groups.set(saved.id, structuredClone(saved));
      f.commits++;
      if (f.holdWrite) await new Promise((resolve) => f.releases.push(resolve));
      const mode = f.replyMode;
      f.replyMode = null;
      if (mode === "drop") return route.abort("failed");
      if (mode === "invalid")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{",
        });
      if (mode === "wrong-id") saved = { ...saved, id: id(999) };
      if (mode === "wrong-revision")
        saved = { ...saved, revision: old?.revision ?? 0 };
      try {
        return await route.fulfill({ json: saved });
      } catch {
        return;
      }
    }
    f.errors.push("Unexpected " + method + " " + path);
    return reject(route, 500, "UNEXPECTED_FIXTURE_REQUEST", path);
  });
  async function page(user = actor()) {
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on("pageerror", (error) => f.errors.push(error.message));
    await page.addInitScript(
      ({ user }) => {
        window.testUser = user;
        window.testMode = location.search.includes("audit")
          ? "audit"
          : "groups";
      },
      { user },
    );
    await page.goto(
      origin +
        "/__group-admission-audit" +
        (options.mode === "audit" ? "?audit" : ""),
    );
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, options.theme || "light");
    await expect(
      page.getByRole("heading", {
        name: options.mode === "audit" ? "Audit log" : "Groups",
        exact: true,
      }),
    ).toBeVisible();
    return page;
  }
  return {
    context,
    page,
    close: async () => {
      for (const release of f.releases) release();
      await context.close();
    },
  };
}
async function edit(page) {
  await page
    .getByRole("button", { name: /Synthetic production group/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
const save = (page) =>
  page.getByRole("button", { name: "Save changes", exact: true }).click();
const review = (page) =>
  page.getByRole("region", { name: "Review group changes" });
const notices = (page) => page.evaluate(() => fixture.notices);
async function changeDescription(page, value = "My local description") {
  await page
    .getByRole("textbox", { name: "Description (optional)", exact: true })
    .fill(value);
}
async function check(name, run) {
  const started = Date.now();
  try {
    await run();
    results.push({ name, passed: true, duration_ms: Date.now() - started });
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: error.message,
      duration_ms: Date.now() - started,
    });
  }
  console.log((results.at(-1).passed ? "PASS " : "FAIL ") + name);
}

const admissionMessage =
  "These membership changes overlap an active canary. Wait for it to finish, or review its pause/cancel controls before trying again.";
const auditEvent = (details = {}) => ({
  id: id(200),
  actor_id: id(90),
  actor: "Synthetic operator",
  actor_kind: "user",
  action: "group.update",
  target: id(10),
  target_id: id(10),
  target_exists: true,
  target_kind: "group",
  target_name: "Synthetic production group",
  device_id: null,
  outcome: "success",
  created_at: "2026-09-27T00:00:00Z",
  request_id: null,
  details,
});
async function openAudit(page) {
  await page
    .getByRole("button", { name: "Details: Group updated", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Event details" }),
  ).toBeVisible();
}
async function expectDetail(page, label, value) {
  const row = page
    .locator(".audit-inspector > .audit-detail-list > div")
    .filter({
      has: page
        .locator("dt")
        .filter({ hasText: new RegExp("^" + label + "$") }),
    });
  await expect(row).toHaveCount(1);
  await expect(row.locator("dd")).toHaveText(value);
}
async function visual(page, width, theme, kind) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const result = await new AxeBuilder({ page }).analyze();
  scans.push({
    width,
    theme,
    kind,
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target),
    })),
  });
  expect(result.violations).toEqual([]);
  const filename = `${kind}-${width}-${theme}.png`;
  await page.screenshot({ path: resolve(output, filename) });
  screenshots.push(filename);
}
try {
  await check(
    "Active-canary conflict preserves local edits and reviewed revision with no retry or rollout action",
    async () => {
      const f = fixture(),
        app = await start(f);
      try {
        const page = await app.page();
        await edit(page);
        await changeDescription(page);
        await page.getByRole("checkbox", { name: /Synthetic edge 2/ }).check();
        f.nextError = [409, "ACTIVE_CANARY_OVERLAP", admissionMessage];
        await save(page);
        await expect(page.getByRole("alert")).toContainText(admissionMessage);
        await expect(review(page)).toHaveCount(0);
        await expect(
          page.getByRole("textbox", { name: "Description (optional)" }),
        ).toHaveValue("My local description");
        await expect(
          page.getByRole("checkbox", { name: /Synthetic edge 2/ }),
        ).toBeChecked();
        await expect(
          page.getByRole("button", { name: "Save changes", exact: true }),
        ).toBeEnabled();
        expect(f.writes).toHaveLength(1);
        expect(f.commits).toBe(0);
        expect(f.writes[0].body.revision).toBe(1);
        expect(
          f.requests.filter(
            (r) => r.method === "GET" && r.path === "/groups/" + id(10),
          ),
        ).toHaveLength(0);
        const link = page.getByRole("link", {
          name: "Review active deployments (opens in a new tab)",
          exact: true,
        });
        await expect(link).toHaveAttribute("target", "_blank");
        expect(await link.getAttribute("rel")).toContain("noopener");
        const href = await link.getAttribute("href");
        expect(href).toContain("/deployments");
        const opened = app.context.waitForEvent("page");
        await link.click();
        const popup = await opened;
        await expect.poll(() => popup.url()).toContain("/deployments");
        await expect(
          popup.getByRole("heading", { name: "Deployments", exact: true }),
        ).toBeVisible();
        const popupUrl = new URL(popup.url());
        expect(popupUrl.hash).toBe("#/deployments?status=active&page=1");
        expect(
          f.requests.filter((r) => r.path === "/deployments/history"),
        ).toHaveLength(1);
        expect(
          f.requests.find((r) => r.path === "/deployments/history").query,
        ).toMatchObject({ status: "active", page: "1", page_size: "12" });
        await popup.close();
        await expect(
          page.getByRole("textbox", { name: "Description (optional)" }),
        ).toHaveValue("My local description");
        expect(f.writes).toHaveLength(1);
        expect(await notices(page)).toEqual([]);
        f.nextError = [409, "ACTIVE_CANARY_OVERLAP", admissionMessage];
        await save(page);
        await expect(page.getByRole("alert")).toContainText(admissionMessage);
        expect(f.writes).toHaveLength(2);
        expect(f.writes[1].body).toEqual(f.writes[0].body);
        expect(f.errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Audit revisions include legacy zero and exact maximum-safe decimal values without duplicate technical rows",
    async () => {
      for (const pair of [
        [0, 1],
        [9007199254740990, 9007199254740991],
      ]) {
        const f = fixture();
        f.audit = auditEvent({
          previous_group_revision: pair[0],
          group_revision: pair[1],
        });
        const app = await start(f, { mode: "audit" });
        try {
          const page = await app.page(actor("viewer"));
          await openAudit(page);
          await expectDetail(page, "Previous group revision", String(pair[0]));
          await expectDetail(page, "Group revision", String(pair[1]));
          await page.getByText("Technical details", { exact: true }).click();
          await expect(
            page
              .locator(".audit-technical")
              .getByText("Previous group revision", { exact: true }),
          ).toHaveCount(0);
          await expect(
            page
              .locator(".audit-technical")
              .getByText("Group revision", { exact: true }),
          ).toHaveCount(0);
          expect(f.requests.filter((r) => r.method !== "GET")).toEqual([]);
          expect(f.errors).toEqual([]);
        } finally {
          await app.close();
        }
      }
    },
  );
  await check(
    "Legacy and partial audit metadata say Not recorded rather than inventing zero or a prior revision",
    async () => {
      for (const details of [
        {},
        { previous_group_revision: 0 },
        { group_revision: 21 },
      ]) {
        const f = fixture();
        f.audit = auditEvent(details);
        const app = await start(f, { mode: "audit" });
        try {
          const page = await app.page();
          await openAudit(page);
          await expectDetail(
            page,
            "Previous group revision",
            details.previous_group_revision === undefined
              ? "Not recorded"
              : String(details.previous_group_revision),
          );
          await expectDetail(
            page,
            "Group revision",
            details.group_revision === undefined
              ? "Not recorded"
              : String(details.group_revision),
          );
          expect(f.requests.filter((r) => r.method !== "GET")).toEqual([]);
          expect(f.errors).toEqual([]);
        } finally {
          await app.close();
        }
      }
    },
  );
  await check(
    "Unsafe audit revision responses fail closed instead of rounding an audit value",
    async () => {
      const f = fixture();
      f.audit = auditEvent({
        previous_group_revision: 9007199254740991,
        group_revision: 9007199254740992,
      });
      const app = await start(f, { mode: "audit" });
      try {
        const page = await app.page();
        await openAudit(page);
        await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
        await expect(
          page
            .locator(".audit-inspector dt")
            .filter({ hasText: /^Group revision$/ }),
        ).toHaveCount(0);
        expect(f.requests.filter((r) => r.method !== "GET")).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Conflict controls and audit revision details stay readable in narrow light and dark layouts",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"])
          for (const mode of ["groups", "audit"]) {
            const f = fixture();
            f.audit = auditEvent({
              previous_group_revision: 9007199254740990,
              group_revision: 9007199254740991,
            });
            const app = await start(f, {
              mode,
              viewport: { width, height: 900 },
              theme,
            });
            try {
              const page = await app.page();
              if (mode === "groups") {
                await edit(page);
                await changeDescription(page);
                await page
                  .getByRole("checkbox", { name: /Synthetic edge 2/ })
                  .check();
                f.nextError = [409, "ACTIVE_CANARY_OVERLAP", admissionMessage];
                await save(page);
                await expect(
                  page.getByRole("link", { name: "Review active deployments" }),
                ).toBeVisible();
                await expect(
                  page.getByRole("button", {
                    name: "Close dialog",
                    exact: true,
                  }),
                ).toBeInViewport();
              } else {
                await openAudit(page);
                await expectDetail(page, "Group revision", "9007199254740991");
              }
              await visual(
                page,
                width,
                theme,
                mode === "groups" ? "group-admission" : "group-audit",
              );
              expect(f.errors).toEqual([]);
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
      "Actual Groups/GroupEditor, AuditLog and new-tab App deployment destination in Chromium with intercepted synthetic API requests only. Does not execute server canary admission, audit persistence, export or live rollout actions.",
    passed:
      results.length === 5 &&
      results.every((r) => r.passed) &&
      scans.length === 8 &&
      scans.every((r) => !r.violations.length),
    results,
    accessibility: scans,
    screenshots,
    loaded_source_sha256: loadedSource,
    current_source_sha256: current,
    source_changed_during_run: Object.keys(current).filter(
      (file) => current[file] !== loadedSource[file],
    ),
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (!report.passed) process.exitCode = 1;
}
