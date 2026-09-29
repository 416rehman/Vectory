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
  process.env.VECTORY_PAGE_FINDER_OUTPUT || ".local/page-finder",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:page-finder-fixture";
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
// Test cases follow the isolated transport below.
const selectedPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const vite = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
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
      name: "page-finder-independent-fixture",
      resolveId(id) {
        if (id === "virtual:page-finder-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__page-finder-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic page finder verification</title></head><body><div id="root"></div><script type="module">import "virtual:page-finder-fixture";</script></body></html>',
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
  if (["/groups", "/policies", "/tokens", "/releases"].includes(path))
    return reply([]);
  if (
    [
      "/deployments/history",
      "/issues/history",
      "/issues/groups",
      "/audit/history",
    ].includes(path)
  )
    return reply({ items: [], total: 0, page: 1, page_size: 12 });
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
const finder = () =>
  page.getByRole("dialog", { name: "Find a page", exact: true });
const search = () =>
  finder().getByRole("combobox", { name: "Find a page", exact: true });
const trigger = () =>
  page.getByRole("button", {
    name: "Find a page",
    exact: true,
    includeHidden: true,
  });
const mobileToggle = () =>
  page.getByRole("button", { name: "Toggle navigation", exact: true });
async function openFinder() {
  if (!(await trigger().isVisible())) await mobileToggle().click();
  await trigger().click();
  await expect(search()).toBeFocused();
}
async function selected(name) {
  const option = finder().getByRole("option", { name, exact: true });
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect(search()).toHaveAttribute(
    "aria-activedescendant",
    await option.getAttribute("id"),
  );
  return option;
}
async function view(route = "overview") {
  await page.goto("about:blank");
  await page.goto(origin + "/__page-finder-fixture#/" + route);
  await expect(trigger()).toBeAttached();
}
async function assertNoWrites() {
  expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
}
let failure;
try {
  await view();
  await check(
    "Keyboard navigation, current page, readable option descriptions and automatic active-option scrolling",
    async () => {
      await openFinder();
      await expect(finder().getByRole("option")).toHaveCount(13);
      await selected("Overview, current page");
      await expect(
        finder().getByRole("option", { name: "Deployments", exact: true }),
      ).toHaveAccessibleDescription(
        "Rollout progress, assignments and rollback",
      );
      await search().press("ArrowUp");
      const last = await selected("Help center");
      await expect
        .poll(() =>
          last.evaluate((element) => {
            const item = element.getBoundingClientRect(),
              list = element.parentElement.getBoundingClientRect();
            return item.top >= list.top - 1 && item.bottom <= list.bottom + 1;
          }),
        )
        .toBe(true);
      await search().press("ArrowDown");
      await selected("Overview, current page");
      const first = finder().getByRole("option", {
        name: "Overview, current page",
        exact: true,
      });
      await first.hover();
      await search().press("ArrowDown");
      const second = await selected("Pipelines");
      expect(
        await first.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        ),
      ).toBe("rgba(0, 0, 0, 0)");
      expect(
        await second.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        ),
      ).not.toBe("rgba(0, 0, 0, 0)");
      await search().fill("rollout");
      await expect(finder().getByRole("option")).toHaveCount(1);
      await selected("Deployments");
      await search().press("Enter");
      await expect(page).toHaveURL(/#\/deployments(?:\?|$)/);
      await expect(finder()).toHaveCount(0);
      await openFinder();
      await expect(search()).toHaveValue("");
      await selected("Overview");
      await expect(
        finder().getByRole("option", {
          name: "Deployments, current page",
          exact: true,
        }),
      ).toBeVisible();
      await search().press("Escape");
      await expect(trigger()).toBeFocused();
    },
  );
  await check(
    "No results, IME composition and pointer selection preserve intended navigation; reopening resets search",
    async () => {
      await openFinder();
      await search().fill("not-a-real-destination");
      await expect(finder().getByRole("status")).toContainText(
        "No matching pages",
      );
      await expect(search()).not.toHaveAttribute("aria-activedescendant");
      const before = page.url();
      await search().press("Enter");
      expect(page.url()).toBe(before);
      await expect(finder()).toBeVisible();
      await search().fill("MFA");
      await selected("People & security");
      await search().dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing: true,
      });
      await search().dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 229,
      });
      await expect(finder()).toBeVisible();
      expect(page.url()).toBe(before);
      await finder()
        .getByRole("option", { name: "People & security", exact: true })
        .click();
      await expect(page).toHaveURL(/#\/users$/);
      await openFinder();
      await search().fill("not-a-real-destination");
      await search().press("ControlOrMeta+k");
      await expect(finder()).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+k");
      await expect(search()).toHaveValue("");
      await selected("Overview");
      await search().press("Escape");
      await assertNoWrites();
    },
  );
  await check(
    "Enrollment destination is available to Operators and administrators but absent for viewers",
    async () => {
      user.role = "viewer";
      await view();
      await openFinder();
      await expect(finder().getByRole("option")).toHaveCount(12);
      await expect(
        finder().getByRole("option", { name: "Add a device", exact: true }),
      ).toHaveCount(0);
      await search().fill("install");
      await expect(finder().getByRole("option")).toHaveCount(0);
      await search().fill("security");
      await selected("People & security");
      await search().press("Escape");
      user.role = "operator";
      await view();
      await openFinder();
      await search().fill("install");
      await selected("Add a device");
      await search().press("Escape");
      user.role = "admin";
      await view();
      await openFinder();
      await search().fill("install");
      await selected("Add a device");
      await search().press("Escape");
    },
  );
  await check(
    "Help opens a context-preserving new tab; declined navigation keeps exact unapplied editor text without writes",
    async () => {
      await view(`configurations/${ids.pipeline}`);
      await page.getByRole("button", { name: "Code", exact: true }).click();
      const code = page.getByRole("textbox", {
        name: "Vector configuration code",
        exact: true,
      });
      const pending = '{"synthetic-unsaved-finder":';
      await code.fill(pending);
      await page.keyboard.press("ControlOrMeta+k");
      await expect(search()).toBeFocused();
      await search().fill("help");
      await expect(
        finder().getByRole("option", { name: "Help center", exact: true }),
      ).toHaveAccessibleDescription(/opens in a new tab/);
      const popupWait = page.waitForEvent("popup");
      await search().press("Enter");
      const popup = await popupWait;
      await expect(
        popup.getByRole("heading", {
          name: "Synthetic documentation",
          exact: true,
        }),
      ).toBeVisible();
      expect(new URL(popup.url()).searchParams.get("pipeline")).toBe(
        ids.pipeline,
      );
      expect(await popup.evaluate(() => opener === null)).toBe(true);
      await popup.close();
      expect(await code.innerText()).toBe(pending);
      await page.keyboard.press("ControlOrMeta+k");
      await search().fill("Devices");
      let refused = false;
      page.once("dialog", async (dialog) => {
        expect(dialog.type()).toBe("confirm");
        refused = true;
        await dialog.dismiss();
      });
      await finder()
        .getByRole("option", { name: "Devices", exact: true })
        .click();
      await expect.poll(() => refused).toBe(true);
      await expect(page).toHaveURL(
        new RegExp(`#/configurations/${ids.pipeline}$`),
      );
      expect(await code.innerText()).toBe(pending);
      await assertNoWrites();
      await page
        .getByRole("button", { name: "Discard code changes", exact: true })
        .click();
    },
  );
  await check(
    "899px and 375px light/dark containment, mobile drawer transition, Escape focus return and four Axe scans",
    async () => {
      for (const width of [899, 375]) {
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 884 });
          await page.evaluate((theme) => {
            localStorage.setItem("vectory-theme", theme);
            localStorage.setItem("vectory-sidebar-collapsed", "false");
          }, theme);
          await view();
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          await openFinder();
          if (width === 375)
            await expect(page.locator("#main-navigation")).not.toBeVisible();
          const rect = await finder().boundingBox();
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
          const geometry = await page.evaluate(() => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
          }));
          expect(geometry.scrollWidth).toBeLessThanOrEqual(width + 1);
          measurements.push({ width, theme, dialog: rect, ...geometry });
          const scan = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
          accessibility.push({
            width,
            theme,
            violations: scan.violations.map((v) => ({
              id: v.id,
              targets: v.nodes.map((node) => node.target),
            })),
          });
          expect(scan.violations).toEqual([]);
          await page.screenshot({
            path: resolve(output, `page-finder-${width}-${theme}.png`),
          });
          await search().press("Escape");
          await expect(finder()).toHaveCount(0);
          await expect(
            width === 375 ? mobileToggle() : trigger(),
          ).toBeFocused();
          await page.keyboard.press("ControlOrMeta+k");
          await expect(search()).toBeFocused();
          await search().press("Escape");
          await expect(
            width === 375 ? mobileToggle() : trigger(),
          ).toBeFocused();
        }
      }
      await assertNoWrites();
    },
  );
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const file of [
    "src/App.tsx",
    "src/PageFinder.tsx",
    "src/page-finder.css",
    "src/styles.css",
    "src/Editor.tsx",
  ])
    source_sha256[`dashboard/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, file)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Actual App page finder with isolated synthetic API transport. No real sessions, account changes, configuration writes or native processes. Axe applies to the four stated modal views.",
        passed: !failure,
        results,
        accessibility,
        measurements,
        requests,
        unexpected,
        errors,
        source_sha256,
        ...(failure
          ? {
              failure: failure.message,
              active_element: await page.evaluate(() =>
                document.activeElement?.outerHTML.slice(0, 1000),
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
