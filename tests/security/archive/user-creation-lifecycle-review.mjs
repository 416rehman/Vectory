// Independent actual-App observation. Every account and API response is synthetic.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname, relative, extname } from "node:path";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "dashboard/package.json"));
const { chromium, expect } = require("@playwright/test");
const output = resolve(root, ".local/user-creation-lifecycle-before");
const build = resolve(root, ".local/mfa-lifecycle-build");
await mkdir(output, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/UsersSecurity.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/src/styles.css",
  "dashboard/src/control.css",
  "tests/security/user-creation-lifecycle-review.mjs",
];
const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [path, hash(await readFile(resolve(root, path)))]),
    ),
  );
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    files.push(...(entry.isDirectory() ? await walk(path) : [path]));
  }
  return files;
}
const builtHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      (await walk(build)).map(async (path) => [
        relative(build, path).replaceAll("\\", "/"),
        hash(await readFile(path)),
      ]),
    ),
  );
const sourceStart = await sourceHashes();
const report = {
  recorded_at: new Date().toISOString(),
  passed: false,
  classification: "isolated_actual_app_expected_before_observation",
  scope:
    "Private production App with intercepted synthetic accounts and HTTP only. Modeled commits do not prove native user creation or bypass server authorization.",
  build_directory: relative(root, build),
  source_sha256: sourceStart,
  built_files_sha256: await builtHashes(),
  groups: [],
  observations: [],
  requests: [],
  unexpected: [],
  page_errors: [],
};
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const target = resolve(build, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!target.startsWith(build + "\\") && !target.startsWith(build + "/"))
      throw Error("outside fixture");
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
const actor = {
  id: "12be74f8-38ae-44f4-99d8-e7d5c35b09a1",
  name: "Synthetic administrator",
  email: "admin@fixture.example.test",
  role: "admin",
  enabled: true,
  revision: 1,
};
const created = {
  id: "b3ed4c8c-1761-4897-a8dd-49735e9d2f88",
  name: "Synthetic new person",
  email: "new@fixture.example.test",
  role: "viewer",
  enabled: true,
  revision: 1,
};

