// Real history component, synthetic HTTP fixtures; no production/preview state.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_HISTORY_OUTPUT || ".local/pipeline-history-component",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:pipeline-history-fixture";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [
    {
      name: "pipeline-history-test-fixture",
      resolveId(id) {
        if (id === "virtual:pipeline-history-fixture") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
import PipelineHistory from '/src/PipelineHistory.tsx'; import '/src/styles.css';
const root=createRoot(document.getElementById('root')); let generation=0;
window.renderHistory=(props)=>{window.historyProps=props;window.restored=[];window.deployed=[];window.historyCloseCount=0;window.restoreFailure='';generation++;window.updateHistory({});};
window.updateHistory=(patch)=>{Object.assign(window.historyProps,patch);root.render(React.createElement(PipelineHistory,{...window.historyProps,key:generation,onClose:()=>window.historyCloseCount++,onDeploy:v=>window.deployed.push(v.id),onRestore:async source=>{window.restored.push(source);if(window.restoreFailure)throw Error(window.restoreFailure);return true;}}));}; window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__history-fixture") return next();
          const html = await vite.transformIndexHtml(
            "/__history-fixture",
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pipeline history component verification</title></head><body><main style="padding:24px"><h1>Synthetic history verification</h1><div id="root"></div></main><script type="module">import "virtual:pipeline-history-fixture";</script></body></html>',
          );
          response.setHeader("Content-Type", "text/html");
          response.end(html);
        });
      },
    },
  ],
});
await server.listen();
const origin = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 960 },
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const requests = [],
  results = [],
  errors = [],
  accessibility = [],
  screenshots = [];
