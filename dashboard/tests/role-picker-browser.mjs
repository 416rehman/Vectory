// Actual App/account forms with an isolated in-memory API; no real account writes.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_ROLE_PICKER_OUTPUT || ".local/role-picker-component",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done, fail) => {
  reservation.once("error", fail);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:role-picker-fixture";
const vite = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "role-picker-independent-fixture",
      resolveId(id) {
        if (id === "virtual:role-picker-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__role-picker") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic role picker verification</title></head><body><div id="root"></div><script type="module">import "virtual:role-picker-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch();
const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Synthetic administrator",
  email: "admin@fixture.example.test",
  role: "admin",
  enabled: true,
  revision: 1,
};
const colleague = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Synthetic colleague",
  email: "colleague@fixture.example.test",
  role: "viewer",
  enabled: true,
  revision: 4,
};
const syntheticPassword = "synthetic-password-not-real";
const csrf = "synthetic-role-picker-csrf";
const descriptions = {
  Viewer:
    "View devices, pipelines, deployments and activity; export audit history.",
  Editor:
    "Viewer access, plus create, edit, validate and organize pipeline drafts. Cannot publish or deploy.",
  Operator:
    "Viewer access, plus publish and deploy pipelines and manage schedules, groups, agent settings, enrollment tokens and device access. Cannot edit drafts.",
  Administrator:
    "All permissions, including managing people and recovering device identities.",
};
const results = [],
  requests = [],
  errors = [],
  unexpected = [],
  accessibility = [],
  measurements = [];
let page, state, failure;
function safe(value) {
  return String(value).replaceAll(syntheticPassword, "[synthetic credential]");
}
function release() {
  for (const done of state?.held.splice(0) || []) done();
}
async function load({ width = 899, theme = "light" } = {}) {
  release();
  if (page) await page.context().close();
  state = {
    people: structuredClone([admin, colleague]),
    mutations: [],
    hold: false,
    held: [],
  };
  const current = state;
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
    localStorage.setItem("vectory-sidebar-collapsed", "true");
  }, theme);
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    requests.push({ method, path, keys: body ? Object.keys(body).sort() : [] });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session") return reply({ user: admin, csrf_token: csrf });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic role fixture" });
      if (path === "/mfa") return reply({ enabled: false });
      if (path === "/users") return reply(current.people);
      const userRequest = path.match(/^\/users\/requests\/([^/]+)$/);
      if (userRequest)
        return reply({ request_id: userRequest[1], status: "not_found" });
    }
    if (request.headers()["x-csrf-token"] !== csrf) {
      unexpected.push(`Missing CSRF ${method} ${path}`);
      return reply(
        { error: { code: "FORBIDDEN", message: "Fixture CSRF missing" } },
        403,
      );
    }
    if (method === "POST" && path === "/users") {
      current.mutations.push({ method, body });
      if (current.hold) await new Promise((done) => current.held.push(done));
      const created = {
        id: "33333333-3333-4333-8333-333333333333",
        name: body.name,
        email: body.email,
        role: body.role,
        enabled: true,
        revision: 1,
      };
      current.people.push(created);
      return reply({ request_id: body.request_id, user: created });
    }
    if (method === "PUT" && path === `/users/${colleague.id}`) {
      current.mutations.push({ method, body });
      if (current.hold) await new Promise((done) => current.held.push(done));
      const existing = current.people.find(
        (person) => person.id === colleague.id,
      );
      if (existing.revision !== body.revision)
        return reply(
          { error: { code: "STALE_REVISION", message: "Fixture changed" } },
          409,
        );
      Object.assign(existing, {
        name: body.name,
        role: body.role,
        enabled: body.enabled,
        revision: existing.revision + 1,
      });
      return reply(existing);
    }
    unexpected.push(`${method} ${path}`);
    return reply(
      {
        error: {
          code: "UNEXPECTED_REQUEST",
          message: "Fixture rejects this operation",
        },
      },
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(safe(error.message)));
  await page.goto(`${origin}/__role-picker#/users`);
  await expect(
    page.getByRole("heading", { name: "People & security", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Edit access for Synthetic colleague",
      exact: true,
    }),
  ).toBeVisible();
}
const dialog = (name) => page.getByRole("dialog", { name, exact: true });
const menu = () => page.getByRole("menu");
const roleButton = (modal) =>
  modal.getByRole("button", { name: "Role", exact: true });
