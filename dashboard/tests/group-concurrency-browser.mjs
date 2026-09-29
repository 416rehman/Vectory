// Actual Groups/GroupEditor UI, intercepted synthetic transport only.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_GROUP_CONCURRENCY_OUTPUT || ".local/group-concurrency",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/GroupEditor.tsx",
  "dashboard/src/GroupRecovery.tsx",
  "dashboard/src/groupRequests.ts",
  "dashboard/src/group-recovery.css",
  "dashboard/src/group-editor.css",
  "dashboard/src/Fleet.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/tests/group-concurrency-browser.mjs",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(root, file)))
          .digest("hex"),
      ]),
    ),
  );
const loadedSource = await hashes();
const virtual = "\0virtual:group-concurrency";
const reservation = net.createServer();
await new Promise((done, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "group-concurrency",
      resolveId(id) {
        if (id === "virtual:group-concurrency") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return [
          "import React,{useState} from 'react';import{createRoot}from'react-dom/client';",
          "import{Groups}from'/src/Fleet.tsx';import{setCSRF}from'/src/api.ts';import'/src/styles.css';",
          "setCSRF('synthetic-csrf');",
          "function Fixture(){const[user,setUser]=useState(window.testUser);window.fixture.setUser=setUser;",
          "return React.createElement(Groups,{user,notify:message=>window.fixture.notices.push({message,actor:user.id})});}",
          "createRoot(document.getElementById('root')).render(React.createElement(Fixture));",
        ].join("\n");
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__group-concurrency") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic group concurrency verification</title></head><body><main id="main-content" tabindex="-1" style="padding:20px"><div id="root"></div></main><script type="module">import "virtual:group-concurrency";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = "http://127.0.0.1:" + port;
const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const actor = (role = "operator", n = 90) => ({
  id: id(n),
  role,
  name: "Synthetic " + role,
  email: role + "@example.test",
  enabled: true,
  revision: 1,
});
const group = (revision = 1) => ({
  id: id(10),
  name: "Synthetic production group",
  description: "Original description",
  device_ids: [id(1)],
  revision,
  created_at: "2026-09-27T00:00:00Z",
});
const device = (n, name = "Synthetic edge " + n) => ({
  id: id(n),
  name,
  os: "windows",
  arch: "amd64",
  status: "verified",
  apply_state: "verified_applied",
  desired_generation: 1,
  reported_generation: 1,
  labels: {},
  last_seen: "2026-09-27T00:00:00Z",
});
function fixture(initial = group()) {
  return {
    groups: new Map(initial ? [[initial.id, structuredClone(initial)]] : []),
    devices: [device(1), device(2), device(3)],
    requests: [],
    writes: [],
    commits: 0,
    releases: [],
    nextError: null,
    replyMode: null,
    detailError: null,
    holdWrite: false,
    errors: [],
  };
}
const browser = await chromium.launch();
const results = [],
  scans = [],
  screenshots = [];
async function start(f, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 899, height: 900 },
    reducedMotion: "reduce",
    colorScheme: options.theme || "light",
  });
  await context.addInitScript(() => {
    const nativeTimeout = window.setTimeout.bind(window),
      nativeClear = window.clearTimeout.bind(window);
    const deadlines = new Map();
    let sequence = 900000;
    window.fixture = {
      notices: [],
      confirmations: [],
      confirmResult: false,
      holdBodyPath: "",
      heldBodies: [],
    };
    window.confirm = (message) => {
      fixture.confirmations.push(message);
      return fixture.confirmResult;
    };
    window.setTimeout = (callback, ms, ...args) => {
      if (ms !== 30000) return nativeTimeout(callback, ms, ...args);
      const id = ++sequence;
      deadlines.set(id, () => callback(...args));
      return id;
    };
    window.clearTimeout = (id) => {
      if (!deadlines.delete(id)) nativeClear(id);
    };
    fixture.expire = () => {
      for (const [id, callback] of [...deadlines]) {
        deadlines.delete(id);
        callback();
      }
    };
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (
        fixture.holdBodyPath &&
        String(args[0]).split("?")[0] === fixture.holdBodyPath
      )
        return {
          ok: response.ok,
          status: response.status,
          text: () =>
            new Promise((resolve) =>
              fixture.heldBodies.push(() =>
                response.text().then(resolve, () => resolve("")),
              ),
            ),
        };
      return response;
    };
  });
  const reject = (route, status, code, message) =>
    route.fulfill({ status, json: { error: { code, message } } });
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      f.errors.push("External request: " + url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = request.method();
    f.requests.push({ path, method });
    if (method === "GET" && path === "/devices")
      return route.fulfill({ json: f.devices });
    // The group overview lists assignments; member edits preview their effects.
    if (method === "GET" && path === "/deployments/history")
      return route.fulfill({
        json: { items: [], total: 0, page: 1, page_size: 12 },
      });
    if (method === "POST" && path === "/groups/membership-preview") {
      const body = request.postDataJSON();
      return route.fulfill({
        json: {
          group_id: body.group_id,
          revision: body.revision,
          stale: false,
          ready: true,
          blockers: [],
          devices: [],
        },
      });
    }
    if (method === "GET" && path === "/groups")
      return route.fulfill({ json: [...f.groups.values()] });
    if (method === "GET" && path.startsWith("/groups/requests/")) {
      const requestId = path.split("/").pop();
      const saved = [...f.groups.values()].find(
        (group) => group.request_id === requestId,
      );
      return route.fulfill({
        json: saved
          ? { request_id: requestId, found: true, group: saved }
          : { request_id: requestId, found: false },
      });
    }
    if (method === "GET" && path.startsWith("/groups/")) {
      if (f.detailError)
        return reject(
          route,
          f.detailError,
          f.detailError === 404 ? "NOT_FOUND" : "UNAVAILABLE",
          "Synthetic review read failed",
        );
      const current = f.groups.get(path.slice(8));
      return current
        ? route.fulfill({ json: current })
        : reject(route, 404, "NOT_FOUND", "Group unavailable");
    }
    if (
      (method === "PUT" && path.startsWith("/groups/")) ||
      (method === "POST" && path === "/groups")
    ) {
      const body = request.postDataJSON();
      f.writes.push({ method, path, body: structuredClone(body) });
      if (f.nextError) {
        const next = f.nextError;
        f.nextError = null;
        return reject(route, ...next);
      }
      const old = method === "PUT" ? f.groups.get(path.slice(8)) : null;
      if (method === "PUT" && !old)
        return reject(route, 404, "NOT_FOUND", "Group unavailable");
      if (old && body.revision !== old.revision)
        return reject(
          route,
          409,
          "STALE_REVISION",
          "Group changed; review it before saving",
        );
      let saved = {
        ...body,
        id: old?.id || id(100 + f.commits),
        revision: old ? old.revision + 1 : 1,
        created_at: old?.created_at || "2026-09-27T00:00:00Z",
      };
      f.groups.set(saved.id, structuredClone(saved));
      f.commits++;
      if (f.holdWrite) await new Promise((resolve) => f.releases.push(resolve));
      const mode = f.replyMode;
      f.replyMode = null;
      if (mode === "drop") return route.abort("failed");
      if (mode === "invalid")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{",
        });
      if (mode === "wrong-id") saved = { ...saved, id: id(999) };
      if (mode === "wrong-revision")
        saved = { ...saved, revision: old?.revision ?? 0 };
      try {
        return await route.fulfill({ json: saved });
      } catch {
        return;
      }
    }
    f.errors.push("Unexpected " + method + " " + path);
    return reject(route, 500, "UNEXPECTED_FIXTURE_REQUEST", path);
  });
  async function page(user = actor()) {
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on("pageerror", (error) => f.errors.push(error.message));
    await page.addInitScript(
      ({ user }) => {
        window.testUser = user;
      },
      { user },
    );
    await page.goto(origin + "/__group-concurrency");
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, options.theme || "light");
    await expect(
      page.getByRole("heading", { name: "Groups", exact: true }),
    ).toBeVisible();
    return page;
  }
  return {
    context,
    page,
    close: async () => {
      for (const release of f.releases) release();
      await context.close();
    },
  };
}
async function edit(page) {
  await page
    .getByRole("button", { name: /Synthetic production group/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("tab", { name: /^(Edit members|Members)$/ })
    .click();
}
const save = (page) =>
  page.getByRole("button", { name: "Save changes", exact: true }).click();
const review = (page) =>
  page.getByRole("region", { name: "Review group changes" });
const notices = (page) => page.evaluate(() => fixture.notices);
async function changeDescription(page, value = "My local description") {
  await page
    .getByRole("textbox", { name: "Description (optional)", exact: true })
    .fill(value);
}
async function check(name, run) {
  const started = Date.now();
  try {
    await run();
    results.push({ name, passed: true, duration_ms: Date.now() - started });
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: error.message,
      duration_ms: Date.now() - started,
    });
  }
  console.log((results.at(-1).passed ? "PASS " : "FAIL ") + name);
}

