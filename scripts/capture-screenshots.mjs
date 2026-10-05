#!/usr/bin/env node
// Capture the product screenshots in docs/screenshots/ from a running local
// preview with the demo fleet. It signs in as the demo administrator through
// the API, changes nothing but its own session, and signs out when it's done.
// See "Capture product screenshots" in docs/dev/DEVELOPMENT.md.
//
//   node scripts/demo.mjs --agents 4               first: a preview and a demo fleet
//   node scripts/capture-screenshots.mjs           then: every screen
//   node scripts/capture-screenshots.mjs overview  or only the screens you name
//
// It reads the preview's VECTORY_PREVIEW_DIR and VECTORY_PREVIEW_WEB_PORT.
// VECTORY_SCREENSHOTS_DIR changes the output folder (default docs/screenshots),
// and VECTORY_CHROMIUM names a Chromium executable when Playwright's own
// browser isn't installed.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const preview =
  process.env.VECTORY_PREVIEW_DIR || path.join(root, ".local", "preview");
const demoRoot =
  process.env.VECTORY_DEMO_DIR || path.join(root, ".local", "demo");
const web = `http://127.0.0.1:${process.env.VECTORY_PREVIEW_WEB_PORT || 8080}`;
const out = path.resolve(
  root,
  process.env.VECTORY_SCREENSHOTS_DIR || path.join("docs", "screenshots"),
);
const viewport = { width: 1440, height: 900 };
const settleTimeout = 20_000;
const telemetryTimeout = 240_000;
const demoNames = new Set([
  "edge-nyc-01",
  "edge-nyc-02",
  "edge-fra-01",
  "web-ams-01",
  "web-ams-02",
  "edge-sfo-01",
  "edge-sfo-02",
  "web-sin-01",
  "edge-syd-01",
  "web-lon-01",
  "edge-tor-01",
  "web-sao-01",
]);
const demoPipelines = new Set([
  "Edge syslog processing (synthetic demo)",
  "Web access logs (synthetic demo)",
]);
const demoGroups = new Set(["Edge collectors", "Web tier"]);

const say = (message) => console.log(`\x1b[2m›\x1b[0m ${message}`);
const done = (message) => console.log(`\x1b[32m✓\x1b[0m ${message}`);
class Stop extends Error {}
const fail = (message) => {
  throw new Stop(message);
};

