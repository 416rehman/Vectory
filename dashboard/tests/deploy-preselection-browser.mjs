// Actual deploy dialog and editor; all HTTP is intercepted synthetic data. A
// pipeline that already runs starts its deployment from the devices that run
// it: the dialog names them in one line, "Change" opens the list, "Clear"
// empties the choice, and nothing is chosen for the person who already chose.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { fleetReplies, fulfillFleetRead } from "./fleet-replies.mjs";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_DEPLOY_PRESELECTION_OUTPUT ||
    ".local/deploy-preselection",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:deploy-preselection";
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const server = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "isolated-deploy-preselection",
      resolveId(id) {
        if (id === "virtual:deploy-preselection") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import TargetDialog from'/src/TargetDialog.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';setCSRF('synthetic');const root=createRoot(document.getElementById('root'));let key=0;window.mount=(name,props={})=>{window.fixtureClosed=false;root.render(name==='app'?React.createElement(App,{key:++key}):React.createElement(TargetDialog,{key:++key,onDone:()=>{},onClose:()=>window.fixtureClosed=true,...props}));};window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__deploy-preselection") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic deployment verification</title></head><body><div id="root"></div><script type="module">import "virtual:deploy-preselection";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const created = "2026-09-27T12:00:00Z";
const policy = {
  heartbeat_seconds: 60,
  sync_paused: false,
  telemetry_enabled: true,
};
const config = {
  sources: { seed: { type: "demo_logs", format: "json" } },
  sinks: { discard: { type: "blackhole", inputs: ["seed"] } },
};
const pipeline = {
  id: id(10),
  name: "Edge syslog processing",
  description: "Never sent to a real device",
  revision: 1,
  archived: false,
  archived_at: null,
  created_at: created,
  updated_at: created,
  config,
  graph: { nodes: [], edges: [] },
};
const version = (number) => ({
  id: id(10 + number),
  configuration_id: pipeline.id,
  number,
  config,
  graph: pipeline.graph,
  sha256: String(number).repeat(64).slice(0, 64),
  artifact: JSON.stringify(config),
  size: JSON.stringify(config).length,
  created_at: created,
  message: `Synthetic version ${number}`,
  validation: { valid: true },
});
const v1 = version(1),
  v2 = version(2);
const otherVersion = {
  id: id(31),
  configuration_id: id(40),
  number: 1,
};
function device(n, name, versionId, extra = {}) {
  return {
    id: id(100 + n),
    name,
    os: "linux",
    arch: "amd64",
    vector_version: "0.58.0",
    agent_version: "synthetic",
    status: versionId ? "verified" : "unmanaged",
    apply_state: versionId ? "verified_applied" : "unmanaged",
    desired_generation: versionId ? 1 : 0,
    reported_generation: versionId ? 1 : 0,
    desired_version_id: versionId || null,
    configuration_mode: "full",
    labels: {},
    sync_paused: false,
    local_paused: false,
    effective_policy: policy,
    created_at: created,
    ...extra,
  };
}
const results = [],
  requests = [],
  unexpected = [],
  errors = [],
  accessibility = [],
  measurements = [];
let context, page, state, failure;
const edge = [
  device(1, "edge-1", v1.id),
  device(2, "edge-2", v1.id),
  device(3, "edge-3", v2.id),
];
const fleet = () => [
  ...edge,
  device(4, "lab-1", null),
  device(5, "lab-2", otherVersion.id),
  device(6, "retired-edge", v1.id, { status: "revoked" }),
];

async function load({
  mountAs = "target",
  width = 899,
  theme = "light",
  devices = fleet(),
  props = {},
  telemetry = "answer",
} = {}) {
  if (context) await context.close();
  state = {
    devices,
    telemetry,
    telemetryReads: 0,
    releaseTelemetry: null,
    previews: [],
    idReads: 0,
  };
  const current = state;
  const groups = () => [
    {
      id: id(20),
      name: "Edge collectors",
      description: "Fixture only",
      device_ids: [id(101), id(102), id(103)],
    },
    {
      id: id(21),
      name: "Laboratory",
      description: "Fixture only",
      device_ids: [id(104), id(105)],
    },
  ];
  const replies = fleetReplies({
    devices: () => current.devices,
    groups,
    versions: [v1, v2, otherVersion],
  });
  context = await browser.newContext({
    viewport: { width, height: 920 },
    reducedMotion: "reduce",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
    localStorage.setItem("vectory-sidebar-collapsed", "true");
    localStorage.setItem("vectory.editor.auto-check", "off");
  }, theme);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    if (url.origin !== origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7);
    requests.push({ method, path, query: url.search });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === "GET") {
      if (path.startsWith("/deployments/requests/"))
        return reply({ request_id: path.split("/").at(-1), found: false });
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: id(90),
            name: "Synthetic administrator",
            email: "fixture@example.test",
            role: "admin",
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic deployment" });
      if (path === "/mfa") return reply({ enabled: false });
      if (path === `/configurations/${pipeline.id}/telemetry`) {
        current.telemetryReads++;
        if (current.telemetry === "fail")
          return reply(
            { error: { code: "UNAVAILABLE", message: "Synthetic outage" } },
            503,
          );
        if (current.telemetry === "hold")
          await new Promise((release) => (current.releaseTelemetry = release));
      }
      if (path === "/devices/inventory/ids") current.idReads++;
      if (await fulfillFleetRead(replies, route)) return;
      if (path === "/devices") return reply(current.devices);
      if (path === `/configurations/${pipeline.id}`) return reply(pipeline);
      if (path === `/configurations/${pipeline.id}/history`)
        return reply({
          items: [v2, v1].map((item) => ({
            id: item.id,
            configuration_id: pipeline.id,
            number: item.number,
            created_at: created,
          })),
          total: 2,
          page: 1,
          page_size: Number(url.searchParams.get("page_size")),
          kind: "versions",
        });
      if (path === `/versions/${v1.id}`) return reply(v1);
      if (path === `/versions/${v2.id}`) return reply(v2);
    }
    if (method === "POST" && path === "/deployments/preview") {
      const body = req.postDataJSON();
      current.previews.push(body);
      const selected = new Set(body.selector.device_ids);
      return reply({
        devices: current.devices.filter((d) => selected.has(d.id)),
        warnings: [],
        conflicts: [],
        create_idempotency: true,
        request_correlation: true,
        blockers: [],
        outcomes: current.devices
          .filter((d) => selected.has(d.id))
          .map((d) => ({
            device_id: d.id,
            resource: "configuration",
            outcome: "requested",
          })),
      });
    }
    unexpected.push(`${method} ${path}`);
    return reply(
      {
        error: {
          code: "UNEXPECTED_REQUEST",
          message: "Synthetic transport rejected request",
        },
      },
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    origin +
      "/__deploy-preselection" +
      (mountAs === "app" ? `#/configurations/${pipeline.id}` : ""),
  );
  await page.waitForFunction(() => window.ready);
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
  }, theme);
  await page.evaluate(
    ({ mountAs, v2, props }) =>
      window.mount(mountAs, {
        open: true,
        userId: "00000000-0000-4000-8000-000000000090",
        version: v2,
        pipelineName: "Edge syslog processing",
        ...props,
      }),
    { mountAs, v2, props },
  );
  return current;
}
const dialog = () =>
  page.getByRole("dialog").filter({ has: page.locator(".target-flow") });
