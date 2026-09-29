// Independent actual-App review. Accounts and HTTP are synthetic; no live user is edited.
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
  process.env.VECTORY_ACCESS_EDIT_OUTPUT || ".local/access-edit-after",
);
const build = resolve(
  root,
  process.env.VECTORY_ACCESS_EDIT_BUILD || ".local/access-edit-after-build",
);
await mkdir(output, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/AccountAccess.tsx",
  "dashboard/src/UsersSecurity.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/src/RolePicker.tsx",
  "dashboard/src/AccountPasswordFields.tsx",
  "dashboard/src/accountActionSession.ts",
  "dashboard/src/control.css",
  "dashboard/src/styles.css",
  "tests/security/access-edit-lifecycle-review.mjs",
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
    "Private production App with intercepted synthetic accounts and HTTP. Native access edits, authorization and session revocation require separate proof.",
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
  name: "Synthetic colleague",
  email: "colleague@fixture.example.test",
  role: "viewer",
  enabled: true,
  revision: 1,
};
const other = {
  id: "8d798e60-6dc7-4a26-aecb-ce426fc39de0",
  name: "Synthetic unrelated",
  email: "unrelated@fixture.example.test",
  role: "viewer",
  enabled: true,
  revision: 1,
};
const editPath = `/users/${target.id}`;
const requestPath = `${editPath}/access-requests/`;
const modePath = (method, path) => `${method} ${path}`;
const putMode = modePath("PUT", editPath);
const getMode = modePath("GET", `${requestPath}{key}`);
const cancelMode = modePath("POST", `${requestPath}{key}/cancel`);

