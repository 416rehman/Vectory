// Actual Enrollment UI with disposable synthetic transport; no real tokens or devices.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_ENROLLMENT_COMPONENT_OUTPUT ||
    ".local/enrollment-component",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:enrollment-fixture";
const server = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    proxy: {},
    hmr: false,
  },
  plugins: [
    {
      name: "synthetic-enrollment-fixture",
      resolveId(id) {
        if (id === "virtual:enrollment-fixture") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {Enrollment} from '/src/Control.tsx';import '/src/styles.css';const root=createRoot(document.getElementById('root'));window.mountEnrollment=()=>root.render(React.createElement(Enrollment,{key:Math.random(),user:{id:'synthetic-admin',name:'Synthetic admin',email:'admin@example.test',role:'admin',enabled:true,revision:1},notify:()=>{},navigate:path=>window.lastNavigation=path}));window.mountEnrollment();`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__enrollment-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              "/__enrollment-fixture",
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic enrollment verification</title></head><body><main style="padding:24px"><div id="root"></div></main><script type="module">import "virtual:enrollment-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const results = [],
  errors = [],
  unexpected = [],
  accessibility = [],
  geometry = [],
  screenshots = [];
let failure;
const serverTime = Date.now();
const tokenId = "8b64e164-3e33-4574-b8f9-829d7b77c2b7";
const device = (status = "online") => ({
  id: "synthetic-device-uuid",
  name: "edge-01",
  os: "linux",
  arch: "amd64",
  agent_version: "synthetic",
  vector_version: "0.58.0",
  status,
  created_at: new Date(serverTime).toISOString(),
  last_seen: new Date(serverTime).toISOString(),
  configuration_mode: "full",
  labels: {},
  desired_generation: 0,
  reported_generation: 0,
  apply_state: "unmanaged",
  sync_paused: false,
  pause_acknowledged: false,
});
async function fixture({
  skew = 0,
  initial = [],
  fail = false,
  width = 1280,
  theme = "light",
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
  });
  await context.addInitScript((value) => {
    const now = Date.now.bind(Date);
    Date.now = () => now() + value;
  }, skew);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const state = {
    devices: initial,
    fail,
    tokens: [],
    posts: 0,
    holdToken: false,
    releaseToken: null,
    tokenRequest: null,
  };
  await context.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (path === "/devices")
      return state.fail
        ? reply(
            {
              error: {
                code: "UNAVAILABLE",
                message: "Synthetic inventory unavailable",
              },
            },
            503,
          )
        : reply(state.devices);
    if (path === "/releases")
      return reply(
        ["windows", "linux", "darwin"].map((os) => ({
          name: "synthetic",
          version: "synthetic",
          os,
          arch: os === "darwin" ? "arm64" : "amd64",
          size: 12,
          sha256: "a".repeat(64),
          signed: false,
          url: "/unused-synthetic-download",
        })),
      );
    if (path === "/tokens" && route.request().method() === "GET")
      return reply(state.tokens);
    if (
      path.startsWith("/tokens/requests/") &&
      route.request().method() === "GET"
    )
      return reply({
        request_id: path.split("/").at(-1),
        request_correlation: true,
        found: false,
      });
    if (path === "/tokens" && route.request().method() === "POST") {
      state.posts++;
      state.tokenRequest = route.request().postDataJSON();
      if (state.holdToken)
        await new Promise((resolve) => {
          state.releaseToken = resolve;
        });
      const record = {
        id: tokenId,
        name: state.tokenRequest.name,
        created_at: new Date(serverTime).toISOString(),
        expires_at: new Date(serverTime + 7 * 86400000).toISOString(),
        uses: 0,
        max_uses: state.tokenRequest.max_uses,
        name_prefix: state.tokenRequest.name_prefix,
        revoked: false,
      };
      state.tokens = [record];
      return reply({
        request_id: state.tokenRequest.request_id,
        request_correlation: true,
        token: "synthetic-unused-token",
        record,
      });
    }
    unexpected.push(path);
    return reply(
      {
        error: { code: "UNEXPECTED", message: "Unexpected synthetic request" },
      },
      500,
    );
  });
  await page.goto(`${origin}/__enrollment-fixture`);
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  const connection = async (mode = "full") => {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Vector configuration mode", { exact: true }).click();
    await page
      .getByRole("menuitemradio", {
        name:
          mode === "full"
            ? "Full Vector configuration"
            : "Restricted components and resources",
        exact: true,
      })
      .click();
  };
  const commands = async (mode = "full") => {
    await connection(mode);
    await page
      .getByRole("button", { name: "Create enrollment token", exact: true })
      .click();
    await page
      .getByRole("button", { name: "I've saved the token", exact: true })
      .click();
  };
  return { context, page, state, connection, commands };
}
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
  console.log("PASS", name);
}
try {
  await check(
    "pending token creation locks connection and token inputs until matching commands are ready",
    async () => {
      const f = await fixture();
      try {
        await f.page.getByRole("radio", { name: "Linux", exact: true }).check();
        await f.connection();
        await f.page
          .getByLabel("Machine name", { exact: true })
          .fill("edge-locked");
        await f.page
          .getByLabel("Server URL", { exact: true })
          .fill("https://synthetic.example.test:8443");
        await f.page
          .getByLabel("Server certificate trust", {
            exact: true,
          })
          .click();
        await f.page
          .getByRole("menuitemradio", {
            name: "Provide a certificate file",
            exact: true,
          })
          .click();
        await f.page
          .getByLabel("CA certificate path on the device", { exact: true })
          .fill("/synthetic/ca.pem");
        await f.page.getByText("Token settings", { exact: true }).click();
        await f.page
          .getByLabel("Allowed machine name prefix (optional)", { exact: true })
          .fill("edge-");
        f.state.holdToken = true;
        await f.page
          .getByRole("button", { name: "Create enrollment token", exact: true })
          .click();
        await expect.poll(() => f.state.posts).toBe(1);
        for (const name of [
          "Machine name",
          "Server URL",
          "Vector configuration mode",
          "CA certificate path on the device",
          "Token name",
          "Expires in (hours)",
          "Maximum uses",
          "Allowed machine name prefix (optional)",
        ])
          await expect(f.page.getByLabel(name, { exact: true })).toBeDisabled();
        await expect(
          f.page.getByLabel("Server certificate trust", { exact: true }),
        ).toBeDisabled();
        expect(f.state.tokenRequest.name_prefix).toBe("edge-");
        expect(f.state.tokenRequest.name).toBe("edge-locked enrollment");
        f.state.releaseToken();
        f.state.releaseToken = null;
        await f.page
          .getByRole("button", { name: "I've saved the token", exact: true })
          .click();
        await expect(
          f.page.getByRole("heading", {
            name: "Run the agent on edge-locked",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          f.page
            .locator(".enroll-command-step")
            .filter({ hasText: "3. Enroll this device" }),
        ).toContainText("--id 'edge-locked'");
        await expect(
          f.page
            .locator(".enroll-command-step")
            .filter({ hasText: "3. Enroll this device" }),
        ).toContainText("--server 'https://synthetic.example.test:8443'");
        await expect(
          f.page
            .locator(".enroll-command-step")
            .filter({ hasText: "3. Enroll this device" }),
        ).toContainText("--ca-file '/synthetic/ca.pem'");
      } finally {
        f.state.releaseToken?.();
        await f.context.close();
      }
    },
  );
  await check(
    "new device verification is independent of browser clock being a day ahead",
    async () => {
      const f = await fixture({ skew: 86400000 });
      try {
        await f.commands();
        f.state.devices = [device()];
        await f.page
          .getByRole("button", { name: "Check connection", exact: true })
          .click();
        await expect(
          f.page.getByRole("heading", {
            name: "edge-01 is enrolled",
            exact: true,
          }),
        ).toBeVisible();
        await f.page
          .getByRole("button", { name: "Open device", exact: true })
          .click();
        expect(await f.page.evaluate(() => window.lastNavigation)).toBe(
          "devices/synthetic-device-uuid",
        );
        expect(f.state.posts).toBe(1);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "existing device remains a conflict with a slow clock and has a continuation path after reload",
    async () => {
      const f = await fixture({ skew: -86400000, initial: [device()] });
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt) await f.page.reload();
          await f.connection();
          await expect(
            f.page.getByRole("button", {
              name: "Create enrollment token",
              exact: true,
            }),
          ).toBeDisabled();
          await f.page
            .getByRole("button", { name: "Open existing device", exact: true })
            .click();
          expect(await f.page.evaluate(() => window.lastNavigation)).toBe(
            "devices/synthetic-device-uuid",
          );
        }
        expect(f.state.posts).toBe(0);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "failed initial inventory cannot be treated as an empty fleet and retry establishes the baseline",
    async () => {
      const f = await fixture({ fail: true, initial: [device()] });
      try {
        await f.connection();
        await expect(f.page.getByRole("alert")).toContainText(
          "Synthetic inventory unavailable",
        );
        await expect(
          f.page.getByRole("button", {
            name: "Create enrollment token",
            exact: true,
          }),
        ).toBeDisabled();
        f.state.fail = false;
        await f.page
          .getByRole("button", { name: "Try again", exact: true })
          .click();
        await expect(
          f.page.getByRole("button", {
            name: "Open existing device",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          f.page.getByRole("button", {
            name: "Create enrollment token",
            exact: true,
          }),
        ).toBeDisabled();
        expect(f.state.posts).toBe(0);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "a newly observed revoked identity is not reported as successfully enrolled",
    async () => {
      const f = await fixture();
      try {
        await f.commands();
        f.state.devices = [device("revoked")];
        await f.page
          .getByRole("button", { name: "Check connection", exact: true })
          .click();
        await expect(
          f.page.getByRole("heading", {
            name: "edge-01 access is revoked",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          f.page.getByRole("heading", {
            name: "edge-01 is enrolled",
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(
          f.page.getByRole("button", { name: "Open device", exact: true }),
        ).toBeEnabled();
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "adoption prepares the sole managed JSON before stopping the old supervisor on all three platforms",
    async () => {
      for (const platform of [
        {
          name: "Windows",
          path: "C:\\ProgramData\\VectoryConfig\\managed.json",
          custom: "C:\\ProgramData\\Owner's Vector\\managed.json",
          flag: "'C:\\ProgramData\\Owner''s Vector\\managed.json'",
          binary: ".\\vectory.exe",
        },
        {
          name: "Linux",
          path: "/etc/vector/vectory-managed/managed.json",
          custom: "/srv/owner's-vector/managed.json",
          flag: "'/srv/owner'\"'\"'s-vector/managed.json'",
          binary: "./vectory",
        },
        {
          name: "macOS",
          path: "/Library/Application Support/VectoryConfig/managed.json",
          custom: "/Library/Application Support/Owner's Vector/managed.json",
          flag: "'/Library/Application Support/Owner'\"'\"'s Vector/managed.json'",
          binary: "./vectory",
        },
      ]) {
        const f = await fixture();
        try {
          await f.page
            .getByRole("radio", { name: platform.name, exact: true })
            .check();
          await f.commands("restricted");
          await expect(
            f.page.getByLabel("Starting workload", { exact: true }),
          ).toHaveValue("existing");
          await expect(
            f.page.getByLabel("Managed configuration file", { exact: true }),
          ).toHaveValue(platform.path);
          const preparation = f.page.locator(
            '[data-enrollment-preparation="existing"]',
          );
          await expect(preparation).toContainText(
            "No local allowance file was selected",
          );
          await expect(preparation).toContainText(
            "before stopping Vector",
          );
          const instructions = await preparation
            .locator("li")
            .allTextContents();
          expect(instructions).toHaveLength(3);
          expect(instructions[0]).toMatch(
            /Back up.*configuration and service definition\s+outside the managed directory/s,
          );
          expect(instructions[1]).toMatch(
            /While Vector is still running.*copy or combine all.*configuration files.*managed JSON/s,
          );
          expect(instructions[2]).toMatch(
            /Only after that file is ready, stop and disable the old\s+supervisor/s,
          );
          await expect(preparation).toContainText("does not discover or copy");
          await expect(preparation).toContainText(
            "local permissions for restricted mode",
          );
          await expect(
            preparation.getByRole("link", {
              name: /adoption preparation steps/,
            }),
          ).toHaveAttribute(
            "href",
            "/help/installation/#keep-an-existing-workload",
          );
          const headings = await f.page
            .locator(".enroll-command-step h3")
            .allTextContents();
          expect(headings).toEqual([
            "1. Prepare the workload before stopping Vector",
            "2. Install the agent",
            "3. Enroll this device",
            "4. Keep the agent running",
          ]);
          await f.page
            .getByLabel("Managed configuration file", { exact: true })
            .fill(platform.custom);
          const installation = f.page
            .locator(".enroll-command-step")
            .filter({ hasText: "2. Install the agent" });
          await expect(installation).toContainText(
            `${platform.binary} install`,
          );
          await expect(installation).toContainText(
            `--managed-config ${platform.flag}`,
          );
          await expect(installation).toContainText(
            "--adopt --allow-full-vector-config=false",
          );
          await expect(
            f.page.locator(".enroll-command-step").last(),
          ).toContainText("A missing file starts no Vector process");
          await expect(f.page.locator("body")).not.toContainText(
            "synthetic-unused-token",
          );
          expect(f.state.posts).toBe(1);
        } finally {
          await f.context.close();
        }
      }
    },
  );
  await check(
    "new unmanaged enrollment has explicit no-process behavior and switching instructions preserves paths and token",
    async () => {
      const f = await fixture();
      try {
        await f.commands();
        await f.page
          .getByLabel("Managed configuration file", { exact: true })
          .fill("C:\\ProgramData\\Prepared\\managed.json");
        const before = await f.page
          .locator(".control-command code")
          .allTextContents();
        await f.page
          .getByLabel("Starting workload", { exact: true })
          .selectOption("new");
        const preparation = f.page.locator(
          '[data-enrollment-preparation="new"]',
        );
        await expect(preparation).toContainText("without starting Vector");
        await expect(preparation).toContainText(
          "No pipeline is assigned automatically",
        );
        await expect(preparation).toContainText(
          "does not contain an existing workload",
        );
        await expect(preparation).not.toContainText("stop and disable");
        await expect(
          preparation.getByRole("link", { name: /preparing a new device/ }),
        ).toHaveAttribute(
          "href",
          "/help/installation/#start-without-a-workload",
        );
        expect(
          await f.page.locator(".control-command code").allTextContents(),
        ).toEqual(before);
        await f.page.getByRole("button", { name: "Back", exact: true }).click();
        await f.page
          .getByRole("button", {
            name: "Continue with saved token",
            exact: true,
          })
          .click();
        await expect(
          f.page.getByLabel("Starting workload", { exact: true }),
        ).toHaveValue("new");
        await expect(
          f.page.getByLabel("Managed configuration file", { exact: true }),
        ).toHaveValue("C:\\ProgramData\\Prepared\\managed.json");
        await f.page
          .getByLabel("Starting workload", { exact: true })
          .selectOption("existing");
        await expect(
          f.page.getByRole("heading", {
            name: "1. Prepare the workload before stopping Vector",
            exact: true,
          }),
        ).toBeVisible();
        expect(
          await f.page.locator(".control-command code").allTextContents(),
        ).toEqual(before);
        expect(f.state.posts).toBe(1);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "preparation and commands remain accessible without horizontal page overflow on desktop and mobile in both themes",
    async () => {
      for (const width of [1280, 375]) {
        for (const theme of ["light", "dark"]) {
          const f = await fixture({ width, theme });
          try {
            await f.commands();
            const workflow = width === 375 ? "new" : "existing";
            await f.page
              .getByLabel("Starting workload", { exact: true })
              .selectOption(workflow);
            const measured = await f.page.evaluate(() => ({
              width: innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
            }));
            geometry.push({ width, theme, workflow, ...measured });
            expect(measured.scrollWidth).toBeLessThanOrEqual(width);
            await f.page
              .getByLabel("Starting workload", { exact: true })
              .focus();
            await f.page.keyboard.press("Tab");
            await expect(
              f.page.getByLabel("Managed configuration file", { exact: true }),
            ).toBeFocused();
            const audit = await new AxeBuilder({ page: f.page })
              .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
              .analyze();
            accessibility.push({
              width,
              theme,
              violations: audit.violations.map(({ id, impact }) => ({
                id,
                impact,
              })),
            });
            expect(audit.violations).toEqual([]);
            // Capture only after the one-time synthetic token modal has been dismissed.
            await expect(f.page.getByRole("dialog")).toHaveCount(0);
            await expect(f.page.locator("body")).not.toContainText(
              "synthetic-unused-token",
            );
            await f.page
              .getByRole("heading", {
                name: "Run the agent on edge-01",
                exact: true,
              })
              .scrollIntoViewIfNeeded();
            const filename = `enrollment-${width === 375 ? "mobile" : "desktop"}-${theme}.png`;
            await f.page.screenshot({
              path: resolve(output, filename),
              fullPage: true,
              animations: "disabled",
            });
            screenshots.push(relative(repository, resolve(output, filename)));
            expect(f.state.posts).toBe(1);
          } finally {
            await f.context.close();
          }
        }
      }
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  await server.close();
  const source_sha256 = {};
  for (const path of [
    "dashboard/src/Control.tsx",
    "dashboard/tests/enrollment-browser.mjs",
    "docs/user/installation.md",
    "agent/internal/agent/reconcile.go",
  ])
    source_sha256[path] = createHash("sha256")
      .update(await readFile(resolve(repository, path)))
      .digest("hex");
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        source: "actual React Enrollment with isolated synthetic HTTP fixtures",
        scope:
          "Browser instructions and generated commands only. No preview, real token, device, filesystem adoption, native startup or activation was exercised.",
        passed: !failure,
        source_sha256,
        results,
        accessibility,
        geometry,
        screenshots,
        browser_errors: errors,
        unexpected_requests: unexpected,
        failure: failure ? String(failure.stack || failure) : undefined,
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
}
if (failure) throw failure;
