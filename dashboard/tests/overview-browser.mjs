// Real Overview component, isolated synthetic HTTP transport. No preview state.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_OVERVIEW_OUTPUT || ".local/overview-component",
);
await mkdir(output, { recursive: true });
const uuid = (n) =>
  `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const user = {
  id: uuid(1),
  name: "Morgan Lee",
  email: "synthetic@example.test",
  role: "admin",
  enabled: true,
  revision: 1,
};
const device = {
  id: uuid(2),
  name: "Synthetic ingest host",
  last_seen: new Date().toISOString(),
  status: "online",
  apply_state: "unmanaged",
  desired_version_id: null,
};
const virtual = "\0virtual:overview-fixture";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 5204,
    strictPort: true,
    proxy: {},
    hmr: false,
  },
  plugins: [
    {
      name: "overview-component-fixture",
      resolveId(id) {
        if (id === "virtual:overview-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import{Overview}from'/src/Fleet.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement('main',{className:'page-content'},React.createElement(Overview,{user:${JSON.stringify(user)},navigate:path=>{window.location.hash='/'+path}})));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__overview") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Overview verification</title></head><body><div id="root"></div><script type="module">import "virtual:overview-fixture";</script></body></html>',
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
page.setDefaultTimeout(8000);
const results = [],
  actionGeometry = [],
  errors = [],
  unexpected = [],
  requests = [],
  accessibility = [];
page.on("pageerror", (error) => errors.push(error.message));
const entry = (n, extra) => ({
  id: uuid(100 + n),
  actor_id: user.id,
  actor: user.name,
  actor_kind: "user",
  action: "configuration.save",
  target: uuid(3),
  target_id: uuid(3),
  target_kind: "configuration",
  target_name: "Synthetic pipeline",
  target_exists: true,
  device_id: null,
  outcome: "success",
  created_at: new Date().toISOString(),
  request_id: null,
  ...extra,
});
const normal = [
  entry(1, {
    action: "configuration.publish",
    target: uuid(4),
    target_id: uuid(3),
    target_name: "Orders pipeline",
  }),
  entry(2, {
    action: "deployment.release",
    target: `${uuid(5)}:${device.id}`,
    target_id: uuid(5),
    target_kind: "deployment",
    target_name: "Canary rollout",
    actor_id: device.id.toUpperCase(),
    actor_kind: "device",
    actor: device.name,
  }),
  entry(3, {
    action: "device.renew",
    target: device.id,
    target_id: device.id.toUpperCase(),
    target_kind: "device",
    target_name: device.name,
  }),
  entry(4, {
    action: "issue.acknowledge",
    target: uuid(6),
    target_id: uuid(6),
    target_kind: "issue",
    target_name: "Apply failed",
    outcome: "prepared",
  }),
  entry(5, { target_name: user.name, target_id: uuid(7), target: uuid(7) }),
];
let entries = normal;
await context.route("**/api/v1/**", async (route) => {
  const req = route.request(),
    path = new URL(req.url()).pathname.replace("/api/v1", "");
  requests.push({ method: req.method(), path });
  if (req.method() === "GET" && path === "/overview")
    return route.fulfill({
      json: {
        devices_total: 1,
        devices_online: 1,
        configurations_total: 2,
        deployments_active: 1,
        issues_open: 0,
        devices: [device],
        recent_activity: entries,
      },
    });
  unexpected.push(`${req.method()} ${path}`);
  return route.fulfill({
    status: 500,
    json: {
      error: {
        code: "UNEXPECTED",
        message: "Unexpected synthetic fixture request",
      },
    },
  });
});
const rows = page.locator(".fleet-activity-list > li");
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
}
async function refresh(next) {
  entries = next;
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/v1/overview",
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await response;
  await expect(rows).toHaveCount(next.length);
}
try {
  await page.goto("http://127.0.0.1:5204/__overview");
  await expect(rows).toHaveCount(5);
  await check(
    "typed targets use exact existing resource IDs; published version and compound raw IDs do not determine routes",
    async () => {
      await expect(
        rows.nth(0).getByRole("link", { name: "Orders pipeline", exact: true }),
      ).toHaveAttribute("href", `#/configurations/${uuid(3)}`);
      await expect(
        rows.nth(1).getByRole("link", { name: "Canary rollout", exact: true }),
      ).toHaveAttribute("href", `#/deployments/${uuid(5)}`);
      await expect(
        rows.nth(2).getByRole("link", { name: device.name, exact: true }),
      ).toHaveAttribute("href", `#/devices/${device.id}`);
      await expect(
        rows.nth(3).getByRole("link", { name: "Apply failed", exact: true }),
      ).toHaveAttribute("href", `#/issues/${uuid(6)}`);
      await expect(
        rows
          .nth(0)
          .getByRole("link", { name: "Pipeline published", exact: true }),
      ).toHaveAttribute("href", `#/audit/${uuid(101)}?page=1`);
      expect(
        await page.locator(`a[href*="/configurations/${uuid(4)}"]`).count(),
      ).toBe(0);
    },
  );
  await check(
    "actor destinations are typed and identity-based; equal display names remain independently accessible",
    async () => {
      const actor = rows
        .nth(0)
        .getByRole("link", { name: user.name, exact: true });
      await expect(actor).toHaveAttribute(
        "href",
        `#/audit?actor_id=${user.id}&page=1`,
      );
      await expect(actor).toHaveAttribute(
        "title",
        `View activity by ${user.name}`,
      );
      await expect(
        rows.nth(1).getByRole("link", { name: device.name, exact: true }),
      ).toHaveAttribute("href", `#/devices/${device.id}`);
      await expect(
        rows.nth(4).getByRole("link", { name: user.name, exact: true }),
      ).toHaveCount(2);
      await expect(rows.nth(4).locator(".fleet-activity-meta")).toHaveText(
        `${user.name} · by ${user.name}`,
      );
      await actor.focus();
      await expect(actor).toBeFocused();
      await actor.press("Enter");
      await expect(page).toHaveURL(
        new RegExp(`#/audit\\?actor_id=${user.id}&page=1$`),
      );
      // Real anchors retain ordinary browser new-tab semantics; the destination is not replaced by click-only JS.
      const popupEvent = context.waitForEvent("page");
      await rows
        .nth(0)
        .getByRole("link", { name: "Orders pipeline", exact: true })
        .click({ button: "middle" });
      const popup = await popupEvent;
      await popup.waitForLoadState("domcontentloaded");
      expect(new URL(popup.url()).hash).toBe(`#/configurations/${uuid(3)}`);
      await popup.close();
    },
  );
  await check(
    "identical typed actor and target are shown once without collapsing distinct same-named identities",
    async () => {
      await expect(
        rows.nth(4).getByRole("link", { name: user.name, exact: true }),
      ).toHaveCount(2);
      await refresh([
        entry(6, {
          action: "login",
          target: user.id,
          target_id: user.id.toUpperCase(),
          target_kind: "user",
          target_name: user.name,
        }),
      ]);
      await expect(rows.first().locator(".fleet-activity-meta")).toHaveText(
        `by ${user.name}`,
      );
      await expect(rows.first().locator(".fleet-activity-meta a")).toHaveCount(
        1,
      );
      await expect(
        rows.first().getByRole("link", { name: user.name, exact: true }),
      ).toHaveAttribute("href", `#/audit?actor_id=${user.id}&page=1`);
      await expect(
        rows.first().getByRole("link", { name: "Sign-in", exact: true }),
      ).toHaveAttribute("href", `#/audit/${uuid(106)}?page=1`);
    },
  );
  await check(
    "deleted, missing, malformed, compound and unknown identities stay plain without action/name inference",
    async () => {
      const fallback = [
        entry(11, {
          target_name: "Deleted pipeline",
          target_exists: false,
          actor_kind: "unknown",
        }),
        entry(12, {
          target_name: "Legacy pipeline",
          target_exists: undefined,
          actor_kind: undefined,
        }),
        entry(13, {
          target_name: "Malformed device",
          target_kind: "device",
          target_id: "javascript:alert(1)",
          actor_id: "javascript:alert(2)",
          actor_kind: "user",
        }),
        entry(14, {
          target_name: "Compound deployment",
          target_kind: "deployment",
          target_id: `${uuid(5)}:${device.id}`,
          actor_id: `${user.id}:other`,
          actor_kind: "device",
        }),
        entry(15, {
          target_name: "Unknown resource",
          target_kind: "unknown",
          actor_id: "external-process",
          actor_kind: "unknown",
          actor: "External process",
        }),
      ];
      await refresh(fallback);
      await expect(rows.nth(0)).toContainText("Deleted pipeline");
      await expect(rows.nth(4)).toContainText("External process");
      await expect(page.locator(".fleet-activity-meta a")).toHaveCount(0);
      await expect(page.locator(".fleet-activity-link")).toHaveCount(5);
      await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    },
  );
  await check(
    "next action aligns with its message, stays actionable, and wraps below the copy on mobile",
    async () => {
      await refresh(normal);
      const row = page.locator(".overview-next-action"),
        copy = row.locator(":scope > div"),
        action = row.getByRole("button", {
          name: "Choose pipeline",
          exact: true,
        });
      for (const width of [1280, 899]) {
        await page.setViewportSize({ width, height: 900 });
        const wide = {
          row: await row.boundingBox(),
          copy: await copy.boundingBox(),
          action: await action.boundingBox(),
        };
        expect(wide.action.x).toBeGreaterThan(wide.copy.x + wide.copy.width);
        expect(
          Math.abs(
            wide.action.x + wide.action.width - wide.row.x - wide.row.width,
          ),
        ).toBeLessThan(2);
        actionGeometry.push({ width, layout: "beside", ...wide });
        if (width === 899)
          await page.screenshot({
            path: resolve(output, "overview-899-light.png"),
            fullPage: true,
            animations: "disabled",
          });
      }
      await action.click();
      await expect(page).toHaveURL(/#\/configurations$/);
      await page.setViewportSize({ width: 390, height: 844 });
      const narrow = {
        copy: await copy.boundingBox(),
        action: await action.boundingBox(),
      };
      expect(narrow.action.y).toBeGreaterThanOrEqual(
        narrow.copy.y + narrow.copy.height,
      );
      expect(Math.abs(narrow.action.x - narrow.copy.x)).toBeLessThan(2);
      actionGeometry.push({ width: 390, layout: "below", ...narrow });
    },
  );
  await check(
    "desktop and mobile Overview remain readable and keyboard accessible in both themes",
    async () => {
      for (const width of [1280, 390]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        for (const theme of ["light", "dark"]) {
          await page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
          }, theme);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          const axe = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
          const violations = axe.violations.map((item) => ({
            id: item.id,
            impact: item.impact,
          }));
          accessibility.push({ width, theme, violations });
          expect(violations).toEqual([]);
          await page.screenshot({
            path: resolve(
              output,
              `overview-${width === 390 ? "mobile" : "desktop"}-${theme}.png`,
            ),
            fullPage: true,
            animations: "disabled",
          });
        }
      }
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Actual Overview component with isolated synthetic transport. Typed resource existence and identity are server claims; no backend mutations, preview state, or actual fleet used.",
        results,
        actionGeometry,
        accessibility,
        requests,
        errors,
        unexpected,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS ${results.length} Overview checks; evidence: ${relative(repository, resolve(output, "report.json"))}`,
  );
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
