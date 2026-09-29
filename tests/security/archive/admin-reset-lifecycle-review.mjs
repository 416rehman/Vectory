// Independent actual-App browser review. Accounts, codes and HTTP are synthetic.
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
const output = resolve(
  root,
  process.env.VECTORY_ADMIN_RESET_OUTPUT || ".local/password-reset-after",
);
const build = resolve(
  root,
  process.env.VECTORY_ADMIN_RESET_BUILD || ".local/password-reset-after-build",
);
await mkdir(output, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/AccountAccess.tsx",
  "dashboard/src/AdminPasswordResetActions.tsx",
  "dashboard/src/UsersSecurity.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/src/AccountPasswordFields.tsx",
  "dashboard/src/accountActionSession.ts",
  "dashboard/src/authRequests.ts",
  "dashboard/src/control.css",
  "dashboard/src/styles.css",
  "tests/security/admin-reset-lifecycle-review.mjs",
];
const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [
        path,
        hash(await readFile(resolve(root, path))),
      ]),
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
    "Private production App with intercepted synthetic accounts and HTTP. Native issuance/cancellation, authorization and delivery to a person require separate proof.",
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
    const targetPath = resolve(
      build,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (
      !targetPath.startsWith(build + "\\") &&
      !targetPath.startsWith(build + "/")
    )
      throw Error("outside fixture");
    response.setHeader(
      "Content-Type",
      mime[extname(targetPath)] || "application/octet-stream",
    );
    response.end(await readFile(targetPath));
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
const target = {
  id: "661d08ec-ae29-4903-91da-f3ad3e5b3d95",
  name: "Synthetic recipient",
  email: "recipient@fixture.example.test",
  role: "viewer",
  enabled: true,
  revision: 1,
};
const other = "e3558fa9-1e22-4ec6-a95c-778d7da2c8b3";
const otherTarget = {
  id: other,
  name: "Another synthetic recipient",
  email: "other-recipient@fixture.example.test",
  role: "viewer",
  enabled: true,
  revision: 1,
};
const resetPath = `/users/${target.id}/password-reset`;
const requestPath = `${resetPath}/requests/`;
const expiry = () => new Date(Date.now() + 900000).toISOString();

async function fixture({
  modes = {},
  bodyPath = null,
  width = 899,
  theme = "light",
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ({ bodyPath, theme }) => {
      localStorage.setItem("vectory-theme", theme);
      window.resetFixture = {
        bodyPath,
        bodyStarted: false,
        bodyRelease: null,
        aborted: [],
      };
      const native = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const path = new URL(
          typeof args[0] === "string" ? args[0] : args[0].url,
          location.href,
        ).pathname;
        args[1]?.signal?.addEventListener(
          "abort",
          () => window.resetFixture.aborted.push(path),
          { once: true },
        );
        const response = await native(...args);
        if (path === window.resetFixture.bodyPath) {
          window.resetFixture.bodyPath = null;
          const original = response.text.bind(response);
          response.text = async () => {
            const text = await original();
            window.resetFixture.bodyStarted = true;
            await new Promise(
              (done) => (window.resetFixture.bodyRelease = done),
            );
            return text;
          };
        }
        return response;
      };
    },
    { bodyPath, theme },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(9000);
  await page.clock.install();
  const state = {
    actor: { ...actor },
    csrf: "synthetic-csrf",
    target: { ...target },
    requests: [],
    posts: [],
    lookups: [],
    cancels: [],
    ledger: new Map(),
    holds: [],
    modes: Object.fromEntries(
      Object.entries(modes).map(([key, value]) => [key, [...value]]),
    ),
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
    const body = request.postData() ? request.postDataJSON() : null;
    const requestId = path.startsWith(requestPath)
      ? path.slice(requestPath.length).replace(/\/cancel$/, "")
      : body?.request_id;
    const entry = {
      method,
      path: path.startsWith(requestPath)
        ? `${requestPath}{key}${path.endsWith("/cancel") ? "/cancel" : ""}`
        : path,
      request_id: requestId || null,
      body_keys: body ? Object.keys(body).sort() : [],
      csrf:
        request.headers()["x-csrf-token"] === state.csrf ? "current" : "other",
    };
    state.requests.push(entry);
    report.requests.push(entry);
    const mode = state.modes[`${method} ${entry.path}`]?.shift() || {};
    const send = async (json, status = 200) => {
      if (mode.holdBefore) await new Promise((done) => state.holds.push(done));
      if (mode.drop) {
        try {
          await route.abort("failed");
        } catch {}
        return;
      }
      if (Object.hasOwn(mode, "raw")) {
        try {
          await route.fulfill({
            body: mode.raw,
            contentType: "application/json",
            status: mode.status || status,
          });
        } catch {}
        return;
      }
      try {
        await route.fulfill({
          json: mode.transform
            ? mode.transform(json)
            : Object.hasOwn(mode, "json")
              ? mode.json
              : json,
          status: mode.status || status,
        });
      } catch {}
    };
    if (method === "GET") {
      if (path === "/status")
        return send({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return send({ user: state.actor, csrf_token: state.csrf });
      if (path === "/users")
        return send([state.actor, state.target, otherTarget]);
      if (path === "/mfa") return send({ enabled: false });
      if (path === "/settings")
        return send({ instance_name: "Synthetic fixture" });
      if (path.startsWith(requestPath) && !path.endsWith("/cancel")) {
        state.lookups.push(requestId);
        const record = state.ledger.get(requestId);
        return send(
          record?.status === "issued"
            ? {
                request_id: requestId,
                user_id: target.id,
                status: "issued",
                active: record.active,
                expires_at: record.expires_at,
              }
            : record?.status === "cancelled"
              ? {
                  request_id: requestId,
                  user_id: target.id,
                  status: "cancelled",
                  was_issued: record.was_issued,
                }
              : {
                  request_id: requestId,
                  user_id: target.id,
                  status: "not_found",
                },
        );
      }
    }
    if (method === "POST" && path === resetPath) {
      state.posts.push({
        request_id: body?.request_id,
        revision: body?.revision,
        password_supplied: typeof body?.current_password === "string",
      });
      if (!body?.request_id) {
        report.unexpected.push({
          method,
          path,
          reason: "missing keyed identity",
        });
        return send(
          {
            error: {
              code: "INVALID_INPUT",
              message: "Missing request identity",
            },
          },
          400,
        );
      }
      const prior = state.ledger.get(body.request_id);
      if (prior)
        return send(
          { error: { code: "CONFLICT", message: "One-shot key already used" } },
          409,
        );
      if (mode.holdBeforeCommit)
        await new Promise((done) => state.holds.push(done));
      if (state.ledger.has(body.request_id))
        return send(
          { error: { code: "CONFLICT", message: "Cancelled key" } },
          409,
        );
      const code = "a".repeat(63) + Math.min(state.posts.length, 9);
      const expires_at = expiry();
      state.ledger.set(body.request_id, {
        status: "issued",
        active: true,
        expires_at,
        code,
      });
      return send({
        request_id: body.request_id,
        user_id: target.id,
        code,
        expires_at,
      });
    }
    if (
      method === "POST" &&
      path.startsWith(requestPath) &&
      path.endsWith("/cancel")
    ) {
      state.cancels.push(requestId);
      const prior = state.ledger.get(requestId);
      state.ledger.set(requestId, {
        status: "cancelled",
        was_issued: prior?.status === "issued" || !!prior?.was_issued,
      });
      return send({
        request_id: requestId,
        user_id: target.id,
        status: "cancelled",
        was_issued: prior?.status === "issued" || !!prior?.was_issued,
      });
    }
    report.unexpected.push({ method, path });
    return send(
      {
        error: { code: "UNEXPECTED", message: "Unexpected synthetic request" },
      },
      500,
    );
  });
  await page.goto(`${origin}/#/users`);
  await expect(
    page.getByRole("heading", { name: "People & security", exact: true }),
  ).toBeVisible();
  const release = () => state.holds.splice(0).forEach((done) => done());
  const close = async () => {
    release();
    await page
      .evaluate(() => window.resetFixture?.bodyRelease?.())
      .catch(() => {});
    await context.close();
  };
  return { page, context, state, release, close };
}

async function observe(name, fn) {
  await fn();
  report.groups.push({ name, passed: true });
  console.log("PASS " + name);
}
const dialog = (f) => f.page.getByRole("dialog");
async function openReset(f) {
  await f.page
    .getByRole("button", { name: `Reset password for ${target.name}` })
    .click();
  await expect(dialog(f)).toHaveAccessibleName("Create a password reset code");
  await dialog(f)
    .getByLabel("Your current password")
    .fill("synthetic-not-a-real-password");
  return dialog(f);
}
async function submit(f) {
  await openReset(f);
  await dialog(f)
    .getByRole("button", { name: "Create reset code", exact: true })
    .click();
}
async function waitUnknown(f) {
  await expect(dialog(f)).toHaveAccessibleName("Reset code result unknown");
  await expect(dialog(f).locator('input[type="password"]')).toHaveCount(0);
}
const postMode = `POST ${resetPath}`;
const lookupMode = `GET ${requestPath}{key}`;
const cancelMode = `POST ${requestPath}{key}/cancel`;

let failure;
try {
  await observe(
    "1. Direct keyed receipt is bound to one preflight and a recoverable in-memory code",
    async () => {
      const f = await fixture();
      try {
        await submit(f);
        await expect.poll(() => f.state.posts.length).toBe(1);
        await expect(dialog(f)).toHaveAccessibleName(
          `Password reset for ${target.name}`,
        );
        expect(f.state.lookups).toEqual([f.state.posts[0].request_id]);
        expect(f.state.posts[0].password_supplied).toBe(true);
        await expect(dialog(f).getByLabel("Password reset code")).toContainText(
          /^[a-f0-9]{64}$/,
        );
        const stored = await f.page.evaluate(() =>
          [localStorage, sessionStorage].flatMap((storage) =>
            Array.from({ length: storage.length }, (_, index) => {
              const key = storage.key(index);
              return [key, key === null ? null : storage.getItem(key)];
            }),
          ),
        );
        expect(JSON.stringify(stored)).not.toContain(
          f.state.ledger.get(f.state.posts[0].request_id).code,
        );
        await dialog(f).getByRole("button", { name: "Hide for now" }).click();
        await expect(dialog(f)).toHaveCount(0);
        await f.page.getByRole("button", { name: "Show reset code" }).click();
        await expect(dialog(f).getByLabel("Password reset code")).toBeVisible();
        await dialog(f)
          .getByRole("button", { name: /shared the code/i })
          .click();
        await expect(
          f.page.getByRole("button", { name: "Show reset code" }),
        ).toHaveCount(0);
        expect(f.state.posts).toHaveLength(1);
        report.observations.push({
          case: "direct receipt",
          outcome:
            "One correlated POST; hiding retained the synthetic code only in the mounted page until explicit acknowledgement.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "2. Unsupported or mismatched preflight sends no password reset POST",
    async () => {
      for (const mode of [
        {
          status: 404,
          json: {
            error: { code: "NOT_FOUND", message: "Synthetic legacy server" },
          },
        },
        { transform: (value) => ({ ...value, request_id: other }) },
        { transform: (value) => ({ ...value, user_id: other }) },
      ]) {
        const f = await fixture({ modes: { [lookupMode]: [mode] } });
        try {
          await submit(f);
          await expect(dialog(f)).toHaveAccessibleName(
            "Create a password reset code",
          );
          await expect(dialog(f).getByRole("alert")).toBeVisible();
          expect(f.state.posts).toHaveLength(0);
        } finally {
          await f.close();
        }
      }
      report.observations.push({
        case: "unsupported or miscorrelated preflight",
        outcome:
          "No reset POST or password transmission reached the synthetic API.",
      });
    },
  );
  await observe(
    "3. Same-tick submit has one keyed POST and one original request identity",
    async () => {
      const f = await fixture();
      try {
        await openReset(f);
        await dialog(f)
          .locator("form")
          .evaluate((form) => {
            form.requestSubmit();
            form.requestSubmit();
          });
        await expect.poll(() => f.state.posts.length).toBe(1);
        await expect(dialog(f)).toHaveAccessibleName(
          `Password reset for ${target.name}`,
        );
        expect(f.state.lookups).toEqual([f.state.posts[0].request_id]);
        expect(f.state.posts[0].request_id).toMatch(/^[a-f0-9-]{36}$/);
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "4. Held headers stop in 30 seconds; late receipt cannot show a code",
    async () => {
      const f = await fixture({
        modes: { [postMode]: [{ holdBefore: true }] },
      });
      try {
        await submit(f);
        await expect.poll(() => f.state.posts.length).toBe(1);
        await f.page.clock.fastForward(31000);
        await waitUnknown(f);
        await expect(
          dialog(f).getByRole("button", { name: "Check request status" }),
        ).toBeVisible();
        f.release();
        await expect(dialog(f).getByLabel("Password reset code")).toHaveCount(
          0,
        );
        expect(f.state.posts).toHaveLength(1);
        report.observations.push({
          case: "header wait",
          elapsed_browser_ms: 31000,
          outcome:
            "Bounded wait, cleared password and retained exact nonsecret review; late secret suppressed.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "5. Held response body can be stopped, closed and reopened without replay",
    async () => {
      const f = await fixture({ bodyPath: `/api/v1${resetPath}` });
      try {
        await submit(f);
        await expect
          .poll(() => f.page.evaluate(() => window.resetFixture.bodyStarted))
          .toBe(true);
        await dialog(f).getByRole("button", { name: "Stop waiting" }).click();
        await expect(dialog(f)).toHaveCount(0);
        await f.page
          .getByRole("button", { name: "Review reset request" })
          .click();
        await waitUnknown(f);
        await f.page.keyboard.press("Escape");
        await expect(dialog(f)).toHaveCount(0);
        await f.page
          .getByRole("button", { name: "Review reset request" })
          .click();
        await waitUnknown(f);
        await f.page.evaluate(() => window.resetFixture.bodyRelease?.());
        await expect(dialog(f).getByLabel("Password reset code")).toHaveCount(
          0,
        );
        expect(f.state.posts).toHaveLength(1);
        report.observations.push({
          case: "response body wait",
          outcome:
            "Stop/Escape leave a page-local review; the late body cannot publish the synthetic code.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "6. Lost committed reply requires exact status and cancellation before a replacement",
    async () => {
      const f = await fixture({ modes: { [postMode]: [{ drop: true }] } });
      try {
        await submit(f);
        await waitUnknown(f);
        const key = f.state.posts[0].request_id;
        await dialog(f)
          .getByRole("button", { name: "Check request status" })
          .click();
        await expect(
          dialog(f).getByText(/A code was issued for this request/),
        ).toBeVisible();
        await expect(dialog(f).getByLabel("Password reset code")).toHaveCount(
          0,
        );
        await dialog(f)
          .getByRole("button", { name: "Cancel this request" })
          .click();
        await expect(
          dialog(f).getByText(/cannot issue or retain a usable code/),
        ).toBeVisible();
        expect(f.state.cancels).toEqual([key]);
        await dialog(f).getByRole("button", { name: "Finish review" }).click();
        await expect(dialog(f)).toHaveCount(0);
        expect(f.state.posts).toHaveLength(1);
        report.observations.push({
          case: "lost issuance receipt",
          outcome:
            "Status disclosed metadata only; exact keyed cancellation fenced the old request before review could finish.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "7. Lost cancellation can be repeated only for the original key",
    async () => {
      const f = await fixture({
        modes: { [postMode]: [{ drop: true }], [cancelMode]: [{ drop: true }] },
      });
      try {
        await submit(f);
        await waitUnknown(f);
        const key = f.state.posts[0].request_id;
        await dialog(f)
          .getByRole("button", { name: "Cancel this request" })
          .click();
        await expect(dialog(f).getByRole("alert")).toBeVisible();
        await dialog(f)
          .getByRole("button", { name: "Cancel this request" })
          .click();
        await expect(
          dialog(f).getByText(/cannot issue or retain a usable code/),
        ).toBeVisible();
        expect(f.state.cancels).toEqual([key, key]);
        expect(f.state.posts).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "8. Wrong keyed receipt or status cannot expose a code or resolve review",
    async () => {
      for (const scenario of [
        "receipt-request",
        "receipt-user",
        "status-request",
        "status-user",
      ]) {
        const statusScenario = scenario.startsWith("status");
        const wrongUser = scenario.endsWith("user");
        const transform = (value) => ({
          ...value,
          [wrongUser ? "user_id" : "request_id"]: other,
        });
        const modes = statusScenario
          ? { [postMode]: [{ drop: true }], [lookupMode]: [{}, { transform }] }
          : { [postMode]: [{ transform }] };
        const f = await fixture({ modes });
        try {
          await submit(f);
          await waitUnknown(f);
          if (statusScenario) {
            await dialog(f)
              .getByRole("button", { name: "Check request status" })
              .click();
            await expect(dialog(f).getByRole("alert")).toBeVisible();
          }
          await expect(dialog(f).getByLabel("Password reset code")).toHaveCount(
            0,
          );
          expect(f.state.posts).toHaveLength(1);
        } finally {
          await f.close();
        }
      }
    },
  );
  await observe(
    "9. Role change during a held reset hides secret and disables old review",
    async () => {
      const f = await fixture({
        modes: { [postMode]: [{ holdBefore: true }] },
      });
      try {
        await submit(f);
        await expect.poll(() => f.state.posts.length).toBe(1);
        f.state.actor = { ...f.state.actor, role: "viewer", revision: 2 };
        await f.page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(
          f.page.getByRole("button", { name: "Review reset request" }),
        ).toHaveCount(0);
        f.release();
        await expect(f.page.getByLabel("Password reset code")).toHaveCount(0);
        expect(f.state.posts).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "10. Narrow layouts and keyboard-accessible review retain bounds and labels",
    async () => {
      for (const [width, theme] of [
        [375, "dark"],
        [375, "light"],
        [899, "light"],
      ]) {
        const f = await fixture({
          width,
          theme,
          modes: { [postMode]: [{ drop: true }] },
        });
        try {
          await submit(f);
          await waitUnknown(f);
          const geometry = await dialog(f).evaluate((element) => {
            const box = (node) => {
              const rect = node.getBoundingClientRect();
              return { x: rect.x, right: rect.right, bottom: rect.bottom };
            };
            return {
              dialog: box(element),
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              buttons: [...element.querySelectorAll("button")].map(box),
              viewport: { width: innerWidth, height: innerHeight },
            };
          });
          expect(geometry.scrollWidth).toBeLessThanOrEqual(
            geometry.clientWidth + 1,
          );
          for (const button of geometry.buttons) {
            expect(button.x).toBeGreaterThanOrEqual(0);
            expect(button.right).toBeLessThanOrEqual(width + 1);
          }
          const axe = await new AxeBuilder({ page: f.page }).analyze();
          expect(axe.violations).toEqual([]);
          report.geometry.push({ width, theme, ...geometry });
          report.accessibility.push({
            width,
            theme,
            violations: axe.violations,
          });
          const shot = resolve(
            output,
            `password-reset-review-${width}-${theme}.png`,
          );
          await f.page.screenshot({ path: shot });
          report.screenshots.push(relative(root, shot));
          await dialog(f)
            .getByRole("button", { name: "Check request status" })
            .focus();
          await expect(
            dialog(f).getByRole("button", { name: "Check request status" }),
          ).toBeFocused();
        } finally {
          await f.close();
        }
      }
    },
  );
  await observe(
    "11. Browser clock alone cannot erase the only plaintext code",
    async () => {
      const f = await fixture();
      try {
        await submit(f);
        await expect(dialog(f)).toHaveAccessibleName(
          `Password reset for ${target.name}`,
        );
        await f.page.clock.fastForward(3600000);
        await expect(
          dialog(f).getByRole("button", { name: "Check code status" }),
        ).toBeVisible();
        await dialog(f)
          .getByRole("button", { name: "Check code status" })
          .click();
        await expect(dialog(f).getByLabel("Password reset code")).toContainText(
          /^[a-f0-9]{64}$/,
        );
        await dialog(f).getByRole("button", { name: "Hide for now" }).click();
        await f.page.getByRole("button", { name: "Show reset code" }).click();
        await expect(dialog(f).getByLabel("Password reset code")).toBeVisible();
        report.observations.push({
          case: "local clock drift",
          elapsed_browser_ms: 3600000,
          outcome:
            "Local wall-clock jump did not discard the only readable synthetic code without an exact server status.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "12. An unrelated target name/revision edit cannot erase an active code",
    async () => {
      const f = await fixture();
      try {
        await submit(f);
        await expect(dialog(f)).toHaveAccessibleName(
          `Password reset for ${target.name}`,
        );
        f.state.target = {
          ...f.state.target,
          name: "Synthetic recipient renamed",
          revision: 3,
        };
        await f.page.clock.fastForward(16000);
        await expect(
          dialog(f).getByText(/account changed after the code was issued/i),
        ).toBeVisible();
        await dialog(f)
          .getByRole("button", { name: "Check code status" })
          .click();
        await expect(dialog(f).getByLabel("Password reset code")).toContainText(
          /^[a-f0-9]{64}$/,
        );
        expect(f.state.posts).toHaveLength(1);
        report.observations.push({
          case: "unrelated account revision",
          outcome:
            "A name-only target update did not discard the code; only exact request status can establish inactivity.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "13. Another person’s row action cannot reveal the first person’s code",
    async () => {
      const f = await fixture();
      try {
        await submit(f);
        await expect(dialog(f)).toHaveAccessibleName(
          `Password reset for ${target.name}`,
        );
        await dialog(f).getByRole("button", { name: "Hide for now" }).click();
        await f.page
          .getByRole("button", {
            name: `Reset password for ${otherTarget.name}`,
          })
          .click();
        await expect(f.page.getByLabel("Password reset code")).toHaveCount(0);
        expect(f.state.posts).toHaveLength(1);
        report.observations.push({
          case: "different row while code held",
          outcome:
            "The other person’s row did not expose or issue the first person’s secret. The dedicated reminder remains the only reveal entry.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "14. A browser clock ahead cannot discard a fresh server receipt",
    async () => {
      const f = await fixture();
      try {
        await f.page.clock.fastForward(3600000);
        await submit(f);
        await expect(dialog(f)).toHaveAccessibleName(
          `Password reset for ${target.name}`,
        );
        await dialog(f)
          .getByRole("button", { name: "Check code status" })
          .click();
        await expect(dialog(f).getByLabel("Password reset code")).toContainText(
          /^[a-f0-9]{64}$/,
        );
        expect(f.state.posts).toHaveLength(1);
        report.observations.push({
          case: "clock ahead at receipt",
          outcome:
            "A correlated fresh server response remained readable despite a browser clock one hour ahead.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "15. Close and Escape hide a confirmed code without losing the only page copy",
    async () => {
      const f = await fixture();
      try {
        await submit(f);
        await expect(dialog(f)).toHaveAccessibleName(
          `Password reset for ${target.name}`,
        );
        await f.page.keyboard.press("Escape");
        await expect(dialog(f)).toHaveCount(0);
        await f.page.getByRole("button", { name: "Show reset code" }).click();
        await expect(dialog(f).getByLabel("Password reset code")).toBeVisible();
        await dialog(f).getByRole("button", { name: "Close dialog" }).click();
        await expect(dialog(f)).toHaveCount(0);
        await f.page.getByRole("button", { name: "Show reset code" }).click();
        await expect(dialog(f).getByLabel("Password reset code")).toBeVisible();
        expect(f.state.posts).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "16. A not-found snapshot requires cancellation before late issuance can land",
    async () => {
      const f = await fixture({
        modes: { [postMode]: [{ holdBeforeCommit: true }] },
      });
      try {
        await submit(f);
        await expect.poll(() => f.state.posts.length).toBe(1);
        const key = f.state.posts[0].request_id;
        await f.page.clock.fastForward(31000);
        await waitUnknown(f);
        await dialog(f)
          .getByRole("button", { name: "Check request status" })
          .click();
        await expect(
          dialog(f).getByText(/No committed result is visible yet/),
        ).toBeVisible();
        await dialog(f)
          .getByRole("button", { name: "Cancel this request" })
          .click();
        await expect(
          dialog(f).getByText(/cannot issue or retain a usable code/),
        ).toBeVisible();
        expect(f.state.ledger.get(key)).toMatchObject({
          status: "cancelled",
          was_issued: false,
        });
        f.release();
        await expect(dialog(f).getByLabel("Password reset code")).toHaveCount(
          0,
        );
        expect(f.state.posts).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
  await observe(
    "17. Changed session, account or role suppresses a held plaintext code",
    async () => {
      for (const change of ["csrf", "account", "role"]) {
        const f = await fixture();
        try {
          await submit(f);
          await expect(dialog(f)).toHaveAccessibleName(
            `Password reset for ${target.name}`,
          );
          if (change === "csrf") f.state.csrf = "synthetic-new-csrf";
          else if (change === "account")
            f.state.actor = {
              ...f.state.actor,
              id: "c05573d3-bc5d-42fb-a752-9836056a9e63",
            };
          else
            f.state.actor = { ...f.state.actor, role: "viewer", revision: 2 };
          await f.page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await expect(f.page.getByLabel("Password reset code")).toHaveCount(0);
          await expect(
            f.page.getByRole("button", { name: "Show reset code" }),
          ).toHaveCount(0);
          expect(f.state.posts).toHaveLength(1);
        } finally {
          await f.close();
        }
      }
    },
  );
  await observe(
    "18. Exact status response headers and body are separately bounded",
    async () => {
      for (const bodyHold of [false, true]) {
        const f = await fixture({
          modes: {
            [postMode]: [{ drop: true }],
            ...(bodyHold ? {} : { [lookupMode]: [{}, { holdBefore: true }] }),
          },
        });
        try {
          await submit(f);
          await waitUnknown(f);
          if (bodyHold) {
            const key = f.state.posts[0].request_id;
            await f.page.evaluate(
              (path) => (window.resetFixture.bodyPath = path),
              `/api/v1${requestPath}${key}`,
            );
          }
          await dialog(f)
            .getByRole("button", { name: "Check request status" })
            .click();
          if (bodyHold)
            await expect
              .poll(() =>
                f.page.evaluate(() => window.resetFixture.bodyStarted),
              )
              .toBe(true);
          else await expect.poll(() => f.state.lookups.length).toBe(2);
          await f.page.clock.fastForward(31000);
          await expect(dialog(f).getByRole("alert")).toBeVisible();
          await expect(
            dialog(f).getByRole("button", { name: "Check request status" }),
          ).toBeEnabled();
          f.release();
          await f.page.evaluate(() => window.resetFixture.bodyRelease?.());
          await expect(dialog(f).getByLabel("Password reset code")).toHaveCount(
            0,
          );
          expect(f.state.posts).toHaveLength(1);
        } finally {
          await f.close();
        }
      }
    },
  );
  await observe(
    "19. Clock skew followed by harmless account edit does not repeatedly mask an active code",
    async () => {
      const f = await fixture();
      try {
        await f.page.clock.fastForward(3600000);
        await submit(f);
        await expect(dialog(f)).toHaveAccessibleName(
          `Password reset for ${target.name}`,
        );
        await dialog(f)
          .getByRole("button", { name: "Check code status" })
          .click();
        await expect(dialog(f).getByLabel("Password reset code")).toBeVisible();
        f.state.target = {
          ...f.state.target,
          name: "Another harmless name edit",
          revision: 3,
        };
        await f.page.clock.fastForward(16000);
        await expect(
          dialog(f).getByText(/account changed after the code was issued/i),
        ).toBeVisible();
        await dialog(f)
          .getByRole("button", { name: "Check code status" })
          .click();
        await expect(dialog(f).getByLabel("Password reset code")).toBeVisible();
        await f.page.clock.fastForward(1000);
        await expect(dialog(f).getByLabel("Password reset code")).toBeVisible();
        expect(f.state.posts).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
  report.source_end_sha256 = await sourceHashes();
  report.source_changes = sourceFiles.filter(
    (path) => sourceStart[path] !== report.source_end_sha256[path],
  );
  expect(report.source_changes).toEqual([]);
  expect(await builtHashes()).toEqual(report.built_files_sha256);
  expect(report.page_errors).toEqual([]);
  expect(report.unexpected).toEqual([]);
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = String(error.stack || error);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  report.counts = {
    groups: report.groups.length,
    intercepted_requests: report.requests.length,
    axe_scans: report.accessibility.length,
  };
  await writeFile(
    resolve(root, "docs/evidence/admin-reset-lifecycle.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    passed: report.passed,
    counts: report.counts,
    output: "docs/evidence/admin-reset-lifecycle.json",
  }),
);
if (failure) throw failure;
