// Actual App with disposable synthetic transport. No real enrollment or certificate access.
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
  process.env.VECTORY_ENROLLMENT_CONNECTION_OUTPUT ||
    ".local/enrollment-connection",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:enrollment-connection-fixture";
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
      name: "synthetic-enrollment-connection",
      resolveId(id) {
        if (id === "virtual:enrollment-connection-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__enrollment-connection") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              "/__enrollment-connection",
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic enrollment connection review</title></head><body><div id="root"></div><script type="module">import "virtual:enrollment-connection-fixture";</script></body></html>',
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
  accessibility = [],
  screenshots = [],
  geometry = [],
  errors = [],
  unexpected = [],
  requests = [];
let failure;
const id = (n) => `d6933dc9-4f37-4d80-8fb1-${String(n).padStart(12, "0")}`;
const user = (role) => ({
  id: id(1),
  name: "Synthetic administrator",
  email: "enrollment@example.test",
  role,
  enabled: true,
  revision: 1,
});
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/Control.tsx",
  "dashboard/src/EnrollmentTokenFlow.tsx",
  "dashboard/src/enrollmentTokenRequests.ts",
  "dashboard/src/enrollment-token-flow.css",
  "dashboard/src/DescribedPicker.tsx",
  "dashboard/src/EnrollmentConnection.tsx",
  "dashboard/src/enrollment-connection.css",
  "dashboard/src/RolePicker.tsx",
  "dashboard/src/role-picker.css",
  "dashboard/src/control.css",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/tests/enrollment-connection-browser.mjs",
];
async function hashes() {
  const values = {};
  for (const path of sourceFiles)
    values[path] = createHash("sha256")
      .update(await readFile(resolve(repository, path)))
      .digest("hex");
  return values;
}
let sourceStart;
const modeLabel = "Vector configuration mode";
const fullLabel = "Full Vector configuration";
const restrictedLabel = "Restricted components and resources";
const trustLabel = "Server certificate trust";
const systemLabel = "Use system trust";
const privateLabel = "Provide a certificate file";
async function fixture({ role = "admin", width = 1280, theme = "light" } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 980 },
    colorScheme: theme,
  });
  await context.addInitScript(
    (theme) => localStorage.setItem("vectory-theme", theme),
    theme,
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const state = {
    tokens: [],
    posts: 0,
    holdToken: false,
    releaseToken: null,
    tokenBody: null,
    requests: [],
  };
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", ""),
      method = request.method();
    const item = { path, method };
    requests.push(item);
    state.requests.push(item);
    const reply = async (json, status = 200) => {
      try {
        await route.fulfill({ json, status });
      } catch {
        /* A closed fixture cancels its own reads. */
      }
    };
    if (path === "/status")
      return reply({ initialized: true, version: "synthetic" });
    if (path === "/session")
      return reply({ user: user(role), csrf_token: "synthetic-unused-csrf" });
    if (path === "/settings")
      return reply({ instance_name: "Synthetic enrollment review" });
    if (path === "/devices") return reply([]);
    if (path === "/releases")
      return reply(
        ["windows", "linux", "darwin"].map((os) => ({
          name: "Synthetic agent",
          version: "synthetic",
          os,
          arch: os === "darwin" ? "arm64" : "amd64",
          size: 12,
          sha256: "a".repeat(64),
          signed: false,
          url: "/unused-synthetic-download",
        })),
      );
    if (path === "/tokens" && method === "GET") return reply(state.tokens);
    if (path.startsWith("/tokens/requests/") && method === "GET")
      return reply({
        request_id: path.split("/").at(-1),
        request_correlation: true,
        found: false,
      });
    if (path === `/tokens/${state.tokens[0]?.id}/revoke` && method === "POST") {
      state.tokens = state.tokens.map((token) => ({ ...token, revoked: true }));
      return reply({ ok: true });
    }
    if (path === "/tokens" && method === "POST") {
      state.posts++;
      state.tokenBody = request.postDataJSON();
      if (state.holdToken)
        await new Promise((release) => {
          state.releaseToken = release;
        });
      const record = {
        id: id(10 + state.posts),
        name: state.tokenBody.name,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        uses: 0,
        max_uses: state.tokenBody.max_uses,
        name_prefix: state.tokenBody.name_prefix,
        revoked: false,
      };
      state.tokens = [record];
      return reply({
        request_id: state.tokenBody.request_id,
        request_correlation: true,
        token: "synthetic-unused-enrollment-token",
        record,
      });
    }
    unexpected.push(item);
    return reply(
      {
        error: { code: "UNEXPECTED", message: "Unexpected synthetic request" },
      },
      500,
    );
  });
  await page.goto(`${origin}/__enrollment-connection#/enrollment`);
  const trigger = (label) =>
    page.getByRole("button", { name: label, exact: true });
  const choose = async (label, option) => {
    await trigger(label).click();
    await page
      .getByRole("menuitemradio", { name: option, exact: true })
      .click();
    await expect(page.getByRole("menu")).toHaveCount(0);
  };
  const connection = async (os = "Linux") => {
    await page.getByRole("radio", { name: os, exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(trigger(modeLabel)).toBeVisible();
  };
  const commands = async () => {
    await page
      .getByRole("button", { name: "Create enrollment token", exact: true })
      .click();
    await page
      .getByRole("button", { name: "I've saved the token", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Run the agent on edge-01",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      "synthetic-unused-enrollment-token",
    );
  };
  const install = page
    .locator(".enroll-command-step")
    .filter({ hasText: "2. Install the agent" });
  const enroll = page
    .locator(".enroll-command-step")
    .filter({ hasText: "3. Enroll this device" });
  const close = async () => {
    state.releaseToken?.();
    await context.close();
  };
  return {
    context,
    page,
    state,
    trigger,
    choose,
    connection,
    commands,
    install,
    enroll,
    close,
  };
}
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
  console.log("PASS", name);
}
async function audit(page, name, width, theme) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  accessibility.push({
    name,
    width,
    theme,
    violations: result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map(({ target }) => target),
    })),
  });
  expect(result.violations).toEqual([]);
}
async function capture(page, suffix) {
  const path = resolve(output, `enrollment-connection-${suffix}.png`);
  await page.screenshot({ path, animations: "disabled" });
  screenshots.push(relative(repository, path));
}

