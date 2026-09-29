// Actual App, isolated synthetic transport. No preview accounts or mutations.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_SIDEBAR_OUTPUT || ".local/sidebar-component",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "src/App.tsx",
  "src/api.ts",
  "src/ui.tsx",
  "src/Editor.tsx",
  "src/styles.css",
  "src/Fleet.tsx",
  "src/AccountMenu.tsx",
  "src/SignOutDialog.tsx",
  "src/signOutSession.ts",
  "src/authRequests.ts",
  "src/account-menu.css",
  "src/appearance.ts",
  "tests/sidebar-browser.mjs",
];
const hashSources = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        `dashboard/${file}`,
        createHash("sha256")
          .update(await readFile(resolve(dashboard, file)))
          .digest("hex"),
      ]),
    ),
  );
const source_start_sha256 = await hashSources();
const virtual = "\0virtual:sidebar-fixture";
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const selectedPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: selectedPort,
    strictPort: true,
    proxy: {},
    hmr: false,
  },
  plugins: [
    {
      name: "sidebar-independent-fixture",
      resolveId(id) {
        if (id === "virtual:sidebar-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__sidebar-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic sidebar verification</title></head><body><div id="root"></div><script type="module">import "virtual:sidebar-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  pipeline: "22222222-2222-4222-8222-222222222222",
  device: "33333333-3333-4333-8333-333333333333",
  version: "44444444-4444-4444-8444-444444444444",
  missing: "55555555-5555-4555-8555-555555555555",
};
const user = {
  id: ids.user,
  email: "sidebar@example.test",
  name: "Synthetic operator",
  role: "admin",
  enabled: true,
  revision: 1,
};
const created = "2026-09-26T12:00:00Z";
const device = {
  id: ids.device,
  name: "Synthetic unassigned device",
  os: "windows",
  arch: "amd64",
  agent_version: "0.1.0-dev",
  vector_version: "0.58.0",
  configuration_mode: "restricted",
  status: "unmanaged",
  labels: {},
  desired_generation: 0,
  reported_generation: 0,
  apply_state: "unmanaged",
  sync_paused: false,
  pause_acknowledged: false,
  created_at: created,
};
const pipeline = {
  id: ids.pipeline,
  name: "Synthetic sidebar pipeline",
  description: "Isolated fixture, never deployed.",
  revision: 1,
  archived: false,
  archived_at: null,
  created_at: created,
  updated_at: created,
  config: {
    sources: { sample: { type: "demo_logs", format: "json" } },
    sinks: { discard: { type: "blackhole", inputs: ["sample"] } },
  },
  graph: { nodes: [], edges: [] },
};
function event(index, extra) {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    actor_id: ids.user,
    actor: user.name,
    actor_kind: "user",
    action: "configuration.create",
    target: ids.pipeline,
    target_id: ids.pipeline,
    target_kind: "configuration",
    target_exists: true,
    target_name: pipeline.name,
    device_id: null,
    outcome: "success",
    created_at: created,
    request_id: null,
    ...extra,
  };
}
const activity = [
  event(1, { target_name: "Live pipeline target" }),
  event(2, {
    action: "configuration.publish",
    target: ids.version,
    target_name: "Published pipeline parent",
  }),
  event(3, {
    target_id: ids.missing,
    target_name: "Deleted pipeline target",
    target_exists: false,
  }),
  event(4, {
    target_id: "javascript:alert(1)",
    target_name: "Malformed target",
    target_exists: true,
    actor_kind: "unknown",
  }),
  event(5, {
    action: "future.action",
    target_id: ids.pipeline,
    target_kind: "unknown",
    target_name: "Unknown target kind",
    target_exists: true,
    actor_kind: "device",
    actor_id: ids.device,
    actor: device.name,
  }),
];
let signedIn = true;
let failLogout = false,
  holdLogout = false;
const pendingLogout = [];
const requests = [],
  unexpected = [],
  errors = [],
  results = [],
  accessibility = [],
  measurements = [];
page.on("pageerror", (error) => errors.push(error.message));
await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== origin) {
    unexpected.push(`External ${url.origin}`);
    return route.abort();
  }
  if (url.pathname.startsWith("/help/"))
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><title>Synthetic help destination</title><h1>Synthetic documentation</h1></html>',
    });
  if (!url.pathname.startsWith("/api/v1/")) return route.continue();
  const path = url.pathname.slice(7),
    method = request.method();
  requests.push({ method, path });
  const reply = (json, status = 200) => route.fulfill({ status, json });
  if (path === "/logout" && method === "POST") {
    if (request.headers()["x-csrf-token"] !== "synthetic-session-token") {
      unexpected.push("Logout did not carry fixture CSRF");
      return reply(
        { error: { code: "FORBIDDEN", message: "Fixture CSRF mismatch" } },
        403,
      );
    }
    const complete = () => {
      if (failLogout)
        return reply(
          {
            error: {
              code: "SYNTHETIC_FAILURE",
              message: "Synthetic sign-out unavailable",
            },
          },
          503,
        );
      signedIn = false;
      return reply({ ok: true });
    };
    if (holdLogout) {
      pendingLogout.push(complete);
      return;
    }
    return complete();
  }
  if (path === "/login" && method === "POST") {
    const body = request.postDataJSON();
    if (body.email !== user.email || typeof body.password !== "string") {
      unexpected.push("Fixture login has no valid synthetic credentials");
      return reply(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Fixture credentials missing",
          },
        },
        401,
      );
    }
    signedIn = true;
    return reply({ user, csrf_token: "synthetic-session-token" });
  }
  if (method !== "GET") {
    unexpected.push(`${method} ${path}`);
    return reply(
      {
        error: {
          code: "UNEXPECTED_MUTATION",
          message: "Synthetic fixture rejects mutations",
        },
      },
      500,
    );
  }
  if (path === "/status")
    return reply({ initialized: true, version: "synthetic" });
  if (path === "/session")
    return signedIn
      ? reply({ user, csrf_token: "synthetic-session-token" })
      : reply(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "Synthetic session ended",
            },
          },
          401,
        );
  if (path === "/users") return reply([user]);
  if (path === "/settings")
    return reply({
      instance_name: "Synthetic workspace label must not appear in the rail",
    });
  if (path === "/mfa") return reply({ enabled: false });
  if (path === "/account/sessions") return reply({ sessions: [] });
  if (path === "/overview")
    return reply({
      devices_total: 1,
      devices_online: 0,
      configurations_total: 1,
      deployments_active: 0,
      issues_open: 0,
      devices: [device],
      recent_activity: activity,
    });
  if (path === "/devices") return reply([device]);
  if (path === "/configurations/library")
    return reply({
      items: [
        {
          ...pipeline,
          config: undefined,
          graph: undefined,
          component_counts: { sources: 1, transforms: 0, sinks: 1 },
          latest_version: null,
        },
      ],
      total: 1,
      page: 1,
      page_size: 12,
    });
  if (path === `/configurations/${ids.pipeline}`) return reply(pipeline);
  if (path === `/configurations/${ids.pipeline}/history`)
    return reply({
      items: [],
      total: 0,
      page: 1,
      page_size: Number(url.searchParams.get("page_size")),
      kind: "versions",
    });
  unexpected.push(`${method} ${path}`);
  return reply(
    {
      error: {
        code: "UNEXPECTED_REQUEST",
        message: "Unexpected synthetic transport request",
      },
    },
    500,
  );
});
async function check(name, run) {
  const began = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - began });
  console.log("PASS", name);
}
const sidebar = page.locator("#main-navigation");
const accountMenu = () => page.getByRole("menu");
const accountTrigger = () =>
  page.getByRole("button", {
    name: "Your account",
    exact: true,
    includeHidden: true,
  });
