// The actual App on every screen of agent updates. Every API response is
// synthetic (agent-update-replies.mjs and fleet-replies.mjs); no real device,
// key or mutation. Each screen is looked at in light, dark and at 390 px.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import {
  fleetReplies,
  nothingOffered,
  slimOverview,
} from "./fleet-replies.mjs";
import { syntheticChannel } from "./notification-fixtures.mjs";
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
let totalRequests = 0;
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
  releases: [
    {
      name: "vectory-0.1.0-linux-amd64",
      os: "linux",
      arch: "amd64",
      version: "0.1.0",
      sha256: "a".repeat(64),
      size: 12_000_000,
      url: "/api/v1/releases/vectory-0.1.0-linux-amd64",
      signed: false,
    },
  ],
  catalog_problems: [],
});

const emptyPage = (url) => ({
  items: [],
  total: 0,
  page: Number(url.searchParams.get("page") || 1),
  page_size: Number(url.searchParams.get("page_size") || 12),
});
/** The reads other pages make on their way (the device page, Add device). */
function elsewhere(method, apiPath, url, body) {
  const ok = (json, status = 200) => ({ status, json });
  if (method === "GET") {
    if (apiPath === "/agent-install") return ok(installFor());
    if (apiPath === "/settings") return ok({ instance_name: "Synthetic" });
    if (apiPath === "/agent-install/activity")
      return ok({ events: [], now: new Date().toISOString() });
    if (apiPath === "/devices") return ok(state.devices());
    if (apiPath === "/groups") return ok(groups());
    if (apiPath === "/releases") return ok([]);
    if (apiPath === "/tokens") return ok(state.tokens);
    if (apiPath.startsWith("/tokens/requests/"))
      return ok({
        request_id: apiPath.split("/").at(-1),
        request_correlation: true,
        found: false,
      });
    if (/^\/devices\/[^/]+\/telemetry$/.test(apiPath))
      return ok({ device_id: apiPath.split("/")[2], samples: [] });
    if (/^\/devices\/[^/]+\/configuration$/.test(apiPath))
      return ok(nothingOffered(apiPath.split("/")[2]));
    if (apiPath === "/audit/history") return ok(emptyPage(url));
    if (apiPath === "/overview")
      return ok(slimOverview(state.devices(), state.overview ?? {}));
    // The Overview's other reads: no rollouts have stopped, and no summary yet.
    if (apiPath === "/deployments/history")
      return ok({ items: [], total: 0, page: 1, page_size: 5 });
    if (apiPath === "/telemetry/summary")
      return ok({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    if (apiPath === "/issues/groups" || apiPath === "/issues/history") {
      const items = state.issues ?? [];
      if (apiPath === "/issues/history")
        return ok({ ...emptyPage(url), items, total: items.length });
      return ok({
        ...emptyPage(url),
        items: items.length
          ? [
              {
                key: "AGENT_UPDATE_ROLLED_BACK",
                code: items[0].code,
                title: "Agents rolled back an update",
                message: items[0].message,
                diagnostics: [],
                version_id: null,
                version_number: null,
                configuration_id: null,
                configuration_name: null,
                deployment_ids: [],
                device_count: items.length,
                issue_count: items.length,
                attempts: items.length,
                reports: items.length,
                first_seen: items[0].first_seen,
                last_seen: items[0].last_seen,
                devices: items,
              },
            ]
          : [],
        total: items.length ? 1 : 0,
      });
    }
    if (apiPath === "/notifications/channels")
      return ok({ items: state.channels, max_channels: 20 });
    if (apiPath === "/notifications/deliveries") return ok(emptyPage(url));
    if (apiPath === "/configurations/library")
      return ok({ items: [], total: 0, page: 1, page_size: 50 });
  }
  if (method === "POST" && apiPath === "/notifications/preview") {
    const examples = {
      "agent_update.failed": [
        "Agent update rollout stopped: Agent 0.1.1",
        "More devices rolled back or failed than its failure threshold allows, so it stopped.",
        "error",
      ],
      "agent_update.rolled_back": [
        "edge-02 rolled back agent 0.1.1",
        "The new build didn't check in within 5 minutes, so the host took it back.",
        "warning",
      ],
      "agent_update.stopped": [
        "All agent updates were stopped",
        "An administrator used Stop all updates.",
        "warning",
      ],
      "agent_update.key_changed": [
        "The release key changed",
        "Agent updates were turned on, or a key was rotated, rolled over or revoked.",
        "warning",
      ],
    };
    const [headline, message, severity] = examples[body.type] ?? [
      "Example message",
      "An example of what this channel sends.",
      "warning",
    ];
    const link = "https://vectory.example.test/#/agent-updates";
    return ok({
      example: true,
      headline,
      message,
      context: `${severity === "error" ? "Error" : "Warning"} · Vectory`,
      link,
      webhook: {
        text: headline,
        blocks: [],
        event: {
          schema: "vectory.notification.v1",
          type: body.type,
          severity,
          recovery: false,
          headline,
          message,
          test: false,
          instance: "Vectory",
          url: link,
        },
      },
      email: {
        subject: `[Vectory] ${headline}`,
        body: `${headline}\n\n${message}\n\nOpen in Vectory: ${link}\n`,
      },
    });
  }
  if (method === "POST" && apiPath === "/notifications/channels") {
    state.channelBodies.push(body);
    const created = syntheticChannel({
      id: id(200 + state.channelBodies.length),
      name: body.name,
      kind: body.kind,
      enabled: body.enabled,
      allow_private: body.allow_private,
      rules: body.rules,
      webhook: {
        url_hint: `${new URL(body.webhook.url).origin}/…`,
        host: new URL(body.webhook.url).hostname,
        header_name: null,
        signing_secret_set: false,
        header_value_set: false,
      },
    });
    state.channels.push(created);
    return ok(created);
  }
  if (method === "POST" && apiPath === "/tokens") {
    state.tokenBodies.push(body);
    const record = {
      id: id(100 + state.tokenBodies.length),
      name: body.name,
      created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      expires_at: new Date(Date.now() + 3600000)
        .toISOString()
        .replace(/\.\d+Z$/, "Z"),
      uses: 0,
      max_uses: body.max_uses,
      name_prefix: body.name_prefix,
      revoked: false,
    };
    state.tokens = [record];
    return ok({
      request_id: body.request_id,
      request_correlation: true,
      token: "synthetic-unused-enrollment-token",
      record,
    });
  }
  return null;
}

async function load({
  role = "admin",
  width = 1100,
  theme = "light",
  path = "agent-updates-settings",
  scenario = onState(),
  devices = fleetDevices,
} = {}) {
  if (context) await context.close();
  // The requests a check reads are the ones its own page made.
  requests.length = 0;
  state = scenario;
  state.role = role;
  state.tokens = [];
  state.channels = [];
  state.channelBodies = [];
  state.devices = devices;
  state.tokenBodies = [];
  fleet = fleetReplies({
    devices: () => state.devices(),
    groups,
    agentUpdates: () => state.updates.enabled,
  });
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
    totalRequests++;
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
    // A reply that never arrives: the server did what it was asked, and the
    // page is told nothing. (state.lose = { match: /POST \/agent.../, times: 1 })
    if (
      given &&
      state.lose?.times > 0 &&
      state.lose.match.test(`${method} ${apiPath}`)
    ) {
      state.lose.times -= 1;
      state.lost = (state.lost || 0) + 1;
      return route.abort("connectionreset");
    }
    if (given) return send(given);
    const other = elsewhere(method, apiPath, url, body);
    if (other) return send(other);
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
  // A dialog is fixed to the window, so it is pictured in a taller window
  // (it grows to fit its content) rather than as a page.
  const dialog = (await page.getByRole("dialog").count()) > 0;
  if (dialog) await page.setViewportSize({ width, height: 1700 });
  await page.screenshot({
    path: resolve(output, file),
    fullPage: !dialog,
    animations: "disabled",
  });
  if (dialog) await page.setViewportSize({ width, height: 900 });
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
 * A rollout in the middle of its first batch: the canary passed, the batch is
 * being watched, one device rolled back and one failed, and the rest are at
 * each step an update has.
 */
const liveRollout = () => {
  const counts = {
    ...noCounts,
    verified: 9,
    rolled_back: 1,
    failed: 1,
    applying: 2,
    waiting_for_host: 1,
    waiting_for_window: 1,
    offered: 3,
    pending: 23,
  };
  const live = rollout({
    state_counts: counts,
    observation_started_at: new Date(Date.now() - 60000).toISOString(),
  });
  const detail = detailBody({
    ...live,
    stages: [
      {
        kind: "canary",
        index: 0,
        state: "passed",
        released_at: "2026-10-03T12:31:00Z",
        size: 1,
        counts: { verified: 1 },
        devices: [
          {
            device_id: id(1),
            device_name: "edge-01",
            state: "verified",
            code: null,
          },
        ],
        more: 0,
      },
      {
        kind: "batch",
        index: 1,
        state: "observing",
        released_at: "2026-10-03T12:40:00Z",
        size: 10,
        counts: { verified: 8, rolled_back: 1, failed: 1 },
        devices: [
          {
            device_id: id(2),
            device_name: "edge-02",
            state: "rolled_back",
            code: "NO_CHECK_IN",
          },
          {
            device_id: id(3),
            device_name: "edge-03",
            state: "failed",
            code: "DOWNLOAD_FAILED",
          },
          {
            device_id: id(4),
            device_name: "edge-04",
            state: "verified",
            code: null,
          },
        ],
        more: 7,
      },
      {
        kind: "batch",
        index: 2,
        state: "queued",
        released_at: null,
        size: 10,
        counts: { pending: 10 },
        devices: [],
        more: 10,
      },
    ],
    failures: [
      {
        state: "rolled_back",
        code: "NO_CHECK_IN",
        message: null,
        count: 1,
        device_ids: [id(2)],
        devices: [{ device_id: id(2), device_name: "edge-02" }],
      },
      {
        state: "failed",
        code: "DOWNLOAD_FAILED",
        message: null,
        count: 1,
        device_ids: [id(3)],
        devices: [{ device_id: id(3), device_name: "edge-03" }],
      },
    ],
    evaluated_at: new Date().toISOString(),
  });
  const row = (n, name, stateName, over = {}) =>
    targetRow({
      device_id: id(n),
      device_name: name,
      state: stateName,
      stage: 1,
      ...over,
    });
  return {
    live,
    detail,
    targets: [
      targetRow(),
      row(2, "edge-02", "rolled_back", { code: "NO_CHECK_IN" }),
      row(3, "edge-03", "failed", { code: "DOWNLOAD_FAILED" }),
      row(4, "edge-04", "waiting_for_host"),
      row(5, "edge-05", "waiting_for_window"),
      row(6, "edge-06", "applying"),
      row(7, "edge-07", "offered"),
      row(8, "edge-08", "pending", { stage: null, from_version: null }),
    ],
  };
};
const liveState = (over = {}) => {
  const { live, detail, targets } = liveRollout();
  return richState({
    rollouts: [live],
    details: { [live.id]: detail },
    targets: { [live.id]: targets },
    ...over,
  });
};

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
    await expect(
      stop.getByRole("link", { name: "What stopping does" }),
    ).toHaveAttribute("href", "/help/agent-updates/#stop-all-updates");
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

  /** Opens the review of 0.1.1 and reviews the whole Edge fleet group. */
  async function reviewTheGroup() {
    await page
      .getByRole("article", { name: "Agent 0.1.1" })
      .getByRole("button", { name: "Update devices…" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Roll out agent 0.1.1" });
    await expect(
      dialog.getByRole("button", { name: "Review", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("checkbox", { name: /Edge fleet/ }).check();
    await dialog.getByRole("button", { name: "Review", exact: true }).click();
    await expect(
      dialog.getByRole("heading", { name: "Will update · 2" }),
    ).toBeVisible();
    return dialog;
  }

  await check(
    "Review: who will and won't update, and the commands that fix hosts",
    async () => {
      for (const view of views) {
        await load({ ...view, path: "agent-updates", scenario: richState() });
        await page
          .getByRole("article", { name: "Agent 0.1.1" })
          .getByRole("button", { name: "Update devices…" })
          .click();
        const choose = page.getByRole("dialog", {
          name: "Roll out agent 0.1.1",
        });
        // Nothing is chosen for anyone: Review waits for devices.
        await expect(
          choose.getByRole("button", { name: "Review", exact: true }),
        ).toBeDisabled();
        await expect(choose).toContainText("Choose devices or groups first.");
        // There is no all-at-once, and the canary comes first.
        await expect(choose).toContainText("There is no all-at-once.");
        await expect(choose.getByLabel("Canary size")).toHaveValue("1");
        await look("review-choose", view);
        await choose.getByRole("checkbox", { name: /Edge fleet/ }).check();
        await choose
          .getByRole("button", { name: "Review", exact: true })
          .click();
        await expect(
          choose.getByRole("heading", { name: "Will update · 2" }),
        ).toBeVisible();
        // The review is a read: the request names the group and the settings.
        expect(state.writes.at(-1)).toEqual({
          route: "preview",
          body: {
            release_id: id(30),
            selector: { device_ids: [], group_ids: [id(50)], exclude_ids: [] },
            rollout: {
              canary_size: 1,
              batch_size: 10,
              observation_seconds: 300,
              failure_threshold: 0,
            },
          },
        });
        await expect(
          choose.getByRole("heading", { name: "Won't update · 3" }),
        ).toBeVisible();
        await expect(
          choose.getByRole("link", { name: "How to read this review" }),
        ).toHaveAttribute("href", "/help/agent-updates/#read-the-review");
        await expect(choose).toContainText(
          "Agent 0.1.1 goes to 2 of 5 devices you chose, a canary of 1 first, then batches of 10.",
        );
        await expect(
          choose.getByText("The canary's result is what its devices report.", {
            exact: false,
          }),
        ).toBeVisible();
        // Each reason the server gave, with the devices it names.
        await expect(
          choose.getByText(
            "edge-04 tried 0.1.1 and rolled back; it takes the next release.",
          ),
        ).toBeVisible();
        await expect(
          choose.getByText(
            `Two successors of its key: ${nextFingerprint.slice(0, 16)} and ${finalFingerprint.slice(0, 16)}. This server signs with neither.`,
          ),
        ).toBeVisible();
        await look("review-groups", view);
      }
    },
  );

  await check(
    "Review: host commands made from what each host reported",
    async () => {
      await load({ path: "agent-updates", scenario: richState() });
      const dialog = await reviewTheGroup();
      // A host that is off needs a choice from a person before any command.
      const off = dialog.locator("article", {
        hasText: "Updates are off on edge-03.",
      });
      await off.getByText("Commands for the host").click();
      await expect(
        off.getByRole("radio", { name: /Automatic \(recommended\)/ }),
      ).not.toBeChecked();
      await expect(
        off.getByRole("radio", { name: /Ask on the host/ }),
      ).not.toBeChecked();
      await expect(off.getByLabel(/^Upgrade command for/)).toHaveCount(0);
      await off
        .getByRole("radio", { name: /Automatic \(recommended\)/ })
        .check();
      const command = off.getByLabel("Upgrade command for edge-03", {
        exact: true,
      });
      await expect(command).toContainText("--updates auto");
      await expect(command).toContainText(
        `--update-key-sha256 ${teamFingerprint}`,
      );
      await expect(command).toContainText("--update-track patch");
      // A host that already takes updates keeps what it reported, and only
      // pins this server's current key.
      const fork = dialog.locator("article", {
        hasText: "edge-05 saw two successors",
      });
      await fork.getByText("Commands for the host").click();
      const kept = fork.getByLabel("Upgrade command for edge-05", {
        exact: true,
      });
      await expect(kept).toContainText("--updates auto");
      await expect(kept).toContainText("--update-window");
      await expect(kept).toContainText(
        `--update-key-sha256 ${teamFingerprint}`,
      );
      await look("review-commands");
    },
  );

  await check(
    "Review: hosts that pin the current key can't take a release an older key signed, and no command pretends they can",
    async () => {
      // The key was rotated after the release was signed: the release names
      // the old key, the settings the new one, and the host pins the new one.
      const scenario = richState();
      scenario.updates.current_key = releaseKey({
        fingerprint: nextFingerprint,
        public_key: nextLine,
      });
      scenario.preview = previewBody({
        will_update: [],
        wont_update: [
          {
            code: "KEY_NOT_PINNED",
            reason:
              "edge-06 pins no key that reaches the key that signed 0.1.1.",
            fix: "Run the Upgrade agent command so the host pins the current release key.",
            devices: [
              { device_id: id(6), device_name: "edge-06", successors: null },
            ],
          },
        ],
        warnings: [],
      });
      await load({ path: "agent-updates", scenario });
      await page
        .getByRole("article", { name: "Agent 0.1.1" })
        .getByRole("button", { name: "Update devices…" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Roll out agent 0.1.1" });
      await dialog.getByRole("checkbox", { name: /Edge fleet/ }).check();
      await dialog.getByRole("button", { name: "Review", exact: true }).click();
      const group = dialog.locator("article", { hasText: "edge-06" });
      await expect(group).toContainText(
        "edge-06 pins no key that reaches the key that signed 0.1.1.",
      );
      // The server's own fix names a command; here it would change nothing.
      await expect(group).toContainText(
        `This release was signed by key ${teamFingerprint.slice(0, 16)}, not the current key ${nextFingerprint.slice(0, 16)}. Withdraw this release and prepare it again`,
      );
      await expect(group).not.toContainText(
        "Run the Upgrade agent command so the host pins the current release key.",
      );
      await expect(group.getByText("Commands for the host")).toHaveCount(0);
      await look("review-older-key");
    },
  );

  await check("Review: start the rollout the review described", async () => {
    await load({ path: "agent-updates", scenario: richState() });
    const dialog = await reviewTheGroup();
    await dialog.getByRole("button", { name: "Start update rollout" }).click();
    await expect(
      page.getByText("Update rollout started. Its canary is released first."),
    ).toBeVisible();
    const created = state.writes.at(-1);
    expect(created.route).toBe("create");
    expect(created.body).toMatchObject({
      release_id: id(30),
      selector: { device_ids: [], group_ids: [id(50)], exclude_ids: [] },
      rollout: {
        canary_size: 1,
        batch_size: 10,
        observation_seconds: 300,
        failure_threshold: 0,
      },
      review_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    await expect(page).toHaveURL(new RegExp(`#/agent-updates/${id(44)}$`));
    await expect(
      page.getByRole("region", { name: "Update rollout details" }),
    ).toBeVisible();
  });

  await check("Review: a review that went stale starts nothing", async () => {
    await load({ path: "agent-updates", scenario: richState() });
    state.staleReview = true;
    const dialog = await reviewTheGroup();
    await dialog.getByRole("button", { name: "Start update rollout" }).click();
    await expect(
      dialog.getByText(
        "Something changed since this review (a device, a release or its key). Review again before you start.",
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText("The review is out of date.", { exact: false }),
    ).toBeVisible();
    // The dialog stays, nothing was created, and starting waits for a new review.
    await expect(
      dialog.getByRole("button", { name: "Start update rollout" }),
    ).toBeDisabled();
    expect(state.writes.some((write) => write.route === "create")).toBe(false);
    expect(state.rollouts).toHaveLength(3);
    await look("review-stale");
    state.staleReview = false;
    await dialog.getByRole("button", { name: "Review again" }).click();
    await dialog.getByRole("button", { name: "Start update rollout" }).click();
    await expect(page).toHaveURL(/#\/agent-updates\//);
    expect(
      state.writes.filter((write) => write.route === "create"),
    ).toHaveLength(1);
  });

  await check(
    "Review: an unanswered start is asked again with the same request, never a new one",
    async () => {
      await load({ path: "agent-updates", scenario: richState() });
      state.lose = { match: /^POST \/agent-update-rollouts$/, times: 1 };
      const dialog = await reviewTheGroup();
      await dialog
        .getByRole("button", { name: "Start update rollout" })
        .click();
      await expect(
        dialog.getByText("We couldn't confirm the rollout started"),
      ).toBeVisible();
      // The server did start it, and the page doesn't claim otherwise.
      expect(
        state.writes.filter((write) => write.route === "create"),
      ).toHaveLength(1);
      expect(state.rollouts).toHaveLength(4);
      await expect(page).toHaveURL(/#\/agent-updates$/);
      // Nothing is sent again by itself.
      const creates = () =>
        requests.filter(
          (request) =>
            request.method === "POST" &&
            request.path === "/agent-update-rollouts",
        );
      await page.waitForTimeout(800);
      expect(creates()).toHaveLength(1);
      await look("review-unconfirmed");
      await dialog
        .getByRole("button", { name: "Send the same request again" })
        .click();
      await expect(page).toHaveURL(/#\/agent-updates\//);
      // The same identity and body went twice; the server made one rollout.
      const sent = creates();
      expect(sent).toHaveLength(2);
      expect(sent[1].body).toEqual(sent[0].body);
      expect(sent[1].body.request_id).toBeTruthy();
      expect(state.rollouts).toHaveLength(4);
    },
  );

  await check(
    "Rollout: progress, stages, why devices rolled back, and each device",
    async () => {
      for (const view of views) {
        await load({
          ...view,
          path: `agent-updates/${id(40)}`,
          scenario: liveState(),
        });
        await expect(heading("Agent 0.1.1")).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Agent updates" }).first(),
        ).toBeVisible();
        await expect(page.locator("a.page-help-link")).toHaveAttribute(
          "href",
          "/help/agent-updates/#watch-a-rollout",
        );
        // A device is updated only from what it reports after the restart.
        await expect(
          page.getByText(
            "A device is updated when it checks in on the new build after the restart and its host reports it healthy.",
          ),
        ).toBeVisible();
        const progress = page.getByRole("region", {
          name: "Rollout progress",
        });
        await expect(progress).toContainText("9 of 41 devices updated");
        await expect(progress).toContainText("1 rolled back");
        await expect(progress).toContainText("1 failed");
        // Stages, the watched one with its countdown.
        const lanes = page.getByRole("list", { name: "Release stages" });
        await expect(
          lanes.getByRole("listitem").filter({ hasText: "Canary" }).first(),
        ).toBeVisible();
        await expect(lanes).toContainText("8 of 10 updated");
        await expect(lanes.getByRole("timer")).toContainText("Next batch in");
        // Why devices rolled back or failed, in the agent's words.
        const why = page.getByRole("region", {
          name: "Why devices rolled back or failed",
        });
        await expect(why).toContainText(
          "The new build didn't check in within 5 minutes.",
        );
        await expect(why).toContainText(
          "A device that rolled back never tries this release again. It takes the next one.",
        );
        await expect(
          why.getByRole("link", { name: "edge-02" }),
        ).toHaveAttribute("href", `#/devices/${id(2)}`);
        await expect(why).toContainText("The download failed.");
        // Each device, with where it is.
        const table = page.getByRole("region", {
          name: "Device results",
          exact: true,
        });
        await expect(table).toContainText("edge-01");
        await expect(table).toContainText("Waiting for the host");
        await expect(table).toContainText(
          "Staged. Waiting for someone on the host to run vectory update apply.",
        );
        await look("rollout", view);
      }
      // A search and a state narrow what the server returns.
      const table = page.getByRole("region", {
        name: "Device results",
        exact: true,
      });
      await table
        .getByRole("textbox", { name: "Search rollout devices" })
        .fill("edge-02");
      await expect(table.getByRole("link", { name: "edge-02" })).toBeVisible();
      await expect(table.getByRole("link", { name: "edge-04" })).toHaveCount(0);
      expect(
        requests.some(
          (request) =>
            request.path === `/agent-update-rollouts/${id(40)}/targets` &&
            request.query.includes("search=edge-02"),
        ),
      ).toBe(true);
    },
  );

  await check("Rollout: pause, resume and cancel send no body", async () => {
    await load({ path: `agent-updates/${id(40)}`, scenario: liveState() });
    const post = (verb) =>
      requests.filter(
        (request) =>
          request.method === "POST" &&
          request.path === `/agent-update-rollouts/${id(40)}/${verb}`,
      );
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const pause = page.getByRole("dialog", { name: "Pause rollout" });
    await expect(pause).toContainText(
      "Offers that haven't started applying are withdrawn",
    );
    await look("rollout-pause");
    await pause.getByRole("button", { name: "Pause rollout" }).click();
    await expect(
      page.getByText("Rollout paused. Devices already applying finish."),
    ).toBeVisible();
    expect(post("pause")).toHaveLength(1);
    expect(post("pause")[0].body).toBeNull();
    await expect(
      page.getByText("Paused", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Resume rollout" })
      .getByRole("button", { name: "Resume rollout" })
      .click();
    await expect(page.getByText("Rollout resumed.")).toBeVisible();
    expect(post("resume")).toHaveLength(1);
    expect(post("resume")[0].body).toBeNull();
    // Cancel is final, and says what it leaves.
    await page.getByRole("button", { name: "Cancel rollout" }).click();
    const cancel = page.getByRole("dialog", { name: "Cancel rollout" });
    await expect(cancel).toContainText(
      "A cancelled rollout is never resumed: review a new one to update the rest.",
    );
    await cancel.getByRole("button", { name: "Cancel rollout" }).click();
    await expect(
      page.getByText("Rollout cancelled. Devices already applying finish."),
    ).toBeVisible();
    expect(post("cancel")).toHaveLength(1);
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Cancel rollout" }),
    ).toHaveCount(0);
    expect(state.writes.map((write) => write.route)).toEqual([
      "pause",
      "resume",
      "cancel",
    ]);
  });

  await check(
    "Rollout: an action with no answer is checked, never sent again",
    async () => {
      await load({ path: `agent-updates/${id(40)}`, scenario: liveState() });
      state.lose = {
        match: /^POST \/agent-update-rollouts\/[^/]+\/pause$/,
        times: 1,
      };
      const pauses = () =>
        requests.filter(
          (request) =>
            request.method === "POST" && request.path.endsWith("/pause"),
        );
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Pause rollout" });
      await dialog.getByRole("button", { name: "Pause rollout" }).click();
      await expect(
        dialog.getByText(
          "The response couldn't be confirmed. Check the rollout's current status before trying this action again.",
        ),
      ).toBeVisible();
      await look("rollout-unconfirmed");
      await expect(
        dialog.getByRole("button", { name: "Pause rollout" }),
      ).toHaveCount(0);
      await page.waitForTimeout(800);
      expect(pauses()).toHaveLength(1);
      // The status is read, not guessed: the pause had been applied.
      await dialog
        .getByRole("button", { name: "Check current status" })
        .click();
      await expect(
        page.getByRole("button", { name: "Resume", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("The previous action may have completed."),
      ).toHaveCount(0);
      expect(pauses()).toHaveLength(1);
    },
  );

  await check("Rollout: read only for a viewer", async () => {
    await load({
      role: "viewer",
      path: `agent-updates/${id(40)}`,
      scenario: liveState(),
    });
    await expect(heading("Agent 0.1.1")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Cancel rollout" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Resume", exact: true }),
    ).toHaveCount(0);
  });

  const groupsOf = (fingerprint) => fingerprint.match(/.{1,8}/g).join(" ");
  /** Updates off, but a key kept from before: turning on again can keep it. */
  const offWithKey = (custody = "offline") =>
    offState({
      updates: updatesBody({
        enabled: false,
        custody,
        current_key: releaseKey({ custody }),
        active_rollouts: 0,
        fleet: null,
        catalog: null,
        frozen_devices: null,
      }),
      keys: [releaseKey({ custody })],
    });

  await check(
    "Settings: turn on with a key kept offline, the fingerprint made here, the password",
    async () => {
      await load({ scenario: offState() });
      await page
        .getByRole("button", { name: "Turn on agent updates…" })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Turn on agent updates",
      });
      // Nothing is chosen for the team, and nothing can be sent yet.
      await expect(
        dialog.getByRole("radio", { name: /This server signs/ }),
      ).not.toBeChecked();
      await expect(
        dialog.getByRole("radio", { name: /A key kept offline/ }),
      ).not.toBeChecked();
      await expect(
        dialog.getByRole("button", { name: "Turn on agent updates" }),
      ).toBeDisabled();
      await expect(dialog).toContainText(
        "Anyone who administers this server, or holds a backup of it, can approve builds that every opted-in host installs.",
      );
      await look("settings-turn-on");
      await dialog.getByRole("radio", { name: /A key kept offline/ }).check();
      // A line that isn't a key says what is wrong with it.
      const field = dialog.getByLabel("Public key");
      await field.fill("not a key");
      // Nothing is said while the person is still typing; leaving the field does.
      await field.blur();
      await expect(dialog.getByRole("alert")).toContainText(
        "This isn't a release key line.",
      );
      await expect(
        dialog.getByRole("button", { name: "Turn on agent updates" }),
      ).toBeDisabled();
      // A key's fingerprint is computed in the browser from what was pasted.
      await field.fill(teamLine);
      await expect(dialog.locator(".update-key-preview")).toContainText(
        "Fingerprint of this key (named team)",
      );
      await expect(
        dialog.getByLabel(`Fingerprint: ${groupsOf(teamFingerprint)}`),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Turn on agent updates" }),
      ).toBeDisabled();
      await look("settings-turn-on-key");
      // The password is asked for, sent once and asked for again when wrong.
      await dialog.getByLabel("Your password").fill("not the password");
      await dialog
        .getByRole("button", { name: "Turn on agent updates" })
        .click();
      await expect(dialog).toContainText("Your password didn't match.");
      await expect(dialog.getByLabel("Your password")).toHaveValue("");
      expect(state.writes).toHaveLength(0);
      await dialog.getByLabel("Your password").fill("correct horse");
      await dialog
        .getByRole("button", { name: "Turn on agent updates" })
        .click();
      await expect(
        page.getByText(
          "Agent updates are on. Hosts pin the key when you add or upgrade them.",
        ),
      ).toBeVisible();
      expect(state.writes).toEqual([
        {
          route: "settings",
          body: {
            enabled: true,
            custody: { kind: "offline", public_key: teamLine },
            current_password: "correct horse",
            revision: 0,
          },
        },
      ]);
      await expect(
        page.getByRole("heading", { name: "Agent updates are on" }),
      ).toBeVisible();
      await expect(
        page.getByLabel(`Fingerprint: ${groupsOf(teamFingerprint)}`).first(),
      ).toBeVisible();
    },
  );

  await check(
    "Settings: the other way to hold the key warns before the password",
    async () => {
      for (const view of views) {
        await load({ ...view, scenario: offWithKey("offline") });
        await expect(
          page.getByText("You choose again when you turn updates on."),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Turn on agent updates…" })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "Turn on agent updates",
        });
        // The same way keeps the key: nothing to paste, nothing to re-pin.
        await dialog.getByRole("radio", { name: /A key kept offline/ }).check();
        await expect(dialog).toContainText(
          `Keeps the key you have, ${teamFingerprint.slice(0, 16)}. Hosts that pin it need nothing.`,
        );
        await expect(dialog.getByLabel("Public key")).toHaveCount(0);
        await expect(
          dialog.getByText("Hosts enrolled with the current key keep it."),
        ).toHaveCount(0);
        // The other way makes a new key, and says what that costs.
        await dialog.getByRole("radio", { name: /This server signs/ }).check();
        const warning = dialog.getByText(
          "Hosts enrolled with the current key keep it. Each takes the new key only when you run its Upgrade agent command again.",
        );
        await expect(warning).toBeVisible();
        const warned = await warning.boundingBox();
        const asked = await dialog.getByLabel("Your password").boundingBox();
        expect(warned.y).toBeLessThan(asked.y);
        await look("settings-turn-on-other", view);
      }
      // Keeping the key sends no custody at all.
      await load({ scenario: offWithKey("offline") });
      await page
        .getByRole("button", { name: "Turn on agent updates…" })
        .click();
      const keep = page.getByRole("dialog", { name: "Turn on agent updates" });
      await keep.getByRole("radio", { name: /A key kept offline/ }).check();
      await keep.getByLabel("Your password").fill("correct horse");
      await keep.getByRole("button", { name: "Turn on agent updates" }).click();
      await expect(
        page.getByRole("heading", { name: "Agent updates are on" }),
      ).toBeVisible();
      expect(state.writes).toEqual([
        {
          route: "settings",
          body: {
            enabled: true,
            current_password: "correct horse",
            revision: 3,
          },
        },
      ]);
    },
  );

  await check(
    "Settings: rotate a key the server holds, upload a rollover for one kept offline",
    async () => {
      const server = releaseKey({ custody: "server" });
      await load({
        scenario: onState({
          updates: updatesBody({ custody: "server", current_key: server }),
          keys: [server],
        }),
      });
      await expect(page.getByText("This server signs").first()).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Upload rollover…" }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "Rotate key…" }).click();
      const rotate = page.getByRole("dialog", {
        name: "Rotate the release key",
      });
      await rotate.getByLabel("Your password").fill("correct horse");
      await rotate.getByRole("button", { name: "Rotate key" }).click();
      await expect(
        page.getByText(
          "Release key rotated. Hosts follow the statement to the new key by themselves.",
        ),
      ).toBeVisible();
      expect(state.writes.map((write) => write.route)).toEqual(["rotate"]);
      await expect(
        page.getByLabel(`Fingerprint: ${groupsOf(nextFingerprint)}`),
      ).toBeVisible();

      // A key kept offline is replaced by a statement it signed.
      await load({ scenario: onState() });
      await expect(
        page.getByRole("button", { name: "Rotate key…" }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "Upload rollover…" }).click();
      const dialog = page.getByRole("dialog", { name: "Upload a rollover" });
      await expect(
        dialog.getByRole("button", { name: "Upload rollover" }),
      ).toBeDisabled();
      await dialog.getByLabel("Rollover file").setInputFiles({
        name: "rollover.json",
        mimeType: "application/json",
        buffer: Buffer.from("{}"),
      });
      await expect(dialog.getByRole("alert")).toBeVisible();
      await dialog.getByLabel("Rollover file").setInputFiles({
        name: "rollover.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(rolloverEnvelope)),
      });
      await expect(dialog).toContainText(
        `Makes ${nextFingerprint.slice(0, 16)} (named team-next) the current key`,
      );
      await expect(
        dialog.getByLabel(`Fingerprint: ${groupsOf(nextFingerprint)}`),
      ).toBeVisible();
      await look("settings-rollover");
      await dialog.getByLabel("Your password").fill("correct horse");
      await dialog.getByRole("button", { name: "Upload rollover" }).click();
      await expect(
        page.getByText(
          "Rollover applied. Hosts follow the statement to the new key by themselves.",
        ),
      ).toBeVisible();
      expect(state.writes.at(-1).route).toBe("rollover");
      // A statement for another key than the current one is refused here.
      const next = releaseKey({
        fingerprint: nextFingerprint,
        public_key: nextLine,
      });
      await load({
        scenario: onState({
          updates: updatesBody({ current_key: next }),
          keys: [next],
        }),
      });
      await page.getByRole("button", { name: "Upload rollover…" }).click();
      const wrong = page.getByRole("dialog", { name: "Upload a rollover" });
      await wrong.getByLabel("Rollover file").setInputFiles({
        name: "rollover.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(rolloverEnvelope)),
      });
      await expect(wrong.getByRole("alert")).toContainText(
        `This statement replaces key ${teamFingerprint.slice(0, 16)}, but the current key is ${nextFingerprint.slice(0, 16)}.`,
      );
      await expect(
        wrong.getByRole("button", { name: "Upload rollover" }),
      ).toBeDisabled();
    },
  );

  await check(
    "Settings: revoke a key, turn off, and clear the stop",
    async () => {
      const retired = releaseKey({
        fingerprint: nextFingerprint,
        public_key: nextLine,
        state: "retired",
        devices_pinning: 3,
        device_names: ["edge-01", "edge-02", "edge-03"],
      });
      const current = releaseKey({ devices_pinning: 0, device_names: [] });
      await load({
        scenario: onState({
          updates: updatesBody({ current_key: current, active_rollouts: 0 }),
          keys: [current, retired],
          rollouts: [],
          releases: [],
        }),
      });
      await page
        .getByRole("button", {
          name: `Revoke key ${nextFingerprint.slice(0, 16)}`,
        })
        .click();
      const revoke = page.getByRole("dialog", {
        name: `Revoke key ${nextFingerprint.slice(0, 16)}`,
      });
      await expect(revoke).toContainText(
        "3 hosts pin it: they keep running, and accept no new build until you run their Upgrade agent command with a key they should trust.",
      );
      await expect(
        revoke.getByRole("button", { name: "Revoke key" }),
      ).toBeDisabled();
      await expect(
        revoke.getByRole("link", { name: "If a key is stolen" }),
      ).toHaveAttribute("href", "/help/agent-updates/#if-a-key-is-stolen");
      await revoke
        .getByLabel("Reason")
        .fill("The laptop that held it was lost");
      await revoke.getByLabel("Your password").fill("correct horse");
      await look("settings-revoke");
      await revoke.getByRole("button", { name: "Revoke key" }).click();
      await expect(
        page.getByText(
          `Key ${nextFingerprint.slice(0, 16)} revoked. Releases only it signed were withdrawn.`,
        ),
      ).toBeVisible();
      expect(state.writes.at(-1)).toEqual({
        route: "revoke",
        body: {
          reason: "The laptop that held it was lost",
          current_password: "correct horse",
        },
      });
      await expect(
        page.getByText("The laptop that held it was lost").first(),
      ).toBeVisible();

      // Turning off is refused while an update rollout runs, and says so first.
      await load({ scenario: onState() });
      await page.getByRole("button", { name: "Turn off…" }).click();
      const running = page.getByRole("dialog", {
        name: "Turn off agent updates",
      });
      await expect(running).toContainText(
        "An update rollout is running. Cancel it, or stop all updates, then turn updates off.",
      );
      await expect(
        running.getByRole("button", { name: "Turn off agent updates" }),
      ).toBeDisabled();
      await running.getByRole("button", { name: "Cancel" }).click();
      await load({
        scenario: onState({
          updates: updatesBody({ active_rollouts: 0 }),
          rollouts: [],
          releases: [],
        }),
      });
      await page.getByRole("button", { name: "Turn off…" }).click();
      const idle = page.getByRole("dialog", { name: "Turn off agent updates" });
      await idle.getByLabel("Your password").fill("correct horse");
      await idle
        .getByRole("button", { name: "Turn off agent updates" })
        .click();
      await expect(
        page.getByText(
          "Agent updates are off. The release key and the stop are kept for when they are turned on again.",
        ),
      ).toBeVisible();
      expect(state.writes.at(-1)).toEqual({
        route: "settings",
        body: {
          enabled: false,
          current_password: "correct horse",
          revision: 3,
        },
      });

      // The stop is cleared by an administrator, and resumes nothing.
      const stoppedAt = {
        reason: "The 0.1.1 build crashes on arm64",
        by_name: "Maria Costa",
        at: "2026-10-03T13:00:00Z",
      };
      for (const view of views) {
        await load({
          ...view,
          scenario: onState({
            updates: updatesBody({ stopped: stoppedAt, active_rollouts: 0 }),
          }),
        });
        await expect(
          page.getByText("All agent updates are stopped").first(),
        ).toBeVisible();
        await look("settings-stopped", view);
      }
      await page.getByRole("button", { name: "Clear the stop" }).click();
      const clear = page.getByRole("dialog", { name: "Clear the stop" });
      await expect(clear).toContainText("Clearing the stop resumes nothing.");
      await clear.getByRole("button", { name: "Clear the stop" }).click();
      await expect(
        page.getByText(
          "The stop is cleared. Nothing was resumed: the rollouts it cancelled stay cancelled.",
        ),
      ).toBeVisible();
      expect(state.writes.at(-1)).toEqual({
        route: "stop-clear",
        body: { revision: 3 },
      });
    },
  );

  await check(
    "Settings: on, read only for everyone but an administrator",
    async () => {
      for (const role of ["viewer", "editor", "operator"]) {
        await load({ role, scenario: onState() });
        await expect(
          page.getByRole("heading", { name: "Agent updates are on" }),
        ).toBeVisible();
        await expect(
          page.getByText("Only an administrator can change this."),
        ).toBeVisible();
        for (const name of [
          "Turn off…",
          "Upload rollover…",
          "Rotate key…",
          /^Revoke key/,
        ])
          await expect(page.getByRole("button", { name })).toHaveCount(0);
        // What the key is and who holds it is still plain to read.
        await expect(
          page.getByLabel(`Fingerprint: ${groupsOf(teamFingerprint)}`),
        ).toBeVisible();
      }
    },
  );

  /** One device, as the device page reads it, with the report it sent. */
  const one =
    (over = {}) =>
    () => [device(1, "edge-01", over)];
  const panel = () =>
    page.getByRole("region", { name: "Agent updates", exact: true });

  await check(
    "Device page: what the device reported about updates, never inferred",
    async () => {
      const cases = [
        {
          name: "automatic, waiting for its window",
          over: {
            agent_update: report({
              state: "waiting_for_window",
              release_version: "0.1.1",
            }),
          },
          text: [
            "Automatic · patch releases · Mon–Fri 02:00–04:00 · key 05cc6c02351af0cb",
            "Staged 0.1.1 · waiting for its update window",
          ],
        },
        {
          name: "ask, staged and waiting for someone on the host",
          over: {
            agent_update: report({
              consent: "ask",
              windows: [],
              state: "waiting_for_host",
              release_version: "0.1.1",
            }),
          },
          text: [
            "Ask on the host · patch releases · Any time · key 05cc6c02351af0cb",
            "Staged 0.1.1 · waiting for someone on edge-01",
          ],
          command: ["Apply command for edge-01", "sudo vectory update apply"],
        },
        {
          name: "off",
          over: {
            agent_update: report({ consent: "off", windows: [], keys: [] }),
          },
          text: [
            "Off on this host. Run the Upgrade agent command with updates on to let the dashboard update it.",
          ],
        },
        {
          name: "rolled back its last update",
          over: {
            agent_update: report({
              last: {
                release: "a".repeat(64),
                outcome: "rolled_back",
                code: "NO_CHECK_IN",
                at: "2026-10-03T12:20:00Z",
                from_version: "0.1.0",
                to_version: "0.1.1",
              },
            }),
          },
          text: [
            "Rolled back from 0.1.1: it didn't check in within 5 minutes. This device won't try 0.1.1 again; it takes the next release.",
          ],
        },
        {
          name: "updated, with how soon it checked in",
          over: {
            agent_update: report({
              last: {
                release: "a".repeat(64),
                outcome: "committed",
                code: null,
                at: "2026-10-03T12:20:00Z",
                from_version: "0.1.0",
                to_version: "0.1.1",
                first_check_in_ms: 1900,
              },
            }),
          },
          text: ["Updated 0.1.0 → 0.1.1", "first check-in 1.9 s after restart"],
        },
        {
          name: "frozen on a fork",
          over: {
            agent_update: report({
              state: "refused",
              code: "KEY_ROLLOVER_CONFLICT",
              rollover_conflict: {
                from: teamFingerprint,
                to: [nextFingerprint, finalFingerprint],
              },
            }),
          },
          text: [
            `Updates stopped on this host: two successors of key ${teamFingerprint.slice(0, 16)} were seen, ${nextFingerprint.slice(0, 16)} and ${finalFingerprint.slice(0, 16)}. Run the Upgrade agent command with the right key.`,
          ],
          link: ["What a fork means", "if-a-key-is-stolen"],
        },
        {
          name: "paused on the host",
          over: { agent_update: report({ paused: true }) },
          text: [
            "Paused on this host. Nothing downloads or applies until someone resumes updates there.",
          ],
          command: ["Resume command for edge-01", "sudo vectory update resume"],
        },
        {
          name: "a host that can't take updates",
          over: {
            agent_update: report({ eligibility: "PACKAGE_MANAGED" }),
          },
          text: ["A package manager owns this agent, so it updates it."],
          link: ["What a host needs", "what-a-host-needs-to-take-an-update"],
        },
        {
          name: "sent no report",
          over: {},
          text: [
            "Not reported",
            "Its last check-in carried no update report, so nothing is said about updates on this device.",
          ],
          absent: ["Automatic ·", "As this device reported it"],
        },
      ];
      for (const given of cases) {
        await load({
          path: `devices/${id(1)}`,
          scenario: onState(),
          devices: one(given.over),
        });
        await expect(panel(), given.name).toBeVisible();
        for (const text of given.text)
          await expect(panel(), `${given.name}: ${text}`).toContainText(text);
        for (const text of given.absent ?? [])
          await expect(panel(), given.name).not.toContainText(text);
        if (given.command) {
          await expect(
            panel().getByLabel(given.command[0], { exact: true }),
          ).toHaveText(given.command[1]);
        }
        // Where the page explains what it reports, the link goes to that part.
        if (given.link)
          await expect(
            panel().getByRole("link", { name: given.link[0] }),
            given.name,
          ).toHaveAttribute("href", `/help/agent-updates/#${given.link[1]}`);
      }
      // The state a device reports is a state, in words and a badge.
      await load({
        path: `devices/${id(1)}`,
        scenario: onState(),
        devices: one({ agent_update: report({ state: "trial" }) }),
      });
      await expect(panel()).toContainText(
        "Trying an agent build · the host takes it back by itself if it doesn't check in within 5 minutes",
      );
    },
  );

  await check(
    "Device page: the panel in light, dark and at phone width, and gone when updates are off",
    async () => {
      for (const view of views) {
        await load({
          ...view,
          path: `devices/${id(1)}`,
          scenario: onState(),
          devices: one({
            agent_update: report({
              state: "waiting_for_host",
              consent: "ask",
              windows: [],
              release_version: "0.1.1",
              last: {
                release: "a".repeat(64),
                outcome: "rolled_back",
                code: "UNHEALTHY",
                at: "2026-10-02T12:20:00Z",
                from_version: "0.1.0",
                to_version: "0.1.1",
              },
            }),
          }),
        });
        await expect(panel()).toContainText("Staged 0.1.1");
        await expect(panel()).toContainText(
          "Rolled back from 0.1.1: it started but wasn't healthy.",
        );
        await expect(
          panel().getByRole("link", { name: "What a rollback means" }),
        ).toHaveAttribute(
          "href",
          "/help/agent-updates/#when-a-host-rolls-back",
        );
        await look("device-updates", view);
      }
      // While updates are off there is nothing about them on the page.
      await load({
        path: `devices/${id(1)}`,
        scenario: offState(),
        devices: one({ agent_update: report() }),
      });
      await expect(
        page.getByRole("heading", { name: "edge-01", level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Agent updates", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText(/agent updates?\b/i)).toHaveCount(0);
    },
  );

  const upgradeDialog = () =>
    page.getByRole("dialog", { name: "Upgrade agent" });
  const openUpgrade = async () => {
    await page.getByRole("button", { name: "Upgrade agent" }).click();
    await expect(upgradeDialog()).toBeVisible();
    await expect(
      upgradeDialog().getByText("Checking available downloads…"),
    ).toHaveCount(0);
  };

  await check(
    "Upgrade agent: a host that takes no updates is opted in by one run, with a choice",
    async () => {
      for (const view of views) {
        await load({
          ...view,
          path: `devices/${id(1)}`,
          scenario: onState(),
          devices: one({
            agent_update: report({ consent: "off", windows: [], keys: [] }),
          }),
        });
        await openUpgrade();
        const dialog = upgradeDialog();
        await expect(
          dialog.getByRole("heading", { name: "Agent updates" }),
        ).toBeVisible();
        await expect(dialog).toContainText("Updates are off on this host.");
        // Nothing is chosen, and the command says so by what it leaves out.
        for (const name of [
          /^Automatic \(recommended\)/,
          /^Ask on the host/,
          /^Off/,
        ])
          await expect(dialog.getByRole("radio", { name })).not.toBeChecked();
        await expect(dialog).toContainText(
          "Without a choice the command only upgrades the agent. It doesn't change how this host takes updates.",
        );
        await expect(
          dialog.getByRole("link", { name: "What a host agrees to" }),
        ).toHaveAttribute("href", "/help/agent-updates/#what-a-host-agrees-to");
        const withoutChoice = await dialog
          .getByLabel("Upgrade command", { exact: true })
          .innerText();
        expect(withoutChoice).not.toMatch(/--update/);
        await look("upgrade-opt-in", view);
        await dialog
          .getByRole("radio", { name: /^Automatic \(recommended\)/ })
          .check();
        const chosen = dialog.getByLabel("Upgrade command", { exact: true });
        await expect(chosen).toContainText("--updates auto");
        await expect(chosen).toContainText(
          `--update-key-sha256 ${teamFingerprint}`,
        );
        await expect(chosen).toContainText("--update-track patch");
      }
      // A host that sent no report at all is told so, and gets the same choice.
      await load({
        path: `devices/${id(1)}`,
        scenario: onState(),
        devices: one({}),
      });
      await openUpgrade();
      await expect(upgradeDialog()).toContainText(
        "Its last check-in carried no update report.",
      );
      await upgradeDialog().getByRole("radio", { name: /^Off/ }).check();
      await expect(
        upgradeDialog().getByLabel("Upgrade command", { exact: true }),
      ).toContainText("--updates off");
    },
  );

  await check(
    "Upgrade agent: a host that takes updates is rolled out to, and can pin the key again",
    async () => {
      for (const view of views) {
        await load({
          ...view,
          path: `devices/${id(1)}`,
          scenario: onState(),
          devices: one({ agent_update: report() }),
        });
        await openUpgrade();
        const dialog = upgradeDialog();
        await expect(
          dialog.getByRole("heading", {
            name: "This device takes updates from the dashboard",
          }),
        ).toBeVisible();
        await expect(dialog).toContainText(
          "Automatic · patch releases · Mon–Fri 02:00–04:00 · key 05cc6c02351af0cb",
        );
        // The command that pins the current key again keeps the host's choices.
        await dialog.getByText("Pin this server's current key again").click();
        const again = dialog.getByLabel(
          "Command to pin the current key on edge-01",
          { exact: true },
        );
        await expect(again).toContainText("--updates auto");
        await expect(again).toContainText(
          `--update-key-sha256 ${teamFingerprint}`,
        );
        await expect(again).toContainText(
          "--update-window 'Mon-Fri 02:00-04:00'",
        );
        await look("upgrade-opted-in", view);
      }
      // Roll out to this device: the review, with this device chosen.
      await load({
        role: "operator",
        path: `devices/${id(1)}`,
        scenario: onState(),
        devices: one({ agent_update: report() }),
      });
      await openUpgrade();
      await upgradeDialog()
        .getByRole("button", { name: "Roll out to this device" })
        .click();
      const review = page.getByRole("dialog", { name: "Roll out agent 0.1.1" });
      await expect(review).toContainText("1 device chosen.");
      await review.getByRole("button", { name: "Review", exact: true }).click();
      expect(state.writes.at(-1)).toMatchObject({
        route: "preview",
        body: {
          selector: { device_ids: [id(1)], group_ids: [], exclude_ids: [] },
        },
      });
      await expect(
        review.getByRole("heading", { name: "Will update · 2" }),
      ).toBeVisible();
      await review.getByRole("button", { name: "Cancel" }).click();

      // A viewer reads it and starts nothing; a stop or no release says why.
      await load({
        role: "viewer",
        path: `devices/${id(1)}`,
        scenario: onState(),
        devices: one({ agent_update: report() }),
      });
      await openUpgrade();
      await expect(
        upgradeDialog().getByRole("button", {
          name: "Roll out to this device",
        }),
      ).toHaveCount(0);
      await load({
        path: `devices/${id(1)}`,
        scenario: onState({ releases: [], rollouts: [] }),
        devices: one({ agent_update: report() }),
      });
      await openUpgrade();
      await upgradeDialog()
        .getByRole("button", { name: "Roll out to this device" })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Roll out to edge-01" }),
      ).toContainText("No release is ready to roll out.");
      await look("upgrade-no-release");
    },
  );

  await check(
    "Upgrade agent: with updates off, nothing about them and the command is today's",
    async () => {
      await load({
        path: `devices/${id(1)}`,
        scenario: offState(),
        devices: one({ agent_update: report() }),
      });
      await openUpgrade();
      const dialog = upgradeDialog();
      await expect(
        dialog.getByRole("heading", { name: "Agent updates" }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("heading", {
          name: "This device takes updates from the dashboard",
        }),
      ).toHaveCount(0);
      const command = await dialog
        .getByLabel("Upgrade command", { exact: true })
        .innerText();
      expect(command).toContain('sudo sh "$dir/vectory-install.sh"');
      expect(command).not.toMatch(/--update/);
      await look("upgrade-updates-off");
    },
  );

  await check(
    "Notifications: the four events of agent updates can be chosen, and are told apart",
    async () => {
      const events = [
        [
          /^An agent update rollout stopped/,
          "agent_update.failed",
          "An update rollout reached its failure threshold.",
        ],
        [
          /^A device rolled back an agent update/,
          "agent_update.rolled_back",
          "A device took its previous agent build back.",
        ],
        [
          /^All agent updates were stopped/,
          "agent_update.stopped",
          "Someone used Stop all updates.",
        ],
        [
          /^The release key changed/,
          "agent_update.key_changed",
          "Updates were turned on or off, or a key was rotated, rolled over or revoked.",
        ],
      ];
      for (const view of views) {
        await load({ ...view, path: "notifications", scenario: onState() });
        await page.getByRole("button", { name: "Add channel" }).first().click();
        const dialog = page.getByRole("dialog", {
          name: "Add a notification channel",
        });
        for (const [name, , description] of events) {
          const box = dialog.getByRole("checkbox", { name });
          await expect(box).toBeVisible();
          await expect(box).not.toBeChecked();
          await expect(dialog.getByText(description)).toBeVisible();
        }
        await look("notifications-events", view);
      }
      // Choosing two of them is what the channel is saved with.
      await load({ path: "notifications", scenario: onState() });
      await page.getByRole("button", { name: "Add channel" }).first().click();
      const dialog = page.getByRole("dialog", {
        name: "Add a notification channel",
      });
      await dialog.getByLabel("Name").fill("Update alerts");
      await dialog
        .getByLabel("Webhook URL")
        .fill("https://hooks.example.test/vectory");
      await dialog.getByRole("checkbox", { name: events[1][0] }).check();
      await dialog.getByRole("checkbox", { name: events[3][0] }).check();
      // A group filter keeps out the events that are about the whole server.
      await expect(dialog.getByRole("note")).toHaveCount(0);
      await dialog.getByRole("button", { name: /All groups/ }).click();
      await page.getByRole("checkbox", { name: /Edge fleet/ }).check();
      await expect(dialog.getByRole("note")).toContainText(
        'A group filter keeps out "The release key changed"',
      );
      await page.keyboard.press("Escape");
      await dialog.getByRole("button", { name: /1 group|Edge fleet/ }).click();
      await page.getByRole("checkbox", { name: /Edge fleet/ }).uncheck();
      await expect(dialog.getByRole("note")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await dialog.getByRole("button", { name: "Add channel" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText("Update alerts").first()).toBeVisible();
      expect(state.channelBodies).toHaveLength(1);
      // What a new channel always starts with, and the two that were chosen:
      // the other two events of agent updates were never chosen for it.
      const sent = state.channelBodies[0].rules.events;
      expect([...sent].sort()).toEqual(
        [
          "issue.opened",
          "issue.resolved",
          "rollout.failed",
          "device.offline",
          "device.recovered",
          "agent_update.rolled_back",
          "agent_update.key_changed",
        ].sort(),
      );
      // The channel says what it sends, in the page's words.
      await expect(
        page.getByText(/agent update rollbacks|agent update/i).first(),
      ).toBeVisible();
    },
  );

  const group = (over = {}) => ({
    cause: "agent_update",
    severity: "warning",
    count: 2,
    device_ids: [id(2), id(4)],
    device_names: ["edge-02", "edge-04"],
    version_id: null,
    version_number: null,
    configuration_id: null,
    configuration_name: null,
    state: "rolled_back",
    since: "2026-10-03T12:20:00Z",
    reason: "NO_CHECK_IN",
    ...over,
  });
  const attention = (...groups) => ({
    attention: groups,
    issues_open: groups.reduce((sum, item) => sum + item.count, 0),
  });

  await check(
    "Overview: devices whose update rolled back are a group in Needs you",
    async () => {
      for (const view of views) {
        await load({
          ...view,
          path: "overview",
          scenario: onState({ overview: attention(group()) }),
        });
        const row = page
          .getByRole("listitem")
          .filter({ hasText: "Agent update rolled back on 2 devices" });
        await expect(row).toBeVisible();
        await expect(row).toContainText(
          "The new build didn't check in within 5 minutes. Each host took the new build back and won't try this release again.",
        );
        await expect(row).toContainText("edge-02 and edge-04");
        await expect(
          row.getByRole("link", { name: "Open issues" }),
        ).toHaveAttribute("href", "#/issues?q=agent_update");
        await expect(
          row.getByRole("link", { name: "Agent updates" }),
        ).toHaveAttribute("href", "#/agent-updates");
        // Nothing here is about a pipeline.
        await expect(row).not.toContainText("pipeline");
        await look("overview-rolled-back", view);
      }
      // One device opens its own page; a failed update says it failed.
      await load({
        path: "overview",
        scenario: onState({
          overview: attention(
            group({
              count: 1,
              device_ids: [id(3)],
              device_names: ["edge-03"],
              state: "failed",
              reason: "DOWNLOAD_FAILED",
            }),
          ),
        }),
      });
      const failed = page
        .getByRole("listitem")
        .filter({ hasText: "Agent update failed on 1 device" });
      await expect(failed).toContainText("The download failed.");
      await expect(failed).not.toContainText("took the new build back");
      await expect(
        failed.getByRole("link", { name: "Open device" }),
      ).toHaveAttribute("href", `#/devices/${id(3)}`);
    },
  );

  await check(
    "Issues: an agent update issue says so, and offers no pipeline retry",
    async () => {
      const issue = (n, name) => ({
        id: id(300 + n),
        device_id: id(n),
        device_name: name,
        device_revoked: false,
        code: "AGENT_UPDATE_ROLLED_BACK",
        stage: "agent_update",
        title: `${name} rolled back agent 0.1.1`,
        message: "The new build didn't check in within 5 minutes.",
        diagnostics: [],
        count: 1,
        reports: 1,
        first_seen: "2026-10-03T12:20:00Z",
        last_seen: "2026-10-03T12:20:00Z",
        desired_version_id: null,
        version_number: null,
        configuration_id: null,
        configuration_name: null,
        deployment_id: null,
        resolved: false,
        resolved_reason: null,
        resolved_at: null,
        revision: 1,
        acknowledged: false,
        acknowledged_at: null,
        acknowledged_by: null,
        acknowledged_by_name: null,
        acknowledgement_reason: null,
        disposition: "open",
      });
      const issues = [issue(2, "edge-02"), issue(4, "edge-04")];
      for (const view of views) {
        await load({
          ...view,
          path: "issues",
          scenario: onState({ issues }),
        });
        const card = page.getByRole("article");
        await expect(
          card.getByText("Agents rolled back an update"),
        ).toBeVisible();
        await expect(
          card.getByRole("link", { name: "Agent update" }).first(),
        ).toHaveAttribute("href", "#/agent-updates");
        await expect(card).not.toContainText("No pipeline version");
        await expect(
          page.getByRole("button", { name: /^Retry on device/ }),
        ).toHaveCount(0);
        await look("issues-agent-update", view);
      }
      // The list of the same issues, one to a row.
      await load({
        path: "issues?view=list",
        scenario: onState({ issues }),
      });
      await expect(
        page.getByText("edge-02 rolled back agent 0.1.1"),
      ).toBeVisible();
      await expect(page.getByText("No pipeline version")).toHaveCount(0);
      await expect(
        page.getByText("AGENT_UPDATE_ROLLED_BACK").first(),
      ).toBeVisible();
    },
  );

  /** The install command on Add device, once created. */
  const installCommandText = () =>
    page.locator(".enroll-command pre").first().innerText();
  const levelCards = () =>
    page.getByRole("group", {
      name: "How should this host take agent updates?",
    });

  await check(
    "Add device: how the host takes updates is a step, nothing chosen for it",
    async () => {
      for (const view of views) {
        await load({ ...view, path: "enrollment", scenario: onState() });
        for (const [n, title] of [
          [1, "Choose the host"],
          [2, "Agent updates"],
          [3, "Run this on the host"],
          [4, "Watch it connect"],
        ])
          await expect(
            page.getByRole("heading", { name: `${n}. ${title}` }),
          ).toBeVisible();
        // Three ways, none of them chosen until a person chooses.
        for (const name of [
          /^Automatic \(recommended\)/,
          /^Ask on the host/,
          /^Off/,
        ])
          await expect(
            levelCards().getByRole("radio", { name }),
          ).not.toBeChecked();
        await page.getByRole("radio", { name: /^Restricted/ }).check();
        await expect(
          page.getByRole("button", { name: "Create install command" }),
        ).toBeDisabled();
        await expect(
          page.getByText("Choose how this host takes agent updates first."),
        ).toBeVisible();
        await levelCards()
          .getByRole("radio", { name: /^Automatic \(recommended\)/ })
          .check();
        // Patch releases are the default, and the key it will pin is shown.
        await expect(
          page.getByRole("radio", { name: /^Patch releases/ }),
        ).toBeChecked();
        await expect(
          page.getByRole("radio", { name: /^Minor releases too/ }),
        ).not.toBeChecked();
        await expect(
          page.getByText(
            `Pins key ${teamFingerprint.slice(0, 16)} · kept offline`,
          ),
        ).toBeVisible();
        await expect(
          page.getByText("Whoever holds the key can install software on it.", {
            exact: false,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "What a host agrees to" }),
        ).toHaveAttribute("href", "/help/agent-updates/#what-a-host-agrees-to");
        await look("add-device-updates", view);
      }
    },
  );

  await check(
    "Add device: the command carries what was chosen, through the quoting rules",
    async () => {
      const make = async (scenario, choose) => {
        await load({ path: "enrollment", scenario });
        await page.getByRole("radio", { name: /^Restricted/ }).check();
        await choose();
        await page
          .getByRole("button", { name: "Create install command" })
          .click();
        await expect(page.locator(".enroll-command pre").first()).toBeVisible();
        return installCommandText();
      };
      const pick = (name) => () =>
        levelCards().getByRole("radio", { name }).check();

      const auto = await make(onState(), async () => {
        await pick(/^Automatic \(recommended\)/)();
        await page
          .getByLabel("Update windows (optional)")
          .fill("Mon-Fri 02:00-04:00\nSat,Sun 01:00-03:00 UTC");
      });
      expect(auto).toContain("--updates auto");
      expect(auto).toContain(`--update-key-sha256 ${teamFingerprint}`);
      expect(auto).toContain("--update-track patch");
      expect(auto).toContain("--update-window 'Mon-Fri 02:00-04:00'");
      expect(auto).toContain("--update-window 'Sat,Sun 01:00-03:00 UTC'");
      await look("add-device-command");

      const ask = await make(onState(), async () => {
        await pick(/^Ask on the host/)();
        await page.getByRole("radio", { name: /^Minor releases too/ }).check();
      });
      expect(ask).toContain("--updates ask");
      expect(ask).toContain("--update-track minor");
      expect(ask).toContain(`--update-key-sha256 ${teamFingerprint}`);
      expect(ask).not.toContain("--update-window");

      // Off writes no key and no track: the host updates only by hand.
      const off = await make(onState(), pick(/^Off/));
      expect(off).toContain("--updates off");
      expect(off).not.toContain("--update-key-sha256");
      expect(off).not.toContain("--update-track");

      // With this server's key, the page says so where the key is named.
      const server = releaseKey({ custody: "server" });
      await load({
        path: "enrollment",
        scenario: onState({
          updates: updatesBody({ custody: "server", current_key: server }),
          keys: [server],
        }),
      });
      await levelCards()
        .getByRole("radio", { name: /^Automatic \(recommended\)/ })
        .check();
      await expect(
        page.getByText(
          `Pins key ${teamFingerprint.slice(0, 16)} · held by this server`,
        ),
      ).toBeVisible();

      // A window the agent wouldn't read is said so, and no command is made.
      await load({ path: "enrollment", scenario: onState() });
      await page.getByRole("radio", { name: /^Restricted/ }).check();
      await levelCards()
        .getByRole("radio", { name: /^Automatic \(recommended\)/ })
        .check();
      await page.getByLabel("Update windows (optional)").fill("whenever");
      await expect(
        page.getByLabel("Update windows (optional)"),
      ).toHaveAttribute("aria-invalid", "true");
      await expect(
        page.getByRole("button", { name: "Create install command" }),
      ).toBeDisabled();
      await expect(
        page.locator(".update-window-field .update-field-error"),
      ).toBeVisible();
      expect(state.tokenBodies).toHaveLength(0);
    },
  );

  await check(
    "Add device: with updates off the step isn't there and the command is today's",
    async () => {
      for (const view of views) {
        await load({ ...view, path: "enrollment", scenario: offState() });
        for (const [n, title] of [
          [1, "Choose the host"],
          [2, "Run this on the host"],
          [3, "Watch it connect"],
        ])
          await expect(
            page.getByRole("heading", { name: `${n}. ${title}` }),
          ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: /Agent updates/ }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("radio", { name: /Automatic \(recommended\)/ }),
        ).toHaveCount(0);
        await page.getByRole("radio", { name: /^Restricted/ }).check();
        await page
          .getByRole("button", { name: "Create install command" })
          .click();
        await expect(page.locator(".enroll-command pre").first()).toBeVisible();
        const command = await installCommandText();
        expect(command).toContain('sudo sh "$dir/vectory-install.sh" \\');
        expect(command).toContain("--mode restricted");
        expect(command).not.toMatch(/--update/);
        await look("add-device-updates-off", view);
      }
    },
  );

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
        requests: totalRequests,
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
