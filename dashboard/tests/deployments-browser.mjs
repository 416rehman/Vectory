// Actual deployment components, isolated synthetic transport; no preview state or credentials.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_DEPLOYMENTS_COMPONENT_OUTPUT ||
    ".local/deployments-component",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:deployments-fixture";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port: 5197, strictPort: true, proxy: {} },
  plugins: [
    {
      name: "synthetic-deployments-fixture",
      resolveId(id) {
        if (id === "virtual:deployments-fixture") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import Deployments from '/src/Deployments.tsx';import '/src/styles.css';const root=createRoot(document.getElementById('root'));let key=0;window.renderDeployments=(props={})=>{window.lastNavigation='';window.notifications=[];root.render(React.createElement(Deployments,{key:++key,user:{id:'synthetic-admin',name:'Synthetic admin',email:'admin@example.test',role:'admin',enabled:true,revision:1},notify:message=>window.notifications.push(message),navigate:path=>window.lastNavigation=path,...props}));};window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__deployments-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              "/__deployments-fixture",
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic deployment verification</title></head><body><main style="padding:24px"><div id="root"></div></main><script type="module">import "virtual:deployments-fixture";</script></body></html>',
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
  viewport: { width: 1280, height: 960 },
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const requests = [],
  unexpected = [],
  errors = [],
  results = [],
  accessibility = [];
page.on("pageerror", (error) => errors.push(error.message));
const rollbackSourceId = "00000000-0000-4000-8000-000000000002";
const rollbackResultId = "00000000-0000-4000-8000-000000000102";
const rollbackVersionId = "00000000-0000-4000-8000-000000000202";
const rollbackPriorVersionId = "00000000-0000-4000-8000-000000000201";
const rollbackConfigurationId = "00000000-0000-4000-8000-000000000200";
const reviewToken = "b".repeat(64);
const summary = (index) => ({
  id: index === 2 ? rollbackSourceId : `d-${String(index).padStart(3, "0")}`,
  rollback_idempotency: true,
  rollback_review: true,
  request_correlation: true,
  name: `Synthetic deployment ${String(index).padStart(3, "0")}`,
  configuration_id:
    index === 2 ? rollbackConfigurationId : "synthetic-pipeline",
  configuration_name: "Synthetic logs",
  version_id: index === 2 ? rollbackVersionId : "synthetic-version",
  version_number: 3,
  policy: null,
  priority: 0,
  target_mode: "snapshot",
  status: index % 5 === 4 ? "failed" : "active",
  scheduled_at: index >= 49 ? "2026-10-01T12:00:00Z" : null,
  created_at: "2026-09-26T12:00:00Z",
  rollout: {
    kind: "canary",
    canary_size: 1,
    batch_size: 5,
    observation_seconds: 30,
    failure_threshold: 0,
  },
  target_count: 1001,
  verified_count: 990,
  state_counts: { verified_applied: 990, failed: 11 },
});
let records = Array.from({ length: 51 }, (_, index) => summary(index));
let targetOverrides = new Map();
records[49].status = "cancelled";
records[50].status = "missed";
const targets = (parent) =>
  Array.from({ length: 1001 }, (_, index) => ({
    device_id:
      parent === rollbackSourceId
        ? `00000000-0000-4000-8000-${String(index + 10000).padStart(12, "0")}`
        : `${parent}-device-${index}`,
    device_name: `${parent} synthetic device ${String(index).padStart(4, "0")}`,
    state: index % 100 === 0 ? "failed" : "verified_applied",
    generation: 2,
    error:
      index % 100 === 0 && !(parent === "d-004" && index === 0)
        ? "Vector validation failed"
        : null,
    original: true,
  }));
let delayedSearch = "",
  delayedTargetSearch = "",
  delayedSummary = "",
  failSummary = "",
  failTargets = "",
  postDelay = 0;
let heldResponses = [];
const envelope = (items, params) => {
  const number = Number(params.get("page")),
    size = Number(params.get("page_size"));
  expect(size, "Every browse request is limited to12").toBe(12);
  return {
    items: items.slice((number - 1) * size, number * size),
    total: items.length,
    page: number,
    page_size: size,
  };
};
await context.route("**/api/v1/**", async (route) => {
  const url = new URL(route.request().url()),
    path = url.pathname.replace("/api/v1", ""),
    method = route.request().method();
  requests.push({
    path,
    method,
    query: Object.fromEntries(url.searchParams),
    body: route.request().postDataJSON(),
  });
  const reply = async (json, status = 200) => {
    try {
      await route.fulfill({ status, json });
    } catch {
      /* Obsolete request may be aborted on component replacement. */
    }
  };
  if (path === "/deployments/history" && method === "GET") {
    let items = records.filter((item) =>
      item.name
        .toLowerCase()
        .includes((url.searchParams.get("search") || "").toLowerCase()),
    );
    const status = url.searchParams.get("status"),
      scheduled = url.searchParams.get("scheduled");
    if (status && status !== "all")
      items = items.filter((item) => item.status === status);
    if (scheduled !== null)
      items = items.filter(
        (item) => Boolean(item.scheduled_at) === (scheduled === "true"),
      );
    const sort = url.searchParams.get("sort"),
      direction = url.searchParams.get("direction") === "desc" ? -1 : 1;
    if (sort)
      items = [...items].sort((a, b) => {
        const key = sort === "verified" ? "verified_count" : sort;
        const x = a[key],
          y = b[key];
        return (
          (typeof x === "number"
            ? x - y
            : String(x || "").localeCompare(String(y || ""))) * direction ||
          a.id.localeCompare(b.id)
        );
      });
    const result = envelope(items, url.searchParams);
    if (delayedSearch && url.searchParams.get("search") === delayedSearch)
      await new Promise((resolve) => heldResponses.push(resolve));
    return reply(result);
  }
  const match = path.match(
    /^\/deployments\/([^/]+)\/(summary|rollout|targets|pause|resume|cancel|rollback-preview|rollback|unassign-preview|unassign|refresh-preview|refresh)$/,
  );
  if (match) {
    const [, id, action] = match;
    const item = records.find((record) => record.id === id);
    if (!item)
      return reply(
        {
          error: { code: "NOT_FOUND", message: "Synthetic deployment missing" },
        },
        404,
      );
    if (action === "summary" && method === "GET") {
      const result = structuredClone(item);
      if (delayedSummary === id)
        await new Promise((resolve) => heldResponses.push(resolve));
      if (failSummary === id) {
        failSummary = "";
        return reply(
          {
            error: {
              code: "UNAVAILABLE",
              message: "Synthetic summary unavailable",
            },
          },
          503,
        );
      }
      return reply(result);
    }
    if (action === "rollout" && method === "GET")
      return reply({
        deployment_id: id,
        status: item.status,
        evaluated_at: new Date().toISOString(),
        stages: [],
        failures: [],
        removed_count: 0,
        check_in_seconds: 60,
        next_admission_at: null,
      });
    if (action === "rollback-preview" && method === "GET")
      return reply({
        source_deployment_id: rollbackSourceId,
        source_version_id: rollbackVersionId,
        source_status: item.status,
        source_action: "cancel",
        previous_version_id: rollbackPriorVersionId,
        previous_version_number: 2,
        previous_configuration_id: rollbackConfigurationId,
        previous_configuration_name: "Synthetic logs",
        priority: item.priority + 1,
        eligible_devices: targets(id).map(({ device_id, device_name }) => ({
          device_id,
          device_name,
          artifact_sha256: "a".repeat(64),
        })),
        excluded_devices: [],
        blockers: [],
        review_token: reviewToken,
        ready: true,
      });
    if (action === "targets" && method === "GET") {
      if (failTargets === id) {
        failTargets = "";
        return reply(
          {
            error: {
              code: "UNAVAILABLE",
              message: "Synthetic device results unavailable",
            },
          },
          503,
        );
      }
      let items = (targetOverrides.get(id) || targets(id)).filter((item) =>
        item.device_name.includes(url.searchParams.get("search") || ""),
      );
      const state = url.searchParams.get("state");
      if (state && state !== "all")
        items = items.filter((item) => item.state === state);
      const sort = url.searchParams.get("sort"),
        direction = url.searchParams.get("direction") === "desc" ? -1 : 1;
      if (sort)
        items = [...items].sort(
          (a, b) =>
            String(a[sort] || "").localeCompare(String(b[sort] || "")) *
              direction || a.device_id.localeCompare(b.device_id),
        );
      const result = envelope(items, url.searchParams);
      if (
        delayedTargetSearch &&
        url.searchParams.get("search") === delayedTargetSearch
      )
        await new Promise((resolve) => heldResponses.push(resolve));
      return reply(result);
    }
    if (method === "POST") {
      if (postDelay) await delay(postDelay);
      if (action === "rollback")
        return reply({
          ...item,
          id: rollbackResultId,
          request_id: route.request().postDataJSON().request_id,
          operation: "rollback",
          source_deployment_id: id,
          version_id: rollbackPriorVersionId,
          name: "Synthetic rollback replacement",
          status: "active",
          selector: {
            device_ids: targets(id).map((target) => target.device_id),
            group_ids: [],
            exclude_ids: [],
          },
          targets: targets(id),
        });
      if (action === "unassign-preview")
        return reply({
          removal_review: true,
          source_deployment_id: id,
          source_status: item.status,
          resource: "configuration",
          ready: true,
          review_token: "e".repeat(64),
          blockers: [],
          devices: [{
            device_id: "00000000-0000-4000-8000-000000000200",
            device_name: "Synthetic affected device",
            effect: "unmanaged",
            before: { assignment_id: id, assignment_name: item.name, version_id: item.version_id, configuration_name: "Synthetic logs", version_number: 3, generation: 1, policy: null },
            after: { assignment_id: null, assignment_name: null, version_id: null, configuration_name: null, version_number: null, generation: 2, policy: null },
            pending_assignment_id: null,
            pending_assignment_name: null,
          }],
        });
      if (action === "refresh-preview")
        return reply({
          refresh_review: true,
          source_deployment_id: id,
          source_status: "scheduled",
          resource: "configuration",
          scheduled_at: "2026-10-01T12:00:00Z",
          ready: true,
          review_token: "b".repeat(64),
          saved_devices: [],
          devices: [
            {
              id: "00000000-0000-4000-8000-000000000200",
              name: "Synthetic affected device",
              status: "online",
            },
          ],
          warnings: [],
          blockers: [],
        });
      if (action === "refresh") {
        const body = route.request().postDataJSON();
        expect(body.review_token).toBe("b".repeat(64));
        return reply({
          ...item,
          status: "scheduled",
          selector: { device_ids: body.expected_device_ids, group_ids: [], exclude_ids: [] },
          targets: body.expected_device_ids.map(device_id => ({ device_id, state: "pending", generation: 0, error: null })),
        });
      }
      if (action === "pause") item.status = "paused";
      if (action === "resume") item.status = "active";
      if (action === "cancel") item.status = "cancelled";
      if (action === "unassign") {
        expect(route.request().postDataJSON()).toEqual({ review_token: "e".repeat(64) });
        item.status = "unassigned";
      }
      return reply({ ...item, targets: targets(id) });
    }
  }
  unexpected.push(`${method} ${path}`);
  return reply(
    {
      error: {
        code: "UNEXPECTED",
        message: "Unexpected synthetic transport request",
      },
    },
    500,
  );
});
const details = () =>
  page.getByRole("region", { name: "Deployment details", exact: true });
async function mount(props = {}, count = props.scheduled ? 2 : 12) {
  await page.evaluate((props) => window.renderDeployments(props), props);
  await expect(page.locator(".deployment-table tbody tr")).toHaveCount(count);
}
async function check(name, operation) {
  await operation();
  results.push({ name, passed: true });
  console.log("PASS", name);
}
async function open(index) {
  await page
    .getByRole("button", {
      name: `View details for Synthetic deployment ${String(index).padStart(3, "0")}`,
      exact: true,
    })
    .click();
}
async function closeDetails() {
  await details()
    .getByRole("button", { name: /^Back to (deployments|schedules)$/ })
    .click();
  await expect(details()).toHaveCount(0);
}
try {
  await page.goto("http://127.0.0.1:5197/__deployments-fixture");
  await page.waitForFunction(() => window.ready);
  await check(
    "initial browsing has one bounded summary request and no eager version, device or target hydration",
    async () => {
      await mount();
      expect(requests).toHaveLength(1);
      expect(requests[0].path).toBe("/deployments/history");
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await page.screenshot({
          path: resolve(output, `desktop-${theme}.png`),
          animations: "disabled",
        });
      }
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "light";
      });
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.locator(".pagination")).toContainText("2 / 5");
      await page
        .getByRole("button", { name: "Filter Status", exact: true })
        .click();
      await page
        .getByRole("radio", { name: "Failed", exact: true })
        .click();
      await expect(page.locator(".pagination")).toContainText("1 / 1");
      await expect(page.locator(".deployment-table tbody tr")).toHaveCount(9);
      expect(requests.at(-1).query.status).toBe("failed");
      expect(requests.at(-1).query.page).toBe("1");
    },
  );
  await check(
    "failed canaries explain that device retry does not restart or release the rollout",
    async () => {
      await mount();
      await open(4);
      await expect(details()).toContainText(
        /Retrying a device sends the same version again\. It doesn.t restart the rollout or release waiting devices\./,
      );
      await expect(
        details().getByRole("button", { name: "Resume", exact: true }),
      ).toHaveCount(0);
      await expect(
        details()
          .getByRole("row")
          .filter({ hasText: "d-004 synthetic device 0000" }),
      ).toContainText("Open device for details");
      await closeDetails();
    },
  );
  await check(
    "headers request global order before paging, preserve links, and remain usable with zero results",
    async () => {
      await mount();
      await page.getByRole("button", { name: /^Sort by Change/ }).click();
      await expect.poll(() => requests.at(-1).query.sort).toBe("name");
      expect(requests.at(-1).query.direction).toBe("asc");
      await expect(
        page.locator(".deployment-table tbody tr").first(),
      ).toContainText("Synthetic deployment 000");
      await page.getByRole("button", { name: /^Sort by Change/ }).click();
      await expect(
        page.locator(".deployment-table tbody tr").first(),
      ).toContainText("Synthetic deployment 050");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(
        page.locator(".deployment-table tbody tr").first(),
      ).toContainText("Synthetic deployment 038");
      expect(requests.at(-1).query).toMatchObject({
        sort: "name",
        direction: "desc",
        page: "2",
      });
      await expect(
        page.locator(".deployment-table tbody tr").first().getByRole("link"),
      ).toHaveAttribute("href", /sort=name&direction=desc/);
      await page.getByRole("button", { name: /^Sort by Devices/ }).click();
      await expect.poll(() => requests.at(-1).query.sort).toBe("verified");
      expect(requests.at(-1).query.page).toBe("1");
      await page
        .getByLabel("Search deployments", { exact: true })
        .fill("no such deployment");
      await expect(
        page.getByRole("heading", {
          name: "No matching deployments",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Filter Status", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Filter Status", exact: true })
        .click();
      await page
        .getByRole("radio", { name: "Failed", exact: true })
        .click();
      await expect.poll(() => requests.at(-1).query.status).toBe("failed");
      await expect(
        page.getByRole("button", {
          name: "Filter Status (active)",
          exact: true,
        }),
      ).toBeVisible();
      await mount();
      await open(0);
      await expect(
        details().locator(".deployment-targets tbody tr"),
      ).toHaveCount(12);
      await details()
        .getByRole("button", { name: /^Sort by Device,/ })
        .click();
      await expect(
        details().locator(".deployment-targets tbody tr").first(),
      ).toContainText("synthetic device 1000");
      const targetRequest = requests
        .filter((r) => r.path.endsWith("/targets"))
        .at(-1);
      expect(targetRequest.query).toMatchObject({
        sort: "device_name",
        direction: "desc",
        page: "1",
      });
      await details()
        .getByRole("button", { name: /^Sort by Progress/ })
        .click();
      await expect
        .poll(
          () =>
            requests.filter((r) => r.path.endsWith("/targets")).at(-1).query
              .sort,
        )
        .toBe("state");
      await closeDetails();
    },
  );
  await check(
    "a blocked schedule shows its reason and distinguishes unreleased devices from active waiting",
    async () => {
      const saved = records;
      const blocked = {
        ...summary(0),
        status: "failed",
        scheduled_at: "2026-09-27T09:00:00Z",
        rollout: { ...summary(0).rollout, kind: "all" },
        target_count: 2,
        verified_count: 0,
        state_counts: { blocked: 1, pending: 1 },
      };
      records = [blocked];
      targetOverrides.set(blocked.id, [
        {
          device_id: "synthetic-blocked",
          device_name: "Blocked synthetic device",
          state: "blocked",
          generation: 0,
          original: true,
          error:
            "Scheduled activation blocked by an active canary; pause or cancel it, then create a new reviewed deployment",
        },
        {
          device_id: "synthetic-unreleased",
          device_name: "Unreleased synthetic device",
          state: "pending",
          generation: 0,
          original: true,
          error: null,
        },
      ]);
      await mount({ scheduled: true }, 1);
      await open(0);
      const rows = details().locator(".deployment-targets tbody tr");
      await expect(rows).toHaveCount(2);
      await expect(
        rows.filter({ hasText: "Blocked synthetic device" }),
      ).toContainText("Blocked");
      await expect(
        rows.filter({ hasText: "Blocked synthetic device" }),
      ).toContainText("Scheduled activation blocked by an active canary");
      await expect(
        rows.filter({ hasText: "Unreleased synthetic device" }),
      ).toContainText("Not released");
      await expect(
        rows.filter({ hasText: "Unreleased synthetic device" }),
      ).toContainText("The rollout stopped before this device was released.");
      await expect(
        details().getByRole("button", { name: "Resume", exact: true }),
      ).toHaveCount(0);
      await closeDetails();
      records[0] = { ...blocked, status: "active" };
      await mount({ scheduled: true }, 1);
      await open(0);
      await expect(
        rows.filter({ hasText: "Unreleased synthetic device" }),
      ).toContainText("Queued");
      await closeDetails();
      targetOverrides.clear();
      records = saved;
    },
  );
  await check(
    "new search wins over an older delayed response and whitespace uses honest empty guidance",
    async () => {
      await mount();
      delayedSearch = "deployment 00";
      await page
        .getByLabel("Search deployments", { exact: true })
        .fill(delayedSearch);
      await expect.poll(() => heldResponses.length).toBe(1);
      await page
        .getByLabel("Search deployments", { exact: true })
        .fill("deployment 020");
      await expect(page.locator(".deployment-table tbody tr")).toHaveCount(1);
      await expect(page.locator(".deployment-table")).toContainText(
        "Synthetic deployment 020",
      );
      heldResponses.splice(0).forEach((resolve) => resolve());
      delayedSearch = "";
      await delay(100);
      await expect(page.locator(".deployment-table")).toContainText(
        "Synthetic deployment 020",
      );
      const saved = records;
      records = [];
      await page.getByLabel("Search deployments", { exact: true }).fill("   ");
      await expect(
        page.getByRole("heading", { name: "No deployments yet", exact: true }),
      ).toBeVisible();
      records = saved;
    },
  );
  await check(
    "last page clamps after refresh and scheduled history retains past cancelled or missed changes",
    async () => {
      await mount({ initialQuery: { search: "", status: "all", page: 5 } }, 3);
      await expect(page.locator(".deployment-table tbody tr")).toHaveCount(3);
      const saved = records;
      records = records.slice(0, 48);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.locator(".pagination")).toContainText("4 / 4");
      await expect(page.locator(".deployment-table tbody tr")).toHaveCount(12);
      records = saved;
      await mount({ scheduled: true });
      await expect(page.locator(".deployment-table")).toContainText(
        "Cancelled",
      );
      await expect(page.locator(".deployment-table")).toContainText(
        "Schedule missed",
      );
      expect(requests.at(-1).query.scheduled).toBe("true");
    },
  );
  await check(
    "closing a pending detail cannot replace a later selection; retry recovers summary and target reads",
    async () => {
      await mount();
      delayedSummary = "d-000";
      await open(0);
      await expect.poll(() => heldResponses.length).toBe(1);
      await closeDetails();
      failSummary = "d-001";
      await open(1);
      await expect(details().getByRole("alert")).toContainText(
        "Synthetic summary unavailable",
      );
      heldResponses.splice(0).forEach((resolve) => resolve());
      delayedSummary = "";
      failTargets = "d-001";
      await details()
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(
        details().getByRole("heading", {
          name: "Synthetic deployment 001",
          exact: true,
        }),
      ).toBeVisible();
      await expect(details().getByRole("alert")).toContainText(
        "Synthetic device results unavailable",
      );
      await details()
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(
        details().locator(".deployment-targets tbody tr"),
      ).toHaveCount(12);
      await expect(details()).not.toContainText("Synthetic deployment 000");
      await details()
        .getByRole("link", { name: "d-001 synthetic device 0000", exact: true })
        .click();
      expect(await page.evaluate(() => window.lastNavigation)).toBe(
        "devices/d-001-device-0",
      );
      await closeDetails();
    },
  );
  await check(
    "target paging preserves total action counts and pause, resume, rollback and removal still require confirmation",
    async () => {
      await mount();
      await open(2);
      await expect(
        details().locator(".deployment-targets tbody tr"),
      ).toHaveCount(12);
      await details()
        .getByRole("button", { name: "Next", exact: true })
        .click();
      await expect(details().locator(".pagination")).toContainText("2 / 84");
      await details()
        .getByRole("button", { name: "Filter Progress", exact: true })
        .click();
      await page
        .getByRole("radio", { name: "Failed (11)", exact: true })
        .click();
      await expect(
        details().locator(".deployment-targets tbody tr"),
      ).toHaveCount(11);
      await expect(details().locator(".pagination")).toContainText("1 / 1");
      delayedTargetSearch = "synthetic device 0";
      await details()
        .getByLabel("Search deployment devices", { exact: true })
        .fill(delayedTargetSearch);
      await expect.poll(() => heldResponses.length).toBe(1);
      await details()
        .getByLabel("Search deployment devices", { exact: true })
        .fill("1000");
      await expect(
        details().locator(".deployment-targets tbody tr"),
      ).toHaveCount(1);
      heldResponses.splice(0).forEach((resolve) => resolve());
      delayedTargetSearch = "";
      await delay(100);
      await expect(
        details().locator(".deployment-targets tbody tr"),
      ).toHaveCount(1);
      await expect(details().locator(".deployment-targets")).toContainText(
        "synthetic device 1000",
      );
      const before = requests.filter((r) => r.method === "POST").length;
      await details()
        .getByRole("button", { name: "Pause", exact: true })
        .click();
      let modal = page.getByRole("dialog", {
        name: "Pause rollout",
        exact: true,
      });
      await expect(modal).toContainText("1001 devices");
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(before);
      postDelay = 150;
      await modal
        .getByRole("button", { name: "Pause rollout", exact: true })
        .click();
      await expect(
        modal.getByRole("button", { name: "Keep current state", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(modal).toBeVisible();
      await expect(
        details().getByRole("button", { name: "Resume", exact: true }),
      ).toBeVisible();
      postDelay = 0;
      await expect(
        details().getByRole("button", {
          name: "Filter Progress (active)",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        details().getByLabel("Search deployment devices", { exact: true }),
      ).toHaveValue("1000");
      await details()
        .getByRole("button", { name: "Resume", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Resume rollout", exact: true })
        .getByRole("button", { name: "Resume rollout", exact: true })
        .click();
      await expect(
        details().getByRole("button", { name: "Pause", exact: true }),
      ).toBeVisible();
      await details()
        .getByRole("button", { name: "Roll back", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Review rollback", exact: true }),
      ).toContainText("Included (1001)");
      await page
        .getByRole("dialog", { name: "Review rollback", exact: true })
        .getByRole("button", { name: "Roll back 1001 devices", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Review rollback", exact: true }),
      ).toHaveCount(0);
      const receipt = page.getByRole("dialog", {
        name: "Rollback confirmed",
        exact: true,
      });
      await expect(receipt).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(
        receipt.getByRole("link", {
          name: "View rollback deployment",
          exact: true,
        }),
      ).toHaveAttribute("href", `#/deployments/${rollbackResultId}?page=1`);
      const rollbackRequests = requests.filter(
        (request) =>
          request.method === "POST" && request.path.endsWith("/rollback"),
      );
      expect(rollbackRequests).toHaveLength(1);
      expect(rollbackRequests[0].path).toBe(
        `/deployments/${rollbackSourceId}/rollback`,
      );
      expect(rollbackRequests[0].body.request_id).toMatch(
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,
      );
      expect(rollbackRequests[0].body.review_token).toBe(reviewToken);
      expect(
        requests.filter(
          (request) =>
            request.method === "GET" &&
            request.path ===
              `/deployments/${rollbackSourceId}/rollback-preview`,
        ),
      ).toHaveLength(1);
      await receipt.getByRole("button", { name: "Close", exact: true }).click();
      await expect(receipt).toHaveCount(0);
      await expect(details()).toBeVisible();
      await details()
        .getByRole("button", { name: "Remove assignment", exact: true })
        .click();
      const removal = page.getByRole("dialog", {
        name: "Remove assignment",
        exact: true,
      });
      await expect(removal).toContainText("Synthetic affected device");
      await removal
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      expect(
        requests.filter(
          (r) => r.method === "POST" && r.path.endsWith("/unassign"),
        ),
      ).toHaveLength(0);
      await closeDetails();
    },
  );
  await check(
    "viewer actions stay unavailable; mobile light/dark details remain usable and accessible",
    async () => {
      await mount({
        user: {
          id: "synthetic-viewer",
          name: "Synthetic viewer",
          email: "viewer@example.test",
          role: "viewer",
          enabled: true,
          revision: 1,
        },
      });
      await expect(
        page.getByRole("button", { name: "Deploy a pipeline", exact: true }),
      ).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await open(3);
      await expect(
        details().locator(".deployment-targets tbody tr"),
      ).toHaveCount(12);
      await expect(
        details().getByRole("button", { name: "Pause", exact: true }),
      ).toHaveCount(0);
      await expect(
        details().getByRole("button", { name: "Remove assignment", exact: true }),
      ).toHaveCount(0);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const overflow = await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
          items: [...document.querySelectorAll("body *")]
            .map((e) => ({
              tag: e.tagName,
              cls: e.className,
              left: e.getBoundingClientRect().left,
              right: e.getBoundingClientRect().right,
              width: e.getBoundingClientRect().width,
            }))
            .filter((e) => e.right > innerWidth + 1 || e.left < -1)
            .slice(0, 30),
        }));
        if (overflow.scroll > overflow.width) {
          await writeFile(
            resolve(output, "overflow.json"),
            JSON.stringify(overflow, null, 2),
          );
          await page.screenshot({ path: resolve(output, "overflow.png") });
        }
        expect(overflow.scroll <= overflow.width).toBe(true);
        const audit = await new AxeBuilder({ page }).analyze();
        accessibility.push({
          theme,
          width: 390,
          violations: audit.violations.map((v) => v.id),
        });
        await page.screenshot({
          path: resolve(output, `mobile-${theme}.png`),
          animations: "disabled",
        });
        if (audit.violations.length)
          await writeFile(
            resolve(output, `accessibility-${theme}.json`),
            JSON.stringify(audit.violations, null, 2),
          );
        expect(audit.violations.map((v) => v.id)).toEqual([]);
      }
      await closeDetails();
      // Returning from the page puts focus back on the row that opened it.
      await expect(
        page.locator('[data-deployment-link="d-003"]'),
      ).toBeFocused();
    },
  );
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
  const source_sha256 = {};
  for (const file of [
    "dashboard/tests/deployments-browser.mjs",
    "dashboard/src/Deployments.tsx",
    "dashboard/src/DeploymentRollout.tsx",
    "dashboard/src/deploymentStatus.ts",
    "dashboard/src/DeploymentRecovery.tsx",
    "dashboard/src/deploymentRequests.ts",
    "dashboard/src/deploymentReceipt.ts",
    "dashboard/src/RollbackReviewPanel.tsx",
    "dashboard/src/rollbackReview.ts",
    "dashboard/src/RecoveryActions.tsx",
    "dashboard/src/api.ts",
    "dashboard/src/ui.tsx",
  ])
    source_sha256[file] = createHash("sha256")
      .update(await readFile(resolve(repository, file)))
      .digest("hex");
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        source:
          "actual React deployment components with isolated synthetic HTTP",
        results,
        requests: requests.length,
        accessibility,
        browser_errors: errors,
        unexpected_requests: unexpected,
        source_sha256,
        screenshots: [
          "desktop-light.png",
          "desktop-dark.png",
          "mobile-light.png",
          "mobile-dark.png",
        ].map((file) => relative(repository, resolve(output, file))),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: results.length,
      evidence: relative(repository, resolve(output, "results.json")),
    }),
  );
} finally {
  heldResponses.splice(0).forEach((resolve) => resolve());
  await context.close();
  await browser.close();
  await server.close();
}
