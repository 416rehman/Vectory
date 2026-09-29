// Actual App/Deployments/device identity navigation; isolated synthetic API only.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_CANARY_RESUME_OUTPUT || ".local/canary-resume-ui",
);
await mkdir(output, { recursive: true });
const sourceFiles = [
  "dashboard/src/App.tsx",
  "dashboard/src/Deployments.tsx",
  "dashboard/src/deployments.css",
  "dashboard/src/deploymentRouting.ts",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/src/DataTable.tsx",
  "dashboard/tests/canary-resume-browser.mjs",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(resolve(root, p)))
          .digest("hex"),
      ]),
    ),
  );
const loaded = await hashes();
const reservation = net.createServer();
await new Promise((done, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const streams = new Map();
const virtual = "\0virtual:canary-resume";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "canary-resume",
      resolveId(id) {
        if (id === "virtual:canary-resume") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const held = streams.get(req.url);
          if (held) {
            streams.delete(req.url);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write(held.body.slice(0, 5));
            held.fixture.bodyHolds.push(() => res.end(held.body.slice(5)));
            res.on("close", () => {
              if (!res.writableEnded) held.fixture.abortedBodies++;
            });
            return;
          }
          if (req.url?.split("?")[0] !== "/__canary-resume") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic canary resume verification</title></head><body><div id="root"></div><script type="module">import "virtual:canary-resume";</script></body></html>',
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
const message =
  "This rollout overlaps another active canary. Wait for it to finish, or review its pause/cancel controls before resuming.";
const uncertain =
  "The response could not be confirmed. Check the current deployment status before trying this action again.";
const deployment = (n = 100, extra = {}) => ({
  id: id(n),
  name: n === 100 ? "Synthetic paused canary" : "Synthetic active canary",
  configuration_id: id(50),
  configuration_name: "Synthetic logs",
  version_id: id(51),
  version_number: 3,
  policy: null,
  priority: n === 100 ? 100 : 200,
  target_mode: "snapshot",
  status: n === 100 ? "paused" : "active",
  scheduled_at: null,
  created_at: "2026-09-27T00:00:00Z",
  rollout: {
    kind: "canary",
    canary_size: 1,
    batch_size: 1,
    observation_seconds: 60,
    failure_threshold: 0,
  },
  target_count: 2,
  verified_count: 1,
  state_counts: { verified_applied: 1, pending: 1 },
  ...extra,
});
const target = (n, extra = {}) => ({
  device_id: id(n),
  device_name: `Synthetic device ${n}`,
  state: n === 1 ? "verified_applied" : "pending",
  generation: n === 1 ? 1 : 0,
  error: null,
  original: true,
  ...extra,
});
function fixture(extra = {}) {
  return {
    summary: deployment(),
    blocker: deployment(101),
    targets: [target(1), target(2)],
    mode: "blocked",
    summaryMode: "normal",
    calls: [],
    errors: [],
    holds: [],
    bodyHolds: [],
    abortedBodies: 0,
    ...extra,
  };
}
const writes = (f) => f.calls.filter((c) => c.method !== "GET");
const clean = (f) => {
  expect(f.errors).toEqual([]);
  expect(
    writes(f).every(
      (c) => c.method === "POST" && c.path === `/deployments/${id(100)}/resume`,
    ),
  ).toBe(true);
};
async function start(
  f,
  { width = 899, theme = "light", role = "admin", deadline = false } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height: 950 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ({ theme, deadline }) => {
      localStorage.setItem("vectory-theme", theme);
      localStorage.setItem("vectory-sidebar-collapsed", "true");
      if (deadline) {
        const original = window.setTimeout;
        window.setTimeout = function (fn, ms, ...args) {
          return original(fn, ms === 30000 ? 180 : ms, ...args);
        };
      }
    },
    { theme, deadline },
  );
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) {
      f.errors.push("External request " + url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = req.method(),
      query = Object.fromEntries(url.searchParams);
    f.calls.push({
      path,
      method,
      query,
      body: method === "GET" ? null : req.postDataJSON(),
      csrf: req.headers()["x-csrf-token"],
    });
    const respond = (json) => route.fulfill({ json });
    const reject = (code, message, status = 409) =>
      route.fulfill({ status, json: { error: { code, message } } });
    if (method === "POST" && path === `/deployments/${id(100)}/resume`) {
      const mode = f.mode;
      if (mode === "hold") await new Promise((done) => f.holds.push(done));
      if (mode === "blocked" || mode === "hold")
        return reject("ACTIVE_CANARY_OVERLAP", message);
      if (mode === "conflict")
        return reject("CONFLICT", "Synthetic unrelated conflict");
      if (mode === "forbidden")
        return reject("FORBIDDEN", "Synthetic access removed", 403);
      if (mode === "unavailable")
        return reject("UNAVAILABLE", "Synthetic server unavailable", 503);
      if (mode === "malformed")
        return route.fulfill({
          contentType: "application/json",
          body: "{invalid",
        });
      if (mode === "id-only") return respond({ id: id(100) });
      if (mode === "wrong-source")
        return respond({ ...deployment(101), targets: f.targets });
      f.summary = deployment(100, {
        status: mode === "completed" ? "completed" : "active",
        state_counts: { verified_applied: 1, desired: 1 },
      });
      f.targets[1] = target(2, { state: "desired", generation: 1 });
      const result = { ...f.summary, targets: f.targets };
      if (mode === "lost") return route.abort("failed");
      if (mode === "held-body") {
        streams.set(url.pathname + url.search, {
          body: JSON.stringify(result),
          fixture: f,
        });
        return route.continue();
      }
      return respond(result);
    }
    if (method !== "GET") {
      f.errors.push("Unexpected mutation " + method + " " + path);
      return reject("UNEXPECTED", "Unexpected mutation", 500);
    }
    if (path === "/status")
      return respond({ initialized: true, version: "synthetic" });
    if (path === "/session")
      return respond({
        user: {
          id: id(99),
          name: "Synthetic operator",
          email: "fixture@example.test",
          role,
          enabled: true,
          revision: 1,
        },
        csrf_token: "synthetic-csrf",
      });
    if (path === "/deployments/history") {
      const items = [f.summary, f.blocker].filter(
        (d) =>
          !query.status || query.status === "all" || query.status === d.status,
      );
      return respond({ items, total: items.length, page: 1, page_size: 12 });
    }
    if (path === `/deployments/${id(100)}/summary`) {
      const mode = f.summaryMode;
      if (mode === "hold") await new Promise((done) => f.holds.push(done));
      if (mode === "failed")
        return reject("UNAVAILABLE", "Synthetic status unavailable", 503);
      if (mode === "wrong-source") return respond(f.blocker);
      return respond(f.summary);
    }
    if (path === `/deployments/${id(101)}/summary`) return respond(f.blocker);
    if (path.endsWith("/targets"))
      return respond({
        items: f.targets,
        total: f.targets.length,
        page: 1,
        page_size: 12,
      });
    f.errors.push("Unexpected GET " + path);
    return reject("UNEXPECTED", path, 404);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (e) => f.errors.push(e.message));
  await page.goto(origin + "/__canary-resume#/deployments");
  await expect(
    page.getByRole("heading", { name: "Deployments", exact: true }),
  ).toBeVisible();
  return {
    page,
    context,
    close: async () => {
      f.holds.splice(0).forEach((done) => done());
      f.bodyHolds.splice(0).forEach((done) => done());
      await context.close();
    },
  };
}
const details = (page) =>
  page.getByRole("dialog", { name: "Deployment details", exact: true });
const action = (page) =>
  page.getByRole("dialog", { name: "Resume rollout", exact: true });
const submit = (page) =>
  action(page).getByRole("button", { name: "Resume rollout", exact: true });
async function open(page) {
  await page
    .getByRole("link", { name: "Synthetic paused canary", exact: true })
    .click();
  await expect(details(page)).toBeVisible();
}
async function begin(page) {
  await open(page);
  await details(page)
    .getByRole("button", { name: "Resume rollout", exact: true })
    .click();
  await expect(action(page)).toBeVisible();
  await expect(details(page)).toHaveCount(0);
}
async function blocked(page) {
  await begin(page);
  await submit(page).click();
  await expect(action(page)).toContainText(message);
}
async function check(name, run) {
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
}
try {
  await check(
    "Blocked resume preserves the paused source and exact scope; read-only active list opens separately",
    async () => {
      const f = fixture(),
        app = await start(f);
      try {
        const { page, context } = app;
        await blocked(page);
        expect(writes(f)).toHaveLength(1);
        expect(f.summary.status).toBe("paused");
        expect(f.targets[1].generation).toBe(0);
        const link = action(page).getByRole("link", {
          name: "Review active deployments (opens in a new tab)",
          exact: true,
        });
        await expect(link).toHaveAttribute(
          "href",
          "#/deployments?status=active&page=1",
        );
        await expect(link).toHaveAttribute("rel", /noopener/);
        await expect(link).toHaveAttribute("rel", /noreferrer/);
        const popupPromise = context.waitForEvent("page");
        await link.click();
        const popup = await popupPromise;
        await expect(
          popup.getByRole("heading", { name: "Deployments", exact: true }),
        ).toBeVisible();
        await expect(
          popup.getByRole("link", {
            name: "Synthetic active canary",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          popup.getByRole("link", {
            name: "Synthetic paused canary",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(await popup.evaluate(() => window.opener === null)).toBe(true);
        await popup.close();
        await expect(action(page)).toContainText(message);
        expect(writes(f)).toHaveLength(1);
        expect(
          f.calls.some(
            (c) =>
              c.path === "/deployments/history" && c.query.status === "active",
          ),
        ).toBe(true);
        clean(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Explicit retry is separate and accepts a full exact-source terminal receipt",
    async () => {
      const f = fixture(),
        app = await start(f, { role: "operator" });
      try {
        const { page } = app;
        await blocked(page);
        f.mode = "completed";
        await submit(page).focus();
        await page.keyboard.press("Enter");
        await expect(action(page)).toHaveCount(0);
        await expect(details(page)).toBeVisible();
        await expect(details(page)).toContainText("Complete");
        expect(writes(f)).toHaveLength(2);
        expect(
          writes(f).every(
            (c) => c.body === null || JSON.stringify(c.body) === "{}",
          ),
        ).toBe(true);
        expect(writes(f).every((c) => c.csrf === "synthetic-csrf")).toBe(true);
        clean(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Only the typed overlap error offers blocker navigation; generic and authorization rejections preserve scope",
    async () => {
      for (const mode of ["conflict", "forbidden"]) {
        const f = fixture({ mode }),
          app = await start(f);
        try {
          const { page } = app;
          await begin(page);
          await submit(page).click();
          await expect(action(page)).toContainText(
            mode === "conflict"
              ? "Synthetic unrelated conflict"
              : "Synthetic access removed",
          );
          await expect(
            action(page).getByRole("link", {
              name: /Review active deployments/,
            }),
          ).toHaveCount(0);
          expect(writes(f)).toHaveLength(1);
          expect(f.summary.status).toBe("paused");
          clean(f);
        } finally {
          await app.close();
        }
      }
    },
  );
  await check(
    "Uncertain results require successful fresh status; held or failed reads cannot enable another mutation",
    async () => {
      for (const mode of [
        "lost",
        "malformed",
        "unavailable",
        "id-only",
        "wrong-source",
      ]) {
        const f = fixture({ mode }),
          app = await start(f);
        try {
          const { page } = app;
          await begin(page);
          await submit(page).click();
          await expect(action(page)).toContainText(uncertain);
          await expect(submit(page)).toHaveCount(0);
          f.summaryMode = "hold";
          await action(page)
            .getByRole("button", { name: "Check current status", exact: true })
            .click();
          await expect.poll(() => f.holds.length).toBe(1);
          expect(writes(f)).toHaveLength(1);
          const controls = page.getByRole("button", {
            name: /^(Resume rollout|Pause rollout|Cancel rollout|Roll back)$/,
          });
          for (const button of await controls.all())
            await expect(button).toBeDisabled();
          f.holds.shift()();
          await expect
            .poll(
              () => f.calls.filter((c) => c.path.endsWith("/summary")).length,
            )
            .toBeGreaterThanOrEqual(2);
          await expect(action(page)).toHaveCount(0);
          await expect(details(page)).toBeVisible();
          await expect(
            details(page).getByRole("button", {
              name: mode === "lost" ? "Pause rollout" : "Resume rollout",
              exact: true,
            }),
          ).toBeEnabled();
          expect(writes(f)).toHaveLength(1);
          clean(f);
        } finally {
          await app.close();
        }
      }
      const f = fixture({ mode: "lost" }),
        app = await start(f);
      try {
        const { page } = app;
        await begin(page);
        await submit(page).click();
        await expect(action(page)).toContainText(uncertain);
        f.summaryMode = "failed";
        await action(page)
          .getByRole("button", { name: "Check current status", exact: true })
          .click();
        await expect(
          page.getByText("Synthetic status unavailable", { exact: true }),
        ).toBeVisible();
        expect(writes(f)).toHaveLength(1);
        await expect(
          page.getByRole("button", { name: "Resume rollout", exact: true }),
        ).toHaveCount(0);
        f.summaryMode = "wrong-source";
        await page
          .getByRole("button", { name: "Check current status", exact: true })
          .click();
        await expect(details(page)).toContainText(
          "The current status could not be confirmed for this deployment.",
        );
        for (const button of await details(page)
          .getByRole("button", {
            name: /^(Resume rollout|Pause rollout|Cancel rollout|Roll back)$/,
          })
          .all())
          await expect(button).toBeDisabled();
        expect(writes(f)).toHaveLength(1);
        f.summaryMode = "normal";
        await page
          .getByRole("button", { name: "Check current status", exact: true })
          .click();
        await expect(action(page)).toHaveCount(0);
        await expect(
          details(page).getByRole("button", {
            name: "Pause rollout",
            exact: true,
          }),
        ).toBeEnabled();
        clean(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Busy action resists dismissal and duplicate submission; a held response body reaches bounded uncertainty",
    async () => {
      const f = fixture({ mode: "hold" }),
        app = await start(f);
      try {
        const { page } = app;
        await begin(page);
        await submit(page).click();
        await expect.poll(() => f.holds.length).toBe(1);
        await expect(
          action(page).locator(".modal-footer button").last(),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(action(page)).toBeVisible();
        expect(
          await page.evaluate(
            () =>
              !window.dispatchEvent(
                new Event("vectory:before-navigate", { cancelable: true }),
              ),
          ),
        ).toBe(true);
        expect(writes(f)).toHaveLength(1);
        f.holds.shift()();
        await expect(action(page)).toContainText(message);
        clean(f);
      } finally {
        await app.close();
      }
      const d = fixture({ mode: "held-body" }),
        timed = await start(d, { deadline: true });
      try {
        const { page } = timed;
        await begin(page);
        await submit(page).click();
        await expect(action(page)).toContainText(uncertain);
        await expect.poll(() => d.abortedBodies).toBe(1);
        expect(writes(d)).toHaveLength(1);
        await action(page)
          .getByRole("button", { name: "Check current status", exact: true })
          .click();
        await expect(
          details(page).getByRole("button", {
            name: "Pause rollout",
            exact: true,
          }),
        ).toBeEnabled();
        expect(writes(d)).toHaveLength(1);
        clean(d);
      } finally {
        await timed.close();
      }
    },
  );
  await check(
    "Role restrictions and keyboard cancellation retain usable detail focus without writes",
    async () => {
      for (const role of ["viewer", "editor"]) {
        const f = fixture(),
          app = await start(f, { role });
        try {
          await open(app.page);
          await expect(
            details(app.page).getByRole("button", {
              name: "Resume rollout",
              exact: true,
            }),
          ).toHaveCount(0);
          expect(writes(f)).toHaveLength(0);
          clean(f);
        } finally {
          await app.close();
        }
      }
      const f = fixture(),
        app = await start(f);
      try {
        await open(app.page);
        await details(app.page)
          .getByRole("textbox", { name: "Search deployment devices" })
          .fill("device 2");
        await expect
          .poll(() =>
            f.calls.some(
              (c) =>
                c.path.endsWith("/targets") && c.query.search === "device 2",
            ),
          )
          .toBe(true);
        await details(app.page)
          .getByRole("button", { name: "Resume rollout", exact: true })
          .click();
        await expect(action(app.page)).toBeVisible();
        await app.page.keyboard.press("Escape");
        await expect(action(app.page)).toHaveCount(0);
        await expect(details(app.page)).toBeVisible();
        await expect(
          details(app.page).getByRole("textbox", {
            name: "Search deployment devices",
          }),
        ).toHaveValue("device 2");
        await expect
          .poll(() =>
            details(app.page).evaluate((el) =>
              el.contains(document.activeElement),
            ),
          )
          .toBe(true);
        expect(writes(f)).toHaveLength(0);
        clean(f);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    "Blocked resume stays contained and accessible in desktop/mobile light and dark",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          const f = fixture(),
            app = await start(f, { width, theme });
          try {
            const { page } = app;
            await blocked(page);
            await expect(page.getByRole("dialog")).toHaveCount(1);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const box = await action(page).boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
            await expect(
              action(page).getByRole("button", {
                name: "Keep current state",
                exact: true,
              }),
            ).toBeInViewport();
            await expect(submit(page)).toBeInViewport();
            const axe = await new AxeBuilder({ page }).analyze();
            accessibility.push({
              width,
              theme,
              violations: axe.violations.map((v) => ({
                id: v.id,
                impact: v.impact,
                nodes: v.nodes.map((n) => n.target),
              })),
            });
            expect(axe.violations).toEqual([]);
            const file = `canary-resume-${width}-${theme}.png`;
            await page.screenshot({ path: resolve(output, file) });
            screenshots.push(file);
            clean(f);
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
      "Actual App/DeploymentInspector with isolated intercepted synthetic HTTP. No live writes or native rollout behavior inferred. Deadline fixture accelerates only the exact 30000ms timeout to 180ms and holds an actual HTTP response body.",
    passed:
      results.length === 7 &&
      results.every((r) => r.passed) &&
      accessibility.length === 4 &&
      accessibility.every((s) => !s.violations.length),
    results,
    accessibility,
    screenshots,
    loaded_source_sha256: loaded,
    current_source_sha256: current,
    source_changed_during_run: Object.keys(current).filter(
      (p) => current[p] !== loaded[p],
    ),
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (!report.passed) process.exitCode = 1;
}