async function signIn() {
  const credentialsPath = path.join(preview, "credentials.json");
  const credentials = await fs
    .readFile(credentialsPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (!credentials)
    fail(
      `No demo administrator in ${path.relative(root, credentialsPath)}. Start the demo first: node scripts/demo.mjs`,
    );
  const status = await fetch(`${web}/api/v1/status`).catch(() => null);
  if (!status?.ok)
    fail(`No preview answers at ${web}. Start it with node scripts/demo.mjs.`);
  const instance = await status.json();
  if (instance.instance_name !== "Vectory demo")
    fail(
      "This server is not the synthetic demo instance. No screenshots were saved.",
    );
  const login = await fetch(`${web}/api/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  });
  if (!login.ok) fail(`Sign-in failed (HTTP ${login.status}).`);
  const body = await login.json();
  if (body.mfa_required)
    fail(
      "The demo administrator uses two-factor sign-in. Capture from a fresh demo.",
    );
  const cookie = login.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .find((pair) => pair.startsWith("vectory_session="));
  if (!cookie) fail("Sign-in returned no session cookie.");
  const headers = { Cookie: cookie };
  const get = async (endpoint) => {
    const response = await fetch(`${web}/api/v1${endpoint}`, { headers });
    if (!response.ok) fail(`GET ${endpoint}: HTTP ${response.status}`);
    return response.json();
  };
  const signOut = () =>
    fetch(`${web}/api/v1/logout`, {
      method: "POST",
      headers: { ...headers, "X-CSRF-Token": body.csrf_token },
    }).catch(() => {});
  return { get, signOut, session: cookie.slice(cookie.indexOf("=") + 1) };
}

/** Reject a mixed preview before a global view can expose unrelated records. */
export function demoRecordProblem({
  pipelines,
  devices,
  deployments,
  groups,
  users,
  tokens,
  versions,
}) {
  if (
    ![pipelines, devices, deployments, groups, users, tokens, versions].every(
      Array.isArray,
    )
  )
    return "The demo inventory could not be verified.";
  if (
    !pipelines.length ||
    pipelines.some((item) => !demoPipelines.has(item.name))
  )
    return "The pipeline list contains records outside the synthetic demo.";
  if (
    !devices.length ||
    devices.some(
      (item) => !demoNames.has(item.name) || item.status === "revoked",
    ) ||
    new Set(devices.map((item) => item.name)).size !== devices.length
  )
    return "The device list contains records outside the synthetic demo.";
  if (
    users.length !== 1 ||
    users[0].email !== "operator@vectory.local" ||
    users[0].name !== "Demo operator"
  )
    return "The account list is not the fresh synthetic demo administrator.";
  const deviceIds = new Set(devices.map((item) => item.id));
  if (
    groups.some(
      (item) =>
        !demoGroups.has(item.name) ||
        !Array.isArray(item.device_ids) ||
        item.device_ids.some((id) => !deviceIds.has(id)),
    )
  )
    return "The group list contains records outside the synthetic demo.";
  if (
    tokens.length !== 1 ||
    tokens.some(
      (item) =>
        typeof item.name !== "string" ||
        !/^Demo fleet \d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(item.name),
    )
  )
    return "A fresh synthetic demo must have exactly one enrollment token.";
  if (versions.some((items) => !Array.isArray(items)))
    return "The demo versions could not be verified.";
  const versionIds = new Set(
    versions.flatMap((items) => items.map((item) => item.id)),
  );
  if (
    !deployments.length ||
    deployments.some(
      (item) =>
        !Array.isArray(item.targets) ||
        item.targets.some((target) => !deviceIds.has(target.device_id)) ||
        (item.version_id
          ? !versionIds.has(item.version_id)
          : item.policy?.heartbeat_seconds !== 15),
    )
  )
    return "The deployment list contains records outside the synthetic demo.";
  return null;
}

async function assertLocalDemoDevices(devices) {
  for (const device of devices) {
    // A familiar name is insufficient: match the enrolled local demo agent.
    const identity = await fs
      .readFile(
        path.join(demoRoot, "agents", device.name, "state", "identity.json"),
        "utf8",
      )
      .then(JSON.parse)
      .catch(() => null);
    if (identity?.credentials?.device_id !== device.id)
      fail(
        `Device ${device.name} does not match its local demo agent. No screenshots were saved.`,
      );
  }
}

// Pick the demo's own records only after proving the instance is isolated.
async function subjects(get) {
  const [pipelines, initialDevices, deployments, groups, users, tokens] =
    await Promise.all([
      get("/configurations"),
      get("/devices"),
      get("/deployments"),
      get("/groups"),
      get("/users"),
      get("/tokens"),
    ]);
  const allVersions = await Promise.all(
    pipelines.map((item) => get(`/configurations/${item.id}/versions`)),
  );
  const problem = demoRecordProblem({
    pipelines,
    devices: initialDevices,
    deployments,
    groups,
    users,
    tokens,
    versions: allVersions,
  });
  if (problem)
    fail(`${problem} Start from a fresh demo; no screenshots were saved.`);
  await assertLocalDemoDevices(initialDevices);
  const pipeline = pipelines.find(
    (item) => item.name === "Edge syslog processing (synthetic demo)",
  );
  if (!pipeline)
    fail("The edge demo pipeline is missing. No screenshots were saved.");
  const versions = new Set(
    allVersions[pipelines.indexOf(pipeline)].map((version) => version.id),
  );
  let rollout = deployments
    .filter((d) => versions.has(d.version_id))
    .sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    )[0];
  if (!rollout) fail(`No deployment of “${pipeline.name}” found.`);
  let devices = initialDevices;
  const unsettled = () =>
    devices.filter(
      (d) => d.status !== "revoked" && d.apply_state !== "verified_applied",
    );
  const deadline = Date.now() + 120_000;
  while (
    (unsettled().length || rollout.status !== "completed") &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const [currentDevices, currentRollout] = await Promise.all([
      get("/devices"),
      get(`/deployments/${rollout.id}`),
    ]);
    devices = currentDevices;
    rollout = currentRollout;
  }
  if (unsettled().length)
    fail(
      `Demo devices have not verified application (${unsettled()
        .map((d) => `${d.name}: ${d.apply_state}`)
        .join(", ")}). No screenshots were saved.`,
    );
  if (rollout.status !== "completed")
    fail(
      `The demo rollout is ${rollout.status}, not completed. No screenshots were saved.`,
    );
  const device = devices.find((d) => d.name === "edge-nyc-01");
  if (!device)
    fail("Demo devices are no longer available. No screenshots were saved.");
  return { pipeline, device, rollout };
}

function screens({ pipeline, device, rollout }) {
  return [
    {
      name: "editor",
      path: `/#/configurations/${pipeline.id}`,
      themes: ["light", "dark"],
      ready: ".react-flow__node",
    },
    { name: "overview", path: "/#/overview", fullPage: true },
    { name: "devices", path: "/#/devices" },
    { name: "device", path: `/#/devices/${device.id}`, height: 1400 },
    { name: "rollout", path: `/#/deployments/${rollout.id}` },
    { name: "add-device", path: "/#/enrollment", height: 960, noNewTokens: true },
    { name: "help", path: "/help/" },
  ];
}