const summary = () => dialog().locator(".target-running");
const change = () =>
  summary().getByRole("button", { name: "Change", exact: true });
const clear = () =>
  summary().getByRole("button", { name: "Clear", exact: true });
const search = () => dialog().getByLabel("Find targets", { exact: true });
const selectedLine = () => dialog().locator(".target-selection-summary");
const review = () =>
  dialog().getByRole("button", { name: "Review deployment", exact: true });
const reviewTable = () =>
  page.getByRole("table", { name: "Deployment review devices", exact: true });
async function check(name, run) {
  const focus = process.env.VECTORY_DEPLOY_PRESELECTION_FOCUS;
  if (focus && !name.toLowerCase().includes(focus.toLowerCase())) return;
  const began = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - began });
  console.log("PASS", name);
}
async function axe(label) {
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({
    label,
    violations: scan.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((n) => n.target),
    })),
  });
  expect(scan.violations, label).toEqual([]);
}
const edgeIds = () => edge.map((d) => d.id).sort();

try {
  await check(
    "a pipeline that runs on three devices starts from them: the title names the pipeline, one line says which devices, and reviewing sends exactly those",
    async () => {
      await load();
      await expect(
        dialog().getByRole("heading", {
          name: "Deploy Edge syslog processing v2",
          exact: true,
        }),
      ).toBeVisible();
      await expect(summary()).toBeVisible();
      // Two devices run v1, one runs v2: both versions are named, and the
      // group that holds all three, and neither the retired device nor the
      // devices that run nothing of this pipeline.
      await expect(summary()).toContainText(
        "Update the 3 devices running v1 and v2 (Edge collectors)",
      );
      await expect(change()).toBeVisible();
      await expect(clear()).toBeVisible();
      await expect(search()).toBeHidden();
      await expect(selectedLine()).toBeHidden();
      await expect(
        dialog().getByRole("checkbox", { name: /^Select / }),
      ).toHaveCount(0);
      // The buttons read as "Change" and "Clear" and say what they apply to.
      await expect(change()).toHaveAccessibleDescription(
        "Update the 3 devices running v1 and v2 (Edge collectors)",
      );
      await review().click();
      await expect(reviewTable()).toBeVisible();
      expect(state.previews).toHaveLength(1);
      expect([...state.previews[0].selector.device_ids].sort()).toEqual(
        edgeIds(),
      );
      expect(state.previews[0].selector.group_ids).toEqual([]);
      expect(state.previews[0].selector.exclude_ids).toEqual([]);
      expect(state.previews[0].version_id).toBe(v2.id);
      // A few devices come with their rows: one page per version, no ids read.
      expect(
        requests.filter((r) => r.path === "/devices/inventory"),
      ).not.toHaveLength(0);
      expect(state.idReads).toBe(0);
      expect(state.telemetryReads).toBe(1);
    },
  );
  await check(
    "Change opens the list with the same three devices chosen and puts the cursor in the search",
    async () => {
      await load();
      await change().click();
      await expect(summary()).toHaveCount(0);
      await expect(search()).toBeFocused();
      for (const name of ["edge-1", "edge-2", "edge-3"])
        await expect(
          dialog().getByRole("checkbox", {
            name: `Select ${name}`,
            exact: true,
          }),
        ).toBeChecked();
      for (const name of ["lab-1", "lab-2"])
        await expect(
          dialog().getByRole("checkbox", {
            name: `Select ${name}`,
            exact: true,
          }),
        ).not.toBeChecked();
      await expect(selectedLine()).toContainText("3 devices selected");
      // One more device by hand joins the choice.
      await dialog()
        .getByRole("checkbox", { name: "Select lab-1", exact: true })
        .check();
      await expect(selectedLine()).toContainText("4 devices selected");
    },
  );
  await check(
    "one click on Clear empties the choice and shows the list to choose from",
    async () => {
      await load();
      await clear().click();
      await expect(summary()).toHaveCount(0);
      await expect(search()).toBeFocused();
      await expect(selectedLine()).toContainText("0 devices selected");
      for (const name of ["edge-1", "edge-2", "edge-3"])
        await expect(
          dialog().getByRole("checkbox", {
            name: `Select ${name}`,
            exact: true,
          }),
        ).not.toBeChecked();
      await expect(review()).toBeVisible();
      // Back to the list never brings the summary back by itself.
      await page.waitForTimeout(400);
      await expect(summary()).toHaveCount(0);
      expect(state.previews).toEqual([]);
    },
  );
  await check(
    "a pipeline no device runs, or a title without its name, opens as before with nothing chosen",
    async () => {
      await load({
        devices: [
          device(4, "lab-1", null),
          device(5, "lab-2", otherVersion.id),
        ],
        props: { pipelineName: undefined },
      });
      await expect(
        dialog().getByRole("heading", {
          name: "Deploy version 2",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        dialog().getByRole("checkbox", { name: "Select lab-1", exact: true }),
      ).toBeVisible();
      await expect(selectedLine()).toContainText("0 devices selected");
      await expect(summary()).toHaveCount(0);
      expect(state.telemetryReads).toBe(1);
    },
  );
  await check(
    "devices named when the dialog opens, and agent settings, look up nothing",
    async () => {
      await load({ props: { initialDeviceIds: [id(104)] } });
      await expect(selectedLine()).toContainText("1 device selected");
      await expect(summary()).toHaveCount(0);
      expect(state.telemetryReads).toBe(0);
      await load({
        props: { version: undefined, policy, preserveExistingSettings: false },
      });
      await expect(
        dialog().getByRole("checkbox", { name: "Select lab-1", exact: true }),
      ).toBeVisible();
      await expect(summary()).toHaveCount(0);
      expect(state.telemetryReads).toBe(0);
    },
  );
  await check(
    "a choice made while the devices are being found is kept, and a failed lookup leaves the choice by hand without an error",
    async () => {
      await load({ telemetry: "hold" });
      await expect(
        dialog().getByRole("checkbox", { name: "Select lab-2", exact: true }),
      ).toBeVisible();
      await dialog()
        .getByRole("checkbox", { name: "Select lab-2", exact: true })
        .check();
      await expect(selectedLine()).toContainText("1 device selected");
      await expect.poll(() => state.releaseTelemetry !== null).toBe(true);
      state.releaseTelemetry();
      await page.waitForTimeout(600);
      await expect(summary()).toHaveCount(0);
      await expect(selectedLine()).toContainText("1 device selected");
      await expect(
        dialog().getByRole("checkbox", { name: "Select lab-2", exact: true }),
      ).toBeChecked();
      await load({ telemetry: "fail" });
      await expect(
        dialog().getByRole("checkbox", { name: "Select lab-1", exact: true }),
      ).toBeVisible();
      await page.waitForTimeout(400);
      await expect(summary()).toHaveCount(0);
      await expect(selectedLine()).toContainText("0 devices selected");
      await expect(dialog().getByRole("alert")).toHaveCount(0);
    },
  );
  await check(
    "more devices than a page names are chosen by id, the way Select all matching reads them, and a hundred and twenty are sent",
    async () => {
      const many = Array.from({ length: 120 }, (_, i) =>
        device(200 + i, `fleet-${String(i + 1).padStart(3, "0")}`, v1.id),
      );
      await load({ devices: [...many, device(4, "lab-1", null)] });
      await expect(summary()).toContainText(
        "Update the 120 devices running v1",
      );
      // No group holds all of them, so none is named.
      await expect(summary()).not.toContainText("(");
      expect(state.idReads).toBe(1);
      await review().click();
      await expect(reviewTable()).toBeVisible();
      expect(state.previews[0].selector.device_ids).toHaveLength(120);
      expect(new Set(state.previews[0].selector.device_ids).size).toBe(120);
    },
  );
  await check(
    "choosing devices from the editor's Choose devices opens the same dialog, named for the pipeline",
    async () => {
      await load({ mountAs: "app", width: 1280 });
      await page
        .getByRole("button", { name: "Choose devices", exact: true })
        .click();
      await expect(
        dialog().getByRole("heading", {
          name: "Deploy Edge syslog processing v2",
          exact: true,
        }),
      ).toBeVisible();
      await expect(summary()).toContainText(
        "Update the 3 devices running v1 and v2 (Edge collectors)",
      );
      await expect(summary().getByRole("button")).toHaveCount(2);
    },
  );
  await check(
    "the summary is readable and accessible at desktop and phone widths in both themes",
    async () => {
      for (const width of [899, 390])
        for (const theme of ["light", "dark"]) {
          await load({ width, theme });
          await expect(summary()).toBeVisible();
          await expect(
            dialog().getByRole("heading", {
              name: "Deploy Edge syslog processing v2",
              exact: true,
            }),
          ).toBeVisible();
          const fit = await page.evaluate(() => {
            const card = document.querySelector(".target-running");
            const box = card.getBoundingClientRect();
            const dialog = card
              .closest("[role=dialog]")
              .getBoundingClientRect();
            return {
              inside: box.left >= dialog.left && box.right <= dialog.right,
              horizontal: document.documentElement.scrollWidth <= innerWidth,
              height: box.height,
            };
          });
          measurements.push({ label: `summary ${width} ${theme}`, ...fit });
          expect(fit.inside).toBe(true);
          expect(fit.horizontal).toBe(true);
          await axe(`deployment summary ${width} ${theme}`);
          await page.screenshot({
            path: resolve(output, `summary-${width}-${theme}.png`),
            animations: "disabled",
          });
        }
    },
  );
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  if (failure && page && !page.isClosed())
    await page
      .screenshot({
        path: resolve(output, "failure.png"),
        animations: "disabled",
      })
      .catch(() => {});
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Actual deploy dialog and editor with isolated synthetic API. The devices that run a pipeline start its deployment; nothing is sent to a server, preview or device.",
        passed: !failure,
        results,
        accessibility,
        measurements,
        requests,
        errors,
        unexpected,
        ...(failure ? { failure: failure.message } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await context?.close();
  await browser.close();
  await server.close();
  console.log("Evidence:", relative(root, resolve(output, "report.json")));
}
