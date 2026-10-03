// The actual App on every screen of agent updates. Every API response is
// synthetic (agent-update-replies.mjs and fleet-replies.mjs); no real device,
// key or mutation. Each screen is looked at in light, dark and at 390 px.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { fleetReplies } from "./fleet-replies.mjs";
import {
  agentUpdateReplies,
  detailBody,
  finalFingerprint,
  id,
  manifestText,
  nextFingerprint,
  nextLine,
  noCounts,
  offState,
  onState,
  previewBody,
  release,
  releaseKey,
  report,
  rollout,
  rolloverEnvelope,
  signatureFile,
  targetRow,
  teamFingerprint,
  teamLine,
  updatesBody,
} from "./agent-update-replies.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_AGENT_UPDATES_OUTPUT || ".local/agent-updates",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:agent-updates";
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "agent-updates-fixture",
      resolveId(source) {
        if (source === "virtual:agent-updates") return virtual;
      },
      load(source) {
        if (source === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url.split("?")[0] !== "/__agent-updates") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic agent updates</title></head><body><div id="root"></div><script type="module">import "virtual:agent-updates";</script></body></html>',
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

const created = "2026-10-03T12:00:00Z";
const results = [],
  requests = [],
  errors = [],
  unexpected = [],
  accessibility = [],
  geometry = [],
  screenshots = [];
let context, page, state, fleet, failure;
// The width and theme the page was loaded in: a picture is named for them.
let shown = { width: 1100, theme: "light" };

// The fleet the screens read: a few devices that report updates in different
// states, and one that reported nothing.
const device = (n, name, over = {}) => ({
  id: id(n),
  name,
  os: "linux",
  arch: "amd64",
  agent_version: "0.1.0",
  vector_version: "0.58.0",
  configuration_mode: "full",
  created_at: created,
  last_seen: new Date().toISOString(),
  status: "verified",
  apply_state: "verified_applied",
  desired_generation: 5,
  reported_generation: 5,
  desired_version_id: null,
  labels: {},
  sync_paused: false,
  local_paused: false,
  pause_acknowledged: false,
  state_dir: "/var/lib/vectory-agent",
  service_manager: "systemd",
  ...over,
});
const fleetDevices = () => [
  device(1, "edge-01", { agent_update: report() }),
  device(2, "edge-02", {
    agent_update: report({ consent: "ask", windows: [] }),
  }),
  device(3, "edge-03", {
    agent_update: report({ consent: "off", windows: [], keys: [] }),
  }),
  device(4, "edge-04", { agent_update: report() }),
  device(5, "edge-05", {
    agent_update: report({
      rollover_conflict: {
        from: teamFingerprint,
        to: [nextFingerprint, finalFingerprint],
      },
      state: "refused",
      code: "KEY_ROLLOVER_CONFLICT",
    }),
  }),
  device(6, "edge-06"),
];
const groups = () => [
  {
    id: id(50),
    name: "Edge fleet",
    description: "",
    device_ids: [id(1), id(2), id(3), id(4), id(5), id(6)],
    revision: 1,
    created_at: created,
    updated_at: created,
  },
];

const installFor = () => ({
  agent_url: "https://vectory.example.test:8443",
  agent_url_configured: false,
  listener_enabled: true,
  dashboard_url: "https://vectory.example.test",
  certificate: {
    available: true,
    publicly_trusted: false,
    ca_sha256: "1f3c" + "0".repeat(56) + "9ab0",
    ca_pem: [
      "-----BEGIN CERTIFICATE-----",
      "MIIBszCCAVmgAwIBAgIUU3ludGhldGljIGFnZW50IENBIGZvciB0ZXN0cy4wCgYI",
      "-----END CERTIFICATE-----",
      "",
    ].join("\n"),
    problem: null,
  },
  downloads_enabled: true,
  installer: {
    url: "https://vectory.example.test:8443/agent/v1/install.sh",
    sha256: "c0f4e1b7" + "1".repeat(50) + "9d19ab",
    platforms: ["linux/amd64"],
  },
  default_install_dir: "/usr/local/bin",
  releases: [],
  catalog_problems: [],
});

async function load({
  role = "admin",
  width = 1100,
  theme = "light",
  path = "agent-updates-settings",
  scenario = onState(),
} = {}) {
  if (context) await context.close();
  state = scenario;
  state.role = role;
  fleet = fleetReplies({ devices: fleetDevices, groups });
  const replies = agentUpdateReplies(state);
  context = await browser.newContext({
    viewport: { width, height: 900 },
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
    const apiPath = url.pathname.slice(7);
    const raw = req.postDataBuffer()?.toString("utf8") ?? "";
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    requests.push({ method, path: apiPath, query: url.search, body });
    const send = (given) =>
      given.json !== undefined
        ? route.fulfill({ status: given.status, json: given.json })
        : route.fulfill({
            status: given.status,
            body: given.body,
            headers: given.headers,
          });
    if (apiPath === "/status")
      return send({
        status: 200,
        json: {
          initialized: true,
          version: "synthetic",
          instance_name: "Synthetic",
        },
      });
    if (apiPath === "/session")
      return send({
        status: 200,
        json: {
          user: {
            id: id(99),
            email: `${role}@example.test`,
            name: "Synthetic reviewer",
            role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        },
      });
    if (state.hold?.test(apiPath))
      await new Promise((done) => state.waiters.push(done));
    const given =
      replies.handle(method, url, body, raw) || fleet.handle(method, url);
    if (given) return send(given);
    if (method === "GET" && apiPath === "/agent-install")
      return send({ status: 200, json: installFor() });
    if (method === "GET" && apiPath === "/settings")
      return send({ status: 200, json: { instance_name: "Synthetic" } });
    unexpected.push(`${method} ${apiPath}`);
    return send({
      status: 500,
      json: {
        error: { code: "UNEXPECTED", message: "Unexpected synthetic request" },
      },
    });
  });
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  shown = { width, theme };
  await page.goto(`${origin}/__agent-updates#/${path}`);
  // A cold dev server compiles the App on first use; the checks below keep
  // their own short timeouts once it is up.
  await page
    .getByText("Loading Vectory…")
    .waitFor({ state: "detached", timeout: 180000 })
    .catch(() => undefined);
}

// While developing a screen: VECTORY_AGENT_UPDATES_ONLY=review runs only the
// checks whose name has that word. Unset, every check runs.
const only = process.env.VECTORY_AGENT_UPDATES_ONLY?.toLowerCase();
async function check(name, run) {
  if (only && !name.toLowerCase().includes(only)) return;
  const start = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - start });
  console.log("PASS", name);
}
/**
 * The page as it is: accessibility, no sideways scroll, and a picture to look
 * at. The picture is named for the width and theme the page was loaded in; a
 * different width resizes the window first, a different theme is refused.
 */
