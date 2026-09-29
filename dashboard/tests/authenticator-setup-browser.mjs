// Actual App with synthetic MFA data and an isolated in-memory API.
// Screenshots contain only explicitly synthetic setup fixtures. No real
// credentials or traces; reports omit passwords, seeds, recovery codes and URLs.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";
import jsQR from "jsqr";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const focus = process.env.VECTORY_AUTHENTICATOR_SETUP_FOCUS || "";
if (focus && focus !== "mobile-footer") throw new Error("Unknown test focus");
const output = resolve(
  repository,
  process.env.VECTORY_AUTHENTICATOR_SETUP_OUTPUT ||
    (focus
      ? ".local/authenticator-mobile-footer"
      : ".local/authenticator-setup"),
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const virtual = "\0virtual:authenticator-setup-fixture";
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "authenticator-setup-fixture",
      resolveId(id) {
        if (id === "virtual:authenticator-setup-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__authenticator-setup") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic authenticator verification</title></head><body><div id="root"></div><script type="module">import "virtual:authenticator-setup-fixture";</script></body></html>',
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
const results = [],
  accessibility = [],
  requests = [],
  unexpected = [],
  errors = [],
  qrChecks = [],
  footerChecks = [];
const syntheticPassword = "synthetic-password-only";
const seeds = ["JBSWY3DPEHPK3PXP", "KRSXG5DSNFXGOIDB"];
const recoveryCodes = Array.from(
  { length: 8 },
  (_, i) => `${String(i + 1).padStart(8, "0")}-00000000-00000000-00000000`,
);
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Synthetic MFA user",
  email: "synthetic+qr@example.test",
  role: "viewer",
  enabled: true,
  revision: 1,
};
let page, state, failure;
const secrets = new Set([syntheticPassword, ...seeds, ...recoveryCodes]);
function safe(message) {
  let text = String(message);
  for (const secret of secrets)
    text = text.replaceAll(secret, "[synthetic credential redacted]");
  return text;
}
function setupValue(index, lifetime) {
  const secret = seeds[index % seeds.length];
  const otpauth_url = `otpauth://totp/${encodeURIComponent("Vectory Synthetic & Test:" + user.email)}?secret=${secret}&issuer=${encodeURIComponent("Vectory Synthetic & Test")}&algorithm=SHA1&digits=6&period=30`;
  secrets.add(otpauth_url);
  return {
    secret,
    otpauth_url,
    expires_at: new Date(Date.now() + lifetime).toISOString(),
  };
}
async function load({
  width = 1200,
  theme = "light",
  clipboard = "allow",
  setupFailure = false,
  setupConflict = false,
  confirmExpired = false,
  invalidSetup = null,
  lifetime = 600000,
} = {}) {
  if (page) await page.context().close();
  state = {
    enabled: false,
    issued: [],
    confirmations: [],
    statusReads: 0,
    setupFailure,
    setupConflict,
    confirmExpired,
    invalidSetup,
    lifetime,
    holdSetup: false,
    holdConfirm: false,
    held: [],
    setupRequestCount: 0,
  };
  const current = state;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ({ theme, clipboard }) => {
      localStorage.setItem("vectory-theme", theme);
      window.__syntheticClipboard = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => {
            if (clipboard === "deny")
              throw new DOMException(
                "Synthetic clipboard denial",
                "NotAllowedError",
              );
            window.__syntheticClipboard.push(value);
          },
        },
      });
    },
    { theme, clipboard },
  );
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
    const error = (code, message, status) =>
      reply({ error: { code, message } }, status);
    if (method === "GET") {
      if (path === "/status")
        return reply({
          initialized: true,
          version: "synthetic",
          instance_name: "Synthetic isolated fixture",
        });
      if (path === "/session")
        return reply({ user, csrf_token: "synthetic-setup-csrf" });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic isolated fixture" });
      if (path === "/mfa") {
        current.statusReads++;
        return reply({
          enabled: current.enabled,
          recovery_codes_remaining: current.enabled ? 8 : null,
        });
      }
      if (path === "/account/sessions")
        return reply({
          sessions: [
            {
              id: "0123456789abcdef0123456789abcdef",
              current: true,
              created_at: new Date().toISOString(),
              last_seen_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              user_agent: "Synthetic browser",
              client_address: "192.0.2.10",
            },
          ],
        });
      if (path === "/overview")
        return reply({
          devices_total: 0,
          devices_online: 0,
          configurations_total: 0,
          deployments_active: 0,
          issues_open: 0,
          devices: [],
          recent_activity: [],
        });
    }
    if (request.headers()["x-csrf-token"] !== "synthetic-setup-csrf") {
      unexpected.push(`Missing CSRF ${method} ${path}`);
      return error("FORBIDDEN", "Fixture CSRF missing", 403);
    }
    if (method === "POST" && path === "/mfa/setup") {
      current.setupRequestCount++;
      expect(Object.keys(body)).toEqual(["password"]);
      if (current.holdSetup)
        await new Promise((resolve) => current.held.push(resolve));
      if (current.setupFailure || body.password !== syntheticPassword)
        return error(
          "WRONG_PASSWORD",
          "Your current password didn't match.",
          403,
        );
      if (current.setupConflict)
        return error(
          "MFA_CHANGED",
          "Your two-factor settings changed in another window. Check them and try again.",
          409,
        );
      const value = setupValue(current.issued.length, current.lifetime);
      if (current.invalidSetup) value.otpauth_url = current.invalidSetup;
      current.issued.push(value);
      return reply(value);
    }
    if (method === "POST" && path === "/mfa/confirm") {
      expect(Object.keys(body)).toEqual(["code"]);
      current.confirmations.push(body.code);
      if (current.holdConfirm)
        await new Promise((resolve) => current.held.push(resolve));
      if (current.enabled)
        return error(
          "MFA_ALREADY_ENABLED",
          "Two-factor authentication is already on for your account.",
          409,
        );
      if (current.confirmExpired)
        return error(
          "MFA_SETUP_EXPIRED",
          "This setup expired. Start a new one to get a fresh QR code.",
          409,
        );
      if (body.code !== "654321")
        return error(
          "INVALID_MFA_CODE",
          "That code didn't match. Enter the current 6-digit code from your authenticator app.",
          403,
        );
      current.enabled = true;
      return reply({ enabled: true, recovery_codes: recoveryCodes });
    }
    unexpected.push(`${method} ${path}`);
    return error(
      "UNEXPECTED_REQUEST",
      "Synthetic fixture refuses this request",
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(safe(error.message)));
  // A cold dev-server transform can exceed the action timeout on a busy host.
  await page.goto(`${origin}/__authenticator-setup#/users`, { timeout: 60000 });
  await expect(
    page.getByRole("heading", { name: "People & security", exact: true }),
  ).toBeVisible();
  await expect(setUp()).toHaveCount(1);
  await expect(setUp()).toBeEnabled();
}
async function check(name, run, focused = false) {
  if (Boolean(focus) !== focused) return;
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
const setUp = () => page.getByRole("button", { name: "Set up", exact: true });
const passwordDialog = () =>
  page.getByRole("dialog", {
    name: "Set up two-factor authentication",
    exact: true,
  });
const setupDialog = () =>
  page.getByRole("dialog", {
    name: "Connect your authenticator app",
    exact: true,
  });
const qrImage = () =>
  page.getByRole("img", { name: "Authenticator setup QR code", exact: true });
const enable = () =>
  setupDialog().getByRole("button", {
    name: /^(Loading )?Turn on two-factor$/,
  });
const codeField = () =>
  setupDialog().getByLabel("6-digit code from your app", { exact: true });
async function submitPassword(value = syntheticPassword) {
  await passwordDialog().getByLabel("Password", { exact: true }).fill(value);
  await passwordDialog()
    .getByRole("button", { name: "Continue", exact: true })
    .click();
}
async function beginSetup() {
  await setUp().click();
  await submitPassword();
  await expect(setupDialog()).toBeVisible();
}
async function pasteCode(text) {
  await codeField().evaluate((input, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text", text);
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, text);
}
async function noPersistedSecrets() {
  const values = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(
    [...secrets].some((secret) => values.includes(secret)),
    "credentials are not persisted in browser storage",
  ).toBe(false);
}
async function noVisibleSecrets() {
  const html = await page.content();
  expect(
    [...secrets].some((secret) => html.includes(secret)),
    "closed setup/recovery credentials are removed from DOM",
  ).toBe(false);
  await noPersistedSecrets();
}
async function axe(label) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({
    label,
    violations: result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  });
  expect(result.violations, label).toEqual([]);
}
async function decodeRenderedQR() {
  await expect(qrImage()).toBeVisible();
  const png = await qrImage().screenshot({ animations: "disabled" });
  const pixels = await page.evaluate(async (png) => {
    const image = new Image();
    const loaded = new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
    });
    image.src = "data:image/png;base64," + png;
    await loaded;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(
        context.getImageData(0, 0, canvas.width, canvas.height).data,
      ),
    };
  }, png.toString("base64"));
  const decoded = jsQR(
    new Uint8ClampedArray(pixels.data),
    pixels.width,
    pixels.height,
  );
  expect(
    !!decoded && decoded.data === state.issued.at(-1).otpauth_url,
    "independent decoder matches the exact synthetic setup URI",
  ).toBe(true);
  qrChecks.push({
    decoder: "jsqr@1.4.0",
    source: "https://github.com/cozmo/jsQR",
    width: pixels.width,
    height: pixels.height,
    qr_version: decoded.version,
    exact_synthetic_uri_match: true,
  });
}
async function manualKey() {
  const key = setupDialog().locator(".authenticator-key-row code");
  await expect(key).toBeVisible();
  const shown = await key.innerText();
  expect(
    shown.replace(/\s+/g, "") === state.issued.at(-1).secret,
    "the grouped manual key matches the synthetic setup seed",
  ).toBe(true);
  expect(shown).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/);
  return key;
}
async function footerGeometry(theme) {
  const geometry = await setupDialog()
    .locator(".modal-footer")
    .evaluate((footer) => {
      const bounds = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        viewport: innerWidth,
        document_width: document.documentElement.scrollWidth,
        footer: bounds(footer),
        buttons: Array.from(footer.querySelectorAll("button"), bounds),
      };
    });
  expect(geometry.buttons).toHaveLength(2);
  expect(
    Math.abs(geometry.buttons[0].y - geometry.buttons[1].y),
  ).toBeLessThanOrEqual(1);
  for (const button of geometry.buttons) {
    expect(button.x).toBeGreaterThanOrEqual(0);
    expect(button.x + button.width).toBeLessThanOrEqual(geometry.viewport);
    expect(button.y).toBeGreaterThanOrEqual(geometry.footer.y);
    expect(button.y + button.height).toBeLessThanOrEqual(
      geometry.footer.y + geometry.footer.height + 1,
    );
  }
  expect(geometry.document_width).toBeLessThanOrEqual(geometry.viewport);
  footerChecks.push({ theme, ...geometry });
}

