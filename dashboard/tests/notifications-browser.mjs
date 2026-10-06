// Settings → Notifications and the Overview/Issues tip, as real components.
// Every HTTP request is intercepted and answered with synthetic data; nothing
// reaches a server, a receiver or the network.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { syntheticChannel } from "./notification-fixtures.mjs";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_NOTIFICATIONS_OUTPUT || ".local/notifications-component",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:notifications";
async function freePort() {
  const reservation = net.createServer();
  await new Promise((done, fail) => {
    reservation.once("error", fail);
    reservation.listen(0, "127.0.0.1", done);
  });
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  return port;
}
// A fixed port keeps a local run inside its assigned block.
const port =
  Number(process.env.VECTORY_NOTIFICATIONS_PORT) || (await freePort());
const server = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  logLevel: "warn",
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "isolated-notifications",
      resolveId(id) {
        if (id === "virtual:notifications") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `
import React from "react";
import { createRoot } from "react-dom/client";
import Notifications from "/src/Notifications.tsx";
import NotificationsHint from "/src/NotificationsHint.tsx";
import { setCSRF } from "/src/api.ts";
import "/src/styles.css";
setCSRF("synthetic-csrf");
const root = createRoot(document.getElementById("root"));
const admin = { id: "synthetic-admin", name: "Synthetic administrator", email: "admin@example.test", role: "admin", enabled: true, revision: 1 };
const viewer = { ...admin, id: "synthetic-viewer", name: "Synthetic viewer", email: "viewer@example.test", role: "viewer" };
const readQuery = () => (location.hash.slice(2) || "notifications").split("?")[1] || "";
// The app passes the route's query; here the hash stands in for the router.
function Page(props) {
  const [query, setQuery] = React.useState(readQuery);
  React.useEffect(() => {
    const changed = () => setQuery(readQuery());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return React.createElement(Notifications, { ...props, query });
}
let key = 0;
window.mount = (name, options = {}) => {
  window.notices = [];
  const user = options.role === "viewer" ? viewer : admin;
  const notify = (message, settings = {}) => window.notices.push({ message, tone: settings.tone ?? null });
  // The tip sits under a page's own title, as on Overview and Issues.
  root.render(
    name === "hint"
      ? React.createElement(
          "div",
          { key: ++key, className: "control-page" },
          React.createElement("h1", null, "Synthetic page"),
          React.createElement(NotificationsHint, { user, placement: options.placement || "page" }),
        )
      : React.createElement(Page, { key: ++key, user, notify }),
  );
};
window.ready = true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__notifications") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic notifications verification</title></head><body><main class="page-content" style="padding:20px"><div id="root"></div></main><script type="module">import "virtual:notifications";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const results = [],
  requests = [],
  unexpected = [],
  errors = [],
  accessibility = [],
  screenshots = [];

/* ---------- Synthetic data ---------- */
// Times are relative to each load, so "2m ago" reads the same in every check.
const ago = (minutes) =>
  new Date(Date.now() - minutes * 60000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
const later = (minutes) =>
  new Date(Date.now() + minutes * 60000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pipelines = Array.from({ length: 60 }, (_, i) => ({
  id: id(5000 + i),
  name: `Synthetic pipeline ${String(i).padStart(2, "0")}`,
  description: "",
  revision: 1,
  created_at: ago(1000 + i),
  updated_at: ago(100 + i),
  archived: false,
  archived_at: null,
  component_counts: { sources: 1, transforms: 0, sinks: 1 },
  latest_version: null,
}));
const groups = ["Edge collectors", "Core aggregators", "Staging"].map(
  (name, i) => ({
    id: id(6000 + i),
    name,
    description: "Synthetic group",
    device_ids: [],
    revision: 1,
  }),
);
function channels() {
  return [
    syntheticChannel({
      id: id(1),
      name: "On-call Slack",
      webhook: {
        url_hint: "https://hooks.example.test/…",
        host: "hooks.example.test",
        header_name: null,
        signing_secret_set: true,
        header_value_set: false,
      },
      rules: {
        events: [
          "issue.opened",
          "issue.resolved",
          "rollout.failed",
          "device.offline",
          "device.recovered",
        ],
        offline_minutes: 15,
        min_severity: "warning",
        pipeline_ids: [],
        group_ids: [],
        quiet_hours: null,
      },
      revision: 3,
      status: {
        state: "delivering",
        last_attempt_at: ago(2),
        last_delivered_at: ago(2),
        last_error: null,
        last_status_code: 200,
        pending: 0,
      },
    }),
    syntheticChannel({
      id: id(2),
      name: "Incident receiver",
      webhook: {
        url_hint: "https://alerts.example.test/…",
        host: "alerts.example.test",
        header_name: "Authorization",
        signing_secret_set: false,
        header_value_set: true,
      },
      rules: {
        events: [
          "issue.opened",
          "rollout.failed",
          "rollout.rolled_back",
          "canary.paused",
        ],
        offline_minutes: 15,
        min_severity: "error",
        pipeline_ids: [pipelines[0].id, pipelines[1].id],
        group_ids: [],
        quiet_hours: {
          start: "22:00",
          end: "07:00",
          time_zone: "Europe/Berlin",
          errors_bypass: true,
        },
      },
      status: {
        state: "failing",
        last_attempt_at: ago(1),
        last_delivered_at: ago(180),
        last_error: "Couldn't resolve alerts.example.test.",
        last_status_code: null,
        pending: 3,
      },
    }),
    syntheticChannel({
      id: id(3),
      name: "Platform team email",
      kind: "email",
      webhook: null,
      email: {
        host: "smtp.example.test",
        port: 587,
        security: "starttls",
        username: "vectory",
        password_set: true,
        from: "Vectory <vectory@example.test>",
        to: ["platform@example.test", "oncall@example.test"],
      },
      rules: {
        events: ["device.offline", "device.recovered"],
        offline_minutes: 60,
        min_severity: "warning",
        pipeline_ids: [],
        group_ids: [groups[0].id],
        quiet_hours: null,
      },
    }),
    syntheticChannel({
      id: id(4),
      name: "Staging hooks",
      enabled: false,
      status: {
        state: "off",
        last_attempt_at: ago(3000),
        last_delivered_at: ago(3000),
        last_error: null,
        last_status_code: 204,
        pending: 0,
      },
    }),
  ];
}
function attempts() {
  const outcomes = [
    "delivered",
    "delivered",
    "retrying",
    "delivered",
    "gave_up",
    "failed",
  ];
  const titles = [
    "Issue on edge-fra-01: http-out can't deliver events",
    "Rollout failed: Edge pipeline v12",
    "edge-ams-02 is offline",
    "edge-ams-02 is back online",
    "Canary paused: Edge pipeline v13",
    "Test message from Vectory",
  ];
  const types = [
    "issue.opened",
    "rollout.failed",
    "device.offline",
    "device.recovered",
    "canary.paused",
    "test",
  ];
  return Array.from({ length: 32 }, (_, i) => {
    const outcome = outcomes[i % outcomes.length];
    const channel = i % 3 === 0 ? 2 : 1;
    const test = types[i % types.length] === "test";
    return {
      id: 1000 - i,
      delivery_id: id(7000 + i),
      channel_id: id(channel),
      channel_name: channel === 2 ? "Incident receiver" : "On-call Slack",
      channel_exists: true,
      kind: test ? "test" : "event",
      type: types[i % types.length],
      title: titles[i % titles.length],
      attempt: outcome === "gave_up" ? 4 : outcome === "retrying" ? 2 : 1,
      at: ago(i * 7 + 1),
      outcome: test && outcome !== "delivered" ? "failed" : outcome,
      status_code:
        outcome === "delivered" ? 200 : outcome === "failed" ? 404 : null,
      latency_ms: outcome === "delivered" ? 140 + i : 5000,
      error:
        outcome === "delivered"
          ? null
          : outcome === "failed"
            ? "The receiver answered 404 Not Found: «redacted»"
            : "Couldn't resolve alerts.example.test.",
      next_attempt_at: outcome === "retrying" ? later(5) : null,
    };
  });
}
const defaults = {
  sink_errors_per_minute: 1,
  error_drops_per_minute: 1,
  buffer_full_percent: 95,
  stall_checks: 3,
  canary_checks: 3,
};
const bounds = {
  sink_errors_per_minute: { min: 1, max: 10000 },
  error_drops_per_minute: { min: 1, max: 100000 },
  buffer_full_percent: { min: 55, max: 100 },
  stall_checks: { min: 2, max: 20 },
  canary_checks: { min: 1, max: 20 },
};
// The server's own example wording, with placeholder names.
function preview(type, name) {
  const examples = {
    "issue.opened": [
      "Issue on example-device: example-sink can't deliver events",
      "The http sink example-sink is failing about 12 requests a minute (connection refused).",
      "Pipeline: Example pipeline v3 · Device: example-device · Error",
      "error",
      false,
    ],
    "issue.resolved": [
      "Resolved on example-device: example-sink can't deliver events",
      "Delivery is healthy again: the latest checks were clean.",
      "Pipeline: Example pipeline v3 · Device: example-device · Error",
      "error",
      true,
    ],
    "rollout.failed": [
      "Rollout failed: Example pipeline v3",
      "More devices failed to apply it than its failure threshold allows, so it stopped.",
      "Deployment: Example pipeline v3 · Error",
      "error",
      false,
    ],
    "rollout.rolled_back": [
      "Rolled back: Example pipeline v3",
      "An administrator rolled it back to v2.",
      "Deployment: Example pipeline v3 · Warning",
      "warning",
      false,
    ],
    "canary.paused": [
      "Canary paused: Example pipeline v3",
      "Devices that applied it stopped delivering events, so the next wave waits. Resume it once delivery is fixed.",
      "Deployment: Example pipeline v3 · Warning",
      "warning",
      false,
    ],
    "device.offline": [
      "example-device is offline",
      "No check-in for 16 min.",
      "Device: example-device · Pipeline: Example pipeline v3 · Warning",
      "warning",
      false,
    ],
    "device.recovered": [
      "example-device is back online",
      "It checked in again after 42 min offline.",
      "Device: example-device · Pipeline: Example pipeline v3 · Warning",
      "warning",
      true,
    ],
  };
  const [headline, message, context, severity, recovery] = examples[type];
  const link = "https://vectory.example.test/#/issues";
  return {
    example: true,
    headline,
    message,
    context: `${context} · Vectory`,
    link,
    webhook: {
      text: headline,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${headline}*\n${message}` },
        },
      ],
      event: {
        schema: "vectory.notification.v1",
        type,
        severity,
        recovery,
        headline,
        message,
        test: false,
        instance: "Vectory",
        url: link,
      },
    },
    email: {
      subject: `[Vectory] ${headline}`,
      body: `${headline}\n\n${message}\n\n${context.replaceAll(" · ", "\n")}\n\nOpen in Vectory: ${link}\n\n—\nSent by the “${name || "New channel"}” channel in Vectory. Change what it sends in Settings → Notifications.\n`,
    },
  };
}

