// Actual Issues controls with isolated synthetic HTTP; no preview state or credentials.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_ISSUES_COMPONENT_OUTPUT || ".local/issues-component",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:issues-fixture";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: {
    host: "127.0.0.1",
    port: 5204,
    strictPort: true,
    proxy: {},
    hmr: false,
  },
  plugins: [
    {
      name: "synthetic-issues-fixture",
      resolveId(id) {
        if (id === "virtual:issues-fixture") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import Issues from '/src/Issues.tsx';import AuditLog from '/src/AuditLog.tsx';import {setCSRF} from '/src/api.ts';import '/src/styles.css';setCSRF('synthetic-csrf');const root=createRoot(document.getElementById('root'));let key=0;window.renderIssues=(props={})=>{window.notifications=[];window.lastNavigation='';root.render(React.createElement(Issues,{key:++key,user:{id:'synthetic-admin',name:'Synthetic admin',email:'admin@example.test',role:'admin',enabled:true,revision:1},notify:message=>window.notifications.push(message),navigate:path=>window.lastNavigation=path,...props}));};window.renderAudit=()=>root.render(React.createElement(AuditLog,{key:++key}));window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__issues-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              "/__issues-fixture",
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic issue verification</title></head><body><main style="padding:24px"><div id="root"></div></main><script type="module">import "virtual:issues-fixture";</script></body></html>',
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
  requests = [],
  errors = [],
  unexpected = [],
  accessibility = [];
const issue = (index, disposition = "open") => ({
  id: index.toString(16).padStart(64, "0"),
  device_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  device_name: `Synthetic issue device ${String(index).padStart(3, "0")}`,
  device_revoked: index === 2 ? null : index % 2 === 0,
  code: "APPLY_FAILED",
  stage: "apply",
  title: "The device couldn't apply the configuration",
  message:
    "Device reported an operational failure. Inspect the local agent status for sanitized diagnostics.",
  diagnostics: [],
  count: index + 1,
  reports: index + 1,
  first_seen: "2026-09-25T12:00:00Z",
  last_seen: "2026-09-26T12:00:00Z",
  desired_version_id: null,
  resolved: disposition === "resolved",
  revision: 1,
  acknowledged: disposition === "acknowledged",
  acknowledged_at:
    disposition === "acknowledged" ? "2026-09-26T12:10:00Z" : null,
  acknowledged_by: disposition === "acknowledged" ? "synthetic-operator" : null,
  acknowledged_by_name:
    disposition === "acknowledged" ? "Synthetic operator" : null,
  acknowledgement_reason:
    disposition === "acknowledged" ? "Retired after independent review" : null,
  disposition,
});
const deviceName = (index) =>
  `Synthetic issue device ${String(index).padStart(3, "0")}`;
// Issues for one failing pipeline version, as the server renders them.
const versioned = (record, deployment) =>
  Object.assign(record, {
    code: "VALIDATION_FAILED",
    stage: "validation",
    title: "Vector rejected the configuration",
    message:
      'The data directory "/srv/synthetic-missing" does not exist on this device.',
    diagnostics: [
      {
        severity: "error",
        code: "DATA_DIR_MISSING",
        field: "data_dir",
        message:
          'The data directory "/srv/synthetic-missing" does not exist on this device.',
        hint: "Remove data_dir from the pipeline to use the device's own data directory, or create this directory on the device.",
      },
    ],
    desired_version_id: "00000000-0000-4000-8000-00000000c0de",
    version_number: 3,
    configuration_id: "00000000-0000-4000-8000-00000000c0f1",
    configuration_name: "Synthetic edge pipeline",
    deployment_id: deployment,
  });
async function fixture(props = {}, { layout = "list" } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errors.push(e.message));
  const state = {
    records: [
      ...Array.from({ length: 25 }, (_, i) => issue(i)),
      issue(26, "acknowledged"),
      issue(27, "resolved"),
    ],
    listFailure: false,
    detailFailure: 0,
    postFailure: 0,
    held: null,
    holdPost: false,
    postRequests: [],
    retryRequests: [],
    auditRecords: [],
  };
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace("/api/v1", ""),
      method = request.method();
    requests.push({
      path,
      method,
      query: Object.fromEntries(url.searchParams),
    });
    const reply = async (json, status = 200) => {
      try {
        await route.fulfill({ status, json });
      } catch {
        /* An obsolete request can be cancelled. */
      }
    };
    const fail = (status, message) =>
      reply(
        {
          error: {
            code: status === 409 ? "CONFLICT" : "FIXTURE_FAILURE",
            message,
          },
        },
        status,
      );
    if (path === "/audit/history" && method === "GET") {
      const records = state.auditRecords.slice().reverse();
      return reply({
        items: records.map(({ details, ...summary }) => summary),
        total: records.length,
        page: 1,
        page_size: 12,
      });
    }
    if (path.startsWith("/audit/") && method === "GET") {
      const record = state.auditRecords.find(
        (item) => item.id === path.slice("/audit/".length),
      );
      return record ? reply(record) : fail(404, "Audit event unavailable");
    }
    if (path === "/issues/history" && method === "GET") {
      if (state.listFailure)
        return fail(503, "Synthetic issue history unavailable");
      const params = url.searchParams,
        number = Number(params.get("page")),
        size = Number(params.get("page_size"));
      expect(size).toBe(12);
      let values = state.records.filter(
        (x) =>
          params.get("state") === "all" ||
          x.disposition === params.get("state"),
      );
      if (params.has("device_id"))
        values = values.filter((x) => x.device_id === params.get("device_id"));
      values = values.filter((x) =>
        `${x.device_name} ${x.code} ${x.message}`
          .toLowerCase()
          .includes((params.get("search") || "").toLowerCase()),
      );
      const sort = params.get("sort") || "last_seen",
        direction = params.get("direction") || "desc";
      expect(["code", "device", "last_seen", "count", "disposition"]).toContain(
        sort,
      );
      const value = (record) =>
        sort === "device"
          ? record.device_name || record.device_id
          : record[sort];
      values = values.slice().sort((a, b) => {
        const left = value(a),
          right = value(b);
        if (left == null || right == null)
          return left == null && right == null
            ? a.id.localeCompare(b.id)
            : left == null
              ? 1
              : -1;
        const comparison =
          typeof left === "number"
            ? left - right
            : String(left).localeCompare(String(right));
        return (
          comparison * (direction === "asc" ? 1 : -1) ||
          a.id.localeCompare(b.id)
        );
      });
      return reply({
        items: values.slice((number - 1) * size, number * size),
        total: values.length,
        page: number,
        page_size: size,
      });
    }
    if (path === "/issues/groups" && method === "GET") {
      if (state.listFailure)
        return fail(503, "Synthetic issue history unavailable");
      const params = url.searchParams,
        number = Number(params.get("page")),
        size = Number(params.get("page_size")),
        search = (params.get("search") || "").toLowerCase();
      expect(size).toBe(12);
      expect(params.has("device_id")).toBe(false);
      const grouped = new Map();
      for (const record of state.records) {
        if (
          params.get("state") !== "all" &&
          record.disposition !== params.get("state")
        )
          continue;
        if (
          !`${record.device_name} ${record.code} ${record.message}`
            .toLowerCase()
            .includes(search)
        )
          continue;
        const key = `${record.desired_version_id || ""}:${record.code}`;
        grouped.set(key, [...(grouped.get(key) || []), record]);
      }
      const newest = (list) =>
        list
          .map((x) => x.last_seen || "")
          .sort()
          .at(-1);
      const items = [...grouped]
        .sort(([, a], [, b]) => newest(b).localeCompare(newest(a)))
        .map(([key, list]) => {
          const devices = list
            .slice()
            .sort(
              (a, b) =>
                (b.last_seen || "").localeCompare(a.last_seen || "") ||
                a.id.localeCompare(b.id),
            )
            .slice(0, 50);
          const first = devices[0];
          return {
            key: createHash("sha256").update(key).digest("hex"),
            code: first.code,
            title: first.title,
            message: first.message,
            diagnostics: first.diagnostics,
            version_id: first.desired_version_id,
            version_number: first.version_number ?? null,
            configuration_id: first.configuration_id ?? null,
            configuration_name: first.configuration_name ?? null,
            deployment_ids: [
              ...new Set(devices.map((x) => x.deployment_id).filter(Boolean)),
            ].sort(),
            device_count: new Set(list.map((x) => x.device_id)).size,
            issue_count: list.length,
            attempts: list.reduce((sum, x) => sum + x.count, 0),
            reports: list.reduce((sum, x) => sum + (x.reports ?? x.count), 0),
            first_seen:
              list
                .map((x) => x.first_seen)
                .filter(Boolean)
                .sort()[0] ?? null,
            last_seen: newest(list) || null,
            devices,
          };
        });
      return reply({
        items: items.slice((number - 1) * size, number * size),
        total: items.length,
        page: number,
        page_size: size,
      });
    }
    const device = path.match(/^\/devices\/([0-9a-f-]{36})(\/retry)?$/);
    if (device) {
      const record = state.records.find((x) => x.device_id === device[1]);
      if (!record) return fail(404, "Device unavailable");
      const current = {
        id: record.device_id,
        name: record.device_name,
        status: "online",
        apply_state: record.retried ? "desired" : "failed",
        desired_version_id: record.desired_version_id,
        desired_generation: record.retried ? 9 : 8,
        reported_generation: 7,
        sync_paused: false,
        local_paused: false,
        retry_preconditions: true,
      };
      if (method === "GET" && !device[2]) return reply(current);
      if (method === "POST" && device[2]) {
        expect(request.headers()["x-csrf-token"]).toBe("synthetic-csrf");
        const body = request.postDataJSON();
        state.retryRequests.push({ path, body });
        expect(body).toEqual({
          expected_version_id: record.desired_version_id,
          expected_generation: 8,
        });
        record.retried = true;
        return reply({
          ...current,
          apply_state: "desired",
          desired_generation: 9,
        });
      }
    }
    const match = path.match(
      /^\/issues\/([0-9a-f]{64})(?:\/(acknowledge|reopen))?$/,
    );
    if (match) {
      const current = state.records.find((x) => x.id === match[1]);
      if (method === "GET")
        return state.detailFailure
          ? fail(state.detailFailure, "Synthetic issue detail unavailable")
          : current
            ? reply(current)
            : fail(404, "Issue unavailable");
      if (method === "POST" && match[2]) {
        expect(request.headers()["x-csrf-token"]).toBe("synthetic-csrf");
        const body = request.postDataJSON();
        state.postRequests.push({ path, body });
        if (state.holdPost)
          await new Promise((resolve) => (state.held = resolve));
        if (state.postFailure)
          return fail(state.postFailure, "Synthetic audit write unavailable");
        if (!current) return fail(404, "Issue unavailable");
        if (body.revision !== current.revision)
          return fail(409, "Issue changed");
        const acknowledge = match[2] === "acknowledge";
        // A note is optional when acknowledging; reopening needs a reason.
        if (!acknowledge && !body.reason)
          return fail(400, "Reopening requires a reason");
        Object.assign(current, {
          revision: current.revision + 1,
          acknowledged: acknowledge,
          disposition: acknowledge ? "acknowledged" : "open",
          resolved: false,
          acknowledged_at: acknowledge ? "2026-09-26T13:00:00Z" : null,
          acknowledged_by: acknowledge ? "synthetic-admin" : null,
          acknowledged_by_name: acknowledge ? "Synthetic admin" : null,
          acknowledgement_reason: acknowledge ? (body.reason ?? null) : null,
        });
        state.auditRecords.push({
          id: `10000000-0000-4000-8000-${String(state.auditRecords.length).padStart(12, "0")}`,
          actor: "Synthetic admin",
          actor_id: "synthetic-admin",
          actor_kind: "user",
          action: acknowledge ? "issue.acknowledge" : "issue.reopen",
          target: current.id,
          target_id: current.id,
          target_kind: "issue",
          target_name: null,
          device_id: current.device_id,
          details: { issue_revision: current.revision, reason: body.reason },
          request_id: null,
          outcome: "success",
          created_at: "2026-09-26T13:00:00Z",
        });
        return reply(current);
      }
    }
    unexpected.push(`${method} ${path}`);
    return fail(500, "Unexpected synthetic request");
  });
  // The first load transforms the whole app; allow for a busy machine.
  await page.goto("http://127.0.0.1:5204/__issues-fixture", {
    timeout: 60000,
  });
  await page.waitForFunction(() => window.ready);
  // Issues opens grouped by version and reason; most checks review the
  // flat list ("All issues"), which a device scope always shows.
  const mount = async (next = {}, view = layout) => {
    await page.evaluate((props) => window.renderIssues(props), {
      ...props,
      ...next,
    });
    await expect(
      page.getByRole("heading", { name: "Issues", exact: true }),
    ).toBeVisible();
    if (view === "list" && !{ ...props, ...next }.deviceId)
      await setLayout(page, "list");
  };
  await mount();
  const row = (index) =>
    page.locator(".issue-table tbody tr").filter({
      has: page.getByRole("link", {
        name: deviceName(index),
        exact: true,
      }),
    });
  const dialog = () => page.getByRole("dialog");
  const open = async (index = 0) => {
    await row(index)
      .getByRole("button", {
        name: `Acknowledge issue on ${deviceName(index)}`,
        exact: true,
      })
      .click();
    await expect(dialog()).toBeVisible();
  };
  const close = async () => {
    state.held?.();
    await context.close();
  };
  return { page, context, state, mount, row, dialog, open, close };
}
async function setStatus(page, value) {
  const button = page
    .getByRole("group", { name: "Issue status", exact: true })
    .getByRole("button", {
      name: value === "acknowledged" ? "Acknowledged" : "Open",
      exact: true,
    });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}
