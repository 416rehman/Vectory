// Actual App/device page. Every API response is synthetic; no real device or mutation.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_DEVICE_ASSIGNMENT_OUTPUT || ".local/device-assignment",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:device-assignment";
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "device-assignment-fixture",
      resolveId(id) {
        if (id === "virtual:device-assignment") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url.split("?")[0] !== "/__device-assignment")
            return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic device assignment check</title></head><body><div id="root"></div><script type="module">import "virtual:device-assignment";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const configurationAssignmentId = "abcdef12-abcd-4123-8123-abcdef123456";
const policyAssignmentId = id(82);
const created = "2026-09-27T12:00:00Z";
const config = {
  sources: { seed: { type: "demo_logs", format: "json" } },
  sinks: { discard: { type: "blackhole", inputs: ["seed"] } },
};
const pipeline = {
  id: id(10),
  name: "Synthetic device pipeline",
  description: "Isolated browser fixture",
  revision: 1,
  config,
  graph: { nodes: [], edges: [] },
  created_at: created,
  updated_at: created,
  archived: false,
};
const version = {
  id: id(11),
  configuration_id: pipeline.id,
  number: 3,
  config,
  graph: pipeline.graph,
  sha256: "a".repeat(64),
  size: JSON.stringify(config).length,
  artifact: JSON.stringify(config),
  created_at: created,
  message: "Synthetic version",
};
const baseDevice = () => ({
  id: id(1),
  name: "Synthetic edge",
  os: "linux",
  arch: "amd64",
  agent_version: "synthetic",
  vector_version: "0.58.0",
  configuration_mode: "full",
  created_at: created,
  last_seen: new Date().toISOString(),
  status: "verified",
  apply_state: "verified_applied",
  desired_generation: 5,
  reported_generation: 5,
  desired_version_id: version.id,
  labels: {},
  sync_paused: false,
  local_paused: false,
  pause_acknowledged: false,
  assignment: {
    id: configurationAssignmentId.toUpperCase(),
    priority: 75,
    reason: "Current configuration winner",
  },
  policy_assignment: {
    id: policyAssignmentId,
    priority: 250,
    reason: "Current independent policy winner",
  },
  effective_policy: {
    heartbeat_seconds: 120,
    sync_paused: false,
    telemetry_enabled: false,
  },
});
const results = [],
  requests = [],
  errors = [],
  unexpected = [],
  accessibility = [],
  geometry = [],
  screenshots = [];
