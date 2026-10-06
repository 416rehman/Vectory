// Actual Add device page with disposable synthetic transport; no real tokens,
// devices or installs. The enrollment activity and inventory are scripted.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { updatesOff } from "./agent-update-replies.mjs";
import { chooseMode, modeTrigger } from "./enrollment-mode.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

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
    // A fixed port when the caller reserves one (VECTORY_HARNESS_PORT).
    port: Number(process.env.VECTORY_HARNESS_PORT) || 0,
    strictPort: !!process.env.VECTORY_HARNESS_PORT,
    proxy: {},
    hmr: false,
  },
  plugins: [
    {
      name: "synthetic-enrollment-fixture",
      // `proxy: {}` merges into vite.config.ts's /api proxy instead of
      // replacing it; drop it so no request can leave the fixture.
      config(config) {
        delete config.server.proxy;
      },
      resolveId(id) {
        if (id === "virtual:enrollment-fixture") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {Enrollment} from '/src/Enrollment.tsx';import {setCSRF} from '/src/api.ts';import '/src/styles.css';setCSRF('synthetic');const root=createRoot(document.getElementById('root'));window.mountEnrollment=(role='admin')=>root.render(React.createElement(Enrollment,{key:Math.random(),user:{id:'synthetic-admin',name:'Synthetic admin',email:'admin@example.test',role,enabled:true,revision:1},notify:message=>(window.notices=[...(window.notices||[]),message]),navigate:path=>window.lastNavigation=path}));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__enrollment-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              "/__enrollment-fixture",
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Add device verification</title></head><body><main style="padding:24px 16px"><div id="root"></div></main><script type="module">import "virtual:enrollment-fixture";</script></body></html>',
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
const iso = (offset = 0) =>
  new Date(serverTime + offset).toISOString().replace(/\.\d+Z$/, "Z");
const tokenId = "8b64e164-3e33-4574-b8f9-829d7b77c2b7";
const secret = "synthetic-unused-enrollment-secret-0123456789abcdef";
const pin = "1f3c" + "0".repeat(56) + "9ab0";
// A synthetic CA certificate: only its PEM shape matters here.
const caPem = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBszCCAVmgAwIBAgIUU3ludGhldGljIGFnZW50IENBIGZvciB0ZXN0cy4wCgYI",
  "U3ludGhldGljU3ludGhldGljU3ludGhldGlj==",
  "-----END CERTIFICATE-----",
  "",
].join("\n");
const installerSha = "c0f4e1b7" + "1".repeat(50) + "9d19ab";
const windowsSha = "e".repeat(64);
const deviceId = "5e7a9c2d-0000-4000-8000-000000000001";
const release = (os, arch, sha, source = "bundled") => ({
  name: `vectory-0.1.0-dev-${os}-${arch}${os === "windows" ? ".exe" : ""}`,
  os,
  arch,
  version: "0.1.0-dev",
  sha256: sha,
  size: 7_626_878,
  url: `/api/v1/releases/vectory-0.1.0-dev-${os}-${arch}${os === "windows" ? ".exe" : ""}`,
  signed: false,
  source,
});
const agentInstall = (overrides = {}) => ({
  agent_url: "https://vectory.example.test:8443",
  agent_url_configured: true,
  listener_enabled: true,
  dashboard_url: "https://vectory.example.test",
  certificate: {
    available: true,
    publicly_trusted: false,
    ca_sha256: pin,
    ca_fingerprint: null,
    ca_pem: caPem,
    ca_name: "Synthetic agent CA",
    ca_issuer: "Synthetic agent CA",
    ca_not_after: iso(86400000 * 30),
    problem: null,
  },
  downloads_enabled: true,
  installer: {
    url: "https://vectory.example.test:8443/agent/v1/install.sh",
    sha256: installerSha,
    platforms: ["linux/amd64", "linux/arm64", "darwin/arm64"],
  },
  default_install_dir: "/usr/local/bin",
  releases: [
    release("linux", "amd64", "a".repeat(64)),
    release("linux", "arm64", "b".repeat(64), "mirror"),
    release("darwin", "arm64", "c".repeat(64)),
    release("windows", "amd64", windowsSha),
  ],
  catalog_problems: [],
  ...overrides,
});
const device = (overrides = {}) => ({
  id: deviceId,
  name: "edge-01",
  os: "linux",
  arch: "amd64",
  agent_version: "0.1.0-dev",
  vector_version: "0.58.0",
  status: "online",
  created_at: iso(1000),
  last_seen: null,
  configuration_mode: "restricted",
  labels: {},
  desired_generation: 0,
  reported_generation: 0,
  apply_state: "unmanaged",
  sync_paused: false,
  pause_acknowledged: false,
  ...overrides,
});
const event = (overrides = {}) => ({
  id: `event-${Math.random()}`,
  created_at: iso(500),
  outcome: "failure",
  reason_code: null,
  device_id: null,
  device_name: "edge-01",
  token_id: tokenId,
  agent_os: "linux",
  agent_arch: "amd64",
  agent_version: "0.1.0-dev",
  configuration_mode: "restricted",
  client_address: "10.0.4.17",
  ...overrides,
});

/** A token request saved by an earlier visit, as the page stores it. */
const savedRequest = (id, overrides = {}) => ({
  actor_id: "synthetic-admin",
  id,
  recorded_at: iso(-120000),
  request: {
    name: "lab-full install command",
    expires_hours: 1,
    max_uses: 1,
    name_prefix: null,
    request_id: id,
  },
  ...overrides,
});
const requestKey = (id) =>
  `vectory:enrollment-token-request:synthetic-admin:${id}`;

async function fixture({
  initial = [],
  failDevices = false,
  activityUnavailable = false,
  width = 1280,
  theme = "light",
  install = agentInstall(),
  role = "admin",
  tokens = [],
  platform = "Linux",
  saved = [],
  statuses = {},
  tokenExpiryMs,
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
  });
  await context.addInitScript((value) => {
    Object.defineProperty(navigator, "userAgentData", {
      get: () => ({ platform: value }),
    });
  }, platform);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const state = {
    devices: initial,
    failDevices,
    activityUnavailable,
    tokens,
    events: [],
    install,
    installReplies: 0,
    posts: 0,
    holdToken: false,
    releaseToken: null,
    tokenRequest: null,
    activity: [],
    // A whole-fleet read is a regression; typed-name checks are bounded.
    lists: 0,
    nameLookups: [],
    deviceReads: [],
    revokes: [],
    statuses,
    lookups: [],
    cancels: [],
    tokenReads: 0,
    failTokens: false,
    tokenExpiryMs,
  };
  await context.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1", "");
    const method = route.request().method();
    const reply = async (json, status = 200) => {
      try {
        await route.fulfill({ status, json });
      } catch {
        /* The page was closed while this read was pending. */
      }
    };
    if (path === "/devices/inventory") {
      state.nameLookups.push({
        q: url.searchParams.get("q"),
        pageSize: url.searchParams.get("page_size"),
        status: url.searchParams.get("status"),
      });
      const query = (url.searchParams.get("q") || "").toLowerCase();
      const revoked = url.searchParams.get("status") === "revoked";
      const matched = state.devices.filter(
        (candidate) =>
          (candidate.status === "revoked") === revoked &&
          candidate.name.toLowerCase().includes(query),
      );
      const counts = {
        status: Object.fromEntries(
          [
            "applied",
            "degraded",
            "held",
            "updating",
            "check",
            "failed",
            "offline",
            "paused",
            "unmanaged",
            "revoked",
          ].map((name) => [name, 0]),
        ),
        views: Object.fromEntries(
          [
            "failing",
            "not_on_desired",
            "offline",
            "paused",
            "no_telemetry",
          ].map((name) => [name, 0]),
        ),
      };
      return state.failDevices
        ? reply(
            {
              error: {
                code: "UNAVAILABLE",
                message: "Synthetic inventory unavailable",
              },
            },
            503,
          )
        : reply({
            items: matched.slice(0, 100),
            total: matched.length,
            page: 1,
            page_size: 100,
            counts,
            device_groups: {},
          });
    }
    if (path === "/devices") {
      state.lists++;
      return reply(state.devices);
    }
    const single = path.match(/^\/devices\/([^/]+)$/);
    if (single && method === "GET") {
      // The watch reads the one device the activity feed names.
      const id = decodeURIComponent(single[1]);
      state.deviceReads.push(id);
      const found = state.devices.find((candidate) => candidate.id === id);
      return found
        ? reply(found)
        : reply({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    }
    // Agent updates are off here, so the page is what it was without them.
    if (path === "/agent-updates") return reply(updatesOff());
    if (path === "/agent-install") {
      await reply(state.install);
      state.installReplies++;
      return;
    }
    if (path === "/agent-install/activity") {
      if (state.activityUnavailable)
        return reply(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          404,
        );
      state.activity.push({
        at: Date.now(),
        since: url.searchParams.get("since"),
      });
      return reply({ events: state.events, now: iso() });
    }
    if (path === "/tokens" && method === "GET") {
      state.tokenReads++;
      return state.failTokens
        ? reply(
            {
              error: {
                code: "UNAVAILABLE",
                message: "Synthetic token inventory unavailable",
              },
            },
            503,
          )
        : reply(state.tokens);
    }
    if (path.startsWith("/tokens/requests/") && method === "GET") {
      const id = path.split("/").at(-1);
      state.lookups.push(id);
      // A list of answers is used in order, the last one from then on.
      let answer = state.statuses[id];
      if (Array.isArray(answer))
        answer = answer.length > 1 ? answer.shift() : answer[0];
      if (answer === "fail")
        return reply(
          {
            error: {
              code: "UNAVAILABLE",
              message: "Synthetic status unavailable",
            },
          },
          503,
        );
      return reply(
        answer || {
          request_id: id,
          request_correlation: true,
          found: false,
        },
      );
    }
    if (
      path.startsWith("/tokens/requests/") &&
      path.endsWith("/cancel") &&
      method === "POST"
    ) {
      const id = path.split("/").at(-2);
      state.cancels.push(id);
      return reply({
        request_id: id,
        request_correlation: true,
        found: true,
        state: "cancelled",
        record: null,
      });
    }
    if (path.endsWith("/revoke") && method === "POST") {
      const id = path.split("/")[2];
      state.revokes.push(id);
      state.tokens = state.tokens.map((token) =>
        token.id === id ? { ...token, revoked: true } : token,
      );
      return reply({ ok: true });
    }
    if (path === "/tokens" && method === "POST") {
      state.posts++;
      state.tokenRequest = route.request().postDataJSON();
      if (state.holdToken)
        await new Promise((resolve) => {
          state.releaseToken = resolve;
        });
      const record = {
        // The first command's token is `tokenId`; later ones are new tokens.
        id: state.posts === 1 ? tokenId : randomUUID(),
        name: state.tokenRequest.name,
        created_at: iso(),
        expires_at:
          state.tokenExpiryMs === undefined
            ? iso(state.tokenRequest.expires_hours * 3600000)
            : new Date(Date.now() + state.tokenExpiryMs).toISOString(),
        uses: 0,
        max_uses: state.tokenRequest.max_uses,
        name_prefix: state.tokenRequest.name_prefix,
        revoked: false,
      };
      state.tokens = [record, ...state.tokens];
      return reply({
        request_id: state.tokenRequest.request_id,
        request_correlation: true,
        token: secret,
        record,
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
  await page.goto(`${origin}/__enrollment-fixture`);
  // Reminders an earlier visit left in this browser, before the page reads them.
  await page.evaluate(
    (records) => {
      for (const [key, value] of records) localStorage.setItem(key, value);
    },
    saved.map((request) => [requestKey(request.id), JSON.stringify(request)]),
  );
  const mount = async () => {
    await page.waitForFunction(
      () => typeof window.mountEnrollment === "function",
    );
    await page.evaluate(
      ({ value, role }) => {
        document.documentElement.dataset.theme = value;
        window.mountEnrollment(role);
      },
      { value: theme, role },
    );
  };
  await mount();
  /**
   * Leave (accepting "Leave site?"), let `meanwhile` change the synthetic
   * server while no page watches, and come back to Add device.
   */
  const reload = async (meanwhile = () => {}) => {
    const leave = (dialog) => void dialog.accept();
    page.on("dialog", leave);
    await page.reload();
    page.off("dialog", leave);
    meanwhile();
    await mount();
  };
  const stored = () =>
    page.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith("vectory:enrollment-token-request:"))
        .map((key) => JSON.parse(localStorage.getItem(key))),
    );
  const create = page.getByRole("button", {
    name: "Create install command",
    exact: true,
  });
  const command = page.getByRole("region", { name: "Install command" });
  const selectMode = (label = "Restricted") => chooseMode(page, label);
  const advanced = () => page.locator(".enroll-advanced > summary").click();
  const createCommand = async (mode = "Restricted") => {
    await selectMode(mode);
    await create.click();
    await expect(page.locator(".enroll-command pre").first()).toBeVisible();
  };
  return {
    context,
    page,
    state,
    create,
    command,
    chooseMode: selectMode,
    advanced,
    createCommand,
    reload,
    stored,
  };
}
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
  console.log("PASS", name);
}
const commandText = async (page) => {
  const readable = page.getByRole("button", { name: "Readable", exact: true });
  if (await readable.isVisible()) await readable.click();
  return page.locator(".enroll-command pre").first().innerText();
};

try {
  await check(
    "a mode choice is required, and the command carries the checksum, pin and choices but never the token",
    async () => {
      const f = await fixture();
      try {
        await expect(f.create).toBeDisabled();
        await expect(modeTrigger(f.page)).toContainText("Choose a mode");
        await modeTrigger(f.page).click();
        await expect(
          f.page.getByRole("menuitemradio", { name: "Restricted" }),
        ).toContainText("Files, destinations and listeners must be approved");
        await expect(
          f.page.getByRole("menuitemradio", { name: "Full Vector" }),
        ).toContainText("get Vector's permissions on this host");
        await f.page.keyboard.press("Escape");
        await expect(f.page.getByRole("status").first()).toContainText(
          "Choose Restricted or Full Vector first.",
        );
        expect(f.state.posts).toBe(0);
        await f.createCommand();
        expect(f.state.posts).toBe(1);
        expect(f.state.tokenRequest.max_uses).toBe(1);
        expect(f.state.tokenRequest.expires_hours).toBe(1);
        const text = await commandText(f.page);
        // The download is verified against the server's CA; nothing turns a
        // certificate check off.
        expect(text).toBe(
          [
            "(",
            "  set -e",
            "  taskTempRoot=${TMPDIR:-/tmp}",
            `  case "$taskTempRoot" in /*) ;; *) echo 'TMPDIR must be an absolute directory.' >&2; exit 1 ;; esac`,
            '  dir=$(mktemp -d "${taskTempRoot%/}/vectory.XXXXXXXXXX")',
            `  trap 'rm -rf "$dir"' EXIT`,
            `  printf '%s\\n' '${caPem.trimEnd()}' > "$dir/vectory-ca.pem"`,
            `  curl -fsSL --proto '=https' --proto-redir '=https' \\`,
            `    --cacert "$dir/vectory-ca.pem" \\`,
            `    -o "$dir/vectory-install.sh" \\`,
            "    https://vectory.example.test:8443/agent/v1/install.sh",
            `  echo '${installerSha}  vectory-install.sh' \\`,
            `    | (cd "$dir" && sha256sum -c -)`,
            `  sudo sh "$dir/vectory-install.sh" \\`,
            "    --mode restricted \\",
            "    --create-user",
            ")",
          ].join("\n"),
        );
        expect(text).not.toMatch(/(^|\s)-[A-Za-z]*k[A-Za-z]*(\s|$)|--insecure/);
        await expect(f.page.locator("body")).not.toContainText(secret);
        await f.page.getByRole("button", { name: "Show", exact: true }).click();
        await expect(f.page.locator(".enroll-secret code")).toHaveText(secret);
        expect(await commandText(f.page)).not.toContain(secret);
        const receipt = f.page.getByRole("definition");
        await expect(receipt.nth(0)).toContainText("c0f4e1b7…9d19ab");
        // The whole pin, grouped for comparing by eye, never a 4-byte excerpt.
        await expect(receipt.nth(1)).toContainText("1F:3C:00:00:00:00:00:00");
        await expect(receipt.nth(1)).toContainText("00:00:00:00:00:00:9A:B0");
        await expect(receipt.nth(1)).not.toContainText("...");
        await expect(receipt.nth(1)).toContainText("Synthetic agent CA");
        await expect(receipt.nth(2)).toContainText("Works once");
        // The displayed command and the issued token describe one fixed host.
        await expect(modeTrigger(f.page)).toBeDisabled();
        await expect(
          f.page.getByRole("radio", { name: "macOS", exact: true }),
        ).toBeDisabled();
        await f.advanced();
        await expect(
          f.page.getByLabel("Device name", { exact: true }),
        ).toBeDisabled();
        await expect(
          f.page.getByLabel("Run the agent as a systemd service", {
            exact: true,
          }),
        ).toBeDisabled();
        expect(await commandText(f.page)).toBe(text);
        expect(f.state.posts).toBe(1);
        await f.page
          .getByRole("button", { name: "Copy token", exact: true })
          .click();
        await f.page
          .locator("summary")
          .filter({ hasText: "I already have the agent" })
          .click();
        await expect(
          f.page.locator(".enroll-command pre").nth(1),
        ).toContainText("--mode restricted");
        await expect(f.page.locator(".enroll-builds")).toContainText(
          "Operator mirror",
        );
      } finally {
        f.state.releaseToken?.();
        await f.context.close();
      }
    },
  );
  await check(
    "host choices are captured before issuing a device-bound token",
    async () => {
      const f = await fixture();
      try {
        await f.chooseMode("Full Vector");
        await f.advanced();
        await f.page.getByLabel("Device name", { exact: true }).fill("edge-42");
        await f.page
          .getByLabel("Run the agent as a systemd service", { exact: true })
          .uncheck();
        await f.create.click();
        await expect(
          f.page.locator(".enroll-command pre").first(),
        ).toBeVisible();
        expect(f.state.tokenRequest.device_name).toBe("edge-42");
        const issuedCommand = await commandText(f.page);
        expect(issuedCommand).toContain("--mode full");
        expect(issuedCommand).toContain("--name edge-42");
        expect(issuedCommand).toContain("--service none");
        await expect(
          f.page.getByLabel("Device name", { exact: true }),
        ).toBeDisabled();
        await f.page
          .locator("summary")
          .filter({ hasText: "I already have the agent" })
          .click();
        const manual = await f.page
          .locator(".enroll-command pre")
          .nth(1)
          .innerText();
        expect(manual).toContain("--mode full");
        expect(manual).toContain("--name edge-42");
        expect(manual).toContain("--service none");
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "an issued command and receipt stay fixed when server install metadata refreshes",
    async () => {
      const f = await fixture();
      try {
        await f.createCommand();
        const issuedCommand = await commandText(f.page);
        await f.page
          .locator("summary")
          .filter({ hasText: "I already have the agent" })
          .click();
        const manual = await f.page
          .locator(".enroll-command pre")
          .nth(1)
          .innerText();
        const receipt = await f.page.getByRole("definition").nth(1).innerText();
        const buildUrl = await f.page
          .locator(".enroll-builds a")
          .first()
          .getAttribute("href");
        await f.advanced();
        const trustDetails = await f.page.locator(".enroll-trust").innerText();
        const replies = f.state.installReplies;
        f.state.install = agentInstall({
          agent_url: "https://different.example.test:8443",
          certificate: {
            ...agentInstall().certificate,
            ca_sha256: "d".repeat(64),
            ca_pem: caPem.replace("MIIB", "MIIA"),
          },
          installer: {
            url: "https://different.example.test:8443/agent/v1/install.sh",
            sha256: "e".repeat(64),
            platforms: ["linux/amd64"],
          },
          releases: [release("linux", "amd64", "f".repeat(64))],
        });
        await expect
          .poll(() => f.state.installReplies, { timeout: 22000 })
          .toBeGreaterThan(replies);
        await f.page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        expect(await commandText(f.page)).toBe(issuedCommand);
        expect(
          await f.page.locator(".enroll-command pre").nth(1).innerText(),
        ).toBe(manual);
        expect(await f.page.getByRole("definition").nth(1).innerText()).toBe(
          receipt,
        );
        expect(
          await f.page.locator(".enroll-builds a").first().getAttribute("href"),
        ).toBe(buildUrl);
        expect(await f.page.locator(".enroll-trust").innerText()).toBe(
          trustDetails,
        );
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "a pending token request and its issued command keep host choices locked",
    async () => {
      const f = await fixture();
      try {
        await f.chooseMode();
        f.state.holdToken = true;
        await f.create.click();
        await expect.poll(() => f.state.posts).toBe(1);
        for (const label of ["Linux", "macOS", "Windows"])
          await expect(
            f.page.getByRole("radio", { name: label, exact: true }),
          ).toBeDisabled();
        await expect(modeTrigger(f.page)).toBeDisabled();
        f.state.releaseToken();
        f.state.releaseToken = null;
        await expect(
          f.page.locator(".enroll-command pre").first(),
        ).toBeVisible();
        await expect(
          f.page.getByRole("radio", { name: "macOS", exact: true }),
        ).toBeDisabled();
      } finally {
        f.state.releaseToken?.();
        await f.context.close();
      }
    },
  );
  await check(
    "at 1440 px no line of an issued command is cut off beside Copy, for any certificate choice",
    async () => {
      for (const [label, path] of [
        ["Pin this server's CA", ""],
        ["The host's trusted certificates", ""],
        ["A CA certificate file on the host", "/etc/vectory/server-ca.pem"],
      ]) {
        const f = await fixture({ width: 1440 });
        try {
          await f.chooseMode();
          await f.advanced();
          await f.page
            .getByRole("radio", { name: new RegExp("^" + label) })
            .check();
          if (path)
            await f.page
              .getByLabel("CA certificate on the host", { exact: true })
              .fill(path);
          await f.create.click();
          await expect(
            f.page.locator(".enroll-command pre").first(),
          ).toBeVisible();
          await commandText(f.page);
          const measured = await f.page
            .locator(".enroll-command")
            .first()
            .evaluate((block) => {
              const pre = block.querySelector("pre");
              const button = block.querySelector(".button");
              return {
                scrollWidth: pre.scrollWidth,
                clientWidth: pre.clientWidth,
                preRight: pre.getBoundingClientRect().right,
                copyLeft: button.getBoundingClientRect().left,
              };
            });
          geometry.push({
            width: 1440,
            state: "command-" + label,
            ...measured,
          });
          expect(measured.scrollWidth).toBeLessThanOrEqual(
            measured.clientWidth,
          );
          expect(measured.copyLeft).toBeGreaterThanOrEqual(measured.preRight);
          if (path)
            expect(await commandText(f.page)).toContain(
              "    --cacert /etc/vectory/server-ca.pem " +
                String.fromCharCode(92),
            );
        } finally {
          await f.context.close();
        }
      }
    },
  );
  await check(
    "live status explains refusals, follows the device to its first check-in and hands off to deployment",
    async () => {
      const f = await fixture();
      try {
        await f.createCommand();
        const watch = f.page.getByRole("region", {
          name: "3. Watch it connect",
        });
        await expect(watch).toContainText("Waiting for the device to enroll…");
        const started = f.state.activity.length;
        const listed = f.state.lists;
        await f.page.waitForTimeout(4500);
        const polls = f.state.activity.length - started;
        expect(polls).toBeGreaterThanOrEqual(2);
        expect(polls).toBeLessThanOrEqual(4);
        // Waiting reads the activity feed, never the full fleet.
        expect(f.state.lists - listed).toBe(0);
        expect(f.state.deviceReads).toEqual([]);
        expect(f.state.activity.at(-1).since).toBe(
          f.state.tokens[0].created_at,
        );
        f.state.events = [
          event({
            reason_code: "TOKEN_UNKNOWN",
            token_id: null,
            created_at: iso(400),
          }),
          event({ reason_code: "NAME_TAKEN", created_at: iso(500) }),
          event({
            reason_code: "TOKEN_EXPIRED",
            token_id: "another-token",
            created_at: iso(550),
          }),
        ].reverse();
        await expect(watch).toContainText(
          'Refused "edge-01": that name belongs to an existing device.',
        );
        await expect(watch).toContainText("the token wasn't recognized");
        await expect(watch).not.toContainText("the token expired");
        await expect(watch).toContainText(
          "from 10.0.4.17 · linux/amd64, agent 0.1.0-dev",
        );
        f.state.events = [
          event({
            outcome: "success",
            reason_code: null,
            device_id: deviceId,
            device_name: "edge-02",
            created_at: iso(900),
          }),
          ...f.state.events,
        ];
        f.state.devices = [device({ name: "edge-02" })];
        await expect(watch).toContainText(
          "Enrolled as edge-02, restricted mode",
        );
        await expect(watch).toContainText(
          "Waiting for edge-02's first check-in…",
        );
        // Once the feed names the device, each poll reads that one device.
        expect(new Set(f.state.deviceReads)).toEqual(new Set([deviceId]));
        await expect(f.page.locator(".enroll-secret")).toBeVisible();
        f.state.devices = [device({ name: "edge-02", last_seen: iso(2000) })];
        await expect(
          f.page.getByRole("heading", { name: "edge-02 is connected" }),
        ).toBeVisible();
        await expect(watch).toContainText("First check-in");
        // The token did its job: the page no longer holds it or a reminder.
        await expect(f.page.locator(".enroll-secret")).toHaveCount(0);
        await expect(f.page.locator("body")).not.toContainText(secret);
        expect(
          await f.page.evaluate(() =>
            Object.keys(localStorage).filter((key) =>
              key.startsWith("vectory:enrollment-token-request:"),
            ),
          ),
        ).toEqual([]);
        await expect(
          f.page.getByRole("region", { name: "Enrollment token requests" }),
        ).toHaveCount(0);
        const settled = f.state.activity.length;
        await f.page.waitForTimeout(2500);
        expect(f.state.activity.length).toBe(settled);
        await f.page
          .getByRole("button", { name: "Deploy a pipeline to edge-02" })
          .click();
        expect(await f.page.evaluate(() => window.lastNavigation)).toBe(
          `configurations?device=${deviceId}`,
        );
        await f.page
          .getByRole("button", { name: "Add another device", exact: true })
          .click();
        await expect(f.create).toBeVisible();
        expect(f.state.posts).toBe(1);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "macOS and Windows hosts get their own verified commands",
    async () => {
      const f = await fixture({ platform: "macOS" });
      try {
        await expect(
          f.page.getByRole("radio", { name: "macOS", exact: true }),
        ).toBeChecked();
        await f.createCommand();
        expect(await commandText(f.page)).toContain(
          `    | (cd "$dir" && shasum -a 256 -c -)\n  sudo sh "$dir/vectory-install.sh" \\\n    --mode restricted \\\n    --create-user\n)`,
        );
        await f.page
          .getByRole("button", { name: "Start over", exact: true })
          .click();
        await f.page
          .getByRole("dialog", { name: "Start over?" })
          .getByRole("button", { name: "Revoke and start over", exact: true })
          .click();
        await f.page
          .getByRole("radio", { name: "Windows", exact: true })
          .check();
        await f.createCommand();
        await expect(
          f.page.getByRole("link", { name: /Download vectory\.exe/ }),
        ).toHaveAttribute(
          "href",
          "/api/v1/releases/vectory-0.1.0-dev-windows-amd64.exe",
        );
        expect(await commandText(f.page)).toBe(
          [
            `if ((Get-FileHash .\\vectory.exe -Algorithm SHA256).Hash -ne '${windowsSha}') { throw 'vectory.exe does not match its SHA-256. Download it again.' }`,
            `.\\vectory.exe setup --server https://vectory.example.test:8443 --ca-sha256 ${pin} --mode restricted`,
          ].join("\n"),
        );
        await expect(f.page.getByRole("definition").first()).toContainText(
          "eeeeeeee…eeeeee",
        );
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "Windows downloads and checks the installer without a separate binary save",
    async () => {
      const f = await fixture({
        platform: "Windows",
        width: 375,
        install: agentInstall({
          windows_installer: {
            url: "https://vectory.example.test:8443/agent/v1/install.ps1",
            sha256: "9".repeat(64),
            platforms: ["windows/amd64"],
          },
        }),
      });
      try {
        await f.createCommand();
        const command = f.page.getByLabel("Windows install command", {
          exact: true,
        });
        await expect(command).toBeVisible();
        const text = await commandText(f.page);
        expect(text).toContain("/agent/v1/install.ps1");
        expect(text).toContain(
          "powershell.exe -NoProfile -ExecutionPolicy Bypass -File",
        );
        expect(text).toContain("--ssl-revoke-best-effort");
        expect(text).not.toContain("--token");
        await expect(
          f.page.getByRole("link", { name: /Download vectory\.exe/ }),
        ).toHaveCount(0);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "a 5,000-device fleet never blocks command creation or downloads the full inventory",
    async () => {
      const initial = Array.from({ length: 5000 }, (_, index) =>
        device({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          name: `host-${index}`,
        }),
      );
      const f = await fixture({ initial });
      try {
        await f.createCommand();
        expect(f.state.posts).toBe(1);
        expect(f.state.lists).toBe(0);
        expect(f.state.nameLookups).toEqual([]);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "an existing device name blocks the command and leads to that device",
    async () => {
      const f = await fixture({ initial: [device({ last_seen: iso() })] });
      try {
        await f.chooseMode();
        await f.advanced();
        await f.page.getByLabel("Device name", { exact: true }).fill("EDGE-01");
        await expect(f.create).toBeDisabled();
        await expect(f.page.locator(".enroll-actions")).toContainText(
          "Choose another device name.",
        );
        await f.page
          .getByRole("button", { name: "Open existing device", exact: true })
          .click();
        expect(await f.page.evaluate(() => window.lastNavigation)).toBe(
          `devices/${deviceId}`,
        );
        expect(f.state.posts).toBe(0);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "a failed optional name lookup is explained without downloading the fleet",
    async () => {
      const f = await fixture({ failDevices: true });
      try {
        await f.chooseMode();
        await f.advanced();
        await f.page.getByLabel("Device name", { exact: true }).fill("edge-01");
        await expect(f.page.locator(".enroll-advanced-fields")).toContainText(
          "Existing names couldn't be checked here",
        );
        await expect(f.create).toBeEnabled();
        expect(f.state.lists).toBe(0);
        expect(f.state.posts).toBe(0);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "a new device from another token never makes this command appear connected",
    async () => {
      const f = await fixture();
      try {
        await f.createCommand();
        f.state.devices = [device({ last_seen: iso(2000) })];
        f.state.events = [
          event({
            outcome: "success",
            token_id: "another-token",
            device_id: deviceId,
          }),
        ];
        await f.page.waitForTimeout(2300);
        await expect(
          f.page.getByRole("heading", { name: "edge-01 is connected" }),
        ).toHaveCount(0);
        await expect(f.page.locator(".enroll-secret")).toBeVisible();
        expect(f.state.deviceReads).toEqual([]);
        expect(f.state.lists).toBe(0);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "an older server without token-linked activity fails closed",
    async () => {
      const f = await fixture({ activityUnavailable: true });
      try {
        await f.createCommand();
        f.state.devices = [device({ last_seen: iso(2000) })];
        await expect(f.page.locator(".enroll-page")).toContainText(
          "won't mark it connected without a token-linked record",
        );
        await expect(
          f.page.getByRole("heading", { name: "edge-01 is connected" }),
        ).toHaveCount(0);
        await expect(f.page.locator(".enroll-secret")).toBeVisible();
        expect(f.state.lists).toBe(0);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "a device revoked after connecting stops being reported as connected",
    async () => {
      const f = await fixture();
      try {
        await f.createCommand();
        f.state.events = [
          event({
            outcome: "success",
            device_id: deviceId,
            reason_code: null,
          }),
        ];
        f.state.devices = [device({ last_seen: iso(2000) })];
        await expect(
          f.page.getByRole("heading", { name: "edge-01 is connected" }),
        ).toBeVisible();
        f.state.devices = [device({ status: "revoked", last_seen: iso(2000) })];
        await expect(f.page.locator(".enroll-page")).toContainText(
          "edge-01's access is revoked",
          { timeout: 12000 },
        );
        await expect(
          f.page.getByRole("heading", { name: "edge-01 is connected" }),
        ).toHaveCount(0);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "the connected-device watch pauses in a hidden tab and refreshes on return",
    async () => {
      const f = await fixture();
      try {
        await f.createCommand();
        f.state.events = [
          event({ outcome: "success", device_id: deviceId, reason_code: null }),
        ];
        f.state.devices = [device({ last_seen: iso(2000) })];
        await expect(
          f.page.getByRole("heading", { name: "edge-01 is connected" }),
        ).toBeVisible();
        await f.page.evaluate(() => {
          window.__testVisibilityState = "hidden";
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => window.__testVisibilityState,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        const reads = f.state.activity.length;
        await f.page.waitForTimeout(5500);
        expect(f.state.activity.length).toBe(reads);
        f.state.devices = [device({ status: "revoked", last_seen: iso(2000) })];
        await f.page.evaluate(() => {
          window.__testVisibilityState = "visible";
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expect(f.page.locator(".enroll-page")).toContainText(
          "edge-01's access is revoked",
          { timeout: 5000 },
        );
        expect(f.state.activity.length).toBeGreaterThan(reads);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "public trust, turned-off downloads and missing builds explain themselves",
    async () => {
      const trusted = agentInstall();
      trusted.certificate.publicly_trusted = true;
      let f = await fixture({ install: trusted });
      try {
        await f.createCommand();
        expect(await commandText(f.page)).toMatch(
          /\n {2}curl -fsSL --proto '=https' --proto-redir '=https' \\\n {4}-o "\$dir\/vectory-install\.sh" \\\n {4}https:\/\/vectory\.example\.test:8443\/agent/,
        );
        await expect(f.page.getByRole("definition").nth(1)).toContainText(
          "publicly trusted",
        );
      } finally {
        await f.context.close();
      }
      f = await fixture({
        install: agentInstall({
          downloads_enabled: false,
          installer: null,
          releases: [],
          catalog_problems: [
            "vectory-0.1.0-dev-linux-amd64 in the release mirror is missing or doesn't match its size and SHA-256, so it isn't offered.",
          ],
        }),
      });
      try {
        await f.chooseMode();
        // Nothing to download: say so before a token exists, and issue the
        // setup command rather than an installer that would fail on the host.
        await expect(f.page.locator(".enroll-no-build")).toContainText(
          "Agent downloads are off on this server.",
        );
        await expect(f.create).toHaveCount(0);
        await f.page
          .getByRole("button", { name: "Create setup command", exact: true })
          .click();
        await expect(
          f.page.getByLabel("Setup command", { exact: true }).first(),
        ).toContainText("sudo vectory setup \\");
        expect(await commandText(f.page)).not.toContain("vectory-install.sh");
        await f.page
          .locator("summary")
          .filter({ hasText: "I already have the agent" })
          .click();
        await expect(f.page.locator(".enroll-manual")).toContainText(
          "This server has no agent builds for this platform.",
        );
        await expect(f.page.locator(".enroll-problems")).toContainText(
          "isn't offered",
        );
        await f.page
          .getByRole("button", { name: "Start over", exact: true })
          .click();
        await f.page
          .getByRole("dialog", { name: "Start over?" })
          .getByRole("button", { name: "Revoke and start over", exact: true })
          .click();
        await f.page
          .getByRole("radio", { name: "Windows", exact: true })
          .check();
        await f.page
          .getByRole("button", { name: "Create setup command", exact: true })
          .click();
        await expect(f.page.locator(".enroll-page")).toContainText(
          "Copy vectory.exe to the host",
        );
        expect(await commandText(f.page)).toContain(".\\vectory.exe setup");
      } finally {
        await f.context.close();
      }
      // A platform without a build is named up front, before any token.
      f = await fixture({
        install: agentInstall({
          releases: [release("linux", "amd64", "a".repeat(64))],
        }),
      });
      try {
        await f.page.getByRole("radio", { name: "macOS", exact: true }).check();
        await f.chooseMode();
        await expect(f.page.locator(".enroll-no-build")).toContainText(
          "This server has no macOS agent build yet.",
        );
        await expect(
          f.page.getByRole("button", {
            name: "Create setup command",
            exact: true,
          }),
        ).toBeEnabled();
        expect(f.state.posts).toBe(0);
      } finally {
        await f.context.close();
      }
      f = await fixture({
        role: "operator",
        install: agentInstall({ releases: [], installer: null }),
      });
      try {
        await f.page
          .locator("summary")
          .filter({ hasText: "I already have the agent" })
          .click();
        await expect(f.page.locator(".enroll-manual")).toContainText(
          "Agent downloads aren't set up on this server. Ask an administrator.",
        );
      } finally {
        await f.context.close();
      }
      f = await fixture({
        install: agentInstall({ agent_url: null, installer: null }),
      });
      try {
        await expect(f.page.locator(".enroll-page")).toContainText(
          "The agent listener is off",
        );
        await expect(f.create).toHaveCount(0);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "tokens show their creator and devices, hide inactive ones by default and revoke only active ones",
    async () => {
      const active = {
        id: "3c0c3b5e-3a51-4f43-9c5d-000000000001",
        name: "Rack 7 fleet",
        created_at: iso(-86400000),
        expires_at: iso(86400000),
        uses: 2,
        max_uses: 10,
        name_prefix: "rack-7-",
        revoked: false,
        created_by: { id: "u1", name: "Ada Admin" },
        last_used_at: iso(-3600000),
        device_count: 2,
        devices: [
          {
            id: deviceId,
            name: "rack-7-a",
            revoked: false,
            enrolled_at: iso(-3600000),
          },
          {
            id: "5e7a9c2d-0000-4000-8000-000000000002",
            name: "rack-7-b",
            revoked: true,
            enrolled_at: iso(-7200000),
          },
        ],
      };
      const expired = {
        ...active,
        id: "3c0c3b5e-3a51-4f43-9c5d-000000000002",
        name: "Old token",
        expires_at: iso(-60000),
        devices: [],
        device_count: 0,
        uses: 0,
      };
      const f = await fixture({ tokens: [active, expired] });
      try {
        const summary = f.page.locator(".enroll-token-management > summary");
        await expect(summary).toHaveText("Manage enrollment tokens (1 active)");
        await summary.click();
        const rows = f.page
          .getByRole("table", { name: "Enrollment tokens" })
          .locator("tbody tr");
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText("Names starting with rack-7-");
        await expect(rows.first()).toContainText("by Ada Admin");
        await expect(rows.first()).toContainText("2 of 10");
        await expect(rows.first()).toContainText("rack-7-b (revoked)");
        await rows
          .first()
          .getByRole("button", { name: "rack-7-a", exact: true })
          .click();
        expect(await f.page.evaluate(() => window.lastNavigation)).toBe(
          `devices/${deviceId}`,
        );
        await f.page
          .getByLabel("Show expired, used and revoked tokens", { exact: true })
          .check();
        await expect(rows).toHaveCount(2);
        await expect(
          rows.filter({ hasText: "Old token" }).getByRole("button", {
            name: "Revoke",
            exact: true,
          }),
        ).toHaveCount(0);
        await rows
          .filter({ hasText: "Rack 7 fleet" })
          .getByRole("button", { name: "Revoke", exact: true })
          .click();
        await f.page
          .getByRole("dialog", { name: "Revoke token" })
          .getByRole("button", { name: "Revoke token", exact: true })
          .click();
        await expect(
          f.page.getByRole("dialog", { name: "Token revoked" }),
        ).toBeVisible();
        expect(f.state.revokes).toEqual([active.id]);
      } finally {
        await f.context.close();
      }
    },
  );
  const usedToken = (id, name, at, overrides = {}) => ({
    id,
    name,
    created_at: iso(-120000),
    expires_at: iso(3600000),
    uses: 1,
    max_uses: 1,
    name_prefix: null,
    revoked: false,
    created_by: { id: "synthetic-admin", name: "Synthetic admin" },
    last_used_at: at,
    device_count: 1,
    devices: [
      {
        id: deviceId,
        name: name.split(" ")[0],
        revoked: false,
        enrolled_at: at,
      },
    ],
    ...overrides,
  });
  const watchRegion = (page) =>
    page.getByRole("region", { name: "3. Watch it connect" });
  const requestCard = (page) =>
    page.getByRole("region", { name: "Enrollment token requests" });
  await check(
    "a command shown before leaving never blocks the next one; back after it enrolled, the timeline says so once",
    async () => {
      const f = await fixture();
      try {
        await f.advanced();
        await f.page
          .getByLabel("Device name", { exact: true })
          .fill("lab-full");
        await f.createCommand("Full Vector");
        // The reminder names the token its command showed, never the secret.
        const [reminder] = await f.stored();
        expect(reminder.token_id).toBe(tokenId);
        expect(JSON.stringify(reminder)).not.toContain(secret);
        const lookups = f.state.lookups.length;
        await f.reload(() => {
          // Meanwhile, on the host, lab-full enrolled with it.
          const at = iso(60000);
          f.state.tokens = f.state.tokens.map((token) =>
            token.id === tokenId
              ? usedToken(tokenId, token.name, at, {
                  created_at: token.created_at,
                })
              : token,
          );
          f.state.devices = [
            device({ name: "lab-full", last_seen: iso(61000) }),
          ];
        });
        await expect(watchRegion(f.page)).toContainText(
          /lab-full install command enrolled lab-full (?:at|on .+ at) \d{1,2}:\d{2}/,
        );
        await expect(requestCard(f.page)).toHaveCount(0);
        await expect.poll(() => f.stored()).toEqual([]);
        // Only a request whose response never arrived is looked up.
        expect(f.state.lookups.length).toBe(lookups);
        await f.chooseMode();
        await expect(f.create).toBeEnabled();
        await f.create.click();
        await expect(
          f.page.locator(".enroll-command pre").first(),
        ).toBeVisible();
        expect(f.state.posts).toBe(2);
        // Said once: the next visit has nothing left to explain.
        await f.reload();
        await expect(watchRegion(f.page)).not.toContainText(
          "enrolled lab-full",
        );
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "an unused command from an earlier visit joins the unused line; revoking it drops its reminder silently",
    async () => {
      const f = await fixture();
      try {
        await f.createCommand();
        await f.reload();
        const unused = f.page.locator(".enroll-unused");
        await expect(unused).toContainText(
          "An install command you created earlier wasn't used.",
        );
        await expect(requestCard(f.page)).toHaveCount(0);
        await f.chooseMode();
        await expect(f.create).toBeEnabled();
        await unused.getByRole("button", { name: "Revoke it" }).click();
        await expect.poll(() => f.state.revokes).toEqual([tokenId]);
        await expect.poll(() => f.stored()).toEqual([]);
        await expect(unused).toHaveCount(0);
        await expect(watchRegion(f.page)).not.toContainText("enrolled");
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "only a creation whose response never arrived blocks, with its time, until it is checked",
    async () => {
      const f = await fixture();
      try {
        await f.chooseMode();
        f.state.holdToken = true;
        await f.create.click();
        await expect.poll(() => f.state.posts).toBe(1);
        // The tab goes away before the server's answer arrives.
        await f.reload();
        const card = requestCard(f.page);
        await expect(card).toContainText(
          /We couldn't confirm whether a token was created at \d{1,2}:\d{2}/,
        );
        await f.chooseMode();
        await expect(f.create).toBeDisabled();
        await expect(f.page.locator(".enroll-actions")).toContainText(
          "Check the saved token request at the top of the page first.",
        );
        // Looked up once on its own (after the probe before sending): the
        // server has no result for it, so it keeps blocking.
        await expect.poll(() => f.state.lookups.length).toBe(2);
        await card.getByRole("button", { name: "Check request" }).click();
        const dialog = f.page.getByRole("dialog", {
          name: "Check token request",
        });
        await expect(dialog).toContainText("No result is recorded yet.");
        await dialog.getByRole("button", { name: "Cancel request" }).click();
        await f.page
          .getByRole("dialog", { name: "Request cancelled" })
          .getByRole("button", { name: "Continue setup" })
          .click();
        await expect(card).toHaveCount(0);
        await expect(f.create).toBeEnabled();
        expect(f.state.cancels).toHaveLength(1);
      } finally {
        f.state.releaseToken?.();
        await f.context.close();
      }
    },
  );
  await check(
    "a reminder an earlier version left for a used-up token never asks to be revoked",
    async () => {
      const id = "0b6c1c55-8a53-4c4b-9f47-4a1c3a5d0e11",
        token = "6f1f3a8e-2f0a-4a53-8c1d-7c9e1a0b2c3d",
        at = iso(-60000);
      const listed = usedToken(token, "lab-full install command", at);
      const status = {
        request_id: id,
        request_correlation: true,
        found: true,
        state: "created",
        record: {
          id: token,
          name: listed.name,
          expires_at: listed.expires_at,
          uses: 1,
          max_uses: 1,
          name_prefix: null,
          revoked: false,
          created_at: listed.created_at,
        },
      };
      // Resolved on its own: dropped, and the timeline says what it enrolled.
      let f = await fixture({
        saved: [savedRequest(id)],
        statuses: { [id]: status },
        tokens: [listed],
      });
      try {
        await expect(watchRegion(f.page)).toContainText(
          /lab-full install command enrolled lab-full (?:at|on .+ at) \d{1,2}:\d{2}/,
        );
        await expect(requestCard(f.page)).toHaveCount(0);
        await expect.poll(() => f.stored()).toEqual([]);
        await f.chooseMode();
        await expect(f.create).toBeEnabled();
      } finally {
        await f.context.close();
      }
      // When the check fails, Check request says what happened and ends it.
      f = await fixture({
        saved: [savedRequest(id)],
        statuses: { [id]: ["fail", status] },
        tokens: [listed],
      });
      try {
        const card = requestCard(f.page);
        await expect(card).toContainText("We couldn't confirm whether");
        await card.getByRole("button", { name: "Check request" }).click();
        const dialog = f.page.getByRole("dialog", {
          name: "Check token request",
        });
        await expect(dialog).toContainText(
          /lab-full install command enrolled lab-full (?:at|on .+ at) \d{1,2}:\d{2}.* Its token can't enroll another device, so there is nothing to cancel\./,
        );
        await expect(dialog).not.toContainText("cannot be retrieved");
        await expect(
          dialog.getByRole("button", { name: "Revoke token and cancel" }),
        ).toHaveCount(0);
        await dialog.getByRole("button", { name: "Done", exact: true }).click();
        await expect(card).toHaveCount(0);
        await expect(watchRegion(f.page)).toContainText(
          "lab-full install command enrolled lab-full",
        );
        expect(f.state.revokes).toEqual([]);
        expect(f.state.cancels).toEqual([]);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "Start over revokes the displayed command after a confirmation, then a new one can be created",
    async () => {
      const f = await fixture();
      try {
        await f.createCommand();
        const startOver = f.page.getByRole("button", {
          name: "Start over",
          exact: true,
        });
        await startOver.click();
        const dialog = f.page.getByRole("dialog", { name: "Start over?" });
        await expect(dialog).toContainText("so no device can enroll with it");
        await dialog
          .getByRole("button", { name: "Keep this command", exact: true })
          .click();
        await expect(f.page.locator(".enroll-secret")).toBeVisible();
        expect(f.state.revokes).toEqual([]);
        await startOver.click();
        await dialog
          .getByRole("button", { name: "Revoke and start over", exact: true })
          .click();
        await expect(f.create).toBeVisible();
        expect(f.state.revokes).toEqual([tokenId]);
        await expect.poll(() => f.stored()).toEqual([]);
        await expect(f.page.locator("body")).not.toContainText(secret);
        await expect(f.page.locator(".enroll-unused")).toHaveCount(0);
        await f.create.click();
        await expect(
          f.page.locator(".enroll-command pre").first(),
        ).toBeVisible();
        expect(f.state.posts).toBe(2);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "on a host without a service manager the timeline says the agent checked in once and how to start it",
    async () => {
      const f = await fixture();
      try {
        await f.createCommand();
        f.state.events = [
          event({
            outcome: "success",
            reason_code: null,
            device_id: deviceId,
            created_at: iso(900),
          }),
        ];
        f.state.devices = [
          device({ last_seen: iso(2000), service_manager: "none" }),
        ];
        const watch = watchRegion(f.page);
        await expect(watch).toContainText(
          "edge-01 checked in once, but nothing keeps its agent running.",
        );
        await expect(watch).toContainText(
          "Start it with sudo /usr/local/bin/vectory run --state-dir /var/lib/vectory-agent, or use a host with systemd.",
        );
        await expect(
          f.page.getByRole("heading", { name: "edge-01 is connected" }),
        ).toHaveCount(0);
        await expect(
          f.page.getByRole("heading", { name: "Start edge-01's agent" }),
        ).toBeVisible();
        await expect(
          f.page.getByLabel("Run command", { exact: true }),
        ).toHaveText(
          "sudo /usr/local/bin/vectory run --state-dir /var/lib/vectory-agent",
        );
        // The token did its job: it enrolled the device.
        await expect.poll(() => f.stored()).toEqual([]);
        // Started under the operator's supervisor: a later check-in.
        f.state.devices = [
          device({ last_seen: iso(62000), service_manager: "none" }),
        ];
        await expect(
          f.page.getByRole("heading", { name: "edge-01 is connected" }),
        ).toBeVisible({ timeout: 15000 });
        await expect(watch).toContainText("Checked in again");
        await expect(watch).not.toContainText("nothing keeps its agent");
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "the page stays accessible and inside the viewport at desktop and phone widths in both themes",
    async () => {
      for (const width of [1280, 390]) {
        for (const theme of ["light", "dark"]) {
          const f = await fixture({ width, theme });
          try {
            await f.createCommand();
            await f.page
              .getByRole("button", { name: "Show", exact: true })
              .click();
            f.state.events = [
              event({ reason_code: "NAME_TAKEN", created_at: iso(500) }),
            ];
            await expect(f.page.locator(".enroll-timeline")).toContainText(
              "Refused",
            );
            const shot = async (name) => {
              const measured = await f.page.evaluate(() => ({
                width: innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
              }));
              geometry.push({ width, theme, state: name, ...measured });
              expect(measured.scrollWidth).toBeLessThanOrEqual(width);
              const audit = await new AxeBuilder({ page: f.page })
                .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
                .analyze();
              accessibility.push({
                width,
                theme,
                state: name,
                violations: audit.violations.map(({ id, impact, nodes }) => ({
                  id,
                  impact,
                  nodes: nodes.map(({ target }) => target),
                })),
              });
              expect(audit.violations).toEqual([]);
              const filename = `add-device-${name}-${width === 390 ? "phone" : "desktop"}-${theme}.png`;
              await f.page.screenshot({
                path: resolve(output, filename),
                fullPage: true,
                animations: "disabled",
              });
              screenshots.push(relative(repository, resolve(output, filename)));
            };
            await shot("waiting");
            f.state.events = [
              event({
                outcome: "success",
                reason_code: null,
                device_id: deviceId,
                created_at: iso(900),
              }),
              ...f.state.events,
            ];
            f.state.devices = [device({ last_seen: iso(2000) })];
            await expect(
              f.page.getByRole("heading", { name: "edge-01 is connected" }),
            ).toBeVisible();
            await shot("connected");
            await f.advanced();
            await f.page.locator(".enroll-token-management > summary").click();
            await f.page
              .getByLabel("Show expired, used and revoked tokens", {
                exact: true,
              })
              .check();
            await expect(
              f.page
                .getByRole("table", { name: "Enrollment tokens" })
                .locator("tbody tr"),
            ).toHaveCount(1);
            await shot("details");
          } finally {
            await f.context.close();
          }
        }
      }
    },
  );
  /** Viewport width, Axe scan and a full-page screenshot of one state. */
  const snapshot = async (f, width, theme, name) => {
    const measured = await f.page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    geometry.push({ width, theme, state: name, ...measured });
    expect(measured.scrollWidth).toBeLessThanOrEqual(width);
    const audit = await new AxeBuilder({ page: f.page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    accessibility.push({
      width,
      theme,
      state: name,
      violations: audit.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        nodes: nodes.map(({ target }) => target),
      })),
    });
    expect(audit.violations).toEqual([]);
    const filename = `add-device-${name}-${width === 390 ? "phone" : "desktop"}-${theme}.png`;
    await f.page.screenshot({
      path: resolve(output, filename),
      fullPage: true,
      animations: "disabled",
    });
    screenshots.push(relative(repository, resolve(output, filename)));
  };
  await check(
    "returning, start-over and service-less states stay accessible and inside the viewport",
    async () => {
      const done = "1d6c1c55-8a53-4c4b-9f47-4a1c3a5d0e01",
        unused = "1d6c1c55-8a53-4c4b-9f47-4a1c3a5d0e02",
        lost = "1d6c1c55-8a53-4c4b-9f47-4a1c3a5d0e03",
        doneToken = "2e7d2d66-9b64-4d5d-8a58-5b2d4b6e1f01",
        unusedToken = "2e7d2d66-9b64-4d5d-8a58-5b2d4b6e1f02";
      const request = (id, name) => ({
        name,
        expires_hours: 1,
        max_uses: 1,
        name_prefix: null,
        request_id: id,
      });
      for (const width of [1280, 390]) {
        for (const theme of ["light", "dark"]) {
          // Back after three commands: one enrolled lab-full, one wasn't
          // used, and one creation's response never arrived.
          let f = await fixture({
            width,
            theme,
            saved: [
              savedRequest(done, {
                token_id: doneToken,
                confirmed_at: iso(-110000),
              }),
              savedRequest(unused, {
                request: request(unused, "lab-web install command"),
                token_id: unusedToken,
                confirmed_at: iso(-100000),
              }),
              savedRequest(lost, {
                recorded_at: iso(-30000),
                request: request(lost, "lab-db install command"),
              }),
            ],
            tokens: [
              usedToken(doneToken, "lab-full install command", iso(-60000)),
              {
                ...usedToken(unusedToken, "lab-web install command", null),
                uses: 0,
                device_count: 0,
                devices: [],
              },
            ],
          });
          try {
            await f.chooseMode();
            await expect(watchRegion(f.page)).toContainText(
              "lab-full install command enrolled lab-full",
            );
            await expect(f.page.locator(".enroll-unused")).toBeVisible();
            await expect(requestCard(f.page)).toContainText(
              "We couldn't confirm whether a token was created",
            );
            await snapshot(f, width, theme, "returned");
          } finally {
            await f.context.close();
          }
          f = await fixture({ width, theme });
          try {
            await f.createCommand();
            await f.page
              .getByRole("button", { name: "Start over", exact: true })
              .click();
            await expect(
              f.page.getByRole("dialog", { name: "Start over?" }),
            ).toBeVisible();
            await snapshot(f, width, theme, "start-over");
            await f.page
              .getByRole("button", { name: "Keep this command", exact: true })
              .click();
            f.state.events = [
              event({
                outcome: "success",
                reason_code: null,
                device_id: deviceId,
                created_at: iso(900),
              }),
            ];
            f.state.devices = [
              device({ last_seen: iso(2000), service_manager: "none" }),
            ];
            await expect(
              f.page.getByRole("heading", { name: "Start edge-01's agent" }),
            ).toBeVisible();
            await snapshot(f, width, theme, "service-less");
          } finally {
            await f.context.close();
          }
        }
      }
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  await check(
    "fleet commands stay reusable after the first enrollment and stop exposing an exhausted token",
    async () => {
      for (const width of [390, 1280]) {
        const f = await fixture({ width });
        try {
          await f.page
            .getByRole("radio", { name: "Many devices", exact: true })
            .check();
          await f.page
            .getByRole("radio", {
              name: "Read a protected file on each host",
              exact: true,
            })
            .check();
          await f.page
            .getByLabel("Enrollment token file", { exact: true })
            .fill("/private/provisioning/owner's token.txt");
          await f.createCommand();
          expect(f.state.tokenRequest.max_uses).toBe(100);
          expect(f.state.tokenRequest.expires_hours).toBe(24);
          expect(f.state.tokenRequest.device_name).toBeUndefined();
          const compact = await f.page
            .locator(".enroll-command pre")
            .first()
            .innerText();
          expect(compact).not.toContain("\n");
          expect(compact).toContain("--token-file");
          expect(compact).not.toContain(secret);
          await f.page
            .getByRole("button", { name: "Show", exact: true })
            .click();
          await expect(f.page.locator(".enroll-secret code")).toHaveText(
            secret,
          );
          f.state.tokens[0] = {
            ...f.state.tokens[0],
            uses: 1,
            device_count: 1,
            devices: [
              {
                id: deviceId,
                name: "fleet-edge-01",
                enrolled_at: iso(900),
                revoked: false,
              },
            ],
          };
          await expect(f.page.locator(".enroll-fleet-progress")).toContainText(
            "1 devices enrolled out of 100",
            { timeout: 12000 },
          );
          await expect(f.page.locator(".enroll-fleet-progress")).toContainText(
            "fleet-edge-01",
          );
          await expect(f.page.locator(".enroll-fleet-progress")).toContainText(
            "Enrollment does not assign a pipeline",
          );
          await expect(f.page.locator(".enroll-secret code")).toHaveText(
            secret,
          );
          await snapshot(f, width, "light", "fleet-reusable");
          expect(await commandText(f.page)).toContain("owner");
          f.state.tokens[0] = { ...f.state.tokens[0], uses: 100 };
          await expect(f.page.locator(".enroll-fleet-progress")).toContainText(
            "100 devices enrolled out of 100",
            { timeout: 12000 },
          );
          await expect(f.page.locator(".enroll-secret code")).toHaveCount(0);
          expect(JSON.stringify(await f.stored())).not.toContain(secret);
        } finally {
          await f.context.close();
        }
      }
    },
  );
  await check(
    "a fleet token expires locally when token reads never list it",
    async () => {
      const f = await fixture({ tokenExpiryMs: 5000 });
      try {
        await f.page
          .getByRole("radio", { name: "Many devices", exact: true })
          .check();
        // Initial inventory was empty. Every read after creation fails, so
        // expiry cannot come from a successfully listed commandToken.
        f.state.failTokens = true;
        await f.createCommand();
        await f.page.getByRole("button", { name: "Show", exact: true }).click();
        await expect(f.page.locator(".enroll-secret code")).toHaveText(secret);
        await expect(f.page.locator(".enroll-secret code")).toHaveCount(0, {
          timeout: 8000,
        });
        await expect(f.page.locator("body")).not.toContainText(secret);
        expect(JSON.stringify(await f.stored())).not.toContain(secret);
        expect(await f.stored()).toEqual([]);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "remote fleet revocation drops the secret and restores the normal refresh rate",
    async () => {
      const f = await fixture();
      try {
        await f.page
          .getByRole("radio", { name: "Many devices", exact: true })
          .check();
        await f.createCommand();
        await f.page.getByRole("button", { name: "Show", exact: true }).click();
        await expect(f.page.locator(".enroll-secret code")).toHaveText(secret);
        f.state.tokens[0] = { ...f.state.tokens[0], revoked: true };
        await expect(f.page.locator(".enroll-fleet-progress")).toContainText(
          "Revoked.",
          { timeout: 12000 },
        );
        await expect(f.page.locator(".enroll-secret code")).toHaveCount(0);
        const reads = f.state.tokenReads;
        await f.page.waitForTimeout(6000);
        expect(f.state.tokenReads).toBe(reads);
        expect(await f.stored()).toEqual([]);
      } finally {
        await f.context.close();
      }
    },
  );
  await check(
    "managed tokens refresh without an active fleet command",
    async () => {
      const token = {
        id: tokenId,
        name: "Synthetic shared token",
        created_at: iso(),
        expires_at: iso(86400000),
        uses: 0,
        max_uses: 100,
        name_prefix: null,
        revoked: false,
      };
      const f = await fixture({ tokens: [token] });
      try {
        await f.page.locator(".enroll-token-management > summary").click();
        const row = f.page
          .getByRole("table", { name: "Enrollment tokens" })
          .locator("tbody tr")
          .filter({ hasText: token.name });
        await expect(row).toContainText("0 of 100");
        const reads = f.state.tokenReads;
        f.state.tokens[0] = { ...token, uses: 1 };
        await expect(row).toContainText("1 of 100", { timeout: 22000 });
        expect(f.state.tokenReads).toBeGreaterThan(reads);
        expect(f.state.posts).toBe(0);
      } finally {
        await f.context.close();
      }
    },
  );
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  await server.close();
  const source_sha256 = {};
  for (const path of [
    "dashboard/src/Enrollment.tsx",
    "dashboard/src/EnrollmentConnection.tsx",
    "dashboard/src/EnrollmentTokenFlow.tsx",
    "dashboard/src/enrollmentCommands.ts",
    "dashboard/src/enrollmentActivity.ts",
    "dashboard/src/enrollmentTokenRequests.ts",
    "dashboard/tests/enrollment-browser.mjs",
  ])
    source_sha256[path] = createHash("sha256")
      .update(await readFile(resolve(repository, path)))
      .digest("hex");
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        source:
          "actual React Add device page with isolated synthetic HTTP fixtures",
        scope:
          "Browser instructions, generated commands and scripted live status only. No preview, real token, device, installer run or activation was exercised.",
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
