// Real App shell with synthetic transport: every page keeps one header and the
// first Tab from a fresh load goes to the skip link (never past the shell).
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_PAGE_CHROME_OUTPUT || ".local/page-chrome",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:page-chrome-fixture";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "page-chrome-fixture",
      resolveId(id) {
        if (id === "virtual:page-chrome-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__page-chrome") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              "/__page-chrome",
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic page chrome verification</title></head><body><div id="root"></div><script type="module">import "virtual:page-chrome-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${port}/__page-chrome`;
const browser = await chromium.launch();
const user = {
  id: "synthetic-admin",
  name: "Synthetic admin",
  email: "admin@example.test",
  role: "admin",
  enabled: true,
  revision: 1,
};
async function open(width = 1440, colorScheme = "light", answers = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme,
  });
  // Nothing else answers: pages show their honest "couldn't load" state, and
  // the header and tabs above it are what this checks.
  await context.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const reply = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/status")
      return reply({ initialized: true, version: "synthetic" });
    if (path === "/session")
      return reply({ user, csrf_token: "synthetic-csrf" });
    if (path in answers) return reply(answers[path]);
    return reply(
      { error: { code: "UNAVAILABLE", message: "Synthetic unavailable" } },
      503,
    );
  });
  const page = await context.newPage();
  return { context, page };
}
const routes = [
  "overview",
  "devices",
  "groups",
  "policies",
  "deployments",
  "schedules",
  "issues",
  "audit",
  "settings",
  "users",
];
const results = [];
let failure;
try {
  const geometry = [];
  for (const route of routes) {
    const { context, page } = await open();
    await page.goto(`${origin}#/${route}`);
    await expect(page.locator("main h1")).toBeVisible();
    // Notifications are announced through two live regions that are always
    // mounted. They carry no role: a role would add an empty "alert" and
    // "status" to every page, beside the ones the page shows itself.
    if (route === "overview")
      expect(
        await page.locator(".sr-only[aria-live]").evaluateAll((nodes) =>
          nodes
            .filter(
              (node) =>
                !node.hasAttribute("role") &&
                !node.hasAttribute("data-route-announcer"),
            )
            .map((node) => node.getAttribute("aria-live"))
            .sort(),
        ),
        "notification live regions",
      ).toEqual(["assertive", "polite"]);
    // Pages with section tabs used to move the Tab starting point past the
    // shell (scrollIntoView on the active tab).
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() =>
      document.activeElement?.textContent?.trim(),
    );
    expect(first, `first Tab on #/${route}`).toBe("Skip to main content");
    geometry.push({
      route,
      ...(await page.evaluate(() => {
        const heading = document.querySelector("main h1");
        const box = heading.getBoundingClientRect();
        return {
          size: getComputedStyle(heading).fontSize,
          top: Math.round(box.top + scrollY),
        };
      })),
    });
    await context.close();
  }
  results.push("The first Tab on every page goes to the skip link");
  // One header contract: the same title size and position on every page.
  expect(new Set(geometry.map((item) => item.size)), "title sizes").toEqual(
    new Set(["24px"]),
  );
  const tops = geometry.map((item) => item.top);
  expect(
    Math.max(...tops) - Math.min(...tops),
    `title positions ${JSON.stringify(geometry)}`,
  ).toBeLessThanOrEqual(1);
  results.push("Every page title has the same size and position");
  {
    const { context, page } = await open(390);
    for (const route of ["devices", "deployments", "policies", "users"]) {
      await page.goto(`${origin}#/${route}`);
      await expect(page.locator("main h1")).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
        `#/${route} fits 390px`,
      ).toBe(true);
      expect(
        await page.evaluate(
          () => getComputedStyle(document.querySelector("main h1")).fontSize,
        ),
      ).toBe("22px");
    }
    await context.close();
  }
  results.push("Pages fit a phone with the phone title size");
  {
    // A dialog hands focus back to the button that opened it, including one
    // whose first field takes focus on open (Create pipeline used to drop it
    // on the page).
    const { context, page } = await open();
    for (const [route, name] of [
      ["configurations", "Create pipeline"],
      ["groups", "Create group"],
    ]) {
      await page.goto(`${origin}#/${route}`);
      const opener = page.getByRole("button", { name, exact: true }).first();
      await expect(opener).toBeVisible();
      for (const close of ["Escape", "Cancel"]) {
        await opener.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog")).toBeVisible();
        if (close === "Escape") await page.keyboard.press("Escape");
        else
          await page
            .getByRole("dialog")
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(opener, `${name} focus after ${close}`).toBeFocused();
      }
    }
    await context.close();
  }
  results.push("Dialogs return focus to the button that opened them");
  {
    // A section tab lives inside the page, so the page it opens replaces it.
    // Focus goes to the new page's title instead of falling to the document,
    // and the next Tab continues inside the page, not at the skip link.
    const { context, page } = await open();
    await page.goto(`${origin}#/devices`);
    await expect(page.locator("main h1")).toHaveText("Devices");
    const tab = page
      .getByRole("navigation", { name: "Device sections" })
      .getByRole("link", { name: "Groups", exact: true });
    let reached = false;
    for (let press = 0; press < 40 && !reached; press++) {
      await page.keyboard.press("Tab");
      reached = await tab.evaluate((node) => node === document.activeElement);
    }
    expect(reached, "Tab reaches the Groups tab").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/groups$/);
    const title = page.getByRole("heading", { level: 1, name: "Groups" });
    await expect(title).toBeFocused();
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () =>
          !!document.activeElement?.closest("#main-content") &&
          document.activeElement !== document.body,
      ),
      "the Tab after arriving stays inside the page",
    ).toBe(true);
    // The sidebar keeps its own focus and the new page is announced instead.
    const overview = page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Overview", exact: true });
    await overview.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/overview$/);
    await expect(overview).toBeFocused();
    await expect(page.locator("[data-route-announcer]")).toHaveText(
      "Overview",
    );
    await context.close();
  }
  results.push(
    "Navigating inside a page focuses the new title; the sidebar keeps focus and the page is announced",
  );
  {
    // A very long name wraps in the header of the dialog it opens and never
    // pushes the close button off a phone or widens the page.
    const long = `synthetic-group-${"x".repeat(75)}`;
    const { context, page } = await open(375, "light", {
      "/groups": [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: long,
          description: "Synthetic group",
          device_ids: [],
          revision: 1,
        },
      ],
      "/devices": [],
    });
    await page.goto(`${origin}#/groups`);
    await page.getByRole("button", { name: long, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole("button", {
      name: "Close dialog",
      exact: true,
    });
    await expect(close).toBeVisible();
    const fit = await page.evaluate(() => {
      const box = document.querySelector('[role="dialog"]');
      const button = box.querySelector('button[aria-label="Close dialog"]');
      return {
        page: document.documentElement.scrollWidth,
        dialog: box.scrollWidth - box.clientWidth,
        closeRight: button.getBoundingClientRect().right,
      };
    });
    expect(fit.page, "page width").toBeLessThanOrEqual(375);
    expect(fit.dialog, "dialog sideways overflow").toBeLessThanOrEqual(1);
    expect(fit.closeRight, "close button in view").toBeLessThanOrEqual(375);
    await context.close();
  }
  results.push("A very long name wraps in a dialog header on a phone");
} catch (error) {
  failure = error;
} finally {
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      { synthetic: true, results, failure: failure?.stack },
      null,
      2,
    ),
  );
  await browser.close();
  await server.close();
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: results.length, output }));
