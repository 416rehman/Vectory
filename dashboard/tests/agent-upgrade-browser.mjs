// Actual App/device page. Every API response is synthetic; no real device or mutation.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { nothingOffered } from "./fleet-replies.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_AGENT_UPGRADE_OUTPUT || ".local/agent-upgrade",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:agent-upgrade";
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "agent-upgrade-fixture",
      resolveId(id) {
        if (id === "virtual:agent-upgrade") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (
            request.url ===
            "/api/v1/releases/vectory-0.1.0-dev-windows-amd64.exe"
          ) {
            requests.push({
              method: request.method,
              path: request.url.slice(7),
              query: "",
            });
            response.setHeader("Content-Type", "application/octet-stream");
            response.setHeader(
              "Content-Disposition",
              'attachment; filename="vectory.exe"',
            );
            response.end("Synthetic download bytes");
            return;
          }
          if (request.url.split("?")[0] !== "/__agent-upgrade") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic device assignment check</title></head><body><div id="root"></div><script type="module">import "virtual:agent-upgrade";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const configurationAssignmentId = "abcdef12-abcd-4123-8123-abcdef123456";
const policyAssignmentId = id(82);
const created = "2026-09-27T12:00:00Z";
const config = {
  sources: { seed: { type: "demo_logs", format: "json" } },
  sinks: { discard: { type: "blackhole", inputs: ["seed"] } },
};
const pipeline = {
  id: id(10),
  name: "Synthetic device pipeline",
  description: "Isolated browser fixture",
  revision: 1,
  config,
  graph: { nodes: [], edges: [] },
  created_at: created,
  updated_at: created,
  archived: false,
};
const version = {
  id: id(11),
  configuration_id: pipeline.id,
  number: 3,
  config,
  graph: pipeline.graph,
  sha256: "a".repeat(64),
  size: JSON.stringify(config).length,
  artifact: JSON.stringify(config),
  created_at: created,
  message: "Synthetic version",
};
const baseDevice = () => ({
  id: id(1),
  name: "Synthetic edge",
  os: "linux",
  arch: "amd64",
  agent_version: "synthetic",
  vector_version: "0.58.0",
  configuration_mode: "full",
  created_at: created,
  last_seen: new Date().toISOString(),
  status: "verified",
  apply_state: "verified_applied",
  desired_generation: 5,
  reported_generation: 5,
  desired_version_id: version.id,
  labels: {},
  sync_paused: false,
  local_paused: false,
  pause_acknowledged: false,
  assignment: {
    id: configurationAssignmentId.toUpperCase(),
    priority: 75,
    reason: "Current configuration winner",
  },
  policy_assignment: {
    id: policyAssignmentId,
    priority: 250,
    reason: "Current independent policy winner",
  },
  effective_policy: {
    heartbeat_seconds: 120,
    sync_paused: false,
    telemetry_enabled: false,
  },
});
const results = [],
  requests = [],
  errors = [],
  unexpected = [],
  accessibility = [],
  geometry = [],
  screenshots = [];
let context, page, state, failure;
async function load({
  device = {
    ...baseDevice(),
    os: "windows",
    arch: "amd64",
    agent_version: "0.1.0-dev",
  },
  releases = [release],
  releaseError = false,
  holdReleases = false,
  role = "viewer",
  width = 899,
  theme = "light",
  path = `devices/${id(1)}`,
} = {}) {
  if (context) await context.close();
  state = {
    device,
    releases,
    releaseError,
    holdReleases,
    releaseWaiters: [],
    reads: 0,
    holdNext: false,
    failNext: false,
    holds: [],
  };
  const current = state;
  context = await browser.newContext({
    viewport: { width, height: 960 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
    localStorage.setItem("vectory-sidebar-collapsed", "true");
  }, theme);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    if (url.origin !== origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7);
    requests.push({ method, path, query: url.search });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: id(99),
            email: "viewer@example.test",
            name: "Synthetic reviewer",
            role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic device context" });
      if (path === `/devices/${id(1)}`) {
        current.reads++;
        const snapshot = structuredClone(current.device);
        if (current.failNext) {
          current.failNext = false;
          return reply(
            {
              error: {
                code: "UNAVAILABLE",
                message: "Synthetic device refresh failed",
              },
            },
            503,
          );
        }
        if (current.holdNext) {
          current.holdNext = false;
          await new Promise((done) => current.holds.push(done));
        }
        return reply(snapshot);
      }
      if (path === "/agent-install") {
        if (current.holdReleases)
          await new Promise((done) => current.releaseWaiters.push(done));
        if (current.releaseError)
          return reply(
            {
              error: {
                code: "UNAVAILABLE",
                message: "Synthetic catalog unavailable",
              },
            },
            503,
          );
        return reply(installFor(current.releases));
      }
      if (path.startsWith("/releases/"))
        return route.fulfill({
          status: 200,
          body: "Synthetic download bytes",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="vectory.exe"',
          },
        });
      if (path === "/devices") return reply([current.device]);
      if (path === "/groups") return reply([]);
      if (path === `/versions/${version.id}`) return reply(version);
      if (path === `/configurations/${pipeline.id}`) return reply(pipeline);
      if (path === "/configurations/library")
        return reply({ items: [], total: 0, page: 1, page_size: 12 });
      if (path === "/deployments/history")
        return reply({
          items: [],
          total: 0,
          page: Number(url.searchParams.get("page") || 1),
          page_size: 12,
        });
      const detail = path.match(/^\/deployments\/([^/]+)\/(summary|targets)$/);
      if (detail) {
        if (detail[2] === "targets")
          return reply({ items: [], total: 0, page: 1, page_size: 12 });
        const isPolicy = detail[1] === policyAssignmentId;
        return reply({
          id: detail[1],
          name: isPolicy
            ? "Synthetic governing settings"
            : "Synthetic governing pipeline",
          configuration_id: isPolicy ? null : pipeline.id,
          configuration_name: isPolicy ? null : pipeline.name,
          version_id: isPolicy ? null : version.id,
          version_number: isPolicy ? null : 3,
          policy: isPolicy ? current.device.effective_policy : null,
          priority: isPolicy ? 250 : 75,
          target_mode: "snapshot",
          status: "completed",
          scheduled_at: null,
          created_at: created,
          rollout: { kind: "all" },
          target_count: 1,
          verified_count: 1,
          state_counts: { verified_applied: 1 },
        });
      }
      // The device page also shows telemetry, open issues and recent activity.
      if (path === `/devices/${id(1)}/telemetry`)
        return reply({ device_id: id(1), samples: [] });
      if (path === `/devices/${id(1)}/configuration`)
        return reply(nothingOffered(id(1)));
      if (path === "/issues/history" || path === "/audit/history")
        return reply({
          items: [],
          total: 0,
          page: 1,
          page_size: Number(url.searchParams.get("page_size") || 12),
        });
    }
    unexpected.push(`${method} ${path}`);
    return reply(
      {
        error: { code: "UNEXPECTED", message: "Unexpected synthetic request" },
      },
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/__agent-upgrade#/${path}`);
}
const settings = () =>
  page.getByRole("region", { name: "Agent settings", exact: true });
const pipelineLink = () =>
  page.getByRole("link", { name: "View pipeline assignment", exact: true });
const settingsLink = () =>
  page.getByRole("link", { name: "View settings assignment", exact: true });
const deviceVisible = () =>
  expect(
    page.getByRole("heading", { name: "Synthetic edge", exact: true }),
  ).toBeVisible();
async function check(name, run) {
  const start = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - start });
  console.log("PASS", name);
}
const release = {
  name: "vectory-0.1.0-dev-windows-amd64.exe",
  os: "windows",
  arch: "amd64",
  version: "0.1.0-dev",
  sha256: "a".repeat(64),
  size: 7000000,
  url: "/api/v1/releases/vectory-0.1.0-dev-windows-amd64.exe",
  signed: false,
};
const linuxRelease = {
  name: "vectory-0.2.0-linux-amd64",
  os: "linux",
  arch: "amd64",
  version: "0.2.0",
  sha256: "975c1a33" + "5".repeat(50) + "0e9d19",
  size: 7000000,
  url: "/api/v1/releases/vectory-0.2.0-linux-amd64",
  signed: false,
  source: "bundled",
};
// A synthetic certificate: only its PEM shape matters here.
const caPem = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBszCCAVmgAwIBAgIUU3ludGhldGljIGFnZW50IENBIGZvciB0ZXN0cy4wCgYI",
  "-----END CERTIFICATE-----",
  "",
].join("\n");
const installerSha = "c0f4e1b7" + "1".repeat(50) + "9d19ab";
// What Add device and Upgrade agent read: the installer, the server's CA and
// the builds, as the server reports them.
const installFor = (releases) => ({
  agent_url: "https://vectory.example.test:8443",
  agent_url_configured: false,
  listener_enabled: true,
  dashboard_url: "https://vectory.example.test",
  certificate: {
    available: true,
    publicly_trusted: false,
    ca_sha256: "1f3c" + "0".repeat(56) + "9ab0",
    ca_pem: caPem,
    problem: null,
  },
  downloads_enabled: true,
  installer: {
    url: "https://vectory.example.test:8443/agent/v1/install.sh",
    sha256: installerSha,
    platforms: ["linux/amd64"],
  },
  default_install_dir: "/usr/local/bin",
  releases,
  catalog_problems: [],
});
const linuxDevice = (extra = {}) => ({
  ...baseDevice(),
  agent_version: "0.1.0",
  state_dir: "/var/lib/vectory-agent",
  service_manager: "systemd",
  ...extra,
});
const upgradeCommandText = [
  `printf '%s\\n' '${caPem.trimEnd()}' > vectory-ca.pem &&`,
  "curl -fsSL --cacert vectory-ca.pem \\",
  "  -o vectory-install.sh \\",
  "  https://vectory.example.test:8443/agent/v1/install.sh &&",
  `echo '${installerSha}  vectory-install.sh' \\`,
  "  | sha256sum -c - &&",
  "sudo sh vectory-install.sh",
].join("\n");
const dialog = () =>
  page.getByRole("dialog", { name: "Upgrade agent", exact: true });