async function setLayout(page, value) {
  const button = page
    .getByRole("group", { name: "Issue layout", exact: true })
    .getByRole("button", {
      name: value === "list" ? "All issues" : "By version and reason",
      exact: true,
    });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
  console.log("PASS", name);
}
try {
  await check(
    "bounded paging, explicit device scope, unavailable timestamps and read retry retain truthful totals",
    async () => {
      const f = await fixture();
      try {
        await expect(f.page.locator(".issue-table tbody tr")).toHaveCount(12);
        await expect(f.page.locator(".pagination")).toContainText("of 25");
        await f.page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(f.row(12)).toBeVisible();
        await f.page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(f.row(24)).toBeVisible();
        await expect(f.page.locator(".issue-table tbody tr")).toHaveCount(1);
        await setStatus(f.page, "acknowledged");
        await expect(f.row(26)).toBeVisible();
        const badge = f.row(26).locator(".badge");
        await expect(badge).toHaveText("Acknowledged");
        expect(await badge.getAttribute("class")).not.toContain("positive");
        f.state.records[0].first_seen = null;
        f.state.records[0].last_seen = null;
        await f.mount({ deviceId: f.state.records[0].device_id });
        await expect(f.row(0)).toBeVisible();
        await expect(f.page.locator(".issue-table tbody tr")).toHaveCount(1);
        await expect(f.row(0).locator("time")).toHaveText("Unavailable");
        await f.page
          .getByRole("button", { name: "Show all devices", exact: true })
          .click();
        expect(await f.page.evaluate(() => window.lastNavigation)).toBe(
          "issues",
        );
        f.state.listFailure = true;
        await f.mount();
        await expect(
          f.page.getByText("Synthetic issue history unavailable", {
            exact: true,
          }),
        ).toBeVisible();
        f.state.listFailure = false;
        await f.page
          .getByRole("button", { name: "Try again", exact: true })
          .click();
        await expect(f.row(1)).toBeVisible();
        await f.page.getByRole("button", { name: /^Sort by Attempts/ }).click();
        await expect(f.row(0)).toBeVisible();
        await f.page.getByRole("button", { name: /^Sort by Attempts/ }).click();
        await expect(f.row(24)).toBeVisible();
        expect(
          requests
            .filter((request) => request.path === "/issues/history")
            .at(-1).query,
        ).toMatchObject({
          sort: "count",
          direction: "desc",
          page: "1",
          page_size: "12",
        });
        await f.page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(f.row(12)).toBeVisible();
        f.state.listFailure = true;
        await f.page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await expect(
          f.page.getByText("Synthetic issue history unavailable", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          f.page.locator(".issue-table tbody tr .control-row-title"),
        ).toHaveCount(0);
        f.state.listFailure = false;
        await f.page
          .getByRole("button", { name: "Try again", exact: true })
          .click();
        await expect(f.row(12)).toBeVisible();
        expect(f.state.postRequests).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "new occurrence conflicts require explicit latest review and a second submission",
    async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.page
          .getByLabel("Note (optional)")
          .fill("Reviewed prior occurrence");
        f.state.records[0].count = 2;
        f.state.records[0].revision = 2;
        await f
          .dialog()
          .getByRole("button", { name: "Acknowledge issue", exact: true })
          .click();
        await expect(
          f.page.getByText(
            "This issue changed since you opened it. Review the latest report before deciding again.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          f
            .dialog()
            .getByRole("button", { name: "Acknowledge issue", exact: true }),
        ).toBeDisabled();
        await f.page
          .getByRole("button", { name: "Review latest issue", exact: true })
          .click();
        await expect(f.dialog()).toContainText("2 failed attempts");
        await expect(f.page.getByLabel("Note (optional)")).toHaveValue(
          "Reviewed prior occurrence",
        );
        expect(f.state.postRequests).toHaveLength(1);
        await f
          .dialog()
          .getByRole("button", { name: "Acknowledge issue", exact: true })
          .click();
        await expect(f.dialog()).toHaveCount(0);
        expect(f.state.postRequests.map((x) => x.body.revision)).toEqual([
          1, 2,
        ]);
        expect(f.state.records[0].resolved).toBe(false);
        expect(await f.page.evaluate(() => window.notifications)).toContain(
          "Issue acknowledged. Recovery has not been verified.",
        );
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "audit failure retains the typed reason and allows a deliberate retry",
    async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.page
          .getByLabel("Note (optional)")
          .fill("Reason preserved after audit failure");
        f.state.postFailure = 500;
        await f
          .dialog()
          .getByRole("button", { name: "Acknowledge issue", exact: true })
          .click();
        await expect(
          f.page.getByText("Synthetic audit write unavailable", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(f.page.getByLabel("Note (optional)")).toHaveValue(
          "Reason preserved after audit failure",
        );
        expect(f.state.records[0].disposition).toBe("open");
        f.state.postFailure = 0;
        await f
          .dialog()
          .getByRole("button", { name: "Acknowledge issue", exact: true })
          .click();
        await expect(f.dialog()).toHaveCount(0);
        expect(f.state.postRequests).toHaveLength(2);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "a competing disposition cannot silently switch the reviewed action",
    async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.page
          .getByLabel("Note (optional)")
          .fill("Reason intended only for acknowledgement");
        Object.assign(f.state.records[0], {
          revision: 2,
          acknowledged: true,
          disposition: "acknowledged",
          acknowledged_by: "other-operator",
          acknowledged_by_name: "Other operator",
          acknowledged_at: "2026-09-26T13:00:00Z",
          acknowledgement_reason: "Other reviewed decision",
        });
        await f
          .dialog()
          .getByRole("button", { name: "Acknowledge issue", exact: true })
          .click();
        await f.page
          .getByRole("button", { name: "Review latest issue", exact: true })
          .click();
        await expect(f.dialog()).toContainText("Close");
        await expect(
          f
            .dialog()
            .getByRole("button", { name: "Acknowledge issue", exact: true }),
        ).toBeDisabled();
        await expect(
          f.dialog().getByRole("button", { name: "Reopen issue", exact: true }),
        ).toHaveCount(0);
        await expect(f.page.getByLabel("Note (optional)")).toHaveValue(
          "Reason intended only for acknowledgement",
        );
        expect(f.state.postRequests).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Audit Log preserves acknowledgement and reopening reasons after current acknowledgement fields clear",
    async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.page
          .getByLabel("Note (optional)")
          .fill("Original retired-device decision");
        await f
          .dialog()
          .getByRole("button", { name: "Acknowledge issue", exact: true })
          .click();
        await expect(f.dialog()).toHaveCount(0);
        await setStatus(f.page, "acknowledged");
        await f
          .row(0)
          .getByRole("button", {
            name: `Reopen issue on ${deviceName(0)}`,
            exact: true,
          })
          .click();
        await f.page
          .getByLabel("Reason for reopening")
          .fill("Later renewed review");
        await f
          .dialog()
          .getByRole("button", { name: "Reopen issue", exact: true })
          .click();
        await expect(f.dialog()).toHaveCount(0);
        expect(f.state.records[0].acknowledgement_reason).toBe(null);
        await f.page.evaluate(() => window.renderAudit());
        await expect(
          f.page.getByRole("heading", { name: "Audit log", exact: true }),
        ).toBeVisible();
        const prior = f.page.getByRole("row").filter({
          has: f.page.getByText("Issue acknowledged", { exact: true }),
        });
        await prior
          .getByRole("link", { name: "Issue acknowledged", exact: true })
          .click();
        await expect(f.dialog()).toContainText(
          "Original retired-device decision",
        );
        await expect(
          f.dialog().getByRole("link", {
            name: f.state.records[0].device_id,
            exact: true,
          }),
        ).toHaveAttribute("href", `#/devices/${f.state.records[0].device_id}`);
        await f
          .dialog()
          .getByText("Technical details", { exact: true })
          .click();
        await expect(f.dialog()).toContainText("Issue revision");
        await f.page.keyboard.press("Escape");
        await f.page
          .getByRole("row")
          .filter({ has: f.page.getByText("Issue reopened", { exact: true }) })
          .getByRole("link", { name: "Issue reopened", exact: true })
          .click();
        await expect(f.dialog()).toContainText("Later renewed review");
        expect(f.state.postRequests).toHaveLength(2);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "stale missing or newly resolved identities cannot be acknowledged after detail refresh",
    async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.page.getByLabel("Note (optional)").fill("Review identity");
        f.state.records[0].revision++;
        await f
          .dialog()
          .getByRole("button", { name: "Acknowledge issue", exact: true })
          .click();
        f.state.detailFailure = 404;
        await f.page
          .getByRole("button", { name: "Review latest issue", exact: true })
          .click();
        await expect(
          f.page.getByText("Synthetic issue detail unavailable", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          f
            .dialog()
            .getByRole("button", { name: "Acknowledge issue", exact: true }),
        ).toBeDisabled();
        f.state.detailFailure = 0;
        f.state.records[0].resolved = true;
        f.state.records[0].disposition = "resolved";
        await f.page
          .getByRole("button", { name: "Review latest issue", exact: true })
          .click();
        await expect(f.dialog()).toContainText("This issue is now resolved");
        await expect(
          f
            .dialog()
            .getByRole("button", { name: "Acknowledge issue", exact: true }),
        ).toBeDisabled();
        expect(f.state.postRequests).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "viewer and editor controls stay read-only; live and retired devices can be acknowledged, missing identities cannot",
    async () => {
      const f = await fixture();
      const decisions = /^(Acknowledge|Reopen) issue on /;
      try {
        // Live (1) and revoked (0) devices: acknowledging records a known,
        // handled failure. A missing identity (2) cannot be decided on.
        for (const index of [0, 1])
          await expect(
            f.row(index).getByRole("button", {
              name: `Acknowledge issue on ${deviceName(index)}`,
              exact: true,
            }),
          ).toBeVisible();
        await expect(f.row(2)).toBeVisible();
        await expect(
          f.row(2).getByRole("button", { name: decisions }),
        ).toHaveCount(0);
        // Retry needs a pipeline version to apply again.
        await expect(
          f.page.getByRole("button", { name: /^Retry on device/ }),
        ).toHaveCount(0);
        for (const role of ["viewer", "editor"]) {
          await f.mount({
            user: {
              id: `synthetic-${role}`,
              name: `Synthetic ${role}`,
              email: `${role}@example.test`,
              role,
              enabled: true,
              revision: 1,
            },
          });
          await expect(f.row(0)).toBeVisible();
          await expect(
            f.page.getByRole("button", { name: decisions }),
          ).toHaveCount(0);
          await setStatus(f.page, "acknowledged");
          await expect(f.row(26)).toBeVisible();
          await expect(
            f.page.getByRole("button", { name: decisions }),
          ).toHaveCount(0);
        }
        expect(f.state.postRequests).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "pending mutation blocks Escape, cancellation and navigation; reopen remains a separate reviewed action",
    async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.page.getByLabel("Note (optional)").fill("Retired fixture");
        f.state.holdPost = true;
        const immediateGuard = await f
          .dialog()
          .getByRole("button", { name: "Acknowledge issue", exact: true })
          .evaluate((button) => {
            button.click();
            const event = new Event("vectory:before-navigate", {
              cancelable: true,
            });
            window.dispatchEvent(event);
            return event.defaultPrevented;
          });
        expect(immediateGuard).toBe(true);
        await expect.poll(() => f.state.postRequests.length).toBe(1);
        await expect(f.page.getByLabel("Note (optional)")).toBeDisabled();
        await expect(
          f.dialog().getByRole("button", { name: "Cancel", exact: true }),
        ).toBeDisabled();
        await f.page.keyboard.press("Escape");
        await expect(f.dialog()).toBeVisible();
        expect(
          await f.page.evaluate(() => {
            const e = new Event("vectory:before-navigate", {
              cancelable: true,
            });
            window.dispatchEvent(e);
            return e.defaultPrevented;
          }),
        ).toBe(true);
        f.state.holdPost = false;
        f.state.held();
        await expect(f.dialog()).toHaveCount(0);
        await setStatus(f.page, "acknowledged");
        await expect(f.row(0)).toBeVisible();
        await f
          .row(0)
          .getByRole("button", {
            name: `Reopen issue on ${deviceName(0)}`,
            exact: true,
          })
          .click();
        await expect(f.page.getByLabel("Reason for reopening")).toHaveValue("");
        await f.page
          .getByLabel("Reason for reopening")
          .fill("Needs renewed review");
        await f
          .dialog()
          .getByRole("button", { name: "Reopen issue", exact: true })
          .click();
        await expect(f.dialog()).toHaveCount(0);
        expect(f.state.records[0].disposition).toBe("open");
        expect(f.state.records[0].resolved).toBe(false);
        expect(f.state.postRequests).toHaveLength(2);
      } finally {
        await f.close();
      }
    },
  );
  const deployments = [
    "00000000-0000-4000-8000-0000000000d1",
    "00000000-0000-4000-8000-0000000000d2",
  ];
  // Six devices fail version 3 of one pipeline the same way, across two
  // deployments; device 1 reported most recently.
  const failing = [1, 3, 4, 5, 6, 7];
  const groupFixture = async () => {
    const f = await fixture({}, { layout: "groups" });
    for (const index of failing)
      versioned(f.state.records[index], deployments[index < 5 ? 0 : 1]);
    f.state.records[1].last_seen = "2026-09-26T12:30:00Z";
    await f.mount({}, "groups");
    const groups = f.page.locator("article.issue-group");
    const group = groups.filter({
      has: f.page.getByRole("heading", {
        name: "Vector rejected the configuration",
        exact: true,
      }),
    });
    return { ...f, groups, group };
  };
  await check(
    "issues open grouped by version and reason with the fix, links, devices and recovery actions",
    async () => {
      const f = await groupFixture();
      try {
        await expect(f.groups).toHaveCount(2);
        await expect(f.groups.first()).toContainText(
          "Vector rejected the configuration",
        );
        await expect(
          f.group.getByRole("link", {
            name: "Synthetic edge pipeline · version 3",
            exact: true,
          }),
        ).toHaveAttribute(
          "href",
          "#/configurations/00000000-0000-4000-8000-00000000c0f1",
        );
        for (const [index, id] of deployments.entries())
          await expect(
            f.group.getByRole("link", {
              name: `Deployment ${index + 1}`,
              exact: true,
            }),
          ).toHaveAttribute("href", `#/deployments/${id}`);
        await expect(f.group.locator(".issue-group-reason")).toHaveText(
          'The data directory "/srv/synthetic-missing" does not exist on this device.',
        );
        await expect(f.group.locator(".issue-fix")).toContainText(
          "Remove data_dir from the pipeline to use the device's own data directory",
        );
        await expect(f.group.locator(".issue-group-status")).toHaveText(
          "6 open",
        );
        const attempts = failing.reduce((sum, index) => sum + index + 1, 0);
        await expect(f.group.locator(".issue-group-meta")).toContainText(
          `6 devices · ${attempts} failed attempts`,
        );
        const other = f.groups.nth(1);
        await expect(other).toContainText("No pipeline version");
        await expect(other.getByRole("link")).toHaveCount(0);
        await expect(other.locator(".issue-group-meta")).toContainText(
          "19 devices",
        );
        // Findings and devices stay collapsed until asked for.
        const toggle = f.group.getByRole("button", {
          name: "Show devices and findings",
          exact: true,
        });
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(f.group.getByRole("table")).toHaveCount(0);
        await toggle.click();
        await expect(
          f.group.getByRole("button", {
            name: "Hide devices and findings",
            exact: true,
          }),
        ).toHaveAttribute("aria-expanded", "true");
        await expect(
          f.group.getByRole("heading", {
            name: "What Vector reported",
            exact: true,
          }),
        ).toBeVisible();
        const devices = f.group.getByRole("table", {
          name: "Devices with Vector rejected the configuration",
          exact: true,
        });
        await expect(devices.locator("tbody tr")).toHaveCount(6);
        await expect(devices.locator("tbody tr").first()).toContainText(
          deviceName(1),
        );
        // Live devices can retry the failed version; a retired identity can
        // only be acknowledged.
        await expect(
          devices.getByRole("button", {
            name: `Retry on device ${deviceName(1)}`,
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          devices.getByRole("button", {
            name: `Retry on device ${deviceName(4)}`,
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(
          devices.getByRole("button", {
            name: `Acknowledge issue on ${deviceName(4)}`,
            exact: true,
          }),
        ).toBeVisible();
        // Acknowledge a live device's failure without a note.
        await devices
          .getByRole("button", {
            name: `Acknowledge issue on ${deviceName(3)}`,
            exact: true,
          })
          .click();
        await expect(f.dialog()).toContainText(
          "Synthetic edge pipeline · version 3",
        );
        await expect(f.dialog()).toContainText(
          "Acknowledging doesn't mark the device healthy.",
        );
        await f
          .dialog()
          .getByRole("button", { name: "Acknowledge issue", exact: true })
          .click();
        await expect(f.dialog()).toHaveCount(0);
        expect(f.state.postRequests).toEqual([
          {
            path: `/issues/${f.state.records[3].id}/acknowledge`,
            body: { revision: 1 },
          },
        ]);
        expect(await f.page.evaluate(() => window.notifications)).toContain(
          "Issue acknowledged. Recovery has not been verified.",
        );
        await expect(f.group.locator(".issue-group-meta")).toContainText(
          "5 devices",
        );
        await expect(devices.locator("tbody tr")).toHaveCount(5);
        // Retry the failed version on a live device after reviewing it.
        await devices
          .getByRole("button", {
            name: `Retry on device ${deviceName(1)}`,
            exact: true,
          })
          .click();
        await expect(f.dialog()).toContainText(
          "Synthetic edge pipeline · version 3 (the version that failed)",
        );
        await f
          .dialog()
          .getByRole("button", { name: "Retry application", exact: true })
          .click();
        await expect(f.dialog()).toHaveCount(0);
        expect(f.state.retryRequests).toEqual([
          {
            path: `/devices/${f.state.records[1].device_id}/retry`,
            body: {
              expected_version_id: "00000000-0000-4000-8000-00000000c0de",
              expected_generation: 8,
            },
          },
        ]);
        expect(await f.page.evaluate(() => window.notifications)).toContain(
          "Retry requested for the reviewed assignment. Device verification is still pending.",
        );
        // Search narrows groups; the flat list remains one click away.
        await f.page
          .getByRole("textbox", {
            name: "Search devices, pipelines, or reasons",
            exact: true,
          })
          .fill("synthetic-missing");
        await expect(f.groups).toHaveCount(1);
        expect(
          requests.filter((request) => request.path === "/issues/groups").at(-1)
            .query,
        ).toMatchObject({
          search: "synthetic-missing",
          state: "open",
          page: "1",
          page_size: "12",
        });
        await setLayout(f.page, "list");
        await expect(f.page.locator(".issue-table tbody tr")).toHaveCount(5);
        await setLayout(f.page, "groups");
        await f.page
          .getByRole("textbox", {
            name: "Search devices, pipelines, or reasons",
            exact: true,
          })
          .fill("no-such-issue");
        await expect(
          f.page.getByRole("heading", {
            name: "No matching issues",
            exact: true,
          }),
        ).toBeVisible();
        await expect(f.groups).toHaveCount(0);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "grouped issues and their device lists fit mobile in light and dark with accessible disclosure and contrast",
    async () => {
      const f = await groupFixture();
      try {
        await f.group
          .getByRole("button", {
            name: "Show devices and findings",
            exact: true,
          })
          .click();
        for (const width of [1280, 390])
          for (const theme of ["light", "dark"]) {
            await f.page.setViewportSize({
              width,
              height: width === 390 ? 844 : 960,
            });
            await f.page.evaluate(
              (theme) => (document.documentElement.dataset.theme = theme),
              theme,
            );
            await expect(
              f.group.getByRole("table", {
                name: "Devices with Vector rejected the configuration",
                exact: true,
              }),
            ).toBeVisible();
            expect(
              await f.page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const audit = await new AxeBuilder({ page: f.page }).analyze();
            accessibility.push({
              width,
              theme,
              view: "groups",
              violations: audit.violations.map((x) => x.id),
            });
            expect(audit.violations.map((x) => x.id)).toEqual([]);
            await f.page.screenshot({
              path: resolve(
                output,
                `groups-${width === 390 ? "mobile" : "desktop"}-${theme}.png`,
              ),
              fullPage: true,
              animations: "disabled",
            });
          }
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "light and dark issue history and review dialog fit mobile and retain accessible labels and contrast",
    async () => {
      const f = await fixture();
      try {
        for (const width of [1280, 390])
          for (const theme of ["light", "dark"]) {
            await f.page.setViewportSize({
              width,
              height: width === 390 ? 844 : 960,
            });
            await f.page.evaluate(
              (theme) => (document.documentElement.dataset.theme = theme),
              theme,
            );
            await setStatus(f.page, "acknowledged");
            await expect(f.row(26)).toBeVisible();
            const geometry = await f.page.evaluate(() => ({
              width: innerWidth,
              scroll: document.documentElement.scrollWidth,
              overflow: [
                ...document.querySelectorAll(
                  "main, .issue-page, .issue-toolbar, .control-table, .data-table-scroll, .pagination",
                ),
              ].map((element) => ({
                name: element.className || element.tagName,
                x: element.getBoundingClientRect().x,
                width: element.getBoundingClientRect().width,
                scroll: element.scrollWidth,
              })),
            }));
            if (geometry.scroll > width) {
              await f.page.screenshot({
                path: resolve(output, "overflow.png"),
              });
              console.log(JSON.stringify(geometry));
              console.log(
                await f.page.evaluate(() =>
                  [
                    ...document.querySelectorAll(
                      ".sr-only,[data-radix-popper-content-wrapper],[data-radix-focus-guard]",
                    ),
                  ].map((element) => ({
                    text: element.textContent?.slice(0, 50),
                    tag: element.tagName,
                    classes: element.className,
                    box: element.getBoundingClientRect().toJSON(),
                    position: getComputedStyle(element).position,
                  })),
                ),
              );
            }
            expect(
              await f.page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const audit = await new AxeBuilder({ page: f.page }).analyze();
            accessibility.push({
              width,
              theme,
              view: "history",
              violations: audit.violations.map((x) => x.id),
            });
            expect(audit.violations.map((x) => x.id)).toEqual([]);
            await f.page.screenshot({
              path: resolve(
                output,
                `${width === 390 ? "mobile" : "desktop"}-${theme}.png`,
              ),
              animations: "disabled",
            });
          }
        await setStatus(f.page, "open");
        await f.open();
        const audit = await new AxeBuilder({ page: f.page }).analyze();
        accessibility.push({
          width: 390,
          theme: "dark",
          view: "dialog",
          violations: audit.violations.map((x) => x.id),
        });
        expect(audit.violations.map((x) => x.id)).toEqual([]);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await f.page.screenshot({
          path: resolve(output, "review-mobile-dark.png"),
          animations: "disabled",
        });
        await f.page.keyboard.press("Escape");
        await expect(f.dialog()).toHaveCount(0);
        await expect(
          f.row(0).getByRole("button", {
            name: `Acknowledge issue on ${deviceName(0)}`,
            exact: true,
          }),
        ).toBeFocused();
      } finally {
        await f.close();
      }
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Actual React Issues controls with isolated synthetic HTTP. Server authorization/transactions are tested separately; no preview or native mutation.",
        results,
        requests: requests.length,
        accessibility,
        browser_errors: errors,
        unexpected_requests: unexpected,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: results.length,
      evidence: relative(repository, resolve(output, "results.json")),
    }),
  );
} finally {
  await browser.close();
  await server.close();
}
