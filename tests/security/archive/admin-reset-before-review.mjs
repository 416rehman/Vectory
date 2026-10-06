// Actual production App with intercepted synthetic HTTP. No real accounts or reset codes.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname, relative, extname } from "node:path";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "dashboard/package.json"));
const { chromium, expect } = require("@playwright/test");
const output = resolve(root, ".local/password-reset-before");
const build = resolve(root, ".local/password-reset-before-build");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceFiles = [
  "dashboard/src/AccountAccess.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/UsersSecurity.tsx",
  "dashboard/src/ui.tsx",
  "dashboard/src/AccountPasswordFields.tsx",
  "dashboard/src/authRequests.ts",
  "dashboard/src/accountActionSession.ts",
];
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    files.push(...(entry.isDirectory() ? await walk(path) : [path]));
  }
  return files;
}
const sourceHashes = Object.fromEntries(
  await Promise.all(sourceFiles.map(async (path) => [path, hash(await readFile(resolve(output, "source", path)))])),
);
const builtHashes = Object.fromEntries(
  await Promise.all((await walk(build)).map(async (path) => [relative(build, path).replaceAll("\\", "/"), hash(await readFile(path))])),
);
const report = {
  recorded_at: new Date().toISOString(),
  passed: false,
  classification: "isolated_actual_app_expected_before_observation",
  scope: "Private production App and intercepted synthetic HTTP only. Modeled commits do not prove native password-reset issuance or server authorization.",
  build_directory: relative(root, build),
  source_sha256: sourceHashes,
  built_files_sha256: builtHashes,
  harness_sha256: hash(await readFile(fileURLToPath(import.meta.url))),
  groups: [],
  observations: [],
  requests: [],
  unexpected: [],
  page_errors: [],
};
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const target = resolve(build, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!target.startsWith(build + "\\") && !target.startsWith(build + "/")) throw Error("outside fixture");
    response.setHeader("Content-Type", mime[extname(target)] || "application/octet-stream");
    response.end(await readFile(target));
  } catch {
    response.statusCode = 404;
    response.end("Synthetic missing asset");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const actor = { id: "12be74f8-38ae-44f4-99d8-e7d5c35b09a1", name: "Synthetic administrator", email: "admin@fixture.example.test", role: "admin", enabled: true, revision: 1 };
const target = { id: "661d08ec-ae29-4903-91da-f3ad3e5b3d95", name: "Synthetic recipient", email: "recipient@fixture.example.test", role: "viewer", enabled: true, revision: 1 };
const resetPath = `/users/${target.id}/password-reset`;
async function fixture({ hold = false, bodyHold = false, drop = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 899, height: 900 } });
  await context.addInitScript((bodyHold) => {
    window.resetFixture = { bodyStarted: false, bodyRelease: null };
    if (!bodyHold) return;
    const native = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const path = new URL(typeof args[0] === "string" ? args[0] : args[0].url, location.href).pathname;
      const response = await native(...args);
      if (path.endsWith("/password-reset")) {
        const original = response.text.bind(response);
        response.text = async () => {
          window.resetFixture.bodyStarted = true;
          await new Promise((done) => (window.resetFixture.bodyRelease = done));
          return original();
        };
      }
      return response;
    };
  }, bodyHold);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.clock.install();
  const state = { actor: { ...actor }, posts: 0, held: [], drop, sessionReads: 0 };
  page.on("pageerror", (error) => report.page_errors.push(error.message));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { report.unexpected.push({ origin: url.origin }); return route.abort(); }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7);
    const method = request.method();
    report.requests.push({ method, path });
    if (method === "GET") {
      if (path === "/status") return route.fulfill({ json: { initialized: true, version: "synthetic" } });
      if (path === "/session") { state.sessionReads++; return route.fulfill({ json: { user: state.actor, csrf_token: "synthetic-csrf" } }); }
      if (path === "/users") return route.fulfill({ json: [state.actor, target] });
      if (path === "/mfa") return route.fulfill({ json: { enabled: false } });
      if (path === "/settings") return route.fulfill({ json: { instance_name: "Synthetic fixture" } });
    }
    if (method === "POST" && path === resetPath) {
      state.posts++;
      if (hold) await new Promise((done) => state.held.push(done));
      if (state.drop) return route.abort("failed");
      return route.fulfill({ json: { code: `synthetic-code-${state.posts}`, expires_at: new Date(Date.now() + 900000).toISOString() } });
    }
    report.unexpected.push({ method, path });
    return route.fulfill({ status: 500, json: { error: { code: "UNEXPECTED", message: "Unexpected fixture request" } } });
  });
  await page.goto(`${origin}/#/users`);
  await expect(page.getByRole("heading", { name: "People & security", exact: true })).toBeVisible();
  const close = async () => {
    for (const done of state.held.splice(0)) done();
    await page.evaluate(() => window.resetFixture?.bodyRelease?.()).catch(() => {});
    await context.close();
  };
  return { page, state, close };
}
async function prepare(f) {
  await f.page.getByRole("button", { name: `Reset password for ${target.name}` }).click();
  const dialog = f.page.getByRole("dialog", { name: "Create a password reset code" });
  await dialog.getByLabel("Your current password").fill("synthetic-not-a-real-password");
  return dialog;
}
async function group(name, fn) {
  await fn();
  report.groups.push({ name, passed: true });
  console.log("PASS " + name);
}
let failure;
try {
  await group("1. Held reset headers exceed 30 seconds and block dismissal", async () => {
    const f = await fixture({ hold: true });
    try {
      const dialog = await prepare(f);
      await dialog.getByRole("button", { name: "Create reset code" }).click();
      await expect.poll(() => f.state.posts).toBe(1);
      await f.page.clock.fastForward(31000);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
      await f.page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      report.observations.push({ case: "held response headers", elapsed_browser_ms: 31000, outcome: "Busy form and dismissal remained blocked; no request deadline.", qualification: "Accelerated browser clock, not real wall time." });
    } finally { await f.close(); }
  });
  await group("2. Held reset body exceeds 30 seconds and retains administrator password", async () => {
    const f = await fixture({ bodyHold: true });
    try {
      const dialog = await prepare(f);
      await dialog.getByRole("button", { name: "Create reset code" }).click();
      await expect.poll(() => f.page.evaluate(() => window.resetFixture.bodyStarted)).toBe(true);
      await f.page.clock.fastForward(31000);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
      await expect(dialog.getByLabel("Your current password")).not.toHaveValue("");
      report.observations.push({ case: "held response body", elapsed_browser_ms: 31000, outcome: "Disabled current-password field retained the submitted secret during the stalled response.", qualification: "No password value or request body is stored in this report." });
    } finally { await f.close(); }
  });
  await group("3. Same-tick reset submissions dispatch two POSTs", async () => {
    const f = await fixture({ hold: true });
    try {
      const dialog = await prepare(f);
      await dialog.locator("form").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
      await expect.poll(() => f.state.posts).toBe(2);
      report.observations.push({ case: "same-tick submit", outcome: "Two POSTs reached intercepted synthetic transport before the busy state rendered; server commit is not inferred." });
    } finally { await f.close(); }
  });
  await group("4. Lost committed reset response invites another unkeyed POST", async () => {
    const f = await fixture({ drop: true });
    try {
      const dialog = await prepare(f);
      await dialog.getByRole("button", { name: "Create reset code" }).click();
      await expect.poll(() => f.state.posts).toBe(1);
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Create reset code" })).toBeEnabled();
      await dialog.getByRole("button", { name: "Create reset code" }).click();
      await expect.poll(() => f.state.posts).toBe(2);
      report.observations.push({ case: "modeled issuance with unread reply", outcome: "The UI offered a second unkeyed issuance, which would replace the first code if both commits succeeded. This fixture does not establish native commit." });
    } finally { await f.close(); }
  });
  expect(report.unexpected).toEqual([]);
  expect(report.page_errors).toEqual([]);
  expect(Object.fromEntries(await Promise.all((await walk(build)).map(async (path) => [relative(build, path).replaceAll("\\", "/"), hash(await readFile(path))])))).toEqual(report.built_files_sha256);
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = String(error.stack || error);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  report.counts = { groups: report.groups.length, intercepted_requests: report.requests.length };
  await writeFile(resolve(root, "docs/evidence/admin-reset-before.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ passed: report.passed, counts: report.counts, output: "docs/evidence/admin-reset-before.json" }));
if (failure) throw failure;