const download = () =>
  dialog().getByRole("link", { name: "Download", exact: true });
const openGuide = async () => {
  await deviceVisible();
  await page
    .getByRole("button", { name: "Upgrade agent", exact: true })
    .click();
  await expect(dialog()).toBeVisible();
};
try {
  await check(
    "Existing device upgrade is read-only, exact-platform and explicit about reused versions",
    async () => {
      for (const role of ["viewer", "admin"]) {
        await load({ role });
        await openGuide();
        await expect(dialog()).toContainText("Last reported agent");
        await expect(dialog()).toContainText("Available download · 0.1.0-dev");
        await expect(dialog()).toContainText("Unsigned development build");
        await expect(dialog()).toContainText(
          "Development builds can share a version label",
        );
        await expect(download()).toHaveAttribute("href", release.url);
        await expect(download()).toHaveAttribute("download", "vectory.exe");
        await expect(dialog()).toContainText("Stopping the agent also stops");
        await expect(dialog()).toContainText("Do not re-enroll or purge state");
        const help = dialog().getByRole("link", {
          name: /Full upgrade instructions/,
        });
        await expect(help).toHaveAttribute(
          "href",
          "/help/installation/#upgrade-an-existing-agent",
        );
        await expect(help).toHaveAttribute("target", "_blank");
        await expect(help).toHaveAttribute("rel", "noopener noreferrer");
        expect(requests.filter((r) => r.path === release.url.slice(7))).toEqual(
          [],
        );
        await page.keyboard.press("Escape");
        await expect(dialog()).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Upgrade agent", exact: true }),
        ).toBeFocused();
      }
    },
  );
  const commandBlock = () =>
    dialog().getByLabel("Upgrade command", { exact: true });
  const commandText = () => commandBlock().evaluate((el) => el.textContent);
  await check(
    "A Linux device gets the one installer command, with no token, and the manual steps behind By hand",
    async () => {
      await load({
        device: linuxDevice(),
        releases: [release, linuxRelease],
        role: "admin",
      });
      await openGuide();
      await expect(
        dialog().getByRole("region", {
          name: "Run this on Synthetic edge",
          exact: true,
        }),
      ).toBeVisible();
      expect(await commandText()).toBe(upgradeCommandText);
      expect(await commandText()).not.toMatch(
        /(^|\s)-[A-Za-z]*k[A-Za-z]*(\s|$)|--insecure|--no-check-certificate|token/,
      );
      await expect(dialog()).toContainText(
        "Synthetic edge's agent doesn't report which build it runs",
      );
      await expect(dialog()).toContainText("The agent goes to /usr/local/bin.");
      // The manual procedure is there, folded away.
      await expect(download()).toBeHidden();
      await dialog().getByText("By hand", { exact: true }).click();
      await expect(download()).toBeVisible();
      await expect(download()).toHaveAttribute("href", linuxRelease.url);
      await expect(download()).toHaveAttribute("download", "vectory");
      await expect(dialog()).toContainText("Do not re-enroll or purge state");
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (value) => {
              window.syntheticCopied = value;
            },
          },
        }),
      );
      await dialog()
        .getByRole("button", { name: "Copy upgrade command", exact: true })
        .click();
      expect(await page.evaluate(() => window.syntheticCopied)).toBe(
        upgradeCommandText,
      );
    },
  );
  await check(
    "A device that reports this build is told so and gets no command",
    async () => {
      await load({
        device: linuxDevice({ agent_sha256: linuxRelease.sha256 }),
        releases: [linuxRelease],
      });
      await openGuide();
      await expect(
        dialog().getByText(
          "Synthetic edge already runs this build (SHA-256 975c1a33…0e9d19).",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(commandBlock()).toHaveCount(0);
      await expect(download()).toHaveCount(0);
    },
  );
  await check(
    "A host without a service stays that way, with its own state directory",
    async () => {
      await load({
        device: linuxDevice({
          state_dir: "/srv/vectory state",
          service_manager: "none",
          agent_sha256: "b".repeat(64),
        }),
        releases: [linuxRelease],
      });
      await openGuide();
      expect(await commandText()).toBe(
        upgradeCommandText.replace(
          "sudo sh vectory-install.sh",
          "sudo sh vectory-install.sh \\\n  --state-dir '/srv/vectory state' \\\n  --service none",
        ),
      );
      await expect(dialog()).toContainText(
        "Synthetic edge runs another build (SHA-256 bbbbbbbb…bbbbbb); this server offers 0.2.0 (SHA-256 975c1a33…0e9d19).",
      );
      // Commands and flags are code that never breaks at a hyphen.
      const note = dialog().getByText(/^Nothing restarts/);
      await expect(note).toHaveText(
        "Nothing restarts vectory run for you: setup says when to stop it and start it again on the new build.",
      );
      await expect(note.locator("code")).toHaveText("vectory run");
      await expect(
        dialog().locator(".agent-upgrade-notes code", {
          hasText: "--install-dir",
        }),
      ).toHaveCSS("white-space", "nowrap");
    },
  );
  await check(
    "The upgrade command fits phones and both themes without widening the page",
    async () => {
      for (const width of [320, 390, 430])
        for (const theme of ["light", "dark"]) {
          await load({
            device: linuxDevice(),
            releases: [linuxRelease],
            width,
            theme,
          });
          await deviceVisible();
          // The device page underneath is measured first: the dialog must
          // not widen the page beyond it.
          const under = await page.evaluate(
            () => document.documentElement.scrollWidth,
          );
          await openGuide();
          await expect(commandBlock()).toBeVisible();
          const metrics = await dialog().evaluate((el) => ({
            width: el.getBoundingClientRect().width,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            page: document.documentElement.scrollWidth,
            viewport: innerWidth,
            // The command scrolls inside its own block.
            command: (() => {
              const pre = el.querySelector(".agent-upgrade-command pre");
              return {
                right: pre.getBoundingClientRect().right,
                scrolls: pre.scrollWidth > pre.clientWidth,
              };
            })(),
          }));
          expect(metrics.width).toBeLessThanOrEqual(width);
          expect(metrics.scrollWidth).toBeLessThanOrEqual(
            metrics.clientWidth + 1,
          );
          expect(metrics.command.right).toBeLessThanOrEqual(width);
          expect(metrics.page).toBeLessThanOrEqual(under);
          geometry.push({ command: true, width, theme, under, ...metrics });
          const audit = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          accessibility.push({
            command: true,
            width,
            theme,
            violations: audit.violations.map(({ id, impact }) => ({
              id,
              impact,
            })),
          });
          expect(audit.violations).toEqual([]);
          const file = `agent-upgrade-command-${width}-${theme}.png`;
          await page.screenshot({
            path: resolve(output, file),
            fullPage: true,
            animations: "disabled",
          });
          screenshots.push(relative(repository, resolve(output, file)));
        }
    },
  );
  await check(
    "Unsupported, missing, ambiguous and unsafe artifact metadata never expose a download",
    async () => {
      for (const item of [
        {
          device: { ...baseDevice(), os: "windows", arch: "arm64" },
          releases: [release],
          text: "No agent download",
        },
        {
          device: { ...baseDevice(), os: "darwin", arch: "amd64" },
          releases: [{ ...release, os: "darwin" }],
          text: "Intel Mac",
        },
        {
          releases: [release, { ...release, sha256: "b".repeat(64) }],
          text: "Several downloads",
        },
        {
          releases: [{ ...release, url: "https://example.test/agent.exe" }],
          text: "metadata is incomplete or invalid",
        },
        {
          releases: [{ ...release, size: undefined }],
          text: "metadata is incomplete or invalid",
        },
      ]) {
        await load(item);
        await openGuide();
        await expect(dialog()).toContainText(item.text);
        await expect(download()).toHaveCount(0);
      }
    },
  );
  await check(
    "Catalog errors retry explicitly; closing a stalled query suppresses late results",
    async () => {
      await load({ releaseError: true });
      await openGuide();
      await expect(dialog()).toContainText("Synthetic catalog unavailable");
      state.releaseError = false;
      await dialog()
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(download()).toBeVisible();
      await page.keyboard.press("Escape");
      state.holdReleases = true;
      await openGuide();
      await expect.poll(() => state.releaseWaiters.length).toBe(1);
      await page.keyboard.press("Escape");
      state.releases = [];
      state.holdReleases = false;
      state.releaseWaiters.splice(0).forEach((fn) => fn());
      await openGuide();
      await expect(dialog()).toContainText("No agent download");
      await expect(download()).toHaveCount(0);
    },
  );
  await check(
    "A stalled catalog has a deadline and does not request a download",
    async () => {
      await load({ holdReleases: true });
      // Pages load on demand behind a 30 s guard of their own; let this one
      // finish before every 30 s timer is shortened.
      await deviceVisible();
      await page.evaluate(() => {
        const original = window.setTimeout.bind(window);
        window.setTimeout = (fn, delay, ...args) =>
          original(fn, delay === 30000 ? 80 : delay, ...args);
      });
      await openGuide();
      await expect(dialog().getByRole("alert")).toContainText(
        "taking too long",
      );
      await expect(download()).toHaveCount(0);
      state.releaseWaiters.splice(0).forEach((fn) => fn());
    },
  );
  await check(
    "Checksum copy failure stays readable; downloading requests only the selected artifact",
    async () => {
      await load();
      await openGuide();
      await expect(download()).toBeVisible();
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async () => {
              throw Error("Synthetic denied");
            },
          },
        }),
      );
      await dialog()
        .getByRole("button", { name: "Copy checksum", exact: true })
        .click();
      await expect(dialog()).toContainText("Select the checksum above");
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (value) => {
              window.syntheticCopied = value;
            },
          },
        }),
      );
      await dialog()
        .getByRole("button", { name: "Copy checksum", exact: true })
        .click();
      await expect(dialog()).toContainText("Checksum copied.");
      expect(await page.evaluate(() => window.syntheticCopied)).toBe(
        release.sha256,
      );
      const downloaded = page.waitForEvent("download");
      await download().click();
      const artifact = await downloaded;
      expect(artifact.suggestedFilename()).toBe("vectory.exe");
      expect(await artifact.failure()).toBeNull();
      const artifactPath = resolve(output, "synthetic-agent-download.txt");
      await artifact.saveAs(artifactPath);
      expect(await readFile(artifactPath, "utf8")).toBe(
        "Synthetic download bytes",
      );
      expect(
        requests.filter((r) => r.path === release.url.slice(7)),
      ).toHaveLength(1);
      await expect(dialog()).not.toContainText("Upgrade complete");
    },
  );
  await check(
    "Upgrade instructions remain readable and keyboard accessible at 899 and 375 in both themes",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await load({ width, theme });
          await openGuide();
          await expect(download()).toBeVisible();
          const metrics = await dialog().evaluate((el) => ({
            width: el.getBoundingClientRect().width,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            viewport: innerWidth,
          }));
          expect(metrics.width).toBeLessThanOrEqual(width);
          expect(metrics.scrollWidth).toBeLessThanOrEqual(
            metrics.clientWidth + 1,
          );
          geometry.push({ width, theme, ...metrics });
          const audit = await new AxeBuilder({ page })
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
          const file = `agent-upgrade-${width}-${theme}.png`;
          await page.screenshot({
            path: resolve(output, file),
            fullPage: true,
            animations: "disabled",
          });
          screenshots.push(relative(repository, resolve(output, file)));
          await dialog()
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(
            page.getByRole("button", { name: "Upgrade agent", exact: true }),
          ).toBeFocused();
        }
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
} catch (error) {
  failure = error;
} finally {
  for (const done of [
    ...(state?.holds || []),
    ...(state?.releaseWaiters || []),
  ])
    done();
  await context?.close();
  await browser.close();
  await vite.close();
  const source_sha256 = {};
  for (const file of [
    "dashboard/src/AgentUpgrade.tsx",
    "dashboard/src/agentUpgradeModel.ts",
    "dashboard/src/agent-upgrade.css",
    "dashboard/src/Fleet.tsx",
    "dashboard/src/api.ts",
    "dashboard/src/ui.tsx",
    "dashboard/tests/agent-upgrade-browser.mjs",
    "docs/user/installation.md",
  ])
    source_sha256[file] = createHash("sha256")
      .update(await readFile(resolve(repository, file)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        passed: !failure,
        scope:
          "Actual App/Fleet upgrade guide with isolated synthetic transport; only GET requests. No real artifact execution, live devices, preview credentials or service changes. Native package upgrade is a separate evidence scope.",
        results,
        requests,
        unexpected,
        errors,
        accessibility,
        geometry,
        screenshots,
        source_sha256,
        failure: failure ? String(failure.stack || failure) : undefined,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: results.length,
    evidence: relative(repository, resolve(output, "report.json")),
  }),
);
