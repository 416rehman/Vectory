// "Check on devices" in the deploy review: the real dialog, intercepted
// synthetic HTTP only. The synthetic server answers when the harness says a
// device answered; nothing here claims a real host validated anything.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { fleetReplies, natural, nothingOffered } from "./fleet-replies.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_DEVICE_CHECK_OUTPUT || ".local/device-check",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:device-check";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "device-check",
      resolveId(id) {
        if (id === "virtual:device-check") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return [
          "import React from 'react';import{createRoot}from'react-dom/client';",
          "import TargetDialog from'/src/TargetDialog.tsx';import{setCSRF}from'/src/api.ts';",
          "import{applyTheme}from'/src/appearance.ts';import'/src/styles.css';",
          "setCSRF('synthetic-csrf');const root=createRoot(document.getElementById('root'));let key=0;",
          // Callers unmount the dialog when it closes; so does this page.
          "window.mount=(props={})=>{applyTheme(localStorage.getItem('vectory-theme')==='dark'?'dark':'light');",
          "window.notices=[];window.dialogClosed=false;",
          "root.render(React.createElement(TargetDialog,{key:++key,onDone:x=>window.notices.push(x),onClose:()=>{window.dialogClosed=true;root.render(null)},...props}));};",
          "window.ready=true;",
        ].join("\n");
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__device-check") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic device check</title></head><body><div id="root"></div><script type="module">import "virtual:device-check";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = "http://127.0.0.1:" + port;
const browser = await chromium.launch();
const results = [],
  accessibility = [],
  screenshots = [];

const id = (n) => "11111111-2222-4333-8444-" + String(n).padStart(12, "0");
const minutes = (n) => new Date(Date.now() + n * 60000).toISOString();
const userId = id(99);
const sha = (n) => String(n % 10).repeat(64);

const device = (n, name, extra = {}) => ({
  id: id(10 + n),
  name,
  os: "linux",
  arch: "amd64",
  vector_version: "0.58.0",
  agent_version: "synthetic",
  status: "online",
  apply_state: "unmanaged",
  desired_generation: 0,
  reported_generation: 0,
  configuration_mode: "full",
  labels: {},
  sync_paused: false,
  local_paused: false,
  pause_acknowledged: false,
  effective_policy: {
    heartbeat_seconds: 60,
    sync_paused: false,
    telemetry_enabled: true,
  },
  telemetry: null,
  last_seen: minutes(0),
  created_at: "2026-09-27T00:00:00Z",
  ...extra,
});
// One device for each state the check can end in.
const NAMES = {
  pass: "edge-nyc-01",
  fix: "edge-nyc-02",
  secret: "edge-fra-01",
  winSecret: "win-ams-01",
  late: "edge-late-01",
  offline: "edge-lon-01",
  old: "edge-old-01",
};
function sevenDevices() {
  return [
    device(0, NAMES.pass),
    device(1, NAMES.fix),
    device(2, NAMES.secret, { secret_names: ["DD_API_KEY"] }),
    device(3, NAMES.winSecret, { os: "windows" }),
    device(4, NAMES.late),
    device(5, NAMES.offline, { status: "offline", last_seen: minutes(-180) }),
    device(6, NAMES.old),
  ];
}
const version = {
  id: id(51),
  configuration_id: id(50),
  number: 3,
  config: {
    sources: { seed: { type: "demo_logs", format: "json" } },
    sinks: { discard: { type: "blackhole", inputs: ["seed"] } },
    tests: [{ name: "adds a field" }, { name: "drops noise" }],
  },
  sha256: "0".repeat(64),
  artifact: "{}",
  size: 2,
  created_at: "2026-09-27T00:00:00Z",
  message: "Synthetic version",
};
const idOf = (f, name) => f.devices.find((item) => item.name === name).id;

// Restricted hosts: Vectory never sees what a host allows, so the review says
// what a version uses as a condition and drops it only for a device a check
// passed on, or whose verified running version already uses the same.
const COLLECTOR = "http://127.0.0.1:8678/collect";
const withSink = (uri, extra = {}) => ({
  ...version,
  config: {
    sources: { seed: { type: "demo_logs", format: "json" } },
    sinks: {
      out: {
        type: "http",
        inputs: ["seed"],
        uri,
        encoding: { codec: "json" },
      },
    },
  },
  ...extra,
});
/** What a device's own record says it verifiably runs. */
const runs = (candidate) => ({
  id: candidate.id,
  number: candidate.number,
  configuration_id: candidate.configuration_id,
  configuration_name: "Synthetic logs",
});
const restricted = (n, name, extra = {}) =>
  device(n, name, {
    configuration_mode: "restricted",
    state_dir: "/srv/vectory state",
    service_manager: "none",
    ...extra,
  });
/** The review's rows (not the check's), inside a dialog locator. */
const reviewedRows = (scope) =>
  scope
    .locator("tbody tr")
    .filter({ has: scope.page().locator(".target-outcome") });

/** What each device answers, as the agent words it. */
const finding = (message, extra = {}) => ({
  severity: "error",
  code: "VECTOR_VALIDATION",
  message,
  ...extra,
});
const answers = {
  pass: {
    state: "passed",
    valid: true,
    duration_ms: 1400,
    tests: [
      { name: "adds a field", passed: true },
      { name: "drops noise", passed: true },
    ],
  },
  fix: {
    state: "failed",
    valid: false,
    duration_ms: 2100,
    diagnostics: [
      finding(
        'Sink "discard" (http) sends to 10.0.0.9:9, which this host does not allow.',
        {
          code: "CAPABILITY_DENIED",
          component_kind: "sink",
          component_id: "discard",
          field: "uri",
          hint: "Run vectory allow --network 10.0.0.9:9 on the host.",
        },
      ),
      finding("Source seed needs a listener below port 1024.", {
        code: "PRIVILEGED_PORT",
        component_kind: "source",
        component_id: "seed",
      }),
      {
        ...finding("The data directory is not writable."),
        severity: "warning",
      },
    ],
    tests: [
      { name: "adds a field", passed: false, message: "Condition failed." },
      { name: "drops noise", passed: false, not_run: true },
    ],
  },
  secret: (...names) => ({
    state: "failed",
    valid: false,
    duration_ms: 30,
    secrets_missing: names,
    diagnostics: names.map((name) =>
      finding(`This device has no file bound to secret "${name}".`, {
        code: "SECRET_BINDING_MISSING",
        component_kind: "sink",
        component_id: "discard",
        field: "auth.token",
        hint: "Bind it on the host with configure-secrets while the agent is stopped.",
      }),
    ),
  }),
};

function scene(extra = {}) {
  const f = {
    devices: sevenDevices(),
    // What the synthetic server decides when a check is asked for.
    initial: {},
    validations: [],
    previews: [],
    creates: [],
    reads: 0,
    cap: 50,
    errors: [],
    ...extra,
  };
  for (const [name, state] of [
    [NAMES.offline, "offline"],
    [NAMES.old, "unsupported"],
  ]) {
    const found = f.devices.find((item) => item.name === name);
    if (found) f.initial[found.id] = state;
  }
  return f;
}
/** A device answers its newest pending row. */
function answer(f, name, patch) {
  const deviceId = idOf(f, name);
  const validation = [...f.validations]
    .reverse()
    .find((item) => item.rows.get(deviceId)?.state === "pending");
  if (!validation) throw new Error(`${name} has nothing pending`);
  validation.rows.set(deviceId, {
    ...validation.rows.get(deviceId),
    diagnostics: [],
    tests: [],
    secrets_missing: [],
    ...patch,
    updated_at: new Date().toISOString(),
  });
}
const answerAll = (f) => {
  answer(f, NAMES.pass, answers.pass);
  answer(f, NAMES.fix, answers.fix);
  answer(f, NAMES.secret, answers.secret("API_KEY", "TLS_KEY"));
  answer(f, NAMES.winSecret, answers.secret("API_KEY"));
  answer(f, NAMES.late, { state: "expired" });
};
const FINAL =
  "Checked 4 of 7 devices: 1 passes, 2 need a secret, 1 needs a fix, 1 offline, 1 didn't answer, 1 has an older agent.";

/** The review the server would compute for a request. */
function previewFor(f, body) {
  const selected = f.devices.filter((item) =>
    body.selector.device_ids.includes(item.id),
  );
  const shown = f.extraOn ? [...selected, f.extra] : selected;
  const picked = (body.rollout.canary_device_ids || selected.slice(0, 1)).slice(
    0,
    body.rollout.canary_size,
  );
  return {
    devices: shown,
    warnings: [],
    conflicts: [],
    outcomes: shown.map((item) => ({
      device_id: item.id,
      resource: "configuration",
      outcome: "requested",
    })),
    create_idempotency: true,
    request_correlation: true,
    blockers: [],
    configuration_name: "Synthetic logs",
    artifact_previews: shown.map((item, index) => ({
      device_id: item.id,
      sha256: sha(index),
      size: 1200,
    })),
    canary:
      body.rollout.kind === "canary"
        ? {
            size: body.rollout.canary_size,
            chosen_by_you: !!body.rollout.canary_device_ids,
            device_ids: picked,
            devices: shown.map((item) => ({
              device_id: item.id,
              device_name: item.name,
              chosen: picked.includes(item.id),
              readiness: "ready",
              reason: "Online and healthy, and it reports metrics",
            })),
          }
        : null,
  };
}
/** The check a preview with `device_validation` creates, as the server does. */
function createCheck(f, body, preview) {
  const named = [...preview.devices].sort((a, b) => natural(a.name, b.name));
  const addressed = named.slice(0, f.cap);
  const created = new Date();
  const validation = {
    id: id(500 + f.validations.length),
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + 600000).toISOString(),
    truncated: named.length > addressed.length,
    run_tests: body.run_tests === true,
    body,
    rows: new Map(),
  };
  // One outstanding check per device: an older pending row ends here.
  for (const older of f.validations)
    for (const item of addressed)
      if (older.rows.get(item.id)?.state === "pending")
        older.rows.set(item.id, {
          ...older.rows.get(item.id),
          state: "expired",
        });
  for (const item of addressed)
    validation.rows.set(item.id, {
      id: item.id,
      name: item.name,
      state: f.initial[item.id] || "pending",
      diagnostics: [],
      tests: [],
      secrets_missing: [],
      updated_at: created.toISOString(),
    });
  f.validations.push(validation);
  return validation;
}
const readable = (validation) => {
  const devices = [...validation.rows.values()].sort((a, b) =>
    natural(a.name, b.name),
  );
  return {
    id: validation.id,
    state: devices.some((item) => item.state === "pending")
      ? "running"
      : "complete",
    created_at: validation.created_at,
    expires_at: validation.expires_at,
    truncated: validation.truncated,
    run_tests: validation.run_tests,
    devices,
  };
};