try {
  sourceStart = await hashes();
  await check(
    "Mode is an explicit descriptive choice; opening or choosing it never creates a token",
    async () => {
      const f = await fixture();
      try {
        await f.connection();
        const create = f.page.getByRole("button", {
          name: "Create enrollment token",
          exact: true,
        });
        await expect(create).toBeDisabled();
        await expect(f.trigger(modeLabel)).toContainText("Choose");
        await f.trigger(modeLabel).click();
        const full = f.page.getByRole("menuitemradio", {
          name: fullLabel,
          exact: true,
        });
        const restricted = f.page.getByRole("menuitemradio", {
          name: restrictedLabel,
          exact: true,
        });
        await expect(full).toContainText(/file|network|publishers/i);
        await expect(restricted).toContainText(/local|permissions|allowances/i);
        for (const option of [full, restricted]) {
          const description = await option.getAttribute("aria-describedby");
          expect(description).toBeTruthy();
          expect(
            await f.page.locator(`[id="${description}"]`).innerText(),
          ).toMatch(/.{45}/);
        }
        await full.click();
        await expect(f.trigger(modeLabel)).toContainText(fullLabel);
        await expect(create).toBeEnabled();
        await expect(f.page.getByRole("menu")).toHaveCount(0);
        expect(f.state.posts).toBe(0);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Keyboard selection, Escape and outside click restore the descriptive picker without submitting",
    async () => {
      const f = await fixture();
      try {
        await f.connection();
        await f.trigger(modeLabel).focus();
        await f.page.keyboard.press("Space");
        const first = f.page.getByRole("menuitemradio", {
          name: fullLabel,
          exact: true,
        });
        await expect(first).toBeFocused();
        await f.page.keyboard.press("ArrowDown");
        await expect(
          f.page.getByRole("menuitemradio", {
            name: restrictedLabel,
            exact: true,
          }),
        ).toBeFocused();
        await f.page.keyboard.press("Enter");
        await expect(f.trigger(modeLabel)).toBeFocused();
        await expect(f.trigger(modeLabel)).toContainText(restrictedLabel);
        await f.page.keyboard.press("Space");
        await f.page.keyboard.press("Escape");
        await expect(f.page.getByRole("menu")).toHaveCount(0);
        await expect(f.trigger(modeLabel)).toBeFocused();
        await f.trigger(modeLabel).click();
        await f.page.getByLabel("Machine name", { exact: true }).click();
        await expect(f.page.getByRole("menu")).toHaveCount(0);
        await expect(f.trigger(modeLabel)).toContainText(restrictedLabel);
        expect(f.state.posts).toBe(0);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Restricted local allowances use an optional device file and only the restricted install command includes it",
    async () => {
      const f = await fixture();
      try {
        await f.connection();
        await f.choose(modeLabel, restrictedLabel);
        const policy = f.page.getByLabel(
          "Local allowance file on the device (optional)",
          { exact: true },
        );
        const create = f.page.getByRole("button", {
          name: "Create enrollment token",
          exact: true,
        });
        await expect(policy).toBeVisible();
        await expect(f.page.locator(".enrollment-policy")).toContainText(
          "The dashboard cannot grant these permissions",
        );
        await expect(create).toBeEnabled();
        await policy.fill("./capabilities.json");
        await expect(policy).toHaveAttribute("aria-invalid", "true");
        await expect(create).toBeDisabled();
        await policy.fill("/protected/approved capabilities.json");
        await expect(policy).toHaveAttribute("aria-invalid", "false");
        await expect(create).toBeEnabled();
        await policy.scrollIntoViewIfNeeded();
        await audit(f.page, "restricted-policy", 1280, "light");
        await capture(f.page, "restricted-policy-1280-light");
        await f.choose(modeLabel, fullLabel);
        await expect(policy).toHaveCount(0);
        await f.commands();
        await expect(f.install).not.toContainText("--capability-policy");
        await f.page.getByRole("button", { name: "Back", exact: true }).click();
        await f.choose(modeLabel, restrictedLabel);
        await expect(policy).toHaveValue(
          "/protected/approved capabilities.json",
        );
        await f.page
          .getByRole("button", {
            name: "Continue with saved token",
            exact: true,
          })
          .click();
        await expect(f.install).toContainText(
          "--capability-policy '/protected/approved capabilities.json'",
        );
        expect(f.state.posts).toBe(1);
        expect(f.state.tokenBody).not.toHaveProperty("capability_policy");
      } finally {
        await f.close();
      }
      const windows = await fixture();
      try {
        await windows.connection("Windows");
        await windows.choose(modeLabel, restrictedLabel);
        const policy = windows.page.getByLabel(
          "Local allowance file on the device (optional)",
          { exact: true },
        );
        await policy.fill("\\\\fileserver\\share\\capabilities.json");
        await expect(policy).toHaveAttribute("aria-invalid", "true");
        await expect(
          windows.page.getByRole("button", {
            name: "Create enrollment token",
            exact: true,
          }),
        ).toBeDisabled();
        await policy.fill("C:\\ProgramData\\Vectory Trust\\capabilities.json");
        await windows.commands();
        await expect(windows.install).toContainText(
          "--capability-policy 'C:\\ProgramData\\Vectory Trust\\capabilities.json'",
        );
      } finally {
        await windows.close();
      }
    },
  );
  await check(
    "Connection fields accept server-supported machine names and explain local input refusals before token creation",
    async () => {
      const f = await fixture();
      try {
        await f.connection();
        await f.choose(modeLabel, restrictedLabel);
        const create = f.page.getByRole("button", {
          name: "Create enrollment token",
          exact: true,
        });
        const machine = f.page.getByLabel("Machine name", { exact: true });
        const serverURL = f.page.getByLabel("Server URL", { exact: true });
        for (const value of ["edge.example.test", "N".repeat(100)]) {
          await machine.fill(value);
          await expect(machine).toHaveValue(value);
          await expect(create).toBeEnabled();
        }
        for (const value of ["-edge", "edge space", "edge/name", "caf\u00e9"]) {
          await machine.fill(value);
          await expect(create).toBeDisabled();
          await expect(machine).toHaveAttribute("aria-invalid", "true");
          await expect(machine).toHaveAccessibleDescription(
            /Start with a letter or number/,
          );
        }
        await machine.fill("Edge.01");
        await f.page
          .locator("summary")
          .filter({ hasText: "Token settings" })
          .click();
        const prefix = f.page.getByLabel(
          "Allowed machine name prefix (optional)",
          { exact: true },
        );
        await prefix.fill("edge");
        await expect(create).toBeEnabled();
        await prefix.fill("another");
        await expect(create).toBeDisabled();
        await prefix.fill("Edge");
        expect(
          await prefix.evaluate((element) => element.checkValidity()),
        ).toBe(false);
        await prefix.fill("");
        await machine.fill("edge-01");
        for (const value of [
          "http://example.test",
          "https://example.test:0",
          "https://example.test:65536",
          "https://example.test/path",
          "https://operator@example.test",
        ]) {
          await serverURL.fill(value);
          await expect(create).toBeDisabled();
          await expect(serverURL).toHaveAttribute("aria-invalid", "true");
          await expect(serverURL).toHaveAccessibleDescription(/valid port/);
        }
        await serverURL.fill("https://example.test:65535");
        await expect(create).toBeEnabled();
        await expect(serverURL).toHaveAttribute("aria-invalid", "false");
        expect(f.state.posts).toBe(0);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "System trust explicitly clears a custom CA and selected modes generate the local authority flag",
    async () => {
      const f = await fixture();
      try {
        await f.connection();
        await expect(f.trigger(trustLabel)).toContainText(systemLabel);
        const systemHelp = f.page.locator(".enrollment-trust-help");
        await systemHelp.locator("summary").click();
        await expect(systemHelp).toContainText(
          "Opening this dashboard in your browser does not confirm trust on another device",
        );
        await expect(systemHelp).not.toContainText("device-ca.pem");
        await systemHelp.locator("summary").click();
        await expect(
          f.page.getByLabel("CA certificate path on the device", {
            exact: true,
          }),
        ).toHaveCount(0);
        await f.choose(modeLabel, restrictedLabel);
        await f.commands();
        await expect(f.install).toContainText(
          "--allow-full-vector-config=false",
        );
        await expect(f.enroll).toContainText("--ca-file=");
        await expect(f.enroll).not.toContainText(/--insecure|--skip.*tls/i);
        await f.page.getByRole("button", { name: "Back", exact: true }).click();
        await f.choose(modeLabel, fullLabel);
        await f.page
          .getByRole("button", {
            name: "Continue with saved token",
            exact: true,
          })
          .click();
        await expect(f.install).toContainText(
          "--allow-full-vector-config=true",
        );
        await expect(f.enroll).toContainText("--ca-file=");
        expect(f.state.posts).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Private trust requires a device-local CA path and switching back explicitly selects system trust",
    async () => {
      const f = await fixture();
      try {
        await f.connection();
        await f.choose(modeLabel, restrictedLabel);
        await f.choose(trustLabel, privateLabel);
        const ca = f.page.getByLabel("CA certificate path on the device", {
          exact: true,
        });
        await expect(ca).toBeVisible();
        await expect(
          f.page.getByRole("button", {
            name: "Create enrollment token",
            exact: true,
          }),
        ).toBeDisabled();
        await ca.fill("   ");
        await expect(
          f.page.getByRole("button", {
            name: "Create enrollment token",
            exact: true,
          }),
        ).toBeDisabled();
        await ca.fill("./trust/server-ca.pem");
        await expect(ca).toHaveAttribute("aria-invalid", "true");
        await expect(ca).toHaveAccessibleDescription(/Relative paths can fail/);
        await expect(
          f.page.getByRole("button", {
            name: "Create enrollment token",
            exact: true,
          }),
        ).toBeDisabled();
        expect(f.state.posts).toBe(0);
        await ca.fill("/protected/Synthetic CA/server-ca.pem");
        await expect(ca).toHaveAttribute("aria-invalid", "false");
        await expect(
          f.page.getByRole("button", {
            name: "Create enrollment token",
            exact: true,
          }),
        ).toBeEnabled();
        await f.choose(trustLabel, systemLabel);
        await expect(ca).toHaveCount(0);
        await f.commands();
        await expect(f.enroll).toContainText("--ca-file=");
        await expect(f.enroll).not.toContainText(
          "/protected/Synthetic CA/server-ca.pem",
        );
        await f.page.getByRole("button", { name: "Back", exact: true }).click();
        await f.choose(trustLabel, privateLabel);
        await expect(ca).toHaveValue("/protected/Synthetic CA/server-ca.pem");
        await f.page
          .getByRole("button", {
            name: "Continue with saved token",
            exact: true,
          })
          .click();
        await expect(f.enroll).toContainText(
          "--ca-file '/protected/Synthetic CA/server-ca.pem'",
        );
        expect(f.state.posts).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Private CA guidance identifies listener trust and self-admin certificate provenance; Windows paths remain safely quoted",
    async () => {
      const f = await fixture();
      try {
        await f.connection("Windows");
        await expect(
          f.page.getByLabel("Server URL", { exact: true }),
        ).toHaveAccessibleDescription(
          /works only when the agent runs on this server/,
        );
        await f.choose(modeLabel, fullLabel);
        await f.choose(trustLabel, privateLabel);
        // Exact disclosure and guidance assertions follow the final approved UI copy.
        const disclosure = f.page.locator("details").filter({
          has: f.page
            .locator("summary")
            .filter({ hasText: /^I run the server/ }),
        });
        await expect(
          f.page.locator(".enrollment-certificate-preparation"),
        ).toContainText(
          "request it from the server administrator through a trusted channel",
        );
        await disclosure.locator("summary").click();
        await expect(disclosure).toContainText(/agent HTTPS listener/i);
        await expect(disclosure).toContainText("VECTORY_TLS_CERT_FILE");
        await expect(disclosure).toContainText(/never private keys/i);
        await expect(disclosure).toContainText(/device-ca.pem|device CA/i);
        const ca = f.page.getByLabel("CA certificate path on the device", {
          exact: true,
        });
        for (const path of [
          ".\\server-ca.pem",
          "\\\\fileserver\\trust\\server-ca.pem",
          "\\\\?\\C:\\trust\\server-ca.pem",
          "C:\\",
          "C:\\trust\\..\\server-ca.pem",
        ]) {
          await ca.fill(path);
          await expect(ca).toHaveAttribute("aria-invalid", "true");
          await expect(ca).toHaveAccessibleDescription(/local drive/);
          await expect(
            f.page.getByRole("button", {
              name: "Create enrollment token",
              exact: true,
            }),
          ).toBeDisabled();
        }
        expect(f.state.posts).toBe(0);
        await ca.fill("C:\\Synthetic CA\\operator's CA.pem");
        await expect(ca).toHaveAttribute("aria-invalid", "false");
        await f.commands();
        await expect(f.enroll).toContainText(
          "--ca-file 'C:\\Synthetic CA\\operator''s CA.pem'",
        );
        await expect(f.enroll).toContainText(".\\vectory.exe enroll");
        expect(f.state.posts).toBe(1);
        expect(
          f.state.requests.filter(({ method }) => method !== "GET"),
        ).toEqual([{ path: "/tokens", method: "POST" }]);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Pending token creation disables both custom pickers and retains the reviewed command inputs",
    async () => {
      const f = await fixture();
      try {
        await f.connection();
        await f.choose(modeLabel, fullLabel);
        await f.choose(trustLabel, privateLabel);
        await f.page
          .getByLabel("CA certificate path on the device", { exact: true })
          .fill("/synthetic/ca.pem");
        f.state.holdToken = true;
        await f.page
          .getByRole("button", { name: "Create enrollment token", exact: true })
          .click();
        await expect.poll(() => f.state.posts).toBe(1);
        for (const label of [modeLabel, trustLabel])
          await expect(f.trigger(label)).toBeDisabled();
        for (const label of [
          "Machine name",
          "Server URL",
          "CA certificate path on the device",
        ])
          await expect(
            f.page.getByLabel(label, { exact: true }),
          ).toBeDisabled();
        await expect(f.page.getByRole("menu")).toHaveCount(0);
        f.state.releaseToken();
        f.state.releaseToken = null;
        await f.page
          .getByRole("button", { name: "I've saved the token", exact: true })
          .click();
        await expect(f.install).toContainText(
          "--allow-full-vector-config=true",
        );
        await expect(f.enroll).toContainText("--ca-file '/synthetic/ca.pem'");
        expect(f.state.posts).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Install paths must be absolute on the device, and managed configuration must be .json before commands can be copied",
    async () => {
      for (const os of ["Linux", "Windows"]) {
        const f = await fixture();
        try {
          await f.connection(os);
          await f.choose(modeLabel, restrictedLabel);
          await f.commands();
          const config = f.page.getByLabel("Managed configuration file", {
            exact: true,
          });
          const vector = f.page.getByLabel("Existing Vector executable", {
            exact: true,
          });
          const state = f.page.getByLabel("Agent state directory", {
            exact: true,
          });
          const next = f.page.getByRole("button", {
            name: "Check connection",
            exact: true,
          });
          const copy = f.page.getByRole("button", {
            name: /^Copy .* command$/,
          });
          await expect(config).toHaveAttribute("aria-invalid", "false");
          await expect(next).toBeEnabled();
          await expect(copy).toHaveCount(3);

          await config.fill("relative.json");
          await expect(config).toHaveAttribute("aria-invalid", "true");
          await expect(config).toHaveAccessibleDescription(/absolute path/);
          await expect(next).toBeDisabled();
          await expect(copy).toHaveCount(0);
          await expect(f.install).toContainText(
            "Correct the local paths above to show this command",
          );
          const absoluteConfig =
            os === "Windows"
              ? "C:\\ProgramData\\VectoryConfig\\managed"
              : "/etc/vector/vectory-managed/managed";
          await config.fill(`${absoluteConfig}.yaml`);
          await expect(config).toHaveAccessibleDescription(/end in \.json/);
          await expect(next).toBeDisabled();
          await config.fill(`${absoluteConfig}.json`);
          await expect(config).toHaveAttribute("aria-invalid", "false");
          await expect(next).toBeEnabled();

          await f.page
            .locator(".control-disclosure > summary")
            .filter({ hasText: "Other local paths" })
            .click();
          await vector.fill(
            os === "Windows" ? "\\\\fileserver\\vector.exe" : "bin/vector",
          );
          await expect(vector).toHaveAttribute("aria-invalid", "true");
          await expect(vector).toHaveAccessibleDescription(/absolute path/);
          await expect(next).toBeDisabled();
          await expect(copy).toHaveCount(0);
          await vector.fill(
            os === "Windows"
              ? "C:\\Program Files\\Vector\\bin\\vector.exe"
              : "/usr/bin/vector",
          );
          await expect(vector).toHaveAttribute("aria-invalid", "false");

          await state.fill(os === "Windows" ? "C:\\" : "var/lib/vectory");
          await expect(state).toHaveAttribute("aria-invalid", "true");
          await expect(state).toHaveAccessibleDescription(/absolute path/);
          await expect(next).toBeDisabled();
          await expect(copy).toHaveCount(0);
          await state.fill(
            os === "Windows" ? "C:\\ProgramData\\Vectory" : "/var/lib/vectory",
          );
          await expect(state).toHaveAttribute("aria-invalid", "false");
          await expect(next).toBeEnabled();
          await expect(copy).toHaveCount(3);
          await expect(f.install).toContainText(
            `--managed-config '${absoluteConfig}.json'`,
          );
          await audit(f.page, `install-paths-${os}`, 1280, "light");
          expect(f.state.posts).toBe(1);
          expect(
            f.state.requests.filter(({ method }) => method !== "GET"),
          ).toEqual([{ path: "/tokens", method: "POST" }]);
        } finally {
          await f.close();
        }
      }
    },
  );
  await check(
    "Foreground and unattended instructions generate valid platform-specific service commands without claiming activation",
    async () => {
      for (const os of ["Linux", "macOS", "Windows"]) {
        const f = await fixture({
          width: os === "Windows" ? 375 : 899,
          theme: os === "Windows" ? "dark" : "light",
        });
        try {
          await f.connection(os);
          await f.choose(modeLabel, restrictedLabel);
          await f.commands();
          const section = f.page.locator(".enroll-command-step").filter({
            has: f.page.getByRole("heading", {
              name: "4. Keep the agent running",
              exact: true,
            }),
          });
          const commands = section.locator(".control-command > code");
          await expect(
            f.page.getByRole("radio", { name: /In this terminal/ }),
          ).toBeChecked();
          await expect(commands).toHaveCount(1);
          await expect(commands.first()).toContainText(/ run --state-dir /);
          await expect(section).toContainText("Closing it stops the agent");
          await f.page.getByRole("radio", { name: /As an OS service/ }).check();
          if (os !== "Windows") {
            const account = f.page.getByLabel("Existing service account", {
              exact: true,
            });
            await expect(account).toHaveAttribute("aria-invalid", "true");
            await expect(commands).toHaveCount(0);
            await expect(
              f.page.getByRole("button", {
                name: "Check connection",
                exact: true,
              }),
            ).toBeDisabled();
            await account.fill("root");
            await expect(commands).toHaveCount(0);
            await account.fill("svcagent");
            await expect(account).toHaveAttribute("aria-invalid", "false");
            await expect(commands).toHaveCount(2);
            await expect(commands.nth(0)).toContainText(
              "sudo ./vectory service-install --state-dir ",
            );
            await expect(commands.nth(0)).toContainText(
              "--service-user 'svcagent'",
            );
            await expect(commands.nth(1)).toHaveText(
              "sudo ./vectory service-start",
            );
          } else {
            await expect(
              f.page.getByLabel("Existing service account", { exact: true }),
            ).toHaveCount(0);
            await expect(section).toContainText("NT SERVICE\\Vectory");
            await expect(commands).toHaveCount(2);
            await expect(commands.nth(0)).toContainText(
              ".\\vectory.exe service-install --state-dir ",
            );
            await expect(commands.nth(0)).not.toContainText("--service-user");
            await expect(commands.nth(1)).toHaveText(
              ".\\vectory.exe service-start",
            );
          }
          await expect(
            f.page.getByRole("button", {
              name: "Check connection",
              exact: true,
            }),
          ).toBeEnabled();
          await expect(section).toContainText(
            "does not prove the service started or Vector",
          );
          await expect(section).toContainText(
            "fresh device check-in and the reported apply state",
          );
          if (os === "Windows") {
            await audit(f.page, "service-setup", 375, "dark");
            expect(
              await f.page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth + 1,
              ),
            ).toBe(true);
            await commands.nth(1).scrollIntoViewIfNeeded();
            await capture(f.page, "service-setup-375-dark");
          }
          await f.page.getByRole("radio", { name: /In this terminal/ }).check();
          await expect(commands).toHaveCount(1);
          await expect(commands.first()).toContainText(/ run --state-dir /);
          await expect(section).not.toContainText("service-install");
          expect(f.state.posts).toBe(1);
          expect(
            f.state.requests.filter(({ method }) => method !== "GET"),
          ).toEqual([{ path: "/tokens", method: "POST" }]);
        } finally {
          await f.close();
        }
      }
    },
  );
  await check(
    "Viewers and editors cannot open enrollment controls or create tokens through the actual App route",
    async () => {
      for (const role of ["viewer", "editor"]) {
        const f = await fixture({ role });
        try {
          await expect(
            f.page.getByRole("heading", {
              name: "Adding devices needs the Operator role",
              exact: true,
            }),
          ).toBeVisible();
          await expect(f.trigger(modeLabel)).toHaveCount(0);
          await expect(
            f.page.getByRole("button", {
              name: "Create enrollment token",
              exact: true,
            }),
          ).toHaveCount(0);
          expect(f.state.posts).toBe(0);
          expect(
            f.state.requests.filter(({ path }) => path === "/tokens"),
          ).toEqual([]);
        } finally {
          await f.close();
        }
      }
    },
  );
  await check(
    "Operators can enroll devices and manage tokens through the actual App route",
    async () => {
      const f = await fixture({ role: "operator" });
      try {
        await f.connection();
        await f.choose(modeLabel, fullLabel);
        await expect(
          f.page.getByRole("button", {
            name: "Create enrollment token",
            exact: true,
          }),
        ).toBeEnabled();
        await f.commands();
        expect(f.state.posts).toBe(1);
        await f.page.locator(".enroll-token-management > summary").click();
        await expect(
          f.page.getByRole("button", { name: "Create token", exact: true }),
        ).toBeVisible();
        await f.page
          .getByRole("button", { name: "Revoke", exact: true })
          .click();
        await f.page
          .getByRole("dialog", { name: "Revoke token" })
          .getByRole("button", { name: "Revoke token", exact: true })
          .click();
        await expect(
          f.page.getByRole("dialog", { name: "Token revoked" }),
        ).toBeVisible();
        expect(f.state.tokens[0]?.revoked).toBe(true);
        expect(
          f.state.requests.filter(({ method }) => method !== "GET"),
        ).toEqual([
          { path: "/tokens", method: "POST" },
          { path: `/tokens/${f.state.tokens[0].id}/revoke`, method: "POST" },
        ]);
        await f.page.goto(`${origin}/__enrollment-connection#/devices`);
        await f.page
          .getByRole("button", { name: "Add device", exact: true })
          .first()
          .click();
        await expect(f.page).toHaveURL(/#\/enrollment$/);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Responsive light/dark mode and trust menus remain readable, bounded and accessible",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          const f = await fixture({ width, theme });
          try {
            await f.connection();
            for (const [label, option, suffix] of [
              [modeLabel, restrictedLabel, "mode"],
              [trustLabel, privateLabel, "trust"],
            ]) {
              await f.trigger(label).click();
              const menu = f.page.getByRole("menu");
              await expect(menu).toBeVisible();
              const box = await menu.boundingBox();
              const doc = await f.page.evaluate(() => ({
                width: innerWidth,
                height: innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
              }));
              expect(box.x).toBeGreaterThanOrEqual(0);
              expect(box.x + box.width).toBeLessThanOrEqual(doc.width + 1);
              expect(box.y).toBeGreaterThanOrEqual(0);
              expect(box.y + box.height).toBeLessThanOrEqual(doc.height + 1);
              expect(doc.scrollWidth).toBeLessThanOrEqual(doc.width + 1);
              geometry.push({ width, theme, label, menu: box, document: doc });
              await audit(f.page, suffix, width, theme);
              await capture(f.page, `${suffix}-${width}-${theme}`);
              await f.page
                .getByRole("menuitemradio", { name: option, exact: true })
                .click();
            }
            await f.page
              .getByLabel("CA certificate path on the device", { exact: true })
              .scrollIntoViewIfNeeded();
            await capture(f.page, `private-ca-${width}-${theme}`);
            const disclosure = f.page.locator(".enrollment-trust-help");
            await disclosure.locator("summary").click();
            await expect(disclosure).toContainText("device-ca.pem");
            await expect(disclosure).toContainText(".local/pki/ca.pem");
            await disclosure.evaluate((element) =>
              element.scrollIntoView({ block: "start" }),
            );
            expect(
              await f.page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth + 1,
              ),
            ).toBe(true);
            await capture(f.page, `certificate-help-${width}-${theme}`);
            expect(f.state.posts).toBe(0);
          } finally {
            await f.close();
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
  const sourceEnd = await hashes();
  const sourceChanges = Object.keys(sourceEnd).filter(
    (name) => sourceStart?.[name] !== sourceEnd[name],
  );
  if (sourceChanges.length && !failure)
    failure = new Error(
      `Sources changed during execution: ${sourceChanges.join(", ")}`,
    );
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        passed: !failure,
        scope:
          "Actual App enrollment connection UI with fully isolated synthetic HTTP. No real token/device, certificate read/download, native execution, preview account or fleet mutation.",
        source_sha256: sourceStart,
        source_end_sha256: sourceEnd,
        source_changes: sourceChanges,
        results,
        accessibility,
        geometry,
        screenshots,
        requests,
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
      passed: !failure,
      groups: results.length,
      axe: accessibility.length,
      report: relative(repository, resolve(output, "report.json")),
    }),
  );
}
if (failure) throw failure;
