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

const root = path.resolve(import.meta.dirname, "..");
const preview =
  process.env.VECTORY_PREVIEW_DIR || path.join(root, ".local", "preview");
const web = `http://127.0.0.1:${process.env.VECTORY_PREVIEW_WEB_PORT || 8080}`;
const out = path.resolve(
  root,
  process.env.VECTORY_SCREENSHOTS_DIR || path.join("docs", "screenshots"),
);
const viewport = { width: 1440, height: 900 };
const settleTimeout = 20_000;

const say = (message) => console.log(`\x1b[2m›\x1b[0m ${message}`);
const done = (message) => console.log(`\x1b[32m✓\x1b[0m ${message}`);
const warn = (message) => console.warn(`\x1b[33m!\x1b[0m ${message}`);
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

// Pick the demo's own records by name, so every run shows the same things.
async function subjects(get) {
  const [pipelines, devices, deployments] = await Promise.all([
    get("/configurations"),
    get("/devices"),
    get("/deployments"),
  ]);
  const demo = pipelines.filter((p) => p.name.endsWith("(synthetic demo)"));
  const pipeline =
    demo.find((p) => p.name.startsWith("Edge syslog processing")) ?? demo[0];
  if (!pipeline)
    fail(
      "No synthetic demo pipeline found. Start the demo: node scripts/demo.mjs",
    );
  const device =
    devices.find((d) => d.name === "edge-nyc-01") ??
    devices.find((d) => d.status !== "revoked");
  if (!device)
    fail("No demo devices found. Start the demo: node scripts/demo.mjs");
  const versions = new Set(
    (await get(`/configurations/${pipeline.id}/versions`)).map((v) => v.id),
  );
  const rollout = deployments
    .filter((d) => versions.has(d.version_id))
    .sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    )[0];
  if (!rollout) fail(`No deployment of “${pipeline.name}” found.`);
  const unsettled = devices.filter(
    (d) => d.status !== "revoked" && d.apply_state !== "verified_applied",
  );
  if (unsettled.length)
    warn(
      `Not every device runs a verified pipeline yet (${unsettled.map((d) => `${d.name}: ${d.apply_state}`).join(", ")}). Wait a minute for a representative capture.`,
    );
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
    { name: "overview", path: "/#/overview" },
    { name: "devices", path: "/#/devices" },
    { name: "device", path: `/#/devices/${device.id}` },
    { name: "rollout", path: `/#/deployments/${rollout.id}` },
    { name: "add-device", path: "/#/enrollment", noNewTokens: true },
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
      warn("A loading indicator was still visible; captured anyway."),
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

async function capture(browser, screen, theme, { get, session }) {
  const context = await browser.newContext({
    viewport,
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
    const file = path.join(
      out,
      `product-${screen.name}${theme === "dark" ? "-dark" : ""}.png`,
    );
    await page.screenshot({
      path: file,
      animations: "disabled",
      caret: "hide",
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

main().catch((error) => {
  console.error(
    `\x1b[31m✗\x1b[0m ${error instanceof Stop ? error.message : error.stack}`,
  );
  process.exitCode = 1;
});
