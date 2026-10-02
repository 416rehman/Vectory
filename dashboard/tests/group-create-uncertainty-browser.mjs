// Regression check: a group create whose response is lost never becomes a second
// group by itself. Actual App, synthetic group transport.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { fleetReplies, fulfillFleetRead } from "./fleet-replies.mjs";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_GROUP_CREATE_UNCERTAINTY_OUTPUT ||
    ".local/group-create-uncertainty-ui",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/GroupEditor.tsx",
  "dashboard/src/GroupRecovery.tsx",
  "dashboard/src/groupRequests.ts",
  "dashboard/src/group-editor.css",
  "dashboard/src/deploymentRouting.ts",
  "dashboard/src/api.ts",
  "dashboard/src/Fleet.tsx",
  "dashboard/src/DataTable.tsx",
  "server/src/api.rs",
  "server/src/groups.rs",
  "dashboard/tests/group-create-uncertainty-browser.mjs",
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
const virtual = "\0virtual:group-create-uncertainty";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "group-create-uncertainty",
      resolveId(id) {
        if (id === "virtual:group-create-uncertainty") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__group-create-uncertainty")
            return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic group-create uncertainty check</title></head><body><div id="root"></div><script type="module">import "virtual:group-create-uncertainty";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = "http://127.0.0.1:" + port;
const browser = await chromium.launch();
const id = (n) => "11111111-2222-4333-8444-" + String(n).padStart(12, "0");
const context = await browser.newContext({
  viewport: { width: 899, height: 950 },
  reducedMotion: "reduce",
});
const requests = [],
  groups = [],
  errors = [];
let loseResponse = true;
const fleet = fleetReplies({ devices: [], groups: () => groups });
await context.addInitScript(() => {
  localStorage.setItem("vectory-theme", "light");
  localStorage.setItem("vectory-sidebar-collapsed", "true");
});
await context.route("**/*", async (route) => {
  const request = route.request(),
    url = new URL(request.url());
  if (url.origin !== origin) {
    errors.push("External request");
    return route.abort();
  }
  if (!url.pathname.startsWith("/api/v1/")) return route.continue();
  const path = url.pathname.slice(7),
    method = request.method();
  requests.push({
    path,
    method,
    body: method === "GET" ? null : request.postDataJSON(),
  });
  // Pages of devices, one device, and the groups without their members.
  if (await fulfillFleetRead(fleet, route)) return;
  if (method === "GET" && path === "/status")
    return route.fulfill({ json: { initialized: true, version: "synthetic" } });
  if (method === "GET" && path === "/session")
    return route.fulfill({
      json: {
        user: {
          id: id(99),
          name: "Synthetic operator",
          email: "fixture@example.test",
          role: "operator",
          enabled: true,
          revision: 1,
        },
        csrf_token: "synthetic",
      },
    });
  if (method === "GET" && path === "/devices")
    return route.fulfill({ json: [] });
  if (method === "GET" && path === "/groups")
    return route.fulfill({ json: groups });
  // The server remembers each create request by its key: a lookup by that key
  // says whether it was ever committed.
  if (method === "GET" && path === "/groups/requests")
    return route.fulfill({
      json: {
        items: groups.map((group) => ({
          request_id: group.request_id,
          group_id: group.id,
          group_name: group.name,
          created_at: group.created_at,
        })),
        total: groups.length,
        page: 1,
        page_size: 12,
      },
    });
  if (method === "GET" && path.startsWith("/groups/requests/")) {
    const requestId = path.split("/").pop();
    const saved = groups.find((group) => group.request_id === requestId);
    return route.fulfill({
      json: saved
        ? { request_id: requestId, found: true, group: saved }
        : { request_id: requestId, found: false },
    });
  }
  if (method === "POST" && path === "/groups") {
    const body = request.postDataJSON();
    // The same key with the same payload returns the group already created.
    const existing = groups.find(
      (group) => group.request_id === body.request_id,
    );
    const saved = existing || {
      ...body,
      id: id(100 + groups.length),
      revision: 1,
      created_at: "2026-09-27T12:00:00Z",
    };
    if (!existing) groups.push(saved);
    if (loseResponse) {
      loseResponse = false;
      return route.abort("failed");
    }
    return route.fulfill({ json: saved });
  }
  errors.push("Unexpected " + method + " " + path);
  return route.fulfill({
    status: 500,
    json: { error: { code: "UNEXPECTED", message: path } },
  });
});
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.on("pageerror", (e) => errors.push(e.message));
const name = "Synthetic uncertain group";
const writes = () => requests.filter((r) => r.method !== "GET");
const create = () =>
  page
    .getByRole("dialog")
    .getByRole("button", { name: "Create group", exact: true });
let passed = false,
  failure = null,
  storage = null;
try {
  await page.goto(origin + "/__group-create-uncertainty#/groups");
  await expect(
    page.getByRole("heading", { name: "Groups", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create group", exact: true })
    .first()
    .click();
  await page.getByRole("textbox", { name: "Group name" }).fill(name);
  await create().click();
  // The create was committed and its answer lost: the form says so and can't
  // be sent again.
  await expect(
    page.getByRole("region", { name: "Review group changes" }),
  ).toContainText("Save could not be confirmed");
  await expect(create()).toBeDisabled();
  expect(writes()).toHaveLength(1);
  expect(writes()[0].body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(groups).toHaveLength(1);
  await page.screenshot({ path: resolve(output, "uncertain-create.png") });
  storage = await page.evaluate(() => ({
    local_group_keys: Object.keys(localStorage).filter((k) =>
      k.includes("group"),
    ),
    session_group_keys: Object.keys(sessionStorage).filter((k) =>
      k.includes("group"),
    ),
  }));
  // The browser keeps a reminder of the unconfirmed request.
  expect(storage.local_group_keys.length).toBeGreaterThan(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const reminder = page
    .getByRole("status")
    .filter({ hasText: "1 group request needs confirmation." });
  await expect(reminder).toBeVisible();
  expect(writes()).toHaveLength(1);
  // The reminder survives a reload.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Groups", exact: true }),
  ).toBeVisible();
  await expect(reminder).toBeVisible();
  await expect(
    page.getByText("Save could not be confirmed", { exact: true }),
  ).toHaveCount(0);
  // Creating another group is blocked until the saved request is reviewed: a
  // lost answer never becomes a second group by itself.
  await expect(
    page.getByRole("button", { name: "Create group", exact: true }).first(),
  ).toBeDisabled();
  await page.screenshot({
    path: resolve(output, "second-create-blocked.png"),
  });
  expect(writes()).toHaveLength(1);
  expect(groups).toHaveLength(1);
  // Reviewing the request reads its status and finds the group the server made.
  await page
    .getByRole("button", { name: "Review group requests", exact: true })
    .click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(
    page.getByRole("heading", { name: "Group confirmed" }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(output, "confirmed.png") });
  expect(
    requests.filter((r) => r.path.startsWith("/groups/requests/")).length,
  ).toBeGreaterThanOrEqual(2);
  expect(writes()).toHaveLength(1);
  expect(groups).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(reminder).toHaveCount(0);
  expect(errors).toEqual([]);
  passed = true;
} catch (e) {
  failure = e.message;
} finally {
  await context.close();
  await browser.close();
  await server.close();
  const current = await hashes();
  const report = {
    recorded_at: new Date().toISOString(),
    passed,
    scope:
      "Regression check on actual App/Groups/GroupEditor with synthetic intercepted HTTP. A committed create's response is lost. The form blocks a second submission, the browser keeps a reminder of the unconfirmed request across a reload, another create is blocked until that request is reviewed, and reviewing it reads its status and finds the one group the server made, so no second group is created. Backend idempotency is covered by the server tests, not established by this synthetic transport.",
    error: failure,
    requests,
    created_groups: groups,
    storage,
    source_sha256: loaded,
    current_source_sha256: current,
    source_changed_during_run: Object.keys(current).filter(
      (p) => current[p] !== loaded[p],
    ),
    screenshots: [
      "uncertain-create.png",
      "second-create-blocked.png",
      "confirmed.png",
    ],
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    passed
      ? "PASS a lost group-create answer never creates a second group by itself"
      : "FAIL " + failure,
  );
  if (!passed) process.exitCode = 1;
}