async function openAccount() {
  await expect(accountTrigger()).toBeAttached();
  if (!(await accountTrigger().isVisible()))
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .click();
  if (!(await accountMenu().isVisible())) await accountTrigger().click();
  await expect(accountMenu()).toBeVisible();
}
async function chooseAppearance(name) {
  await openAccount();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(
    page.getByRole("menuitemradio", { name, exact: true }),
  ).toHaveAttribute("aria-checked", "true");
}
const collapse = () =>
  page.getByRole("button", { name: "Collapse sidebar", exact: true });
const expand = () =>
  page.getByRole("button", { name: "Expand sidebar", exact: true });
async function compact(value) {
  const target = value ? collapse() : expand();
  if (await target.isVisible()) {
    await sidebar.hover({ position: { x: 20, y: 120 } });
    await expect(target).toHaveCSS("opacity", "1");
    await target.click();
  }
  await expect(value ? expand() : collapse()).toBeVisible();
}
async function edgeGeometry(control, label) {
  const rail = await sidebar.boundingBox();
  const button = await control.boundingBox();
  expect(
    Math.abs(button.x + button.width / 2 - rail.x - rail.width),
  ).toBeLessThanOrEqual(1);
  expect(button.width).toBeGreaterThanOrEqual(24);
  expect(button.height).toBeGreaterThanOrEqual(24);
  const outside = {
    x: rail.x + rail.width + 8,
    y: button.y + button.height / 2,
  };
  expect(
    await control.evaluate(
      (element, point) =>
        element.contains(document.elementFromPoint(point.x, point.y)),
      outside,
    ),
  ).toBe(true);
  measurements.push({ label, rail, button, outside_hit_test: true });
  return outside;
}
async function noOverflow() {
  const measure = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  measurements.push(measure);
  expect(measure.scrollWidth).toBeLessThanOrEqual(measure.width + 1);
}
async function axe(label, selector) {
  let scan = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21aa",
  ]);
  if (selector) scan = scan.include(selector);
  const result = await scan.analyze();
  accessibility.push({
    label,
    violations: result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  });
  expect(result.violations, label).toEqual([]);
}
let failure;
try {
  await page.goto(origin + "/__sidebar-fixture#/overview");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await check(
    "desktop edge toggle hides at rest, reveals on hover or keyboard focus and preserves both widths and named controls",
    async () => {
      await expect(collapse()).toBeVisible();
      await expect(
        sidebar.getByText(
          "Synthetic workspace label must not appear in the rail",
          { exact: true },
        ),
      ).toHaveCount(0);
      const expanded = await sidebar.boundingBox();
      expect(expanded.width).toBeGreaterThanOrEqual(180);
      const brand = sidebar.getByRole("button", {
        name: "Vectory overview",
        exact: true,
      });
      await brand.focus();
      await page.mouse.move(1200, 300);
      await expect(collapse()).toHaveCSS("opacity", "0");
      await expect(collapse()).toHaveCSS("pointer-events", "none");
      await sidebar.hover({ position: { x: 20, y: 120 } });
      await expect(collapse()).toHaveCSS("opacity", "1");
      await expect(collapse()).toHaveAttribute("aria-expanded", "true");
      await page.screenshot({
        path: resolve(output, "sidebar-edge-expanded.png"),
        animations: "disabled",
      });
      let edge = await edgeGeometry(collapse(), "expanded page-facing edge");
      await page.mouse.click(edge.x, edge.y);
      await expect(expand()).toHaveAttribute("aria-expanded", "false");
      await brand.focus();
      await page.mouse.move(1200, 300);
      await expect(expand()).toHaveCSS("opacity", "0");
      await sidebar.hover({ position: { x: 20, y: 120 } });
      await expect(expand()).toHaveCSS("opacity", "1");
      edge = await edgeGeometry(expand(), "collapsed page-facing edge");
      await page.mouse.click(edge.x, edge.y);
      await expect(collapse()).toHaveAttribute("aria-expanded", "true");

      // A fixed edge control must remain clickable when a short viewport scrolls the rail.
      await page.setViewportSize({ width: 1440, height: 240 });
      await sidebar.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(
        await sidebar.evaluate((element) => element.scrollTop),
      ).toBeGreaterThan(0);
      await sidebar.hover({ position: { x: 20, y: 120 } });
      await expect(collapse()).toHaveCSS("opacity", "1");
      await edgeGeometry(collapse(), "scrolled rail page-facing edge");
      await page.setViewportSize({ width: 1440, height: 960 });
      await sidebar.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.mouse.move(1200, 300);
      await brand.focus();
      await expect(collapse()).toHaveCSS("opacity", "0");
      await page.keyboard.press("Tab");
      await expect(collapse()).toBeFocused();
      await expect(collapse()).toHaveCSS("opacity", "1");
      await page.keyboard.press("Enter");
      await expect(expand()).toBeFocused();
      await expect(expand()).toHaveCSS("opacity", "1");
      await expect
        .poll(async () => Math.round((await sidebar.boundingBox()).width))
        .toBe(68);
      for (const name of [
        "Overview",
        "Pipelines",
        "Devices",
        "Activity",
        "Find a page",
        "Your account",
      ]) {
        const control = sidebar.getByRole("button", { name, exact: true });
        await expect(control).toBeVisible();
        expect(await control.getAttribute("title")).toBeTruthy();
      }
      await expect(
        sidebar.getByRole("link", { name: "Help center (opens in a new tab)" }),
      ).toHaveCount(0);
      await expect(
        sidebar.getByRole("button", { name: "Overview", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await noOverflow();
      await axe("collapsed desktop sidebar", "#main-navigation");
      await page.screenshot({
        path: resolve(output, "sidebar-desktop-light.png"),
        animations: "disabled",
      });
    },
  );
  await check(
    "explicit collapse preference persists across reload and route changes; icon actions remain usable",
    async () => {
      expect(
        await page.evaluate(() =>
          localStorage.getItem("vectory-sidebar-collapsed"),
        ),
      ).toBe("true");
      await page.reload();
      await expect(expand()).toBeVisible();
      await sidebar
        .getByRole("button", { name: "Pipelines", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", { name: "Pipelines", exact: true }),
      ).toBeVisible();
      await expect(expand()).toBeVisible();
      await sidebar
        .getByRole("button", { name: "Find a page", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        sidebar.getByRole("button", { name: "Find a page", exact: true }),
      ).toBeFocused();
      await sidebar
        .getByRole("button", { name: "Your account", exact: true })
        .click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        sidebar.getByRole("button", { name: "Your account", exact: true }),
      ).toBeFocused();
      await compact(false);
      expect(
        await page.evaluate(() =>
          localStorage.getItem("vectory-sidebar-collapsed"),
        ),
      ).toBe("false");
      await page.reload();
      await expect(collapse()).toBeVisible();
      await compact(true);
    },
  );
  await check(
    "899px keeps a usable desktop rail; mobile opens complete labels independently and contains keyboard focus",
    async () => {
      await sidebar
        .getByRole("button", { name: "Overview", exact: true })
        .click();
      await page.setViewportSize({ width: 899, height: 900 });
      await expect(expand()).toBeVisible();
      await noOverflow();
      await page.setViewportSize({ width: 375, height: 812 });
      await expect(sidebar).not.toBeVisible();
      const toggle = page.getByRole("button", {
        name: "Toggle navigation",
        exact: true,
      });
      await toggle.click();
      await expect(sidebar).toBeVisible();
      await expect
        .poll(() =>
          sidebar.evaluate((element) =>
            element.contains(document.activeElement),
          ),
        )
        .toBe(true);
      for (const name of ["Overview", "Pipelines", "Devices", "Activity"])
        await expect(
          sidebar
            .locator(".nav-label")
            .filter({ hasText: new RegExp(`^${name}$`) }),
        ).toBeVisible();
      await expect(collapse()).not.toBeVisible();
      await expect(expand()).not.toBeVisible();
      for (let n = 0; n < 15; n++) {
        await page.keyboard.press("Tab");
        expect(
          await sidebar.evaluate((element) =>
            element.contains(document.activeElement),
          ),
        ).toBe(true);
      }
      for (let n = 0; n < 15; n++) {
        await page.keyboard.press("Shift+Tab");
        expect(
          await sidebar.evaluate((element) =>
            element.contains(document.activeElement),
          ),
        ).toBe(true);
      }
      await noOverflow();
      await axe("mobile open navigation light");
      await page.screenshot({
        path: resolve(output, "sidebar-mobile-light.png"),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(sidebar).not.toBeVisible();
      await expect(toggle).toBeFocused();
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "dark"),
      );
      await toggle.click();
      await expect(
        sidebar.getByRole("button", { name: "Close navigation", exact: true }),
      ).toBeFocused();
      await axe("mobile open navigation dark, ordinary motion preference");
      await page.screenshot({
        path: resolve(output, "sidebar-mobile-dark.png"),
        animations: "disabled",
      });
      await sidebar
        .getByRole("button", { name: "Pipelines", exact: true })
        .click();
      await expect(sidebar).not.toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Pipelines", exact: true }),
      ).toBeVisible();
      await noOverflow();
      await page.setViewportSize({ width: 1440, height: 960 });
      await expect(expand()).toBeVisible();
      expect(
        await page.evaluate(() =>
          localStorage.getItem("vectory-sidebar-collapsed"),
        ),
      ).toBe("true");
      await axe("collapsed desktop sidebar dark", "#main-navigation");
      await page.screenshot({
        path: resolve(output, "sidebar-desktop-dark.png"),
        animations: "disabled",
      });
    },
  );
  await check(
    "mobile account menu retains the drawer and handles Escape before it; search keeps its dialog handoff",
    async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      const toggle = page.getByRole("button", {
        name: "Toggle navigation",
        exact: true,
      });
      await toggle.click();
      const account = sidebar.getByRole("button", {
        name: "Your account",
        exact: true,
      });
      await account.click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(sidebar).toBeVisible();
      expect(
        await page.locator(".app-main").evaluate((element) => element.inert),
      ).toBe(true);
      await page
        .getByRole("menuitemradio", { name: "Dark", exact: true })
        .focus();
      await page.keyboard.press("ArrowDown");
      expect(
        await page
          .getByRole("menu")
          .evaluate((element) => element.contains(document.activeElement)),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(sidebar).toBeVisible();
      await expect(account).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(sidebar).not.toBeVisible();
      await expect(toggle).toBeFocused();
      await toggle.click();
      await account.click();
      await page.keyboard.press("Control+k");
      await expect(
        page.getByRole("dialog", { name: "Find a page", exact: true }),
      ).toBeVisible();
      await expect(accountMenu()).toHaveCount(0);
      await expect(sidebar).not.toBeVisible();
      await page.keyboard.press("Escape");
      await expect(toggle).toBeFocused();
      await toggle.click();
      await sidebar
        .getByRole("button", { name: "Find a page", exact: true })
        .click();
      const search = page.getByRole("dialog", {
        name: "Find a page",
        exact: true,
      });
      await expect(search).toBeVisible();
      await expect(sidebar).not.toBeVisible();
      await page.keyboard.press("Escape");
      await expect(toggle).toBeFocused();
      await toggle.click();
      await page.keyboard.press("Control+k");
      await expect(search).toBeVisible();
      await expect(sidebar).not.toBeVisible();
      await page.keyboard.press("Escape");
      await expect(toggle).toBeFocused();
      await page.setViewportSize({ width: 1440, height: 960 });
    },
  );
  await check(
    "editor defaults compact, honors an explicit expansion and resizes its live canvas without writes or lost nodes",
    async () => {
      await page.evaluate(() =>
        localStorage.removeItem("vectory-sidebar-collapsed"),
      );
      await page.goto(
        origin + `/__sidebar-fixture#/configurations/${ids.pipeline}`,
      );
      await expect(expand()).toBeVisible();
      await expect(page.locator(".react-flow__node")).toHaveCount(2);
      await expect(page.locator(".react-flow__edge")).toHaveCount(1);
      const graph = page.locator(".editor-graph");
      const before = await graph.boundingBox();
      await compact(false);
      await expect
        .poll(async () => (await graph.boundingBox()).width)
        .toBeLessThan(before.width - 100);
      await expect(page.locator(".react-flow__node")).toHaveCount(2);
      await expect(page.locator(".react-flow__edge")).toHaveCount(1);
      await noOverflow();
      await page.reload();
      await expect(collapse()).toBeVisible();
      await expect(page.locator(".react-flow__node")).toHaveCount(2);
      await compact(true);
      await expect
        .poll(async () => (await graph.boundingBox()).width)
        .toBeGreaterThanOrEqual(before.width - 2);
      await page.setViewportSize({ width: 899, height: 900 });
      await noOverflow();
      await page.setViewportSize({ width: 375, height: 812 });
      await noOverflow();
      expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
    },
  );
  await check(
    "activity names use only existing typed destinations while verbs keep exact audit links",
    async () => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(origin + "/__sidebar-fixture#/overview");
      const rows = page.locator(".fleet-activity-list li");
      await expect(rows).toHaveCount(5);
      await expect(
        rows
          .nth(0)
          .getByRole("link", { name: "Live pipeline target", exact: true }),
      ).toHaveAttribute("href", `#/configurations/${ids.pipeline}`);
      await expect(
        rows.nth(1).getByRole("link", {
          name: "Published pipeline parent",
          exact: true,
        }),
      ).toHaveAttribute("href", `#/configurations/${ids.pipeline}`);
      for (const [index, name] of [
        [2, "Deleted pipeline target"],
        [3, "Malformed target"],
        [4, "Unknown target kind"],
      ]) {
        await expect(
          rows.nth(index).locator(".fleet-activity-meta"),
        ).toContainText(name);
        await expect(
          rows.nth(index).getByRole("link", { name, exact: true }),
        ).toHaveCount(0);
      }
      for (let index = 0; index < activity.length; index++)
        await expect(
          rows.nth(index).locator("a.fleet-activity-link"),
        ).toHaveAttribute("href", `#/audit/${activity[index].id}?page=1`);
      await expect(
        rows.nth(0).getByRole("link", { name: user.name, exact: true }),
      ).toHaveAttribute("href", `#/audit?actor_id=${ids.user}&page=1`);
      await expect(
        rows.nth(3).getByRole("link", { name: user.name, exact: true }),
      ).toHaveCount(0);
      await expect(
        rows.nth(4).getByRole("link", { name: device.name, exact: true }),
      ).toHaveAttribute("href", `#/devices/${ids.device}`);
      expect(
        await page.locator('a[href^="javascript:"],a[href^="data:"]').count(),
      ).toBe(0);
      expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
      await noOverflow();
    },
  );
  await check(
    "account menu anchors above expanded and compact triggers with named keyboard choices and contained mobile layout",
    async () => {
      await page.setViewportSize({ width: 1440, height: 960 });
      for (const collapsed of [false, true]) {
        await compact(collapsed);
        await accountTrigger().focus();
        await page.keyboard.press("Enter");
        await expect(accountMenu()).toBeVisible();
        const trigger = await accountTrigger().boundingBox(),
          menu = await accountMenu().boundingBox();
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(1440);
        expect(menu.y + menu.height).toBeLessThanOrEqual(trigger.y + 1);
        expect(Math.abs(menu.x - trigger.x)).toBeLessThanOrEqual(40);
        measurements.push({
          label: collapsed
            ? "compact account anchor"
            : "expanded account anchor",
          trigger,
          menu,
        });
        for (const name of ["Light", "Dark", "Auto"])
          await expect(
            page.getByRole("menuitemradio", { name, exact: true }),
          ).toBeVisible();
        await expect(
          page.getByRole("menuitem", { name: "Sign out", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(accountTrigger()).toBeFocused();
      }
      await chooseAppearance("Light");
      await page.keyboard.press("ArrowRight");
      await expect(
        page.getByRole("menuitemradio", { name: "Dark", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("ArrowLeft");
      await expect(
        page.getByRole("menuitemradio", { name: "Light", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await axe("desktop account menu light");
      await page.screenshot({
        path: resolve(output, "account-menu-desktop-light.png"),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 375, height: 812 });
      await chooseAppearance("Dark");
      const menu = await accountMenu().boundingBox();
      expect(menu.x).toBeGreaterThanOrEqual(0);
      expect(menu.x + menu.width).toBeLessThanOrEqual(375);
      await noOverflow();
      await axe("mobile account menu dark");
      await page.screenshot({
        path: resolve(output, "account-menu-mobile-dark.png"),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1440, height: 960 });
    },
  );
  await check(
    "Light Dark and Auto preserve explicit preference and follow live system appearance only in Auto",
    async () => {
      await page.evaluate(() => localStorage.removeItem("vectory-theme"));
      await page.emulateMedia({ colorScheme: "dark" });
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      expect(
        await page.evaluate(() => localStorage.getItem("vectory-theme")),
      ).toBe(null);
      await openAccount();
      await expect(
        page.getByRole("menuitemradio", { name: "Auto", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await chooseAppearance("Light");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      expect(
        await page.evaluate(() => localStorage.getItem("vectory-theme")),
      ).toBe("light");
      await page.emulateMedia({ colorScheme: "light" });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await chooseAppearance("Dark");
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await chooseAppearance("Auto");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      expect(
        await page.evaluate(() => localStorage.getItem("vectory-theme")),
      ).toBe("auto");
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      expect(
        await page.evaluate(() => localStorage.getItem("vectory-theme")),
      ).toBe("auto");
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    },
  );
  await check(
    "documentation and sign-out retain draft guards; a failed sign-out checks the session before a deliberate retry",
    async () => {
      await page.goto(
        origin + `/__sidebar-fixture#/configurations/${ids.pipeline}`,
      );
      await page.getByRole("button", { name: "Code", exact: true }).click();
      const code = page.getByRole("textbox", {
        name: "Vector configuration code",
        exact: true,
      });
      const pending = '{"unsaved-account-menu":';
      await code.fill(pending);
      await openAccount();
      await expect(
        page.getByRole("menuitem", { name: "People & security", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("menuitem", {
          name: "Vector documentation (opens in a new tab)",
          exact: true,
        }),
      ).toHaveCount(0);
      const documentation = page.getByRole("menuitem", {
        name: "Vectory documentation (opens in a new tab)",
        exact: true,
      });
      await expect(documentation).toHaveAttribute("target", "_blank");
      expect(await documentation.getAttribute("rel")).toMatch(/noopener/);
      const href = await documentation.getAttribute("href");
      expect(href).toContain("/help/");
      expect(href).toContain(`pipeline=${ids.pipeline}`);
      const popupWait = page.waitForEvent("popup");
      await documentation.click();
      const popup = await popupWait;
      await expect(
        popup.getByRole("heading", {
          name: "Synthetic documentation",
          exact: true,
        }),
      ).toBeVisible();
      expect(await popup.evaluate(() => opener === null)).toBe(true);
      await popup.close();
      expect(await code.innerText()).toBe(pending);
      for (const name of ["Settings", "Sign out"]) {
        await openAccount();
        let rejected = false;
        page.once("dialog", async (dialog) => {
          expect(dialog.type()).toBe("confirm");
          rejected = true;
          await dialog.dismiss();
        });
        await page.getByRole("menuitem", { name, exact: true }).click();
        // Sign-out asks only through the draft guard; declining keeps everything.
        await expect.poll(() => rejected).toBe(true);
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
        expect(await code.innerText()).toBe(pending);
        await expect(page).toHaveURL(
          new RegExp(`#/configurations/${ids.pipeline}$`),
        );
        expect(requests.filter((request) => request.method !== "GET")).toEqual(
          [],
        );
      }
      await page
        .getByRole("button", { name: "Discard code changes", exact: true })
        .click();
      await openAccount();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
      await expect(page).toHaveURL(/#\/settings$/);
      await page
        .getByRole("navigation", { name: "Settings sections", exact: true })
        .getByRole("button", { name: "People & security", exact: true })
        .click();
      await expect(page).toHaveURL(/#\/users$/);
      await page.setViewportSize({ width: 375, height: 812 });
      expect(requests.filter((request) => request.method !== "GET")).toEqual(
        [],
      );
      // No draft: sign-out starts at once. A slow one shows its progress; a
      // failure checks the session itself before offering a deliberate retry.
      failLogout = true;
      holdLogout = true;
      await openAccount();
      await page
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .click();
      await expect.poll(() => pendingLogout.length).toBe(1);
      expect(
        requests.filter((request) => request.path === "/logout"),
      ).toHaveLength(1);
      const progress = page.getByRole("alertdialog", { name: "Signing out…" });
      await expect(progress).toBeVisible();
      await expect(
        progress.getByRole("button", { name: "Stop waiting", exact: true }),
      ).toBeEnabled();
      await pendingLogout.shift()();
      const retry = page.getByRole("alertdialog", {
        name: "Couldn't sign out",
      });
      await expect(retry).toBeVisible();
      await expect(retry).toContainText("Your session is still active.");
      await expect(
        retry.getByRole("button", { name: "Try again", exact: true }),
      ).toBeFocused();
      expect(signedIn).toBe(true);
      expect(
        requests.filter((request) => request.path === "/logout"),
      ).toHaveLength(1);
      await axe("mobile sign-out retry");
      await page.screenshot({
        path: resolve(output, "account-signout-retry-mobile.png"),
        animations: "disabled",
      });
      await retry
        .getByRole("button", { name: "Keep working", exact: true })
        .click();
      await expect(retry).toHaveCount(0);
      await expect(accountTrigger()).toBeAttached();
      expect(signedIn).toBe(true);
      failLogout = false;
      await openAccount();
      await page
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .click();
      await expect.poll(() => pendingLogout.length).toBe(1);
      expect(
        requests.filter((request) => request.path === "/logout"),
      ).toHaveLength(2);
      expect(signedIn).toBe(true);
      await pendingLogout.shift()();
      holdLogout = false;
      await expect(
        page.getByRole("heading", { name: "Sign in to Vectory", exact: true }),
      ).toBeVisible();
      expect(signedIn).toBe(false);
      // The account just signed out is offered again; the password is next.
      await expect(
        page.getByLabel("Email address", { exact: true }),
      ).toHaveValue(user.email);
      await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
      await expect(accountTrigger()).toHaveCount(0);
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe(
        "hidden",
      );
      await page.getByLabel("Email address", { exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
      await page.getByLabel("Email address", { exact: true }).fill(user.email);
      await page
        .getByLabel("Password", { exact: true })
        .fill("synthetic-unused-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Toggle navigation", exact: true }),
      ).toBeVisible();
      await expect(sidebar).not.toBeVisible();
      expect(signedIn).toBe(true);
      expect(
        requests
          .filter((request) => request.method !== "GET")
          .map(({ method, path }) => ({ method, path })),
      ).toEqual([
        { method: "POST", path: "/logout" },
        { method: "POST", path: "/logout" },
        { method: "POST", path: "/login" },
      ]);
      await page.setViewportSize({ width: 1440, height: 960 });
      await expect(accountTrigger()).toBeVisible();
    },
  );
  await check(
    "unavailable preference storage does not prevent collapsing or expanding the current page",
    async () => {
      await page.addInitScript(() => {
        const get = Storage.prototype.getItem,
          set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (key) {
          if (key === "vectory-sidebar-collapsed")
            throw new DOMException(
              "Synthetic blocked preference",
              "SecurityError",
            );
          return get.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
          if (key === "vectory-sidebar-collapsed")
            throw new DOMException(
              "Synthetic blocked preference",
              "SecurityError",
            );
          return set.call(this, key, value);
        };
      });
      await page.reload();
      await expect(collapse()).toBeVisible();
      await compact(true);
      await compact(false);
    },
  );
  expect(await hashSources()).toEqual(source_start_sha256);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = await hashSources();
  const source_changes = sourceFiles.filter(
    (file) =>
      source_start_sha256[`dashboard/${file}`] !==
      source_sha256[`dashboard/${file}`],
  );
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Actual App and editor with isolated synthetic transport, including one fixture-only sign-out/sign-in. No preview sessions, account mutation or native activation. Accessibility applies to the explicitly scanned views.",
        passed: !failure,
        results,
        accessibility,
        measurements,
        requests,
        errors,
        unexpected,
        source_sha256,
        source_start_sha256,
        source_end_sha256: source_sha256,
        source_changes,
        ...(failure
          ? {
              failure: failure.message,
              active_element_at_failure: await page.evaluate(() =>
                document.activeElement?.outerHTML.slice(0, 1000),
              ),
              navigation_controls_at_failure: await sidebar
                .locator("button")
                .evaluateAll((elements) =>
                  elements.map((element) => ({
                    label: element.getAttribute("aria-label"),
                    class: element.className,
                    display: getComputedStyle(element).display,
                    visibility: getComputedStyle(element).visibility,
                    box: element.getBoundingClientRect().toJSON(),
                  })),
                ),
            }
          : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await vite.close();
  console.log(
    "Evidence: " + relative(repository, resolve(output, "report.json")),
  );
}