async function fixture({
  modes = {},
  bodyPath = null,
  width = 899,
  theme = "light",
  selfEdit = false,
} = {}) {
  const subject = selfEdit ? actor : target;
  const subjectPath = `/users/${subject.id}`;
  const subjectRequestPath = `${subjectPath}/access-requests/`;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ({ bodyPath, theme }) => {
      localStorage.setItem("vectory-theme", theme);
      window.editFixture = {
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
          () => window.editFixture.aborted.push(path),
          { once: true },
        );
        const response = await native(...args);
        if (path === window.editFixture.bodyPath) {
          window.editFixture.bodyPath = null;
          const original = response.text.bind(response);
          response.text = async () => {
            const text = await original();
            window.editFixture.bodyStarted = true;
            await new Promise(
              (done) => (window.editFixture.bodyRelease = done),
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
    target: { ...subject },
    requests: [],
    puts: [],
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
    const path = url.pathname.slice(7),
      method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    const requestId = path.startsWith(subjectRequestPath)
      ? path.slice(subjectRequestPath.length).replace(/\/cancel$/, "")
      : body?.request_id;
    const normalized = path.startsWith(subjectRequestPath)
      ? `${subjectRequestPath}{key}${path.endsWith("/cancel") ? "/cancel" : ""}`
      : path;
    const entry = {
      method,
      path: normalized,
      request_id: requestId || null,
      body_keys: body ? Object.keys(body).sort() : [],
      csrf:
        request.headers()["x-csrf-token"] === state.csrf ? "current" : "other",
    };
    state.requests.push(entry);
    report.requests.push(entry);
    const mode = state.modes[modePath(method, normalized)]?.shift() || {};
    const send = async (json, status = 200) => {
      if (mode.holdBefore) await new Promise((done) => state.holds.push(done));
      if (mode.drop) {
        try {
          await route.abort("failed");
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
        return send(
          selfEdit
            ? [state.target, { ...other, role: "admin" }, target]
            : [state.actor, state.target, other],
        );
      if (path === "/mfa") return send({ enabled: false });
      if (path === "/settings")
        return send({ instance_name: "Synthetic fixture" });
      if (path === "/overview")
        return send({
          devices_total: 0,
          devices_online: 0,
          configurations_total: 0,
          deployments_active: 0,
          issues_open: 0,
          devices: [],
          recent_activity: [],
        });
      if (path.startsWith(subjectRequestPath) && !path.endsWith("/cancel")) {
        state.lookups.push(requestId);
        const prior = state.ledger.get(requestId);
        return send(
          prior?.status === "applied"
            ? {
                request_id: requestId,
                user_id: subject.id,
                status: "applied",
                user: prior.user,
              }
            : {
                request_id: requestId,
                user_id: subject.id,
                status:
                  prior?.status === "cancelled" ? "cancelled" : "not_found",
              },
        );
      }
    }
    if (method === "PUT" && path === subjectPath) {
      state.puts.push({
        request_id: body?.request_id,
        revision: body?.revision,
        password_supplied: typeof body?.current_password === "string",
        proposal: {
          name: body?.name,
          role: body?.role,
          enabled: body?.enabled,
        },
      });
      if (!body?.request_id) {
        report.unexpected.push({ method, path, reason: "missing key" });
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
      if (state.ledger.has(body.request_id))
        return send(
          { error: { code: "CONFLICT", message: "Key already used" } },
          409,
        );
      if (mode.holdBeforeCommit)
        await new Promise((done) => state.holds.push(done));
      if (state.ledger.has(body.request_id))
        return send(
          { error: { code: "CONFLICT", message: "Cancelled key" } },
          409,
        );
      const user = {
        ...state.target,
        name: body.name,
        role: body.role,
        enabled: body.enabled,
        revision: body.revision + 1,
      };
      state.ledger.set(body.request_id, { status: "applied", user });
      state.target = user;
      if (selfEdit) state.actor = user;
      return send({ request_id: body.request_id, user });
    }
    if (
      method === "POST" &&
      path.startsWith(subjectRequestPath) &&
      path.endsWith("/cancel")
    ) {
      state.cancels.push(requestId);
      const prior = state.ledger.get(requestId);
      if (!prior) state.ledger.set(requestId, { status: "cancelled" });
      return send(
        prior?.status === "applied"
          ? {
              request_id: requestId,
              user_id: subject.id,
              status: "applied",
              user: prior.user,
            }
          : { request_id: requestId, user_id: subject.id, status: "cancelled" },
      );
    }
    report.unexpected.push({ method, path });
    return send(
      { error: { code: "UNEXPECTED", message: "Unexpected fixture request" } },
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
      .evaluate(() => window.editFixture?.bodyRelease?.())
      .catch(() => {});
    await context.close();
  };
  return { page, context, state, release, close };
}
async function group(name, fn) {
  await fn();
  report.groups.push({ name, passed: true });
  console.log("PASS " + name);
}
const dialog = (f) => f.page.getByRole("dialog");
async function prepare(f, person = target) {
  await f.page
    .getByRole("button", { name: `Edit access for ${person.name}` })
    .click();
  await expect(dialog(f)).toHaveAccessibleName("Edit workspace access");
  await dialog(f).getByLabel("Full name").fill("Synthetic colleague edited");
  await dialog(f)
    .getByLabel("Your current password")
    .fill("synthetic-not-a-real-password");
}
async function submit(f) {
  await prepare(f);
  await dialog(f).getByRole("button", { name: "Save access" }).click();
}
async function unknown(f) {
  await expect(dialog(f)).toHaveAccessibleName("Access change needs review");
  await expect(dialog(f).locator('input[type="password"]')).toHaveCount(0);
}

let failure;
try {
  await group(
    "1. Direct edit has one keyed preflight, one PUT and exact receipt",
    async () => {
      const f = await fixture();
      try {
        await submit(f);
        await expect.poll(() => f.state.puts.length).toBe(1);
        await expect(dialog(f)).not.toBeVisible();
        expect(f.state.lookups).toEqual([f.state.puts[0].request_id]);
        expect(f.state.puts[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(f.state.puts[0].password_supplied).toBe(true);
        await expect(
          f.page
            .getByRole("status")
            .filter({ hasText: "Saved Synthetic colleague edited" }),
        ).toBeVisible();
        report.observations.push({
          case: "direct receipt",
          outcome:
            "One correlated keyed PUT and exact preflight; no extra mutation.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "2. Unsupported or wrong-target preflight never sends the password",
    async () => {
      for (const mode of [
        {
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "No route" } },
        },
        { transform: (v) => ({ ...v, user_id: other.id }) },
      ]) {
        const f = await fixture({ modes: { [getMode]: [mode] } });
        try {
          await submit(f);
          await expect(dialog(f)).toHaveAccessibleName("Edit workspace access");
          await expect(dialog(f).getByRole("alert")).toBeVisible();
          expect(f.state.puts.length).toBe(0);
        } finally {
          await f.close();
        }
      }
    },
  );
  await group("3. Same-tick submissions dispatch one keyed PUT", async () => {
    const f = await fixture({ modes: { [putMode]: [{ holdBefore: true }] } });
    try {
      await prepare(f);
      await dialog(f)
        .locator("form")
        .evaluate((form) => {
          form.requestSubmit();
          form.requestSubmit();
        });
      await expect.poll(() => f.state.puts.length).toBe(1);
      expect(new Set(f.state.puts.map((p) => p.request_id)).size).toBe(1);
      f.release();
    } finally {
      await f.close();
    }
  });
  await group(
    "4. Header timeout clears password and retains review; late reply cannot toast",
    async () => {
      const f = await fixture({ modes: { [putMode]: [{ holdBefore: true }] } });
      try {
        await submit(f);
        await expect.poll(() => f.state.puts.length).toBe(1);
        await f.page.clock.fastForward(31000);
        await unknown(f);
        f.release();
        await expect(
          f.page
            .getByRole("status")
            .filter({ hasText: "Saved Synthetic colleague edited" }),
        ).toHaveCount(0);
        report.observations.push({
          case: "held headers",
          elapsed_browser_ms: 31000,
          outcome:
            "Bounded wait with no retained password; exact nonsecret review remained. Late receipt did not claim success.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "5. Body timeout can be closed and reopened without replay",
    async () => {
      const f = await fixture({ bodyPath: `/api/v1${editPath}` });
      try {
        await submit(f);
        await expect
          .poll(() => f.page.evaluate(() => window.editFixture.bodyStarted))
          .toBe(true);
        await f.page.clock.fastForward(31000);
        await unknown(f);
        await dialog(f).getByRole("button", { name: "Back to people" }).click();
        await expect(dialog(f)).not.toBeVisible();
        await f.page
          .getByRole("button", { name: "Review access change" })
          .click();
        await unknown(f);
        expect(f.state.puts.length).toBe(1);
        report.observations.push({
          case: "held body",
          outcome:
            "The only password copy was cleared; closing and reopening preserved request review without resubmission.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "6. Lost committed reply resolves from immutable status, without replay",
    async () => {
      const f = await fixture({ modes: { [putMode]: [{ drop: true }] } });
      try {
        await submit(f);
        await unknown(f);
        await dialog(f)
          .getByRole("button", { name: "Check request status" })
          .click();
        await expect(
          dialog(f).getByRole("region", { name: "Applied access change" }),
        ).toBeVisible();
        await dialog(f).getByRole("button", { name: "Finish review" }).click();
        await expect(dialog(f)).not.toBeVisible();
        expect(f.state.puts.length).toBe(1);
        report.observations.push({
          case: "lost committed reply",
          outcome:
            "Exact immutable applied snapshot resolved the request; no second PUT.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "7. Not-found snapshot cannot release a held PUT; cancellation fences it",
    async () => {
      const f = await fixture({
        modes: { [putMode]: [{ holdBeforeCommit: true }] },
      });
      try {
        await submit(f);
        await expect.poll(() => f.state.puts.length).toBe(1);
        await f.page.clock.fastForward(31000);
        await unknown(f);
        await dialog(f)
          .getByRole("button", { name: "Check request status" })
          .click();
        await expect(dialog(f)).toContainText(
          "earlier request may still arrive",
        );
        expect(f.state.puts.length).toBe(1);
        await dialog(f)
          .getByRole("button", { name: "Cancel this request" })
          .click();
        await expect(dialog(f)).toContainText("This request cannot apply now");
        f.release();
        expect(f.state.ledger.get(f.state.puts[0].request_id).status).toBe(
          "cancelled",
        );
        await dialog(f).getByRole("button", { name: "Finish review" }).click();
        report.observations.push({
          case: "noncausal not-found",
          outcome:
            "No second PUT after a negative snapshot; cancellation tombstoned the exact key before the held body could commit.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "8. Wrong-target valid receipt stays unconfirmed until exact status",
    async () => {
      const f = await fixture({
        modes: { [putMode]: [{ transform: (v) => ({ ...v, user: other }) }] },
      });
      try {
        await submit(f);
        await unknown(f);
        await expect(
          f.page
            .getByRole("status")
            .filter({ hasText: "Saved Synthetic unrelated" }),
        ).toHaveCount(0);
        await dialog(f)
          .getByRole("button", { name: "Check request status" })
          .click();
        await expect(
          dialog(f).getByRole("region", { name: "Applied access change" }),
        ).toBeVisible();
        expect(f.state.puts.length).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "9. Former-admin reply cannot claim success after role downgrade",
    async () => {
      const f = await fixture({ modes: { [putMode]: [{ holdBefore: true }] } });
      try {
        await submit(f);
        await expect.poll(() => f.state.puts.length).toBe(1);
        f.state.actor = { ...actor, role: "viewer", revision: 2 };
        await f.page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(
          f.page
            .getByRole("status")
            .filter({ hasText: "An access change may still be in flight" }),
        ).toBeVisible();
        f.release();
        await expect(
          f.page
            .getByRole("status")
            .filter({ hasText: "Saved Synthetic colleague edited" }),
        ).toHaveCount(0);
        report.observations.push({
          case: "authority drift",
          outcome:
            "Role downgrade hid old review authority; late receipt did not trigger a success toast.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "10. Wrong-proposal valid receipt cannot claim the requested edit",
    async () => {
      const f = await fixture({
        modes: {
          [putMode]: [
            {
              transform: (v) => ({
                ...v,
                user: { ...v.user, name: "A different saved name" },
              }),
            },
          ],
        },
      });
      try {
        await submit(f);
        await unknown(f);
        await expect(
          f.page
            .getByRole("status")
            .filter({ hasText: "Saved A different saved name" }),
        ).toHaveCount(0);
        await dialog(f)
          .getByRole("button", { name: "Check request status" })
          .click();
        await expect(
          dialog(f).getByRole("region", { name: "Applied access change" }),
        ).toBeVisible();
        expect(f.state.puts.length).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "11. Wrong applied-status identity cannot resolve a lost edit",
    async () => {
      const f = await fixture({
        modes: {
          [putMode]: [{ drop: true }],
          [getMode]: [{}, { transform: (v) => ({ ...v, user_id: other.id }) }],
        },
      });
      try {
        await submit(f);
        await unknown(f);
        await dialog(f)
          .getByRole("button", { name: "Check request status" })
          .click();
        await expect(dialog(f).getByRole("alert")).toBeVisible();
        await expect(
          dialog(f).getByRole("region", { name: "Applied access change" }),
        ).toHaveCount(0);
        expect(f.state.puts.length).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "12. Stop, X and Escape hide review while keeping its reminder",
    async () => {
      const f = await fixture({ modes: { [putMode]: [{ holdBefore: true }] } });
      try {
        await submit(f);
        await expect(dialog(f)).toHaveAccessibleName(
          "Waiting for access change",
        );
        await dialog(f).getByRole("button", { name: "Stop waiting" }).click();
        await expect(dialog(f)).not.toBeVisible();
        await expect(
          f.page.getByRole("button", { name: "Review access change" }),
        ).toBeVisible();
        await f.page
          .getByRole("button", { name: "Review access change" })
          .click();
        await unknown(f);
        await dialog(f).getByRole("button", { name: "Close dialog" }).click();
        await expect(dialog(f)).not.toBeVisible();
        await f.page
          .getByRole("button", { name: "Review access change" })
          .click();
        await unknown(f);
        await f.page.keyboard.press("Escape");
        await expect(dialog(f)).not.toBeVisible();
        await expect(
          f.page.getByRole("button", { name: "Review access change" }),
        ).toBeVisible();
        f.release();
        await expect(
          f.page
            .getByRole("status")
            .filter({ hasText: "Saved Synthetic colleague edited" }),
        ).toHaveCount(0);
        expect(f.state.puts.length).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "13. Account switch during held edit suppresses the late success",
    async () => {
      const f = await fixture({ modes: { [putMode]: [{ holdBefore: true }] } });
      try {
        await submit(f);
        await expect.poll(() => f.state.puts.length).toBe(1);
        f.state.actor = { ...other, role: "admin" };
        await f.page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(
          f.page.getByRole("alert").filter({ hasText: "Your session ended" }),
        ).toBeVisible();
        f.release();
        await expect(
          f.page
            .getByRole("status")
            .filter({ hasText: "Saved Synthetic colleague edited" }),
        ).toHaveCount(0);
      } finally {
        await f.close();
      }
    },
  );
  await group(
    "14. Confirmed self-demotion signs out without claiming status access",
    async () => {
      const f = await fixture({ selfEdit: true });
      try {
        await prepare(f, actor);
        await dialog(f).getByRole("button", { name: "Role" }).click();
        await f.page.getByRole("menuitemradio", { name: "Viewer" }).click();
        await dialog(f).getByRole("button", { name: "Save access" }).click();
        await expect.poll(() => f.state.puts.length).toBe(1);
        expect(f.state.puts[0].proposal.role).toBe("viewer");
        await expect(
          f.page.getByRole("button", { name: "Sign in", exact: true }).first(),
        ).toBeVisible();
        await expect(
          f.page.getByRole("button", { name: "Review access change" }),
        ).toHaveCount(0);
        report.observations.push({
          case: "self-demotion",
          outcome:
            "Exact receipt confirmed the edit, then the browser left the administrator workspace; no post-demotion status lookup was promised.",
        });
      } finally {
        await f.close();
      }
    },
  );
  await group("15. Narrow review remains readable and axe-clean", async () => {
    for (const { width, theme } of [
      { width: 375, theme: "dark" },
      { width: 375, theme: "light" },
      { width: 899, theme: "light" },
    ]) {
      const f = await fixture({
        width,
        theme,
        modes: { [putMode]: [{ drop: true }] },
      });
      try {
        await submit(f);
        await unknown(f);
        const bounds = await dialog(f).boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(-1);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
        const violations = (
          await new AxeBuilder({ page: f.page }).analyze()
        ).violations.map((v) => ({ id: v.id, impact: v.impact }));
        report.accessibility.push({ width, theme, violations });
        expect(violations).toEqual([]);
        const path = resolve(
          output,
          `access-edit-review-${width}-${theme}.png`,
        );
        await f.page.screenshot({ path });
        report.screenshots.push(relative(root, path));
        report.geometry.push({ width, theme, dialog: bounds });
      } finally {
        await f.close();
      }
    }
  });
  await group(
    "16. Navigation warns before discarding an unresolved request ID",
    async () => {
      const f = await fixture({ modes: { [putMode]: [{ drop: true }] } });
      try {
        await submit(f);
        await unknown(f);
        await dialog(f).getByRole("button", { name: "Back to people" }).click();
        await expect(
          f.page.getByRole("button", { name: "Review access change" }),
        ).toBeVisible();
        const messages = [];
        f.page.once("dialog", async (prompt) => {
          messages.push(prompt.message());
          await prompt.dismiss();
        });
        await f.page.evaluate(() => {
          location.hash = "/overview";
        });
        await expect.poll(() => messages.length).toBe(1);
        expect(messages[0]).toContain("exact ID is only on this page");
        await expect(f.page).toHaveURL(/#\/users$/);
        f.page.once("dialog", async (prompt) => prompt.accept());
        await f.page.evaluate(() => {
          location.hash = "/overview";
        });
        await expect(f.page).toHaveURL(/#\/overview$/);
        expect(f.state.puts.length).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  expect(report.unexpected).toEqual([]);
  expect(report.page_errors).toEqual([]);
  expect(await builtHashes()).toEqual(report.built_files_sha256);
  report.source_end_sha256 = await sourceHashes();
  report.source_changes = sourceFiles.filter(
    (path) => report.source_end_sha256[path] !== sourceStart[path],
  );
  expect(report.source_changes).toEqual([]);
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
    resolve(root, "docs/evidence/access-edit-lifecycle.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    passed: report.passed,
    counts: report.counts,
    output: "docs/evidence/access-edit-lifecycle.json",
  }),
);
if (failure) throw failure;
