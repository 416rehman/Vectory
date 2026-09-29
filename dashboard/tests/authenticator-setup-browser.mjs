// Actual App with synthetic MFA data and an isolated in-memory API.
// Screenshots contain only explicitly synthetic setup fixtures. No real
// credentials or traces; reports omit passwords, seeds, recovery codes and URLs.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
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
function setupValue(index) {
  const secret = seeds[index % seeds.length];
  const otpauth_url = `otpauth://totp/${encodeURIComponent("Vectory Synthetic & Test:" + user.email)}?secret=${secret}&issuer=${encodeURIComponent("Vectory Synthetic & Test")}&algorithm=SHA1&digits=6&period=30`;
  secrets.add(otpauth_url);
  return { secret, otpauth_url };
}
async function load({
  width = 1200,
  theme = "light",
  clipboard = "allow",
  setupFailure = false,
  setupConflict = false,
  confirmFailure = false,
  confirmExpired = false,
  invalidSetup = null,
} = {}) {
  if (page) await page.context().close();
  state = {
    enabled: false,
    issued: [],
    confirmations: [],
    setupFailure,
    setupConflict,
    confirmFailure,
    confirmExpired,
    invalidSetup,
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
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({ user, csrf_token: "synthetic-setup-csrf" });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic isolated fixture" });
      if (path === "/mfa") return reply({ enabled: current.enabled });
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
          "The current password is incorrect.",
          403,
        );
      if (current.setupConflict)
        return error(
          "CONFLICT",
          "MFA changed while this request was being checked. Review its current state and start again.",
          409,
        );
      const value = setupValue(current.issued.length);
      if (current.invalidSetup) value.otpauth_url = current.invalidSetup;
      current.issued.push(value);
      return reply(value);
    }
    if (method === "POST" && path === "/mfa/confirm") {
      expect(Object.keys(body)).toEqual(["code"]);
      current.confirmations.push(body.code);
      if (current.holdConfirm)
        await new Promise((resolve) => current.held.push(resolve));
      if (current.confirmExpired)
        return error(
          "MFA_SETUP_EXPIRED",
          "Authenticator setup expired. Start again.",
          409,
        );
      if (current.confirmFailure || body.code !== "654321")
        return error(
          "INVALID_MFA_CODE",
          "The authenticator code is incorrect or already used.",
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
  await page.goto(`${origin}/__authenticator-setup#/users`);
  await expect(
    page.getByRole("heading", { name: "People & security", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toBeEnabled();
}
async function check(name, run, focused = false) {
  if (Boolean(focus) !== focused) return;
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
async function beginSetup() {
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await page
    .getByLabel("Current password", { exact: true })
    .fill(syntheticPassword);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("dialog", {
      name: "Connect your authenticator",
      exact: true,
    }),
  ).toBeVisible();
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
const setupDialog = () =>
  page.getByRole("dialog", { name: "Connect your authenticator", exact: true });
const qrImage = () =>
  page.getByRole("img", { name: "Authenticator setup QR code", exact: true });
const enable = () =>
  page.getByRole("button", {
    name: /^(Loading )?Enable two-factor authentication$/,
  });
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
  const details = setupDialog().locator("details.authenticator-manual");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
  const key = setupDialog().getByLabel("Setup key", { exact: true });
  await expect(key).toHaveAttribute("readonly", "");
  expect(
    (await key.inputValue()) === state.issued.at(-1).secret,
    "manual key matches synthetic setup seed",
  ).toBe(true);
  return key;
}
async function closeDialog() {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
    "password gate retries without exposing setup; rendered QR decodes exactly and manual copy stays local",
    async () => {
      await load({ setupFailure: true });
      await page
        .getByRole("button", { name: "Set up authenticator", exact: true })
        .click();
      await expect(qrImage()).toHaveCount(0);
      await page
        .getByLabel("Current password", { exact: true })
        .fill(syntheticPassword);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText(
        "The current password is incorrect",
      );
      expect(state.issued).toHaveLength(0);
      await expect(qrImage()).toHaveCount(0);
      state.setupFailure = false;
      await expect(
        page.getByLabel("Current password", { exact: true }),
      ).toHaveValue("");
      await page
        .getByLabel("Current password", { exact: true })
        .fill(syntheticPassword);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(setupDialog()).toBeVisible();
      await decodeRenderedQR();
      await page.screenshot({
        path: resolve(output, "authenticator-setup-desktop-synthetic.png"),
        animations: "disabled",
      });
      await manualKey();
      await setupDialog()
        .getByRole("button", { name: "Copy setup key", exact: true })
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
    "hiding setup retains its QR in this tab, while deliberate navigation discards it",
    async () => {
      await load();
      await beginSetup();
      await manualKey();
      await page
        .getByLabel("Authenticator code", { exact: true })
        .fill("123456");
      await closeDialog();
      await noVisibleSecrets();
      expect(state.enabled).toBe(false);
      await page
        .getByRole("button", {
          name: "Continue authenticator setup",
          exact: true,
        })
        .click();
      await decodeRenderedQR();
      expect(state.issued).toHaveLength(1);
      await expect(
        page.getByLabel("Authenticator code", { exact: true }),
      ).toHaveValue("123456");
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
    "six ASCII digits and spaced paste support error retry on the same setup, then hand off to one-time recovery display",
    async () => {
      await load();
      await beginSetup();
      const code = page.getByLabel("Authenticator code", { exact: true });
      for (const invalid of ["12345", "abcdef", "１２３４５６"]) {
        await code.fill(invalid);
        await expect(enable()).toBeDisabled();
      }
      await code.evaluate((input) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text", "123 456");
        input.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      });
      await expect(code).toHaveValue("123456");
      await expect(enable()).toBeEnabled();
      await enable().click();
      await expect(setupDialog()).toContainText("incorrect or already used");
      await expect(
        setupDialog().getByRole("button", { name: "Start a new setup" }),
      ).toBeVisible();
      expect(state.issued).toHaveLength(1);
      expect(
        state.confirmations.length === 1 && state.confirmations[0] === "123456",
        "confirmation sends only the six-digit code",
      ).toBe(true);
      await decodeRenderedQR();
      await code.fill("654321");
      await enable().click();
      const recovery = page.getByRole("dialog", {
        name: "Save your recovery codes",
        exact: true,
      });
      await expect(recovery).toBeVisible();
      await expect(qrImage()).toHaveCount(0);
      const displayed = await recovery.locator("pre").innerText();
      expect(
        recoveryCodes.every((value) => displayed.includes(value)),
        "all eight synthetic recovery codes are handed off",
      ).toBe(true);
      expect(state.enabled).toBe(true);
      await recovery.getByRole("button", { name: "Hide for now" }).click();
      await expect(recovery).toHaveCount(0);
      await noVisibleSecrets();
      await page
        .getByRole("button", { name: "Show recovery codes", exact: true })
        .click();
      await expect(recovery).toBeVisible();
      const reopened = await recovery.locator("pre").innerText();
      expect(
        recoveryCodes.every((value) => reopened.includes(value)),
        "the original eight codes remain in memory for deliberate reopening",
      ).toBe(true);
      await recovery
        .getByRole("button", { name: /saved my recovery codes/i })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Disable authenticator",
          exact: true,
        }),
      ).toBeVisible();
      await noVisibleSecrets();
    },
  );
  await check(
    "expired confirmation uses current-status review before a new password-gated setup",
    async () => {
      await load({ confirmExpired: true });
      await beginSetup();
      await page
        .getByLabel("Authenticator code", { exact: true })
        .fill("654321");
      await enable().click();
      const review = page.getByRole("dialog", {
        name: "Authenticator change not confirmed",
        exact: true,
      });
      await expect(review).toBeVisible();
      await expect(qrImage()).toHaveCount(0);
      await review
        .getByRole("button", { name: "Check current status", exact: true })
        .click();
      await expect(review).toContainText("not enabled now");
      await review
        .getByRole("button", { name: "Review a new setup", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Verify your password", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Current password", { exact: true }),
      ).toHaveValue("");
      await noVisibleSecrets();
      state.confirmExpired = false;
      await page
        .getByLabel("Current password", { exact: true })
        .fill(syntheticPassword);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await decodeRenderedQR();
      expect(state.issued).toHaveLength(2);
    },
  );
  await check(
    "a competing setup conflict requires current-status review before another password-gated setup",
    async () => {
      await load({ setupConflict: true });
      await page
        .getByRole("button", { name: "Set up authenticator", exact: true })
        .click();
      await page
        .getByLabel("Current password", { exact: true })
        .fill(syntheticPassword);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const review = page.getByRole("dialog", {
        name: "Authenticator change not confirmed",
        exact: true,
      });
      await expect(review).toBeVisible();
      await expect(qrImage()).toHaveCount(0);
      expect(state.setupRequestCount).toBe(1);
      expect(state.issued).toHaveLength(0);
      await review
        .getByRole("button", { name: "Check current status", exact: true })
        .click();
      await expect(review).toContainText(
        "does not reveal whether a setup key is pending",
      );
      await review
        .getByRole("button", { name: "Review a new setup", exact: true })
        .click();
      await expect(
        page.getByLabel("Current password", { exact: true }),
      ).toHaveValue("");
      state.setupConflict = false;
      await page
        .getByLabel("Current password", { exact: true })
        .fill(syntheticPassword);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(setupDialog()).toBeVisible();
      expect(state.setupRequestCount).toBe(2);
      expect(state.issued).toHaveLength(1);
      await noPersistedSecrets();
    },
  );
  await check(
    "stopping a pending setup or confirmation retains an honest review without secret replay",
    async () => {
      await load();
      state.holdSetup = true;
      await page
        .getByRole("button", { name: "Set up authenticator", exact: true })
        .click();
      await page
        .getByLabel("Current password", { exact: true })
        .fill(syntheticPassword);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect.poll(() => state.held.length).toBe(1);
      const waiting = page.getByRole("dialog", {
        name: "Waiting for the server",
        exact: true,
      });
      await expect(waiting).toBeVisible();
      await waiting
        .getByRole("button", { name: "Stop waiting", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      state.held.shift()();
      await expect(
        page.getByText("Authenticator change not confirmed.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(qrImage()).toHaveCount(0);
      await page
        .getByRole("button", { name: "Review authenticator change" })
        .click();
      const review = page.getByRole("dialog", {
        name: "Authenticator change not confirmed",
        exact: true,
      });
      await review
        .getByRole("button", { name: "Check current status", exact: true })
        .click();
      await expect(review).toContainText("not enabled now");
      await review
        .getByRole("button", { name: "Review a new setup", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Verify your password", exact: true }),
      ).toBeVisible();
      state.holdSetup = false;
      await page
        .getByLabel("Current password", { exact: true })
        .fill(syntheticPassword);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(setupDialog()).toBeVisible();
      state.holdConfirm = true;
      await page
        .getByLabel("Authenticator code", { exact: true })
        .fill("654321");
      await enable().click();
      await expect.poll(() => state.held.length).toBe(1);
      await waiting
        .getByRole("button", { name: "Stop waiting", exact: true })
        .click();
      state.held.shift()();
      await expect(qrImage()).toHaveCount(0);
      await expect(
        page.getByRole("dialog", { name: "Save your recovery codes" }),
      ).toHaveCount(0);
      await expect.poll(() => state.enabled).toBe(true);
      await page
        .getByRole("button", { name: "Review authenticator change" })
        .click();
      await review
        .getByRole("button", { name: "Check current status", exact: true })
        .click();
      await expect(review).toContainText(
        "Recovery codes from an unread response cannot be recovered",
      );
      expect(state.confirmations).toEqual(["654321"]);
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
        .getByRole("button", { name: "Copy setup key", exact: true })
        .click();
      await expect(key).toBeVisible();
      expect(
        await page.evaluate(() => window.__syntheticClipboard.length),
      ).toBe(0);
      await expect(setupDialog()).not.toContainText("Setup key copied");
      for (const url of [
        "https://untrusted.invalid/qr",
        "otpauth://hotp/Untrusted?secret=JBSWY3DPEHPK3PXP&counter=0",
      ]) {
        await load({ invalidSetup: url });
        await page
          .getByRole("button", { name: "Set up authenticator", exact: true })
          .click();
        await page
          .getByLabel("Current password", { exact: true })
          .fill(syntheticPassword);
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        const review = page.getByRole("dialog", {
          name: "Authenticator change not confirmed",
          exact: true,
        });
        await expect(review).toBeVisible();
        await expect(qrImage()).toHaveCount(0);
        await expect(
          page.getByRole("link", {
            name: "Open authenticator app",
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(enable()).toHaveCount(0);
        await review
          .getByRole("button", { name: "Check current status", exact: true })
          .click();
        await expect(review).toContainText("not enabled now");
        await closeDialog();
        await noVisibleSecrets();
      }
    },
  );
  await check(
    "mobile light/dark setup and manual controls have contained layout, accessible focus and independently decodable QR pixels",
    async () => {
      for (const theme of ["light", "dark"]) {
        await load({ width: 375, theme });
        await beginSetup();
        await decodeRenderedQR();
        await footerGeometry(theme);
        await axe(`375px ${theme} scan step`);
        await page.screenshot({
          path: resolve(
            output,
            `authenticator-setup-mobile-${theme}-synthetic.png`,
          ),
          animations: "disabled",
        });
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
        await axe(`375px ${theme} manual step`);
        await page.screenshot({
          path: resolve(
            output,
            `authenticator-manual-mobile-${theme}-synthetic.png`,
          ),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await noVisibleSecrets();
      }
    },
  );
  await check(
    "375px light/dark footer keeps both actions on one contained row after the CSS correction",
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
        await manualKey();
        await footerGeometry(theme);
        await page.screenshot({
          path: resolve(
            output,
            `authenticator-manual-mobile-${theme}-synthetic.png`,
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
    "src/App.tsx",
    "src/ui.tsx",
    "src/control.css",
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
          ? "Focused CSS follow-up: 375px light/dark scan and manual footer containment on actual App with synthetic setup fixtures. No behavioral-suite rerun, real MFA setup or server verification. Screenshots contain synthetic credentials only."
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
