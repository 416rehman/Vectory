// Real App/library, isolated synthetic HTTP transport. Never uses preview credentials.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { configuredChannels } from "./notification-fixtures.mjs";
import { slimOverview } from "./fleet-replies.mjs";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Any free port: parallel runs never collide.
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_LIBRARY_COMPONENT_OUTPUT ||
    ".local/pipeline-library-component",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:pipeline-library-fixture";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {} },
  plugins: [
    {
      name: "pipeline-library-session-fixture",
      resolveId(id) {
        if (id === "virtual:pipeline-library-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react'; import {createRoot} from 'react-dom/client'; import App from '/src/App.tsx'; import '/src/styles.css'; createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__library-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              "/__library-fixture",
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic library session verification</title></head><body><div id="root"></div><script type="module">import "virtual:pipeline-library-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
await context.addInitScript(() => {
  window.__pendingFileReads = [];
  const originalRead = File.prototype.arrayBuffer;
  File.prototype.arrayBuffer = function () {
    if (this.name.startsWith("delayed-"))
      return new Promise((resolve) =>
        window.__pendingFileReads.push({
          name: this.name,
          resolve: () => originalRead.call(this).then(resolve),
        }),
      );
    return originalRead.call(this);
  };
});
const errors = [],
  requests = [],
  creationPosts = [],
  unexpected = [],
  results = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && /Maximum update depth/.test(message.text()))
    errors.push(message.text());
});
const user = (id) => ({
  id,
  name: `Synthetic ${id}`,
  email: `${id}@example.test`,
  role: "admin",
  enabled: true,
  revision: 1,
});
let signedIn = user("first"),
  nextLogin = user("second"),
  empty = false,
  failing = false,
  published = false,
  running = 2;
const failedRollout = {
  id: "00000000-0000-4000-8000-0000000000f4",
  name: null,
  configuration_id: "active-0",
  configuration_name: "Synthetic blue 00",
  version_id: "00000000-0000-4000-8000-0000000000e4",
  version_number: 4,
  policy: null,
  status: "failed",
  created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
  failed_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  target_count: 3,
  verified_count: 0,
  state_counts: { rolled_back: 1, pending: 2 },
};
const historyReads = [];
/** The first row, published as v4 while its devices run `running`. */
const publishedRow = (item) => ({
  ...item,
  assigned_devices: 3,
  running_versions: [
    {
      id: `00000000-0000-4000-8000-0000000000e${running}`,
      number: running,
      devices: 3,
    },
  ],
  latest_version: {
    id: failedRollout.version_id,
    number: 4,
    created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    author: "Synthetic",
    draft_changed: false,
  },
});
const records = [false, true].flatMap((archived) =>
  Array.from({ length: 13 }, (_, index) => ({
    id: `${archived ? "archived" : "active"}-${index}`,
    name: `Synthetic blue ${String(index).padStart(2, "0")}`,
    description: "Synthetic transport fixture; never deployed.",
    revision: 1,
    created_at: "2026-09-26T12:00:00Z",
    updated_at: "2026-09-26T12:00:00Z",
    archived,
    archived_at: archived ? "2026-09-26T12:00:00Z" : null,
    component_counts: { sources: 1, transforms: 0, sinks: 1 },
    latest_version: null,
  })),
);
await context.route("**/api/v1/**", async (route) => {
  const url = new URL(route.request().url()),
    method = route.request().method(),
    path = url.pathname.replace("/api/v1", "");
  const reply = (json, status = 200) => route.fulfill({ status, json });
  if (path === "/status")
    return reply({ initialized: true, version: "synthetic" });
  if (path === "/session")
    return signedIn
      ? reply({ user: signedIn, csrf_token: "synthetic-session-token" })
      : reply(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "Synthetic session ended",
            },
          },
          401,
        );
  if (path === "/logout" && method === "POST") {
    signedIn = null;
    return reply({ ok: true });
  }
  if (path === "/login" && method === "POST") {
    signedIn = nextLogin;
    return reply({ user: signedIn, csrf_token: "synthetic-login-token" });
  }
  if (path === "/settings")
    return reply({ instance_name: "Synthetic isolated library check" });
  if (path === "/overview")
    return reply(slimOverview([], { configurations_total: 26 }));
  // The Overview's first-run checklist asks whether agent downloads exist.
  if (path === "/releases") return reply([]);
  if (path.startsWith("/configurations/requests/") && method === "GET")
    return reply({ request_id: path.split("/").at(-1), found: false });
  if (path === "/configurations" && method === "POST") {
    creationPosts.push(JSON.parse(route.request().postData()));
    return reply(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Synthetic create request captured without saving",
        },
      },
      400,
    );
  }
  // An administrator's Overview asks whether a notification channel exists.
  if (path === "/notifications/channels") return reply(configuredChannels);
  if (path === "/configurations/library" && method === "GET") {
    const query = Object.fromEntries(url.searchParams);
    requests.push(query);
    if (query.page_size !== "12")
      throw Error("Library request is not bounded to 12");
    if (failing)
      return reply(
        {
          error: { code: "UNAVAILABLE", message: "Synthetic library outage" },
        },
        503,
      );
    let rows = empty
      ? []
      : records.filter(
          (item) =>
            item.archived === (query.state === "archived") &&
            item.name.toLowerCase().includes(query.search.toLowerCase()),
        );
    const direction = query.direction === "desc" ? -1 : 1;
    rows = [...rows].sort(
      (a, b) =>
        a.name.localeCompare(b.name) * (query.sort === "name" ? direction : 1),
    );
    const number = Number(query.page);
    return reply({
      items: rows
        .slice((number - 1) * 12, number * 12)
        .map((item, index) =>
          published && index === 0 && !item.archived
            ? publishedRow(item)
            : item,
        ),
      total: rows.length,
      page: number,
      page_size: 12,
    });
  }
  // Only a row whose latest version runs nowhere reads rollout history.
  if (path === "/deployments/history" && method === "GET") {
    const query = Object.fromEntries(url.searchParams);
    historyReads.push(query);
    return reply({
      items: query.status === "failed" ? [failedRollout] : [],
      total: query.status === "failed" ? 1 : 0,
      page: 1,
      page_size: Number(query.page_size),
    });
  }
  unexpected.push(`${method} ${path}`);
  return reply(
    {
      error: {
        code: "UNEXPECTED_FIXTURE_REQUEST",
        message: "Unexpected synthetic transport request",
      },
    },
    500,
  );
});
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
}
async function signOutAndIn() {
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  // Signing out no longer asks for confirmation.
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Sign in/ })).toBeVisible();
  await page.getByLabel("Email address", { exact: true }).fill(nextLogin.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-unused-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Pipelines", exact: true }),
  ).toBeVisible();
}
try {
  await page.goto(`http://127.0.0.1:${port}/__library-fixture#/configurations`);
  await expect(page.locator(".pipeline-library-table tbody tr")).toHaveCount(
    12,
  );
  await check(
    "pipeline action menus escape clipping and close on outside pointer or Escape without opening a pipeline",
    async () => {
      const triggers = page.getByRole("button", { name: /^Actions for / });
      const beforeUrl = page.url(),
        beforeRequests = requests.length;
      await triggers.nth(0).click();
      await expect(
        page.getByRole("menuitem", { name: "Duplicate pipeline", exact: true }),
      ).toBeVisible();
      const heading = await page
        .getByRole("heading", {
          name: "Pipelines",
          exact: true,
          includeHidden: true,
        })
        .boundingBox();
      await page.mouse.click(
        heading.x + heading.width / 2,
        heading.y + heading.height / 2,
      );
      await expect(page.getByRole("menu")).toHaveCount(0);
      await triggers.nth(3).click();
      await page
        .getByRole("menuitem", { name: "Duplicate pipeline", exact: true })
        .focus();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(triggers.nth(3)).toBeFocused();
      expect(page.url()).toBe(beforeUrl);
      expect(requests.length).toBe(beforeRequests);
      expect(unexpected).toEqual([]);
    },
  );
  await check(
    "under StrictMode the create dialog keeps focus through its development remount and returns it on close",
    async () => {
      const create = page
        .locator("main")
        .getByRole("button", { name: "Create pipeline", exact: true });
      await create.focus();
      await page.evaluate(() => {
        window.__focusTrail = [];
        document.addEventListener(
          "focusin",
          (event) =>
            window.__focusTrail.push(
              event.target.closest('[role="dialog"]')
                ? "dialog"
                : event.target.textContent.trim().slice(0, 40),
            ),
          true,
        );
      });
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: "Create pipeline",
        exact: true,
      });
      await expect(dialog.getByLabel("Pipeline name")).toBeFocused();
      // Radix hands focus back after a timeout; give a remount the chance.
      await delay(300);
      await expect(dialog.getByLabel("Pipeline name")).toBeFocused();
      const trail = await page.evaluate(() => window.__focusTrail);
      expect(trail, "focus never leaves the open dialog").toEqual(
        trail.map(() => "dialog"),
      );
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(create).toBeFocused();
      // A dialog mounted already open (a row's Duplicate) runs its own
      // effects twice as well; focus still stays inside it.
      await page
        .getByRole("button", { name: /^Actions for / })
        .first()
        .click();
      await page.evaluate(() => (window.__focusTrail = []));
      await page
        .getByRole("menuitem", { name: "Duplicate pipeline", exact: true })
        .click();
      const duplicate = page.getByRole("dialog", {
        name: "Duplicate pipeline",
        exact: true,
      });
      await expect(duplicate).toBeVisible();
      await delay(300);
      const after = await page.evaluate(() => window.__focusTrail);
      const entered = after.indexOf("dialog");
      expect(entered, "focus enters the duplicate dialog").toBeGreaterThan(-1);
      expect(
        after.slice(entered),
        "focus never leaves the duplicate dialog",
      ).toEqual(after.slice(entered).map(() => "dialog"));
      await duplicate
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(duplicate).toHaveCount(0);
      expect(unexpected).toEqual([]);
    },
  );
  await check(
    "the create dialog drops an error about the start once that start is fixed",
    async () => {
      await page
        .locator("main")
        .getByRole("button", { name: "Create pipeline", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Create pipeline",
        exact: true,
      });
      const complaint = "Choose a Vector configuration file to import.";
      const submit = dialog.getByRole("button", {
        name: "Create pipeline",
        exact: true,
      });
      await dialog.getByLabel("Pipeline name").fill("From a file");
      await dialog.getByText("Import a Vector config", { exact: true }).click();
      await submit.click();
      await expect(dialog).toContainText(complaint);
      // Choosing another start answers it.
      await dialog.getByText("Build a pipeline", { exact: true }).click();
      await expect(dialog).not.toContainText(complaint);
      await dialog.getByText("Import a Vector config", { exact: true }).click();
      await submit.click();
      await expect(dialog).toContainText(complaint);
      // So does pasting a configuration.
      await dialog
        .getByRole("button", { name: "Paste instead", exact: true })
        .click();
      await dialog
        .getByLabel("Vector configuration", { exact: true })
        .fill(
          '{"sources":{"a":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["a"]}}}',
        );
      await dialog
        .getByRole("button", { name: "Use this configuration", exact: true })
        .click();
      await expect(
        dialog.locator(".pipeline-start-import-result[role=status]"),
      ).toContainText("Pasted JSON");
      await expect(dialog).not.toContainText(complaint);
      await dialog.locator('input[type="file"]').setInputFiles([
        {
          name: "source.yaml",
          mimeType: "text/yaml",
          buffer: Buffer.from(
            "sources:\n  a:\n    type: demo_logs\n    format: json\n",
          ),
        },
        {
          name: "sink.json",
          mimeType: "application/json",
          buffer: Buffer.from(
            '{"sinks":{"out":{"type":"blackhole","inputs":["a"]}}}',
          ),
        },
      ]);
      await expect(
        dialog.locator(".pipeline-start-import-result[role=status]"),
      ).toContainText("2 configuration files");
      await expect(dialog.getByLabel("Pipeline name")).toHaveValue(
        "From a file",
      );
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(unexpected).toEqual([]);
    },
  );
  await check(
    "replacing a valid import blocks Create until the newest read finishes and submits only the new configuration",
    async () => {
      await page
        .locator("main")
        .getByRole("button", { name: "Create pipeline", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Create pipeline",
        exact: true,
      });
      const submit = dialog.getByRole("button", {
        name: "Create pipeline",
        exact: true,
      });
      const files = dialog.locator('input[type="file"]');
      const config = (source) =>
        JSON.stringify({
          sources: { [source]: { type: "demo_logs", format: "json" } },
          sinks: { output: { type: "blackhole", inputs: [source] } },
        });
      await dialog.getByText("Import a Vector config", { exact: true }).click();
      await files.setInputFiles({
        name: "previous.json",
        mimeType: "application/json",
        buffer: Buffer.from(config("previous")),
      });
      await expect(
        dialog.locator(".pipeline-start-import-result"),
      ).toContainText("previous.json");
      await expect(dialog.getByLabel("Pipeline name")).toHaveValue("previous");
      const before = creationPosts.length;
      await files.setInputFiles({
        name: "delayed-newer.json",
        mimeType: "application/json",
        buffer: Buffer.from(config("newer")),
      });
      await expect
        .poll(() => page.evaluate(() => window.__pendingFileReads.length))
        .toBe(1);
      await expect(
        dialog.locator(".pipeline-start-import-result"),
      ).toContainText("delayed-newer.json");
      await expect(
        dialog.locator(".pipeline-start-import-result"),
      ).not.toContainText("previous.json");
      await expect(submit).toBeDisabled();
      expect(creationPosts.length).toBe(before);
      await page.evaluate(() => window.__pendingFileReads.shift().resolve());
      await expect(
        dialog.locator(".pipeline-start-import-result"),
      ).toContainText("checked locally");
      await expect(dialog.getByLabel("Pipeline name")).toHaveValue(
        "delayed-newer",
      );
      await expect(submit).toBeEnabled();
      await submit.click();
      await expect.poll(() => creationPosts.length).toBe(before + 1);
      expect(creationPosts.at(-1).config.sources).toHaveProperty("newer");
      expect(creationPosts.at(-1).config.sources).not.toHaveProperty(
        "previous",
      );
      await expect(dialog).toContainText(
        "Synthetic create request captured without saving",
      );
      // A generic 400 does not prove another tab's identical request was not
      // saved. Review and dismiss the exact browser reminder before creating
      // a different pipeline in the next scenario.
      await expect(dialog).toContainText("Creation result needs confirmation");
      await dialog
        .getByRole("button", { name: "Close and review request", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      const saved = page.getByRole("dialog", {
        name: "Saved pipeline requests",
        exact: true,
      });
      await expect(saved).toContainText("delayed-newer");
      await saved.getByRole("button", { name: /delayed-newer/ }).click();
      const review = page.getByRole("dialog", {
        name: "Review pipeline request",
        exact: true,
      });
      await expect(review).toContainText("No completed request was found yet");
      await review
        .getByRole("button", { name: "Dismiss reminder", exact: true })
        .click();
      await page
        .getByRole("dialog", {
          name: "Dismiss this pipeline reminder?",
          exact: true,
        })
        .getByRole("button", { name: "Dismiss reminder", exact: true })
        .click();
      await expect(review).toHaveCount(0);
    },
  );
  await check(
    "switching start choice invalidates a pending file read and cannot restore it later",
    async () => {
      await page
        .locator("main")
        .getByRole("button", { name: "Create pipeline", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Create pipeline",
        exact: true,
      });
      await dialog.getByText("Import a Vector config", { exact: true }).click();
      await dialog.locator('input[type="file"]').setInputFiles({
        name: "delayed-late.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          '{"sources":{"late":{"type":"demo_logs","format":"json"}},"sinks":{"output":{"type":"blackhole","inputs":["late"]}}}',
        ),
      });
      await expect
        .poll(() => page.evaluate(() => window.__pendingFileReads.length))
        .toBe(1);
      await dialog
        .getByText("Try a synthetic example", { exact: true })
        .click();
      await expect(dialog.getByLabel("Pipeline name")).toHaveValue(
        "Synthetic demo",
      );
      await page.evaluate(() => window.__pendingFileReads.shift().resolve());
      await delay(100);
      await dialog.getByText("Import a Vector config", { exact: true }).click();
      await expect(dialog.locator(".pipeline-start-import-result")).toHaveCount(
        0,
      );
      await expect(dialog.getByLabel("Pipeline name")).toHaveValue("");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    },
  );
  await check(
    "real App preserves search, archive filter, sort and page across library remount",
    async () => {
      await page.getByLabel("Search pipelines").fill("blue");
      await page
        .getByRole("button", { name: "Filter Status", exact: true })
        .click();
      await page
        .getByRole("radio", { name: "Archived pipelines", exact: true })
        .click();
      await page.getByRole("button", { name: /^Sort by Pipeline/ }).click();
      await expect.poll(() => requests.at(-1)?.sort).toBe("name");
      expect(requests.at(-1).direction).toBe("asc");
      await expect(
        page.locator(".pipeline-library-table tbody tr"),
      ).toHaveCount(12);
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(
        page.locator(".pipeline-library-table tbody tr"),
      ).toHaveCount(1);
      await page.getByRole("link", { name: "Overview", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Overview", exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Pipelines", exact: true }).click();
      await expect(page.getByLabel("Search pipelines")).toHaveValue("blue");
      await expect(
        page.getByRole("button", {
          name: "Filter Status (active)",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("columnheader", { name: /Sort by Pipeline/ }),
      ).toHaveAttribute("aria-sort", "ascending");
      expect(requests.at(-1)).toMatchObject({
        state: "archived",
        sort: "name",
        direction: "asc",
        page: "2",
      });
      await expect(page.locator(".pagination")).toContainText("2 / 2");
      await expect(
        page.locator(".pipeline-library-table tbody tr"),
      ).toHaveCount(1);
    },
  );
  await check(
    "same-user profile refresh preserves query without a render or request loop",
    async () => {
      signedIn = { ...signedIn, name: "Synthetic renamed first", revision: 2 };
      const before = requests.length;
      const refreshed = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/v1/session",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await refreshed;
      await delay(500);
      expect(requests.length).toBe(before);
      await expect(page.locator(".pagination")).toContainText("2 / 2");
      await expect(page.getByLabel("Search pipelines")).toHaveValue("blue");
    },
  );
  await check(
    "signout clears discovery context before a different account signs in",
    async () => {
      await signOutAndIn();
      await expect(page.getByLabel("Search pipelines")).toHaveValue("");
      await expect(
        page.getByRole("button", { name: "Filter Status", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("columnheader", { name: /Sort by Updated/ }),
      ).toHaveAttribute("aria-sort", "descending");
      expect(requests.at(-1)).toMatchObject({
        state: "active",
        sort: "updated",
        page: "1",
      });
      await expect(page.locator(".pagination")).toContainText("1 / 2");
      await page.getByLabel("Search pipelines").fill("blue");
      await expect.poll(() => requests.at(-1)?.search).toBe("blue");
      nextLogin = user("second");
      await signOutAndIn();
      await expect(page.getByLabel("Search pipelines")).toHaveValue("");
    },
  );
  await check(
    "a failed refresh keeps the pipelines dimmed under one message with Retry, the header says so, and phones get cards",
    async () => {
      const rows = page.locator(".pipeline-library-table tbody tr");
      await expect(rows).toHaveCount(12);
      failing = true;
      await page
        .getByRole("button", { name: "Refresh now", exact: true })
        .click();
      const alert = page.getByRole("alert").filter({
        hasText: "Couldn't refresh pipelines.",
      });
      await expect(alert).toContainText("Showing data from");
      await expect(rows).toHaveCount(12);
      await expect(page.locator(".pipeline-library-table")).toHaveAttribute(
        "data-stale",
        "",
      );
      await expect(page.locator(".live-status")).toContainText(
        "Stale · last update",
      );
      await page.screenshot({
        path: resolve(output, "stale-desktop.png"),
        animations: "disabled",
      });
      failing = false;
      await alert.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(alert).toHaveCount(0);
      await expect(page.locator(".live-status")).toContainText("Updated");
      // Phones read the list as cards: name, published state and where it runs.
      await page.setViewportSize({ width: 390, height: 844 });
      const cards = page
        .getByRole("list", { name: "Pipeline library", exact: true })
        .locator("li.data-list-item");
      await expect(cards).toHaveCount(12);
      await expect(cards.first()).toContainText("Not published");
      await expect(cards.first().getByRole("link")).toHaveAttribute(
        "href",
        /^#\/configurations\//,
      );
      const appearance = await page.evaluate(
        () => document.documentElement.dataset.theme ?? null,
      );
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme,
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: resolve(output, `mobile-${theme}.png`),
          animations: "disabled",
        });
      }
      await page.evaluate((theme) => {
        if (theme === null) delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = theme;
      }, appearance);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(rows).toHaveCount(12);
    },
  );
  await check(
    "a row whose latest version no device runs says how its newest rollout ended, linked to it, on desktop and phone",
    async () => {
      // Rows that publish nothing read no rollout history.
      expect(historyReads).toEqual([]);
      published = true;
      await page
        .getByRole("button", { name: "Refresh now", exact: true })
        .click();
      const first = page.locator(".pipeline-library-table tbody tr").first();
      await expect(first).toContainText(
        "Running v2 on 3 of 3 · v4 not running",
      );
      const outcome = first.getByRole("link", {
        name: "v4 failed on 1 device",
      });
      await expect(outcome).toHaveAttribute(
        "href",
        `#/deployments/${failedRollout.id}`,
      );
      await expect(first.locator(".pipeline-status-outcome")).toContainText(
        /v4 failed on 1 device · 1[12]m ago/,
      );
      // Bounded: the newest 20 of each ending, and nothing else.
      await expect
        .poll(() =>
          historyReads
            .map(({ status, page: n, page_size }) => [status, n, page_size])
            .sort(),
        )
        .toEqual([
          ["failed", "1", "20"],
          ["rolled_back", "1", "20"],
        ]);
      // Other rows stay as they were.
      await expect(
        page.locator(".pipeline-library-table tbody tr").nth(1),
      ).not.toContainText("failed on");
      // Phones read the same line in the card.
      await page.setViewportSize({ width: 390, height: 844 });
      const card = page
        .getByRole("list", { name: "Pipeline library", exact: true })
        .locator("li.data-list-item")
        .first();
      await expect(
        card.getByRole("link", { name: "v4 failed on 1 device" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: resolve(output, "outcome-mobile.png"),
        animations: "disabled",
      });
      // Once the devices run that version, the row says nothing about the failure.
      running = 4;
      await page.setViewportSize({ width: 1280, height: 900 });
      await page
        .getByRole("button", { name: "Refresh now", exact: true })
        .click();
      await expect(
        page.locator(".pipeline-library-table tbody tr").first(),
      ).toContainText("Running v4 on 3 of 3");
      await expect(page.locator(".pipeline-status-outcome")).toHaveCount(0);
      published = false;
      running = 2;
      await page
        .getByRole("button", { name: "Refresh now", exact: true })
        .click();
      await expect(
        page.locator(".pipeline-library-table tbody tr").first(),
      ).toContainText("Not published");
    },
  );
  await check(
    "whitespace-only search uses the unfiltered empty-library guidance",
    async () => {
      empty = true;
      await page.getByLabel("Search pipelines").fill("   ");
      await page
        .getByRole("button", { name: "Refresh now", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Create your first pipeline",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: "No matching pipelines",
          exact: true,
        }),
      ).toHaveCount(0);
      expect(requests.at(-1).search).toBe("");
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  const source_sha256 = {};
  for (const file of [
    "src/PipelineLibrary.tsx",
    "src/DataTable.tsx",
    "src/dataTableModel.ts",
    "src/data-table.css",
    "src/pipeline-library.css",
  ])
    source_sha256[`dashboard/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, file)))
      .digest("hex");
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      {
        scope:
          "Real App and library with isolated synthetic HTTP transport. No production backend or credentials.",
        recorded_at: new Date().toISOString(),
        source_sha256,
        results,
        errors,
        unexpected,
        library_requests: requests.length,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: results.length,
      request_count: requests.length,
      errors: errors.length,
      evidence: relative(repository, resolve(output, "results.json")),
    }),
  );
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