const option = (label) =>
  menu().getByRole("menuitemradio", { name: new RegExp(`^${label}\\b`) });
async function openAdd() {
  await page.getByRole("button", { name: "Add person", exact: true }).click();
  return dialog("Add a workspace user");
}
async function openEdit() {
  await page
    .getByRole("button", {
      name: "Edit access for Synthetic colleague",
      exact: true,
    })
    .click();
  return dialog("Edit workspace access");
}
async function choose(modal, label) {
  await roleButton(modal).click();
  await option(label).click();
  await expect(menu()).toHaveCount(0);
  await expect(modal).toBeVisible();
}
async function check(name, run) {
  const start = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - start });
  console.log("PASS " + name);
}
async function axe(label) {
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({
    label,
    violations: scan.violations.map((item) => ({
      id: item.id,
      targets: item.nodes.map((node) => node.target),
    })),
  });
  if (scan.violations.length) {
    measurements.push({
      label: `${label} accessibility diagnostic`,
      focus: await page.evaluate(() => ({
        active: document.activeElement?.outerHTML,
        menu: [...document.querySelectorAll(".role-picker-menu")].map(
          (element) => ({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            tabIndex: element.tabIndex,
            overflowY: getComputedStyle(element).overflowY,
            children: [...element.querySelectorAll("[role=menuitemradio]")].map(
              (item) => ({
                name: item.getAttribute("aria-label"),
                tabIndex: item.tabIndex,
              }),
            ),
          }),
        ),
      })),
    });
    await page.screenshot({
      path: resolve(output, "accessibility-failure.png"),
      animations: "disabled",
    });
  }
  expect(scan.violations).toEqual([]);
}
try {
  await check(
    "Add person defaults to Viewer; permission descriptions, keyboard selection, Escape and outside dismissal preserve the parent form",
    async () => {
      await load();
      const modal = await openAdd(),
        trigger = roleButton(modal);
      await expect(trigger).toContainText("Viewer");
      await expect(trigger).toContainText(descriptions.Viewer);
      await trigger.focus();
      await page.keyboard.press("Space");
      for (const [label, text] of Object.entries(descriptions)) {
        await expect(option(label)).toBeVisible();
        await expect(option(label)).toContainText(text);
      }
      await expect(option("Viewer")).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("End");
      await expect(option("Administrator")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(menu()).toHaveCount(0);
      await expect(modal).toBeVisible();
      await expect(trigger).toBeFocused();
      await expect(trigger).toContainText("Administrator");
      await trigger.click();
      await page.keyboard.press("Escape");
      await expect(modal).toBeVisible();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await modal
        .getByRole("heading", { name: "Add a workspace user", exact: true })
        .click();
      await expect(menu()).toHaveCount(0);
      await expect(modal).toBeVisible();
      await modal.getByLabel("Full name", { exact: true }).click();
      await expect(
        modal.getByLabel("Full name", { exact: true }),
      ).toBeFocused();
      expect(state.mutations).toEqual([]);
      await modal.getByRole("button", { name: "Cancel", exact: true }).click();
      const reopened = await openAdd();
      await expect(roleButton(reopened)).toContainText("Viewer");
      expect(state.mutations).toEqual([]);
    },
  );
  await check(
    "role selection remains local until Create user; a pending submission hides the secret and locks a single request",
    async () => {
      await load();
      const modal = await openAdd();
      await choose(modal, "Editor");
      expect(state.mutations).toEqual([]);
      await modal
        .getByLabel("Full name", { exact: true })
        .fill("Synthetic new person");
      await modal
        .getByLabel("Email", { exact: true })
        .fill("new@fixture.example.test");
      await modal
        .getByLabel("Initial password", { exact: true })
        .fill(syntheticPassword);
      state.hold = true;
      await modal
        .getByRole("button", { name: "Create user", exact: true })
        .click();
      await expect.poll(() => state.mutations.length).toBe(1);
      expect(state.mutations[0].body.role).toBe("editor");
      expect(state.people).toHaveLength(2);
      await expect(modal).toHaveCount(0);
      await expect(dialog("Waiting for account creation")).toBeVisible();
      await expect(page.getByLabel("Initial password")).toHaveCount(0);
      release();
      await expect(dialog("Waiting for account creation")).toHaveCount(0);
      await expect.poll(() => state.people.length).toBe(3);
      expect(state.people[2].role).toBe("editor");
    },
  );
  await check(
    "Edit access retains the account until Save access, preserves revision fields, and protects the last administrator",
    async () => {
      await load();
      const modal = await openEdit();
      await expect(roleButton(modal)).toContainText("Viewer");
      await choose(modal, "Operator");
      expect(state.people[1]).toEqual(colleague);
      expect(state.mutations).toEqual([]);
      await modal
        .getByLabel("Your current password", { exact: true })
        .fill(syntheticPassword);
      state.hold = true;
      await modal
        .getByRole("button", { name: "Save access", exact: true })
        .click();
      await expect.poll(() => state.mutations.length).toBe(1);
      const body = state.mutations[0].body;
      expect({
        name: body.name,
        role: body.role,
        revision: body.revision,
        enabled: body.enabled,
      }).toEqual({
        name: colleague.name,
        role: "operator",
        revision: 4,
        enabled: true,
      });
      await expect(roleButton(modal)).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(modal).toBeVisible();
      release();
      await expect(modal).toHaveCount(0);
      await expect.poll(() => state.people[1].role).toBe("operator");
      await page
        .getByRole("button", {
          name: "Edit access for Synthetic administrator",
          exact: true,
        })
        .click();
      const own = dialog("Edit workspace access");
      await expect(roleButton(own)).toBeDisabled();
      await expect(own).toContainText("last active administrator");
      expect(state.mutations).toHaveLength(1);
    },
  );
  await check(
    "role fields and open descriptions fit 899px and 375px light/dark with accessible parent-modal layering",
    async () => {
      for (const [width, theme, edit] of [
        [899, "light", false],
        [375, "light", false],
        [375, "dark", true],
      ]) {
        await load({ width, theme });
        const modal = edit ? await openEdit() : await openAdd();
        const label = `${width}-${theme}`;
        await axe(`closed role field ${label}`);
        await page.screenshot({
          path: resolve(output, `role-picker-closed-${label}.png`),
          animations: "disabled",
        });
        await roleButton(modal).click();
        await expect(menu()).toBeVisible();
        for (const role of Object.keys(descriptions))
          await expect(option(role)).toBeVisible();
        const bounds = await menu().boundingBox();
        measurements.push({ label, menu: bounds });
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await axe(`open role descriptions ${label}`);
        await page.screenshot({
          path: resolve(output, `role-picker-open-${label}.png`),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await expect(modal).toBeVisible();
        await expect(roleButton(modal)).toBeFocused();
        expect(state.mutations).toEqual([]);
      }
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
} catch (error) {
  failure = error;
  console.error(safe(error.stack));
  process.exitCode = 1;
} finally {
  release();
  const source_sha256 = {};
  for (const file of [
    "src/RolePicker.tsx",
    "src/DescribedPicker.tsx",
    "src/roles.ts",
    "src/role-picker.css",
    "src/UsersSecurity.tsx",
    "src/AccountAccess.tsx",
    "src/ui.tsx",
    "package-lock.json",
  ])
    source_sha256[`dashboard/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, file)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        passed: !failure,
        scope:
          "Actual App, UsersSecurity and WorkspaceAccess with isolated synthetic accounts and in-memory form submissions. No real preview/account mutations, authentication enforcement or native server claim. Reports omit credentials and request bodies; screenshots use blank forms and synthetic names.",
        results,
        accessibility,
        measurements,
        requests,
        errors,
        unexpected,
        source_sha256,
        ...(failure ? { failure: safe(failure.message) } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  if (page) await page.context().close();
  await browser.close();
  await vite.close();
  console.log(
    "Evidence: " + relative(repository, resolve(output, "report.json")),
  );
}
