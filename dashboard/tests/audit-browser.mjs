// Actual AuditLog and App navigation; all HTTP records below are isolated synthetic fixtures.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Any free port: parallel runs never collide.
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_AUDIT_COMPONENT_OUTPUT || ".local/audit-component",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:audit-fixture";
const nativeFiles = new Map();
const nativeDownloads = [];
const server = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {},
    hmr: false,
  },
  plugins: [
    {
      name: "synthetic-audit-fixture",
      resolveId(id) {
        if (id === "virtual:audit-fixture") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `import React from 'react';import{createRoot}from'react-dom/client';import AuditLog from '/src/AuditLog.tsx';import App from '/src/App.tsx';import{setCSRF}from'/src/api.ts';import '/src/styles.css';const root=createRoot(document.getElementById('root'));let key=0;window.renderAudit=(props={})=>{setCSRF('synthetic-csrf');root.render(React.createElement(AuditLog,{key:++key,...props}));};if(location.pathname.endsWith('-app'))root.render(React.createElement(App));window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (nativeFiles.has(req.url)) {
            const body = nativeFiles.get(req.url);
            nativeDownloads.push({ path: req.url, method: req.method });
            res.setHeader("Content-Type", "application/x-ndjson");
            res.setHeader(
              "Content-Disposition",
              'attachment; filename="synthetic-audit.jsonl"',
            );
            res.setHeader("Content-Length", Buffer.byteLength(body));
            res.end(body);
            return;
          }
          if (
            !["/__audit-fixture", "/__audit-app"].includes(
              req.url?.split("?")[0],
            )
          )
            return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic audit verification</title></head><body><main id="fixture-main" style="padding:24px"><div id="root"></div></main><script type="module">import "virtual:audit-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch();
const results = [],
  errors = [],
  requests = [],
  unexpected = [],
  accessibility = [];
const origin = `http://127.0.0.1:${port}`;
const id = (number) =>
  `abcdefab-1234-4000-8000-${String(number).padStart(12, "0")}`;
const user = {
  id: id(900),
  name: "Synthetic reviewer",
  email: "audit@example.test",
  role: "viewer",
  enabled: true,
  revision: 1,
};
const event = (number) => ({
  id: id(number),
  actor_id: id(900),
  actor: "Synthetic reviewer",
  actor_kind: "user",
  action: number % 2 ? "configuration.publish" : "issue.acknowledge",
  target: id(number + 100),
  target_id: id(number + 100),
  target_kind: number % 2 ? "configuration" : "issue",
  target_name: `Synthetic ${number < 25 ? "Alpha" : "Beta"} ${number}`,
  device_id: id(number % 2 ? 800 : 801),
  // The server names a device by its current name; a device that no longer
  // exists has none.
  device_name: number % 2 ? "Synthetic edge 800" : null,
  outcome: number % 7 ? "success" : "denied",
  created_at: "2026-09-26T12:00:00Z",
  request_id: `synthetic-request-${number}`,
});
async function fixture({ app = false, route = "audit", signedIn = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    acceptDownloads: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  const state = {
    records: Array.from({ length: 49 }, (_, index) => event(index + 1)),
    heldSearch: "",
    heldId: "",
    heldExport: false,
    failHistory: false,
    failDetail: "",
    failExport: false,
    held: [],
    exports: [],
    signedIn,
    calls: [],
  };
  state.records[0].created_at = null;
  async function respond(route, json, status = 200) {
    try {
      await route.fulfill({ status, json });
    } catch {}
  }
  await context.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.replace("/api/v1", ""),
      method = req.method();
    const call = {
      path,
      method,
      query: Object.fromEntries(url.searchParams),
      body: req.postData() ? req.postDataJSON() : null,
      resourceType: req.resourceType(),
    };
    requests.push(call);
    state.calls.push(call);
    if (path === "/session")
      return state.signedIn
        ? respond(route, { user, csrf_token: "synthetic-csrf" })
        : respond(
            route,
            { error: { code: "UNAUTHENTICATED", message: "Sign in required" } },
            401,
          );
    if (path === "/status")
      return respond(route, { initialized: true, version: "synthetic" });
    if (path === "/login") {
      state.signedIn = true;
      return respond(route, { user, csrf_token: "synthetic-csrf" });
    }
    if (path === "/logout") {
      state.signedIn = false;
      return respond(route, { ok: true });
    }
    if (path === "/settings")
      return respond(route, { instance_name: "Synthetic test workspace" });
    if (path === "/audit/exports" && method === "GET")
      return respond(
        route,
        state.exports
          .filter((file) => !file.discarded)
          .map(({ discarded, ...file }) => file),
      );
    if (path === "/audit/history") {
      expect(method).toBe("GET");
      expect(url.searchParams.get("page_size")).toBe("12");
      if (state.failHistory)
        return respond(
          route,
          {
            error: {
              code: "TEST_FAILURE",
              message: "Synthetic history unavailable",
            },
          },
          503,
        );
      let items = state.records.filter((item) =>
        `${item.actor} ${item.action} ${item.target_name}`
          .toLowerCase()
          .includes((url.searchParams.get("search") || "").toLowerCase()),
      );
      for (const key of [
        "action",
        "outcome",
        "actor_id",
        "device_id",
        "target_id",
      ])
        if (url.searchParams.has(key))
          items = items.filter(
            (item) => item[key] === url.searchParams.get(key),
          );
      if (url.searchParams.has("family"))
        items = items.filter((item) =>
          item.action.startsWith(url.searchParams.get("family") + "."),
        );
      const sort = url.searchParams.get("sort");
      if (sort) {
        const direction = url.searchParams.get("direction") === "asc" ? 1 : -1;
        items.sort((left, right) => {
          const a = left[sort],
            b = right[sort];
          if (a == null || b == null)
            return a == null ? (b == null ? 0 : 1) : -1;
          return (
            String(a).localeCompare(String(b), "en", { sensitivity: "base" }) *
            direction
          );
        });
      }
      const pageNo = Number(url.searchParams.get("page"));
      const reply = () =>
        respond(route, {
          items: items.slice((pageNo - 1) * 12, pageNo * 12),
          total: items.length,
          page: pageNo,
          page_size: 12,
        });
      if (
        state.heldSearch &&
        url.searchParams.get("search") === state.heldSearch
      ) {
        state.held.push(reply);
        return;
      }
      return reply();
    }
    if (path === "/audit/exports" && method === "POST") {
      expect(req.headers()["x-csrf-token"]).toBe("synthetic-csrf");
      expect(call.body).not.toHaveProperty("page");
      expect(call.body).not.toHaveProperty("page_size");
      expect(call.body).not.toHaveProperty("sort");
      expect(call.body).not.toHaveProperty("direction");
      if (state.failExport)
        return respond(
          route,
          {
            error: {
              code: "EXPORT_TOO_LARGE",
              message: "Narrow filters: export exceeds 100,000 rows",
            },
          },
          422,
        );
      const file = {
        id: id(700 + state.exports.length),
        row_count: 49,
        filters: call.body,
        byte_count: 5600,
        sha256: "a".repeat(64),
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600000).toISOString(),
      };
      file.download_path = `/api/v1/audit/exports/${file.id}/download`;
      state.exports.push(file);
      nativeFiles.set(
        file.download_path,
        JSON.stringify({ type: "metadata", row_count: 49 }) +
          "\n" +
          state.records
            .map((item) => JSON.stringify({ type: "event", event: item }))
            .join("\n") +
          "\n" +
          JSON.stringify({ type: "complete", row_count: 49 }) +
          "\n",
      );
      const reply = () => respond(route, file);
      if (state.heldExport) {
        state.held.push(reply);
        return;
      }
      return reply();
    }
    if (/^\/audit\/exports\/[^/]+$/.test(path) && method === "DELETE") {
      expect(req.headers()["x-csrf-token"]).toBe("synthetic-csrf");
      const file = state.exports.find((file) => path.endsWith(file.id));
      if (file) file.discarded = true;
      return respond(route, { ok: true });
    }
    if (/^\/audit\/exports\/[^/]+\/download$/.test(path)) {
      const body =
        JSON.stringify({ type: "metadata", row_count: 49 }) +
        "\n" +
        state.records
          .map((item) => JSON.stringify({ type: "event", event: item }))
          .join("\n") +
        "\n" +
        JSON.stringify({ type: "complete", row_count: 49 }) +
        "\n";
      nativeFiles.set(url.pathname, body);
      return route.continue();
    }
    if (/^\/audit\/[^/]+$/.test(path)) {
      const eventId = path.split("/").pop();
      if (state.failDetail === eventId)
        return respond(
          route,
          { error: { code: "MISSING", message: "Event unavailable" } },
          404,
        );
      const entry = state.records.find((item) => item.id === eventId);
      if (!entry)
        return respond(
          route,
          { error: { code: "MISSING", message: "Event unavailable" } },
          404,
        );
      const reply = () =>
        respond(route, {
          ...entry,
          details: {
            reason: "Synthetic review: <script>not executable</script>",
            issue_revision: 2,
            device_id: id(801),
            actual_sha256: "b".repeat(64),
            password: "PRIVATE_SENTINEL_MUST_NOT_RENDER",
          },
        });
      if (state.heldId === eventId) {
        state.held.push(reply);
        return;
      }
      return reply();
    }
    unexpected.push(call);
    return respond(
      route,
      {
        error: { code: "UNEXPECTED", message: "Unexpected synthetic request" },
      },
      500,
    );
  });
  await page.goto(
    `${origin}/${app ? "__audit-app" : "__audit-fixture"}${app ? `#/${route}` : ""}`,
  );
  await page.waitForFunction(() => window.ready);
  return {
    context,
    page,
    state,
    async render(props = {}) {
      await page.evaluate((props) => window.renderAudit(props), props);
    },
    async release() {
      const held = state.held.splice(0);
      await Promise.all(held.map((reply) => reply()));
    },
    async close() {
      await context.close();
    },
  };
}
async function check(name, run) {
  const started = Date.now();
  await run();
  results.push({ name, status: "passed", milliseconds: Date.now() - started });
  console.log(`PASS ${name}`);
}
try {
  await check(
    "bounded pages, typed identity links and lazy safe detail with focus restoration",
    async () => {
      const f = await fixture();
      try {
        await f.render();
        await expect(f.page.locator(".audit-table tbody tr")).toHaveCount(12);
        expect(
          f.state.calls.filter((c) => /^\/audit\/[0-9a-f-]+$/.test(c.path)),
        ).toHaveLength(0);
        await expect(
          f.page.getByText("Time unavailable", { exact: true }),
        ).toBeVisible();
        await expect(f.page.locator(".audit-target a").first()).toHaveAttribute(
          "href",
          `#/configurations/${id(101)}`,
        );
        await expect(
          f.page.getByText("Synthetic reviewer", { exact: true }).first(),
        ).not.toHaveAttribute("href");
        await f.page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(f.page.locator(".audit-target").first()).toHaveText(
          "Synthetic Alpha 13",
        );
        const opener = f.page
          .getByRole("link", { name: "Pipeline published", exact: true })
          .first();
        await opener.click();
        const dialog = f.page.getByRole("dialog", { name: "Event details" });
        await expect(
          dialog.getByText(
            "Synthetic review: <script>not executable</script>",
            { exact: true },
          ),
        ).toBeVisible();
        expect(await dialog.textContent()).not.toContain("PRIVATE_SENTINEL");
        await dialog.getByText("Technical details", { exact: true }).click();
        await expect(
          dialog.getByText("b".repeat(64), { exact: true }),
        ).toBeVisible();
        await f.page.keyboard.press("Escape");
        await expect(opener).toBeFocused();
        expect(f.state.calls.some((c) => c.path === "/audit")).toBe(false);
        expect(f.state.calls.every((c) => c.method === "GET")).toBe(true);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "stale search and detail responses cannot replace current results; initial errors are not empty",
    async () => {
      const f = await fixture();
      try {
        f.state.failHistory = true;
        await f.render();
        await expect(f.page.getByRole("alert")).toContainText(
          "Synthetic history unavailable",
        );
        await expect(
          f.page.getByText("No activity recorded", { exact: true }),
        ).toHaveCount(0);
        await expect(
          f.page.getByRole("button", { name: "Export results" }),
        ).toBeDisabled();
        f.state.failHistory = false;
        await f.page
          .getByRole("button", { name: "Retry", exact: true })
          .click();
        await expect(f.page.locator(".audit-table tbody tr")).toHaveCount(12);
        f.state.heldSearch = "Alpha";
        await f.page
          .getByRole("textbox", { name: "Search activity" })
          .fill("Alpha");
        await expect.poll(() => f.state.held.length).toBe(1);
        await f.page
          .getByRole("textbox", { name: "Search activity" })
          .fill("Beta");
        await expect(f.page.locator(".audit-target").first()).toHaveText(
          "Synthetic Beta 25",
        );
        await f.release();
        await delay(50);
        await expect(f.page.locator(".audit-target").first()).toHaveText(
          "Synthetic Beta 25",
        );
        f.state.heldId = id(25);
        await f.page
          .getByRole("link", { name: "Pipeline published", exact: true })
          .first()
          .click();
        await expect.poll(() => f.state.held.length).toBe(1);
        await f.page.keyboard.press("Escape");
        await f.page
          .getByRole("link", { name: "Issue acknowledged", exact: true })
          .first()
          .click();
        await expect(
          f.page
            .getByRole("dialog")
            .getByRole("heading", { name: "Issue acknowledged" }),
        ).toBeVisible();
        await f.release();
        await delay(50);
        await expect(
          f.page
            .getByRole("dialog")
            .getByRole("heading", { name: "Issue acknowledged" }),
        ).toBeVisible();
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "column filters, inclusive dates, device scope and page clamping",
    async () => {
      const f = await fixture();
      try {
        await f.render({ initialDeviceId: id(800) });
        await expect(f.page.locator(".audit-table tbody tr")).toHaveCount(12);
        expect(f.state.calls[0].query.device_id).toBe(id(800));
        await f.page
          .getByRole("button", { name: "Filter Event", exact: true })
          .click();
        await f.page
          .getByLabel("Event", { exact: true })
          .selectOption("action:configuration.publish");
        await f.page
          .getByRole("button", { name: "Close Event filter" })
          .click();
        await f.page
          .getByRole("button", { name: "Filter Result", exact: true })
          .click();
        await f.page
          .getByRole("radio", { name: "Succeeded", exact: true })
          .click();
        await f.page
          .getByRole("button", { name: "Filter Time", exact: true })
          .click();
        await f.page.getByLabel("From date").fill("2026-09-27");
        await f.page.getByLabel("Through date").fill("2026-09-26");
        await expect(
          f.page.getByRole("button", { name: "Apply dates" }),
        ).toBeDisabled();
        await f.page.getByLabel("From date").fill("2026-09-01");
        await f.page.getByRole("button", { name: "Apply dates" }).click();
        await f.page.getByRole("button", { name: "Close Time filter" }).click();
        await expect
          .poll(() =>
            f.state.calls.some(
              (c) =>
                c.query.action === "configuration.publish" &&
                c.query.from === "2026-09-01T00:00:00.000Z" &&
                c.query.to === "2026-09-26T23:59:59.999Z",
            ),
          )
          .toBe(true);
        await f.page
          .getByRole("button", { name: "Clear filters", exact: true })
          .click();
        await expect(f.page.locator(".audit-table tbody tr")).toHaveCount(12);
        await f.page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(f.page.locator(".audit-target").first()).toHaveText(
          "Synthetic Alpha 13",
        );
        f.state.records = f.state.records.slice(0, 3);
        await f.page
          .getByRole("button", { name: "Refresh now", exact: true })
          .click();
        await expect(f.page.locator(".audit-table tbody tr")).toHaveCount(3);
        // Page 2 clamps to the only page, and a single page needs no pager.
        await expect
          .poll(
            () =>
              f.state.calls
                .filter((call) => call.path === "/audit/history")
                .at(-1).query.page,
          )
          .toBe("1");
        await expect(
          f.page.getByRole("button", { name: "Previous", exact: true }),
        ).toHaveCount(0);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "server-wide column sorting resets pages, preserves permalink filters and never enters export scope",
    async () => {
      const f = await fixture({
        app: true,
        route: "audit?search=Synthetic&page=2",
      });
      try {
        await expect(f.page.locator(".audit-target").first()).toHaveText(
          "Synthetic Alpha 13",
        );
        await expect(
          f.page.getByRole("button", { name: "Filter By", exact: true }),
        ).toHaveCount(0);
        await f.page.getByRole("button", { name: /^Sort by Event/ }).click();
        await expect
          .poll(() => f.state.calls.at(-1).query)
          .toMatchObject({
            page: "1",
            search: "Synthetic",
            sort: "action",
            direction: "asc",
          });
        await expect(
          f.page.locator(".audit-event-title").first(),
        ).toHaveAttribute("href", /sort=action&direction=asc/);
        await expect(
          f.page.locator(".audit-table tbody tr").first(),
        ).toContainText("Pipeline published");
        await f.page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(f.page.locator(".audit-target").first()).toHaveText(
          "Synthetic Beta 25",
        );
        // Time sorts newest first on its first click; other columns A to Z.
        for (const [label, column, direction] of [
          ["By", "actor", "asc"],
          ["Result", "outcome", "asc"],
          ["Time", "created_at", "desc"],
        ]) {
          await f.page
            .getByRole("button", { name: new RegExp(`^Sort by ${label}`) })
            .click();
          await expect
            .poll(() => f.state.calls.at(-1).query)
            .toMatchObject(
              direction === "asc"
                ? { page: "1", sort: column, direction }
                : { page: "1" },
            );
          await expect(
            f.page.getByRole("columnheader").filter({
              has: f.page.getByRole("button", {
                name: new RegExp(`^Sort by ${label}`),
              }),
            }),
          ).toHaveAttribute(
            "aria-sort",
            direction === "asc" ? "ascending" : "descending",
          );
        }
        await f.page.getByRole("button", { name: "Export results" }).click();
        await f.page.getByRole("button", { name: "Prepare export" }).click();
        await expect(
          f.page.getByRole("heading", { name: "File ready" }),
        ).toBeVisible();
        const body = f.state.calls.find((call) => call.method === "POST").body;
        // Exports keep the visible scope: sign-ins stay out by default.
        expect(body).toEqual({ scope: "changes", search: "Synthetic" });
        await f.page.keyboard.press("Escape");
        await f.page
          .getByPlaceholder("Search activity")
          .fill("No matching synthetic event");
        await expect(
          f.page.getByRole("heading", { name: "No matching events" }),
        ).toBeVisible();
        await expect(
          f.page.getByRole("button", { name: "Filter Event", exact: true }),
        ).toBeVisible();
        await expect(
          f.page.getByRole("button", { name: /^Sort by Time/ }),
        ).toBeVisible();
        await f.page.evaluate((actor) => {
          location.hash = `#/audit?actor_id=${actor}&page=1`;
        }, user.id);
        await f.page
          .getByRole("button", { name: "Filter By (active)", exact: true })
          .click();
        await expect(
          f.page.getByRole("dialog", { name: "Filter By" }),
        ).toContainText("Showing activity by Synthetic reviewer.");
        await expect(
          f.page
            .getByRole("dialog", { name: "Filter By" })
            .getByRole("textbox"),
        ).toHaveCount(0);
        await f.page
          .getByRole("dialog", { name: "Filter By" })
          .getByRole("button", { name: "Clear filter", exact: true })
          .click();
        await expect
          .poll(
            () =>
              f.state.calls
                .filter((call) => call.path === "/audit/history")
                .at(-1).query.actor_id,
          )
          .toBeUndefined();
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "prepared export covers all pages and downloads natively; errors and closed preparation free capacity",
    async () => {
      const f = await fixture();
      try {
        await f.page.evaluate(() => {
          const actual = Date.now;
          Date.now = () => actual() + 86400000;
        });
        await f.render();
        await expect(f.page.locator(".audit-table tbody tr")).toHaveCount(12);
        await f.page.getByRole("button", { name: "Next", exact: true }).click();
        await f.page.getByRole("button", { name: "Export results" }).click();
        let dialog = f.page.getByRole("dialog", {
          name: "Export audit events",
        });
        await expect(
          dialog.getByText(/All matching pages are included/),
        ).toContainText("49");
        f.state.failExport = true;
        await dialog.getByRole("button", { name: "Prepare export" }).click();
        await expect(dialog.getByRole("alert")).toContainText("100,000");
        await expect(
          dialog.getByRole("link", { name: "Download JSONL" }),
        ).toHaveCount(0);
        expect(f.state.calls.filter((c) => c.method === "POST")).toHaveLength(
          1,
        );
        f.state.failExport = false;
        await dialog.getByRole("button", { name: "Prepare export" }).click();
        await expect(
          dialog.getByRole("heading", { name: "File ready" }),
        ).toBeVisible();
        const downloading = f.page.waitForEvent("download");
        await dialog.getByRole("link", { name: "Download JSONL" }).click();
        const download = await downloading;
        const saved = resolve(output, "synthetic-audit.jsonl");
        await download.saveAs(saved);
        expect((await readFile(saved, "utf8")).trim().split("\n")).toHaveLength(
          51,
        );
        await expect(dialog.getByRole("status")).toContainText(
          "cannot confirm that the file was saved",
        );
        expect(nativeDownloads.length).toBeGreaterThan(0);
        expect(
          f.state.calls.filter(
            (c) => c.path.endsWith("/download") && c.resourceType === "fetch",
          ),
        ).toHaveLength(0);
        await dialog.getByRole("button", { name: "Discard file" }).click();
        await expect(
          dialog.getByRole("heading", { name: "File ready" }),
        ).toHaveCount(0);
        f.state.heldExport = true;
        await dialog.getByRole("button", { name: "Prepare export" }).click();
        await expect.poll(() => f.state.held.length).toBe(1);
        const pendingId = f.state.exports.at(-1).id;
        await dialog
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await f.release();
        await expect
          .poll(() =>
            f.state.calls.some(
              (c) =>
                c.method === "DELETE" &&
                c.path === `/audit/exports/${pendingId}`,
            ),
          )
          .toBe(true);
        f.state.heldExport = false;
        await f.page
          .getByRole("textbox", { name: "Search activity" })
          .fill("Alpha");
        await expect
          .poll(() => f.state.calls.at(-1)?.query.search)
          .toBe("Alpha");
        await f.page.getByRole("button", { name: "Export results" }).click();
        dialog = f.page.getByRole("dialog");
        await dialog.getByRole("button", { name: "Prepare export" }).click();
        await expect(
          dialog.getByRole("heading", { name: "File ready" }),
        ).toBeVisible();
        const unusedId = f.state.exports.at(-1).id;
        await f.page.keyboard.press("Escape");
        expect(
          f.state.calls.some(
            (c) =>
              c.method === "DELETE" && c.path === `/audit/exports/${unusedId}`,
          ),
        ).toBe(false);
        await f.page
          .getByRole("textbox", { name: "Search activity" })
          .fill("Beta");
        await expect
          .poll(() => f.state.calls.at(-1)?.query.search)
          .toBe("Beta");
        await f.page.getByRole("button", { name: "Export results" }).click();
        await expect(
          f.page.getByRole("region", { name: "Earlier prepared files" }),
        ).toBeVisible();
        await expect(f.page.locator(".audit-retained-file")).toHaveCount(1);
        await expect(f.page.locator(".audit-retained-file")).toContainText(
          "Search: Alpha",
        );
        await expect(f.page.locator(".audit-retained-file")).not.toContainText(
          "Search: Beta",
        );
        await f.page
          .locator(".audit-retained-file")
          .getByRole("button", { name: /Discard file prepared/ })
          .click();
        await expect
          .poll(() =>
            f.state.calls.some(
              (c) =>
                c.method === "DELETE" &&
                c.path === `/audit/exports/${unusedId}`,
            ),
          )
          .toBe(true);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "exact App event URLs survive login, reload, Back and Forward, with copy fallback and invalid-ID safety",
    async () => {
      const f = await fixture({
        app: true,
        route: `audit/${id(13).toUpperCase()}?search=Alpha&page=2&execute=delete`,
        signedIn: false,
      });
      try {
        await f.page
          .getByLabel("Email address", { exact: true })
          .fill(user.email);
        await f.page
          .getByLabel("Password", { exact: true })
          .fill("synthetic-only");
        await f.page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        let dialog = f.page.getByRole("dialog", { name: "Event details" });
        await expect(
          dialog.getByText("Synthetic Alpha 13", { exact: true }),
        ).toBeVisible();
        await f.page.reload();
        await expect(
          f.page
            .getByRole("dialog")
            .getByText("Synthetic Alpha 13", { exact: true }),
        ).toBeVisible();
        await f.page.evaluate(() =>
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async () => {
                throw new Error("denied");
              },
            },
          }),
        );
        await f.page.getByRole("button", { name: "Copy event link" }).click();
        const input = f.page.getByRole("textbox", { name: "Event link" });
        await expect(input).toBeFocused();
        expect(await input.inputValue()).toContain(
          `#/${`audit/${id(13)}`}?search=Alpha&page=2`,
        );
        expect(await input.inputValue()).not.toContain("execute");
        await f.page
          .getByRole("button", { name: "Return to audit log" })
          .click();
        await expect(f.page.getByRole("dialog")).toHaveCount(0);
        await expect(
          f.page.getByRole("textbox", { name: "Search activity" }),
        ).toHaveValue("Alpha");
        await expect(f.page.locator(".audit-target").first()).toHaveText(
          "Synthetic Alpha 13",
        );
        await f.page.goBack();
        await expect(
          f.page
            .getByRole("dialog")
            .getByText("Synthetic Alpha 13", { exact: true }),
        ).toBeVisible();
        await f.page.goForward();
        await expect(f.page.getByRole("dialog")).toHaveCount(0);
        await f.page.evaluate(() => {
          location.hash = "#/audit/not-a-uuid?page=1";
        });
        await expect(
          f.page.getByRole("dialog").getByText(/invalid identifier/),
        ).toBeVisible();
        expect(f.state.calls.some((c) => c.path === "/audit/not-a-uuid")).toBe(
          false,
        );
        expect(
          f.state.calls.filter((c) => c.method !== "GET").map((c) => c.path),
        ).toEqual(["/login"]);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "the detail names the device an event is about, and falls back to its ID when the server gives no name",
    async () => {
      const f = await fixture();
      try {
        await f.render();
        // Event 3 is about a device the server names; event 2 about one it does not.
        await f.page
          .getByRole("link", { name: "Pipeline published", exact: true })
          .first()
          .click();
        const dialog = f.page.getByRole("dialog", { name: "Event details" });
        const named = dialog.getByRole("link", {
          name: "Synthetic edge 800",
          exact: true,
        });
        await expect(named).toHaveAttribute("href", `#/devices/${id(800)}`);
        await expect(dialog).not.toContainText(id(800));
        await f.page.keyboard.press("Escape");
        await f.page
          .getByRole("link", { name: "Issue acknowledged", exact: true })
          .first()
          .click();
        await expect(
          dialog.getByRole("link", { name: id(801), exact: true }),
        ).toHaveAttribute("href", `#/devices/${id(801)}`);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "a retired identity's events show the device's own name with a badge, in the list, on a phone and in the detail",
    async () => {
      const f = await fixture();
      try {
        // What a recovery stores: the old record keeps its name with its own
        // id appended, so the new identity can take the name.
        const stored = `edge-nyc-01#retired-${id(60)}`;
        f.state.records = [
          {
            ...event(2),
            action: "device.revoke",
            target: stored,
            target_id: id(60),
            target_kind: "device",
            target_name: stored,
            device_id: id(60),
          },
          event(3),
        ];
        await f.render();
        const row = f.page.locator(".audit-table tbody tr").first();
        await expect(row.locator(".audit-target")).toContainText("edge-nyc-01");
        await expect(row.locator(".audit-target a")).toHaveText("edge-nyc-01");
        await expect(row.locator(".audit-target")).toContainText(
          "Retired identity",
        );
        await expect(f.page.locator(".audit-table")).not.toContainText(
          "#retired-",
        );
        for (const [width, theme] of [
          [1280, "light"],
          [1280, "dark"],
          [390, "light"],
          [390, "dark"],
        ]) {
          await f.page.setViewportSize({ width, height: 960 });
          await f.page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await expect(f.page.locator("body")).not.toContainText("#retired-");
          await expect(
            f.page.getByText("Retired identity", { exact: true }).first(),
          ).toBeVisible();
          expect(
            await f.page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          ).toBe(true);
          await f.page.screenshot({
            path: resolve(output, `audit-retired-${width}-${theme}.png`),
            animations: "disabled",
          });
        }
        await f.page.setViewportSize({ width: 1280, height: 960 });
        await f.page
          .getByRole("link", { name: "Device access revoked", exact: true })
          .first()
          .click();
        const dialog = f.page.getByRole("dialog", { name: "Event details" });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("edge-nyc-01");
        await expect(dialog).toContainText("Retired identity");
        await expect(dialog.getByText("Target", { exact: true })).toBeVisible();
        const axe = await new AxeBuilder({ page: f.page }).analyze();
        accessibility.push({
          width: 1280,
          theme: "dark",
          view: "retired detail",
          violations: axe.violations,
        });
        expect(axe.violations).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "desktop/mobile light/dark accessibility, readable filters and safe detail layout",
    async () => {
      const f = await fixture();
      try {
        await f.render();
        await expect(f.page.locator(".audit-table tbody tr")).toHaveCount(12);
        for (const width of [1280, 390])
          for (const theme of ["light", "dark"]) {
            await f.page.setViewportSize({ width, height: 960 });
            await f.page.evaluate((theme) => {
              document.documentElement.dataset.theme = theme;
            }, theme);
            const axe = await new AxeBuilder({ page: f.page }).analyze();
            accessibility.push({ width, theme, violations: axe.violations });
            expect(axe.violations).toEqual([]);
            expect(
              await f.page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
              ),
            ).toBe(true);
            await f.page.screenshot({
              path: resolve(
                output,
                `audit-${width === 390 ? "mobile" : "desktop"}-${theme}.png`,
              ),
              fullPage: true,
              animations: "disabled",
            });
          }
        await f.page
          .getByRole("link", { name: "Issue acknowledged", exact: true })
          .first()
          .click();
        await expect(
          f.page
            .getByRole("dialog")
            .getByRole("heading", { name: "Issue acknowledged" }),
        ).toBeVisible();
        const detailAxe = await new AxeBuilder({ page: f.page }).analyze();
        expect(detailAxe.violations).toEqual([]);
        accessibility.push({
          width: 390,
          theme: "dark",
          view: "detail",
          violations: detailAxe.violations,
        });
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
  const report = {
    generated_at: new Date().toISOString(),
    scope:
      "Actual React AuditLog/App with isolated synthetic HTTP; no real-server export or authentication claim",
    results,
    accessibility,
    requests,
    unexpected,
    errors,
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `Evidence: ${relative(repository, resolve(output, "report.json"))}`,
  );
} catch (failure) {
  await writeFile(
    resolve(output, "failure.json"),
    JSON.stringify(
      { results, requests, errors, unexpected, error: String(failure) },
      null,
      2,
    ),
  );
  throw failure;
} finally {
  await browser.close();
  await server.close();
}
