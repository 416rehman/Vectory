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
  process.env.VECTORY_PAGE_HELP_OUTPUT || ".local/page-help-component",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((yes, no) => {
  reservation.once("error", no);
  reservation.listen(0, "127.0.0.1", yes);
});
const port = reservation.address().port;
await new Promise((yes) => reservation.close(yes));
const virtual = "\0virtual:page-help-fixture";
const vite = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "page-help-fixture",
      resolveId(id) {
        if (id === "virtual:page-help-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__page-help") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic page help verification</title></head><body><div id="root"></div><script type="module">import "virtual:page-help-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(30000);
const pipelineId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Synthetic operator",
  email: "help@example.test",
  role: "admin",
  revision: 1,
  enabled: true,
};
const device = {
  id: deviceId,
  name: "Synthetic device",
  os: "linux",
  arch: "amd64",
  status: "unmanaged",
  apply_state: "unmanaged",
  desired_generation: 0,
  reported_generation: 0,
  configuration_mode: "restricted",
  labels: {},
  sync_paused: false,
  pause_acknowledged: false,
};
const pipeline = {
  id: pipelineId,
  name: "Synthetic help pipeline",
  description: "Isolated fixture, never deployed.",
  revision: 1,
  archived: false,
  created_at: "2026-09-26T12:00:00Z",
  updated_at: "2026-09-26T12:00:00Z",
  config: {
    sources: {
      sample: {
        type: "demo_logs",
        format: "json",
        decoding: { codec: "json" },
      },
    },
    sinks: { output: { type: "blackhole", inputs: ["sample"] } },
  },
  graph: { nodes: [], edges: [] },
};
const results = [],
  requests = [],
  unexpected = [],
  errors = [],
  measurements = [],
  accessibility = [];
