// Real App/library, isolated synthetic HTTP transport. Never uses preview credentials.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { configuredChannels } from "./notification-fixtures.mjs";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  server: { host: "127.0.0.1", port: 5196, strictPort: true, proxy: {} },
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
const errors = [],
  requests = [],
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
  empty = false;
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
    return reply({
      devices_total: 0,
      devices_online: 0,
      configurations_total: 26,
      deployments_active: 0,
      issues_open: 0,
      devices: [],
      recent_activity: [],
    });
  // The Overview's first-run checklist asks whether agent downloads exist.
  if (path === "/releases") return reply([]);
  // An administrator's Overview asks whether a notification channel exists.
  if (path === "/notifications/channels") return reply(configuredChannels);
  if (path === "/configurations/library" && method === "GET") {
    const query = Object.fromEntries(url.searchParams);
    requests.push(query);
    if (query.page_size !== "12")
      throw Error("Library request is not bounded to 12");
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
      items: rows.slice((number - 1) * 12, number * 12),
      total: rows.length,
      page: number,
      page_size: 12,
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
  await page.goto("http://127.0.0.1:5196/__library-fixture#/configurations");
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
    "whitespace-only search uses the unfiltered empty-library guidance",
    async () => {
      empty = true;
      await page.getByLabel("Search pipelines").fill("   ");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
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
