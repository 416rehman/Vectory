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
const AxeBuilder = require("@axe-core/playwright").default;
const output = resolve(root, process.env.VECTORY_USER_CREATION_OUTPUT || ".local/user-creation-recovery-after");
const build = resolve(root, process.env.VECTORY_USER_CREATION_BUILD || ".local/user-creation-recovery-build");
await mkdir(output, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/UsersSecurity.tsx",
  "dashboard/src/AddPersonActions.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/src/styles.css",
  "dashboard/src/control.css",
  "tests/security/user-creation-recovery-review.mjs",
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
  classification: "isolated_actual_app_correctness",
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
  accessibility: [],
  screenshots: [],
  geometry: [],
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

async function fixture({ holdHeaders = false, holdBeforeCommit = false, bodyHold = false, drop = false, wrongLookup = false, driftedLookup = false, wrongReceipt = false, wrongPreflight = false, unsupportedPreflight = false, rejectPost = false, width = 899, theme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
  await context.addInitScript((bodyHold) => {
    window.userCreationFixture = { bodyStarted: false, bodyRelease: null };
    if (!bodyHold) return;
    const native = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const path = new URL(typeof args[0] === "string" ? args[0] : args[0].url, location.href).pathname;
      const response = await native(...args);
      if (path === "/api/v1/users" && args[1]?.method === "POST") {
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
    actor: { ...actor }, people: [{ ...actor }], posts: 0, lookups: 0, cancels: 0,
    held: [], requestId: null, status: "not_found", drop, wrongLookup, driftedLookup,
    wrongPreflight, unsupportedPreflight, holdHeaders, holdBeforeCommit, wrongReceipt, rejectPost,
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
    report.requests.push({ method, path: path.startsWith('/users/requests/') ? '/users/requests/{key}' + (path.endsWith('/cancel') ? '/cancel' : '') : path });
    if (method === "GET") {
      if (path === "/status") return route.fulfill({ json: { initialized: true, version: "synthetic" } });
      if (path === "/session") {
        state.sessionReads = (state.sessionReads || 0) + 1;
        return route.fulfill({ json: { user: state.actor, csrf_token: "synthetic-csrf" } });
      }
      if (path === "/users") return route.fulfill({ json: state.people });
      if (path === "/mfa") return route.fulfill({ json: { enabled: false } });
      if (path === "/settings") return route.fulfill({ json: { instance_name: "Synthetic fixture" } });
      if (path.startsWith('/users/requests/')) {
        state.lookups++;
        const id = path.slice('/users/requests/'.length);
        state.requestId ??= id;
        if (state.unsupportedPreflight && state.posts === 0)
          return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Synthetic legacy server' } } });
        const echo = state.wrongPreflight && state.posts === 0 ? 'e3558fa9-1e22-4ec6-a95c-778d7da2c8b3' : id;
        if (state.status === 'created') return route.fulfill({ json: { request_id: echo, status: 'created', user: state.wrongLookup ? { ...created, id: 'e3558fa9-1e22-4ec6-a95c-778d7da2c8b3', email: 'other@fixture.example.test' } : state.driftedLookup ? { ...created, name: 'Renamed synthetic person', role: 'operator', enabled: false, revision: 2 } : created } });
        return route.fulfill({ json: { request_id: echo, status: state.status } });
      }
    }
    if (method === 'POST' && path.startsWith('/users/requests/') && path.endsWith('/cancel')) {
      state.cancels++;
      const id = path.slice('/users/requests/'.length, -'/cancel'.length);
      if (state.status === 'not_found') state.status = 'cancelled';
      return route.fulfill({ json: state.status === 'created' ? { request_id: id, status: 'created', user: created } : { request_id: id, status: 'cancelled' } });
    }
    if (method === "POST" && path === "/users") {
      state.posts++;
      const body = request.postDataJSON();
      if (typeof body?.request_id !== 'string') {
        report.unexpected.push({ method, path, reason: 'missing request_id' });
        return route.fulfill({ status: 400, json: { error: { code: 'INVALID_INPUT', message: 'Missing request key' } } });
      }
      state.requestId ??= body.request_id;
      if (state.rejectPost)
        return route.fulfill({ status: 400, json: { error: { code: 'INVALID_INPUT', message: 'Synthetic invalid user data' } } });
      if (state.status === 'cancelled' || state.status === 'created')
        return route.fulfill({ status: 409, json: { error: { code: 'CONFLICT', message: 'Synthetic one-shot key' } } });
      if (state.holdBeforeCommit) await new Promise((done) => state.held.push(done));
      if (state.status === 'cancelled')
        return route.fulfill({ status: 409, json: { error: { code: 'CONFLICT', message: 'Cancelled key' } } });
      state.status = 'created';
      state.people.push({ ...created });
      if (state.holdHeaders) await new Promise((done) => state.held.push(done));
      if (state.drop) return route.abort('failed');
      return route.fulfill({ json: { request_id: body.request_id, user: state.wrongReceipt ? { ...created, email: 'other@fixture.example.test' } : created } });
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
  await group('1. First keyed account creation requires exact fresh preflight and one direct receipt', async () => {
    const f = await fixture();
    try {
      const dialog = await prepare(f);
      await dialog.getByRole('button', { name: 'Create user' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(f.page.getByText('Workspace user created.')).toBeVisible();
      expect(f.state.posts).toBe(1);
      expect(f.state.lookups).toBe(1);
      expect(f.state.status).toBe('created');
      await expect(f.page.getByRole('button', { name: 'Add person', exact: true })).toBeVisible();
    } finally { await f.close(); }
  });
  await group('2. Held response headers and body time out into exact-request review without late success', async () => {
    for (const body of [false, true]) {
      const f = await fixture({ holdHeaders: !body, bodyHold: body });
      try {
        const dialog = await prepare(f);
        await dialog.getByRole('button', { name: 'Create user' }).click();
        if (body) await expect.poll(() => f.page.evaluate(() => window.userCreationFixture.bodyStarted)).toBe(true);
        else await expect.poll(() => f.state.posts).toBe(1);
        await f.page.clock.fastForward(31000);
        const review = f.page.getByRole('dialog', { name: 'Account creation not confirmed' });
        await expect(review).toBeVisible();
        await expect(review).toContainText('submitted password is not retained');
        await expect(review.getByRole('button', { name: 'Check request status' })).toBeEnabled();
        await f.page.evaluate(() => window.userCreationFixture?.bodyRelease?.());
        f.release();
        await f.page.waitForTimeout(40);
        await expect(f.page.getByText('Workspace user created.')).toHaveCount(0);
        expect(f.state.posts).toBe(1);
        await review.getByRole('button', { name: 'Check request status' }).click();
        await expect(review).toContainText('This request created');
        expect(f.state.posts).toBe(1);
        report.observations.push({ case: body ? 'held body' : 'held headers', elapsed_browser_ms: 31000, qualification: 'Accelerated browser time; client abort is not native rollback.' });
      } finally { await f.close(); }
    }
  });
  await group('3. Stop waiting, Close and Escape keep one-shot review and suppress late receipt', async () => {
    for (const exit of ['stop', 'x', 'escape']) {
      const f = await fixture({ holdHeaders: true });
      try {
        const form = await prepare(f);
        await form.getByRole('button', { name: 'Create user' }).click();
        await expect.poll(() => f.state.posts).toBe(1);
        const waiting = f.page.getByRole('dialog', { name: 'Waiting for account creation' });
        await expect(waiting).toBeVisible();
        if (exit === 'stop') await waiting.getByRole('button', { name: 'Stop waiting' }).click();
        else if (exit === 'x') await waiting.getByRole('button', { name: 'Close dialog' }).click();
        else await f.page.keyboard.press('Escape');
        await expect(waiting).toHaveCount(0);
        await expect(f.page.getByRole('button', { name: 'Review account creation' })).toBeVisible();
        f.release();
        await f.page.waitForTimeout(40);
        await expect(f.page.getByText('Workspace user created.')).toHaveCount(0);
        expect(f.state.posts).toBe(1);
        await f.page.getByRole('button', { name: 'Review account creation' }).click();
        await expect(f.page.getByRole('dialog', { name: 'Account creation not confirmed' })).toBeVisible();
      } finally { await f.close(); }
    }
  });
  await group('4. Same-tick submissions claim one key and dispatch one POST', async () => {
    const f = await fixture({ holdHeaders: true });
    try {
      const dialog = await prepare(f);
      await dialog.locator('form').evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
      await expect.poll(() => f.state.posts).toBe(1);
      expect(f.state.lookups).toBe(1);
      await expect(f.page.getByRole('dialog', { name: 'Waiting for account creation' })).toBeVisible();
    } finally { await f.close(); }
  });
  await group('5. Unread committed response resolves only by exact status without replaying password', async () => {
    const f = await fixture({ drop: true });
    try {
      const dialog = await prepare(f);
      await dialog.getByRole('button', { name: 'Create user' }).click();
      const review = f.page.getByRole('dialog', { name: 'Account creation not confirmed' });
      await expect(review).toBeVisible();
      await expect(review.getByRole('button', { name: 'Create user' })).toHaveCount(0);
      await review.getByRole('button', { name: 'Check request status' }).click();
      await expect(review).toContainText('This request created');
      await expect(review).toContainText('password is unknown');
      expect(f.state.posts).toBe(1);
      await review.getByRole('button', { name: 'Finish review' }).click();
      await expect(review).toHaveCount(0);
      await expect(f.page.getByRole('button', { name: 'Add person', exact: true })).toBeVisible();
      report.observations.push({ case: 'modeled committed unread response', qualification: 'Synthetic server state only; no real account or password mutation.' });
    } finally { await f.close(); }
  });
  await group('6. Cancel fences a held earlier send before its synthetic commit', async () => {
    const f = await fixture({ holdBeforeCommit: true });
    try {
      const dialog = await prepare(f);
      await dialog.getByRole('button', { name: 'Create user' }).click();
      await expect.poll(() => f.state.posts).toBe(1);
      const waiting = f.page.getByRole('dialog', { name: 'Waiting for account creation' });
      await waiting.getByRole('button', { name: 'Stop waiting' }).click();
      await f.page.getByRole('button', { name: 'Review account creation' }).click();
      const review = f.page.getByRole('dialog', { name: 'Account creation not confirmed' });
      await review.getByRole('button', { name: 'Check request status' }).click();
      await expect(review).toContainText('no committed result yet');
      await review.getByRole('button', { name: 'Cancel this request' }).click();
      await expect(review).toContainText('This request was cancelled');
      f.release();
      await f.page.waitForTimeout(40);
      expect(f.state.status).toBe('cancelled');
      expect(f.state.people).toHaveLength(1);
      expect(f.state.posts).toBe(1);
      expect(f.state.cancels).toBe(1);
      await review.getByRole('button', { name: 'Finish review' }).click();
      await expect(f.page.getByRole('button', { name: 'Add person', exact: true })).toBeVisible();
    } finally { await f.close(); }
  });
  await group('7. Absent or wrong preflight capability never sends account creation', async () => {
    for (const options of [{ unsupportedPreflight: true }, { wrongPreflight: true }]) {
      const f = await fixture(options);
      try {
        const form = await prepare(f);
        await form.getByRole('button', { name: 'Create user' }).click();
        await expect(form).toBeVisible();
        await expect(form.getByRole('alert')).toContainText('not sent');
        expect(f.state.posts).toBe(0);
        expect(f.state.lookups).toBe(1);
      } finally { await f.close(); }
    }
  });
  await group('8. Wrong first receipt is rejected; edited or substituted current status requires neutral review', async () => {
    for (const options of [{ wrongReceipt: true }, { drop: true, wrongLookup: true }, { drop: true, driftedLookup: true }]) {
      const f = await fixture(options);
      try {
        const form = await prepare(f);
        await form.getByRole('button', { name: 'Create user' }).click();
        const review = f.page.getByRole('dialog', { name: 'Account creation not confirmed' });
        await expect(review).toBeVisible();
        if (options.wrongLookup || options.driftedLookup)
          await review.getByRole('button', { name: 'Check request status' }).click();
        await expect(review.getByRole('alert')).toBeVisible();
        if (options.wrongReceipt) {
          await expect(review.getByRole('button', { name: 'Finish review' })).toHaveCount(0);
        } else {
          await expect(review).toContainText('current details differ from the original entry');
          await expect(review).toContainText('this page has not selected that account');
          await expect(review.getByRole('button', { name: 'Finish review' })).toBeEnabled();
          await expect(review).not.toContainText('This request created Synthetic new person');
        }
        expect(f.state.posts).toBe(1);
      } finally { await f.close(); }
    }
  });
  await group('9. Role downgrade retires old response and restored same actor can review exact key', async () => {
    const f = await fixture({ holdHeaders: true });
    try {
      const form = await prepare(f);
      await form.getByRole('button', { name: 'Create user' }).click();
      await expect.poll(() => f.state.posts).toBe(1);
      f.state.actor = { ...f.state.actor, role: 'viewer', revision: 2 };
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => f.state.sessionReads).toBeGreaterThan(1);
      await expect(f.page.getByRole('button', { name: 'Add person', exact: true })).toHaveCount(0);
      f.release();
      await f.page.waitForTimeout(40);
      await expect(f.page.getByText('Workspace user created.')).toHaveCount(0);
      f.state.actor = { ...f.state.actor, role: 'admin', revision: 3 };
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(f.page.getByRole('button', { name: 'Review account creation' })).toBeVisible();
      await f.page.getByRole('button', { name: 'Review account creation' }).click();
      const changed = f.page.getByRole('dialog', { name: 'Your access changed' });
      await changed.getByRole('button', { name: 'Review original request' }).click();
      const review = f.page.getByRole('dialog', { name: 'Account creation not confirmed' });
      await review.getByRole('button', { name: 'Check request status' }).click();
      await expect(review).toContainText('This request created');
      expect(f.state.posts).toBe(1);
    } finally { await f.close(); }
  });
  await group('10. Mobile and desktop review remain keyboard reachable with clean Axe scans', async () => {
    for (const [width, theme] of [[375, 'dark'], [899, 'light'], [375, 'light'], [899, 'dark']]) {
      const f = await fixture({ drop: true, width, theme });
      try {
        const form = await prepare(f);
        await form.getByRole('button', { name: 'Create user' }).click();
        const review = f.page.getByRole('dialog', { name: 'Account creation not confirmed' });
        await expect(review).toBeVisible();
        const primary = review.getByRole('button', { name: 'Check request status' });
        await primary.focus();
        await expect(primary).toBeFocused();
        await f.page.keyboard.press('Tab');
        await f.page.keyboard.press('Shift+Tab');
        await expect(primary).toBeFocused();
        const geometry = await review.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const code = element.querySelector('code');
          const codeBox = code?.getBoundingClientRect();
          const codeParent = code?.parentElement;
          const last = document.createRange();
          if (code?.firstChild) last.setStart(code.firstChild, code.firstChild.textContent.length - 1);
          if (code?.firstChild) last.setEnd(code.firstChild, code.firstChild.textContent.length);
          const lastBox = code?.firstChild ? last.getBoundingClientRect() : null;
          return { left: box.left, right: box.right, scrollWidth: document.documentElement.scrollWidth,
            code: codeBox ? { left: codeBox.left, right: codeBox.right, textLength: code.textContent.length,
              lastRight: lastBox.right, parentScrollWidth: codeParent.scrollWidth,
              parentClientWidth: codeParent.clientWidth } : null,
            buttons: [...element.querySelectorAll('button')].map((button) => {
              const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right, bottom: rect.bottom };
            }) };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width + 1);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(width + 1);
        expect(geometry.code?.lastRight).toBeLessThanOrEqual(width - 8);
        expect(geometry.code?.parentScrollWidth).toBeLessThanOrEqual(geometry.code?.parentClientWidth + 1);
        for (const button of geometry.buttons) {
          expect(button.left).toBeGreaterThanOrEqual(0);
          expect(button.right).toBeLessThanOrEqual(width + 1);
          expect(button.bottom).toBeLessThanOrEqual(901);
        }
        report.geometry.push({ width, theme, ...geometry });
        const axe = await new AxeBuilder({ page: f.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        expect(axe.violations).toEqual([]);
        report.accessibility.push({ width, theme, violations: [] });
        const shot = resolve(output, `account-creation-${width}-${theme}.png`);
        await f.page.screenshot({ path: shot, animations: 'disabled' });
        report.screenshots.push(relative(root, shot));
      } finally { await f.close(); }
    }
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
  report.counts = { groups: report.groups.length, axe_scans: report.accessibility.length, intercepted_requests: report.requests.length, screenshots: report.screenshots.length };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, counts: report.counts, output }));
if (failure) throw failure;