page.on("pageerror", (e) => errors.push(e.message));
await context.route("**/*", async (route) => {
  const request = route.request(),
    url = new URL(request.url());
  if (url.origin !== origin) {
    unexpected.push(`External ${url.origin}`);
    return route.abort();
  }
  if (url.pathname.startsWith("/help/"))
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Synthetic help target</title><main>Help opened</main>",
    });
  if (!url.pathname.startsWith("/api/v1/")) return route.continue();
  const path = url.pathname.slice(7),
    method = request.method();
  requests.push({ method, path });
  const reply = (json) => route.fulfill({ json });
  if (method !== "GET") {
    unexpected.push(`${method} ${path}`);
    return route.fulfill({
      status: 500,
      json: {
        error: {
          code: "FIXTURE_MUTATION",
          message: "Fixture forbids mutations",
        },
      },
    });
  }
  if (path === "/status")
    return reply({ initialized: true, version: "synthetic" });
  if (path === "/session")
    return reply({ user, csrf_token: "synthetic-help-session" });
  if (path === "/settings")
    return reply({ instance_name: "Synthetic help workspace" });
  if (path === "/mfa") return reply({ enabled: false });
  if (path === "/account/sessions") return reply({ sessions: [] });
  if (path === "/users") return reply([user]);
  // A server without the fleet summary answers 404; the Overview falls back.
  if (path === "/telemetry/summary")
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "Not found" } },
    });
  if (path === "/overview")
    return reply({
      devices_total: 1,
      devices_online: 0,
      configurations_total: 1,
      deployments_active: 0,
      issues_open: 0,
      devices: [device],
      recent_activity: [],
    });
  if (path === "/devices") return reply([device]);
  if (path === `/devices/${deviceId}`) return reply(device);
  if (path === `/devices/${deviceId}/telemetry`)
    return reply({ device_id: deviceId, samples: [] });
  if (["/groups", "/policies", "/tokens", "/releases"].includes(path))
    return reply([]);
  if (path === "/agent-install")
    return reply({
      agent_url: null,
      agent_url_configured: false,
      listener_enabled: false,
      dashboard_url: null,
      certificate: null,
      downloads_enabled: true,
      installer: null,
      default_install_dir: "/usr/local/bin",
      releases: [],
      catalog_problems: [],
    });
  if (
    [
      "/configurations/library",
      "/deployments/history",
      "/audit/history",
      "/issues/history",
      "/issues/groups",
      `/configurations/${pipelineId}/history`,
    ].includes(path)
  )
    return reply({
      items: [],
      total: 0,
      page: 1,
      page_size: Number(url.searchParams.get("page_size") || 12),
    });
  if (path === `/configurations/${pipelineId}`) return reply(pipeline);
  // Add device lists the last day's enrollment attempts.
  if (path === "/agent-install/activity")
    return reply({ events: [], now: new Date().toISOString() });
  unexpected.push(`${method} ${path}`);
  return route.fulfill({
    status: 500,
    json: {
      error: { code: "FIXTURE_REQUEST", message: "Unexpected fixture request" },
    },
  });
});
async function check(name, run) {
  const start = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - start });
  console.log("PASS", name);
}
async function anchorExists(href) {
  const url = new URL(href, origin),
    topic = url.pathname.split("/")[2];
  const source = await readFile(
    resolve(repository, `docs/user/${topic}.md`),
    "utf8",
  );
  if (url.hash) {
    const anchors = [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map(
      ([, heading]) =>
        heading
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s-]/gu, "")
          .trim()
          .replace(/\s+/g, "-"),
    );
    expect(anchors, href).toContain(decodeURIComponent(url.hash.slice(1)));
  }
}
async function geometry(link, name) {
  const box = await link.boundingBox(),
    heading = await link.locator("..").locator("h1,h2").boundingBox();
  expect(box).not.toBeNull();
  expect(heading).not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  expect(box.x - heading.x - heading.width).toBeGreaterThanOrEqual(3);
  expect(box.x - heading.x - heading.width).toBeLessThanOrEqual(12);
  expect(
    Math.abs(box.y + box.height / 2 - heading.y - heading.height / 2),
  ).toBeLessThanOrEqual(2);
  const scroll = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(scroll.scroll).toBeLessThanOrEqual(scroll.width + 1);
  measurements.push({ name, box, heading, ...scroll });
}
async function scan(name) {
  const result = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({
    name,
    violations: result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((n) => n.target),
    })),
  });
  expect(result.violations).toEqual([]);
}
let failure;
try {
  await check(
    "Every main workspace title exposes one named help icon to an existing guide section",
    async () => {
      const routes = [
        ["overview", "Overview"],
        ["configurations", "Pipelines"],
        ["devices", "Devices"],
        [`devices/${deviceId}`, device.name],
        ["groups", "Groups"],
        ["policies", "Agent settings"],
        ["enrollment", "Add device"],
        ["deployments", "Deployments"],
        ["schedules", "Schedules"],
        ["issues", "Issues"],
        ["audit", "Audit log"],
        ["settings", "General"],
        ["users", "People & security"],
      ];
      for (const [route, title] of routes) {
        await page.goto(`${origin}/__page-help#/${route}`);
        await expect(
          page.getByRole("heading", { name: title, exact: true, level: 1 }),
        ).toBeVisible();
        const help = page.locator(
          ".page-heading .page-title-row .page-help-link",
        );
        await expect(help).toHaveCount(1);
        await expect(help).toHaveAccessibleName(
          /Help for .+ \(opens in a new tab\)/,
        );
        await expect(help).toHaveAttribute("target", "_blank");
        await expect(help).toHaveAttribute("rel", "noopener noreferrer");
        await expect(help.locator("svg")).toHaveCount(1);
        for (const icon of await help.locator("svg").all()) {
          await expect(icon).toHaveAttribute("aria-hidden", "true");
          await expect(icon).toHaveAttribute("focusable", "false");
        }
        await expect(help.locator(".page-help-link-external")).toHaveCount(0);
        await anchorExists(await help.getAttribute("href"));
        await geometry(help, title);
      }
    },
  );
  await check(
    "Help title geometry remains readable at desktop and mobile in both themes",
    async () => {
      for (const [width, theme] of [
        [1280, "light"],
        [1280, "dark"],
        [390, "light"],
        [390, "dark"],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${origin}/__page-help#/configurations`);
        const help = page.getByRole("link", {
          name: "Help for Pipelines (opens in a new tab)",
          exact: true,
        });
        await expect(help).toBeVisible();
        await page.evaluate(
          (value) => (document.documentElement.dataset.theme = value),
          theme,
        );
        await help.focus();
        await expect(help).toBeFocused();
        await geometry(help, `${width}-${theme}`);
        await scan(`${width}-${theme}`);
        await page.screenshot({
          path: resolve(output, `page-help-${width}-${theme}.png`),
        });
      }
    },
  );
  await check(
    "Editor help opens beside an invalid local draft without navigation, save, or lost content",
    async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${origin}/__page-help#/configurations/${pipelineId}`);
      await expect(
        page.getByRole("heading", { name: pipeline.name, exact: true }),
      ).toBeVisible();
      const help = page.getByRole("link", {
        name: "Help for the pipeline editor (opens in a new tab)",
        exact: true,
      });
      await expect(help).toHaveAttribute(
        "href",
        `/help/pipelines/?pipeline=${pipelineId}#add-and-connect-components`,
      );
      await page
        .locator('.react-flow__node[data-id="sample"] .pipeline-node')
        .click();
      const componentHelp = page.getByRole("link", {
        name: "Component documentation (opens in a new tab)",
        exact: true,
      });
      await expect(componentHelp).toHaveClass(/page-help-link/);
      await expect(componentHelp).toHaveAttribute(
        "href",
        "https://vector.dev/docs/reference/configuration/sources/demo_logs/",
      );
      await page
        .getByRole("button", { name: "Actions for Decoding", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Edit Decoding as JSON", exact: true })
        .click();
      const raw = page.getByRole("textbox", {
          name: "Decoding (JSON)",
          exact: true,
        }),
        pending = '{"unfinished":';
      await raw.fill(pending);
      const before = page.url(),
        mutationsBefore = requests.filter((r) => r.method !== "GET").length;
      let dialogs = 0;
      page.on("dialog", async (dialog) => {
        dialogs++;
        await dialog.dismiss();
      });
      const popupPromise = context.waitForEvent("page");
      await help.focus();
      await page.keyboard.press("Enter");
      const popup = await popupPromise;
      await popup.waitForLoadState("domcontentloaded");
      expect(popup.url()).toBe(
        `${origin}/help/pipelines/?pipeline=${pipelineId}#add-and-connect-components`,
      );
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      await popup.close();
      expect(page.url()).toBe(before);
      await expect(raw).toHaveText(pending);
      expect(dialogs).toBe(0);
      expect(requests.filter((r) => r.method !== "GET")).toHaveLength(
        mutationsBefore,
      );
      await raw.fill(
        JSON.stringify(pipeline.config.sources.sample.decoding, null, 2),
      );
      await page
        .locator(".editor-inspector")
        .getByRole("button", { name: "Close component settings", exact: true })
        .click();
      await page.locator(".editor-tools-menu > summary").click();
      await page
        .getByRole("button", { name: "Version history", exact: true })
        .click();
      const historyHelp = page.getByRole("link", {
        name: "Help for pipeline history (opens in a new tab)",
        exact: true,
      });
      await expect(historyHelp).toBeVisible();
      await expect(historyHelp).toHaveAttribute(
        "href",
        `/help/pipelines/?pipeline=${pipelineId}#compare-saved-history`,
      );
      await anchorExists(await historyHelp.getAttribute("href"));
    },
  );
  await check(
    "Inline pipeline help and official Vector references visibly indicate a safe new-tab destination",
    async () => {
      await page.goto(
        `${origin}/__page-help#/configurations/${pipelineId}?panel=settings&section=general`,
      );
      const settings = page.getByRole("dialog", {
        name: "Pipeline settings",
        exact: true,
      });
      await expect(settings).toBeVisible();
      const localHelp = settings.getByRole("link", {
        name: "How this works (opens help in a new tab)",
        exact: true,
      });
      const reference = settings.getByRole("link", {
        name: "Vector reference for general (opens in a new tab)",
        exact: true,
      });
      await expect(localHelp).toHaveAttribute(
        "href",
        `/help/pipelines/?pipeline=${pipelineId}#global-settings`,
      );
      await anchorExists(await localHelp.getAttribute("href"));
      await expect(reference).toHaveAttribute(
        "href",
        "https://vector.dev/docs/reference/configuration/global-options/",
      );
      for (const [width, theme] of [
        [1280, "light"],
        [390, "dark"],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        for (const link of [localHelp, reference]) {
          await link.scrollIntoViewIfNeeded();
          await expect(link).toHaveAttribute("target", "_blank");
          await expect(link).toHaveAttribute("rel", "noopener noreferrer");
          const indicator = link.locator(".doc-link-indicator");
          await expect(indicator).toBeVisible();
          await expect(indicator).toHaveAttribute("aria-hidden", "true");
          await expect(indicator).toHaveAttribute("focusable", "false");
          expect((await indicator.boundingBox()).width).toBeGreaterThanOrEqual(
            10,
          );
          await link.focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Shift+Tab");
          await expect(link).toBeFocused();
          await expect(link).toHaveCSS("outline-style", "solid");
        }
      }
      expect(requests.filter((request) => request.method !== "GET")).toEqual(
        [],
      );
    },
  );
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  await page
    .screenshot({ path: resolve(output, "failure.png") })
    .catch(() => {});
} finally {
  const source_sha256 = {};
  for (const file of [
    "src/DocLink.tsx",
    "src/help-link.css",
    "src/PipelineGlobals.tsx",
    "src/ScalarReference.tsx",
    "src/Editor.tsx",
    "src/PipelineSettings.tsx",
    "src/PipelineSchemaFields.tsx",
    "src/SchemaValueEditor.tsx",
  ])
    source_sha256[`dashboard/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, file)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        scope: "Actual App with isolated synthetic API; no production state",
        generated_at: new Date().toISOString(),
        source_sha256,
        results,
        measurements,
        accessibility,
        errors,
        unexpected,
        mutations: requests.filter((r) => r.method !== "GET"),
        failure: failure?.message || null,
      },
      null,
      2,
    ),
  );
  await context.close();
  await browser.close();
  await vite.close();
}
console.log(
  `Evidence: ${relative(repository, resolve(output, "report.json"))}`,
);
if (failure) throw failure;
