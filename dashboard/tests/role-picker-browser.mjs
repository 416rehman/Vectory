// Actual App People & security with an isolated in-memory API; no real account writes.
// Covers the role picker, invitations, keyed request recovery and access edits.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
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
  status: "active",
  mfa_enabled: false,
  last_login_at: new Date().toISOString(),
  invite_expires_at: null,
};
const colleague = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Synthetic colleague",
  email: "colleague@fixture.example.test",
  role: "viewer",
  enabled: true,
  revision: 4,
  status: "active",
  mfa_enabled: true,
  last_login_at: null,
  invite_expires_at: null,
};
const syntheticPassword = "synthetic-password-not-real";
const inviteCode = "ab".repeat(32);
const csrf = "synthetic-role-picker-csrf";
const descriptions = {
  Viewer: "Sees devices, pipelines, deployments and activity.",
  Editor: "Creates and changes pipeline drafts. Doesn't publish or deploy.",
  Operator:
    "Publishes and deploys, and manages devices, groups, agent settings and enrollment. Doesn't edit drafts.",
  Administrator:
    "Everything, including managing people and recovering device identities.",
};
const results = [],
  requests = [],
  errors = [],
  unexpected = [],
  accessibility = [],
  measurements = [];
let page, state, failure;
function safe(value) {
  return String(value)
    .replaceAll(syntheticPassword, "[synthetic credential]")
    .replaceAll(inviteCode, "[synthetic invite]");
}
function release() {
  for (const done of state?.held.splice(0) || []) done();
}
function publicUser(person) {
  const { id, name, email, role, enabled, revision } = person;
  return { id, name, email, role, enabled, revision };
}
async function load({ width = 899, theme = "light" } = {}) {
  release();
  if (page) await page.context().close();
  state = {
    people: structuredClone([admin, colleague]),
    mutations: [],
    creations: new Map(),
    edits: new Map(),
    hold: false,
    held: [],
    // "lose": commit, then drop the response; "drop": drop before commit.
    createFault: null,
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
    const fail = (code, message, status) =>
      reply({ error: { code, message } }, status);
    if (method === "GET") {
      if (path === "/status")
        return reply({
          initialized: true,
          version: "synthetic",
          instance_name: "Synthetic role fixture",
        });
      if (path === "/session")
        return reply({ user: publicUser(admin), csrf_token: csrf });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic role fixture" });
      if (path === "/mfa")
        return reply({ enabled: false, recovery_codes_remaining: null });
      if (path === "/devices") return reply([]);
      if (path === "/account/sessions")
        return reply({
          sessions: [
            {
              id: "0123456789abcdef0123456789abcdef",
              current: true,
              created_at: null,
              last_seen_at: null,
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              user_agent: null,
              client_address: null,
            },
          ],
        });
      if (path === "/users") return reply(current.people);
      const creation = path.match(/^\/users\/requests\/([^/]+)$/);
      if (creation) {
        const entry = current.creations.get(creation[1]);
        return reply(
          !entry
            ? { request_id: creation[1], status: "not_found" }
            : entry.status === "cancelled"
              ? { request_id: creation[1], status: "cancelled" }
              : {
                  request_id: creation[1],
                  status: "created",
                  user: entry.user,
                },
        );
      }
      const edit = path.match(/^\/users\/([^/]+)\/access-requests\/([^/]+)$/);
      if (edit) {
        const entry = current.edits.get(edit[2]);
        return reply(
          entry
            ? { request_id: edit[2], user_id: edit[1], ...entry }
            : { request_id: edit[2], user_id: edit[1], status: "not_found" },
        );
      }
    }
    if (request.headers()["x-csrf-token"] !== csrf) {
      unexpected.push(`Missing CSRF ${method} ${path}`);
      return fail("FORBIDDEN", "Fixture CSRF missing", 403);
    }
    if (method === "POST" && path === "/users") {
      current.mutations.push({ method, path, body });
      if (current.hold) await new Promise((done) => current.held.push(done));
      if (current.people.some((person) => person.email === body.email))
        return fail("EMAIL_TAKEN", `Someone already uses ${body.email}.`, 409);
      if (current.createFault === "drop") return route.abort("failed");
      const invited = body.invite === true;
      const created = {
        id: "33333333-3333-4333-8333-33333333333" + current.people.length,
        name: body.name,
        email: body.email,
        role: body.role,
        enabled: true,
        revision: 1,
        status: invited ? "invited" : "active",
        mfa_enabled: false,
        last_login_at: null,
        invite_expires_at: invited
          ? new Date(Date.now() + 86400000).toISOString()
          : null,
      };
      current.people.push(created);
      current.creations.set(body.request_id, {
        status: "created",
        user: publicUser(created),
      });
      if (current.createFault === "lose") return route.abort("failed");
      return reply({
        request_id: body.request_id,
        user: publicUser(created),
        ...(invited
          ? {
              invite: {
                code: inviteCode,
                expires_at: created.invite_expires_at,
              },
            }
          : {}),
      });
    }
    const cancel = path.match(/^\/users\/requests\/([^/]+)\/cancel$/);
    if (method === "POST" && cancel) {
      current.mutations.push({ method, path, body });
      const entry = current.creations.get(cancel[1]);
      if (!entry) current.creations.set(cancel[1], { status: "cancelled" });
      return reply(
        entry?.status === "created"
          ? { request_id: cancel[1], status: "created", user: entry.user }
          : { request_id: cancel[1], status: "cancelled" },
      );
    }
    const put = path.match(/^\/users\/([^/]+)$/);
    if (method === "PUT" && put) {
      current.mutations.push({ method, path, body });
      if (current.hold) await new Promise((done) => current.held.push(done));
      const existing = current.people.find((person) => person.id === put[1]);
      if (body.current_password !== syntheticPassword)
        return fail(
          "WRONG_PASSWORD",
          "Your current password didn't match.",
          403,
        );
      if (existing.revision !== body.revision)
        return fail("STALE_REVISION", "This account changed.", 409);
      Object.assign(existing, {
        name: body.name,
        role: body.role,
        enabled: body.enabled,
        revision: existing.revision + 1,
      });
      current.edits.set(body.request_id, {
        status: "applied",
        user: publicUser(existing),
      });
      return reply({ request_id: body.request_id, user: publicUser(existing) });
    }
    unexpected.push(`${method} ${path}`);
    return fail("UNEXPECTED_REQUEST", "Fixture rejects this operation", 500);
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(safe(error.message)));
  // A cold dev-server transform can exceed the 8 s action timeout on a busy host.
  await page.goto(`${origin}/__role-picker#/users`, { timeout: 60000 });
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
const row = (text) =>
  page.locator(".people-table tbody tr", { hasText: text }).first();
async function openAdd() {
  await page.getByRole("button", { name: "Add person", exact: true }).click();
  return dialog("Add a person");
}
async function openEdit(name = "Synthetic colleague") {
  await page
    .getByRole("button", { name: `Edit access for ${name}`, exact: true })
    .click();
  return dialog("Edit workspace access");
}
async function choose(modal, label) {
  await roleButton(modal).click();
  await option(label).click();
  await expect(menu()).toHaveCount(0);
  await expect(modal).toBeVisible();
}
async function fillPerson(modal, name, email) {
  await modal.getByLabel("Name", { exact: true }).fill(name);
  await modal.getByLabel("Email", { exact: true }).fill(email);
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
  if (scan.violations.length)
    await page.screenshot({
      path: resolve(output, "accessibility-failure.png"),
      animations: "disabled",
    });
  expect(scan.violations).toEqual([]);
}
try {
  await check(
    "Add person defaults to Viewer and an invite; the role menu and capability preview work by keyboard, Escape and outside clicks",
    async () => {
      await load();
      const modal = await openAdd(),
        trigger = roleButton(modal);
      await expect(trigger).toContainText("Viewer");
      await expect(trigger).toContainText(descriptions.Viewer);
      await expect(
        modal.getByRole("radio", { name: /Send an invite link/ }),
      ).toBeChecked();
      await expect(modal).toContainText("This role can:");
      await modal.getByLabel("Name", { exact: true }).fill("Sam Rivera");
      await expect(modal).toContainText("Sam will be able to:");
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
      await expect(
        modal.locator(".role-capabilities li.yes", {
          hasText: "Manage people and recover device identities",
        }),
      ).toBeVisible();
      await choose(modal, "Editor");
      await expect(modal).toContainText(
        "Editors change drafts and operators publish them",
      );
      await trigger.click();
      await page.keyboard.press("Escape");
      await expect(modal).toBeVisible();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await modal
        .getByRole("heading", { name: "Add a person", exact: true })
        .click();
      await expect(menu()).toHaveCount(0);
      await expect(modal).toBeVisible();
      await expect(modal.getByLabel("Name", { exact: true })).toHaveValue(
        "Sam Rivera",
      );
      expect(state.mutations).toEqual([]);
      await modal.getByRole("button", { name: "Cancel", exact: true }).click();
      const reopened = await openAdd();
      await expect(roleButton(reopened)).toContainText("Viewer");
      await expect(reopened.getByLabel("Name", { exact: true })).toHaveValue(
        "",
      );
      expect(state.mutations).toEqual([]);
    },
  );
  await check(
    "an invitation is one keyed request without a password; its single-use link opens once and the table shows it",
    async () => {
      await load();
      const modal = await openAdd();
      await fillPerson(
        modal,
        "Synthetic invitee",
        "invitee@fixture.example.test",
      );
      await choose(modal, "Operator");
      state.hold = true;
      await modal
        .getByRole("button", { name: "Create invite link", exact: true })
        .click();
      await expect.poll(() => state.mutations.length).toBe(1);
      await expect(modal.getByLabel("Name", { exact: true })).toBeDisabled();
      await expect(
        modal.getByRole("button", { name: "Stop waiting", exact: true }),
      ).toBeVisible();
      const sent = state.mutations[0].body;
      expect(Object.keys(sent).sort()).toEqual([
        "email",
        "invite",
        "name",
        "request_id",
        "role",
      ]);
      expect(sent.role).toBe("operator");
      release();
      const link = dialog("Invite link for Synthetic invitee");
      await expect(link).toBeVisible();
      const url = await link.locator(".copy-line code").innerText();
      expect(url).toBe(`${origin}/__role-picker#/invite?code=${inviteCode}`);
      await expect(link).toContainText("It works once, until");
      await link.getByRole("button", { name: "Done", exact: true }).click();
      await expect(link).toHaveCount(0);
      await expect(row("invitee@fixture.example.test")).toContainText(
        "Invited",
      );
      await expect(row("invitee@fixture.example.test")).toContainText(
        "Link expires in",
      );
      const html = await page.content();
      expect(html.includes(inviteCode)).toBe(false);
      expect(state.mutations).toHaveLength(1);
    },
  );
  await check(
    "a duplicate email stays next to the field with a way to find that person; nothing is resent",
    async () => {
      await load();
      const modal = await openAdd();
      await fillPerson(modal, "Someone else", colleague.email);
      await modal.getByText("Set a password now").click();
      await modal
        .getByRole("button", { name: "Generate", exact: true })
        .click();
      await modal
        .getByRole("button", { name: "Add person", exact: true })
        .click();
      const email = modal.getByLabel("Email", { exact: true });
      await expect(modal).toContainText(
        `Someone already uses ${colleague.email}.`,
      );
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await expect(modal.getByLabel("Name", { exact: true })).toHaveValue(
        "Someone else",
      );
      await expect(modal.getByLabel("Password for Someone")).toHaveValue("");
      expect(state.mutations).toHaveLength(1);
      expect(Object.keys(state.mutations[0].body).sort()).toEqual([
        "email",
        "name",
        "password",
        "request_id",
        "role",
      ]);
      await modal
        .getByRole("button", { name: "Show in Workspace access", exact: true })
        .click();
      await expect(modal).toHaveCount(0);
      await expect(row(colleague.email)).toHaveClass(/person-highlight/);
      expect(state.mutations).toHaveLength(1);
    },
  );
  await check(
    "a lost creation response is read back automatically; an unknown one is cancelled before a new attempt keeps the entries",
    async () => {
      await load();
      state.createFault = "lose";
      let modal = await openAdd();
      await fillPerson(modal, "Lost response", "lost@fixture.example.test");
      await modal
        .getByRole("button", { name: "Create invite link", exact: true })
        .click();
      const ready = dialog("Lost response's account is ready");
      await expect(ready).toBeVisible();
      await expect(ready).toContainText("We couldn't show the invite link.");
      await expect(
        ready.getByRole("button", { name: "Create invite link", exact: true }),
      ).toBeVisible();
      expect(state.mutations).toHaveLength(1);
      await ready.getByRole("button", { name: "Done", exact: true }).click();
      await expect(row("lost@fixture.example.test")).toContainText("Invited");
      state.createFault = "drop";
      modal = await openAdd();
      await fillPerson(
        modal,
        "Dropped request",
        "dropped@fixture.example.test",
      );
      await choose(modal, "Editor");
      await modal
        .getByRole("button", { name: "Create invite link", exact: true })
        .click();
      await expect(modal).toContainText(
        "We couldn't confirm Dropped request's account was created",
      );
      const first = state.mutations.at(-1).body.request_id;
      await modal.getByText("Technical details").click();
      await expect(modal).toContainText(first);
      state.createFault = null;
      await modal
        .getByRole("button", { name: "Cancel it and try again", exact: true })
        .click();
      await expect(modal.getByLabel("Name", { exact: true })).toHaveValue(
        "Dropped request",
      );
      await expect(modal.getByLabel("Email", { exact: true })).toHaveValue(
        "dropped@fixture.example.test",
      );
      await expect(roleButton(modal)).toContainText("Editor");
      expect(state.mutations.at(-1).path).toBe(
        `/users/requests/${first}/cancel`,
      );
      await modal
        .getByRole("button", { name: "Create invite link", exact: true })
        .click();
      await expect(dialog("Invite link for Dropped request")).toBeVisible();
      const second = state.mutations.at(-1).body.request_id;
      expect(second).not.toBe(first);
      expect(state.creations.get(first).status).toBe("cancelled");
    },
  );
  await check(
    "editing access shows what saving does, sends one keyed request, and protects the last administrator",
    async () => {
      await load();
      const modal = await openEdit();
      await expect(roleButton(modal)).toContainText("Viewer");
      await choose(modal, "Operator");
      await expect(modal).toContainText(
        "Change the role from Viewer to Operator",
      );
      await expect(modal).toContainText(
        "Sign Synthetic out of every browser and cancel their unused links",
      );
      expect(state.mutations).toEqual([]);
      await modal
        .getByLabel("Your password", { exact: true })
        .fill("wrong-synthetic-password");
      await modal
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect(modal).toContainText("Your password didn't match.");
      await expect(roleButton(modal)).toContainText("Operator");
      await modal
        .getByLabel("Your password", { exact: true })
        .fill(syntheticPassword);
      state.hold = true;
      await modal
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect.poll(() => state.mutations.length).toBe(2);
      const body = state.mutations[1].body;
      expect(Object.keys(body).sort()).toEqual([
        "current_password",
        "enabled",
        "name",
        "request_id",
        "revision",
        "role",
      ]);
      expect({ role: body.role, revision: body.revision }).toEqual({
        role: "operator",
        revision: 4,
      });
      expect(body.request_id).not.toBe(state.mutations[0].body.request_id);
      await expect(roleButton(modal)).toBeDisabled();
      release();
      await expect(modal).toHaveCount(0);
      await expect(row(colleague.email)).toContainText("Operator");
      await openEdit("Synthetic administrator");
      const own = dialog("Edit workspace access");
      await expect(roleButton(own)).toBeDisabled();
      await expect(own).toContainText("You're the only active administrator.");
      expect(state.mutations).toHaveLength(2);
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
        if (width < 760)
          await expect(
            page.getByRole("list", { name: "Workspace access", exact: true }),
          ).toBeVisible();
        await axe(`people page ${width}-${theme}`);
        const modal = edit
          ? await (async () => {
              await page
                .getByRole("list", { name: "Workspace access", exact: true })
                .getByRole("button", {
                  name: "Edit access for Synthetic colleague",
                  exact: true,
                })
                .click();
              return dialog("Edit workspace access");
            })()
          : await openAdd();
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
    "src/AddPersonActions.tsx",
    "src/AdminPasswordResetActions.tsx",
    "src/keyedRequest.ts",
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
          "Actual App, UsersSecurity, AddPersonActions and WorkspaceAccess with isolated synthetic accounts and in-memory keyed requests, including dropped and lost responses. No real preview/account mutations, authentication enforcement or native server claim. Reports omit credentials, invite codes and request bodies; screenshots use blank forms and synthetic names.",
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
