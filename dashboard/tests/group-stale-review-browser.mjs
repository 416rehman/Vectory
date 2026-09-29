// Before-fix investigation: actual Groups component, synthetic shared transport only.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(root, ".local/group-stale-review");
await mkdir(output, { recursive: true });
const virtual = "\0virtual:group-stale-review";
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "group-stale-review",
      resolveId(id) {
        if (id === "virtual:group-stale-review") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `import React from 'react';import{createRoot}from'react-dom/client';import{Groups}from'/src/Fleet.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';setCSRF('synthetic');window.notices=[];createRoot(document.getElementById('root')).render(React.createElement(Groups,{user:{id:'00000000-0000-4000-8000-000000000090',name:'Synthetic operator',email:'operator@example.test',role:'operator',enabled:true,revision:1},notify:m=>window.notices.push(m)}));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__group-stale-review") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic group stale-edit reproduction</title></head><body><main style="padding:24px"><div id="root"></div></main><script type="module">import "virtual:group-stale-review";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const devices = [1, 2].map((n) => ({
  id: id(n),
  name: `Synthetic edge ${n}`,
  os: "windows",
  arch: "amd64",
  status: "online",
  apply_state: "verified_applied",
  desired_generation: 1,
  reported_generation: 1,
  last_seen: new Date().toISOString(),
  labels: {},
}));
let group = {
  id: id(10),
  name: "Synthetic production group",
  description: "Original description",
  device_ids: [id(1)],
};
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1100, height: 900 },
});
const requests = [],
  errors = [],
  observations = [];
let failure;
await context.route("**/*", async (route) => {
  const req = route.request(),
    url = new URL(req.url());
  if (url.origin !== origin) throw Error("External request refused");
  if (!url.pathname.startsWith("/api/v1/")) return route.continue();
  const path = url.pathname.slice(7),
    method = req.method();
  requests.push({ path, method });
  if (method === "GET" && path === "/devices")
    return route.fulfill({ json: devices });
  // The group overview lists assignments; member edits preview their effects.
  if (method === "GET" && path === "/deployments/history")
    return route.fulfill({
      json: { items: [], total: 0, page: 1, page_size: 12 },
    });
  if (method === "POST" && path === "/groups/membership-preview") {
    const body = req.postDataJSON();
    return route.fulfill({
      json: {
        group_id: body.group_id,
        revision: body.revision,
        stale: false,
        ready: true,
        blockers: [],
        devices: [],
      },
    });
  }
  if (method === "GET" && path === "/groups")
    return route.fulfill({ json: [group] });
  if (method === "PUT" && path === `/groups/${group.id}`) {
    const body = req.postDataJSON();
    observations.push({ before: structuredClone(group), submitted: body });
    group = { id: group.id, ...body };
    return route.fulfill({ json: group });
  }
  throw Error(`Unexpected request ${method} ${path}`);
});
try {
  const tabs = await Promise.all([context.newPage(), context.newPage()]);
  for (const page of tabs) {
    page.setDefaultTimeout(7000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/__group-stale-review");
    await page
      .getByRole("button", {
        name: "Synthetic production group Original description",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("tab", { name: "Edit members", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: /Synthetic edge 1/ }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: /Synthetic edge 2/ }),
    ).not.toBeChecked();
  }
  await tabs[0].getByRole("checkbox", { name: /Synthetic edge 2/ }).check();
  await tabs[0]
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(tabs[0].getByRole("dialog")).toHaveCount(0);
  expect(group.device_ids).toEqual([id(1), id(2)]);
  await tabs[1]
    .getByLabel("Description (optional)", { exact: true })
    .fill("Description edited by second operator");
  await tabs[1].screenshot({
    path: resolve(output, "stale-dialog-before-submit.png"),
  });
  await tabs[1]
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(tabs[1].getByRole("dialog")).toHaveCount(0);
  expect(observations).toHaveLength(2);
  expect(observations[1].before.device_ids).toEqual([id(1), id(2)]);
  expect(observations[1].submitted.device_ids).toEqual([id(1)]);
  expect(observations[1].submitted).not.toHaveProperty("revision");
  expect(group.device_ids).toEqual([id(1)]);
  expect(await tabs[1].evaluate(() => window.notices)).toContain(
    "Group saved.",
  );
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
} finally {
  const source_sha256 = {};
  for (const path of [
    "dashboard/src/Fleet.tsx",
    "dashboard/src/api.ts",
    "server/src/api.rs",
    "server/src/rollout.rs",
    "contracts/CONTRACT.md",
    "dashboard/tests/group-stale-review-browser.mjs",
  ])
    source_sha256[path] = createHash("sha256")
      .update(await readFile(resolve(root, path)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        passed: !failure,
        scope:
          "Expected-defect reproduction: two actual Groups component tabs with shared intercepted synthetic transport. Proves stale membership submission and unqualified success UI; does not independently prove SQLite behavior or real deployment effects. No preview access, credentials or live writes.",
        observed_defect: !failure
          ? "A description-only edit from an older modal sends the old full device list, removes the peer-added device and reports Group saved without stale-review protection."
          : null,
        observations,
        final_group: group,
        requests,
        errors,
        source_sha256,
        ...(failure ? { failure: failure.message } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await server.close();
}
if (failure) throw failure;
console.log(
  "Reproduced stale group membership overwrite; evidence .local/group-stale-review/report.json",
);