// Wait until the page stops loading: no pending requests, no spinners or busy
// regions, fonts ready, nothing focused, then two quiet animation frames.
async function settle(page, ready) {
  await page.waitForLoadState("networkidle", { timeout: settleTimeout });
  if (ready)
    await page
      .locator(ready)
      .first()
      .waitFor({ state: "visible", timeout: settleTimeout });
  await page
    .waitForFunction(
      () =>
        !document.querySelector(
          '.loading, [aria-busy="true"], [role="progressbar"]',
        ),
      null,
      { timeout: settleTimeout },
    )
    .catch(() =>
      fail("A loading indicator remained visible. No screenshot was saved."),
    );
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await page.waitForLoadState("networkidle", { timeout: settleTimeout });
}

// The editor starts its automatic Vector check after a short pause. Network
// idle can finish before that timer fires, leaving a "Not checked" hero image.
// A native Vector result is part of the screenshot's claim about the demo
// pipeline. "No problems" alone can also mean structural checks only.
async function waitForEditorCheck(page) {
  try {
    await page.waitForFunction(
      () => {
        const panel = document.querySelector(".problems-panel");
        const summary = panel?.querySelector(".problems-toggle strong");
        const check = document.querySelector(".editor-check-button");
        const feedbackId = check?.getAttribute("aria-describedby");
        const verdict = feedbackId
          ? document.getElementById(feedbackId)?.textContent?.trim()
          : null;
        return (
          panel?.getAttribute("data-state") === "clean" &&
          summary?.textContent?.trim() === "No problems" &&
          ["passed", "device"].includes(
            check?.getAttribute("data-check-state"),
          ) &&
          verdict?.startsWith("Vector 0.58 accepted this pipeline.")
        );
      },
      null,
      { timeout: 60_000 },
    );
  } catch {
    const summary =
      (
        await page
          .locator(".problems-panel .problems-toggle strong")
          .textContent()
          .catch(() => null)
      )?.trim() || "no check result";
    const state =
      (await page
        .locator(".editor-check-button")
        .getAttribute("data-check-state")
        .catch(() => null)) || "no Vector result";
    fail(
      `The demo pipeline did not finish a clean Vector check (status: ${summary}; Vector: ${state}). No editor screenshot was saved.`,
    );
  }
  await settle(page);
}