try {
  await check(
    "Stale two-tab edit preserves local text and requires reviewed revision plus a distinct save",
    async () => {
      const f = fixture(),
        app = await start(f);
      try {
        const first = await app.page(),
          second = await app.page();
        await edit(first);
        await edit(second);
        await first.getByRole("checkbox", { name: /Synthetic edge 2/ }).check();
        await save(first);
        await expect(first.getByRole("dialog")).toHaveCount(0);
        await changeDescription(second);
        await save(second);
        await expect(review(second)).toContainText("This group changed");
        await expect(review(second)).toContainText(
          "Your edits would remove 1 device",
        );
        await expect(review(second)).toContainText("Synthetic edge 2");
        await expect(
          second.getByRole("textbox", { name: "Description (optional)" }),
        ).toHaveValue("My local description");
        expect(f.commits).toBe(1);
        expect(f.writes.at(-1).body.revision).toBe(1);
        await review(second)
          .getByRole("button", { name: "Use latest members" })
          .click();
        await review(second)
          .getByRole("button", { name: "Continue editing" })
          .click();
        await expect(
          second.getByRole("textbox", { name: "Group name" }),
        ).toBeFocused();
        expect(f.writes).toHaveLength(2);
        await expect(
          second.getByRole("checkbox", { name: /Synthetic edge 2/ }),
        ).toBeChecked();
        await save(second);
        await expect(second.getByRole("dialog")).toHaveCount(0);
        expect(f.writes.at(-1).body).toMatchObject({
          revision: 2,
          device_ids: [id(1), id(2)],
          description: "My local description",
        });
        expect(f.groups.get(id(10)).revision).toBe(3);
        expect(f.commits).toBe(2);
        expect(f.errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Explicitly reviewed removals remain local; another concurrent save causes a second conflict",
    async () => {
      const f = fixture(),
        app = await start(f);
      try {
        const page = await app.page();
        await edit(page);
        await changeDescription(page);
        f.groups.set(id(10), {
          ...f.groups.get(id(10)),
          revision: 2,
          device_ids: [id(1), id(2)],
          name: "Peer renamed group",
          description: "Peer description",
        });
        await save(page);
        await expect(review(page)).toContainText("Peer renamed group");
        await review(page)
          .getByRole("button", { name: "Use latest name" })
          .click();
        await expect(
          page.getByRole("textbox", { name: "Group name" }),
        ).toHaveValue("Peer renamed group");
        await review(page)
          .getByRole("button", { name: "Continue editing" })
          .click();
        expect(f.commits).toBe(0);
        expect(f.writes).toHaveLength(1);
        f.groups.set(id(10), {
          ...f.groups.get(id(10)),
          revision: 3,
          device_ids: [id(1), id(2), id(3)],
        });
        await save(page);
        await expect(review(page)).toContainText(
          "Your edits would remove 2 devices",
        );
        expect(f.writes.at(-1).body.revision).toBe(2);
        expect(f.commits).toBe(0);
        await expect(
          page.getByRole("textbox", { name: "Description (optional)" }),
        ).toHaveValue("My local description");
        expect(await notices(page)).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Unavailable membership stays exact; a replacement device is not substituted",
    async () => {
      const initial = { ...group(), device_ids: [id(1), id(77)] };
      const f = fixture(initial);
      f.devices = [device(1), device(3, "Synthetic replacement")];
      const app = await start(f);
      try {
        const page = await app.page();
        await edit(page);
        await changeDescription(page);
        await expect(
          page.getByRole("checkbox", { name: new RegExp(id(77)) }),
        ).toBeChecked();
        f.groups.set(id(10), { ...initial, revision: 2, device_ids: [id(1)] });
        await save(page);
        await expect(review(page)).toContainText(id(77));
        await expect(review(page)).toContainText(
          "Your edits would add 1 device",
        );
        await expect(
          page.getByRole("checkbox", { name: /Synthetic replacement/ }),
        ).not.toBeChecked();
        await review(page)
          .getByRole("button", { name: "Use latest members" })
          .click();
        await review(page)
          .getByRole("button", { name: "Continue editing" })
          .click();
        await save(page);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(f.writes.at(-1).body.device_ids).toEqual([id(1)]);
        expect(f.errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Definite conflict differs from stale review; failed or missing review reads preserve edits",
    async () => {
      const f = fixture(),
        app = await start(f);
      try {
        const page = await app.page();
        await edit(page);
        await changeDescription(page);
        f.nextError = [409, "CONFLICT", "Assignments conflict"];
        await save(page);
        await expect(page.getByRole("alert")).toContainText(
          "Assignments conflict",
        );
        expect(
          f.requests.filter(
            (r) => r.path === "/groups/" + id(10) && r.method === "GET",
          ),
        ).toHaveLength(0);
        f.groups.set(id(10), { ...f.groups.get(id(10)), revision: 2 });
        f.detailError = 503;
        await save(page);
        await expect(review(page)).toContainText(
          "Synthetic review read failed",
        );
        await expect(
          page.getByRole("textbox", { name: "Description (optional)" }),
        ).toHaveValue("My local description");
        await expect(
          page.getByRole("button", { name: "Save changes" }),
        ).toBeDisabled();
        f.detailError = null;
        await page.evaluate(
          (path) => {
            fixture.holdBodyPath = path;
          },
          "/api/v1/groups/" + id(10),
        );
        await review(page)
          .getByRole("button", { name: "Review saved group" })
          .click();
        await expect
          .poll(() => page.evaluate(() => fixture.heldBodies.length))
          .toBe(1);
        await page.evaluate(() => fixture.expire());
        await expect(review(page)).toContainText("taking too long");
        await expect(
          page.getByRole("button", { name: "Save changes" }),
        ).toBeDisabled();
        await page.evaluate(() => {
          fixture.holdBodyPath = "";
          for (const finish of fixture.heldBodies) finish();
        });
        await expect(
          review(page).getByRole("button", { name: "Continue editing" }),
        ).toHaveCount(0);
        f.detailError = 404;
        await review(page)
          .getByRole("button", { name: "Review saved group" })
          .click();
        await expect(review(page)).toContainText("no longer available");
        await expect(
          page.getByRole("button", { name: "Save changes" }),
        ).toBeDisabled();
        expect(f.commits).toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Lost, unreadable or wrong-identity PUT receipts never automatically resend or claim success",
    async () => {
      for (const mode of ["drop", "invalid", "wrong-id", "wrong-revision"]) {
        const f = fixture(),
          app = await start(f);
        try {
          const page = await app.page();
          await edit(page);
          await changeDescription(page);
          f.replyMode = mode;
          await save(page);
          await expect(review(page)).toContainText(
            "Save could not be confirmed",
          );
          await expect(
            page.getByRole("button", { name: "Save changes" }),
          ).toBeDisabled();
          expect(f.commits).toBe(1);
          expect(f.writes).toHaveLength(1);
          expect(await notices(page)).toEqual([]);
          await review(page)
            .getByRole("button", { name: "Review saved group" })
            .click();
          await expect(review(page)).toContainText("Your selection matches");
          expect(f.writes).toHaveLength(1);
          expect(await notices(page)).toEqual([]);
          await review(page)
            .getByRole("button", { name: "Continue editing" })
            .click();
          await expect(
            page.getByRole("button", { name: "Save changes" }),
          ).toBeDisabled();
          expect(f.errors).toEqual([]);
        } finally {
          await app.close();
        }
      }
    },
  );

  await check(
    "Ambiguous keyed create requires exact request review, without duplicate POST or name-based receipt",
    async () => {
      const f = fixture(null),
        app = await start(f);
      try {
        const page = await app.page();
        await page
          .getByRole("button", { name: "Create group", exact: true })
          .first()
          .click();
        await page
          .getByRole("textbox", { name: "Group name" })
          .fill("Synthetic new group");
        f.replyMode = "drop";
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Create group", exact: true })
          .click();
        await expect(review(page)).toContainText("Save could not be confirmed");
        await expect(
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Create group", exact: true }),
        ).toBeDisabled();
        expect(f.commits).toBe(1);
        expect(f.writes).toHaveLength(1);
        expect(await notices(page)).toEqual([]);
        await review(page)
          .getByRole("button", { name: "Close and review request" })
          .click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page
          .getByRole("button", { name: "Review group requests", exact: true })
          .click();
        await page.locator(".group-recovery-list > button").first().click();
        await expect(
          page.getByRole("dialog", { name: "Group confirmed", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("dialog")).toContainText(
          "Synthetic new group",
        );
        expect(f.writes).toHaveLength(1);
        expect(f.errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );

  await check(
    "Held writes guard dismissal/navigation; deadlines cover bodies and stale actor results",
    async () => {
      const f = fixture(),
        app = await start(f);
      try {
        const page = await app.page();
        await edit(page);
        await changeDescription(page);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toBeVisible();
        expect(await page.evaluate(() => fixture.confirmations)).toEqual([
          "Discard your unsaved group edits?",
        ]);
        await page.evaluate(
          (path) => {
            fixture.holdBodyPath = path;
          },
          "/api/v1/groups/" + id(10),
        );
        await save(page);
        await expect
          .poll(() => page.evaluate(() => fixture.heldBodies.length))
          .toBe(1);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toBeVisible();
        expect(
          await page.evaluate(() =>
            window.dispatchEvent(
              new Event("vectory:before-navigate", { cancelable: true }),
            ),
          ),
        ).toBe(false);
        await expect(
          page.getByRole("button", { name: "Cancel", exact: true }),
        ).toBeDisabled();
        await page.evaluate(() => fixture.expire());
        await expect(review(page)).toContainText("Save could not be confirmed");
        await page.evaluate(() => {
          fixture.holdBodyPath = "";
          for (const finish of fixture.heldBodies) finish();
        });
        await expect(review(page)).toBeVisible();
        expect(await notices(page)).toEqual([]);
        expect(f.writes).toHaveLength(1);
        await page.evaluate(
          (user) => fixture.setUser(user),
          actor("operator", 91),
        );
        // A new actor starts over from the group's overview.
        await expect(review(page)).toHaveCount(0);
        // The session settles in more than one step; each step remounts.
        await expect(async () => {
          await page
            .getByRole("tab", { name: "Edit members", exact: true })
            .click({ timeout: 2000 });
          await expect(
            page.getByRole("textbox", { name: "Description (optional)" }),
          ).toHaveValue("Original description", { timeout: 1000 });
        }).toPass();
        expect(f.writes).toHaveLength(1);
        expect(f.errors).toEqual([]);
      } finally {
        await app.close();
      }
      const pending = fixture(),
        next = await start(pending);
      try {
        const page = await next.page();
        await edit(page);
        await changeDescription(page, "Old actor private draft");
        pending.holdWrite = true;
        await save(page);
        await expect.poll(() => pending.releases.length).toBe(1);
        await page.evaluate(
          (user) => fixture.setUser(user),
          actor("viewer", 91),
        );
        // A viewer starts on the overview and reads members on their tab.
        await expect(async () => {
          await page
            .getByRole("tab", { name: "Members", exact: true })
            .click({ timeout: 2000 });
          await expect(
            page.getByRole("textbox", { name: "Description (optional)" }),
          ).toHaveValue("Original description", { timeout: 1000 });
        }).toPass();
        for (const release of pending.releases) release();
        await expect(
          page.getByRole("button", { name: "Save changes" }),
        ).toHaveCount(0);
        expect(await notices(page)).toEqual([]);
        expect(pending.writes).toHaveLength(1);
        expect(pending.errors).toEqual([]);
      } finally {
        await next.close();
      }
    },
  );

  await check(
    "Read permissions, legacy missing revision and normalized zero revision fail safely",
    async () => {
      for (const role of ["viewer", "editor"]) {
        const f = fixture(),
          app = await start(f);
        try {
          const page = await app.page(actor(role));
          await edit(page);
          await expect(
            page.getByRole("textbox", { name: "Group name" }),
          ).toHaveAttribute("readonly", "");
          await expect(
            page.getByRole("button", { name: "Save changes" }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("checkbox", { name: /Synthetic edge 1/ }),
          ).toBeDisabled();
          expect(f.writes).toHaveLength(0);
        } finally {
          await app.close();
        }
      }
      const legacy = group();
      delete legacy.revision;
      const f = fixture(legacy),
        app = await start(f);
      try {
        const page = await app.page();
        await edit(page);
        await expect(page.getByRole("alert")).toContainText(
          "Update the server",
        );
        await expect(
          page.getByRole("button", { name: "Save changes" }),
        ).toBeDisabled();
        expect(f.writes).toHaveLength(0);
      } finally {
        await app.close();
      }
      const zero = fixture(group(0)),
        normalized = await start(zero);
      try {
        const page = await normalized.page(actor("admin"));
        await edit(page);
        await changeDescription(page);
        await save(page);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(zero.writes[0].body.revision).toBe(0);
        expect(zero.groups.get(id(10)).revision).toBe(1);
      } finally {
        await normalized.close();
      }
    },
  );

  await check(
    "Reviewed membership remains usable with search, keyboard focus and responsive light/dark layouts",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          const f = fixture(),
            app = await start(f, { viewport: { width, height: 900 }, theme });
          try {
            const page = await app.page();
            await edit(page);
            await changeDescription(page);
            f.groups.set(id(10), {
              ...f.groups.get(id(10)),
              revision: 2,
              device_ids: [id(1), id(2)],
              description:
                "A peer saved a longer description for this explicitly synthetic production group.",
            });
            await save(page);
            await expect(review(page)).toContainText(
              "Your edits would remove 1 device",
            );
            await expect(review(page)).toBeFocused();
            const header = await page
              .locator(".group-editor-modal .modal-header")
              .boundingBox();
            expect(header.y).toBeGreaterThanOrEqual(0);
            expect(header.y + header.height).toBeLessThan(900);
            await expect(
              page.getByRole("button", { name: "Close dialog", exact: true }),
            ).toBeInViewport();
            await page
              .getByRole("textbox", { name: "Find a device", exact: true })
              .fill("edge 3");
            await expect(
              page.getByRole("checkbox", { name: /Synthetic edge 3/ }),
            ).not.toBeChecked();
            await expect(
              page.getByRole("checkbox", { name: /Synthetic edge 1/ }),
            ).toHaveCount(0);
            expect(f.writes).toHaveLength(1);
            expect(f.commits).toBe(0);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const dialog = await page.getByRole("dialog").boundingBox();
            expect(dialog.x).toBeGreaterThanOrEqual(0);
            expect(dialog.x + dialog.width).toBeLessThanOrEqual(width + 1);
            const result = await new AxeBuilder({ page }).analyze();
            scans.push({
              width,
              theme,
              violations: result.violations.map((v) => ({
                id: v.id,
                impact: v.impact,
                nodes: v.nodes.map((n) => n.target),
              })),
            });
            expect(result.violations).toEqual([]);
            const filename = "group-review-" + width + "-" + theme + ".png";
            await page
              .locator(".group-editor-form > .modal-body")
              .evaluate((body) => {
                body.scrollTop = 0;
              });
            await page.screenshot({ path: resolve(output, filename) });
            screenshots.push(filename);
            expect(f.errors).toEqual([]);
          } finally {
            await app.close();
          }
        }
    },
  );
} finally {
  await browser.close();
  await server.close();
  const current = await hashes();
  const report = {
    recorded_at: new Date().toISOString(),
    scope:
      "Actual Groups/GroupEditor components in Chromium, synthetic shared API transport with fault injection and controlled 30-second deadlines. Does not execute server authorization, database reconciliation, real assignments, or live preview writes.",
    passed:
      results.length === 9 &&
      results.every((r) => r.passed) &&
      scans.length === 4 &&
      scans.every((s) => !s.violations.length),
    results,
    accessibility: scans,
    screenshots,
    loaded_source_sha256: loadedSource,
    current_source_sha256: current,
    source_changed_during_run: Object.keys(current).filter(
      (file) => current[file] !== loadedSource[file],
    ),
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (!report.passed) process.exitCode = 1;
}