try {
  await check(
    "a wrong password stays next to its field; the rendered QR decodes exactly and manual copy stays local",
    async () => {
      await load({ setupFailure: true });
      await setUp().click();
      await expect(qrImage()).toHaveCount(0);
      await submitPassword();
      await expect(passwordDialog()).toContainText(
        "Your password didn't match.",
      );
      const password = passwordDialog().getByLabel("Password", {
        exact: true,
      });
      await expect(password).toHaveAttribute("aria-invalid", "true");
      await expect(password).toHaveValue("");
      await expect(password).toBeFocused();
      expect(state.issued).toHaveLength(0);
      await expect(qrImage()).toHaveCount(0);
      state.setupFailure = false;
      await submitPassword();
      await expect(setupDialog()).toBeVisible();
      await decodeRenderedQR();
      await expect(setupDialog()).toContainText(
        /This QR code expires in (10:00|9:\d\d)/,
      );
      await page.screenshot({
        path: resolve(output, "authenticator-setup-desktop-synthetic.png"),
        animations: "disabled",
      });
      await manualKey();
      await setupDialog()
        .getByRole("button", { name: "Copy key", exact: true })
        .click();
      expect(
        await page.evaluate(
          (expected) => window.__syntheticClipboard.at(-1) === expected,
          state.issued.at(-1).secret,
        ),
        "copy writes the setup key only",
      ).toBe(true);
      expect(
        (await setupDialog()
          .getByRole("link", { name: "Open authenticator app", exact: true })
          .getAttribute("href")) === state.issued.at(-1).otpauth_url,
        "app link uses the exact validated local URI",
      ).toBe(true);
      expect(state.confirmations).toHaveLength(0);
      await noPersistedSecrets();
    },
  );
  await check(
    "hiding setup retains its QR and partial code in this tab, while deliberate navigation discards it",
    async () => {
      await load();
      await beginSetup();
      await manualKey();
      await codeField().fill("123");
      await setupDialog()
        .getByRole("button", { name: "Not now", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await noVisibleSecrets();
      expect(state.enabled).toBe(false);
      await expect(
        page.getByText(
          "Setup in progress. Enter a code from your app to finish.",
        ),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Continue setup", exact: true })
        .click();
      await decodeRenderedQR();
      expect(state.issued).toHaveLength(1);
      await expect(codeField()).toHaveValue("123");
      expect(state.confirmations).toHaveLength(0);
      let navigationPrompted = false;
      page.once("dialog", (dialog) => {
        navigationPrompted = true;
        void dialog.dismiss();
      });
      await page.evaluate(() => {
        location.hash = "#/overview";
      });
      await expect.poll(() => navigationPrompted).toBe(true);
      await expect.poll(() => new URL(page.url()).hash).toBe("#/users");
      await expect(setupDialog()).toBeVisible();
      page.once("dialog", (dialog) => void dialog.accept());
      await page.evaluate(() => {
        location.hash = "#/overview";
      });
      await expect(
        page.getByRole("heading", { name: "Overview", exact: true }),
      ).toBeVisible();
      await noVisibleSecrets();
    },
  );
  await check(
    "only six ASCII digits count; a pasted spaced code submits itself, a miss clears the field, and recovery codes follow",
    async () => {
      await load();
      await beginSetup();
      for (const invalid of ["12345", "abcdef", "１２３４５６"]) {
        await codeField().fill(invalid);
        await expect(enable()).toBeDisabled();
        expect(state.confirmations).toHaveLength(0);
      }
      await codeField().fill("");
      await pasteCode("123 456");
      await expect(setupDialog()).toContainText("That code didn't match.");
      await expect(setupDialog()).not.toContainText("recovery code");
      await expect(codeField()).toHaveValue("");
      await expect(codeField()).toBeFocused();
      await expect(
        setupDialog().getByRole("button", { name: "Start a new setup" }),
      ).toHaveCount(0);
      expect(state.confirmations).toEqual(["123456"]);
      expect(state.issued).toHaveLength(1);
      await decodeRenderedQR();
      await codeField().fill("111111");
      await expect.poll(() => state.confirmations.length).toBe(2);
      await expect(setupDialog()).toContainText(
        "Codes change every 30 seconds.",
      );
      await codeField().fill("222222");
      await expect.poll(() => state.confirmations.length).toBe(3);
      await expect(
        setupDialog().getByRole("button", { name: "Start a new setup" }),
      ).toBeVisible();
      await codeField().fill("654321");
      const recovery = page.getByRole("dialog", {
        name: "Save your recovery codes",
        exact: true,
      });
      await expect(recovery).toBeVisible();
      await expect(qrImage()).toHaveCount(0);
      const displayed = await recovery
        .getByRole("list", { name: "Recovery codes" })
        .innerText();
      expect(
        recoveryCodes.every((value) => displayed.includes(value)),
        "all eight synthetic recovery codes are handed off",
      ).toBe(true);
      await expect(recovery).toContainText(user.email);
      await expect(recovery).toContainText("Synthetic isolated fixture");
      await recovery.getByRole("button", { name: "Copy", exact: true }).click();
      const copied = await page.evaluate(() =>
        window.__syntheticClipboard.at(-1),
      );
      expect(copied.split("\n")[0]).toContain(
        `Vectory recovery codes for ${user.email} on Synthetic isolated fixture`,
      );
      expect(recoveryCodes.every((value) => copied.includes(value))).toBe(true);
      const download = page.waitForEvent("download");
      await recovery
        .getByRole("button", { name: "Download", exact: true })
        .click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(
        /^vectory-recovery-codes-127\.0\.0\.1-\d+-\d{4}-\d\d-\d\d\.txt$/,
      );
      expect(state.enabled).toBe(true);
      await recovery
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await expect(recovery).toHaveCount(0);
      await noVisibleSecrets();
      await page
        .getByRole("button", { name: "Show recovery codes", exact: true })
        .click();
      await expect(recovery).toBeVisible();
      const reopened = await recovery
        .getByRole("list", { name: "Recovery codes" })
        .innerText();
      expect(
        recoveryCodes.every((value) => reopened.includes(value)),
        "the original eight codes remain in memory for deliberate reopening",
      ).toBe(true);
      await recovery
        .getByRole("button", { name: "I've saved these codes", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Turn off", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("8 of 8 recovery codes left")).toBeVisible();
      await noVisibleSecrets();
    },
  );
  await check(
    "an expired setup shows its own state, from the server or the countdown, and restarts behind the password",
    async () => {
      await load({ confirmExpired: true });
      await beginSetup();
      await codeField().fill("654321");
      await expect(setupDialog()).toContainText("This QR code expired");
      await expect(qrImage()).toHaveCount(0);
      await setupDialog()
        .getByRole("button", { name: "Start a new setup", exact: true })
        .click();
      await expect(passwordDialog()).toBeVisible();
      await expect(
        passwordDialog().getByLabel("Password", { exact: true }),
      ).toHaveValue("");
      await noVisibleSecrets();
      state.confirmExpired = false;
      await submitPassword();
      await decodeRenderedQR();
      expect(state.issued).toHaveLength(2);
      await load({ lifetime: 2500 });
      await beginSetup();
      await decodeRenderedQR();
      await expect(setupDialog()).toContainText("This QR code expired", {
        timeout: 6000,
      });
      await expect(qrImage()).toHaveCount(0);
      expect(state.confirmations).toHaveLength(0);
    },
  );
  await check(
    "a concurrent two-factor change keeps the password form with a plain message; the retry is deliberate",
    async () => {
      await load({ setupConflict: true });
      await setUp().click();
      await submitPassword();
      await expect(passwordDialog().getByRole("alert")).toContainText(
        "changed in another window",
      );
      await expect(qrImage()).toHaveCount(0);
      expect(state.setupRequestCount).toBe(1);
      expect(state.issued).toHaveLength(0);
      await expect(
        passwordDialog().getByLabel("Password", { exact: true }),
      ).toHaveValue("");
      state.setupConflict = false;
      await submitPassword();
      await expect(setupDialog()).toBeVisible();
      expect(state.setupRequestCount).toBe(2);
      expect(state.issued).toHaveLength(1);
      await noPersistedSecrets();
    },
  );
  await check(
    "stopping a pending setup or confirmation reads the current state once and never resends a secret",
    async () => {
      await load();
      state.holdSetup = true;
      await setUp().click();
      await submitPassword();
      await expect.poll(() => state.held.length).toBe(1);
      const reads = state.statusReads;
      await passwordDialog()
        .getByRole("button", { name: "Stop waiting", exact: true })
        .click();
      const outcome = page.getByRole("dialog", {
        name: "Two-factor is still off",
        exact: true,
      });
      await expect(outcome).toBeVisible();
      await expect.poll(() => state.statusReads).toBeGreaterThan(reads);
      state.held.shift()();
      await expect(qrImage()).toHaveCount(0);
      expect(state.setupRequestCount).toBe(1);
      await outcome
        .getByRole("button", { name: "Start again", exact: true })
        .click();
      await expect(
        passwordDialog().getByLabel("Password", { exact: true }),
      ).toHaveValue("");
      state.holdSetup = false;
      await submitPassword();
      await expect(setupDialog()).toBeVisible();
      expect(state.setupRequestCount).toBe(2);
      state.holdConfirm = true;
      await codeField().fill("654321");
      await expect.poll(() => state.held.length).toBe(1);
      await setupDialog()
        .getByRole("button", { name: "Stop waiting", exact: true })
        .click();
      await expect(setupDialog()).toContainText(
        "We couldn't confirm that code. Enter the next code from your app.",
      );
      await expect(codeField()).toHaveValue("");
      expect(state.confirmations).toEqual(["654321"]);
      state.held.shift()();
      await expect.poll(() => state.enabled).toBe(true);
      state.holdConfirm = false;
      await codeField().fill("654321");
      const lost = page.getByRole("dialog", {
        name: "Two-factor is on",
        exact: true,
      });
      await expect(lost).toBeVisible();
      await expect(lost).toContainText("Generate new ones now");
      await expect(
        page.getByRole("dialog", { name: "Save your recovery codes" }),
      ).toHaveCount(0);
      expect(state.confirmations).toEqual(["654321", "654321"]);
      await lost.getByRole("button", { name: "Not now", exact: true }).click();
      await expect(
        page.getByText("Your recovery codes weren't shown. Generate new ones."),
      ).toBeVisible();
      await noVisibleSecrets();
    },
  );
  await check(
    "manual fallback survives clipboard denial and malformed setup responses expose no QR or app link",
    async () => {
      await load({ clipboard: "deny" });
      await beginSetup();
      const key = await manualKey();
      await setupDialog()
        .getByRole("button", { name: "Copy key", exact: true })
        .click();
      await expect(key).toBeVisible();
      expect(
        await page.evaluate(() => window.__syntheticClipboard.length),
      ).toBe(0);
      await expect(setupDialog()).toContainText(
        "Copy isn't available here. Select the text to copy it.",
      );
      for (const url of [
        "https://untrusted.invalid/qr",
        "otpauth://hotp/Untrusted?secret=JBSWY3DPEHPK3PXP&counter=0",
      ]) {
        await load({ invalidSetup: url });
        await setUp().click();
        await submitPassword();
        const outcome = page.getByRole("dialog", {
          name: "Two-factor is still off",
          exact: true,
        });
        await expect(outcome).toBeVisible();
        await expect(qrImage()).toHaveCount(0);
        await expect(
          page.getByRole("link", {
            name: "Open authenticator app",
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(enable()).toHaveCount(0);
        await outcome
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await noVisibleSecrets();
      }
    },
  );
  await check(
    "mobile light/dark setup puts the app link and key first, stays contained, and keeps QR pixels decodable",
    async () => {
      for (const theme of ["light", "dark"]) {
        await load({ width: 375, theme });
        await beginSetup();
        await decodeRenderedQR();
        const order = await setupDialog().evaluate((dialog) => {
          const top = (selector) =>
            dialog.querySelector(selector).getBoundingClientRect().top;
          return {
            manual: top(".authenticator-manual"),
            scan: top(".authenticator-scan"),
          };
        });
        expect(order.manual).toBeLessThan(order.scan);
        await footerGeometry(theme);
        await manualKey();
        const dimensions = await setupDialog().evaluate((dialog) => ({
          left: dialog.getBoundingClientRect().left,
          right: dialog.getBoundingClientRect().right,
          document_width: document.documentElement.scrollWidth,
          viewport: innerWidth,
        }));
        expect(dimensions.left).toBeGreaterThanOrEqual(0);
        expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
        expect(dimensions.document_width).toBeLessThanOrEqual(
          dimensions.viewport,
        );
        await axe(`375px ${theme} setup`);
        await page.screenshot({
          path: resolve(
            output,
            `authenticator-setup-mobile-${theme}-synthetic.png`,
          ),
          animations: "disabled",
          fullPage: true,
        });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await noVisibleSecrets();
      }
    },
  );
  await check(
    "375px light/dark footer keeps both actions on one contained row",
    async () => {
      for (const theme of ["light", "dark"]) {
        await load({ width: 375, theme });
        await beginSetup();
        await footerGeometry(theme);
        await page.screenshot({
          path: resolve(
            output,
            `authenticator-setup-mobile-${theme}-synthetic.png`,
          ),
          animations: "disabled",
        });
      }
    },
    true,
  );
  expect(results).toHaveLength(focus ? 1 : 8);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw new Error(safe(error.message));
} finally {
  const source_sha256 = {};
  for (const file of [
    "tests/authenticator-setup-browser.mjs",
    "src/UsersSecurity.tsx",
    "src/MfaActions.tsx",
    "src/mfaActionModel.ts",
    "src/AuthenticatorSetup.tsx",
    "src/authenticator-setup.css",
    "src/authControls.tsx",
    "src/App.tsx",
    "src/ui.tsx",
    "package.json",
    "package-lock.json",
  ])
    source_sha256[`dashboard/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, file)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope: focus
          ? "Focused CSS follow-up: 375px light/dark setup footer containment on actual App with synthetic setup fixtures. No behavioral-suite rerun, real MFA setup or server verification. Screenshots contain synthetic credentials only."
          : "Actual App MFA onboarding with synthetic credentials and isolated mocked API. No real MFA setup, server TOTP/recovery validation, native activation or traces. Reports omit QR payloads and credential values; screenshots contain only explicitly synthetic setup fixtures.",
        focus: focus || null,
        passed: !failure,
        results,
        accessibility,
        qrChecks,
        footerChecks,
        requests,
        unexpected,
        errors,
        source_sha256,
        ...(failure ? { failure: safe(failure.message) } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await vite.close();
  console.log(
    "Evidence: " + relative(repository, resolve(output, "report.json")),
  );
}
