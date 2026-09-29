// Actual People & security controls, disposable synthetic API only. No live accounts.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(repository, ".local/mfa-recovery-browser");
await mkdir(output, { recursive: true });
// An OS-assigned port: harnesses never claim a fixed port another worker may use.
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:mfa-recovery-review";
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {},
    hmr: false,
  },
  plugins: [
    {
      name: "mfa-recovery-review",
      resolveId(id) {
        if (id === "virtual:mfa-recovery-review") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import{UsersSecurity}from'/src/UsersSecurity.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';setCSRF('synthetic-csrf');window.notices=[];window.sessionEnded=0;addEventListener('vectory:session-ended',()=>window.sessionEnded++);createRoot(document.getElementById('root')).render(React.createElement(UsersSecurity,{user:{id:'22222222-2222-4222-8222-222222222222',email:'synthetic@example.test',name:'Synthetic recovery review',role:'viewer',enabled:true,revision:1},notify:message=>window.notices.push(message),onUserChanged:()=>{},onSignIn:()=>{},onReload:()=>{}}));`;
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__mfa-recovery-review") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic MFA recovery review</title></head><body><main id="root"></main><script type="module">import "virtual:mfa-recovery-review";</script></body></html>',
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
const syntheticPassword = "synthetic-current-password";
const unused = "11111111-22222222-33333333-44444444";
const used = "aaaaaaaa-bbbbbbbb-cccccccc-dddddddd";
const seed = "JBSWY3DPEHPK3PXP";
const recoveryCodes = Array.from(
  { length: 8 },
  (_, i) =>
    `${String(i).repeat(8)}-${String(i).repeat(8)}-${String(i).repeat(8)}-${String(i).repeat(8)}`,
);
const privateValues = [syntheticPassword, unused, used, seed, ...recoveryCodes];
const redact = (text) =>
  privateValues.reduce(
    (out, value) => out.replaceAll(value, "[synthetic credential]"),
    String(text),
  );
const results = [],
  accessibility = [],
  errors = [],
  unexpected = [],
  contexts = [];
let failure, page, state;
const button = (name) => page.getByRole("button", { name, exact: true });
const dialog = () =>
  page.getByRole("dialog", {
    name: "Turn off two-factor authentication",
    exact: true,
  });
const turnOff = () =>
  dialog().getByRole("button", { name: "Turn off two-factor", exact: true });
async function load(width = 899) {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
  });
  contexts.push(context);
  page = await context.newPage();
  state = {
    enabled: true,
    remaining: 7,
    requests: [],
    statusReads: 0,
    hold: false,
    release: null,
  };
  page.on("pageerror", (error) => errors.push(redact(error.message)));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(`${request.method()} foreign request`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = request.method();
    const reply = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    const reject = (code, message, status = 403) =>
      reply({ error: { code, message } }, status);
    if (path === "/mfa" && method === "GET") {
      state.statusReads++;
      return reply({
        enabled: state.enabled,
        recovery_codes_remaining: state.enabled ? state.remaining : null,
      });
    }
    if (path === "/account/sessions" && method === "GET")
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
    if (path === "/status" && method === "GET")
      return reply({
        initialized: true,
        version: "synthetic",
        instance_name: "Synthetic recovery fixture",
      });
    if (method !== "POST") {
      unexpected.push(`${method} ${path}`);
      return reply({}, 404);
    }
    const body = request.postDataJSON();
    state.requests.push({ path, body });
    if (request.headers()["x-csrf-token"] !== "synthetic-csrf")
      throw Error("CSRF header missing");
    if (state.hold)
      await new Promise((resolve) => {
        state.release = () => {
          state.hold = false;
          state.release = null;
          resolve();
        };
      });
    const factorOk = body.recovery_code === unused || body.code === "123456";
    if (path === "/mfa/disable" || path === "/mfa/recovery-codes") {
      if (body.password !== syntheticPassword)
        return reject("WRONG_PASSWORD", "Your current password didn't match.");
      if (!state.enabled)
        return reject(
          "MFA_NOT_ENABLED",
          "Two-factor authentication is off for this account.",
          409,
        );
      if (!factorOk)
        return reject(
          "INVALID_MFA_CODE",
          "That code didn't match. Enter a current authenticator code or an unused recovery code.",
        );
      if (path === "/mfa/disable") {
        state.enabled = false;
        return reply({ enabled: false });
      }
      state.remaining = 8;
      return reply({ enabled: true, recovery_codes: recoveryCodes });
    }
    if (path === "/mfa/setup") {
      if (body.password !== syntheticPassword)
        return reject("WRONG_PASSWORD", "Your current password didn't match.");
      return reply({
        secret: seed,
        otpauth_url: `otpauth://totp/Vectory:synthetic@example.test?secret=${seed}&issuer=Vectory&algorithm=SHA1&digits=6&period=30`,
        expires_at: new Date(Date.now() + 600000).toISOString(),
      });
    }
    if (path === "/mfa/confirm" && body.code === "654321") {
      state.enabled = true;
      state.remaining = 8;
      return reply({ enabled: true, recovery_codes: recoveryCodes });
    }
    unexpected.push(`${method} ${path}`);
    return reply({}, 404);
  });
  await page.goto(origin + "/__mfa-recovery-review");
  await expect(page.getByText("7 of 8 recovery codes left")).toBeVisible();
  await expect(button("Turn off")).toBeEnabled();
}
async function openTurnOff() {
  await button("Turn off").click();
  await expect(dialog()).toBeVisible();
}
async function recoveryMode(container = dialog()) {
  await container
    .getByRole("button", { name: "Use a recovery code instead", exact: true })
    .click();
  const input = container.getByLabel("Recovery code", { exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("maxlength", "80");
  return input;
}
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
  console.log("PASS " + name);
}
try {
  await check(
    "lost authenticator: invalid and reused recovery codes keep the session; an unused code turns it off and a fresh setup follows",
    async () => {
      await load();
      await openTurnOff();
      const password = dialog().getByLabel("Password", { exact: true });
      await password.fill(syntheticPassword);
      const input = await recoveryMode();
      for (const code of ["invalid-synthetic-code", used]) {
        await input.fill(code);
        await turnOff().click();
        await expect(dialog()).toContainText("That recovery code didn't work.");
        await expect(input).toHaveAttribute("aria-invalid", "true");
        await expect(input).toHaveValue("");
        await expect(password).toHaveValue("");
        expect(state.enabled).toBe(true);
        expect(await page.evaluate(() => window.sessionEnded)).toBe(0);
        expect(Object.keys(state.requests.at(-1).body).sort()).toEqual([
          "password",
          "recovery_code",
        ]);
        await password.fill(syntheticPassword);
      }
      await input.fill(unused);
      await turnOff().click();
      await expect(dialog()).toHaveCount(0);
      await expect(button("Set up")).toBeEnabled();
      expect(state.requests.at(-1).body.recovery_code === unused).toBe(true);
      expect(await page.evaluate(() => window.notices.at(-1))).toBe(
        "Two-factor authentication is off. Other browsers were signed out.",
      );
      await button("Set up").click();
      const passwordDialog = page.getByRole("dialog", {
        name: "Set up two-factor authentication",
        exact: true,
      });
      await expect(
        passwordDialog.getByLabel("Password", { exact: true }),
      ).toHaveValue("");
      await passwordDialog
        .getByLabel("Password", { exact: true })
        .fill(syntheticPassword);
      await passwordDialog
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      const setup = page.getByRole("dialog", {
        name: "Connect your authenticator app",
        exact: true,
      });
      await expect(
        setup.getByRole("img", {
          name: "Authenticator setup QR code",
          exact: true,
        }),
      ).toBeVisible();
      expect(Object.keys(state.requests.at(-1).body)).toEqual(["password"]);
      await setup
        .getByLabel("6-digit code from your app", { exact: true })
        .fill("654321");
      const codes = page.getByRole("dialog", {
        name: "Save your recovery codes",
        exact: true,
      });
      await expect(codes).toBeVisible();
      await codes
        .getByRole("button", { name: "I've saved these codes", exact: true })
        .click();
      await expect(button("Turn off")).toBeEnabled();
      expect(await page.evaluate(() => window.sessionEnded)).toBe(0);
      expect(state.requests.map((request) => request.path)).toEqual([
        "/mfa/disable",
        "/mfa/disable",
        "/mfa/disable",
        "/mfa/setup",
        "/mfa/confirm",
      ]);
    },
  );
  await check(
    "factor switching and dismissal clear typed factors; a wrong password stays next to its field",
    async () => {
      await load();
      await openTurnOff();
      await dialog()
        .getByLabel("Code from your authenticator app", { exact: true })
        .fill("123456");
      expect(state.requests).toHaveLength(0);
      const input = await recoveryMode();
      await expect(input).toHaveValue("");
      await input.fill(unused);
      await dialog()
        .getByRole("button", {
          name: "Use your authenticator app instead",
          exact: true,
        })
        .click();
      await expect(
        dialog().getByLabel("Code from your authenticator app", {
          exact: true,
        }),
      ).toHaveValue("");
      await page.keyboard.press("Escape");
      await expect(dialog()).toHaveCount(0);
      await openTurnOff();
      await expect(
        dialog().getByLabel("Password", { exact: true }),
      ).toHaveValue("");
      await expect(
        dialog().getByLabel("Code from your authenticator app", {
          exact: true,
        }),
      ).toHaveValue("");
      await dialog()
        .getByLabel("Password", { exact: true })
        .fill("wrong-synthetic-password");
      const recovery = await recoveryMode();
      await recovery.fill(unused);
      await turnOff().click();
      await expect(dialog()).toContainText("Your password didn't match.");
      await expect(
        dialog().getByLabel("Password", { exact: true }),
      ).toBeFocused();
      expect(await page.evaluate(() => window.sessionEnded)).toBe(0);
      expect(state.enabled).toBe(true);
      expect(state.requests).toHaveLength(1);
    },
  );
  await check(
    "stopping an in-flight request reads the current state; a new request is deliberate and a finished one is reported plainly",
    async () => {
      await load();
      await openTurnOff();
      await dialog()
        .getByLabel("Password", { exact: true })
        .fill(syntheticPassword);
      const recovery = await recoveryMode();
      await recovery.fill(unused);
      state.hold = true;
      await turnOff().click();
      await expect.poll(() => !!state.release).toBe(true);
      await expect(recovery).toBeDisabled();
      await expect(
        dialog().getByRole("button", {
          name: "Use your authenticator app instead",
          exact: true,
        }),
      ).toBeDisabled();
      const reads = state.statusReads;
      await dialog()
        .getByRole("button", { name: "Stop waiting", exact: true })
        .click();
      const stillOn = page.getByRole("dialog", {
        name: "Two-factor is still on",
        exact: true,
      });
      await expect(stillOn).toBeVisible();
      expect(state.statusReads).toBeGreaterThan(reads);
      expect(state.requests).toHaveLength(1);
      state.release();
      await expect.poll(() => state.enabled).toBe(false);
      await stillOn
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(dialog()).toBeVisible();
      await expect(
        dialog().getByLabel("Password", { exact: true }),
      ).toHaveValue("");
      await dialog()
        .getByLabel("Password", { exact: true })
        .fill(syntheticPassword);
      const again = await recoveryMode();
      await again.fill(unused);
      await turnOff().click();
      await expect(dialog()).toHaveCount(0);
      await expect(button("Set up")).toBeEnabled();
      expect(await page.evaluate(() => window.notices.at(-1))).toBe(
        "Two-factor authentication is already off.",
      );
      expect(state.requests.map((request) => request.path)).toEqual([
        "/mfa/disable",
        "/mfa/disable",
      ]);
      for (const request of state.requests)
        expect(Object.keys(request.body).sort()).toEqual([
          "password",
          "recovery_code",
        ]);
    },
  );
  await check(
    "new recovery codes need the password and a current factor, replace the count, and an unconfirmed result says the old codes may be gone",
    async () => {
      await load();
      await button("New recovery codes").click();
      const form = page.getByRole("dialog", {
        name: "Generate new recovery codes",
        exact: true,
      });
      await expect(form).toBeVisible();
      await form
        .getByLabel("Password", { exact: true })
        .fill(syntheticPassword);
      await form
        .getByLabel("Code from your authenticator app", { exact: true })
        .fill("123456");
      const codes = page.getByRole("dialog", {
        name: "Save your recovery codes",
        exact: true,
      });
      await expect(codes).toBeVisible();
      await expect(codes).toContainText("Synthetic recovery fixture");
      expect(Object.keys(state.requests.at(-1).body).sort()).toEqual([
        "code",
        "password",
      ]);
      await codes
        .getByRole("button", { name: "I've saved these codes", exact: true })
        .click();
      await expect(page.getByText("8 of 8 recovery codes left")).toBeVisible();
      expect(await page.evaluate(() => window.notices.at(-1))).toBe(
        "New recovery codes are ready. Your old codes no longer work.",
      );
      state.hold = true;
      await button("New recovery codes").click();
      await form
        .getByLabel("Password", { exact: true })
        .fill(syntheticPassword);
      const recovery = await recoveryMode(form);
      await recovery.fill(unused);
      await form
        .getByRole("button", { name: "Generate new codes", exact: true })
        .click();
      await expect.poll(() => !!state.release).toBe(true);
      await form
        .getByRole("button", { name: "Stop waiting", exact: true })
        .click();
      const unknown = page.getByRole("dialog", {
        name: "Two-factor is on",
        exact: true,
      });
      await expect(unknown).toBeVisible();
      await expect(unknown).toContainText("your old ones may no longer work");
      state.release();
      await unknown
        .getByRole("button", { name: "Not now", exact: true })
        .click();
      await expect(
        page.getByText("Your recovery codes weren't shown. Generate new ones."),
      ).toBeVisible();
      const html = await page.content();
      expect(recoveryCodes.some((code) => html.includes(code))).toBe(false);
      expect(
        state.requests.filter(
          (request) => request.path === "/mfa/recovery-codes",
        ),
      ).toHaveLength(2);
    },
  );
  await check(
    "recovery controls fit mobile and keyboard navigation remains accessible in both themes",
    async () => {
      for (const theme of ["light", "dark"]) {
        await load(375);
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        await openTurnOff();
        await recoveryMode();
        // Safe visual evidence: no current password, recovery code or setup key.
        await expect(
          dialog().getByLabel("Password", { exact: true }),
        ).toHaveValue("");
        await expect(
          dialog().getByLabel("Recovery code", { exact: true }),
        ).toHaveValue("");
        await page.screenshot({
          path: resolve(output, `mfa-turn-off-375-${theme}-synthetic.png`),
          animations: "disabled",
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(375);
        const audit = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        accessibility.push({
          theme,
          violations: audit.violations.map((issue) => ({
            id: issue.id,
            impact: issue.impact,
          })),
        });
        expect(audit.violations).toEqual([]);
        expect(state.requests.length).toBe(0);
      }
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
} catch (error) {
  failure = redact(error.message);
  console.error(failure);
  process.exitCode = 1;
} finally {
  const source_sha256 = {};
  for (const file of [
    "dashboard/src/UsersSecurity.tsx",
    "dashboard/src/MfaActions.tsx",
    "dashboard/src/AuthenticatorSetup.tsx",
    "dashboard/src/api.ts",
    "dashboard/tests/mfa-recovery-browser.mjs",
  ])
    source_sha256[file] = createHash("sha256")
      .update(await readFile(resolve(repository, file)))
      .digest("hex");
  const report = {
    recorded_at: new Date().toISOString(),
    scope:
      "Actual UsersSecurity and authenticator setup React controls against a disposable synthetic API. Starts from an MFA-enabled signed-in account; it does not repeat real login or server factor verification. No live instance, credentials or accounts. Screenshots show blank forms only. Credential values and request bodies are omitted.",
    passed: !failure,
    results,
    accessibility,
    errors,
    unexpected,
    source_sha256,
    ...(failure ? { failure } : {}),
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await vite.close();
  console.log("Evidence: .local/mfa-recovery-browser/report.json");
}