async function look(name, view = shown) {
  if (view.theme !== shown.theme)
    throw new Error(`${name}: the page is ${shown.theme}, not ${view.theme}`);
  const { width, theme } = view;
  if (width !== shown.width) {
    await page.setViewportSize({ width, height: 900 });
    shown = { width, theme };
  }
  const metrics = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(metrics.page).toBeLessThanOrEqual(metrics.viewport);
  geometry.push({ name, width, theme, ...metrics });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  accessibility.push({
    name,
    width,
    theme,
    violations: audit.violations.map(({ id, impact }) => ({ id, impact })),
  });
  expect(audit.violations, `${name} ${width} ${theme}`).toEqual([]);
  const file = `${name}-${width}-${theme}.png`;
  await page.screenshot({
    path: resolve(output, file),
    fullPage: true,
    animations: "disabled",
  });
  screenshots.push(relative(repository, resolve(output, file)));
  // A tall phone page is read in pieces: VECTORY_AGENT_UPDATES_SLICES=1 also
  // writes it as pictures of 1300 px each, which stay legible.
  if (process.env.VECTORY_AGENT_UPDATES_SLICES && width <= 480) {
    const total = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    for (let top = 0, n = 1; top < total; top += 1300, n++)
      await page.screenshot({
        path: resolve(output, `${name}-${width}-${theme}-part${n}.png`),
        fullPage: true,
        clip: { x: 0, y: top, width, height: Math.min(1300, total - top) },
        animations: "disabled",
      });
  }
}
const views = [
  { width: 1100, theme: "light" },
  { width: 1100, theme: "dark" },
  { width: 390, theme: "light" },
];
const heading = (name) =>
  page.getByRole("heading", { name, exact: true, level: 1 });
const platforms = [
  { os: "linux", arch: "amd64" },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "arm64" },
];
/**
 * A server with updates on, the key kept offline, three builds in its catalog
 * (one without a release, one waiting for a signature, one ready and rolling
 * out), and rollouts in each state a list shows.
 */