let context, page, state, failure;
async function load({
  device = baseDevice(),
  role = "viewer",
  width = 899,
  theme = "light",
  path = `devices/${id(1)}`,
} = {}) {
  if (context) await context.close();
  state = { device, reads: 0, holdNext: false, failNext: false, holds: [] };
  const current = state;
  context = await browser.newContext({
    viewport: { width, height: 960 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
    localStorage.setItem("vectory-sidebar-collapsed", "true");
  }, theme);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    if (url.origin !== origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7);
    requests.push({ method, path, query: url.search });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: id(99),
            email: "viewer@example.test",
            name: "Synthetic reviewer",
            role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic device context" });
      if (path === `/devices/${id(1)}`) {
        current.reads++;
        const snapshot = structuredClone(current.device);
        if (current.failNext) {
          current.failNext = false;
          return reply(
            {
              error: {
                code: "UNAVAILABLE",
                message: "Synthetic device refresh failed",
              },
            },
            503,
          );
        }
        if (current.holdNext) {
          current.holdNext = false;
          await new Promise((done) => current.holds.push(done));
        }
        return reply(snapshot);
      }
      if (path === "/devices") return reply([current.device]);
      if (path === "/groups") return reply([]);
      if (path === `/versions/${version.id}`) return reply(version);
      if (path === `/configurations/${pipeline.id}`) return reply(pipeline);
      if (path === "/configurations/library")
        return reply({ items: [], total: 0, page: 1, page_size: 12 });
      if (path === "/deployments/history")
        return reply({
          items: [],
          total: 0,
          page: Number(url.searchParams.get("page") || 1),
          page_size: 12,
        });
      if (/^\/deployments\/[^/]+\/rollout$/.test(path))
        return reply({
          deployment_id: path.split("/")[2],
          status: "active",
          evaluated_at: new Date().toISOString(),
          stages: [],
          failures: [],
          removed_count: 0,
          check_in_seconds: 60,
          next_admission_at: null,
        });
      const detail = path.match(/^\/deployments\/([^/]+)\/(summary|targets)$/);
      if (detail) {
        if (detail[2] === "targets")
          return reply({ items: [], total: 0, page: 1, page_size: 12 });
        const isPolicy = detail[1] === policyAssignmentId;
        return reply({
          id: detail[1],
          name: isPolicy
            ? "Synthetic governing settings"
            : "Synthetic governing pipeline",
          configuration_id: isPolicy ? null : pipeline.id,
          configuration_name: isPolicy ? null : pipeline.name,
          version_id: isPolicy ? null : version.id,
          version_number: isPolicy ? null : 3,
          policy: isPolicy ? current.device.effective_policy : null,
          priority: isPolicy ? 250 : 75,
          target_mode: "snapshot",
          status: "completed",
          scheduled_at: null,
          created_at: created,
          rollout: { kind: "all" },
          target_count: 1,
          verified_count: 1,
          state_counts: { verified_applied: 1 },
        });
      }
      // The device page also shows telemetry, open issues and recent activity.
      if (path === `/devices/${id(1)}/telemetry`)
        return reply({ device_id: id(1), samples: [] });
      if (path === "/issues/history" || path === "/audit/history")
        return reply({
          items: [],
          total: 0,
          page: 1,
          page_size: Number(url.searchParams.get("page_size") || 12),
        });
    }
    unexpected.push(`${method} ${path}`);
    return reply(
      {
        error: { code: "UNEXPECTED", message: "Unexpected synthetic request" },
      },
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  // A cold Vite transform on a busy host can outlast the 7 s action timeout.
  await page.goto(`${origin}/__device-assignment#/${path}`, {
    timeout: 60000,
  });
}
const settings = () =>
  page.getByRole("region", { name: "Agent settings", exact: true });
const pipelineLink = () =>
  page.getByRole("link", { name: "View pipeline assignment", exact: true });
const settingsLink = () =>
  page.getByRole("link", { name: "View settings assignment", exact: true });
const deviceVisible = () =>
  expect(
    page.getByRole("heading", { name: "Synthetic edge", exact: true }),
  ).toBeVisible();
async function check(name, run) {
  const start = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - start });
  console.log("PASS", name);
}
try {
  await check(
    "new candidate failure stays separate from last verified generation; stale and legacy outcomes never label a new assignment as failed",
    async () => {
      const failed = {
        ...baseDevice(),
        status: "failed",
        apply_state: "failed",
        reported_apply_state: "failed",
        reported_generation: 4,
        configuration_attempt: {
          generation: 5,
          version_id: version.id,
          sha256: version.sha256,
          state: "failed",
          error: {
            code: "VALIDATION_FAILED",
            stage: "validation",
            message: "raw diagnostic must not appear",
          },
        },
      };
      await load({ device: failed });
      await deviceVisible();
      await expect(page.locator(".device-explanation")).toContainText(
        "Vector rejected this version on the device.",
      );
      await expect(page.locator("body")).not.toContainText(
        "raw diagnostic must not appear",
      );
      await page.getByText("Technical details", { exact: true }).click();
      const details = page.locator(".device-disclosure[open]");
      await expect(
        details.locator("dl > div").filter({
          has: page.locator("dt", { hasText: /^Last verified generation$/ }),
        }),
      ).toContainText("4");
      await expect(details).toContainText("Generation 5 · Failed");
      await expect(details).toContainText("Reported workload state");
      for (const mismatch of [
        { generation: 4 },
        { version_id: id(12) },
        { sha256: "b".repeat(64) },
      ]) {
        await load({
          device: {
            ...failed,
            status: "pending",
            apply_state: "desired",
            configuration_attempt: {
              ...failed.configuration_attempt,
              ...mismatch,
            },
          },
        });
        await deviceVisible();
        await expect(page.locator(".device-explanation")).toContainText(
          "Waiting for the agent to report an attempt",
        );
        await expect(page.locator(".device-explanation")).not.toContainText(
          "rejected this version",
        );
        await page.getByText("Technical details", { exact: true }).click();
        await expect(
          page.locator(".device-disclosure[open]"),
        ).not.toContainText("Generation 5 · Failed");
      }
      await load({
        device: {
          ...failed,
          configuration_attempt: undefined,
          reported_apply_state: undefined,
        },
      });
      await deviceVisible();
      await expect(page.locator(".device-explanation")).toContainText(
        "without identifying an attempt",
      );
      await load({
        device: {
          ...failed,
          apply_state: "verification_unknown",
          configuration_attempt: {
            ...failed.configuration_attempt,
            state: "verified_applied",
          },
        },
      });
      await deviceVisible();
      await expect(page.locator(".device-explanation")).toContainText(
        "could not confirm",
      );
      await expect(page.locator(".device-explanation")).not.toContainText(
        "verified that this version is active",
      );
    },
  );
  await check(
    "candidate failure context remains readable in both themes and widths without native diagnostics or mutation controls",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await load({
            width,
            theme,
            device: {
              ...baseDevice(),
              status: "failed",
              apply_state: "failed",
              reported_apply_state: "failed",
              reported_generation: 4,
              configuration_attempt: {
                generation: 5,
                version_id: version.id,
                sha256: version.sha256,
                state: "failed",
                error: {
                  code: "SECRET_RESOLUTION_FAILED",
                  stage: "materialization",
                  message: "sanitized",
                },
              },
            },
          });
          await deviceVisible();
          await expect(page.locator(".device-explanation")).toContainText(
            "could not resolve the local references",
          );
          await expect(
            page.getByRole("button", { name: "Retry application" }),
          ).toHaveCount(0);
          await page.getByText("Technical details", { exact: true }).click();
          const audit = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          accessibility.push({
            label: "Configuration attempt",
            width,
            theme,
            violations: audit.violations.map(({ id, impact }) => ({
              id,
              impact,
            })),
          });
          expect(audit.violations).toEqual([]);
          await page
            .getByRole("heading", { name: "Synthetic edge", exact: true })
            .click();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          const filename = `device-attempt-${width}-${theme}.png`;
          await page.screenshot({
            path: resolve(output, filename),
            fullPage: true,
            animations: "disabled",
          });
          screenshots.push(relative(repository, resolve(output, filename)));
        }
    },
  );
  await check(
    "configuration and policy links use separate canonical IDs, clear old list context, and remain read-only for viewers",
    async () => {
      await load({ path: "deployments?search=unrelated&status=failed&page=4" });
      await expect(
        page.getByRole("heading", { name: "Deployments", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          requests.some(
            (r) =>
              r.path === "/deployments/history" &&
              r.query.includes("search=unrelated"),
          ),
        )
        .toBe(true);
      await page.evaluate((id) => {
        location.hash = `/devices/${id}`;
      }, id(1));
      await deviceVisible();
      await expect(pipelineLink()).toHaveAttribute(
        "href",
        `#/deployments/${configurationAssignmentId}?page=1`,
      );
      await expect(settingsLink()).toHaveAttribute(
        "href",
        `#/deployments/${policyAssignmentId}?page=1`,
      );
      await expect(settings()).toContainText("priority 250");
      await expect(settings()).toContainText("120 seconds");
      await expect(
        settings()
          .locator(".control-summary-list > div")
          .filter({ has: page.locator("dt", { hasText: /^Metrics$/ }) }),
      ).toContainText("Disabled");
      await page.getByText("Technical details", { exact: true }).click();
      await expect(page.locator(".device-disclosure[open]")).toContainText(
        "Current independent policy winner",
      );
      await expect(page.locator(".device-disclosure[open]")).toContainText(
        "Current configuration winner",
      );
      await pipelineLink().click();
      await expect(page).toHaveURL(
        new RegExp(`#/deployments/${configurationAssignmentId}\\?page=1$`),
      );
      await expect(
        page.getByRole("region", { name: "Deployment details", exact: true }),
      ).toContainText("Synthetic governing pipeline");
      // The rollout is its own page; its route (checked above) already
      // dropped the old list search and page, which Back returns to.
      await expect(
        page.getByRole("button", { name: "Pause", exact: true }),
      ).toHaveCount(0);
      await page.goBack();
      await deviceVisible();
      await settingsLink().click();
      await expect(page).toHaveURL(
        new RegExp(`#/deployments/${policyAssignmentId}\\?page=1$`),
      );
      await expect(
        page.getByRole("region", { name: "Deployment details", exact: true }),
      ).toContainText("Synthetic governing settings");
    },
  );
  await check(
    "ordinary assignment links honor an app navigation veto without starting requests or mutations",
    async () => {
      await load();
      await deviceVisible();
      await page.evaluate(() => {
        window.deviceNavigationVeto = (event) => event.preventDefault();
        window.addEventListener(
          "vectory:before-navigate",
          window.deviceNavigationVeto,
        );
      });
      const before = requests.length;
      await pipelineLink().click();
      await expect(page).toHaveURL(new RegExp(`#/devices/${id(1)}$`));
      await expect(pipelineLink()).toBeVisible();
      expect(
        requests.slice(before).filter((r) => r.path.includes("/deployments/")),
      ).toEqual([]);
      await page.evaluate(() =>
        window.removeEventListener(
          "vectory:before-navigate",
          window.deviceNavigationVeto,
        ),
      );
      await settingsLink().click();
      await expect(
        page.getByRole("region", { name: "Deployment details", exact: true }),
      ).toBeVisible();
    },
  );
  await check(
    "absent bindings and legacy missing policy stay explicit; malformed typed identities fail closed",
    async () => {
      for (const effective of [
        { heartbeat_seconds: 60, sync_paused: false, telemetry_enabled: true },
        undefined,
      ]) {
        await load({
          device: {
            ...baseDevice(),
            assignment: undefined,
            policy_assignment: undefined,
            effective_policy: effective,
          },
        });
        await deviceVisible();
        await expect(pipelineLink()).toHaveCount(0);
        await expect(settingsLink()).toHaveCount(0);
        await expect(settings()).toContainText(
          "No settings assignment reported.",
        );
        await expect(settings()).not.toContainText("default");
        if (effective) await expect(settings()).toContainText("60 seconds");
        else
          await expect(settings()).toContainText(
            "Current agent settings have not been reported.",
          );
      }
      for (const invalid of ["javascript:alert(1)", `${id(20)}:${id(21)}`]) {
        await load({
          device: {
            ...baseDevice(),
            policy_assignment: {
              id: invalid,
              priority: 100,
              reason: "Malformed fixture",
            },
          },
        });
        await expect(page.getByRole("alert")).toContainText(
          "server response does not match",
        );
        await expect(settingsLink()).toHaveCount(0);
        await expect(pipelineLink()).toHaveCount(0);
      }
    },
  );
  await check(
    "unassigned devices with or without a file digest do not claim Vector is running and retain device selection in the pipeline chooser",
    async () => {
      for (const digest of [null, "a".repeat(64)]) {
        await load({
          role: "operator",
          device: {
            ...baseDevice(),
            desired_version_id: null,
            assignment: undefined,
            apply_state: "unmanaged",
            status: "unmanaged",
            actual_sha256: digest,
          },
        });
        await deviceVisible();
        const unassigned = page
          .locator(".device-pipeline")
          .filter({ hasText: "No pipeline assigned" });
        await expect(unassigned).toHaveCount(1);
        await expect(unassigned).toContainText(
          "An adopted local workload may continue running",
        );
        await expect(unassigned).toContainText("waits without starting Vector");
        await expect(unassigned).toContainText(
          "An agent check-in alone does not confirm a running workload",
        );
        await expect(unassigned).not.toContainText(
          "The agent keeps its existing",
        );
        await expect(pipelineLink()).toHaveCount(0);
        await settingsLink()
          .count()
          .then((count) => expect(count).toBe(1));
        // The button opens the same dialog as the Deployments page, with this
        // device already chosen; with nothing published the way on keeps it.
        await page
          .getByRole("button", { name: "Deploy a pipeline", exact: true })
          .click();
        const picker = page.getByRole("dialog", {
          name: "Deploy a pipeline to Synthetic edge",
        });
        await expect(picker).toBeVisible();
        await picker
          .getByRole("link", { name: "Start from a template", exact: true })
          .click();
        await expect(page).toHaveURL(
          new RegExp(`#/configurations\\?device=${id(1)}$`),
        );
        await expect(
          page.getByRole("heading", { name: "Pipelines", exact: true }),
        ).toBeVisible();
      }
    },
  );
  await check(
    "refresh keeps known context on error and ignores an older delayed binding response",
    async () => {
      await load();
      await deviceVisible();
      state.failNext = true;
      await page
        .getByRole("button", { name: "Refresh now", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "Synthetic device refresh failed",
      );
      await expect(settingsLink()).toHaveAttribute(
        "href",
        `#/deployments/${policyAssignmentId}?page=1`,
      );
      state.holdNext = true;
      await page
        .getByRole("button", { name: "Refresh now", exact: true })
        .click();
      await expect.poll(() => state.holds.length).toBe(1);
      state.device = {
        ...state.device,
        policy_assignment: {
          id: id(83),
          priority: 300,
          reason: "Newer policy winner",
        },
      };
      await page
        .getByRole("button", { name: "Refresh now", exact: true })
        .click();
      await expect(settingsLink()).toHaveAttribute(
        "href",
        `#/deployments/${id(83)}?page=1`,
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      state.holds.shift()();
      await expect(settings()).toContainText("priority 300");
      await expect(settingsLink()).toHaveAttribute(
        "href",
        `#/deployments/${id(83)}?page=1`,
      );
    },
  );
  await check(
    "device provenance is keyboard accessible and fits 899px and 375px in light and dark themes",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await load({ width, theme });
          await deviceVisible();
          await expect(settingsLink()).toBeVisible();
          await pipelineLink().focus();
          await expect(pipelineLink()).toBeFocused();
          // The settings link sits in the side column; reach it by keyboard.
          for (let step = 0; step < 60; step++) {
            if (
              await settingsLink().evaluate((n) => n === document.activeElement)
            )
              break;
            await page.keyboard.press("Tab");
          }
          await expect(settingsLink()).toBeFocused();
          const size = await page.evaluate(() => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
          }));
          geometry.push({ ...size, theme });
          expect(size.scrollWidth).toBeLessThanOrEqual(width);
          for (const link of [pipelineLink(), settingsLink()]) {
            const box = await link.boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
          }
          const audit = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          accessibility.push({
            width,
            theme,
            violations: audit.violations.map(({ id, impact }) => ({
              id,
              impact,
            })),
          });
          expect(audit.violations).toEqual([]);
          await page
            .getByRole("heading", { name: "Synthetic edge", exact: true })
            .click();
          const filename = `device-assignments-${width}-${theme}.png`;
          await page.screenshot({
            path: resolve(output, filename),
            fullPage: true,
            animations: "disabled",
          });
          screenshots.push(relative(repository, resolve(output, filename)));
        }
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
} catch (error) {
  failure = error;
} finally {
  for (const release of state?.holds || []) release();
  await context?.close();
  await browser.close();
  await vite.close();
  const source_sha256 = {};
  for (const path of [
    "dashboard/src/Fleet.tsx",
    "dashboard/src/DeviceDetail.tsx",
    "dashboard/src/deviceApplication.ts",
    "dashboard/src/devices.css",
    "dashboard/src/deploymentRouting.ts",
    "dashboard/src/api.ts",
    "dashboard/src/ui.tsx",
    "dashboard/tests/device-assignment-browser.mjs",
    "docs/user/telemetry.md",
  ])
    source_sha256[path] = createHash("sha256")
      .update(await readFile(resolve(repository, path)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        passed: !failure,
        scope:
          "Actual App, Fleet and deployment inspector with intercepted synthetic transport only. All expected requests are GET. No preview credentials, live devices, real assignments, native Vector runtime or activation.",
        results,
        requests,
        unexpected,
        errors,
        accessibility,
        geometry,
        screenshots,
        source_sha256,
        failure: failure ? String(failure.stack || failure) : undefined,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: results.length,
    evidence: relative(repository, resolve(output, "report.json")),
  }),
);
