// Actual account/metrics tables with synthetic data only; no real API mutations.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_ACCOUNT_METRICS_TABLES_OUTPUT ||
    ".local/account-metrics-tables",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:account-metrics-tables";
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, proxy: {}, hmr: false },
  plugins: [
    {
      name: "account-metrics-tables-fixture",
      resolveId(id) {
        if (id === "virtual:account-metrics-tables") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{WorkspaceAccess}from'/src/AccountAccess.tsx';import TelemetryPanel from'/src/TelemetryPanel.tsx';import'/src/styles.css';import'/src/control.css';import'/src/fleet.css';const root=createRoot(document.getElementById('root'));let key=0;
      function People({initial}){const[people,setPeople]=useState(initial),[saved,setSaved]=useState(null);window.updatePerson=(person)=>{setPeople(old=>old.map(p=>p.id===person.id?person:p));setSaved(person);};return React.createElement(WorkspaceAccess,{user:initial[0],people,reload:()=>{},notify:()=>{},onUserChanged:()=>{},savedPerson:saved,onPersonLocated:()=>setSaved(null)});}
      window.renderPeople=initial=>root.render(React.createElement(People,{key:++key,initial}));window.renderMetrics=device=>root.render(React.createElement(TelemetryPanel,{key:++key,device}));window.ready=true;`;
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__table-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic table verification</title></head><body><main style="padding:16px;min-width:0"><h1>Synthetic table verification</h1><div id="root"></div></main><script type="module">import "virtual:account-metrics-tables";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
  esbuild: {
    include: /(?:virtual:account-metrics-tables|\.tsx?$)/,
    loader: "tsx",
  },
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch();
const id = (n) => `abcdefab-1234-4000-8000-${String(n).padStart(12, "0")}`;
const people = Array.from({ length: 29 }, (_, n) => ({
  id: id(n + 1),
  name: n === 0 ? "Administrator" : `Person ${n}`,
  email: `person${n}@fixture.example.test`,
  role: n === 0 ? "admin" : n % 3 === 0 ? "operator" : "viewer",
  enabled: n % 5 !== 0 || n === 0,
  revision: 1,
}));
const components = [
  { id: "missing", type: "blackhole", events_per_second: null, errors: null },
  { id: "ten", type: "http", events_per_second: 10, errors: 3 },
  { id: "two", type: "demo_logs", events_per_second: 2, errors: 10 },
  { id: "zero", type: "filter", events_per_second: 0, errors: 0 },
];
const samples = [
  { sampled_at: "2026-09-26T12:00:00Z", events_per_second: 10, errors: 8 },
  {
    sampled_at: "2026-09-26T12:02:00Z",
    events_per_second: 0,
    errors: 10,
    components,
  },
  { sampled_at: "2026-09-26T12:04:00Z", errors: 12 },
];
// A 10 s check-in: the empty 12:01 slot is a missed report, drawn as a gap.
const device = {
  id: id(100),
  name: "Synthetic device",
  effective_policy: {
    heartbeat_seconds: 10,
    sync_paused: false,
    telemetry_enabled: true,
  },
  telemetry: samples[1],
};
const results = [],
  accessibility = [],
  scrolling = [],
  calls = [],
  errors = [],
  unexpected = [];
async function fixture() {
  const context = await browser.newContext({
    viewport: { width: 899, height: 960 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const call = { method: route.request().method(), path };
    calls.push(call);
    if (
      path === `/api/v1/devices/${device.id}/telemetry` &&
      call.method === "GET"
    )
      return route.fulfill({ json: { device_id: device.id, samples } });
    unexpected.push(call);
    return route.fulfill({
      status: 500,
      json: {
        error: { code: "UNEXPECTED", message: "Unexpected synthetic request" },
      },
    });
  });
  // A cold dev-server transform can exceed the action timeout on a busy host.
  await page.goto(`${origin}/__table-fixture`, { timeout: 60000 });
  await page.waitForFunction(() => window.ready);
  return { page, close: () => context.close() };
}
async function check(name, fn) {
  await fn();
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
async function headerFilter(page, name) {
  await page
    .getByRole("button", {
      name: new RegExp(`^Filter ${name}(?: \\(active\\))?$`),
    })
    .click();
}
const rowNames = (table) =>
  table.locator("tbody tr td:first-child strong").allTextContents();
try {
  await check(
    "People sort and filter the entire collection before pagination; empty headers remain usable",
    async () => {
      const f = await fixture();
      try {
        await f.page.evaluate((people) => window.renderPeople(people), people);
        const table = f.page.getByRole("table", {
          name: "Workspace access",
          exact: true,
        });
        await expect(table.locator("tbody tr")).toHaveCount(12);
        await f.page.getByRole("button", { name: /^Sort by Name/ }).click();
        expect((await rowNames(table))[0]).toBe("Person 28");
        await f.page.getByRole("button", { name: "Next", exact: true }).click();
        expect((await rowNames(table))[0]).toBe("Person 16");
        await headerFilter(f.page, "Role");
        await f.page
          .getByRole("radio", { name: "Operator", exact: true })
          .click();
        expect(await rowNames(table)).toEqual([
          "Person 27",
          "Person 24",
          "Person 21",
          "Person 18",
          "Person 15",
          "Person 12",
          "Person 9",
          "Person 6",
          "Person 3",
        ]);
        await headerFilter(f.page, "Status");
        await f.page
          .getByRole("radio", { name: "Disabled", exact: true })
          .click();
        expect(await rowNames(table)).toEqual(["Person 15"]);
        await headerFilter(f.page, "Name");
        await f.page
          .getByRole("textbox", { name: "Filter Name", exact: true })
          .fill("Nobody");
        await f.page.keyboard.press("Escape");
        await expect(table).toContainText(
          "No people match your search or filters.",
        );
        await expect(
          table.getByRole("button", {
            name: "Filter Role (active)",
            exact: true,
          }),
        ).toBeVisible();
        expect(calls).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Updated person is located under the current sort and clears only excluding filters",
    async () => {
      const f = await fixture();
      try {
        await f.page.evaluate((people) => window.renderPeople(people), people);
        await headerFilter(f.page, "Role");
        await f.page
          .getByRole("radio", { name: "Viewer", exact: true })
          .click();
        await headerFilter(f.page, "Status");
        await f.page
          .getByRole("radio", { name: "Active", exact: true })
          .click();
        const changed = {
          ...people[1],
          name: "Zebra saved",
          role: "operator",
          revision: 2,
        };
        await f.page.evaluate((person) => window.updatePerson(person), changed);
        await expect(
          f.page.getByRole("button", { name: "Edit access for Zebra saved" }),
        ).toBeVisible();
        await expect(
          f.page.getByRole("button", {
            name: "Filter Status (active)",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          f.page.getByRole("button", { name: "Filter Role", exact: true }),
        ).toBeVisible();
        await f.page
          .getByRole("button", { name: "Edit access for Zebra saved" })
          .click();
        await expect(
          f.page.getByRole("dialog", { name: "Edit workspace access" }),
        ).toBeVisible();
        await f.page.keyboard.press("Escape");
        expect(calls).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "Metric numeric sorts preserve zero, keep missing last, and leave chronological chart semantics unchanged",
    async () => {
      const f = await fixture();
      try {
        await f.page.evaluate((device) => window.renderMetrics(device), device);
        const table = f.page.getByRole("table", {
          name: "Component metrics",
          exact: true,
        });
        await expect(table.locator("tbody tr")).toHaveCount(4);
        const path = f.page.locator(".telemetry-series.in path").first(),
          original = await path.getAttribute("d");
        await table.getByRole("button", { name: /^Sort by Out \/ s/ }).click();
        expect(await rowNames(table)).toEqual([
          "zero",
          "two",
          "ten",
          "missing",
        ]);
        await table.getByRole("button", { name: /^Sort by Out \/ s/ }).click();
        expect(await rowNames(table)).toEqual([
          "ten",
          "two",
          "zero",
          "missing",
        ]);
        await table
          .getByRole("button", { name: "Filter Out / s", exact: true })
          .click();
        await f.page
          .getByRole("textbox", { name: "Filter Out / s", exact: true })
          .fill("0");
        await f.page.keyboard.press("Escape");
        expect(await rowNames(table)).toEqual(["ten", "zero"]);
        await f.page
          .getByText("View samples as a table", { exact: true })
          .click();
        const history = f.page.getByRole("table", {
          name: "Metric samples",
          exact: true,
        });
        await expect(history.locator("tbody tr")).toHaveCount(3);
        await history.getByRole("button", { name: /^Sort by In \/ s/ }).click();
        expect(
          await history.locator("tbody tr td:nth-child(2)").allTextContents(),
        ).toEqual(["0", "10", "—"]);
        await history.getByRole("button", { name: /^Sort by In \/ s/ }).click();
        expect(
          await history.locator("tbody tr td:nth-child(2)").allTextContents(),
        ).toEqual(["10", "0", "—"]);
        await expect(path).toHaveAttribute("d", original);
        await f.page
          .getByRole("img", { name: /^Throughput, events \/ second/ })
          .focus();
        await f.page.keyboard.press("ArrowLeft");
        await expect(
          f.page.locator(".telemetry-readout").first(),
        ).toContainText("No report");
        expect(calls.every((call) => call.method === "GET")).toBe(true);
      } finally {
        await f.close();
      }
    },
  );
  await check(
    "People and telemetry headers remain visible, scrollable and accessible at desktop/mobile in both themes",
    async () => {
      const f = await fixture();
      try {
        for (const view of ["people", "metrics"]) {
          if (view === "people")
            await f.page.evaluate(
              (people) => window.renderPeople(people),
              people,
            );
          else
            await f.page.evaluate(
              (device) => window.renderMetrics(device),
              device,
            );
          for (const [width, theme] of [
            [899, "light"],
            [375, "dark"],
          ]) {
            await f.page.setViewportSize({ width, height: 960 });
            await f.page.evaluate(
              (theme) => (document.documentElement.dataset.theme = theme),
              theme,
            );
            // On a phone, people are cards with their actions in view.
            const cards = view === "people" && width < 760;
            const table = f.page.getByRole("table").first();
            if (cards) {
              await expect(table).toBeHidden();
              const list = f.page.getByRole("list", {
                name: "Workspace access",
                exact: true,
              });
              await expect(list).toBeVisible();
              await expect(list.getByRole("listitem")).toHaveCount(
                people.length,
              );
              await expect(
                list.getByRole("button", {
                  name: "Edit access for Person 3",
                  exact: true,
                }),
              ).toBeVisible();
            } else {
              await expect(table.locator("thead")).toBeVisible();
              await expect(
                table.getByRole("columnheader").first(),
              ).toBeVisible();
            }
            const axe = await new AxeBuilder({ page: f.page }).analyze();
            accessibility.push({
              view,
              width,
              theme,
              violations: axe.violations,
            });
            expect(axe.violations).toEqual([]);
            expect(
              await f.page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            if (!cards) {
              const region = f.page.getByRole("region", {
                name:
                  view === "people"
                    ? "Workspace access table"
                    : "Component metrics table",
                exact: true,
              });
              // Only a region that actually scrolls sideways is a keyboard
              // stop; one that fits has nothing to scroll and no tab stop.
              const scrolls = await region.evaluate(
                (node) => node.scrollWidth > node.clientWidth + 1,
              );
              scrolling.push({ view, width, scrolls });
              if (scrolls) {
                await expect(region).toHaveAttribute("tabindex", "0");
                await region.focus();
                await expect(region).toBeFocused();
                await f.page.keyboard.press("End");
                await f.page.keyboard.press("ArrowRight");
              } else await expect(region).not.toHaveAttribute("tabindex");
            }
            await f.page.screenshot({
              path: resolve(output, `${view}-${width}-${theme}.png`),
              fullPage: true,
            });
          }
        }
      } finally {
        await f.close();
      }
    },
  );
  // The keyboard path was exercised, not only the absence of a tab stop.
  expect(scrolling.some((entry) => entry.scrolls)).toBe(true);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  const hashes = {};
  for (const file of [
    "src/AccountAccess.tsx",
    "src/TelemetryPanel.tsx",
    "src/DataTable.tsx",
    "src/dataTableModel.ts",
    "src/control.css",
  ])
    hashes[`dashboard/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, file)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Actual account and telemetry components with synthetic local fixtures; no real accounts or device mutation",
        results,
        accessibility,
        scrolling,
        calls,
        errors,
        unexpected,
        hashes,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Evidence: ${relative(repository, resolve(output, "report.json"))}`,
  );
} catch (error) {
  await writeFile(
    resolve(output, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        results,
        accessibility,
        calls,
        errors,
        unexpected,
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser.close();
  await vite.close();
}