page.on("pageerror", (error) => errors.push(error.message));
const values = Object.fromEntries(
  Array.from({ length: 40 }, (_, index) => [`setting_${index}`, index]),
);
const original = {
  "field.with.dot": null,
  items: [1, 2],
  opaque: { retained: true },
  values,
};
const draft = {
  "field.with.dot": "",
  items: [2, 1],
  opaque: { retained: true },
  values: Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value + 1]),
  ),
};
const configuration = {
  id: "synthetic-pipeline",
  name: "Synthetic history",
  description: "",
  revision: 40,
  config: draft,
  graph: { nodes: [], edges: [] },
  archived: false,
  created_at: "2026-09-01T12:00:00Z",
  updated_at: "2026-09-26T12:00:00Z",
};
const user = {
  id: "synthetic-admin",
  email: "history@example.test",
  name: "Synthetic author",
  role: "admin",
  enabled: true,
  revision: 1,
};
const version = (number) => ({
  id: `v${number}`,
  configuration_id: configuration.id,
  number,
  config: { ...original, marker: number },
  graph: { nodes: [], edges: [] },
  artifact: "{}",
  sha256: "a".repeat(64),
  size: 2,
  validation: {},
  created_at: "2026-09-26T12:00:00Z",
  message: `Version ${number} change`,
  author: "Synthetic author",
  author_id: "synthetic-author",
  source_revision: number + 1,
});
const revision = (number) => ({
  id: `r${number}`,
  configuration_id: configuration.id,
  revision: number,
  config: { ...original, marker: number * 10 },
  graph: { nodes: [], edges: [] },
  created_at: "2026-09-26T12:00:00Z",
  message: `Revision ${number} change`,
  source: { kind: "version", id: "v1" },
});
let delayed = "";
const versionConfigs = new Map();
await page.route("**/api/v1/**", async (route) => {
  const url = new URL(route.request().url());
  if (route.request().method() !== "GET")
    throw Error(
      `Unexpected mutation: ${route.request().method()} ${url.pathname}`,
    );
  requests.push(url.pathname + url.search);
  let body;
  if (url.pathname.endsWith("/history")) {
    const kind = url.searchParams.get("kind"),
      selectedPage = Number(url.searchParams.get("page")),
      size = Number(url.searchParams.get("page_size"));
    if (size !== 12) throw Error("History page was not bounded to12");
    const source = Array.from(
      { length: kind === "versions" ? 30 : 40 },
      (_, index) =>
        kind === "versions" ? version(30 - index) : revision(40 - index),
    );
    body = {
      total: source.length,
      page: selectedPage,
      page_size: size,
      items: source
        .slice((selectedPage - 1) * size, selectedPage * size)
        .map(
          ({ config, graph, artifact, validation, ...metadata }) => metadata,
        ),
    };
  } else if (/\/versions\/v\d+$/.test(url.pathname)) {
    body = version(Number(url.pathname.split("/").at(-1).slice(1)));
    if (versionConfigs.has(body.id)) body.config = versionConfigs.get(body.id);
  } else if (/\/revisions\/r\d+$/.test(url.pathname))
    body = revision(Number(url.pathname.split("/").at(-1).slice(1)));
  else throw Error(`Unexpected fixture request: ${url.pathname}`);
  if (url.pathname.endsWith(delayed) && delayed) await delay(500);
  try {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  } catch {
    /* An obsolete snapshot read can be aborted. */
  }
});
async function fixture(extra = {}) {
  await page.evaluate((props) => window.renderHistory(props), {
    configuration,
    draft,
    user,
    hasPendingFields: false,
    ...extra,
  });
  await expect(
    page.getByRole("heading", { name: "Version 30", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore as draft", exact: true }),
  ).toBeEnabled();
}
function change(path) {
  return page.locator(".history-change").filter({
    has: page.locator(".history-change-heading code").filter({ hasText: path }),
  });
}
async function lineValues(change, kind) {
  return change
    .locator(`.history-diff-line[data-kind="${kind}"] .history-diff-code`)
    .allTextContents();
}
async function smallFixture() {
  versionConfigs.set("v30", {
    "field.with.dot": null,
    items: [1, 2],
    object: { retained: true },
    removed: "prior",
    text: "before",
  });
  await fixture({
    draft: {
      added: { enabled: true, tags: ["one", "two"] },
      "field.with.dot": "",
      items: [2, 1],
      object: { retained: true },
      text: "after",
    },
  });
}
async function check(name, operation) {
  try {
    await operation();
    results.push({ name, passed: true });
    console.log("PASS", name);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    throw error;
  }
}
try {
  await page.goto(new URL("/__history-fixture", origin).href);
  await page.waitForFunction(() => window.ready);
  await check("bounded metadata and path-aware typed changes", async () => {
    await fixture();
    await expect(
      page.getByText("Published from draft revision 31.", { exact: true }),
    ).toBeVisible();
    await page.getByText("Snapshot details", { exact: true }).click();
    await expect(page.locator(".history-provenance")).toContainText(
      "synthetic-author",
    );
    await expect(page.locator(".history-provenance")).toContainText("v30");
    await page.getByText("Snapshot details", { exact: true }).click();
    expect(await page.locator(".history-sidebar .history-row").count()).toBe(
      12,
    );
    expect(await page.locator(".history-change").count()).toBe(25);
    await expect(
      page.locator(".history-change-heading code").first(),
    ).toHaveText('["field.with.dot"]');
    await expect(page.locator(".history-change").first()).toContainText("null");
    await expect(page.locator(".history-change").first()).toContainText('""');
    await expect(page.locator(".history-comparison strong")).toHaveText([
      "Version 30",
      "Current draft",
    ]);
    const first = page.locator(".history-change").first();
    await expect(first.locator(".history-change-status")).toContainText(
      "Modified",
    );
    expect(await lineValues(first, "removed")).toEqual(["null"]);
    expect(await lineValues(first, "added")).toEqual(['""']);
    await expect(
      first.locator('[data-kind="removed"] .history-line-marker [aria-hidden]'),
    ).toHaveText("−");
    await expect(
      first.locator('[data-kind="added"] .history-line-marker [aria-hidden]'),
    ).toHaveText("+");
    await expect(first.locator('[data-kind="removed"]')).toHaveAttribute(
      "data-before-line",
      "1",
    );
    await expect(first.locator('[data-kind="removed"]')).not.toHaveAttribute(
      "data-after-line",
    );
    await expect(first.locator('[data-kind="added"]')).toHaveAttribute(
      "data-after-line",
      "1",
    );
    await expect(first.locator('[data-kind="added"]')).not.toHaveAttribute(
      "data-before-line",
    );
    await page
      .locator(".history-preview .pagination")
      .getByRole("button", { name: "Next", exact: true })
      .click();
    expect(await page.locator(".history-change").count()).toBe(19);
    expect(
      requests.some((path) => /\/configurations\/[^/]+\/versions$/.test(path)),
    ).toBe(false);
    await page
      .getByRole("button", { name: "Configuration", exact: true })
      .click();
    expect(
      JSON.parse(
        await page.getByLabel("Version 30 configuration JSON").inputValue(),
      ).opaque,
    ).toEqual({ retained: true });
    await expect(
      page.getByLabel("Version 30 configuration JSON"),
    ).toHaveAttribute("readonly", "");
  });
  await check(
    "paginated histories compare arbitrary snapshots and ignore obsolete reads",
    async () => {
      await fixture();
      const list = page.getByRole("complementary", { name: "Saved snapshots" });
      await list.getByRole("button", { name: "Next", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Version 18", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Choose comparison", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Choose comparison",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Draft revisions", exact: true })
        .click();
      await dialog.getByRole("button", { name: "Next", exact: true }).click();
      await dialog
        .getByRole("button", { name: "Compare with revision 28", exact: true })
        .click();
      await expect(page.locator(".history-comparison")).toContainText(
        "Revision 28",
      );
      await expect(page.locator(".history-change")).toHaveCount(1);
      await expect(page.locator(".history-change")).toContainText("280");
      await expect(page.locator(".history-comparison strong")).toHaveText([
        "Version 18",
        "Revision 28",
      ]);
      expect(
        await lineValues(page.locator(".history-change"), "removed"),
      ).toEqual(["18"]);
      expect(
        await lineValues(page.locator(".history-change"), "added"),
      ).toEqual(["280"]);
      await list.getByRole("button", { name: "Previous", exact: true }).click();
      await expect(
        list.getByRole("button", { name: "View version 30", exact: true }),
      ).toBeVisible();
      delayed = "/v29";
      await list
        .getByRole("button", { name: "View version 29", exact: true })
        .click();
      await list
        .getByRole("button", { name: "View version 28", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Configuration", exact: true })
        .click();
      await expect(
        page.getByLabel("Version 28 configuration JSON"),
      ).toContainText('"marker": 28');
      await delay(600);
      await expect(
        page.getByLabel("Version 28 configuration JSON"),
      ).toContainText('"marker": 28');
      delayed = "";
    },
  );
  await check(
    "unified added, removed and modified values preserve direction and typed data",
    async () => {
      await smallFixture();
      const summary = page.getByRole("group", {
        name: "Change summary",
        exact: true,
      });
      await expect(summary).toContainText(/1 added/);
      await expect(summary).toContainText(/1 removed/);
      await expect(summary).toContainText(/4 modified/);
      await expect(page.locator(".history-change")).toHaveCount(6);
      const added = change("added");
      await expect(added.locator(".history-change-status")).toContainText(
        "Added",
      );
      expect(await lineValues(added, "removed")).toEqual([]);
      const addedLines = JSON.stringify(
        { enabled: true, tags: ["one", "two"] },
        null,
        2,
      ).split("\n");
      expect(await lineValues(added, "added")).toEqual(addedLines);
      expect(
        await added
          .locator(".history-diff-line")
          .evaluateAll((rows) =>
            rows.map((row) => [
              row.getAttribute("data-before-line"),
              row.getAttribute("data-after-line"),
            ]),
          ),
      ).toEqual(addedLines.map((_, index) => [null, String(index + 1)]));
      const removed = change("removed");
      await expect(removed.locator(".history-change-status")).toContainText(
        "Removed",
      );
      expect(await lineValues(removed, "removed")).toEqual(['"prior"']);
      expect(await lineValues(removed, "added")).toEqual([]);
      expect(await lineValues(change("items[0]"), "removed")).toEqual(["1"]);
      expect(await lineValues(change("items[0]"), "added")).toEqual(["2"]);
      expect(await lineValues(change("items[1]"), "removed")).toEqual(["2"]);
      expect(await lineValues(change("items[1]"), "added")).toEqual(["1"]);
      await expect(change("object")).toHaveCount(0);
      versionConfigs.clear();
    },
  );
  await check(
    "key ordering alone is unchanged; large values render progressively without data loss",
    async () => {
      versionConfigs.set("v30", { z: { b: false, a: null }, a: [0, ""] });
      await fixture({ draft: { a: [0, ""], z: { a: null, b: false } } });
      await expect(
        page.getByText("No configuration differences.", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".history-change")).toHaveCount(0);
      const large = Array.from({ length: 130 }, (_, index) =>
        index === 129 ? `synthetic-${"x".repeat(300)}` : `synthetic-${index}`,
      );
      versionConfigs.set("v30", { shared: true });
      await fixture({ draft: { shared: true, large } });
      const largeChange = change("large");
      await expect(largeChange.locator(".history-diff-line")).toHaveCount(80);
      await expect(largeChange).toContainText("80 of 132 lines");
      await largeChange
        .getByRole("button", { name: "Show next 52 lines", exact: true })
        .click();
      expect(await lineValues(largeChange, "added")).toEqual(
        JSON.stringify(large, null, 2).split("\n"),
      );
      await expect(largeChange.locator(".history-diff-line")).toHaveCount(132);
      await expect(
        largeChange.getByRole("button", { name: /^Show next/ }),
      ).toHaveCount(0);
      await expect(largeChange).toContainText("132 of 132 lines");
      await expect(
        largeChange.locator(".history-diff-line").last(),
      ).toHaveAttribute("data-after-line", "132");
      const scroll = largeChange.getByRole("region");
      await expect(scroll).toHaveAttribute("tabindex", "0");
      await scroll.focus();
      await expect(scroll).toBeFocused();
      if (
        await scroll.evaluate(
          (element) => element.scrollWidth > element.clientWidth,
        )
      ) {
        await page.keyboard.press("ArrowRight");
        await expect
          .poll(() => scroll.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0);
      }
      await page
        .getByRole("button", { name: "Configuration", exact: true })
        .click();
      expect(
        JSON.parse(
          await page.getByLabel("Version 30 configuration JSON").inputValue(),
        ),
      ).toEqual({ shared: true });
      versionConfigs.clear();
    },
  );
  await check(
    "restore confirmation retains errors and gates pending or archived drafts",
    async () => {
      await fixture();
      await page.evaluate(() =>
        window.updateHistory({ hasPendingFields: true }),
      );
      await expect(
        page.getByRole("button", { name: "Restore as draft", exact: true }),
      ).toBeDisabled();
      await page.evaluate(() =>
        window.updateHistory({
          hasPendingFields: false,
          configuration: {
            ...window.historyProps.configuration,
            archived: true,
          },
        }),
      );
      await expect(
        page.getByRole("button", { name: "Restore as draft", exact: true }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: "Deploy this version", exact: true })
        .click();
      expect(await page.evaluate(() => window.deployed)).toEqual(["v30"]);
      await page.evaluate(() => {
        window.updateHistory({
          configuration: {
            ...window.historyProps.configuration,
            archived: false,
          },
        });
        window.restoreFailure = "The draft changed. Refresh and review it.";
      });
      await page
        .getByRole("button", { name: "Restore as draft", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Restore version 30 as draft?",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Restore draft", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toContainText(
        "The draft changed.",
      );
      expect(await page.evaluate(() => window.historyCloseCount)).toBe(0);
      await page.evaluate(() => {
        window.restoreFailure = "";
      });
      await dialog
        .getByRole("button", { name: "Restore draft", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.historyCloseCount))
        .toBe(1);
      expect(await page.evaluate(() => window.restored)).toEqual([
        { version_id: "v30" },
        { version_id: "v30" },
      ]);
    },
  );
  await check(
    "viewer controls and mobile dark/light accessibility",
    async () => {
      await smallFixture();
      await page.evaluate(() =>
        window.updateHistory({
          user: { ...window.historyProps.user, role: "viewer" },
        }),
      );
      await expect(
        page.getByRole("button", { name: "Restore as draft", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Deploy this version", exact: true }),
      ).toHaveCount(0);
      for (const [width, theme] of [
        [899, "light"],
        [899, "dark"],
        [375, "light"],
        [375, "dark"],
      ]) {
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme,
        );
        await page.setViewportSize({ width, height: 960 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width + 1);
        // Tables take a tab stop only when they scroll sideways.
        const diffScroll = page.locator(".history-diff-scroll").first();
        if (
          await diffScroll.evaluate(
            (node) => node.scrollWidth > node.clientWidth + 1,
          )
        )
          await expect(diffScroll).toHaveAttribute("tabindex", "0");
        else await expect(diffScroll).not.toHaveAttribute("tabindex", "0");
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        expect(
          axe.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
          })),
        ).toEqual([]);
        accessibility.push({ width, theme, violations: axe.violations.length });
        const screenshot = `history-diff-${width}-${theme}.png`;
        await page.locator(".history-preview").screenshot({
          path: resolve(output, screenshot),
        });
        screenshots.push(screenshot);
      }
      versionConfigs.clear();
    },
  );
  expect(errors).toEqual([]);
} finally {
  const sources = {};
  for (const name of [
    "dashboard/src/PipelineHistory.tsx",
    "dashboard/src/HistoryChange.tsx",
    "dashboard/src/pipeline-history.css",
    "dashboard/src/historyDiff.ts",
    "dashboard/tests/pipeline-history-browser.mjs",
  ]) {
    try {
      sources[name] = createHash("sha256")
        .update(await readFile(resolve(repository, name)))
        .digest("hex");
    } catch {
      sources[name] = null;
    }
  }
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        scope:
          "Actual React history component with explicitly synthetic HTTP fixtures and locally recorded action callbacks; not backend or native activation acceptance.",
        checks: results,
        accessibility,
        screenshots,
        page_errors: errors,
        requests,
        source_sha256: sources,
      },
      null,
      2,
    ),
  );
  await context.close();
  await browser.close();
  await server.close();
}
