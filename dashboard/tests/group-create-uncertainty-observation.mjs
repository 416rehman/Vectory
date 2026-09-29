// Expected workflow-limit observation; actual App, synthetic group transport.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
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
  "dashboard/src/group-editor.css",
  "dashboard/src/deploymentRouting.ts",
  "dashboard/src/api.ts",
  "dashboard/src/Fleet.tsx",
  "dashboard/src/DataTable.tsx",
  "server/src/api.rs",
  "server/src/groups.rs",
  "dashboard/tests/group-create-uncertainty-observation.mjs",
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
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic group-create uncertainty observation</title></head><body><div id="root"></div><script type="module">import "virtual:group-create-uncertainty";</script></body></html>',
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
  if (method === "POST" && path === "/groups") {
    const saved = {
      ...request.postDataJSON(),
      id: id(100 + groups.length),
      revision: 1,
      created_at: "2026-09-27T12:00:00Z",
    };
    groups.push(saved);
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
let observed = false,
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
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create group", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Review group changes" }),
  ).toContainText("Save could not be confirmed");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Create group", exact: true }),
  ).toBeDisabled();
  expect(writes()).toHaveLength(1);
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
  await page
    .getByRole("button", { name: "Close and refresh groups", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  expect(writes()).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Groups", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Save could not be confirmed", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Create group", exact: true })
    .first()
    .click();
  await page.getByRole("textbox", { name: "Group name" }).fill(name);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Create group", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create group", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name, exact: true })).toHaveCount(2);
  expect(writes()).toHaveLength(2);
  expect(writes()[0].body).toEqual(writes()[1].body);
  expect(writes()[0].body).not.toHaveProperty("request_id");
  expect(groups[0].id).not.toBe(groups[1].id);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: resolve(output, "duplicate-after-explicit-new-create.png"),
  });
  observed = true;
} catch (e) {
  failure = e.message;
} finally {
  await context.close();
  await browser.close();
  await server.close();
  const current = await hashes();
  const report = {
    recorded_at: new Date().toISOString(),
    observation_reproduced: observed,
    correctness_test_count: 0,
    scope:
      "Separate expected workflow-limit observation on actual App/Groups/GroupEditor with synthetic intercepted HTTP. A committed fixture response is lost. Open-form duplicate submission is correctly blocked. A deliberate close/refresh/reload/new-create with the same payload can create another UUID; no automatic retry is claimed. Backend duplicate behavior is source-reviewed separately, not established by the synthetic transport.",
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
      "duplicate-after-explicit-new-create.png",
    ],
    source_boundary:
      "server/src/api.rs group create path allocates a fresh UUID and inserts/audits without deployment request registry; names are display metadata, not operation identity.",
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    observed
      ? "OBSERVATION reproduced (not acceptance)"
      : "OBSERVATION failed: " + failure,
  );
  if (!observed) process.exitCode = 1;
}
