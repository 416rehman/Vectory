// Actual People & security controls, disposable synthetic API only. No live accounts.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(repository, ".local/mfa-recovery-browser");
await mkdir(output, { recursive: true });
const virtual = "\0virtual:mfa-recovery-review";
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
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
          return `import React from 'react';import{createRoot}from'react-dom/client';import{UsersSecurity}from'/src/UsersSecurity.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';setCSRF('synthetic-csrf');window.notices=[];window.sessionEnded=0;addEventListener('vectory:session-ended',()=>window.sessionEnded++);createRoot(document.getElementById('root')).render(React.createElement(UsersSecurity,{user:{id:'22222222-2222-4222-8222-222222222222',email:'synthetic@example.test',name:'Synthetic recovery review',role:'viewer',enabled:true,revision:1},notify:message=>window.notices.push(message),onUserChanged:()=>{}}));`;
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
const recoveryCodes = Array.from({ length: 8 }, (_, i) => `${i}`.repeat(32));
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
    name: "Disable multi-factor authentication",
    exact: true,
  });
async function load(width = 899) {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
  });
  contexts.push(context);
  page = await context.newPage();
  state = { enabled: true, requests: [], hold: null, release: null };
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
    const reject = (code, message) => reply({ error: { code, message } }, 403);
    if (path === "/mfa" && method === "GET")
      return reply({ enabled: state.enabled });
    if (method !== "POST") {
      unexpected.push(`${method} ${path}`);
      return reply({}, 404);
    }
    const body = request.postDataJSON();
    state.requests.push({ path, body });
    if (request.headers()["x-csrf-token"] !== "synthetic-csrf")
      throw Error("CSRF header missing");
    if (state.hold) {
      state.release = () => {
        state.hold = null;
      };
      await new Promise((resolve) => {
        state.release = () => {
          state.hold = null;
          resolve();
        };
      });
    }
    if (path === "/mfa/disable") {
      if (body.password !== syntheticPassword)
        return reject("WRONG_PASSWORD", "Current password is incorrect");
      if (body.recovery_code !== unused && body.code !== "123456")
        return reject(
          "INVALID_MFA_CODE",
          "Authenticator or recovery code is invalid or already used",
        );
      state.enabled = false;
      return reply({ enabled: false });
    }
    if (path === "/mfa/setup") {
      if (body.password !== syntheticPassword)
        return reject("WRONG_PASSWORD", "Current password is incorrect");
      return reply({
        secret: seed,
        otpauth_url: `otpauth://totp/Vectory:synthetic@example.test?secret=${seed}&issuer=Vectory&algorithm=SHA1&digits=6&period=30`,
      });
    }
    if (path === "/mfa/confirm" && body.code === "654321") {
      state.enabled = true;
      return reply({ enabled: true, recovery_codes: recoveryCodes });
    }
    unexpected.push(`${method} ${path}`);
    return reply({}, 404);
  });
  await page.goto(origin + "/__mfa-recovery-review");
  await expect(button("Disable authenticator")).toBeEnabled();
  await button("Disable authenticator").click();
  await expect(dialog()).toBeVisible();
}
async function recoveryMode() {
  await dialog()
    .getByRole("button", { name: "Use a recovery code instead", exact: true })
    .click();
  const input = dialog().getByLabel("Recovery code", { exact: true });
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
    "lost authenticator: invalid and reused recovery codes retain the session; an unused code allows fresh authenticator enrollment",
    async () => {
      await load();
      await dialog()
        .getByLabel("Current password", { exact: true })
        .fill(syntheticPassword);
      const input = await recoveryMode();
      for (const code of ["invalid-synthetic-code", used]) {
        await input.fill(code);
        await dialog()
          .getByRole("button", { name: "Disable authenticator", exact: true })
          .click();
        await expect(dialog().getByRole("alert")).toContainText(
          "invalid or already used",
        );
        expect(state.enabled).toBe(true);
        expect(await page.evaluate(() => window.sessionEnded)).toBe(0);
        expect(Object.keys(state.requests.at(-1).body).sort()).toEqual([
          "password",
          "recovery_code",
        ]);
      }
      await input.fill(unused);
      await dialog()
        .getByRole("button", { name: "Disable authenticator", exact: true })
        .click();
      await expect(dialog()).toHaveCount(0);
      await expect(button("Set up authenticator")).toBeEnabled();
      expect(state.requests.at(-1).body.recovery_code === unused).toBe(true);
      await button("Set up authenticator").click();
      const passwordDialog = page.getByRole("dialog", {
        name: "Verify your password",
        exact: true,
      });
      await expect(
        passwordDialog.getByLabel("Current password", { exact: true }),
      ).toHaveValue("");
      await passwordDialog
        .getByLabel("Current password", { exact: true })
        .fill(syntheticPassword);
      await passwordDialog
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      const setup = page.getByRole("dialog", {
        name: "Connect your authenticator",
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
        .getByLabel("Authenticator code", { exact: true })
        .fill("654321");
      await setup
        .getByRole("button", {
          name: "Enable two-factor authentication",
          exact: true,
        })
        .click();
      const codes = page.getByRole("dialog", {
        name: "Save your recovery codes",
        exact: true,
      });
      await expect(codes).toBeVisible();
      await codes
        .getByRole("button", {
          name: "I’ve saved my recovery codes",
          exact: true,
        })
        .click();
      await expect(button("Disable authenticator")).toBeEnabled();
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
    "factor switching, dismissal, wrong password and an in-flight request preserve the intended factor boundary",
    async () => {
      await load();
      await dialog()
        .getByLabel("Current authenticator code", { exact: true })
        .fill("123456");
      const input = await recoveryMode();
      await expect(input).toHaveValue("");
      await input.fill(unused);
      await dialog()
        .getByRole("button", {
          name: "Use an authenticator code instead",
          exact: true,
        })
        .click();
      await expect(
        dialog().getByLabel("Current authenticator code", { exact: true }),
      ).toHaveValue("");
      await page.keyboard.press("Escape");
      await expect(dialog()).toHaveCount(0);
      await button("Disable authenticator").click();
      await expect(
        dialog().getByLabel("Current password", { exact: true }),
      ).toHaveValue("");
      await expect(
        dialog().getByLabel("Current authenticator code", { exact: true }),
      ).toHaveValue("");
      await dialog()
        .getByLabel("Current password", { exact: true })
        .fill("wrong-synthetic-password");
      const recovery = await recoveryMode();
      await recovery.fill(unused);
      await dialog()
        .getByRole("button", { name: "Disable authenticator", exact: true })
        .click();
      await expect(dialog().getByRole("alert")).toContainText(
        "Current password is incorrect",
      );
      expect(await page.evaluate(() => window.sessionEnded)).toBe(0);
      expect(state.enabled).toBe(true);
      await dialog()
        .getByLabel("Current password", { exact: true })
        .fill(syntheticPassword);
      state.hold = true;
      await dialog()
        .getByRole("button", { name: "Disable authenticator", exact: true })
        .click();
      await expect.poll(() => !!state.release).toBe(true);
      await expect(recovery).toBeDisabled();
      await expect(
        dialog().getByRole("button", {
          name: "Use an authenticator code instead",
          exact: true,
        }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog()).toBeVisible();
      state.release();
      await expect(dialog()).toHaveCount(0);
      expect(Object.keys(state.requests.at(-1).body).sort()).toEqual([
        "password",
        "recovery_code",
      ]);
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
        await recoveryMode();
        if (theme === "light") {
          // Safe visual evidence: no current password, recovery code or setup key.
          await expect(
            dialog().getByLabel("Current password", { exact: true }),
          ).toHaveValue("");
          await expect(
            dialog().getByLabel("Recovery code", { exact: true }),
          ).toHaveValue("");
          await page.screenshot({
            path: resolve(
              repository,
              "docs/screenshots/mfa-recovery-disable-synthetic.png",
            ),
            animations: "disabled",
          });
        }
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
      "Actual UsersSecurity and authenticator setup React controls against a disposable synthetic API. Starts from an MFA-enabled signed-in account; it does not repeat real login or server factor verification. No live instance, credentials, accounts, screenshots or traces. Credential values and request bodies are omitted.",
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
  await writeFile(
    resolve(repository, "docs/evidence/mfa-recovery-ui.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
  await vite.close();
  console.log("Evidence: docs/evidence/mfa-recovery-ui.json");
}