// The first successful metrics scrape has no previous counter sample, so the
// editor can report a live device while every graph rate still says "no data".
// The synthetic pipeline has two sources and several connected steps. One
// inactive route output may legitimately lack a counter; the rest must show
// real rates, including at least one nonzero flow.
export function editorTelemetryReady(root) {
  const doc = root || document;
  const live = doc.querySelector('.editor-live-toggle[aria-pressed="true"]');
  const status = doc.querySelector(".editor-live-status");
  const nodes = [...doc.querySelectorAll(".pipeline-node-live")];
  const edges = [...doc.querySelectorAll(".pipeline-edge-rate")];
  const positive = (text) => {
    const value = (text || "").trim();
    return (
      value.startsWith("<0.1") ||
      Number.parseFloat(value.replaceAll(",", "")) > 0
    );
  };
  const nodeRates = nodes.map((node) =>
    [...node.querySelectorAll(".pipeline-node-live-stat b")].map(
      (rate) => rate.textContent,
    ),
  );
  const knownNodes = nodes.filter(
    (node, index) =>
      !node.hasAttribute("data-empty") &&
      nodeRates[index].some((rate) => /^(\d|<0\.1)/.test(rate?.trim() || "")),
  ).length;
  const knownEdges = edges.filter((edge) => !edge.hasAttribute("data-empty"));
  return Boolean(
    live &&
    ["live", "partial"].includes(status?.getAttribute("data-tone")) &&
    nodes.length >= 6 &&
    knownNodes >= nodes.length - 1 &&
    edges.length >= 4 &&
    knownEdges.length >= edges.length - 1 &&
    knownEdges.some((edge) => positive(edge.textContent)),
  );
}

// Running rates alone do not guarantee a useful Overview screenshot. The
// fleet chart needs two completed, populated time buckets as well.
export function overviewTelemetryReady(root) {
  const doc = root || document;
  const rows = [...doc.querySelectorAll(".running-now .overview-running-item")];
  const throughput = doc.querySelector(
    ".throughput .overview-throughput-stats > div:first-child dd",
  );
  const chart = doc.querySelector(".throughput .fleet-chart-frame");
  return Boolean(
    rows.length >= 2 &&
    rows.every((row) => {
      const rate = row.querySelector(".overview-running-rate");
      return rate && !rate.hasAttribute("data-missing");
    }) &&
    throughput &&
    !throughput.hasAttribute("data-missing") &&
    Number.parseFloat(throughput.textContent?.replaceAll(",", "")) > 0 &&
    chart &&
    chart.getClientRects().length > 0,
  );
}

async function waitForEditorTelemetry(page) {
  try {
    await page.waitForFunction(editorTelemetryReady, null, {
      timeout: telemetryTimeout,
      polling: 1_000,
    });
  } catch {
    const state = await page.evaluate(() => ({
      status: document
        .querySelector(".editor-live-status")
        ?.textContent?.trim(),
      nodes: document.querySelectorAll(".pipeline-node-live").length,
      emptyNodes: document.querySelectorAll(".pipeline-node-live[data-empty]")
        .length,
      edges: document.querySelectorAll(".pipeline-edge-rate").length,
      emptyEdges: document.querySelectorAll(".pipeline-edge-rate[data-empty]")
        .length,
    }));
    fail(
      `The demo editor had no complete live graph after 4 minutes (status: ${state.status || "none"}; nodes: ${state.nodes}, empty: ${state.emptyNodes}; connections: ${state.edges}, empty: ${state.emptyEdges}). No editor screenshot was saved.`,
    );
  }
}

async function waitForOverviewTelemetry(page) {
  try {
    await page.waitForFunction(overviewTelemetryReady, null, {
      timeout: telemetryTimeout,
      polling: 1_000,
    });
  } catch {
    const state = await page.evaluate(() => ({
      rows: document.querySelectorAll(".running-now .overview-running-item")
        .length,
      missingRows: document.querySelectorAll(
        ".running-now .overview-running-rate[data-missing]",
      ).length,
      throughput: document
        .querySelector(
          ".throughput .overview-throughput-stats > div:first-child dd",
        )
        ?.textContent?.trim(),
      chart: !!document.querySelector(".throughput .fleet-chart-frame"),
    }));
    fail(
      `The demo Overview had no complete live telemetry after 4 minutes (running versions: ${state.rows}, missing rates: ${state.missingRows}; fleet input: ${state.throughput || "none"}; completed chart: ${state.chart ? "yes" : "no"}). No Overview screenshot was saved.`,
    );
  }
}

