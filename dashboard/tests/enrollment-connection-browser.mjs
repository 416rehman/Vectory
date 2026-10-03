// Actual App with disposable synthetic transport. No real enrollment, install
// or certificate access.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fleetReplies, fulfillFleetRead } from "./fleet-replies.mjs";

const fleet = fleetReplies({ devices: [], groups: [] });
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
      // `proxy: {}` merges into vite.config.ts's /api proxy instead of
      // replacing it; drop it so no request can leave the fixture.
      config(config) {
        delete config.server.proxy;
      },
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
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Add device review</title></head><body><div id="root"></div><script type="module">import "virtual:enrollment-connection-fixture";</script></body></html>',
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
const pin = "ab".repeat(32);
// A synthetic CA certificate: only its PEM shape matters here.
const caPem = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBszCCAVmgAwIBAgIUU3ludGhldGljIGFnZW50IENBIGZvciB0ZXN0cy4wCgYI",
  "U3ludGhldGljU3ludGhldGljU3ludGhldGlj==",
  "-----END CERTIFICATE-----",
  "",
].join("\n");
const agentInstall = {
  agent_url: "https://vectory.example.test:8443",
  agent_url_configured: true,
  listener_enabled: true,
  dashboard_url: null,
  certificate: {
    available: true,
    publicly_trusted: false,
    ca_sha256: pin,
    ca_fingerprint: null,
    ca_pem: caPem,
    ca_name: "Synthetic agent CA",
    ca_issuer: "Synthetic agent CA",
    ca_not_after: null,
    problem: null,
  },
  downloads_enabled: true,
  installer: {
    url: "https://vectory.example.test:8443/agent/v1/install.sh",
    sha256: "cd".repeat(32),
    platforms: ["linux/amd64"],
  },
  default_install_dir: "/usr/local/bin",
  releases: [
    {
      name: "vectory-0.1.0-dev-linux-amd64",
      os: "linux",
      arch: "amd64",
      version: "0.1.0-dev",
      sha256: "ef".repeat(32),
      size: 7_626_878,
      url: "/api/v1/releases/vectory-0.1.0-dev-linux-amd64",
      signed: false,
      source: "bundled",
    },
  ],
  catalog_problems: [],
};
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/Enrollment.tsx",
  "dashboard/src/EnrollmentTokenFlow.tsx",
  "dashboard/src/enrollmentTokenRequests.ts",
  "dashboard/src/enrollment-token-flow.css",
  "dashboard/src/EnrollmentConnection.tsx",
  "dashboard/src/enrollment-connection.css",
  "dashboard/src/enrollment-page.css",
  "dashboard/src/enrollmentCommands.ts",
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
  const state = { tokens: [], posts: 0, tokenBody: null, requests: [] };
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
    // The device list reads a page of the (empty) fleet and its groups.
    if (await fulfillFleetRead(fleet, route)) return;
    if (path === "/devices") return reply([]);
    if (path === "/agent-install") return reply(agentInstall);
    if (path === "/agent-install/activity")
      return reply({ events: [], now: new Date().toISOString() });
    // The device list also reads groups for its filter.
    if (path === "/groups") return reply([]);
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
      // A held creation keeps the page pending until the check releases it.
      if (state.hold) await state.hold;
      const record = {
        id: id(10 + state.posts),
        name: state.tokenBody.name,
        created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        expires_at: new Date(Date.now() + 3600000)
          .toISOString()
          .replace(/\.\d+Z$/, "Z"),
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
  const createCommand = async () => {
    await page.getByRole("radio", { name: /^Restricted/ }).check();
    await page
      .getByRole("button", { name: "Create install command", exact: true })
      .click();
    await expect(page.locator(".enroll-command pre").first()).toContainText(
      `sudo sh "$dir/vectory-install.sh" \\\n    --mode restricted`,
    );
    await expect(page.locator("body")).not.toContainText(
      "synthetic-unused-enrollment-token",
    );
  };
  return {
    context,
    page,
    state,
    createCommand,
    close: () => context.close(),
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
  await page.screenshot({ path, animations: "disabled", fullPage: true });
  screenshots.push(relative(repository, path));
}

try {
  sourceStart = await hashes();
  await check(
    "Viewers and editors cannot open Add device or create tokens through the actual App route",
    async () => {
      for (const role of ["viewer", "editor"]) {
        const f = await fixture({ role });
        try {
          await expect(
            f.page.getByRole("heading", {
              name: "Needs the Operator or Administrator role",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            f.page.getByRole("button", {
              name: "Create install command",
              exact: true,
            }),
          ).toHaveCount(0);
          expect(f.state.posts).toBe(0);
          expect(
            f.state.requests.filter(({ path }) =>
              ["/tokens", "/agent-install"].includes(path),
            ),
          ).toEqual([]);
        } finally {
          await f.close();
        }
      }
    },
  );
  await check(
    "Operators create an install command and manage its token through the actual App route",
    async () => {
      const f = await fixture({ role: "operator" });
      try {
        await f.createCommand();
        expect(f.state.posts).toBe(1);
        await expect(
          f.page.locator(".enroll-command pre").first(),
        ).toContainText(`echo '${"cd".repeat(32)}  vectory-install.sh'`);
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
        await f.page
          .getByRole("dialog", { name: "Token revoked" })
          .getByRole("button", { name: "Close", exact: true })
          .last()
          .click();
        await expect(f.page.locator(".enroll-timeline")).toContainText(
          "This command's token expired or was revoked.",
        );
        await f.page.goto(`${origin}/__enrollment-connection#/devices`);
        // Leaving with an unconfirmed in-page token asks to save or discard it.
        const save = f.page.getByRole("dialog", {
          name: "Save your enrollment token",
        });
        // The prompt opens a moment after the route change, so wait for it
        // rather than sampling once (a slow machine sampled too early).
        const asked = await save
          .waitFor({ state: "visible", timeout: 3000 })
          .then(
            () => true,
            () => false,
          );
        if (asked)
          await save
            .getByRole("button", { name: "Discard token copy", exact: true })
            .click();
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
    "Saving or discarding the token on the leave prompt goes where the person was heading; closing the prompt stays",
    async () => {
      for (const choice of ["I've saved the token", "Discard token copy"]) {
        const f = await fixture();
        try {
          await f.createCommand();
          const save = f.page.getByRole("dialog", {
            name: "Save your enrollment token",
          });
          const head = () =>
            f.page.evaluate(() => {
              location.hash = "/devices";
            });
          await head();
          await expect(save).toBeVisible();
          await expect(save).toContainText(
            "Save this token or discard its in-page copy before leaving.",
          );
          await expect(f.page).toHaveURL(/#\/enrollment$/);
          // Closing the prompt without choosing is a decision to stay.
          await f.page.keyboard.press("Escape");
          await expect(save).toHaveCount(0);
          await expect(f.page).toHaveURL(/#\/enrollment$/);
          await head();
          await expect(save).toBeVisible();
          await save.getByRole("button", { name: choice, exact: true }).click();
          await expect(f.page).toHaveURL(/#\/devices$/);
          await expect(
            f.page.getByRole("heading", { name: "Devices", exact: true }),
          ).toBeVisible();
          await expect(save).toHaveCount(0);
        } finally {
          await f.close();
        }
      }
    },
  );
  await check(
    "Each certificate choice puts its exact option in the commands, and the choices lock while a token is created",
    async () => {
      const f = await fixture();
      try {
        const install = () =>
          f.page.locator(".enroll-command pre").first().innerText();
        const setup = async () => {
          const manual = f.page.locator(".enroll-manual");
          if (!(await manual.evaluate((details) => details.open)))
            await manual.locator("summary").click();
          return manual.locator("pre").innerText();
        };
        const insecure =
          /(^|\s)(-[A-Za-z]*k[A-Za-z]*|--insecure|--no-check-certificate|-SkipCertificateCheck)(\s|$)/;
        await f.page.locator(".enroll-advanced > summary").click();
        const radios = f.page.locator('input[name="enroll-trust"]');
        await expect(radios).toHaveCount(3);
        // Pinning this server's private CA is the default.
        await expect(
          f.page.getByRole("radio", { name: /^Pin this server's CA/ }),
        ).toBeChecked();
        // The choices lock while the token is being created.
        let release;
        f.state.hold = new Promise((resolve) => (release = resolve));
        await f.page.getByRole("radio", { name: /^Restricted/ }).check();
        await f.page
          .getByRole("button", { name: "Create install command", exact: true })
          .click();
        await expect.poll(() => f.state.posts).toBe(1);
        for (const radio of await radios.all())
          await expect(radio).toBeDisabled();
        release();
        f.state.hold = null;
        await expect(
          f.page.locator(".enroll-command pre").first(),
        ).toBeVisible();
        for (const radio of await radios.all())
          await expect(radio).toBeEnabled();
        // Pinned: the command carries the CA for curl; setup gets the fingerprint.
        let text = await install();
        expect(text).toContain("-----BEGIN CERTIFICATE-----");
        expect(text).toContain(
          `curl -fsSL --proto '=https' --proto-redir '=https' \\\n    --cacert "$dir/vectory-ca.pem" \\`,
        );
        expect(text).not.toContain("--ca-file");
        expect(text).not.toMatch(insecure);
        expect(await setup()).toContain(`--ca-sha256 ${pin}`);
        // A CA file on the host: exactly that path, for curl and for setup.
        await f.page
          .getByRole("radio", { name: /^A CA certificate file on the host/ })
          .check();
        await f.page
          .getByLabel("CA certificate on the host", { exact: true })
          .fill("/etc/vectory/server-ca.pem");
        text = await install();
        expect(text).toContain(
          "curl -fsSL --proto '=https' --proto-redir '=https' \\\n    --cacert /etc/vectory/server-ca.pem \\",
        );
        expect(text).toContain("    --ca-file /etc/vectory/server-ca.pem \\");
        expect(text).not.toContain("BEGIN CERTIFICATE");
        expect(text).not.toMatch(insecure);
        let manual = await setup();
        expect(manual).toContain("  --ca-file /etc/vectory/server-ca.pem \\");
        expect(manual).not.toContain("--ca-sha256");
        await expect(f.page.getByRole("definition").nth(1)).toContainText(
          "/etc/vectory/server-ca.pem",
        );
        // The host's trusted certificates: an explicit, empty --ca-file=.
        await f.page
          .getByRole("radio", { name: /^The host's trusted certificates/ })
          .check();
        text = await install();
        expect(text).toMatch(
          /\n {2}curl -fsSL --proto '=https' --proto-redir '=https' \\\n/,
        );
        expect(text).toContain("    --ca-file= \\");
        expect(text).not.toMatch(insecure);
        manual = await setup();
        expect(manual).toContain("  --ca-file= \\");
        expect(manual).not.toContain("--ca-sha256");
        // Windows: PowerShell checks the file hash and runs setup; it makes
        // no web request, so it has no certificate check to skip.
        await f.page
          .getByRole("radio", { name: "Windows", exact: true })
          .check();
        await expect(
          f.page.locator(".enroll-command pre").first(),
        ).toContainText("--ca-file=");
        expect(await install()).not.toMatch(
          /Invoke-WebRequest|SkipCertificateCheck|ServerCertificateValidationCallback/,
        );
        expect(f.state.posts).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "A path no command can carry is refused by field name, and a plain apostrophe is quoted for PowerShell",
    async () => {
      const f = await fixture();
      try {
        await f.page.locator(".enroll-advanced > summary").click();
        await f.page.getByRole("radio", { name: /^Restricted/ }).check();
        await f.page
          .getByRole("radio", { name: "Windows", exact: true })
          .check();
        const stateDir = f.page.getByLabel("Agent state directory", {
          exact: true,
        });
        const managedConfig = f.page.getByLabel("Managed configuration file", {
          exact: true,
        });
        const create = f.page.getByRole("button", {
          name: /^Create (install|setup) command$/,
        });
        // Curly quotes close a string in PowerShell: refused, naming the field.
        for (const character of ["\u2018", "\u2019", "\u201A", "\u201B"]) {
          await stateDir.fill(`C:\\Owner${character}s`);
          await expect(stateDir).toHaveAttribute("aria-invalid", "true");
          await expect(f.page.locator("body")).toContainText(
            "Agent state directory can't contain curly quotes",
          );
          await expect(create).toBeDisabled();
        }
        // So are control characters and double quotes, in any path field.
        await stateDir.fill("C:\\Owner\u007fs");
        await expect(f.page.locator("body")).toContainText(
          "Agent state directory can't contain control characters.",
        );
        await expect(create).toBeDisabled();
        await managedConfig.fill('C:\\a"b\\vector.json');
        await expect(f.page.locator("body")).toContainText(
          "Managed configuration file can't contain a double quote.",
        );
        await managedConfig.fill("");
        expect(f.state.posts).toBe(0);
        // The plain apostrophe is a legal character: PowerShell gets it doubled.
        await stateDir.fill("C:\\Owner's Data");
        await expect(stateDir).not.toHaveAttribute("aria-invalid", "true");
        await expect(create).toBeEnabled();
        await create.click();
        // The request is made after the click returns, so wait for it before
        // reading the command the page then shows.
        await expect.poll(() => f.state.posts).toBe(1);
        await expect(
          f.page.locator(".enroll-command pre").first(),
        ).toContainText("--state-dir 'C:\\Owner''s Data'");
      } finally {
        await f.close();
      }
      // A POSIX shell doesn't read a curly quote as a quote: it stays legal.
      const g = await fixture();
      try {
        await g.page.locator(".enroll-advanced > summary").click();
        await g.page.getByRole("radio", { name: /^Restricted/ }).check();
        await g.page.getByRole("radio", { name: "Linux", exact: true }).check();
        const stateDir = g.page.getByLabel("Agent state directory", {
          exact: true,
        });
        await stateDir.fill("/srv/o\u2019s");
        await expect(stateDir).not.toHaveAttribute("aria-invalid", "true");
        await stateDir.fill("/srv/a\u007fb");
        await expect(stateDir).toHaveAttribute("aria-invalid", "true");
        await expect(g.page.locator("body")).toContainText(
          "Agent state directory can't contain control characters.",
        );
      } finally {
        await g.close();
      }
    },
  );
  await check(
    "The App page stays readable, bounded and accessible at tablet and phone widths in light and dark",
    async () => {
      for (const width of [899, 390])
        for (const theme of ["light", "dark"]) {
          const f = await fixture({ width, theme });
          try {
            await f.createCommand();
            const doc = await f.page.evaluate(() => ({
              width: innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
            }));
            expect(doc.scrollWidth).toBeLessThanOrEqual(doc.width + 1);
            geometry.push({ width, theme, document: doc });
            await audit(f.page, "install-command", width, theme);
            await capture(f.page, `${width}-${theme}`);
            expect(f.state.posts).toBe(1);
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
          "Actual App Add device route with fully isolated synthetic HTTP. No real token/device, installer run, certificate read, native execution, preview account or fleet mutation.",
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