async function launch(
  f,
  { width = 1280, height = 1100, theme = "light" } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
  }, theme);
  const page = await context.newPage();
  page.setDefaultTimeout(9000);
  page.on("pageerror", (e) => f.errors.push(e.message));
  const fleet = fleetReplies({ devices: () => f.devices, groups: [] });
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) {
      f.errors.push("External request " + url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = req.method();
    const reply = async (json, status = 200, headers = {}) => {
      try {
        await route.fulfill({ status, json, headers });
      } catch {
        /* The page went away while this was pending. */
      }
    };
    if (method === "POST" && path === "/deployments/preview") {
      const body = JSON.parse(req.postData());
      f.previews.push(body);
      if (body.device_validation) {
        if (f.forbid)
          return reply(
            { error: { code: "FORBIDDEN", message: "Forbidden" } },
            403,
          );
        if (f.throttle) {
          const wait = f.throttle;
          if (!wait.sticky) f.throttle = null;
          return reply(
            { error: { code: wait.code, message: "Too many requests" } },
            429,
            { "retry-after": String(wait.retryAfter) },
          );
        }
        if (f.dropStart) {
          f.dropStart = false;
          return route.abort("failed");
        }
        if (f.refuse)
          return reply(
            {
              error: {
                code: "CONFLICT",
                message: "The reviewed devices changed. Review again.",
              },
            },
            409,
          );
      }
      const preview = previewFor(f, body);
      if (!body.device_validation) return reply(preview);
      const validation = createCheck(f, body, preview);
      return reply({
        ...preview,
        validation_id: validation.id,
        validation_truncated: validation.truncated,
      });
    }
    if (method === "POST" && path === "/deployments") {
      const body = JSON.parse(req.postData());
      f.creates.push(body);
      return reply({
        id: id(101),
        ...body,
        request_correlation: true,
        request_id: body.request_id,
        operation: "create",
        source_deployment_id: null,
        status: "active",
        created_at: minutes(0),
        targets: body.expected_device_ids.map((device_id) => ({
          device_id,
          state: "pending",
          generation: 0,
        })),
      });
    }
    if (method === "GET" && path.startsWith("/device-validations/")) {
      f.reads += 1;
      f.readTimes?.push(Date.now());
      if (f.gone)
        return reply(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          404,
        );
      if (f.dropReads > 0) {
        f.dropReads -= 1;
        return route.abort("failed");
      }
      if (f.readThrottle) {
        f.readThrottle -= 1;
        return reply(
          { error: { code: "RATE_LIMITED", message: "Too many requests" } },
          429,
          { "retry-after": "1" },
        );
      }
      const validation = f.validations.find(
        (item) => item.id === path.split("/").pop(),
      );
      return validation
        ? reply(readable(validation))
        : reply({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    }
    if (method === "GET" && path.startsWith("/versions/")) {
      const key = path.split("/").pop();
      f.versionReads?.push(key);
      const found = f.versions?.[key];
      return found
        ? reply(found)
        : reply({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    }
    if (method === "POST") {
      f.errors.push("Unexpected POST " + path);
      return reply({ error: { code: "UNEXPECTED", message: path } }, 500);
    }
    const paged = fleet.handle(method, url);
    if (paged) return reply(paged.json, paged.status);
    if (path === "/status")
      return reply({ initialized: true, version: "synthetic" });
    if (path === "/devices") return reply(f.devices);
    if (path === "/groups") return reply([]);
    if (path === "/agent/releases") return reply([]);
    if (path.startsWith("/devices/") && path.endsWith("/telemetry"))
      return reply({ device_id: path.split("/")[2], samples: [] });
    if (path.startsWith("/devices/") && path.endsWith("/configuration"))
      return reply(nothingOffered(path.split("/")[2]));
    f.errors.push("Unexpected " + method + " " + path);
    return reply({ error: { code: "UNEXPECTED", message: path } }, 404);
  });
  return { page, context, close: () => context.close() };
}

/** The dialog, with the devices chosen and the review open. */
async function openReview(f, { names, canary = false, ...options } = {}) {
  const app = await launch(f, options);
  await app.page.goto(origin + "/__device-check");
  await app.page.waitForFunction(() => window.ready);
  const props = options.props || {};
  await app.page.evaluate(
    ({ version, userId, props }) =>
      window.mount({
        open: true,
        userId,
        version,
        pipelineName: "Synthetic logs",
        ...props,
      }),
    { version: options.version || version, userId, props },
  );
  const dialog = app.page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if (!props.initialDeviceIds)
    for (const name of names || f.devices.map((item) => item.name))
      await dialog.getByLabel(`Select ${name}`).check();
  if (canary) await dialog.getByRole("radio", { name: /Canary/ }).check();
  await dialog.getByRole("button", { name: "Review deployment" }).click();
  const check = dialog.getByRole("region", { name: "Check on devices" });
  await expect(check).toBeVisible();
  return { ...app, dialog, check };
}
const askButton = (check, name = "Check on devices") =>
  check.getByRole("button", { name, exact: true });
const summary = (check) => check.locator(".device-check-summary");
const rowOf = (check, name) =>
  check.getByRole("row", { name: new RegExp(name) });
const noErrors = (f) => expect(f.errors).toEqual([]);
/** What in the check reaches past the dialog, outside a box that scrolls on its own. */
const overflowing = (page) =>
  page.evaluate(() => {
    const edge = document.querySelector(".modal").getBoundingClientRect().right;
    const scrolls = (e) => {
      for (
        let n = e.parentElement;
        n && n.matches(".device-check *");
        n = n.parentElement
      )
        if (getComputedStyle(n).overflowX !== "visible") return true;
      return false;
    };
    return [...document.querySelectorAll(".device-check *")]
      .filter(
        (e) =>
          e.getBoundingClientRect().width > 0 &&
          e.getBoundingClientRect().right > edge + 1 &&
          !scrolls(e),
      )
      .slice(0, 5)
      .map(
        (e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 50)}`,
      );
  });
async function shot(page, check, name) {
  await check.scrollIntoViewIfNeeded();
  const file = `${name}.png`;
  await page.screenshot({ path: resolve(output, file) });
  screenshots.push(file);
}
async function scan(page, label, width, theme) {
  const axe = await new AxeBuilder({ page }).analyze();
  accessibility.push({
    width,
    theme,
    page: label,
    violations: axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target),
    })),
  });
  expect(axe.violations).toEqual([]);
}
const check = async (name, run) => {
  const at = Date.now();
  try {
    await run();
    results.push({ name, passed: true, duration_ms: Date.now() - at });
  } catch (e) {
    results.push({
      name,
      passed: false,
      error: e.message,
      duration_ms: Date.now() - at,
    });
  }
  console.log((results.at(-1).passed ? "PASS " : "FAIL ") + name);
  if (!results.at(-1).passed) console.log(results.at(-1).error);
};

const asked = (f) => f.previews.filter((body) => body.device_validation);
const settle = (ms = 2600) => new Promise((done) => setTimeout(done, ms));
const WAIT = { timeout: 9000 };

try {
  await check(
    "The review offers the check without starting it, and Deploy never depends on it",
    async () => {
      const f = scene();
      const app = await openReview(f);
      const { page, dialog, check: section } = app;
      try {
        await expect(section).toContainText(
          "Runs the check on each host. It doesn't start or change anything.",
        );
        const tests = section.getByRole("switch", {
          name: "Also run the pipeline's tests",
        });
        await expect(tests).not.toBeChecked();
        await expect(section).toContainText("2 tests");
        const deploy = dialog.getByRole("button", {
          name: "Deploy to devices",
        });
        await expect(deploy).toBeEnabled();
        // Nothing is asked of any device until the button is pressed.
        await page.waitForTimeout(500);
        expect(asked(f)).toHaveLength(0);
        expect(f.reads).toBe(0);
        await expect(summary(section)).toHaveCount(0);
        // The live region exists before anything is said in it.
        await expect(
          section.locator('.device-check-live[role="status"]'),
        ).toHaveCount(1);
        await shot(page, section, "idle-1280-light");
        await askButton(section).click();
        await expect.poll(() => asked(f).length).toBe(1);
        // The request is the reviewed one, plus the two flags.
        expect(asked(f)[0]).toEqual({
          ...f.previews[0],
          device_validation: true,
          run_tests: false,
        });
        await expect(deploy).toBeEnabled();
        await expect(deploy).toHaveText("Deploy to devices");
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Every state arrives as the devices answer, and the summary line stays true",
    async () => {
      const f = scene();
      f.readTimes = [];
      const app = await openReview(f);
      const { page, dialog, check: section } = app;
      try {
        await askButton(section).click();
        const table = section.getByRole("table", {
          name: "Check results by device",
        });
        // Offline and older agents are decided at once; the rest are being checked.
        await expect(summary(section)).toContainText(
          "Checked 0 of 7 devices so far: 1 offline, 1 has an older agent, 5 still checking.",
          WAIT,
        );
        await expect(askButton(section, "Checking…")).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await expect(table.getByRole("row")).toHaveCount(8);
        for (const name of [
          NAMES.pass,
          NAMES.fix,
          NAMES.secret,
          NAMES.winSecret,
          NAMES.late,
        ])
          await expect(rowOf(section, name)).toContainText("Checking…");
        await expect(rowOf(section, NAMES.offline)).toContainText(
          "Offline: not checked",
        );
        await expect(rowOf(section, NAMES.old)).toContainText(
          "Older agent: can't check",
        );
        await expect(section).toContainText(
          "Results are advisory. Deploy doesn't wait for them.",
        );
        await expect(section).toContainText(
          "Each device answers at its next check-in. A check expires after 10 minutes.",
        );
        // A check is read every two seconds while anything is pending.
        await page.waitForTimeout(4600);
        const gaps = f.readTimes.slice(1).map((at, i) => at - f.readTimes[i]);
        expect(gaps.length).toBeGreaterThanOrEqual(2);
        for (const gap of gaps) expect(gap).toBeGreaterThan(1500);
        for (const gap of gaps) expect(gap).toBeLessThan(5000);
        await shot(page, section, "running-1280-light");

        answer(f, NAMES.pass, answers.pass);
        await expect(summary(section)).toContainText(
          "Checked 1 of 7 devices so far: 1 passes, 1 offline, 1 has an older agent, 4 still checking.",
          WAIT,
        );
        const pass = rowOf(section, NAMES.pass);
        await expect(pass).toContainText("Passes here");
        await expect(pass).toContainText(
          "Validation found no error on this host.",
        );
        await expect(pass).toContainText("2 of 2 tests pass · Took 1.4 s");
        answer(f, NAMES.fix, answers.fix);
        answer(f, NAMES.secret, answers.secret("API_KEY", "TLS_KEY"));
        answer(f, NAMES.winSecret, answers.secret("API_KEY"));
        answer(f, NAMES.late, { state: "expired" });
        await expect(summary(section)).toContainText(FINAL, WAIT);
        await expect(askButton(section, "Check again")).toBeVisible();
        // The deployment's own button never changed.
        await expect(
          dialog.getByRole("button", { name: "Deploy to devices" }),
        ).toBeEnabled();

        // A failure leads with where, what and the fix, and opens to the rest.
        const fix = rowOf(section, NAMES.fix);
        await expect(fix).toContainText("Needs a fix");
        await expect(fix).toContainText(
          'Sink "discard" (http) sends to 10.0.0.9:9, which this host does not allow.',
        );
        await expect(
          fix.locator("code", { hasText: /^discard$/ }),
        ).toBeVisible();
        await expect(fix.locator("code", { hasText: /^uri$/ })).toBeVisible();
        await expect(fix).toContainText(
          "Fix Run vectory allow --network 10.0.0.9:9 on the host.",
        );
        await expect(
          fix.getByText("Source seed needs a listener below port 1024."),
        ).toBeHidden();
        await fix.getByText(/2 more findings/).click();
        await expect(fix).toContainText(
          "Source seed needs a listener below port 1024.",
        );
        await expect(fix).toContainText("The data directory is not writable.");
        await expect(fix).toContainText("Condition failed.");
        await expect(fix).toContainText("Didn't run");
        await shot(page, section, "complete-expanded-1280-light");

        // A missing secret names itself and brings the exact commands to copy.
        const secret = rowOf(section, NAMES.secret);
        await expect(secret).toContainText("Needs a secret");
        await expect(secret).toContainText(
          "Secret API_KEY isn't bound on this device.",
        );
        await expect(secret).toContainText(
          "Secret TLS_KEY isn't bound on this device.",
        );
        await expect(secret).toContainText(
          "sudo vectory configure-secrets --secret-files /etc/vectory/secret-bindings.json",
        );
        const commands = [
          "sudo vectory service-stop",
          "sudo vectory configure-secrets --secret-files /etc/vectory/secret-bindings.json",
          "sudo vectory service-start",
        ].join("\n");
        await secret
          .getByRole("button", {
            name: `Copy the commands for ${NAMES.secret}`,
          })
          .click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          commands,
        );
        // The bindings file keeps what the host already has bound.
        await secret.getByText("Bindings file").click();
        await expect(secret).toContainText("DD_API_KEY");
        await expect(secret).toContainText("API_KEY");
        const windows = rowOf(section, NAMES.winSecret);
        await expect(windows).toContainText(
          "vectory configure-secrets --secret-files C:\\ProgramData\\Vectory\\secret-bindings.json",
        );
        await expect(windows).not.toContainText("sudo");

        await expect(rowOf(section, NAMES.late)).toContainText(
          "No answer in time",
        );
        await expect(rowOf(section, NAMES.late)).toContainText(
          "It didn't answer in time. A check lasts 10 minutes, and a newer check for the same device replaces it.",
        );
        await expect(rowOf(section, NAMES.offline)).toContainText(
          "Last seen 3h ago.",
        );
        const old = rowOf(section, NAMES.old);
        await expect(old).toContainText(
          "Choose Upgrade agent on its device page",
        );
        await expect(
          old.getByRole("link", { name: /Open edge-old-01/ }),
        ).toHaveAttribute("href", `#/devices/${idOf(f, NAMES.old)}`);
        // Ask again where something can still change; nowhere else.
        for (const name of [NAMES.late, NAMES.offline, NAMES.old])
          await expect(
            section.getByRole("button", { name: `Retry ${name}` }),
          ).toBeVisible();
        for (const name of [NAMES.fix, NAMES.secret, NAMES.winSecret])
          await expect(
            section.getByRole("button", { name: `Check ${name} again` }),
          ).toBeVisible();
        await expect(
          section.getByRole("button", { name: /edge-nyc-01/ }),
        ).toHaveCount(0);

        // Complete: nothing is read again.
        const reads = f.reads;
        await settle();
        expect(f.reads).toBe(reads);
        await shot(page, section, "complete-1280-light");
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Retry asks only the device or devices named, and leaves every other answer",
    async () => {
      const f = scene();
      const app = await openReview(f);
      const { page, check: section } = app;
      try {
        await askButton(section).click();
        await expect(summary(section)).toContainText("5 still checking", WAIT);
        answerAll(f);
        await expect(summary(section)).toContainText(FINAL, WAIT);
        // One device: the one that was offline has come back.
        delete f.initial[idOf(f, NAMES.offline)];
        await section
          .getByRole("button", { name: `Retry ${NAMES.offline}` })
          .click();
        await expect.poll(() => asked(f).length).toBe(2);
        const retry = asked(f)[1];
        expect(retry.selector).toEqual({
          device_ids: [idOf(f, NAMES.offline)],
          group_ids: [],
          exclude_ids: [],
        });
        expect(retry).not.toHaveProperty("replaces");
        expect(retry.rollout.kind).toBe("all");
        expect(retry.device_validation).toBe(true);
        // It reads "Checking…" at once and keeps the keyboard's place.
        await expect(rowOf(section, NAMES.offline)).toContainText("Checking…");
        await expect(rowOf(section, NAMES.offline)).toBeFocused();
        await expect(rowOf(section, NAMES.fix)).toContainText("Needs a fix");
        await expect(rowOf(section, NAMES.secret)).toContainText(
          "Needs a secret",
        );
        await expect(summary(section)).toContainText(
          "Checked 4 of 7 devices so far: 1 passes, 2 need a secret, 1 needs a fix, 1 didn't answer, 1 has an older agent, 1 still checking.",
          WAIT,
        );
        answer(f, NAMES.offline, answers.pass);
        await expect(summary(section)).toContainText(
          "Checked 5 of 7 devices: 2 pass, 2 need a secret, 1 needs a fix, 1 didn't answer, 1 has an older agent.",
          WAIT,
        );
        // Everything that didn't answer, at once.
        await section
          .getByRole("button", { name: "Retry 1 unanswered" })
          .click();
        await expect.poll(() => asked(f).length).toBe(3);
        expect(asked(f)[2].selector.device_ids).toEqual([idOf(f, NAMES.late)]);
        answer(f, NAMES.late, answers.fix);
        await expect(summary(section)).toContainText(
          "Checked 6 of 7 devices: 2 pass, 2 need a secret, 2 need a fix, 1 has an older agent.",
          WAIT,
        );
        await expect(
          section.getByRole("button", { name: /unanswered/ }),
        ).toHaveCount(0);
        // A failed device checks again once its host is fixed.
        await section
          .getByRole("button", { name: `Check ${NAMES.secret} again` })
          .click();
        await expect.poll(() => asked(f).length).toBe(4);
        expect(asked(f)[3].selector.device_ids).toEqual([
          idOf(f, NAMES.secret),
        ]);
        answer(f, NAMES.secret, answers.pass);
        await expect(summary(section)).toContainText(
          "Checked 6 of 7 devices: 3 pass, 1 needs a secret, 2 need a fix, 1 has an older agent.",
          WAIT,
        );
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Asking again for several devices sends one request for just those",
    async () => {
      const f = scene();
      const app = await openReview(f);
      const { check: section } = app;
      try {
        await askButton(section).click();
        await expect(summary(section)).toContainText("5 still checking", WAIT);
        answerAll(f);
        await expect(summary(section)).toContainText(FINAL, WAIT);
        delete f.initial[idOf(f, NAMES.offline)];
        await section
          .getByRole("button", { name: "Retry 2 unanswered" })
          .click();
        await expect.poll(() => asked(f).length).toBe(2);
        expect([...asked(f)[1].selector.device_ids].sort()).toEqual(
          [idOf(f, NAMES.late), idOf(f, NAMES.offline)].sort(),
        );
        // The button that asked is gone: the keyboard goes to the first device asked.
        await expect(rowOf(section, NAMES.late)).toBeFocused();
        answer(f, NAMES.late, answers.pass);
        answer(f, NAMES.offline, answers.fix);
        await expect(summary(section)).toContainText(
          "Checked 6 of 7 devices: 2 pass, 2 need a secret, 2 need a fix, 1 has an older agent.",
          WAIT,
        );
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "The tests switch is the run_tests flag, for the check and for a retry",
    async () => {
      const f = scene();
      const app = await openReview(f);
      const { check: section } = app;
      try {
        const tests = section.getByRole("switch", {
          name: "Also run the pipeline's tests",
        });
        await tests.check();
        await askButton(section).click();
        await expect.poll(() => asked(f).length).toBe(1);
        expect(asked(f)[0].run_tests).toBe(true);
        await expect(summary(section)).toContainText("5 still checking", WAIT);
        answerAll(f);
        await expect(summary(section)).toContainText(FINAL, WAIT);
        await tests.uncheck();
        await section
          .getByRole("button", { name: `Retry ${NAMES.old}` })
          .click();
        await expect.poll(() => asked(f).length).toBe(2);
        expect(asked(f)[1].run_tests).toBe(false);
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "A pipeline without tests says so and leaves the switch off",
    async () => {
      const f = scene();
      const app = await openReview(f, {
        version: {
          ...version,
          config: { ...version.config, tests: undefined },
        },
      });
      const { check: section } = app;
      try {
        const tests = section.getByRole("switch", {
          name: "Also run the pipeline's tests",
        });
        await expect(tests).toBeDisabled();
        await expect(tests).not.toBeChecked();
        await expect(section).toContainText("This pipeline has no tests.");
        await askButton(section).click();
        await expect.poll(() => asked(f).length).toBe(1);
        expect(asked(f)[0].run_tests).toBe(false);
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "On a phone each device is a card, nothing overflows and both themes pass axe",
    async () => {
      for (const [width, height] of [
        [390, 844],
        [320, 700],
      ])
        for (const theme of ["light", "dark"]) {
          const f = scene();
          const app = await openReview(f, { width, height, theme });
          const { page, dialog, check: section } = app;
          try {
            await shot(page, section, `idle-${width}-${theme}`);
            await askButton(section).click();
            await expect(summary(section)).toContainText(
              "5 still checking",
              WAIT,
            );
            await expect(section.locator(".device-check-card")).toHaveCount(7);
            await expect(section.getByRole("table")).toHaveCount(0);
            await shot(page, section, `running-${width}-${theme}`);
            answerAll(f);
            await expect(summary(section)).toContainText(FINAL, WAIT);
            const secret = section.locator(".device-check-card", {
              hasText: NAMES.secret,
            });
            await expect(secret).toContainText("Needs a secret");
            await expect(secret).toContainText(
              "Secret API_KEY isn't bound on this device.",
            );
            await expect(
              secret.getByRole("button", {
                name: `Copy the commands for ${NAMES.secret}`,
              }),
            ).toBeVisible();
            await expect(
              dialog.getByRole("button", { name: "Deploy to devices" }),
            ).toBeVisible();
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            expect(await overflowing(page)).toEqual([]);
            await scan(page, "check-results", width, theme);
            await shot(page, section, `complete-${width}-${theme}`);
            noErrors(f);
          } finally {
            await app.close();
          }
        }
    },
  );

  await check(
    "At 768 px the results are a table, and in dark at 1280 px they pass axe",
    async () => {
      for (const [width, theme] of [
        [768, "light"],
        [1280, "dark"],
        [1440, "light"],
      ]) {
        const f = scene();
        const app = await openReview(f, { width, theme });
        const { page, check: section } = app;
        try {
          await askButton(section).click();
          await expect(summary(section)).toContainText(
            "5 still checking",
            WAIT,
          );
          answerAll(f);
          await expect(summary(section)).toContainText(FINAL, WAIT);
          await expect(
            section.getByRole("table", { name: "Check results by device" }),
          ).toBeVisible();
          await expect(section.locator(".device-check-card")).toHaveCount(0);
          expect(await overflowing(page)).toEqual([]);
          await scan(page, "check-results", width, theme);
          await shot(page, section, `complete-${width}-${theme}`);
          noErrors(f);
        } finally {
          await app.close();
        }
      }
    },
  );

  await check(
    "A 429 says how long to wait and waits for it, for both limits",
    async () => {
      const f = scene();
      const app = await openReview(f);
      const { page, dialog, check: section } = app;
      try {
        f.throttle = { code: "RATE_LIMITED", retryAfter: 3 };
        await askButton(section).click();
        const note = section.locator(".device-check-note");
        await expect(note).toContainText(
          /Checks are limited to a few a minute\. Try again in [123] s\./,
        );
        await expect(askButton(section)).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await expect(summary(section)).toHaveCount(0);
        await shot(page, section, "limited-1280-light");
        // Nothing was asked of any device, and Deploy is untouched.
        await settle(300);
        await askButton(section).click({ force: true });
        expect(asked(f)).toHaveLength(1);
        await expect(
          dialog.getByRole("button", { name: "Deploy to devices" }),
        ).toBeEnabled();
        // The wait ends on its own.
        await expect(askButton(section)).not.toHaveAttribute(
          "aria-disabled",
          "true",
          {
            timeout: 7000,
          },
        );
        await expect(note).toHaveCount(0);
        await askButton(section).click();
        await expect(summary(section)).toContainText("5 still checking", WAIT);
        expect(asked(f)).toHaveLength(2);
        // The server's other limit, a minute long.
        f.throttle = { code: "CAPACITY_BUSY", retryAfter: 60 };
        await section
          .getByRole("button", { name: `Retry ${NAMES.old}` })
          .click();
        await expect(note).toContainText(
          /Too many checks are waiting for devices to answer\. Try again in (1 min|\d+ s)\./,
        );
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Each way a request can fail has a calm message and leaves Deploy alone",
    async () => {
      const f = scene();
      const app = await openReview(f);
      const { page, dialog, check: section } = app;
      try {
        const note = section.locator(".device-check-note");
        const deploy = dialog.getByRole("button", {
          name: "Deploy to devices",
        });
        f.forbid = true;
        await askButton(section).click();
        await expect(note).toContainText(
          "Your role can't run a check. Ask an operator or administrator.",
        );
        await expect(deploy).toBeEnabled();
        await shot(page, section, "role-1280-light");
        f.forbid = false;
        f.dropStart = true;
        await askButton(section).click();
        await expect(note).toContainText(
          "Vectory didn't answer, so the check may not have started. Try again.",
        );
        await shot(page, section, "network-1280-light");
        await expect(askButton(section)).not.toHaveAttribute(
          "aria-disabled",
          "true",
        );
        f.refuse = true;
        await askButton(section).click();
        await expect(note).toContainText(
          "The reviewed devices changed. Review again.",
        );
        f.refuse = false;
        await askButton(section).click();
        await expect(note).toHaveCount(0);
        await expect(summary(section)).toContainText("5 still checking", WAIT);
        await expect(deploy).toBeEnabled();
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "A read that fails is retried, a 429 is waited out, and gone results are never shown as current",
    async () => {
      const f = scene();
      const app = await openReview(f);
      const { page, check: section } = app;
      try {
        const note = section.locator(".device-check-note");
        f.dropReads = 1;
        await askButton(section).click();
        await expect(note).toContainText(
          "Can't reach Vectory. Trying again…",
          WAIT,
        );
        await expect(summary(section)).toContainText("Asking the devices…");
        // The next try works: the message goes and the devices appear.
        await expect(summary(section)).toContainText("5 still checking", {
          timeout: 12000,
        });
        await expect(note).toHaveCount(0);
        f.readThrottle = 1;
        await expect(note).toContainText(
          /Too many requests just now\. The results load again in 1 s\./,
          {
            timeout: 6000,
          },
        );
        await expect(note).toHaveCount(0, { timeout: 8000 });
        // The server forgot the check: the rows go, with a way to ask again.
        f.gone = true;
        await expect(note).toContainText(
          "These results are no longer available. Check again for current ones.",
          WAIT,
        );
        await expect(section.getByRole("table")).toHaveCount(0);
        await expect(summary(section)).toHaveCount(0);
        await expect(askButton(section)).not.toHaveAttribute(
          "aria-disabled",
          "true",
        );
        f.gone = false;
        await askButton(section).click();
        await expect(summary(section)).toContainText("5 still checking", WAIT);
        await shot(page, section, "recovered-1280-light");
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Results are for the review they were asked on: a changed selection says so, and going back clears them",
    async () => {
      const f = scene();
      f.extra = device(9, "edge-new-01");
      f.devices.push(f.extra);
      const names = f.devices.slice(0, 4).map((item) => item.name);
      const app = await openReview(f, { names, canary: true });
      const { page, dialog, check: section } = app;
      try {
        await askButton(section).click();
        await expect(summary(section)).toContainText(
          "Checked 0 of 4 devices so far",
          WAIT,
        );
        answer(f, NAMES.pass, answers.pass);
        await expect(summary(section)).toContainText("1 passes", WAIT);
        // The review is computed again with a device that wasn't there.
        f.extraOn = true;
        await dialog.getByRole("button", { name: /Canary devices:/ }).click();
        const menu = page.getByRole("dialog", { name: "Canary devices" });
        await menu.getByRole("radio", { name: /edge-nyc-02/ }).check();
        await menu.getByRole("button", { name: "Apply" }).click();
        await expect(section).toContainText(
          "These results are for the previous selection.",
          WAIT,
        );
        await expect(section.getByRole("table")).toHaveCount(0);
        await expect(summary(section)).toHaveCount(0);
        await expect(askButton(section)).toHaveText("Check on devices");
        await shot(page, section, "previous-selection-1280-light");
        // Nothing is read for a check that no longer belongs here.
        const reads = f.reads;
        await settle();
        expect(f.reads).toBe(reads);
        // Asking again checks the selection as it is now.
        await askButton(section).click();
        await expect(summary(section)).toContainText(
          "Checked 0 of 5 devices so far",
          WAIT,
        );
        await expect(section).not.toContainText("previous selection");
        await expect(rowOf(section, "edge-new-01")).toBeVisible();
        // Going back to the selection and reviewing again starts clean.
        await dialog.getByRole("button", { name: "Back to selection" }).click();
        await dialog.getByRole("button", { name: "Review deployment" }).click();
        await expect(section).toBeVisible();
        await expect(summary(section)).toHaveCount(0);
        await expect(section.getByRole("table")).toHaveCount(0);
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Polling stops when the dialog closes and when a deployment is sent, and Deploy works mid-check",
    async () => {
      for (const way of ["close", "deploy"]) {
        const f = scene();
        const app = await openReview(f);
        const { page, dialog, check: section } = app;
        try {
          await askButton(section).click();
          await expect(summary(section)).toContainText(
            "5 still checking",
            WAIT,
          );
          if (way === "close") {
            await dialog.getByRole("button", { name: "Close dialog" }).click();
            await expect(page.getByRole("dialog")).toHaveCount(0);
          } else {
            // Nothing about the check blocks the deployment.
            await dialog
              .getByRole("button", { name: "Deploy to devices" })
              .click();
            await expect(dialog).toContainText("Deployment created");
            expect(f.creates).toHaveLength(1);
          }
          const reads = f.reads;
          await settle();
          expect(f.reads).toBe(reads);
          noErrors(f);
        } finally {
          await app.close();
        }
      }
    },
  );

  await check(
    "More than 50 devices: the first 50 by name are checked and the rest are named",
    async () => {
      const devices = Array.from({ length: 53 }, (_, n) =>
        device(n, `edge-${String(n + 1).padStart(2, "0")}`),
      );
      const f = scene({ devices });
      f.initial = {};
      const app = await openReview(f, {
        props: {
          initialDeviceIds: devices.map((item) => item.id),
          initialDevices: devices,
        },
      });
      const { page, check: section } = app;
      try {
        await askButton(section).click();
        await expect(summary(section)).toContainText(
          "Checked 0 of 50 devices so far: 50 still checking.",
          WAIT,
        );
        await expect(section.locator(".device-check-truncated")).toHaveText(
          "Checked the first 50 devices by name. The other 3 weren't checked.",
        );
        await expect(section.getByRole("table").getByRole("row")).toHaveCount(
          51,
        );
        // 50 rows scroll inside the table, not the dialog.
        const scrolls = await section
          .locator(".device-check-table-wrap")
          .evaluate((node) => node.scrollHeight > node.clientHeight + 20);
        expect(scrolls).toBe(true);
        await expect(rowOf(section, "edge-50")).toBeAttached();
        await expect(rowOf(section, "edge-51")).toHaveCount(0);
        await shot(page, section, "truncated-1280-light");
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "The keyboard reaches everything in order, focus stays in the dialog and motion follows the preference",
    async () => {
      const f = scene();
      const app = await openReview(f);
      const { page, dialog, check: section } = app;
      try {
        const inside = () =>
          page.evaluate(
            () => !!document.activeElement?.closest('[role="dialog"]'),
          );
        await section
          .getByRole("switch", { name: "Also run the pipeline's tests" })
          .focus();
        await page.keyboard.press("Tab");
        await expect(askButton(section)).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(askButton(section, "Checking…")).toBeFocused({
          timeout: 9000,
        });
        expect(await inside()).toBe(true);
        await expect(summary(section)).toContainText("5 still checking", WAIT);
        await expect(askButton(section, "Checking…")).toBeFocused();
        answerAll(f);
        await expect(summary(section)).toContainText(FINAL, WAIT);
        // The button is the same button, still focused, saying what it does now.
        await expect(askButton(section, "Check again")).toBeFocused();
        // Tab walks the results in reading order: asking again, then rows.
        await page.keyboard.press("Tab");
        await expect(
          section.getByRole("button", { name: "Retry 2 unanswered" }),
        ).toBeFocused();
        const order = [];
        for (let step = 0; step < 14; step++) {
          await page.keyboard.press("Tab");
          order.push(
            await page.evaluate(
              () =>
                document.activeElement?.getAttribute("aria-label") ||
                document.activeElement?.textContent?.trim().slice(0, 40) ||
                "",
            ),
          );
          expect(await inside()).toBe(true);
        }
        // Rows go top to bottom, in name order: each device's controls before the next's.
        const at = (name) => order.findIndex((label) => label.includes(name));
        expect(at(NAMES.secret)).toBeGreaterThanOrEqual(0);
        expect(at(`Retry ${NAMES.late}`)).toBeGreaterThan(at(NAMES.secret));
        expect(at(`Retry ${NAMES.offline}`)).toBeGreaterThan(
          at(`Retry ${NAMES.late}`),
        );
        // Reduced motion: nothing spins.
        await askButton(section, "Check again").click();
        const spin = section.locator(".spin").first();
        await expect(spin).toBeVisible({ timeout: 9000 });
        expect(
          await spin.evaluate(
            (node) => getComputedStyle(node).animationDuration,
          ),
        ).toMatch(/^(0s|1e-05s)$/);
        expect(
          await dialog
            .getByRole("button", { name: "Deploy to devices" })
            .isEnabled(),
        ).toBe(true);
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "A restricted host nobody has asked about gets a condition, never the claim that it refuses",
    async () => {
      for (const [width, theme] of [
        [1280, "light"],
        [390, "dark"],
      ]) {
        const f = scene({
          devices: [restricted(0, "edge-restr-01")],
          versionReads: [],
        });
        f.initial = {};
        const app = await openReview(f, {
          version: withSink(COLLECTOR),
          width,
          theme,
        });
        const { page, dialog } = app;
        try {
          const note = dialog.locator(".target-approval-note");
          await expect(note.locator("strong")).toHaveText(
            "edge-restr-01 runs in restricted mode and needs its host to allow what this version uses",
          );
          await expect(note.locator("p").nth(0)).toHaveText(
            "It uses destination 127.0.0.1:8678. It refuses this version unless its host already allows these.",
          );
          await expect(note.locator("p").nth(1)).toHaveText(
            "Vectory can't see a host's allowances; Check on devices in the review shows whether it has them. Only the host operator can allow these; the dashboard can't.",
          );
          await expect(reviewedRows(dialog)).toContainText(
            "No pipeline assigned; refuses it unless its host allows destination 127.0.0.1:8678",
          );
          await expect(dialog).not.toContainText(
            /until its host approves|approves it|refused until/,
          );
          // The commands for the host are still handed over, made for that host.
          await note
            .getByText("Commands for the host", { exact: true })
            .click();
          await expect(
            dialog.getByLabel("Host approval commands, On edge-restr-01", {
              exact: true,
            }),
          ).toContainText("--state-dir '/srv/vectory state'");
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await scan(page, "restricted host not asked about", width, theme);
          await note.scrollIntoViewIfNeeded();
          const file = `approval-condition-${width}-${theme}.png`;
          await page.screenshot({ path: resolve(output, file) });
          screenshots.push(file);
          // No version runs there, so nothing was read to compare.
          expect(f.versionReads).toEqual([]);
          noErrors(f);
        } finally {
          await app.close();
        }
      }
    },
  );

  await check(
    "A host whose device already runs a version using the same destinations is not told anything; one that cannot be compared still gets the condition",
    async () => {
      const covering = withSink(COLLECTOR, { id: id(71), number: 1 });
      const elsewhere = withSink("http://127.0.0.1:9/elsewhere", {
        id: id(72),
        number: 2,
      });
      // The same address, but a version whose addresses differ by device.
      const perDevice = withSink(COLLECTOR, {
        id: id(73),
        number: 3,
        variables: [{ name: "target", path: "/sinks/out/uri", type: "string" }],
      });
      const f = scene({
        devices: [
          restricted(0, "edge-restr-01", { running_version: runs(covering) }),
          restricted(1, "edge-restr-02", { running_version: runs(elsewhere) }),
          restricted(2, "edge-restr-03", { running_version: runs(perDevice) }),
        ],
        versions: {
          [covering.id]: covering,
          [elsewhere.id]: elsewhere,
          [perDevice.id]: perDevice,
        },
        versionReads: [],
      });
      f.initial = {};
      const app = await openReview(f, {
        version: withSink(COLLECTOR, { id: id(60), number: 4 }),
      });
      const { page, dialog } = app;
      try {
        const note = dialog.locator(".target-approval-note");
        await expect(note.locator("strong")).toHaveText(
          "2 selected devices run in restricted mode and need their hosts to allow what this version uses",
        );
        await expect(note).toContainText(
          "edge-restr-01 already runs a version that uses these.",
        );
        const row = (name) =>
          reviewedRows(dialog).filter({ hasText: name }).first();
        await expect(row("edge-restr-01")).not.toContainText("refuses it");
        await expect(row("edge-restr-01")).toContainText(
          "No pipeline assigned",
        );
        for (const name of ["edge-restr-02", "edge-restr-03"])
          await expect(row(name)).toContainText(
            "refuses it unless its host allows destination 127.0.0.1:8678",
          );
        // Each running version is read once, however many devices run it.
        expect([...f.versionReads].sort()).toEqual(
          [covering.id, elsewhere.id, perDevice.id].sort(),
        );
        noErrors(f);
      } finally {
        await app.close();
      }
      // When every restricted device already runs it, the review says nothing.
      const quiet = scene({
        devices: [
          restricted(0, "edge-restr-01", { running_version: runs(covering) }),
        ],
        versions: { [covering.id]: covering },
        versionReads: [],
      });
      quiet.initial = {};
      const second = await openReview(quiet, {
        version: withSink(COLLECTOR, { id: id(60), number: 4 }),
      });
      try {
        await expect(second.dialog.locator(".target-outcome")).toHaveCount(1);
        await expect(second.dialog.locator(".target-outcome")).toContainText(
          "No pipeline assigned",
        );
        await expect(
          second.dialog.locator(".target-outcome"),
        ).not.toContainText("refuses it");
        await expect(
          second.dialog.locator(".target-approval-note"),
        ).toHaveCount(0);
        await shot(
          second.page,
          second.check,
          "approval-already-runs-1280-light",
        );
        noErrors(quiet);
      } finally {
        await second.close();
      }
    },
  );

  await check(
    "Once Check on devices passes on a restricted host the review says that instead, and asks again after the selection changes",
    async () => {
      const f = scene({
        devices: [restricted(0, NAMES.pass), restricted(1, NAMES.fix)],
        versionReads: [],
      });
      f.initial = {};
      const app = await openReview(f, { version: withSink(COLLECTOR) });
      const { page, dialog, check: section } = app;
      try {
        const note = dialog.locator(".target-approval-note");
        const headline = note.locator("strong");
        const condition = "refuses it unless its host allows destination";
        await expect(headline).toHaveText(
          "2 selected devices run in restricted mode and need their hosts to allow what this version uses",
        );
        await askButton(section).click();
        await expect(summary(section)).toContainText("2 still checking", WAIT);
        // Asking is not an answer: nothing changes until a host passes.
        await expect(reviewedRows(dialog)).toHaveCount(2);
        for (const row of await reviewedRows(dialog).all())
          await expect(row).toContainText(condition);
        answer(f, NAMES.pass, answers.pass);
        answer(f, NAMES.fix, answers.fix);
        await expect(summary(section)).toContainText(
          "Checked 2 of 2 devices: 1 passes, 1 needs a fix.",
          WAIT,
        );
        // The one that passed leaves the condition and is named after it.
        await expect(headline).toHaveText(
          `${NAMES.fix} runs in restricted mode and needs its host to allow what this version uses`,
        );
        await expect(note).toContainText(
          `Check on devices passed on ${NAMES.pass}.`,
        );
        await expect(
          reviewedRows(dialog).filter({ hasText: NAMES.pass }).first(),
        ).not.toContainText(condition);
        await expect(
          reviewedRows(dialog).filter({ hasText: NAMES.fix }).first(),
        ).toContainText(condition);
        // Fixed on the host and checked again: nothing is left to say but that.
        await section
          .getByRole("button", { name: `Check ${NAMES.fix} again` })
          .click();
        await expect(summary(section)).toContainText("1 still checking", WAIT);
        answer(f, NAMES.fix, answers.pass);
        await expect(summary(section)).toContainText(
          "Checked 2 of 2 devices: 2 pass.",
          WAIT,
        );
        await expect(headline).toHaveText(
          `Check on devices passed on ${NAMES.pass} and ${NAMES.fix}`,
        );
        await expect(note).toContainText(
          "They run in restricted mode, and their hosts accepted this version.",
        );
        await expect(dialog).not.toContainText(condition);
        await expect(dialog).not.toContainText(/approves it|refused until/);
        await expect(
          note.getByText("Commands for the host", { exact: true }),
        ).toHaveCount(0);
        await shot(page, note, "approval-check-passed-1280-light");
        // A check belongs to the review it was asked on: going back clears it,
        // and the condition returns until a host passes again.
        await dialog.getByRole("button", { name: "Back to selection" }).click();
        await dialog
          .getByRole("button", { name: "Review deployment", exact: true })
          .click();
        await expect(section).toBeVisible();
        await expect(headline).toHaveText(
          "2 selected devices run in restricted mode and need their hosts to allow what this version uses",
        );
        noErrors(f);
      } finally {
        await app.close();
      }
    },
  );
} finally {
  await browser.close();
  await server.close();
  const report = {
    recorded_at: new Date().toISOString(),
    scope:
      "The real deploy review and its Check on devices section, with intercepted synthetic HTTP. The synthetic server answers when the harness says so: no host validated anything.",
    passed:
      results.length === 18 &&
      results.every((r) => r.passed) &&
      accessibility.every((s) => !s.violations.length),
    results,
    accessibility,
    screenshots,
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (!report.passed) process.exitCode = 1;
}