async function fixture({ hold = false, bodyHold = false, drop = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 899, height: 900 } });
  await context.addInitScript((bodyHold) => {
    window.userCreationFixture = { bodyStarted: false, bodyRelease: null };
    if (!bodyHold) return;
    const native = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const path = new URL(
        typeof args[0] === "string" ? args[0] : args[0].url,
        location.href,
      ).pathname;
      const response = await native(...args);
      if (path === "/api/v1/users") {
        const original = response.text.bind(response);
        response.text = async () => {
          window.userCreationFixture.bodyStarted = true;
          await new Promise((done) => (window.userCreationFixture.bodyRelease = done));
          return original();
        };
      }
      return response;
    };
  }, bodyHold);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.clock.install();
  const state = {
    actor: { ...actor },
    people: [{ ...actor }],
    posts: 0,
    held: [],
    sessionReads: 0,
    drop,
  };
  page.on("pageerror", (error) => report.page_errors.push(error.message));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      report.unexpected.push({ origin: url.origin });
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7);
    const method = request.method();
    report.requests.push({ method, path });
    if (method === "GET") {
      if (path === "/status") return route.fulfill({ json: { initialized: true, version: "synthetic" } });
      if (path === "/session") {
        state.sessionReads++;
        return route.fulfill({ json: { user: state.actor, csrf_token: "synthetic-csrf" } });
      }
      if (path === "/users") return route.fulfill({ json: state.people });
      if (path === "/mfa") return route.fulfill({ json: { enabled: false } });
      if (path === "/settings") return route.fulfill({ json: { instance_name: "Synthetic fixture" } });
    }
    if (method === "POST" && path === "/users") {
      state.posts++;
      state.people.push({ ...created, id: state.posts === 1 ? created.id : "e3558fa9-1e22-4ec6-a95c-778d7da2c8b3" });
      if (hold) await new Promise((done) => state.held.push(done));
      if (state.drop) return route.abort("failed");
      return route.fulfill({ json: created });
    }
    report.unexpected.push({ method, path });
    return route.fulfill({ status: 500, json: { error: { code: "UNEXPECTED", message: "Unexpected fixture request" } } });
  });
  await page.goto(`${origin}/#/users`);
  await expect(page.getByRole("heading", { name: "People & security", exact: true })).toBeVisible();
  const close = async () => {
    for (const done of state.held.splice(0)) done();
    await page.evaluate(() => window.userCreationFixture?.bodyRelease?.()).catch(() => {});
    await context.close();
  };
  return { page, state, close, release: () => state.held.splice(0).forEach((done) => done()) };
}
async function prepare(f) {
  await f.page.getByRole("button", { name: "Add person", exact: true }).click();
  const dialog = f.page.getByRole("dialog", { name: "Add a workspace user" });
  await dialog.getByRole("textbox", { name: "Full name" }).fill(created.name);
  await dialog.getByRole("textbox", { name: "Email" }).fill(created.email);
  await dialog.getByLabel("Initial password").fill("synthetic-not-a-real-password");
  return dialog;
}
async function group(name, fn) {
  await fn();
  report.groups.push({ name, passed: true });
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("PASS " + name);
}
let failure;
try {
  await group("1. Held create headers exceed 30 seconds and block dismissal", async () => {
    const f = await fixture({ hold: true });
    try {
      const dialog = await prepare(f);
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect.poll(() => f.state.posts).toBe(1);
      await f.page.clock.fastForward(31000);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
      await f.page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      report.observations.push({ case: "held response headers", elapsed_browser_ms: 31000, outcome: "Busy form and dismissal remained blocked; no request deadline.", qualification: "Accelerated browser clock, not real wall time." });
    } finally { await f.close(); }
  });
  await group("2. Held create body exceeds 30 seconds and retains password form", async () => {
    const f = await fixture({ bodyHold: true });
    try {
      const dialog = await prepare(f);
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect.poll(() => f.page.evaluate(() => window.userCreationFixture.bodyStarted)).toBe(true);
      await f.page.clock.fastForward(31000);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
      await expect(dialog.getByLabel("Initial password")).toHaveValue("synthetic-not-a-real-password");
      report.observations.push({ case: "held response body", elapsed_browser_ms: 31000, outcome: "Disabled password field retained its value while form remained stuck.", qualification: "The report stores no password value or request body." });
    } finally { await f.close(); }
  });
  await group("3. Same-tick create submissions dispatch two POSTs", async () => {
    const f = await fixture({ hold: true });
    try {
      const dialog = await prepare(f);
      await dialog.locator("form").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
      await expect.poll(() => f.state.posts).toBe(2);
      report.observations.push({ case: "same-tick submit", outcome: "Two intercepted POSTs reached synthetic transport before busy state rendered; native uniqueness/commit is not inferred." });
    } finally { await f.close(); }
  });
  await group("4. Lost committed response leaves create form open for a fresh POST", async () => {
    const f = await fixture({ drop: true });
    try {
      const dialog = await prepare(f);
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect.poll(() => f.state.posts).toBe(1);
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Create user" })).toBeEnabled();
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect.poll(() => f.state.posts).toBe(2);
      report.observations.push({ case: "modeled commit with unread reply", outcome: "The UI offered a new unkeyed POST with the same form; synthetic duplicate acceptance is not a native-server claim." });
    } finally { await f.close(); }
  });
  await group("5. Same-account admin to viewer refresh leaves open creation dialog", async () => {
    const f = await fixture();
    try {
      const dialog = await prepare(f);
      f.state.actor = { ...f.state.actor, role: "viewer", revision: 2 };
      await f.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => f.state.sessionReads).toBeGreaterThan(1);
      await expect(f.page.getByRole("button", { name: "Add person", exact: true })).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Create user" })).toBeEnabled();
      report.observations.push({ case: "role downgrade while form open", outcome: "Add person entry disappears but its open form remains submit-enabled. Native authorization is separate." });
    } finally { await f.close(); }
  });
  expect(report.unexpected).toEqual([]);
  expect(report.page_errors).toEqual([]);
  report.source_end_sha256 = await sourceHashes();
  report.source_changes = sourceFiles.filter((path) => report.source_sha256[path] !== report.source_end_sha256[path]);
  expect(report.source_changes).toEqual([]);
  report.built_end_sha256 = await builtHashes();
  expect(report.built_end_sha256).toEqual(report.built_files_sha256);
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = String(error.stack || error);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  report.counts = { groups: report.groups.length, intercepted_requests: report.requests.length };
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ passed: report.passed, counts: report.counts, output }));
if (failure) throw failure;