/* ---------- Harness ---------- */
let context, page, state;
async function load({
  view = "",
  role = "admin",
  mount = "page",
  placement,
  width = 1280,
  ...overrides
} = {}) {
  if (context) await context.close();
  context = await browser.newContext({ viewport: { width, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  state = {
    channels: channels(),
    attempts: attempts(),
    detection: {
      thresholds: { ...defaults },
      defaults,
      bounds,
      revision: 0,
      updated_at: null,
      updated_by_name: null,
      evaluation_interval_seconds: 25,
    },
    writes: [],
    previews: [],
    deliveryQueries: [],
    tests: {},
    stale: false,
    // A name the server says another channel has, in any case.
    nameTaken: "",
    ...overrides,
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7);
    const method = request.method();
    requests.push({ method, path, query: url.search });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    const refuse = (status, code, message) =>
      reply({ error: { code, message } }, status);
    if (
      method !== "GET" &&
      request.headers()["x-csrf-token"] !== "synthetic-csrf"
    )
      unexpected.push(`Missing CSRF ${method} ${path}`);
    const body = method === "GET" ? null : request.postDataJSON();
    const channelPath = path.match(
      /^\/notifications\/channels\/([^/]+)(\/test)?$/,
    );
    if (method === "GET" && path === "/notifications/channels")
      return reply({ items: state.channels, max_channels: 20 });
    if (method === "POST" && path === "/notifications/channels") {
      state.writes.push({ method, path, body });
      if (
        state.nameTaken &&
        body.name.toLowerCase() === state.nameTaken.toLowerCase()
      )
        return refuse(
          409,
          "NAME_TAKEN",
          "Another channel has this name. Choose another.",
        );
      const created = syntheticChannel({
        id: id(99),
        name: body.name,
        kind: body.kind,
        enabled: body.enabled,
        allow_private: body.allow_private,
        rules: body.rules,
        webhook:
          body.kind === "webhook"
            ? {
                url_hint: `${new URL(body.webhook.url).origin}/…`,
                host: new URL(body.webhook.url).hostname,
                header_name: body.webhook.header_name,
                signing_secret_set: !!body.webhook.signing_secret,
                header_value_set: !!body.webhook.header_value,
              }
            : null,
        email:
          body.kind === "email"
            ? { ...body.email, password_set: !!body.email.password }
            : null,
      });
      state.channels.push(created);
      return reply(created);
    }
    if (channelPath) {
      const channel = state.channels.find((c) => c.id === channelPath[1]);
      if (!channel) return refuse(404, "NOT_FOUND", "No such channel");
      if (method === "POST" && channelPath[2]) {
        state.writes.push({ method, path, body });
        const result =
          state.tests[channel.id] ??
          (channel.id === id(2)
            ? {
                delivered: false,
                status_code: null,
                latency_ms: 5003,
                error: "Couldn't resolve alerts.example.test.",
              }
            : {
                delivered: true,
                status_code: 200,
                latency_ms: 142,
                error: null,
              });
        return reply({ attempt_id: 2000, at: later(0), ...result });
      }
      if (method === "PUT") {
        state.writes.push({ method, path, body });
        if (state.stale || body.revision !== channel.revision)
          return refuse(
            409,
            "STALE_REVISION",
            "This channel changed since you opened it",
          );
        Object.assign(channel, {
          name: body.name,
          enabled: body.enabled,
          allow_private: body.allow_private,
          rules: body.rules,
          revision: channel.revision + 1,
        });
        if (channel.webhook) {
          if (body.webhook.signing_secret === null)
            channel.webhook.signing_secret_set = false;
          if (typeof body.webhook.signing_secret === "string")
            channel.webhook.signing_secret_set = true;
          channel.webhook.header_name = body.webhook.header_name;
        }
        return reply(channel);
      }
      if (method === "DELETE") {
        state.writes.push({ method, path, body });
        state.channels = state.channels.filter((c) => c !== channel);
        return reply({ ok: true });
      }
      if (method === "GET") return reply(channel);
    }
    if (method === "POST" && path === "/notifications/preview") {
      state.previews.push(body);
      return reply(preview(body.type, body.name));
    }
    if (method === "GET" && path === "/notifications/deliveries") {
      const query = Object.fromEntries(url.searchParams);
      state.deliveryQueries.push(query);
      const size = Number(query.page_size || 12);
      const number = Number(query.page || 1);
      const matching = state.attempts.filter(
        (a) =>
          (!query.channel_id || a.channel_id === query.channel_id) &&
          (!query.outcome || a.outcome === query.outcome),
      );
      return reply({
        items: matching.slice((number - 1) * size, number * size),
        total: matching.length,
        page: number,
        page_size: size,
      });
    }
    if (method === "GET" && path === "/detection")
      return reply(state.detection);
    if (method === "PUT" && path === "/detection") {
      state.writes.push({ method, path, body });
      if (body.revision !== state.detection.revision)
        return refuse(
          409,
          "STALE_REVISION",
          "Detection thresholds changed since you opened them",
        );
      state.detection = {
        ...state.detection,
        thresholds: body.thresholds,
        revision: state.detection.revision + 1,
        updated_at: later(0),
        updated_by_name: "Synthetic administrator",
      };
      return reply(state.detection);
    }
    if (method === "GET" && path === "/groups") return reply(groups);
    if (method === "GET" && path === "/configurations/library") {
      const search = (url.searchParams.get("search") || "").toLowerCase();
      const matching = pipelines.filter((p) =>
        p.name.toLowerCase().includes(search),
      );
      return reply({
        items: matching.slice(0, 50),
        total: matching.length,
        page: 1,
        page_size: 50,
      });
    }
    unexpected.push(`${method} ${path}`);
    return refuse(500, "UNEXPECTED", "Unexpected synthetic request");
  });
  await page.goto(
    `${origin}/__notifications#/notifications${view ? `?view=${view}` : ""}`,
  );
  await page.waitForFunction(() => window.ready);
  await page.evaluate(
    ({ mount, role, placement }) => window.mount(mount, { role, placement }),
    {
      mount,
      role,
      placement,
    },
  );
}
async function theme(name) {
  await page.evaluate(
    (value) => (document.documentElement.dataset.theme = value),
    name,
  );
}
async function axe(view, themeName) {
  const audit = await new AxeBuilder({ page }).analyze();
  accessibility.push({
    view,
    theme: themeName,
    violations: audit.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target),
    })),
  });
  expect(
    audit.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`,
    ),
  ).toEqual([]);
}
async function shot(name, options = {}) {
  await page.screenshot({
    path: resolve(output, name),
    animations: "disabled",
    ...options,
  });
  screenshots.push(name);
}
async function noSidewaysScroll(width) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    width,
  );
}
const notices = () => page.evaluate(() => window.notices);
const channelTable = () =>
  page.getByRole("table", { name: "Notification channels", exact: true });
const channelRow = (name) =>
  channelTable().locator("tbody tr").filter({ hasText: name });
async function check(name, run) {
  if (
    process.env.VECTORY_NOTIFICATIONS_ONLY &&
    !name.includes(process.env.VECTORY_NOTIFICATIONS_ONLY)
  )
    return;
  await run();
  results.push({ name, passed: true });
  console.log("PASS", name);
}

let failure;
try {
  await check(
    "a first visit explains notifications in one sentence and offers Add channel",
    async () => {
      await load({ channels: [] });
      await expect(
        page.getByRole("heading", { name: "Notifications", level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "No notification channels yet" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Get a message in Slack, any webhook or email when an issue opens, a rollout fails or a device goes offline.",
        ),
      ).toBeVisible();
      // One way in: the empty state's action, not a second one in the header.
      await expect(
        page.getByRole("button", { name: "Add channel" }),
      ).toHaveCount(1);
      await expect(
        page.getByRole("link", { name: /How notifications work/ }),
      ).toHaveAttribute("href", "/help/notifications/");
      for (const name of ["light", "dark"]) {
        await theme(name);
        await axe("first run", name);
        await shot(`empty-${name}.png`);
      }
    },
  );

  await check(
    "adding a webhook checks what the server checks, previews the message and sends each secret once",
    async () => {
      await load({ channels: [] });
      await page.getByRole("button", { name: "Add channel" }).click();
      const dialog = page.getByRole("dialog", {
        name: "Add a notification channel",
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("textbox", { name: "Name", exact: true }),
      ).toBeFocused();
      await dialog
        .getByRole("button", { name: "Add channel", exact: true })
        .click();
      await expect(dialog.getByText("Name this channel.")).toBeVisible();
      await expect(dialog.getByText("Enter the webhook URL.")).toBeVisible();
      expect(state.writes).toEqual([]);
      await dialog
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("On-call Slack");
      const url = dialog.getByRole("textbox", { name: "Webhook URL" });
      const privateAllowed = dialog.getByRole("checkbox", {
        name: /Allow private network addresses/,
      });
      await url.fill("http://10.1.2.3/hook");
      await expect(
        dialog.getByText(
          "Use https://. Plain http:// works only for private addresses, with Allow private network addresses on.",
        ),
      ).toBeVisible();
      await privateAllowed.check();
      await expect(dialog.getByText(/^Use https:\/\//)).toHaveCount(0);
      await url.fill("https://169.254.169.254/latest/meta-data");
      await expect(
        dialog.getByText(
          "169.254.169.254 is a link-local, metadata or reserved address, which Vectory never contacts.",
        ),
      ).toBeVisible();
      await privateAllowed.uncheck();
      await url.fill("https://user:pass@hooks.example.test/services/synthetic");
      await expect(
        dialog.getByText(/Remove the user name and password from the URL/),
      ).toBeVisible();
      await url.fill("https://hooks.example.test/services/T000/B000/synthetic");
      const signing = dialog.getByLabel("Signing secret (optional)");
      await signing.fill("too-short");
      await expect(
        dialog.getByText("Use at least 16 characters."),
      ).toBeVisible();
      await signing.fill("synthetic-signing-secret-0001");
      const minutes = dialog.getByRole("textbox", {
        name: "Minutes offline before a message",
      });
      await minutes.fill("3");
      await expect(dialog.getByText("Enter 5 to 1,440 minutes.")).toBeVisible();
      await minutes.fill("30");
      // The server renders the preview, with placeholder names only.
      const preview = dialog.getByRole("complementary", {
        name: "Message preview",
      });
      await expect(
        preview.getByText(
          "Issue on example-device: example-sink can't deliver events",
        ),
      ).toBeVisible();
      await expect(
        preview.getByText("An example: the names are placeholders."),
      ).toBeVisible();
      await preview
        .getByRole("combobox", { name: "Event to preview" })
        .selectOption("device.offline");
      await expect(
        preview.getByText("example-device is offline"),
      ).toBeVisible();
      await expect
        .poll(() => state.previews.at(-1))
        .toEqual({ type: "device.offline", name: "On-call Slack" });
      // Quiet hours in a chosen zone, errors let through by default.
      await dialog
        .getByRole("switch", { name: /Hold messages overnight/ })
        .check();
      await dialog
        .getByRole("combobox", { name: "Time zone" })
        .selectOption("Europe/Berlin");
      await expect(
        dialog.getByRole("checkbox", { name: /Let errors through/ }),
      ).toBeChecked();
      // Pipelines come a page at a time; a search asks the server for the rest.
      await dialog
        .getByRole("button", { name: "Pipelines All pipelines" })
        .click();
      const picker = page.getByRole("dialog", { name: "Choose pipelines" });
      await expect(
        picker.getByText("Showing 50 of 60. Search to find others."),
      ).toBeVisible();
      await picker
        .getByRole("textbox", { name: "Find a pipeline" })
        .fill("pipeline 59");
      await picker
        .getByRole("checkbox", { name: "Synthetic pipeline 59" })
        .check();
      await expect
        .poll(() =>
          requests.some(
            (r) =>
              r.path === "/configurations/library" &&
              r.query.includes("search=pipeline+59"),
          ),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Pipelines Synthetic pipeline 59" }),
      ).toBeVisible();
      await expect(
        dialog.getByText("Only events about this pipeline."),
      ).toBeVisible();
      await preview
        .getByRole("combobox", { name: "Event to preview" })
        .selectOption("issue.opened");
      await expect(
        preview.getByText(
          "Issue on example-device: example-sink can't deliver events",
        ),
      ).toBeVisible();
      await axe("add dialog", "light");
      await shot("dialog-light.png");
      await dialog.evaluate((node) => node.scrollTo(0, 0));
      await shot("dialog-top-light.png");
      await theme("dark");
      await axe("add dialog", "dark");
      await shot("dialog-top-dark.png");
      await dialog.evaluate((node) => node.scrollTo(0, node.scrollHeight));
      await shot("dialog-bottom-dark.png");
      await theme("light");
      await dialog
        .getByRole("button", { name: "Add channel", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      const created = state.writes.at(-1);
      expect(created.method).toBe("POST");
      expect(created.body).toEqual({
        name: "On-call Slack",
        kind: "webhook",
        enabled: true,
        allow_private: false,
        rules: {
          events: [
            "issue.opened",
            "issue.resolved",
            "rollout.failed",
            "device.offline",
            "device.recovered",
          ],
          offline_minutes: 30,
          min_severity: "warning",
          pipeline_ids: [pipelines[59].id],
          group_ids: [],
          quiet_hours: {
            start: "22:00",
            end: "07:00",
            time_zone: "Europe/Berlin",
            errors_bypass: true,
          },
        },
        webhook: {
          url: "https://hooks.example.test/services/T000/B000/synthetic",
          signing_secret: "synthetic-signing-secret-0001",
          header_name: null,
        },
      });
      expect(await notices()).toEqual([
        {
          message: "On-call Slack is set up. Send a test message to check it.",
          tone: "success",
        },
      ]);
      await expect(channelRow("On-call Slack")).toContainText(
        "No messages yet",
      );
      // With a channel, the header offers the next one.
      await expect(
        page.getByRole("button", { name: "Add channel" }),
      ).toHaveCount(1);
    },
  );

  await check(
    "email channels refuse unencrypted mail to another host and send the password only with a user name",
    async () => {
      await load({ channels: [] });
      await page.getByRole("button", { name: "Add channel" }).click();
      const dialog = page.getByRole("dialog", {
        name: "Add a notification channel",
      });
      await dialog.getByRole("radio", { name: /Email/ }).check();
      await dialog
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("Platform team email");
      await dialog
        .getByRole("textbox", { name: "SMTP server" })
        .fill("smtp.example.test");
      const security = dialog.getByRole("combobox", { name: "Security" });
      await security.selectOption("tls");
      await expect(dialog.getByRole("textbox", { name: "Port" })).toHaveValue(
        "465",
      );
      await security.selectOption("none");
      await dialog
        .getByRole("button", { name: "Add channel", exact: true })
        .click();
      await expect(
        dialog.getByText(
          "Unencrypted email only goes to a relay on this server (localhost), with Allow private network addresses on.",
        ),
      ).toBeVisible();
      await security.selectOption("starttls");
      await expect(dialog.getByRole("textbox", { name: "Port" })).toHaveValue(
        "587",
      );
      await expect(dialog.getByLabel("Password")).toBeDisabled();
      await dialog
        .getByRole("textbox", { name: "User name (optional)" })
        .fill("vectory");
      await expect(
        dialog.getByText("Enter the password for this user name."),
      ).toBeVisible();
      await dialog.getByLabel("Password").fill("synthetic-smtp-password");
      await dialog
        .getByRole("textbox", { name: "From" })
        .fill("Vectory <vectory@example.test>");
      await dialog
        .getByRole("textbox", { name: "To" })
        .fill("platform@example.test, not-an-address");
      await expect(
        dialog.getByText("not-an-address isn't a valid address."),
      ).toBeVisible();
      await dialog
        .getByRole("textbox", { name: "To" })
        .fill("platform@example.test, oncall@example.test");
      const preview = dialog.getByRole("complementary", {
        name: "Message preview",
      });
      await expect(
        preview.getByText(
          "[Vectory] Issue on example-device: example-sink can't deliver events",
        ),
      ).toBeVisible();
      await expect(
        preview.getByText(/Sent by the “Platform team email” channel/),
      ).toBeVisible();
      await dialog
        .getByRole("button", { name: "Add channel", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      expect(state.writes.at(-1).body.email).toEqual({
        host: "smtp.example.test",
        port: 587,
        security: "starttls",
        username: "vectory",
        from: "Vectory <vectory@example.test>",
        to: ["platform@example.test", "oncall@example.test"],
        password: "synthetic-smtp-password",
      });
    },
  );

  await check(
    "the list shows each channel's real state and a test reports what the receiver did",
    async () => {
      await load();
      await expect(channelTable().locator("tbody tr")).toHaveCount(4);
      await expect(channelRow("On-call Slack")).toContainText("Delivering");
      await expect(channelRow("On-call Slack")).toContainText(
        "Last delivered 2m ago",
      );
      await expect(channelRow("On-call Slack")).toContainText(
        "Issues and resolutions, failed rollouts, offline after 15 min and back online",
      );
      await expect(channelRow("Incident receiver")).toContainText("Failing");
      await expect(channelRow("Incident receiver")).toContainText(
        "Couldn't resolve alerts.example.test. · 3 waiting",
      );
      await expect(channelRow("Incident receiver")).toContainText(
        "Errors only · 2 pipelines · Quiet 22:00–07:00 (Europe/Berlin)",
      );
      await expect(channelRow("Platform team email")).toContainText(
        "2 recipients via smtp.example.test",
      );
      await expect(channelRow("Platform team email")).toContainText(
        "No messages yet",
      );
      await expect(channelRow("Staging hooks")).toContainText("Off");
      // An off channel sends nothing, tests included.
      await expect(
        channelRow("Staging hooks").getByRole("button", { name: "Send test" }),
      ).toHaveCount(0);
      await channelRow("Incident receiver")
        .getByRole("button", { name: "Send test" })
        .click();
      await expect.poll(notices).toEqual([
        {
          message:
            "Test to Incident receiver failed. Couldn't resolve alerts.example.test.",
          tone: "error",
        },
      ]);
      await channelRow("On-call Slack")
        .getByRole("button", { name: "Send test" })
        .click();
      await expect
        .poll(async () => (await notices()).at(-1))
        .toEqual({
          message: "Test delivered to On-call Slack: answered 200 in 142 ms.",
          tone: "success",
        });
      expect(
        state.writes.filter((w) => w.path.endsWith("/test")).map((w) => w.body),
      ).toEqual([{}, {}]);
      for (const name of ["light", "dark"]) {
        await theme(name);
        await axe("channels", name);
        await shot(`channels-${name}.png`);
      }
    },
  );

  await check(
    "editing keeps saved secrets unless replaced or removed, and a stale save is explained",
    async () => {
      await load();
      await channelRow("On-call Slack")
        .getByRole("button", { name: "Edit On-call Slack" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Edit On-call Slack" });
      const savedUrl = dialog.getByRole("group", { name: "Webhook URL" });
      await expect(savedUrl.getByText("Saved")).toBeVisible();
      await expect(
        savedUrl.getByText("https://hooks.example.test/…"),
      ).toBeVisible();
      // A webhook needs its URL: it can be replaced, not removed.
      await expect(
        savedUrl.getByRole("button", { name: "Remove" }),
      ).toHaveCount(0);
      // Focus follows each switch: to the new value, and back to Replace.
      await savedUrl.getByRole("button", { name: "Replace" }).click();
      await expect(
        dialog.getByRole("textbox", { name: "Webhook URL" }),
      ).toBeFocused();
      await dialog.getByRole("button", { name: "Keep saved" }).click();
      await expect(
        savedUrl.getByRole("button", { name: "Replace" }),
      ).toBeFocused();
      // Without edits, the saved settings can be tested from here, on a phone too.
      await dialog.getByRole("button", { name: "Send test" }).click();
      await expect
        .poll(async () => (await notices()).at(-1))
        .toEqual({
          message: "Test delivered to On-call Slack: answered 200 in 142 ms.",
          tone: "success",
        });
      const signing = dialog.getByRole("group", {
        name: "Signing secret (optional)",
      });
      await signing.getByRole("button", { name: "Remove" }).click();
      await expect(signing.getByText("Removed on save")).toBeVisible();
      await expect(signing.getByRole("button", { name: "Undo" })).toBeFocused();
      // An edit isn't saved yet, so a test would not say anything about it.
      await expect(
        dialog.getByRole("button", { name: "Send test" }),
      ).toHaveCount(0);
      // Escape with an unsaved edit asks first; keeping it keeps the dialog.
      const asked = [];
      page.once("dialog", (question) => {
        asked.push(question.message());
        return question.dismiss();
      });
      await page.keyboard.press("Escape");
      await expect
        .poll(() => asked)
        .toEqual(["Discard your changes to this channel?"]);
      await expect(dialog).toBeVisible();
      await signing.getByRole("button", { name: "Undo" }).click();
      await expect(signing.getByText("Saved")).toBeVisible();
      await signing.getByRole("button", { name: "Remove" }).click();
      await axe("edit dialog", "light");
      await shot("edit-light.png");
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await expect(dialog).toHaveCount(0);
      const saved = state.writes.at(-1);
      expect(saved.method).toBe("PUT");
      expect(saved.body.revision).toBe(3);
      expect(saved.body.webhook).toEqual({
        signing_secret: null,
        header_name: null,
      });
      expect(JSON.stringify(saved.body)).not.toContain("hooks.example.test");
      expect((await notices()).at(-1)).toEqual({
        message: "On-call Slack saved.",
        tone: "success",
      });
      // Another administrator's edit won the race.
      state.stale = true;
      await channelRow("On-call Slack")
        .getByRole("button", { name: "Edit On-call Slack" })
        .click();
      await dialog
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("On-call Slack (EU)");
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await expect(
        dialog.getByText(
          "Someone changed this channel while you edited it. Close the dialog and open it again to see their changes.",
        ),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        channelRow("On-call Slack").getByRole("button", {
          name: "Edit On-call Slack",
        }),
      ).toBeFocused();
      // Removing asks first and says what happens to waiting messages.
      state.stale = false;
      await channelRow("Staging hooks")
        .getByRole("button", { name: "Edit Staging hooks" })
        .click();
      const staging = page.getByRole("dialog", { name: "Edit Staging hooks" });
      await staging.getByRole("button", { name: "Remove channel" }).click();
      await expect(
        staging.getByText(
          "Remove Staging hooks? Waiting messages are dropped.",
        ),
      ).toBeVisible();
      await staging
        .getByRole("button", { name: "Remove", exact: true })
        .click();
      await expect(staging).toHaveCount(0);
      expect(state.writes.at(-1)).toMatchObject({
        method: "DELETE",
        path: `/notifications/channels/${id(4)}`,
      });
      await expect(channelTable().locator("tbody tr")).toHaveCount(3);
    },
  );

  await check(
    "the delivery log pages on the server and keeps its filters in the address",
    async () => {
      await load({ view: "delivery" });
      const log = page.getByRole("table", {
        name: "Delivery log",
        exact: true,
      });
      await expect(log.locator("tbody tr")).toHaveCount(25);
      await expect(
        page.getByText("32 attempts", { exact: true }),
      ).toBeVisible();
      expect(state.deliveryQueries.at(-1)).toEqual({
        page: "1",
        page_size: "25",
      });
      await expect(log.locator("tbody tr").first()).toContainText(
        "Issue on edge-fra-01: http-out can't deliver events",
      );
      await expect(log.locator("tbody tr").nth(2)).toContainText("Retrying");
      await expect(log.locator("tbody tr").nth(2)).toContainText("Next try");
      await expect(log.locator("tbody tr").nth(4)).toContainText("Gave up");
      await expect(log.locator("tbody tr").nth(4)).toContainText(
        "No more tries after 4 attempts.",
      );
      await expect(log.locator("tbody tr").nth(5)).toContainText("Test");
      for (const name of ["light", "dark"]) {
        await theme(name);
        await axe("delivery log", name);
        await shot(`delivery-${name}.png`);
      }
      await theme("light");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(log.locator("tbody tr")).toHaveCount(7);
      expect(page.url()).toContain("view=delivery");
      expect(page.url()).toContain("page=2");
      expect(state.deliveryQueries.at(-1)).toEqual({
        page: "2",
        page_size: "25",
      });
      await page
        .getByRole("group", { name: "Result" })
        .getByRole("button", { name: "Gave up" })
        .click();
      await expect(log.locator("tbody tr")).toHaveCount(5);
      expect(page.url()).toContain("outcome=gave_up");
      expect(page.url()).not.toContain("page=");
      await page
        .getByRole("combobox", { name: "Channel" })
        .selectOption({ label: "Incident receiver" });
      await expect
        .poll(() => state.deliveryQueries.at(-1))
        .toEqual({
          page: "1",
          page_size: "25",
          channel_id: id(2),
          outcome: "gave_up",
        });
      await expect(
        page.getByRole("heading", { name: "No matching attempts" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(log.locator("tbody tr")).toHaveCount(25);
      expect(page.url()).not.toContain("outcome=");
    },
  );

  await check(
    "detection thresholds keep the server's bounds, reset to defaults and ask before unsaved edits are lost",
    async () => {
      await load({
        view: "detection",
        detection: {
          thresholds: {
            ...defaults,
            sink_errors_per_minute: 20,
            buffer_full_percent: 90,
          },
          defaults,
          bounds,
          revision: 2,
          updated_at: ago(60),
          updated_by_name: "Synthetic administrator",
          evaluation_interval_seconds: 25,
        },
      });
      const buffer = page.getByRole("textbox", { name: "Full buffer" });
      const sink = page.getByRole("textbox", { name: "Failing destination" });
      const save = page.getByRole("button", { name: "Save changes" });
      await expect(buffer).toHaveValue("90");
      await expect(sink).toHaveValue("20");
      await expect(
        page.getByText("Changed by Synthetic administrator"),
      ).toBeVisible();
      await expect(save).toBeDisabled();
      for (const name of ["light", "dark"]) {
        await theme(name);
        await axe("detection", name);
        await shot(`detection-${name}.png`, { fullPage: true });
      }
      await theme("light");
      await buffer.fill("50");
      await expect(
        page.getByText("Enter a whole number from 55 to 100."),
      ).toBeVisible();
      await expect(save).toBeDisabled();
      await sink.fill("1");
      await expect(
        page.getByText("failed request a minute", { exact: true }),
      ).toBeVisible();
      await buffer.fill("85");
      await save.click();
      await expect.poll(() => state.writes.length).toBe(1);
      expect(state.writes[0]).toEqual({
        method: "PUT",
        path: "/detection",
        body: {
          thresholds: {
            ...defaults,
            sink_errors_per_minute: 1,
            buffer_full_percent: 85,
          },
          revision: 2,
        },
      });
      await expect
        .poll(async () => (await notices()).at(-1))
        .toEqual({
          message:
            "Detection thresholds saved. They apply from each device's next check.",
          tone: "success",
        });
      await page.getByRole("button", { name: "Reset to defaults" }).click();
      await expect(buffer).toHaveValue("95");
      await save.click();
      await expect.poll(() => state.writes.length).toBe(2);
      expect(state.writes[1].body).toEqual({
        thresholds: defaults,
        revision: 3,
      });
      await expect
        .poll(async () => (await notices()).at(-1))
        .toEqual({
          message:
            "Detection is back on the defaults. It applies from each device's next check.",
          tone: "success",
        });
      await expect(
        page.getByRole("button", { name: "Reset to defaults" }),
      ).toBeDisabled();
      // An unsaved edit asks before another view replaces it.
      await buffer.fill("80");
      const asked = [];
      page.once("dialog", (question) => {
        asked.push(question.message());
        return question.dismiss();
      });
      await page.getByRole("link", { name: "Channels" }).click();
      expect(asked).toEqual(["Discard your unsaved threshold changes?"]);
      await expect(buffer).toHaveValue("80");
      page.once("dialog", (question) => question.accept());
      await page.getByRole("link", { name: "Channels" }).click();
      await expect(channelTable()).toBeVisible();
    },
  );

  await check(
    "viewers read detection thresholds but manage nothing, and never ask for channels",
    async () => {
      const before = requests.length;
      await load({ role: "viewer" });
      await expect(
        page.getByRole("heading", { name: /^Needs the .+ role$/ }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Detection" }).click();
      await expect(
        page.getByRole("textbox", { name: "Full buffer" }),
      ).toBeDisabled();
      await expect(page.getByText("Administrators change these")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Save changes" }),
      ).toHaveCount(0);
      await page.getByRole("link", { name: "Delivery log" }).click();
      await expect(
        page.getByRole("heading", { name: /^Needs the .+ role$/ }),
      ).toBeVisible();
      // Only the thresholds were read; channels and the log are administrators'.
      expect([
        ...new Set(requests.slice(before).map((r) => `${r.method} ${r.path}`)),
      ]).toEqual(["GET /detection"]);
      expect(state.deliveryQueries).toEqual([]);
      await axe("viewer detection", "light");
    },
  );

  await check(
    "at phone width channels are cards, the dialog is one column and nothing scrolls sideways",
    async () => {
      await load({ width: 390 });
      const list = page.getByRole("list", {
        name: "Notification channels",
        exact: true,
      });
      await expect(list).toBeVisible();
      await expect(channelTable()).toHaveCount(0);
      await expect(list.locator(".data-list-item")).toHaveCount(4);
      // Cards keep what the table's status column says.
      await expect(list).toContainText("Couldn't resolve alerts.example.test.");
      await expect(list).toContainText("Last delivered 2m ago");
      for (const name of ["light", "dark"]) {
        await theme(name);
        await noSidewaysScroll(390);
        await axe("channels phone", name);
        await shot(`channels-mobile-${name}.png`, { fullPage: true });
      }
      await theme("light");
      await page.getByRole("button", { name: "Add channel" }).click();
      const dialog = page.getByRole("dialog", {
        name: "Add a notification channel",
      });
      await expect(dialog).toBeVisible();
      await noSidewaysScroll(390);
      const form = await dialog.locator(".notifications-form").boundingBox();
      const aside = await dialog
        .getByRole("complementary", { name: "Message preview" })
        .boundingBox();
      expect(aside.y).toBeGreaterThan(form.y + form.height - 1);
      await axe("add dialog phone", "light");
      await shot("dialog-mobile-light.png");
      await dialog
        .getByRole("complementary", { name: "Message preview" })
        .scrollIntoViewIfNeeded();
      await theme("dark");
      await shot("dialog-mobile-preview-dark.png");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await page.getByRole("link", { name: "Delivery log" }).click();
      await expect(
        page.getByRole("list", { name: "Delivery log", exact: true }),
      ).toBeVisible();
      await noSidewaysScroll(390);
      await axe("delivery phone", "dark");
      await shot("delivery-mobile-dark.png", { fullPage: true });
      await page.getByRole("link", { name: "Detection" }).click();
      await expect(
        page.getByRole("textbox", { name: "Full buffer" }),
      ).toBeVisible();
      await theme("light");
      await noSidewaysScroll(390);
      await axe("detection phone", "light");
      await shot("detection-mobile-light.png", { fullPage: true });
      // Phone cards have no row actions: the channel's dialog offers the test.
      await page.getByRole("link", { name: "Channels" }).click();
      await page
        .getByRole("list", { name: "Notification channels", exact: true })
        .locator(".data-list-item")
        .first()
        .click();
      const edit = page.getByRole("dialog", { name: "Edit On-call Slack" });
      await expect(
        edit.getByRole("button", { name: "Send test" }),
      ).toBeVisible();
      await noSidewaysScroll(390);
      await edit.evaluate((node) => node.scrollTo(0, node.scrollHeight));
      await axe("edit dialog phone", "light");
      await shot("edit-mobile-light.png");
      await edit.getByRole("button", { name: "Send test" }).click();
      await expect
        .poll(async () => (await notices()).at(-1))
        .toEqual({
          message: "Test delivered to On-call Slack: answered 200 in 142 ms.",
          tone: "success",
        });
    },
  );

  await check(
    "a name another channel has is said at the Name field, which is marked invalid and focused, until the name changes",
    async () => {
      await load({ channels: [], nameTaken: "On-call Slack" });
      await page.getByRole("button", { name: "Add channel" }).click();
      const dialog = page.getByRole("dialog", {
        name: "Add a notification channel",
      });
      const name = dialog.getByRole("textbox", { name: "Name", exact: true });
      await name.fill("on-call slack");
      await dialog
        .getByRole("textbox", { name: "Webhook URL" })
        .fill("https://hooks.example.test/services/T000/B000/synthetic");
      const add = dialog.getByRole("button", {
        name: "Add channel",
        exact: true,
      });
      await add.click();
      const refusal = "Another channel has this name. Choose another.";
      await expect(dialog.getByText(refusal)).toBeVisible();
      // At the field only: no second copy in a banner above the form.
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await expect(name).toHaveAttribute("aria-invalid", "true");
      await expect(name).toBeFocused();
      expect(state.writes).toHaveLength(1);
      await axe("name taken", "light");
      await shot("name-taken-light.png");
      await theme("dark");
      await shot("name-taken-dark.png");
      await page.setViewportSize({ width: 390, height: 844 });
      await shot("name-taken-phone.png");
      await page.setViewportSize({ width: 1280, height: 900 });
      await theme("light");
      // A different name clears it, and saves.
      await name.fill("On-call Slack 2");
      await expect(dialog.getByText(refusal)).toHaveCount(0);
      await expect(name).not.toHaveAttribute("aria-invalid", "true");
      await add.click();
      await expect(dialog).toHaveCount(0);
      expect(state.writes).toHaveLength(2);
      expect(state.writes.at(-1).body.name).toBe("On-call Slack 2");
    },
  );
  await check(
    "the tip is one quiet line for administrators without a channel, and stays dismissed",
    async () => {
      await load({ channels: [], mount: "hint", placement: "page" });
      const tip = page.getByRole("note", { name: "Notifications" });
      await expect(tip).toHaveText(
        "Nobody is alerted when something here needs attention. Set up notifications",
      );
      await expect(
        tip.getByRole("link", { name: "Set up notifications" }),
      ).toHaveAttribute("href", "#/notifications");
      const box = await tip.boundingBox();
      expect(box.height).toBeLessThan(48);
      for (const name of ["light", "dark"]) {
        await theme(name);
        await axe("tip", name);
        await shot(`tip-${name}.png`, {
          clip: { x: 0, y: 0, width: 1280, height: 120 },
        });
      }
      await tip
        .getByRole("button", { name: "Dismiss the notifications tip" })
        .click();
      await expect(tip).toHaveCount(0);
      const asked = requests.filter(
        (r) => r.path === "/notifications/channels",
      ).length;
      await page.evaluate(() => window.mount("hint", { placement: "card" }));
      await page.waitForTimeout(300);
      await expect(
        page.getByRole("note", { name: "Notifications" }),
      ).toHaveCount(0);
      // Dismissed means it doesn't even ask again.
      expect(
        requests.filter((r) => r.path === "/notifications/channels").length,
      ).toBe(asked);
      // With a channel set up, or for anyone but an administrator, nothing shows.
      await load({ mount: "hint", placement: "card" });
      await expect
        .poll(
          () =>
            requests.filter((r) => r.path === "/notifications/channels").length,
        )
        .toBeGreaterThan(asked);
      await page.waitForTimeout(300);
      await expect(
        page.getByRole("note", { name: "Notifications" }),
      ).toHaveCount(0);
      const before = requests.length;
      await load({ channels: [], mount: "hint", role: "viewer" });
      await page.waitForTimeout(300);
      await expect(
        page.getByRole("note", { name: "Notifications" }),
      ).toHaveCount(0);
      expect(
        requests
          .slice(before)
          .filter((r) => r.path.startsWith("/notifications/")),
      ).toEqual([]);
    },
  );

  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
} catch (error) {
  failure = error;
  console.error(error);
  if (page && !page.isClosed())
    await page
      .screenshot({ path: resolve(output, "failure.png") })
      .catch(() => {});
} finally {
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Actual Settings → Notifications components and the Overview/Issues tip with synthetic channels, attempts and thresholds; every request intercepted, nothing sent.",
        passed: !failure,
        selected_test: process.env.VECTORY_NOTIFICATIONS_ONLY || null,
        results,
        accessibility,
        screenshots,
        requests,
        unexpected,
        errors,
        ...(failure ? { failure: failure.message } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await server.close();
  console.log("Evidence: " + relative(root, resolve(output, "report.json")));
}
if (failure) throw failure;