async function waitForDemoDeviceRates(page) {
  try {
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll(".devices-page tbody tr")];
        return rows.length > 0 && rows.every((row) => row.querySelector(".device-flow"));
      },
      null,
      { timeout: 120_000 },
    );
  } catch {
    fail(
      "The demo Devices page did not show fresh per-device rates. No Devices screenshot was saved.",
    );
  }
  await settle(page);
}

async function capture(browser, screen, theme, { get, session }) {
  const context = await browser.newContext({
    viewport: { ...viewport, height: screen.height ?? viewport.height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  try {
    await context.addCookies([
      { name: "vectory_session", value: session, url: web },
    ]);
    await context.addInitScript((choice) => {
      try {
        localStorage.setItem("vectory-theme", choice);
        localStorage.setItem("starlight-theme", choice);
        localStorage.removeItem("vectory-sidebar-collapsed");
      } catch {
        /* The color scheme still applies without storage. */
      }
    }, theme);
    const page = await context.newPage();
    if (!(await page.request.get(`${web}/api/v1/session`)).ok())
      fail("The browser's session was refused; nothing was captured.");
    const tokens = screen.noNewTokens ? (await get("/tokens")).length : 0;
    await page.goto(web + screen.path);
    await settle(page, screen.ready);
    if (screen.name === "editor") {
      await waitForEditorCheck(page);
      await waitForEditorTelemetry(page);
    }
    if (screen.name === "overview") await waitForOverviewTelemetry(page);
    if (screen.name === "devices") await waitForDemoDeviceRates(page);
    if (screen.name === "add-device") {
      await page.locator('input[name="enroll-os"][value="linux"]').check();
      await page.locator('input[name="enroll-mode"][value="restricted"]').check();
      await settle(page);
      if (!(await page.getByRole("button", { name: "Create install command" }).isEnabled()))
        fail("The demo Add device page is not ready to create an install command. No image was saved.");
    }
    const file = path.join(
      out,
      `product-${screen.name}${theme === "dark" ? "-dark" : ""}.png`,
    );
    await page.screenshot({
      path: file,
      animations: "disabled",
      caret: "hide",
      fullPage: screen.fullPage ?? false,
    });
    // A screen that issues an enrollment token could show its secret.
    if (screen.noNewTokens && (await get("/tokens")).length !== tokens) {
      await fs.rm(file, { force: true });
      fail(
        `Opening ${screen.path} issued an enrollment token, so the image could show a secret. Nothing was saved for it; revoke that token.`,
      );
    }
    done(file.startsWith(root + path.sep) ? path.relative(root, file) : file);
  } finally {
    await context.close();
  }
}

async function main() {
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  let chromium;
  try {
    // Playwright comes with the dashboard's development dependencies.
    ({ chromium } = createRequire(path.join(root, "dashboard", "package.json"))(
      "playwright",
    ));
  } catch {
    fail(
      "Install the dashboard's dependencies first: (cd dashboard && npm ci)",
    );
  }
  const account = await signIn();
  try {
    const list = screens(await subjects(account.get)).filter(
      (screen) => !only.length || only.includes(screen.name),
    );
    const unknown = only.filter((name) => !list.some((s) => s.name === name));
    if (unknown.length) fail(`Unknown screen: ${unknown.join(", ")}`);
    await fs.mkdir(out, { recursive: true });
    const browser = await chromium.launch(
      process.env.VECTORY_CHROMIUM
        ? { executablePath: process.env.VECTORY_CHROMIUM }
        : {},
    );
    try {
      for (const screen of list)
        for (const theme of screen.themes ?? ["light"])
          await capture(browser, screen, theme, account);
    } finally {
      await browser.close();
    }
  } finally {
    await account.signOut();
  }
  say(
    "Review the images before you commit them. Stop the demo with: node scripts/demo.mjs --stop",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      `\x1b[31m✗\x1b[0m ${error instanceof Stop ? error.message : error.stack}`,
    );
    process.exitCode = 1;
  });
