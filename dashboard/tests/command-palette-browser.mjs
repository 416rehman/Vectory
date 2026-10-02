// Actual App command palette, isolated synthetic transport. No preview accounts or mutations.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { configuredChannels } from "./notification-fixtures.mjs";
import {
  fleetReplies,
  fulfillFleetRead,
  nothingOffered,
  slimOverview,
} from "./fleet-replies.mjs";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_COMMAND_PALETTE_OUTPUT || ".local/command-palette",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:command-palette-fixture";
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
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
      name: "command-palette-fixture",
      resolveId(id) {
        if (id === "virtual:command-palette-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__command-palette") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic command palette verification</title></head><body><div id="root"></div><script type="module">import "virtual:command-palette-fixture";</script></body></html>',
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
  group: "66666666-6666-4666-8666-666666666666",
  deployment: "77777777-7777-4777-8777-777777777777",
  colleague: "88888888-8888-4888-8888-888888888888",
  version: "99999999-9999-4999-8999-999999999999",
};
const user = {
  id: ids.user,
  email: "palette@example.test",
  name: "Synthetic operator",
  role: "admin",
  enabled: true,
  revision: 1,
};
const colleague = {
  id: ids.colleague,
  email: "reviewer@example.test",
  name: "Robin Reviewer",
  role: "viewer",
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
  labels: { region: "eu-west" },
  desired_generation: 0,
  reported_generation: 0,
  apply_state: "unmanaged",
  sync_paused: false,
  pause_acknowledged: false,
  last_seen: new Date().toISOString(),
  created_at: created,
};
const pipeline = {
  id: ids.pipeline,
  name: "Synthetic palette pipeline",
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
const savedGroup = {
  id: ids.group,
  name: "Edge collectors",
  description: "Synthetic group",
  device_ids: [ids.device],
  revision: 1,
};
// A published version of the pipeline, offered once a check turns it on: the
// pipeline's page then has something to deploy.
const publishedVersion = {
  id: ids.version,
  configuration_id: ids.pipeline,
  number: 2,
  config: pipeline.config,
  graph: pipeline.graph,
  sha256: "2".repeat(64),
  artifact: JSON.stringify(pipeline.config),
  size: JSON.stringify(pipeline.config).length,
  created_at: created,
  message: "Synthetic version",
  validation: { valid: true },
};
let published = false;
// The rollout has finished since the palette's list was read.
let finished = false;
const rolloutSummary = () => ({
  id: ids.deployment,
  rollback_idempotency: true,
  rollback_review: true,
  request_correlation: true,
  name: "Synthetic palette rollout",
  configuration_id: ids.pipeline,
  configuration_name: "Synthetic palette pipeline",
  version_id: ids.version,
  version_number: 2,
  policy: null,
  priority: 100,
  target_mode: "snapshot",
  status: finished ? "completed" : "active",
  scheduled_at: null,
  created_at: created,
  rollout: {
    kind: "canary",
    canary_size: 1,
    batch_size: 5,
    observation_seconds: 30,
    failure_threshold: 0,
  },
  target_count: 3,
  verified_count: finished ? 3 : 1,
  state_counts: finished
    ? { verified_applied: 3 }
    : { verified_applied: 1, pending: 2 },
});
const fleet = fleetReplies({
  devices: [device],
  groups: [savedGroup],
  groupById: false,
});
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
  requests.push({ method, path: path + url.search });
  const reply = (json, status = 200) => route.fulfill({ status, json });
  if (method !== "GET") {
    unexpected.push(`${method} ${path}`);
    return reply(
      { error: { code: "UNEXPECTED_MUTATION", message: "Rejected" } },
      500,
    );
  }
  const page12 = { items: [], total: 0, page: 1, page_size: 12 };
  // The palette searches devices on the server and lists groups by count.
  if (await fulfillFleetRead(fleet, route)) return;
  if (path === "/status")
    return reply({ initialized: true, version: "synthetic" });
  if (path === "/session")
    return reply({ user, csrf_token: "synthetic-session-token" });
  if (path === "/users") return reply([user, colleague]);
  if (path === "/settings") return reply({ instance_name: "Synthetic" });
  if (path === "/mfa") return reply({ enabled: false });
  if (path === "/account/sessions") return reply({ sessions: [] });
  // An administrator's Overview and Issues ask whether a notification channel exists.
  if (path === "/notifications/channels") return reply(configuredChannels);
  if (path === "/overview")
    return reply(slimOverview([device], { configurations_total: 1 }));
  if (path === "/telemetry/summary")
    return reply({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
  if (path === "/devices") return reply([device]);
  if (path === `/devices/${ids.device}`) return reply(device);
  if (path === `/devices/${ids.device}/telemetry`)
    return reply({ device_id: ids.device, samples: [] });
  if (path === `/devices/${ids.device}/configuration`)
    return reply(nothingOffered(ids.device));
  if (path === "/groups")
    return reply([
      {
        id: ids.group,
        name: "Edge collectors",
        description: "Synthetic group",
        device_ids: [ids.device],
        revision: 1,
      },
    ]);
  if (path === "/groups/requests")
    return reply({ items: [], total: 0, page: 1, page_size: 50 });
  if (["/policies", "/tokens", "/releases"].includes(path)) return reply([]);
  if (path === "/deployments/history")
    return reply({
      items: [
        {
          id: ids.deployment,
          name: null,
          configuration_name: "Synthetic palette pipeline",
          version_id: ids.version,
          version_number: 2,
          policy: false,
          status: "active",
          priority: 100,
          target_count: 3,
          created_at: created,
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
    });
  // The rollout the palette's verbs open, with the review a rollback shows.
  if (path === `/deployments/${ids.deployment}/summary`)
    return reply(rolloutSummary());
  if (path === `/deployments/${ids.deployment}/rollout`)
    return reply({
      deployment_id: ids.deployment,
      status: finished ? "completed" : "active",
      evaluated_at: new Date().toISOString(),
      stages: [],
      failures: [],
      removed_count: 0,
      check_in_seconds: 60,
      next_admission_at: null,
    });
  if (path === `/deployments/${ids.deployment}/targets`)
    return reply({ items: [], total: 0, page: 1, page_size: 12 });
  if (path === `/deployments/${ids.deployment}/rollback-preview`)
    return reply({
      source_deployment_id: ids.deployment,
      source_version_id: ids.version,
      source_status: "active",
      source_action: "cancel",
      previous_version_id: ids.pipeline,
      previous_version_number: 1,
      previous_configuration_id: ids.pipeline,
      previous_configuration_name: "Synthetic palette pipeline",
      priority: 101,
      eligible_devices: [
        {
          device_id: ids.device,
          device_name: device.name,
          artifact_sha256: "a".repeat(64),
        },
      ],
      excluded_devices: [],
      blockers: [],
      review_token: "b".repeat(64),
      ready: true,
    });
  if (path === `/versions/${ids.version}`) return reply(publishedVersion);
  if (["/issues/history", "/audit/history"].includes(path))
    return reply(page12);
  if (path === "/issues/groups")
    return reply({ items: [], total: 0, page: 1, page_size: 12 });
  if (path === "/configurations/library")
    return reply({
      items: [
        {
          ...pipeline,
          config: undefined,
          graph: undefined,
          component_counts: { sources: 1, transforms: 0, sinks: 1 },
          latest_version: { id: ids.pipeline, number: 2, created_at: created },
        },
      ],
      total: 1,
      page: 1,
      page_size: 12,
    });
  if (path === `/configurations/${ids.pipeline}`) return reply(pipeline);
  if (path === `/configurations/${ids.pipeline}/history`)
    return reply({
      items: published
        ? [
            {
              id: ids.version,
              configuration_id: ids.pipeline,
              number: 2,
              created_at: created,
            },
          ]
        : [],
      total: published ? 1 : 0,
      page: 1,
      page_size: Number(url.searchParams.get("page_size")),
      kind: "versions",
    });
  unexpected.push(`${method} ${path}`);
  return reply(
    { error: { code: "UNEXPECTED_REQUEST", message: "Unexpected" } },
    500,
  );
});
async function check(name, run) {
  const began = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - began });
  console.log("PASS", name);
}
const palette = () =>
  page.getByRole("dialog", { name: "Search Vectory", exact: true });
const search = () =>
  palette().getByRole("combobox", { name: "Search Vectory", exact: true });
async function open() {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(search()).toBeFocused();
}
async function selected(name) {
  const option = palette().getByRole("option", { name, exact: true });
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect(search()).toHaveAttribute(
    "aria-activedescendant",
    await option.getAttribute("id"),
  );
  return option;
}
async function view(route = "overview") {
  await page.goto("about:blank");
  await page.goto(`${origin}/__command-palette#/${route}`);
  await expect(page.locator("h1")).toBeVisible();
}
let failure;
try {
  await view();
  await check(
    "Ctrl K opens a top-anchored palette with pages and actions, the current page marked and Escape returning focus",
    async () => {
      const opener = page.getByRole("button", { name: "Search", exact: true });
      await opener.click();
      await expect(search()).toBeFocused();
      const box = await palette().boundingBox();
      expect(box.y).toBeLessThan(960 * 0.2);
      measurements.push({ label: "palette 1440", box });
      await expect(
        palette().getByRole("option", {
          name: "Overview, current page",
          exact: true,
        }),
      ).toBeVisible();
      await expect(palette().getByRole("group")).toHaveCount(2);
      await selected("Overview, current page");
      await search().press("ArrowDown");
      await selected("Pipelines");
      await expect(
        palette().getByRole("option", { name: "Deployments", exact: true }),
      ).toHaveAccessibleDescription(
        "Rollout progress, assignments and rollback",
      );
      await search().press("Escape");
      await expect(palette()).toHaveCount(0);
      await expect(opener).toBeFocused();
    },
  );
  await check(
    "Opening the palette again within thirty seconds reuses what it read",
    async () => {
      await view();
      const reads = () =>
        requests.filter(
          (request) => request.path === "/deployments/history?page_size=20",
        ).length;
      const before = reads();
      await open();
      await expect.poll(reads).toBe(before + 1);
      await search().press("Escape");
      await expect(palette()).toHaveCount(0);
      await open();
      await page.waitForTimeout(500);
      expect(reads()).toBe(before + 1);
      await search().press("Escape");
    },
  );
  await check(
    "Fuzzy search finds a device by name with its live status, highlights the match, opens it and remembers it",
    async () => {
      await open();
      await search().fill("unassig");
      const option = palette().getByRole("option", {
        name: "Synthetic unassigned device",
        exact: true,
      });
      await expect(option).toBeVisible();
      await expect(option.locator("mark")).toHaveText("unassig");
      await expect(option.locator(".status-badge")).toHaveText("No pipeline");
      await expect(palette().getByRole("status")).toContainText("1 result");
      await selected("Synthetic unassigned device");
      await search().press("Enter");
      await expect(page).toHaveURL(new RegExp(`#/devices/${ids.device}$`));
      await expect(
        page.getByRole("heading", {
          name: "Synthetic unassigned device",
          level: 1,
        }),
      ).toBeVisible();
      await open();
      await expect(
        palette().getByRole("group", { name: "Recent" }),
      ).toContainText("Synthetic unassigned device");
      // The server matches a device's platform as well as its name.
      await search().fill("windows amd64");
      await expect(
        palette().getByRole("option", { name: "Synthetic unassigned device" }),
      ).toBeVisible();
      await expect(
        palette().getByRole("option", { name: "Synthetic unassigned device" }),
      ).toContainText("windows / amd64");
      // Devices come from the server one search at a time, five rows at most;
      // the fleet is never listed to be filtered here.
      expect(requests.map((request) => request.path)).toContain(
        "/devices/inventory?q=unassig&page_size=5",
      );
      expect(requests.filter((request) => request.path === "/devices")).toEqual(
        [],
      );
      // Pipelines, groups and deployments are searchable too.
      await search().fill("edge coll");
      await expect(
        palette().getByRole("option", { name: "Edge collectors" }),
      ).toBeVisible();
      await search().fill("palette pipe");
      await expect(
        palette().getByRole("group", { name: "Pipelines" }),
      ).toContainText("Synthetic palette pipeline");
      await expect(
        palette().getByRole("group", { name: "Deployments" }),
      ).toBeVisible();
      await search().press("Escape");
    },
  );
  await check(
    "Actions run from the palette: theme, create group on its page, security activity and the shortcut sheet",
    async () => {
      await view();
      await open();
      await search().fill("dark theme");
      await selected("Switch to dark theme");
      await search().press("Enter");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await open();
      await search().fill("create group");
      await selected("Create group");
      await search().press("Enter");
      await expect(page).toHaveURL(/#\/groups$/);
      const editor = page.getByRole("dialog", { name: "Create group" });
      await expect(editor).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(editor).toHaveCount(0);
      await open();
      await search().fill("security activity");
      // Pages rank first; the action is chosen explicitly.
      await palette()
        .getByRole("option", { name: "View security activity", exact: true })
        .click();
      await expect(page).toHaveURL(/#\/audit\?scope=security$/);
      await expect(
        page.getByRole("radio", { name: "Security", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await open();
      await search().fill("keyboard");
      await selected("Keyboard shortcuts");
      await search().press("Enter");
      const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("Search and run commands");
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await page.evaluate(() => localStorage.setItem("vectory-theme", "light"));
    },
  );
  await check(
    "Global shortcuts: ? opens the sheet and g then a key goes to a section, never while typing",
    async () => {
      await view();
      await page.locator("#main-content").focus();
      await page.keyboard.press("?");
      await expect(
        page.getByRole("dialog", { name: "Keyboard shortcuts" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await page.keyboard.press("g");
      await page.keyboard.press("d");
      await expect(page).toHaveURL(/#\/devices$/);
      await page.locator("#main-content").focus();
      await page.keyboard.press("g");
      await page.keyboard.press("a");
      await expect(page).toHaveURL(/#\/deployments$/);
      // Typing in a field never triggers navigation.
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await search().fill("g");
      await search().press("d");
      await expect(page).toHaveURL(/#\/deployments$/);
      await search().press("Escape");
    },
  );
  await check(
    "Single-key shortcuts turn off in the account menu, stay off after a reload, and Ctrl K keeps working",
    async () => {
      await view();
      const account = page
        .getByRole("button", { name: "Your account", exact: true })
        .first();
      const toggle = () =>
        page.getByRole("menuitemcheckbox", { name: "Single-key shortcuts" });
      const sheet = () =>
        page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await account.click();
      await expect(toggle()).toHaveAttribute("aria-checked", "true");
      await expect(toggle()).toHaveAccessibleDescription(
        "R, /, ?, [ and G then a letter. Turn off if you use speech input.",
      );
      await toggle().click();
      await expect(toggle()).toHaveAttribute("aria-checked", "false");
      await page.keyboard.press("Escape");
      for (const pass of ["now", "after reload"]) {
        if (pass === "after reload") await view();
        await page.locator("#main-content").focus();
        await page.keyboard.press("?");
        await page.keyboard.press("g");
        await page.keyboard.press("d");
        await page.keyboard.press("r");
        await page.waitForTimeout(300);
        await expect(sheet(), `? ${pass}`).toHaveCount(0);
        await expect(page, `G then D ${pass}`).toHaveURL(/#\/overview$/);
        // Shortcuts with a modifier never switch off.
        await open();
        await page.keyboard.press("Escape");
      }
      // The sheet says why only modifier shortcuts work.
      await account.click();
      await page.getByRole("menuitem", { name: /Keyboard shortcuts/ }).click();
      await expect(sheet()).toContainText("Single-key shortcuts are off");
      await page.keyboard.press("Escape");
      await account.click();
      await toggle().click();
      await expect(toggle()).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await page.locator("#main-content").focus();
      await page.keyboard.press("?");
      await expect(sheet()).toBeVisible();
      await expect(sheet()).not.toContainText("Single-key shortcuts are off");
      await page.keyboard.press("Escape");
    },
  );
  await check(
    "No results and IME composition keep the page; help opens in a new tab and the editor draft guard still applies",
    async () => {
      await view(`configurations/${ids.pipeline}`);
      await page.getByRole("button", { name: "Code", exact: true }).click();
      const code = page.getByRole("textbox", {
        name: "Vector configuration code",
        exact: true,
      });
      const pending = '{"synthetic-unsaved-palette":';
      await code.fill(pending);
      await open();
      await search().fill("not-a-real-destination");
      await expect(palette()).toContainText("No results for");
      await expect(search()).not.toHaveAttribute("aria-activedescendant");
      const before = page.url();
      await search().press("Enter");
      expect(page.url()).toBe(before);
      await search().fill("devices");
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
      await expect(palette()).toBeVisible();
      expect(page.url()).toBe(before);
      await search().fill("help center");
      await selected("Help center");
      const popupWait = page.waitForEvent("popup");
      await search().press("Enter");
      const popup = await popupWait;
      await expect(
        popup.getByRole("heading", { name: "Synthetic documentation" }),
      ).toBeVisible();
      expect(new URL(popup.url()).searchParams.get("pipeline")).toBe(
        ids.pipeline,
      );
      expect(await popup.evaluate(() => opener === null)).toBe(true);
      await popup.close();
      expect(await code.innerText()).toBe(pending);
      await open();
      await search().fill("Devices");
      let refused = false;
      page.once("dialog", async (dialog) => {
        expect(dialog.type()).toBe("confirm");
        refused = true;
        await dialog.dismiss();
      });
      await palette()
        .getByRole("option", { name: "Devices", exact: true })
        .click();
      await expect.poll(() => refused).toBe(true);
      await expect(page).toHaveURL(
        new RegExp(`#/configurations/${ids.pipeline}$`),
      );
      expect(await code.innerText()).toBe(pending);
      await page
        .getByRole("button", { name: "Discard code changes", exact: true })
        .click();
    },
  );
  await check(
    "Verbs on rollouts, pipelines and devices answer to the words typed, open the page's own review or dialog, send nothing and follow the role",
    async () => {
      published = true;
      const mutations = () =>
        requests.filter((request) => request.method !== "GET");
      const verb = (name) =>
        palette().getByRole("option", { name, exact: true });
      const verbs = () =>
        palette().getByRole("option", {
          name: /^(Pause|Cancel|Roll back|Deploy|Duplicate|Show issues) /,
        });
      const dialog = (name) => page.getByRole("dialog", { name, exact: true });
      const asking = {
        pause: ["pause palette", "Pause Synthetic palette pipeline v2"],
        cancel: ["cancel palette", "Cancel Synthetic palette pipeline v2"],
        rollback: [
          "roll back palette",
          "Roll back Synthetic palette pipeline v2",
        ],
        deploy: ["deploy palette", "Deploy Synthetic palette pipeline v2…"],
        duplicate: [
          "duplicate palette",
          "Duplicate Synthetic palette pipeline…",
        ],
        issues: [
          "show issues unassigned",
          "Show issues for Synthetic unassigned device",
        ],
      };
      async function pick(name) {
        const [words, title] = asking[name];
        await open();
        await search().fill(words);
        await expect(verb(title)).toBeVisible();
        await verb(title).click();
        await expect(palette()).toHaveCount(0);
      }
      await view();
      // The names alone list no verb.
      await open();
      await search().fill("synthetic");
      await expect(
        palette().getByRole("group", { name: "Pipelines" }),
      ).toContainText("Synthetic palette pipeline");
      await expect(verbs()).toHaveCount(0);
      await search().press("Escape");
      // A rollout: the page opens with the same review its button opens.
      await pick("pause");
      await expect(page).toHaveURL(
        new RegExp(`#/deployments/${ids.deployment}$`),
      );
      await expect(dialog("Pause rollout")).toBeVisible();
      // The review opens on the choice that changes nothing: an Enter pressed
      // again right after the palette's own does not confirm it.
      const keepState = (name) =>
        dialog(name).getByRole("button", {
          name: "Keep current state",
          exact: true,
        });
      await expect(keepState("Pause rollout")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(dialog("Pause rollout")).toHaveCount(0);
      expect(mutations()).toEqual([]);
      // Already on that page, the verb runs in place.
      await pick("cancel");
      await expect(dialog("Cancel rollout")).toBeVisible();
      await expect(keepState("Cancel rollout")).toBeFocused();
      await page.keyboard.press("Escape");
      await pick("rollback");
      await expect(dialog("Review rollback")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog("Review rollback")).toHaveCount(0);
      expect(mutations()).toEqual([]);
      // A pipeline: its page opens the deploy dialog, or the duplicate one.
      await pick("deploy");
      await expect(page).toHaveURL(
        new RegExp(`#/configurations/${ids.pipeline}$`),
      );
      await expect(
        dialog("Deploy Synthetic palette pipeline v2"),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog("Deploy Synthetic palette pipeline v2")).toHaveCount(
        0,
      );
      await pick("duplicate");
      await expect(dialog("Duplicate pipeline")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog("Duplicate pipeline")).toHaveCount(0);
      // A device: its issues.
      await pick("issues");
      await expect(page).toHaveURL(
        new RegExp(`#/issues\\?device=${ids.device}$`),
      );
      await expect(
        page.getByRole("button", { name: "Show all devices", exact: true }),
      ).toBeVisible();
      expect(mutations()).toEqual([]);
      // Each role is offered what its pages let it do.
      for (const [role, allowed] of [
        ["viewer", ["issues"]],
        ["operator", ["pause", "cancel", "rollback", "deploy", "issues"]],
        ["editor", ["duplicate", "issues"]],
        ["admin", Object.keys(asking)],
      ]) {
        user.role = role;
        await view();
        await open();
        // Once the pipelines are listed, a verb that is missing is missing.
        await search().fill("palette");
        await expect(
          palette().getByRole("group", { name: "Pipelines" }),
        ).toContainText("Synthetic palette pipeline");
        for (const [name, [words, title]] of Object.entries(asking)) {
          await search().fill(words);
          if (allowed.includes(name))
            await expect(verb(title), `${role} ${name}`).toBeVisible();
          else await expect(verb(title), `${role} ${name}`).toHaveCount(0);
        }
        await search().press("Escape");
      }
      user.role = "admin";
      // A list that was out of date: the rollout finished since it was read.
      // The page opens and says so; no review opens, now or on a later click.
      finished = true;
      await view();
      await pick("pause");
      await expect(
        page
          .getByRole("region", { name: "Notifications" })
          .getByText("Pause isn't available for this rollout now."),
      ).toBeVisible();
      await expect(dialog("Pause rollout")).toHaveCount(0);
      await page.waitForTimeout(500);
      await expect(dialog("Pause rollout")).toHaveCount(0);
      finished = false;
      published = false;
      expect(mutations()).toEqual([]);
    },
  );
  await check(
    "/ goes to the page's own search, or opens the palette where a page has none; the sheet reads Up / Down; old addresses open their pages with their query",
    async () => {
      // The key is pressed once the page's own content is there: until then a
      // page has no search to go to.
      const slash = async (route, ready) => {
        await view(route);
        await expect(ready).toBeVisible();
        await page.locator("#main-content").focus();
        await page.keyboard.press("/");
      };
      const issuesSearch = page.getByRole("textbox", {
        name: "Search devices, pipelines, or reasons",
        exact: true,
      });
      const pipelinesSearch = page.getByRole("textbox", {
        name: "Search pipelines",
        exact: true,
      });
      await slash("issues", issuesSearch);
      await expect(issuesSearch).toBeFocused();
      await expect(palette()).toHaveCount(0);
      await slash("configurations", pipelinesSearch);
      await expect(pipelinesSearch).toBeFocused();
      await expect(palette()).toHaveCount(0);
      // The Agent settings list has no search of its own.
      await slash(
        "policies",
        page.getByRole("heading", { name: "No saved agent settings" }),
      );
      await expect(search()).toBeFocused();
      await search().press("Escape");
      // Typing a slash into a field is typing.
      await view("issues");
      const box = page.getByRole("textbox", {
        name: "Search devices, pipelines, or reasons",
        exact: true,
      });
      await box.focus();
      await page.keyboard.type("a/b");
      await expect(box).toHaveValue("a/b");
      await expect(palette()).toHaveCount(0);
      // The sheet joins the arrows with a slash, and keeps "then" for G O.
      await view();
      await page.locator("#main-content").focus();
      await page.keyboard.press("?");
      const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await expect(sheet).toContainText("Search this page");
      const row = (label) =>
        sheet.locator("dl > div").filter({ hasText: label });
      await expect(row("Move between results").locator(".kbd")).toHaveText([
        "↑",
        "↓",
      ]);
      await expect(
        row("Move between results").locator(".shortcut-then"),
      ).toHaveText("/");
      await expect(row("Pipelines").locator(".shortcut-then")).toHaveText(
        "then",
      );
      await page.keyboard.press("Escape");
      // The names pages used to have still open the pages that replaced them,
      // from a link and from inside the dashboard, keeping what follows.
      for (const [old, current] of [
        ["pipelines", "configurations"],
        ["activity", "deployments"],
        ["rollouts", "deployments"],
        ["pipelines?q=syslog", "configurations?q=syslog"],
        [`rollouts/${ids.deployment}`, `deployments/${ids.deployment}`],
      ]) {
        await view(old);
        await expect(page, `${old} from a link`).toHaveURL(
          new RegExp(`#/${current.replace(/[?/]/g, "\\$&")}$`),
        );
        await view();
        await page.evaluate((old) => {
          location.hash = `#/${old}`;
        }, old);
        await expect(page, `${old} inside`).toHaveURL(
          new RegExp(`#/${current.replace(/[?/]/g, "\\$&")}$`),
        );
      }
    },
  );
  await check(
    "Results follow the role: viewers see no operator actions or people; administrators can find people",
    async () => {
      user.role = "viewer";
      await view();
      await open();
      for (const name of ["Add device", "Create pipeline", "Create group"])
        await expect(
          palette().getByRole("option", { name, exact: true }),
        ).toHaveCount(0);
      await search().fill("Robin");
      await expect(
        palette().getByRole("group", { name: "People" }),
      ).toHaveCount(0);
      await search().press("Escape");
      user.role = "admin";
      await view();
      await open();
      await search().fill("Robin");
      await expect(
        palette().getByRole("group", { name: "People" }),
      ).toContainText("Robin Reviewer");
      await search().press("Escape");
    },
  );
  await check(
    "899px and 375px light/dark stay contained, return focus and pass Axe",
    async () => {
      for (const width of [899, 375]) {
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 884 });
          await page.evaluate((theme) => {
            localStorage.setItem("vectory-theme", theme);
          }, theme);
          await view();
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          const opener =
            width === 375
              ? page
                  .locator(".mobile-header")
                  .getByRole("button", { name: "Search", exact: true })
              : page
                  .locator("#main-navigation")
                  .getByRole("button", { name: "Search", exact: true });
          await opener.click();
          await expect(search()).toBeFocused();
          const rect = await palette().boundingBox();
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
            path: resolve(output, `command-palette-${width}-${theme}.png`),
          });
          // The same palette with a verb among its results.
          await search().fill("pause palette");
          const verbRow = palette().getByRole("option", {
            name: "Pause Synthetic palette pipeline v2",
            exact: true,
          });
          await expect(verbRow).toBeVisible();
          const verbScan = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
          accessibility.push({
            width,
            theme,
            view: "verbs",
            violations: verbScan.violations.map((v) => ({
              id: v.id,
              targets: v.nodes.map((node) => node.target),
            })),
          });
          expect(verbScan.violations).toEqual([]);
          await page.screenshot({
            path: resolve(
              output,
              `command-palette-verbs-${width}-${theme}.png`,
            ),
          });
          await search().press("Escape");
          await expect(palette()).toHaveCount(0);
          await expect(opener).toBeFocused();
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
} finally {
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Actual App command palette with isolated synthetic API transport. No real sessions, account changes, configuration writes or native processes.",
        passed: !failure,
        results,
        accessibility,
        measurements,
        requests,
        unexpected,
        errors,
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
if (failure) throw failure;
