// Actual App auth UI with isolated synthetic transport. No real accounts or secrets.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Any free port: parallel runs never collide.
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_STAGED_LOGIN_OUTPUT || ".local/staged-login",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:staged-login-fixture";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {},
    hmr: false,
  },
  plugins: [
    {
      name: "staged-login-fixture",
      resolveId(id) {
        if (id === "virtual:staged-login-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__staged-login") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic staged login verification</title></head><body><div id="root"></div><script type="module">import "virtual:staged-login-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch();
const results = [],
  unexpected = [],
  errors = [],
  requestSummaries = [],
  accessibility = [],
  layouts = [];
const credentials = {
  email: "synthetic-mfa@example.test",
  password: "synthetic-only-password",
};
const user = {
  id: "synthetic-user",
  email: credentials.email,
  name: "Synthetic user",
  role: "viewer",
  enabled: true,
  revision: 1,
};
// A teammate invited with a hyphenated address.
const invited = {
  email: "ops-teammate@example.com",
  name: "Synthetic teammate",
};
const inviteCode = "c".repeat(64);
async function fixture({
  mfa = true,
  setupPath = null,
  setupInitializedAfterPost = false,
  setupStatusUnavailableAfterPost = false,
  route = "users",
  theme = "light",
} = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: theme,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  // On a slow or busy device the next frame can come after the person has
  // already moved on. A test can hold the page's animation frames and let them
  // run at the moment it chooses.
  await context.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window),
      cancel = window.cancelAnimationFrame.bind(window),
      held = new Map();
    let holding = false,
      next = 1e9;
    window.requestAnimationFrame = (callback) => {
      if (!holding) return request(callback);
      held.set(++next, callback);
      return next;
    };
    window.cancelAnimationFrame = (id) => {
      if (!held.delete(id)) cancel(id);
    };
    window.holdFrames = () => (holding = true);
    window.releaseFrames = () => {
      holding = false;
      for (const [id, callback] of [...held]) {
        held.delete(id);
        callback(performance.now());
      }
    };
  });
  const state = {
    mfa,
    authenticated: false,
    challenge: "",
    issued: 0,
    attempts: 0,
    expiry: false,
    holdLogin: false,
    holdVerification: false,
    held: [],
    requests: [],
    setupInitialized: false,
    setupStatusUnavailable: false,
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace("/api/v1", ""),
      method = req.method();
    const body = req.postData() ? req.postDataJSON() : null;
    state.requests.push({ path, method, body });
    requestSummaries.push({
      path,
      method,
      keys: body ? Object.keys(body).sort() : [],
    });
    const reply = async (json, status = 200) => {
      try {
        await route.fulfill({ status, json });
      } catch {}
    };
    const session = () => ({ user, csrf_token: "synthetic-csrf" });
    if (path === "/status") {
      if (state.setupStatusUnavailable)
        return reply(
          { error: { code: "UNAVAILABLE", message: "Synthetic unavailable" } },
          503,
        );
      return reply(
        setupPath
          ? {
              initialized: state.setupInitialized,
              version: "synthetic",
              setup_hint: {
                source: "file",
                variable: "VECTORY_BOOTSTRAP_SECRET_FILE",
                container: false,
                path: setupPath,
              },
            }
          : { initialized: true, version: "synthetic" },
      );
    }
    if (path === "/bootstrap" && method === "POST") {
      state.setupInitialized = setupInitializedAfterPost;
      state.setupStatusUnavailable = setupStatusUnavailableAfterPost;
      return reply(
        { error: { code: "UNAVAILABLE", message: "Synthetic unavailable" } },
        503,
      );
    }
    if (path === "/invite/preview" && method === "POST")
      return reply({
        ...invited,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        instance_name: "Synthetic verification",
      });
    if (path === "/invite/accept" && method === "POST") {
      state.authenticated = true;
      return reply({
        user: { ...user, ...invited },
        csrf_token: "synthetic-csrf",
      });
    }
    if (path === "/session")
      return state.authenticated
        ? reply(session())
        : reply(
            { error: { code: "UNAUTHENTICATED", message: "Sign in required" } },
            401,
          );
    if (path === "/login" && method === "POST") {
      expect(body).not.toHaveProperty("totp_code");
      expect(body).not.toHaveProperty("recovery_code");
      if (
        body.email !== credentials.email ||
        body.password !== credentials.password
      )
        return reply(
          {
            error: { code: "UNAUTHENTICATED", message: "Invalid credentials" },
          },
          401,
        );
      if (!state.mfa) {
        state.authenticated = true;
        return reply(session());
      }
      state.challenge = String(++state.issued).padStart(64, "0");
      state.attempts = 0;
      const next = {
        mfa_required: true,
        challenge_token: state.challenge,
        expires_at: new Date(Date.now() + 300000).toISOString(),
      };
      const send = () => reply(next);
      if (state.holdLogin) {
        state.held.push(send);
        return;
      }
      return send();
    }
    if (path === "/login/mfa" && method === "POST") {
      expect(Object.keys(body).sort()).toEqual([
        "challenge_token",
        body.recovery_code !== undefined ? "recovery_code" : "totp_code",
      ]);
      expect(body).not.toHaveProperty("password");
      expect(body).not.toHaveProperty("email");
      if (
        state.expiry ||
        body.challenge_token !== state.challenge ||
        ++state.attempts >= 5
      )
        return reply(
          {
            error: {
              code: "MFA_CHALLENGE_EXPIRED",
              message: "Sign-in verification expired. Start again.",
            },
          },
          401,
        );
      if (
        body.totp_code !== "246810" &&
        body.recovery_code !== "synthetic-recovery-code"
      )
        return reply(
          {
            error: {
              code: "INVALID_MFA_CODE",
              message: "The verification code is invalid. Try again.",
            },
          },
          401,
        );
      const send = () => {
        state.authenticated = true;
        state.challenge = "";
        return reply(session());
      };
      if (state.holdVerification) {
        state.held.push(send);
        return;
      }
      return send();
    }
    if (path === "/settings" && state.authenticated)
      return reply({ instance_name: "Synthetic verification" });
    if (path === "/account/sessions" && state.authenticated)
      return reply({ sessions: [] });
    if (path === "/mfa" && state.authenticated)
      return reply({
        enabled: state.mfa,
        recovery_codes_remaining: state.mfa ? 7 : null,
      });
    if (path === "/password-reset" && method === "POST")
      return reply(
        {
          error: {
            code: "RESET_CODE_INVALID",
            message: "This reset code is invalid, expired or already used.",
          },
        },
        401,
      );
    unexpected.push({ path, method });
    return reply(
      {
        error: { code: "UNEXPECTED", message: "Unexpected synthetic request" },
      },
      500,
    );
  });
  await page.goto(`http://127.0.0.1:${port}/__staged-login#/${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await expect(
    page.getByRole("heading", {
      name: setupPath
        ? "Set up Vectory"
        : route.startsWith("invite")
          ? /^Join /
          : route.startsWith("reset")
            ? "Reset your password"
            : /^Sign in to /,
    }),
  ).toBeVisible({ timeout: 15000 });
  return {
    context,
    page,
    state,
    async credentials(password = credentials.password) {
      await page
        .getByLabel("Email address", { exact: true })
        .fill(credentials.email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    },
    async release() {
      await Promise.all(state.held.splice(0).map((send) => send()));
    },
    async close() {
      await context.close();
    },
  };
}
async function check(name, run) {
  const started = Date.now();
  await run();
  results.push({ name, status: "passed", milliseconds: Date.now() - started });
  console.log("PASS " + name);
}
async function pending(f) {
  await expect(
    f.page.getByRole("heading", {
      name: "Two-factor authentication",
      exact: true,
    }),
  ).toBeVisible();
  await expect(f.page.getByLabel("Password", { exact: true })).toHaveCount(0);
  expect(f.state.authenticated).toBe(false);
  expect(
    await f.page.evaluate(async () => (await fetch("/api/v1/session")).status),
  ).toBe(401);
}
try {
  await check(
    "credentials first, no partial session, isolated factor body and preserved destination",
    async () => {
      const f = await fixture();
      try {
        await expect(
          f.page.getByRole("link", { name: "Notices (opens in a new tab)" }),
        ).toHaveAttribute("href", "/NOTICE.txt");
        const notices = await f.page.request.get(
          `http://127.0.0.1:${port}/NOTICE.txt`,
        );
        expect(notices.ok()).toBe(true);
        expect(await notices.text()).toContain(
          "Copyright (c) Meta Platforms, Inc. and affiliates.",
        );
        await expect(
          f.page.getByLabel("Authenticator code", { exact: true }),
        ).toHaveCount(0);
        await expect(
          f.page.getByRole("button", { name: "Use a recovery code" }),
        ).toHaveCount(0);
        await f.credentials("incorrect-password");
        await expect(f.page.getByRole("alert")).toBeVisible();
        expect(f.state.issued).toBe(0);
        await f.credentials();
        await pending(f);
        await expect(
          f.page.getByLabel("Authenticator code", { exact: true }),
        ).toBeFocused();
        const stored = await f.page.evaluate(() =>
          JSON.stringify({
            local: { ...localStorage },
            session: { ...sessionStorage },
            hash: location.hash,
          }),
        );
        expect(stored.includes(f.state.challenge)).toBe(false);
        expect(stored.includes(credentials.password)).toBe(false);
        await f.page
          .getByLabel("Authenticator code", { exact: true })
          .fill("111111");
        await expect(f.page.getByText(/code didn't work/i)).toBeVisible();
        await pending(f);
        await expect(
          f.page.getByLabel("Authenticator code", { exact: true }),
        ).toHaveValue("");
        await expect(
          f.page.getByLabel("Authenticator code", { exact: true }),
        ).toBeFocused();
        await f.page
          .getByLabel("Authenticator code", { exact: true })
          .fill("246810");
        await expect(
          f.page.getByRole("heading", {
            name: "People & security",
            exact: true,
          }),
        ).toBeVisible();
        expect(f.page.url()).toContain("#/users");
        expect(
          f.state.requests.filter((r) => r.path === "/login/mfa"),
        ).toHaveLength(2);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Back, method switching and reload clear challenge input without retaining passwords",
    async () => {
      const f = await fixture();
      try {
        await f.credentials();
        await pending(f);
        const first = f.state.challenge;
        await f.page
          .getByLabel("Authenticator code", { exact: true })
          .fill("12345");
        await f.page
          .getByRole("button", {
            name: "Use a recovery code",
            exact: true,
          })
          .click();
        await expect(
          f.page.getByLabel("Recovery code", { exact: true }),
        ).toBeFocused();
        await expect(
          f.page.getByLabel("Recovery code", { exact: true }),
        ).toHaveValue("");
        await f.page
          .getByLabel("Recovery code", { exact: true })
          .fill("synthetic-unused");
        await f.page
          .getByRole("button", {
            name: "Use your authenticator app",
            exact: true,
          })
          .click();
        await expect(
          f.page.getByLabel("Authenticator code", { exact: true }),
        ).toHaveValue("");
        await f.page.getByRole("button", { name: "Back", exact: true }).click();
        await expect(
          f.page.getByLabel("Email address", { exact: true }),
        ).toHaveValue(credentials.email);
        await expect(
          f.page.getByLabel("Password", { exact: true }),
        ).toHaveValue("");
        await f.credentials();
        await pending(f);
        expect(f.state.challenge === first).toBe(false);
        await f.page.reload();
        await expect(
          f.page.getByRole("heading", { name: /^Sign in to / }),
        ).toBeVisible();
        await expect(
          f.page.getByLabel("Password", { exact: true }),
        ).toHaveValue("");
        expect(
          f.state.requests.filter((r) => r.path === "/login/mfa"),
        ).toHaveLength(0);
        await f.credentials();
        await pending(f);
        await f.page
          .getByRole("button", {
            name: "Use a recovery code",
            exact: true,
          })
          .click();
        await f.page
          .getByLabel("Recovery code", { exact: true })
          .fill("synthetic-used-recovery-code");
        await f.page
          .getByRole("button", { name: "Verify", exact: true })
          .click();
        await expect(
          f.page.getByText(/recovery code didn't work/i),
        ).toBeVisible();
        await expect(
          f.page.getByLabel("Recovery code", { exact: true }),
        ).toHaveValue("");
        await expect(
          f.page.getByLabel("Recovery code", { exact: true }),
        ).toBeFocused();
        await f.page
          .getByLabel("Recovery code", { exact: true })
          .fill("synthetic-recovery-code");
        await f.page
          .getByRole("button", { name: "Verify", exact: true })
          .click();
        await expect(
          f.page.getByRole("heading", {
            name: "People & security",
            exact: true,
          }),
        ).toBeVisible();
        // The person learns that the code is spent and how many are left. The
        // toast is announced to screen readers too, so the words appear twice
        // in the page: look at the one people see.
        await expect(
          f.page
            .getByRole("region", { name: "Notifications" })
            .getByText("You used a recovery code; 7 left.", { exact: true }),
        ).toBeVisible();
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "expired challenge restarts sign-in and busy stages prevent conflicting inputs",
    async () => {
      const f = await fixture();
      try {
        f.state.holdLogin = true;
        await f.credentials();
        await expect.poll(() => f.state.held.length).toBe(1);
        await expect(
          f.page.getByLabel("Email address", { exact: true }),
        ).toBeDisabled();
        await expect(
          f.page.getByLabel("Password", { exact: true }),
        ).toBeDisabled();
        await f.release();
        f.state.holdLogin = false;
        await pending(f);
        f.state.expiry = true;
        await f.page
          .getByLabel("Authenticator code", { exact: true })
          .fill("246810");
        await expect(
          f.page.getByRole("heading", { name: /^Sign in to / }),
        ).toBeVisible();
        await expect(
          f.page.getByLabel("Password", { exact: true }),
        ).toHaveValue("");
        await expect(
          f.page
            .getByText(/verification expired|sign in again|start again/i)
            .first(),
        ).toBeVisible();
        expect(f.state.authenticated).toBe(false);
        f.state.expiry = false;
        await f.credentials();
        await pending(f);
        f.state.holdVerification = true;
        await f.page
          .getByLabel("Authenticator code", { exact: true })
          .fill("246810");
        await expect.poll(() => f.state.held.length).toBe(1);
        await expect(
          f.page.getByLabel("Authenticator code", { exact: true }),
        ).toBeDisabled();
        await expect(
          f.page.getByRole("button", { name: "Back", exact: true }),
        ).toBeDisabled();
        await expect(
          f.page.getByRole("button", {
            name: "Use a recovery code",
            exact: true,
          }),
        ).toBeDisabled();
        await f.release();
        await expect(
          f.page.getByRole("heading", {
            name: "People & security",
            exact: true,
          }),
        ).toBeVisible();
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "non-MFA stays one-step and mobile verification is accessible in both themes",
    async () => {
      const direct = await fixture({ mfa: false });
      try {
        await direct.credentials();
        await expect(
          direct.page.getByRole("heading", {
            name: "People & security",
            exact: true,
          }),
        ).toBeVisible();
        expect(direct.state.requests.some((r) => r.path === "/login/mfa")).toBe(
          false,
        );
      } finally {
        await direct.close();
      }
      const f = await fixture();
      try {
        await f.credentials();
        await pending(f);
        await f.page.setViewportSize({ width: 375, height: 812 });
        for (const theme of ["light", "dark"]) {
          await f.page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          expect(
            await f.page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          const axe = await new AxeBuilder({ page: f.page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
          const violations = axe.violations.map((item) => ({
            id: item.id,
            impact: item.impact,
          }));
          accessibility.push({ theme, width: 375, violations });
          expect(violations).toEqual([]);
          await f.page.screenshot({
            path: resolve(output, "staged-login-mobile-" + theme + ".png"),
            animations: "disabled",
          });
        }
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "every auth screen fits 320 to 430 px without sideways scrolling, including a long setup-secret command",
    async () => {
      const screens = [
        {
          name: "setup",
          options: {
            setupPath: "/home/you/Vectory/.local/preview/bootstrap.secret",
          },
          themes: ["light", "dark"],
        },
        {
          name: "setup-long-path",
          options: {
            setupPath:
              "/srv/vectory/deployments/production-control-plane/secrets/bootstrap.secret",
          },
          themes: ["light"],
        },
        { name: "signin", options: {}, themes: ["light"] },
        { name: "reset", options: { route: "reset" }, themes: ["light"] },
        {
          name: "invite",
          options: { route: `invite?code=${inviteCode}` },
          themes: ["light", "dark"],
        },
        { name: "mfa", options: {}, mfa: true, themes: ["light", "dark"] },
      ];
      for (const screen of screens)
        for (const theme of screen.themes) {
          const f = await fixture({ ...screen.options, theme });
          try {
            if (screen.mfa) {
              await f.credentials();
              await pending(f);
            }
            for (const width of [320, 360, 390, 430]) {
              await f.page.setViewportSize({ width, height: 900 });
              const layout = await f.page.evaluate(() => {
                const code = document.querySelector(".copy-line > code");
                const card = document
                  .querySelector(".signin-card")
                  .getBoundingClientRect();
                return {
                  page: document.documentElement.scrollWidth,
                  viewport: innerWidth,
                  commandRight: code
                    ? code.getBoundingClientRect().right
                    : null,
                  // Anything that sticks out past the card's edge.
                  outside: [...document.querySelectorAll(".signin-card *")]
                    .filter(
                      (element) =>
                        element.getBoundingClientRect().right > card.right + 1,
                    )
                    .map((element) => element.className || element.tagName),
                };
              });
              layouts.push({ screen: screen.name, theme, width, ...layout });
              expect(
                layout.page,
                `${screen.name} at ${width}`,
              ).toBeLessThanOrEqual(layout.viewport);
              expect(layout.outside, `${screen.name} at ${width}`).toEqual([]);
              // A long command stays inside its own box.
              if (layout.commandRight !== null)
                expect(layout.commandRight).toBeLessThanOrEqual(width);
              if (
                screen.name !== "setup-long-path" &&
                (width !== 360 || theme === "dark")
              )
                await f.page.screenshot({
                  path: resolve(
                    output,
                    `auth-${screen.name}-${width}-${theme}.png`,
                  ),
                  fullPage: true,
                  animations: "disabled",
                });
            }
          } finally {
            await f.close();
          }
        }
    },
  );
  await check(
    "typing after Back to sign in stays in the field the person chose when the next frame comes late",
    async () => {
      const f = await fixture({ route: `reset?code=${"a".repeat(64)}` });
      try {
        const chosen = "violet-harbor-lantern-2046";
        await f.page.getByLabel("New password", { exact: true }).fill(chosen);
        await f.page
          .getByLabel("Confirm new password", { exact: true })
          .fill(chosen);
        await f.page
          .getByRole("button", { name: "Save new password", exact: true })
          .click();
        await expect(f.page.getByRole("alert")).toContainText(
          "invalid, expired or already used",
        );
        // The person is quicker than this device's next frame.
        await f.page.evaluate(() => window.holdFrames());
        await f.page
          .getByRole("button", { name: "Back to sign in", exact: true })
          .click();
        const email = f.page.getByLabel("Email address", { exact: true }),
          password = f.page.getByLabel("Password", { exact: true });
        await email.fill(credentials.email);
        await password.click();
        await f.page.keyboard.type(credentials.password.slice(0, 8));
        await f.page.evaluate(() => window.releaseFrames());
        await f.page.keyboard.type(credentials.password.slice(8));
        await expect(password).toBeFocused();
        await expect(email).toHaveValue(credentials.email);
        expect(
          await password.evaluate(
            (input, typed) => input.value === typed,
            credentials.password,
          ),
        ).toBe(true);
        await f.page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await pending(f);
        expect(
          f.state.requests
            .filter((request) => request.path === "/login")
            .map((request) => request.body),
        ).toEqual([credentials]);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "the setup form says each problem once, clears it as you type and focuses the first field to fix",
    async () => {
      const f = await fixture({
        setupPath: "/home/you/Vectory/.local/preview/bootstrap.secret",
      });
      try {
        const submit = f.page.getByRole("button", {
          name: "Create administrator account",
          exact: true,
        });
        const secret = f.page.getByLabel("Setup secret", { exact: true });
        await submit.click();
        await expect(
          f.page.getByText("Paste the setup secret from your server.", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          f.page.getByText("Enter your name.", { exact: true }),
        ).toBeVisible();
        await expect(secret).toBeFocused();
        // Typing in a field clears its own error only.
        await secret.fill("synthetic-setup-secret");
        await expect(
          f.page.getByText("Paste the setup secret from your server."),
        ).toHaveCount(0);
        await expect(
          f.page.getByText("Enter your name.", { exact: true }),
        ).toBeVisible();
        await f.page
          .getByLabel("Your name", { exact: true })
          .fill("Synthetic admin");
        await f.page
          .getByLabel("Email address", { exact: true })
          .fill("ops-admin@example.com");
        const password = f.page.getByLabel("Password", { exact: true });
        await password.fill("password");
        await f.page
          .getByLabel("Confirm password", { exact: true })
          .fill("password");
        await submit.click();
        await expect(password).toBeFocused();
        // The weak-password advice appears once: the error, not the meter too.
        await expect(f.page.locator(".auth-field-error")).toHaveCount(1);
        await expect(f.page.locator(".password-meter")).toHaveCount(0);
        await password.fill("password1");
        await expect(f.page.locator(".auth-field-error")).toHaveCount(0);
        await expect(f.page.locator(".password-meter")).toHaveCount(1);
        expect(
          f.state.requests.filter((r) => r.path === "/bootstrap"),
        ).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "an uncertain first-admin request keeps setup and status snapshots separate",
    async () => {
      const start = async (options) => {
        const f = await fixture({
          setupPath: "/run/secrets/bootstrap",
          ...options,
        });
        await f.page
          .getByLabel("Setup secret", { exact: true })
          .fill("synthetic-setup-secret");
        await f.page
          .getByLabel("Your name", { exact: true })
          .fill("Synthetic administrator");
        await f.page
          .getByLabel("Email address", { exact: true })
          .fill("admin@example.test");
        await f.page
          .getByLabel("Password", { exact: true })
          .fill("Synthetic private password 2026!");
        await f.page
          .getByLabel("Confirm password", { exact: true })
          .fill("Synthetic private password 2026!");
        await f.page
          .getByRole("button", { name: "Create administrator account" })
          .click();
        return f;
      };
      const first = await start({});
      try {
        const review = first.page.getByRole("status").filter({
          has: first.page.getByRole("heading", {
            name: "First administrator setup is unconfirmed",
          }),
        });
        await expect(review).toContainText("has not reported setup yet");
        await expect(review).toContainText(
          "earlier request; it may still finish",
        );
        await expect(
          first.page.getByRole("button", {
            name: "Create administrator account",
          }),
        ).toHaveCount(0);
        await expect(
          first.page.getByRole("button", { name: "Check setup status" }),
        ).toBeFocused();
        await first.page.setViewportSize({ width: 390, height: 844 });
        for (const theme of ["light", "dark"]) {
          await first.page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
          }, theme);
          expect(
            await first.page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          const axe = await new AxeBuilder({ page: first.page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
          expect(
            axe.violations.map(({ id, impact }) => ({ id, impact })),
          ).toEqual([]);
          await first.page.screenshot({
            path: resolve(output, `auth-setup-recovery-390-${theme}.png`),
            animations: "disabled",
          });
        }
        expect(
          first.state.requests.filter((r) => r.path === "/bootstrap"),
        ).toHaveLength(1);
        first.state.setupInitialized = true;
        await first.page
          .getByRole("button", { name: "Check setup status" })
          .click();
        await expect(review).toContainText(
          "does not show whether your request created the account",
        );
        expect(
          first.state.requests.filter((r) => r.path === "/bootstrap"),
        ).toHaveLength(1);
        await first.page
          .getByRole("button", { name: "Try signing in" })
          .click();
        await expect(
          first.page.getByRole("heading", { name: /^Sign in to / }),
        ).toBeVisible();
        await expect(
          first.page.getByLabel("Email address", { exact: true }),
        ).toHaveValue("admin@example.test");
        await expect(
          first.page.getByText(
            "A setup status check cannot confirm which request created the account.",
            { exact: false },
          ),
        ).toBeVisible();
      } finally {
        await first.close();
      }
      const second = await start({ setupStatusUnavailableAfterPost: true });
      try {
        const review = second.page.getByRole("status").filter({
          has: second.page.getByRole("heading", {
            name: "First administrator setup is unconfirmed",
          }),
        });
        await expect(review).toContainText(
          "could not check whether setup finished",
        );
        await expect(
          second.page.getByRole("button", { name: "Start a new setup" }),
        ).toHaveCount(0);
        second.state.setupStatusUnavailable = false;
        await second.page
          .getByRole("button", { name: "Check setup status" })
          .click();
        await expect(review).toContainText("has not reported setup yet");
        await second.page
          .getByRole("button", { name: "Start a new setup" })
          .click();
        await expect(
          second.page.getByRole("button", {
            name: "Create administrator account",
          }),
        ).toBeVisible();
        await expect(
          second.page.getByLabel("Setup secret", { exact: true }),
        ).toHaveValue("");
        await expect(
          second.page.getByLabel("Setup secret", { exact: true }),
        ).toBeFocused();
        await expect(
          second.page.getByLabel("Password", { exact: true }),
        ).toHaveValue("");
        expect(
          second.state.requests.filter((r) => r.path === "/bootstrap"),
        ).toHaveLength(1);
      } finally {
        await second.close();
      }
      const third = await start({ setupInitializedAfterPost: true });
      try {
        await expect(
          third.page.getByRole("heading", {
            name: "First administrator setup is unconfirmed",
          }),
        ).toBeVisible();
        await expect(
          third.page.getByRole("heading", { name: /^Sign in to / }),
        ).toHaveCount(0);
        await expect(
          third.page.getByText(
            "does not show whether your request created the account",
            { exact: false },
          ),
        ).toBeVisible();
      } finally {
        await third.close();
      }
    },
  );
  await check("the welcome text keeps a hyphenated email whole", async () => {
    // The number of lines a text spans.
    const lines = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set(
        [...range.getClientRects()].map((rect) => Math.round(rect.top)),
      ).size;
    };
    for (const theme of ["light", "dark"]) {
      const f = await fixture({
        route: `invite?code=${inviteCode}`,
        theme,
      });
      try {
        // The invitation names the address too.
        await f.page.setViewportSize({ width: 320, height: 900 });
        const invitedAddress = f.page.locator(".signin-lede .auth-email");
        await expect(invitedAddress).toHaveText(invited.email);
        expect(await invitedAddress.evaluate(lines)).toBe(1);
        await f.page.setViewportSize({ width: 390, height: 900 });
        const chosen = "violet-harbor-lantern-2046";
        await f.page.getByLabel("Password", { exact: true }).fill(chosen);
        await f.page
          .getByLabel("Confirm password", { exact: true })
          .fill(chosen);
        await f.page
          .getByRole("button", { name: "Create my account", exact: true })
          .click();
        await expect(
          f.page.getByRole("heading", { name: /^Welcome, / }),
        ).toBeVisible();
        const address = f.page.locator(".signin-lede .auth-email");
        await expect(address).toHaveText(invited.email);
        for (const width of [320, 390]) {
          await f.page.setViewportSize({ width, height: 900 });
          // One line of text: the address never breaks at its hyphen.
          expect(
            await address.evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return new Set(
                [...range.getClientRects()].map((rect) => Math.round(rect.top)),
              ).size;
            }),
          ).toBe(1);
        }
        await f.page.screenshot({
          path: resolve(output, `auth-welcome-320-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        await f.close();
      }
    }
  });
  await check(
    "a new refusal replaces the old one, and the two-factor step shows the address's first letter",
    async () => {
      const f = await fixture();
      try {
        const refused = "That email and password don't match. Try again.";
        await f.credentials("incorrect-password");
        await expect(f.page.getByRole("alert")).toHaveText(refused);
        // The form refuses an address without @ by itself: it says so, and the
        // refusal of the earlier try is gone, not left beside it.
        await f.page
          .getByLabel("Email address", { exact: true })
          .fill("not-an-email");
        await f.page.getByLabel("Password", { exact: true }).fill("anything");
        await f.page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await expect(
          f.page.getByText("Enter the email address for your account."),
        ).toBeVisible();
        await expect(f.page.getByText(refused)).toHaveCount(0);
        await expect(f.page.getByRole("alert")).toHaveCount(0);
        expect(
          f.state.requests.filter((request) => request.path === "/login"),
        ).toHaveLength(1);
        // Past the password, the step names who is signing in.
        await f.credentials();
        await pending(f);
        await expect(f.page.locator(".signin-identity")).toContainText(
          credentials.email,
        );
        await expect(f.page.locator(".signin-identity > span")).toHaveText("S");
        for (const [width, theme] of [
          [1280, "light"],
          [390, "light"],
          [390, "dark"],
        ]) {
          await f.page.setViewportSize({ width, height: 844 });
          await f.page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
          }, theme);
          await f.page.screenshot({
            path: resolve(output, `auth-two-factor-${width}-${theme}.png`),
            animations: "disabled",
          });
        }
      } finally {
        await f.close();
      }
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Actual App staged sign-in with synthetic transport. Backend security verified separately; no real secrets or accounts.",
        results,
        accessibility,
        layouts,
        requests: requestSummaries,
        errors,
        unexpected,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Evidence: " + relative(repository, resolve(output, "report.json")),
  );
} finally {
  await browser.close();
  await server.close();
}
