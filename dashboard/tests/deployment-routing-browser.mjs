// Actual App router and deployment inspector; synthetic transport only.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_DEPLOYMENT_ROUTING_OUTPUT || ".local/deployment-routing",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:deployment-routing-fixture";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    proxy: {},
    hmr: false,
  },
  plugins: [
    {
      name: "deployment-routing-fixture",
      resolveId(id) {
        if (id === "virtual:deployment-routing-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__deployment-routing") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              "/__deployment-routing",
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic deployment navigation verification</title></head><body><div id="root"></div><script type="module">import "virtual:deployment-routing-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch(),
  results = [],
  errors = [],
  unexpected = [];
const origin = "http://127.0.0.1:5199/__deployment-routing";
const id = (n) => "abcdefab-1234-4000-8000-" + String(n).padStart(12, "0");
const user = (role) => ({
  id: "synthetic-user",
  name: "Synthetic user",
  email: "routing@example.test",
  role,
  enabled: true,
  revision: 1,
});
const summary = (n) => ({
  id: id(n),
  name: n > 13 ? "Synthetic scheduled " + n : "Synthetic Alpha " + n,
  configuration_id: id(99),
  configuration_name: "Synthetic logs",
  version_id: id(100),
  version_number: 2,
  policy: null,
  priority: 0,
  target_mode: "snapshot",
  status: n > 13 ? "scheduled" : "active",
  scheduled_at: n > 13 ? "2026-10-01T12:00:00Z" : null,
  created_at: "2026-09-26T12:00:00Z",
  rollout: {
    kind: "all",
    canary_size: 1,
    batch_size: 5,
    observation_seconds: 30,
    failure_threshold: 0,
  },
  target_count: 1,
  verified_count: 0,
  state_counts: { desired: 1 },
});
async function fixture({
  signedIn = true,
  role = "viewer",
  deniedId = "",
} = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  const state = {
    signedIn,
    role,
    records: Array.from({ length: 15 }, (_, i) => summary(i + 1)),
    requests: [],
    delayId: "",
    releaseDetail: null,
    holdMutation: "",
    releaseMutation: null,
  };
  await context.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.replace("/api/v1", ""),
      method = route.request().method();
    state.requests.push({
      path,
      method,
      query: Object.fromEntries(url.searchParams),
    });
    const reply = async (json, status = 200) => {
      try {
        await route.fulfill({ json, status });
      } catch {
        /* Obsolete document reads may be cancelled. */
      }
    };
    if (path === "/status")
      return reply({ initialized: true, version: "synthetic" });
    if (path === "/login" && method === "POST") {
      state.signedIn = true;
      return reply({ user: user(state.role), csrf_token: "synthetic-csrf" });
    }
    if (path === "/session")
      return state.signedIn
        ? reply({ user: user(state.role), csrf_token: "synthetic-csrf" })
        : reply(
            {
              error: {
                code: "UNAUTHENTICATED",
                message: "Synthetic session required",
              },
            },
            401,
          );
    if (!state.signedIn)
      return reply(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Synthetic session required",
          },
        },
        401,
      );
    if (path === "/settings")
      return reply({ instance_name: "Synthetic navigation check" });
    if (path === "/overview")
      return reply({
        devices_total: 0,
        devices_online: 0,
        configurations_total: 0,
        deployments_active: 13,
        issues_open: 0,
        devices: [],
        recent_activity: [],
      });
    if (path === "/deployments/history") {
      let items = state.records.filter((item) =>
        item.name.includes(url.searchParams.get("search") || ""),
      );
      if (url.searchParams.get("scheduled") === "true")
        items = items.filter((item) => item.scheduled_at);
      const status = url.searchParams.get("status");
      if (status && status !== "all")
        items = items.filter((item) => item.status === status);
      const number = Number(url.searchParams.get("page")),
        size = Number(url.searchParams.get("page_size"));
      expect(size).toBe(12);
      return reply({
        items: items.slice((number - 1) * size, number * size),
        total: items.length,
        page: number,
        page_size: size,
      });
    }
    const match = path.match(
      /^\/deployments\/([^/]+)\/(summary|rollout|targets|pause|unassign-preview|unassign)$/,
    );
    if (match) {
      const [, identity, action] = match;
      if (identity === deniedId)
        return reply(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "Synthetic access expired",
            },
          },
          401,
        );
      const item = state.records.find((record) => record.id === identity);
      if (!item)
        return reply(
          { error: { code: "NOT_FOUND", message: "Deployment not found" } },
          404,
        );
      if (action === "summary") {
        const copy = structuredClone(item);
        if (state.delayId === identity)
          await new Promise((resolve) => (state.releaseDetail = resolve));
        return reply(copy);
      }
      if (action === "rollout")
        return reply({
          deployment_id: item.id,
          status: item.status,
          evaluated_at: new Date().toISOString(),
          stages: [],
          failures: [],
          removed_count: 0,
          check_in_seconds: 60,
          next_admission_at: null,
        });
      if (action === "targets")
        return reply({
          items: [
            {
              device_id: id(200),
              device_name: "Device for " + item.name,
              state: "desired",
              generation: 1,
              error: null,
              original: true,
            },
          ],
          total: 1,
          page: 1,
          page_size: 12,
        });
      if (method === "POST") {
        if (action === "unassign-preview")
          return reply({
            removal_review: true,
            source_deployment_id: item.id,
            source_status: item.status,
            resource: "configuration",
            ready: true,
            review_token: "e".repeat(64),
            blockers: [],
            devices: [{
              device_id: id(200),
              device_name: "Synthetic affected device",
              effect: "unmanaged",
              before: { assignment_id: item.id, assignment_name: item.name, version_id: item.version_id, configuration_name: "Synthetic pipeline", version_number: 1, generation: 1, policy: null },
              after: { assignment_id: null, assignment_name: null, version_id: null, configuration_name: null, version_number: null, generation: 2, policy: null },
              pending_assignment_id: null,
              pending_assignment_name: null,
            }],
          });
        if (action === "unassign")
          expect(route.request().postDataJSON()).toEqual({ review_token: "e".repeat(64) });
        if (state.holdMutation === action)
          await new Promise((resolve) => (state.releaseMutation = resolve));
        item.status = action === "pause" ? "paused" : "unassigned";
        return reply(item);
      }
    }
    unexpected.push(method + " " + path);
    return reply(
      { error: { code: "UNEXPECTED", message: "Unexpected synthetic route" } },
      500,
    );
  });
  return {
    context,
    page,
    state,
    close: async () => {
      state.releaseDetail?.();
      state.releaseMutation?.();
      await context.close();
    },
  };
}
const dialog = (page) =>
  page.getByRole("region", { name: "Deployment details", exact: true });