const richState = (over = {}) =>
  onState({
    updates: updatesBody({
      catalog: [
        {
          version: "0.1.3",
          platforms,
          devices_behind: 41,
          release: null,
        },
        {
          version: "0.1.2",
          platforms,
          devices_behind: 41,
          release: { id: id(31), state: "awaiting_signature" },
        },
        {
          version: "0.1.1",
          platforms,
          devices_behind: 38,
          release: { id: id(30), state: "ready" },
        },
      ],
    }),
    releases: [
      release({
        id: id(31),
        version: "0.1.2",
        counter: 8,
        state: "awaiting_signature",
        signer: null,
        rollouts: [],
      }),
      release({
        rollouts: [
          { id: id(40), status: "active" },
          { id: id(41), status: "completed" },
        ],
      }),
      release({
        id: id(32),
        version: "0.1.0",
        counter: 5,
        state: "withdrawn",
        withdrawn_at: "2026-10-01T09:00:00Z",
        withdrawn_reason: "A build that didn't start on arm64",
        rollouts: [{ id: id(42), status: "cancelled" }],
      }),
    ],
    rollouts: [
      rollout(),
      rollout({
        id: id(41),
        name: "Edge fleet, second wave",
        status: "completed",
        completed_at: "2026-10-02T09:00:00Z",
        target_count: 20,
        state_counts: { ...noCounts, verified: 18, rolled_back: 2 },
      }),
      rollout({
        id: id(42),
        release: { ...rollout().release, version: "0.1.0", counter: 5 },
        status: "cancelled",
        cancel_reason: "release_withdrawn",
        cancelled_at: "2026-10-01T09:00:00Z",
        target_count: 6,
        state_counts: { ...noCounts, verified: 1, cancelled: 5 },
      }),
    ],
    details: { [id(40)]: detailBody() },
    targets: { [id(40)]: [targetRow()] },
    ...over,
  });