const back = (page) =>
  dialog(page)
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: /^(Deployments|Schedules)$/ });
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
  console.log("PASS", name);
}
try {
  await check(
    "opening, refresh, Back and Forward preserve exact rollout and list filters/page",
    async () => {
      const f = await fixture();
      try {
        await f.page.goto(origin + "#/deployments");
        await f.page
          .getByLabel("Search deployments", { exact: true })
          .fill("Alpha");
        await f.page.getByRole("button", { name: "Filter Status", exact: true }).click();
        await f.page.getByRole("radio", { name: "In progress", exact: true }).click();
        await expect(f.page.locator(".deployment-table tbody tr")).toHaveCount(
          12,
        );
        await f.page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(f.page.locator(".deployment-table tbody tr")).toHaveCount(
          1,
        );
        await f.page
          .getByRole("button", {
            name: "View details for Synthetic Alpha 13",
            exact: true,
          })
          .click();
        await expect(f.page).toHaveURL(
          origin +
            "#/deployments/" +
            id(13) +
            "?search=Alpha&status=active&page=2",
        );
        await expect(
          dialog(f.page).getByRole("heading", {
            name: "Synthetic Alpha 13",
            exact: true,
          }),
        ).toBeVisible();
        await f.page.reload();
        await expect(
          dialog(f.page).getByRole("heading", {
            name: "Synthetic Alpha 13",
            exact: true,
          }),
        ).toBeVisible();
        await f.page.goBack();
        await expect(dialog(f.page)).toHaveCount(0);
        await expect(
          f.page.getByLabel("Search deployments", { exact: true }),
        ).toHaveValue("Alpha");
        await expect(f.page.getByRole("button", { name: "Filter Status (active)", exact: true })).toBeVisible();
        await expect(f.page.locator(".pagination")).toContainText("2 / 2");
        await f.page.goForward();
        await expect(
          dialog(f.page).getByRole("heading", {
            name: "Synthetic Alpha 13",
            exact: true,
          }),
        ).toBeVisible();
        await back(f.page).click();
        await expect(f.page).toHaveURL(
          origin + "#/deployments?search=Alpha&status=active&page=2",
        );
        await f.page.goBack();
        await expect(
          dialog(f.page).getByRole("heading", {
            name: "Synthetic Alpha 13",
            exact: true,
          }),
        ).toBeVisible();
        expect(f.state.requests.filter((r) => r.method !== "GET")).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "direct sign-in and schedule links keep identity, copy exact URL, open a new tab and expose truthful clipboard fallback",
    async () => {
      const f = await fixture({ signedIn: false });
      try {
        await f.page.goto(
          origin +
            "#/schedules/" +
            id(14).toUpperCase() +
            "?page=1&action=cancel",
        );
        await expect(
          // The heading names the instance: "Sign in to <instance>".
          f.page.getByRole("heading", { name: /^Sign in to / }),
        ).toBeVisible();
        await f.page
          .getByLabel("Email address", { exact: true })
          .fill("routing@example.test");
        await f.page
          .getByLabel("Password", { exact: true })
          .fill("synthetic-unused-password");
        await f.page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await expect(
          dialog(f.page).getByRole("heading", {
            name: "Synthetic scheduled 14",
            exact: true,
          }),
        ).toBeVisible();
        await dialog(f.page)
          .getByRole("button", { name: "Copy deployment link", exact: true })
          .click();
        await expect(
          dialog(f.page)
            .getByRole("status")
            .filter({ hasText: "Deployment link copied." }),
        ).toBeVisible();
        const link = await f.page.evaluate(() =>
          navigator.clipboard.readText(),
        );
        expect(link).toBe(origin + "#/schedules/" + id(14) + "?page=1");
        const popupPromise = f.context.waitForEvent("page");
        await dialog(f.page)
          .getByRole("link", { name: "Open in new tab", exact: true })
          .click();
        const popup = await popupPromise;
        await expect(
          dialog(popup).getByRole("heading", {
            name: "Synthetic scheduled 14",
            exact: true,
          }),
        ).toBeVisible();
        await popup.close();
        await f.page.evaluate(() =>
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: () => Promise.reject(Error("Denied")) },
          }),
        );
        await dialog(f.page)
          .getByRole("button", { name: "Copy deployment link", exact: true })
          .click();
        const fallback = dialog(f.page).getByLabel("Deployment link", {
          exact: true,
        });
        await expect(fallback).toHaveValue(link);
        await expect(fallback).toBeFocused();
        expect(
          await fallback.evaluate(
            (input) =>
              input.selectionStart === 0 &&
              input.selectionEnd === input.value.length,
          ),
        ).toBe(true);
        await back(f.page).click();
        await expect(f.page).toHaveURL(origin + "#/schedules?page=1");
        expect(
          f.state.requests.filter((r) => r.method !== "GET").map((r) => r.path),
        ).toEqual(["/login"]);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Back/Forward identity changes ignore old delayed summaries and reset device filters",
    async () => {
      const f = await fixture();
      try {
        f.state.delayId = id(1);
        await f.page.goto(origin + "#/deployments/" + id(1) + "?page=1");
        await expect.poll(() => !!f.state.releaseDetail).toBe(true);
        await f.page.evaluate(
          (hash) => (location.hash = hash),
          "/deployments/" + id(2) + "?page=1",
        );
        await expect(
          dialog(f.page).getByRole("heading", {
            name: "Synthetic Alpha 2",
            exact: true,
          }),
        ).toBeVisible();
        f.state.releaseDetail();
        f.state.releaseDetail = null;
        f.state.delayId = "";
        await delay(100);
        await expect(dialog(f.page)).not.toContainText("Synthetic Alpha 1");
        await dialog(f.page)
          .getByLabel("Search deployment devices", { exact: true })
          .fill("some filter");
        await f.page.goBack();
        await expect(
          dialog(f.page).getByRole("heading", {
            name: "Synthetic Alpha 1",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          dialog(f.page).getByLabel("Search deployment devices", {
            exact: true,
          }),
        ).toHaveValue("");
        await f.page.goForward();
        await expect(
          dialog(f.page).getByRole("heading", {
            name: "Synthetic Alpha 2",
            exact: true,
          }),
        ).toBeVisible();
        expect(f.state.requests.filter((r) => r.method !== "GET")).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "malformed, missing and unauthorized direct links never fall back to another rollout or mutate",
    async () => {
      const f = await fixture({ deniedId: id(3) });
      try {
        await f.page.goto(
          origin + "#/deployments/%2E%2E%2Fdevices?action=rollback&page=0",
        );
        await expect(
          f.page.getByRole("heading", {
            name: "Invalid deployment link",
            exact: true,
          }),
        ).toBeVisible();
        expect(f.state.requests.some((r) => r.path.endsWith("/summary"))).toBe(
          false,
        );
        await f.page
          .getByRole("button", { name: "Return to deployments", exact: true })
          .click();
        await f.page.evaluate(
          (hash) => (location.hash = hash),
          "/deployments/" + id(999) + "?page=1",
        );
        await expect(dialog(f.page).getByRole("alert")).toContainText(
          "Deployment not found",
        );
        await expect(
          dialog(f.page).getByRole("button", {
            name: "Return to deployments",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          dialog(f.page).getByRole("button", {
            name: "Copy deployment link",
            exact: true,
          }),
        ).toHaveCount(0);
        // The session really ends: the shell's sign-in prompt first asks the
        // server whether it is still valid and resumes silently if it is.
        f.state.signedIn = false;
        await f.page.evaluate(
          (hash) => (location.hash = hash),
          "/deployments/" + id(3) + "?page=1",
        );
        // An expired session is handled once by the shell's sign-in prompt;
        // the page keeps what it had instead of showing its own error.
        await expect(
          f.page.getByRole("heading", {
            name: "Your session ended",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          dialog(f.page).getByRole("button", {
            name: "Pause",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(f.state.requests.filter((r) => r.method !== "GET")).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "browser navigation is held during confirmed rollout and assignment commits",
    async () => {
      const f = await fixture({ role: "admin" });
      try {
        await f.page.goto(origin + "#/deployments/" + id(4) + "?page=1");
        await dialog(f.page)
          .getByRole("button", { name: "Pause", exact: true })
          .click();
        f.state.holdMutation = "pause";
        await f.page
          .getByRole("dialog", { name: "Pause rollout", exact: true })
          .getByRole("button", { name: "Pause rollout", exact: true })
          .click();
        await expect.poll(() => !!f.state.releaseMutation).toBe(true);
        await f.page.evaluate(
          (hash) => (location.hash = hash),
          "/deployments/" + id(4) + "?status=failed&page=2",
        );
        await expect(f.page).toHaveURL(
          origin + "#/deployments/" + id(4) + "?page=1",
        );
        await f.page.evaluate(() => (location.hash = "/overview"));
        await expect(f.page).toHaveURL(
          origin + "#/deployments/" + id(4) + "?page=1",
        );
        f.state.releaseMutation();
        f.state.releaseMutation = null;
        f.state.holdMutation = "";
        await expect(
          dialog(f.page).getByRole("button", {
            name: "Resume",
            exact: true,
          }),
        ).toBeVisible();
        await dialog(f.page)
          .getByRole("button", { name: "Remove assignment", exact: true })
          .click();
        const removal = f.page.getByRole("dialog", {
          name: "Remove assignment",
          exact: true,
        });
        await expect(removal).toContainText("Synthetic affected device");
        f.state.holdMutation = "unassign";
        await removal
          .getByRole("button", { name: "Remove assignment", exact: true })
          .click();
        await expect.poll(() => !!f.state.releaseMutation).toBe(true);
        await f.page.evaluate(() => (location.hash = "/overview"));
        await expect(f.page).toHaveURL(
          origin + "#/deployments/" + id(4) + "?page=1",
        );
        f.state.releaseMutation();
        f.state.releaseMutation = null;
        f.state.holdMutation = "";
        await expect(removal).toHaveCount(0);
        await f.page.getByRole("dialog", { name: "Assignment removed", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
        await back(f.page).click();
        await expect(dialog(f.page)).toHaveCount(0);
        expect(f.state.requests.filter((r) => r.path === "/overview")).toEqual(
          [],
        );
        expect(
          f.state.requests
            .filter((r) => r.method === "POST")
            .map((r) => r.path),
        ).toEqual([
          "/deployments/" + id(4) + "/pause",
          "/deployments/" + id(4) + "/unassign-preview",
          "/deployments/" + id(4) + "/unassign",
        ]);
      } finally {
        await f.close();
      }
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        source:
          "actual App/router/deployment inspector with isolated synthetic transport",
        results,
        browser_errors: errors,
        unexpected_requests: unexpected,
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
  await browser.close();
  await server.close();
}