try {
  await check(
    "Settings: off, nothing chosen for anyone, and read only for others",
    async () => {
      for (const view of views) {
        await load({ ...view, scenario: offState() });
        await expect(heading("Agent updates")).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Agent updates are off" }),
        ).toBeVisible();
        await expect(
          page.getByText(
            "Devices run the agent they have until someone upgrades it on the host.",
          ),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Turn on agent updates…" }),
        ).toBeVisible();
        await look("settings-off", view);
      }
      for (const role of ["viewer", "operator"]) {
        await load({ role, scenario: offState() });
        await expect(
          page.getByText("Only an administrator can change this."),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: /Turn on/ })).toHaveCount(
          0,
        );
      }
    },
  );

  await check(
    "Settings: on, the key, its history and who must act",
    async () => {
      for (const view of views) {
        await load({
          ...view,
          scenario: onState({
            keys: [
              releaseKey({
                fingerprint: nextFingerprint,
                public_key: nextLine,
                state: "current",
                introduced_by: rolloverEnvelope,
                devices_pinning: 9,
                device_names: ["edge-04", "edge-05"],
              }),
              releaseKey({
                state: "retired",
                retired_at: "2026-11-02T09:00:00Z",
                devices_pinning: 12,
                device_names: ["edge-01", "edge-02", "edge-03"],
              }),
              releaseKey({
                fingerprint: finalFingerprint,
                state: "revoked",
                revoked_at: "2026-10-20T09:00:00Z",
                revoked_reason: "The laptop that held it was lost",
                devices_pinning: 2,
                device_names: ["edge-06", "edge-07"],
              }),
            ],
            updates: updatesBody({
              current_key: releaseKey({
                fingerprint: nextFingerprint,
                public_key: nextLine,
                state: "current",
                introduced_by: rolloverEnvelope,
                devices_pinning: 9,
              }),
              frozen_devices: {
                total: 1,
                items: [
                  {
                    device_id: id(5),
                    device_name: "edge-05",
                    rollover_conflict: {
                      from: teamFingerprint,
                      to: [nextFingerprint, finalFingerprint],
                    },
                  },
                ],
              },
            }),
          }),
        });
        await expect(
          page.getByRole("heading", { name: "Agent updates are on" }),
        ).toBeVisible();
        await expect(
          page.getByText("Fixed while updates are on."),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Key history" }),
        ).toBeVisible();
        await look("settings-on", view);
      }
    },
  );

  await check(
    "Devices: the fleet, the builds, the releases and the rollouts",
    async () => {
      for (const view of views) {
        await load({ ...view, path: "agent-updates", scenario: richState() });
        await expect(heading("Agent updates")).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Your fleet" }),
        ).toBeVisible();
        // The server's counts, as it gave them: nothing summed here.
        await expect(
          page.getByRole("link", { name: /^0\.1\.0\s*41 devices$/ }),
        ).toHaveAttribute("href", "#/devices?agent_version=0.1.0");
        await expect(
          page.getByRole("link", { name: /^30\s*Automatic$/ }),
        ).toHaveAttribute("href", "#/devices?agent_update=automatic");
        await expect(
          page.getByRole("link", { name: /^3\s*Can't update$/ }),
        ).toHaveAttribute("href", "#/devices?agent_update=cannot_update");
        // Versions this server can't read have no filter to open.
        await expect(page.getByText("Unknown version")).toBeVisible();
        await expect(
          page.getByRole("link", { name: /Unknown version/ }),
        ).toHaveCount(0);
        // Builds, and what each one needs next.
        await expect(
          page.getByRole("button", { name: "Roll out agent 0.1.3" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Roll out agent 0.1.1" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Sign it" }),
        ).toBeVisible();
        // Releases, the one waiting for a signature first.
        const waiting = page.getByRole("article", { name: "Agent 0.1.2" });
        await expect(
          waiting.getByRole("heading", { name: "Waiting for your signature" }),
        ).toBeVisible();
        await expect(
          waiting.getByRole("link", { name: "Download release.json" }),
        ).toHaveAttribute("href", `/api/v1/agent-releases/${id(31)}/manifest`);
        await expect(
          waiting.getByLabel("Sign command", { exact: true }),
        ).toHaveText(
          "vectory release sign --key team.key --checksums SHA256SUMS release.json",
        );
        await expect(
          waiting.getByText(
            "from the project's release page or from your own build",
            { exact: false },
          ),
        ).toBeVisible();
        await expect(
          waiting.getByText("a list from the server would only check", {
            exact: false,
          }),
        ).toBeVisible();
        await expect(waiting.getByLabel("Signature file")).toBeVisible();
        // Rollouts, with the deployments page's bar.
        await expect(
          page.getByRole("link", { name: "Edge fleet, second wave" }).first(),
        ).toBeVisible();
        await expect(
          page.getByText("Cancelled: its release was withdrawn").first(),
        ).toBeVisible();
        await look("devices-updates", view);
      }
    },
  );

  await check(
    "Devices: prepare a release, sign it with a file, withdraw it",
    async () => {
      await load({ path: "agent-updates", scenario: richState() });
      // Prepare: the server copies a catalog build; with a key kept offline it
      // then waits for a signature, and no host is offered it before that.
      await page.getByRole("button", { name: "Roll out agent 0.1.3" }).click();
      const prepare = page.getByRole("dialog", { name: "Prepare agent 0.1.3" });
      await expect(prepare).toContainText(
        "It then waits for your signature: nothing is offered until you sign it with the key you keep offline.",
      );
      await look("devices-prepare");
      await prepare.getByRole("button", { name: "Prepare release" }).click();
      await expect(
        page.getByText(
          "Agent 0.1.3 is prepared. It waits for your signature below.",
        ),
      ).toBeVisible();
      expect(state.writes.at(-1)).toEqual({
        route: "prepare",
        body: { version: "0.1.3" },
      });
      await expect(
        page
          .getByRole("article", { name: "Agent 0.1.3" })
          .getByRole("heading", { name: "Waiting for your signature" }),
      ).toBeVisible();

      // A file that isn't a signature file is named as such and can't be sent.
      const waiting = page.getByRole("article", { name: "Agent 0.1.2" });
      const chooser = waiting.getByLabel("Signature file");
      await chooser.setInputFiles({
        name: "release.json.sig",
        mimeType: "application/json",
        buffer: Buffer.from("not json at all"),
      });
      await expect(waiting.getByRole("alert")).toBeVisible();
      await expect(
        waiting.getByRole("button", { name: "Upload signature" }),
      ).toBeDisabled();
      // A real one names the key it is by, before anything is sent.
      await chooser.setInputFiles({
        name: "release.json.sig",
        mimeType: "application/json",
        buffer: Buffer.from(signatureFile),
      });
      await expect(
        waiting.getByText(
          `release.json.sig holds a signature by key ${teamFingerprint.slice(0, 16)}, the current key. The server verifies it.`,
        ),
      ).toBeVisible();
      await waiting.getByRole("button", { name: "Upload signature" }).click();
      await expect(
        page.getByText("Signature accepted. Agent 0.1.2 is ready to roll out."),
      ).toBeVisible();
      expect(state.writes.at(-1)).toMatchObject({
        route: "signature",
        id: id(31),
        bytes: signatureFile,
      });
      await expect(
        page.getByRole("heading", { name: "Waiting for your signature" }),
      ).toHaveCount(1);

      // Withdraw: a reason, and the rollouts it will cancel, named first.
      await page
        .getByRole("article", { name: "Agent 0.1.1" })
        .getByRole("button", { name: "Withdraw…" })
        .click();
      const withdraw = page.getByRole("dialog", {
        name: "Withdraw agent 0.1.1",
      });
      await expect(withdraw).toContainText(
        "1 update rollout of this release is running and will be cancelled.",
      );
      await expect(
        withdraw.getByRole("button", { name: "Withdraw release" }),
      ).toBeDisabled();
      await withdraw.getByLabel("Reason").fill("It crashes on arm64");
      await look("devices-withdraw");
      await withdraw.getByRole("button", { name: "Withdraw release" }).click();
      await expect(page.getByText("Agent 0.1.1 was withdrawn.")).toBeVisible();
      expect(state.writes.at(-1)).toEqual({
        route: "withdraw",
        body: { reason: "It crashes on arm64" },
      });
    },
  );

  await check("Devices: Stop all updates, then the stop is shown", async () => {
    await load({
      role: "operator",
      path: "agent-updates",
      scenario: richState(),
    });
    // Operators stop updates and start rollouts; preparing and signing a
    // release is for administrators.
    await expect(
      page.getByRole("button", { name: "Roll out agent 0.1.3" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("An administrator prepares it first."),
    ).toBeVisible();
    await expect(
      page.getByText("Only an administrator can upload the signature."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Stop all updates" }).click();
    const stop = page.getByRole("dialog", { name: "Stop all updates" });
    await expect(stop).toContainText(
      "Cancels every update rollout and withdraws every offer. Devices already trying a build finish, and a device that already downloaded it may still start within about a minute.",
    );
    await expect(
      stop.getByRole("button", { name: "Stop all updates" }),
    ).toBeDisabled();
    await stop.getByLabel("Reason").fill("The 0.1.1 build crashes on arm64");
    await look("devices-stop");
    await stop.getByRole("button", { name: "Stop all updates" }).click();
    await expect(
      page.getByText(
        "All agent updates are stopped. Every update rollout was cancelled.",
      ),
    ).toBeVisible();
    expect(state.writes.at(-1)).toEqual({
      route: "stop",
      body: { reason: "The 0.1.1 build crashes on arm64" },
    });
    await expect(
      page.getByRole("status").filter({
        hasText: "All agent updates are stopped",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop all updates" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Roll out agent/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "New update rollout" }),
    ).toHaveCount(0);
    // The stop, as everyone reads it afterwards.
    for (const view of views) {
      await load({
        ...view,
        path: "agent-updates",
        scenario: richState({
          updates: {
            ...richState().updates,
            stopped: {
              reason: "The 0.1.1 build crashes on arm64",
              by_name: "Maria Costa",
              at: "2026-10-03T13:00:00Z",
            },
            active_rollouts: 0,
          },
        }),
      });
      await expect(
        page.getByText("All agent updates are stopped").first(),
      ).toBeVisible();
      await look("devices-stopped", view);
    }
  });

  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
} catch (error) {
  failure = error;
} finally {
  for (const done of state?.waiters || []) done();
  await context?.close();
  await browser.close();
  await vite.close();
  const source_sha256 = {};
  for (const file of [
    "dashboard/src/AgentUpdates.tsx",
    "dashboard/src/AgentUpdatesSettings.tsx",
    "dashboard/src/AgentUpdateReview.tsx",
    "dashboard/src/AgentUpdateRollout.tsx",
    "dashboard/src/agent-updates.css",
    "dashboard/tests/agent-update-replies.mjs",
    "dashboard/tests/agent-updates-browser.mjs",
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
          "Actual App with an isolated synthetic transport. Every key is a published test key; no real device, key, signature or mutation.",
        results,
        requests: requests.length,
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
