import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const output = path.join(root, "site/dist");
const captures = path.join(root, ".local/site-browser");
const require = createRequire(path.join(root, "dashboard/package.json"));
const { chromium, expect } = require("@playwright/test");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".webp": "image/webp",
};

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    let file = path.resolve(output, `.${pathname}`);
    if (!file.startsWith(output + path.sep) && file !== output)
      throw Error("Invalid path");
    if ((await fs.stat(file)).isDirectory())
      file = path.join(file, "index.html");
    response.setHeader(
      "Content-Type",
      mime[path.extname(file)] || "application/octet-stream",
    );
    response.end(await fs.readFile(file));
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
const disallowedRequests = [];
const fixture =
  "# synthetic browser regression\napi:\n  enabled: false\nsources:\n  events:\n    type: demo_logs\n    format: json\ntransforms:\n  sample:\n    type: sample\n    inputs: [events]\n    rate: 10\nsinks:\n  out:\n    type: console\n    inputs: [sample]\n    encoding:\n      codec: json\ncustom:\n  future_setting: kept\n";

try {
  await fs.mkdir(captures, { recursive: true });
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      !request.url().startsWith(origin + "/") ||
      /\/api\//.test(request.url())
    )
      disallowedRequests.push(request.url());
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.addInitScript(() => {
    window.__storageWrites = 0;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args) {
      window.__storageWrites++;
      return original.apply(this, args);
    };
  });

  async function importSource(source, format = "yaml") {
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import a configuration" });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("textbox", { name: "Configuration code", exact: true })
      .fill(source);
    await dialog
      .getByRole("combobox", { name: "Format", exact: true })
      .selectOption(format);
    await dialog
      .getByRole("button", { name: "Visualize configuration" })
      .click();
    await expect(dialog).not.toBeVisible();
  }
  async function exported(format) {
    const pending = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name: `Export ${format.toUpperCase()}`,
        exact: true,
      })
      .click();
    const download = await pending;
    return fs.readFile(await download.path(), "utf8");
  }
  async function noOverflow() {
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Page overflows the viewport",
    );
  }

  await page.goto(origin + "/designer/");
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Example", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.getByRole("status")).toContainText("Synthetic example");
  const detailsTab = page.getByRole("tab", { name: "Details", exact: true });
  const codeTab = page.getByRole("tab", { name: "Code", exact: true });
  const detailsPanel = page.locator("#designer-details-panel");
  const codePanel = page.locator("#designer-code-panel");
  await expect(detailsTab).toHaveAttribute(
    "aria-controls",
    "designer-details-panel",
  );
  await expect(codeTab).toHaveAttribute("aria-controls", "designer-code-panel");
  await expect(detailsPanel).toHaveAttribute(
    "aria-labelledby",
    "designer-details-tab",
  );
  await expect(codePanel).toHaveAttribute(
    "aria-labelledby",
    "designer-code-tab",
  );
  await expect(detailsPanel).toBeVisible();
  await expect(codePanel).toBeHidden();
  await detailsTab.focus();
  await detailsTab.press("ArrowRight");
  await expect(codeTab).toBeFocused();
  await expect(codeTab).toHaveAttribute("aria-selected", "true");
  await expect(codePanel).toBeVisible();
  await expect(detailsPanel).toBeHidden();
  await codeTab.press("Home");
  await expect(detailsTab).toBeFocused();
  await detailsTab.press("ArrowLeft");
  await expect(codeTab).toBeFocused();
  await codeTab.press("ArrowRight");
  await expect(detailsTab).toBeFocused();
  await detailsTab.press("End");
  await expect(codeTab).toBeFocused();
  await codeTab.press("Home");
  await expect(detailsTab).toBeFocused();

  await page
    .getByRole("button", { name: "Add component", exact: true })
    .first()
    .click();
  const picker = page.getByRole("dialog", { name: "Add a component" });
  const categories = picker.getByRole("group", { name: "Component category" });
  const sources = categories.getByRole("button", {
    name: "Sources",
    exact: true,
  });
  const transforms = categories.getByRole("button", {
    name: "Transforms",
    exact: true,
  });
  await expect(sources).toHaveAttribute("aria-pressed", "true");
  await sources.focus();
  await sources.press("Tab");
  await expect(transforms).toBeFocused();
  await transforms.press("Enter");
  await expect(transforms).toHaveAttribute("aria-pressed", "true");
  await expect(sources).toHaveAttribute("aria-pressed", "false");
  await picker.getByRole("button", { name: "Close component picker" }).click();
  await page
    .getByRole("combobox", { name: "Connection style" })
    .selectOption("orthogonal");
  await noOverflow();

  await importSource(fixture);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  assert.equal(
    await exported("yaml"),
    fixture,
    "Untouched source lost formatting, comments or unknown values",
  );
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Format", exact: true })
    .selectOption("json");
  const converted = JSON.parse(await exported("json"));
  assert.equal(converted.custom.future_setting, "kept");
  assert.deepEqual(converted.sinks.out.inputs, ["sample"]);
  await page
    .getByRole("combobox", { name: "Format", exact: true })
    .selectOption("toml");
  assert((await exported("toml")).includes('future_setting = "kept"'));

  const largeRoute = JSON.stringify({
    sources: { events: { type: "demo_logs" } },
    transforms: {
      route: {
        type: "route",
        inputs: ["events"],
        route: Object.fromEntries(
          Array.from({ length: 20000 }, (_, i) => [`r${i}`, "true"]),
        ),
      },
    },
    sinks: { out: { type: "blackhole", inputs: ["route.r0"] } },
  });
  await importSource(largeRoute, "json");
  await expect(
    page.getByRole("heading", {
      name: "Graph display limit reached.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  assert.equal(
    await exported("json"),
    largeRoute,
    "Limited graph discarded original source",
  );

  const compact = JSON.stringify({
    sources: { events: { type: "demo_logs" } },
    sinks: { out: { type: "blackhole", inputs: ["events"] } },
    custom: Array.from({ length: 38000 }, () => ({ a: { b: { c: 0 } } })),
  });
  await importSource(compact, "json");
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Format", exact: true })
    .selectOption("yaml");
  await expect(page.getByRole("status")).toContainText(
    "exceeds the 1 MiB limit",
  );
  await expect(
    page.getByRole("combobox", { name: "Format", exact: true }),
  ).toHaveValue("json");
  assert.equal(
    await exported("json"),
    compact,
    "Failed conversion replaced exportable source",
  );

  await importSource(fixture.replace("# synthetic browser regression\n", ""));
  await page
    .getByRole("combobox", { name: "Connection style" })
    .selectOption("curved");
  await expect
    .poll(() =>
      page.locator(".react-flow__node").evaluateAll((nodes) =>
        nodes.every((node) => {
          const viewport = node.closest(".react-flow").getBoundingClientRect();
          const rect = node.getBoundingClientRect();
          return (
            rect.left >= viewport.left &&
            rect.right <= viewport.right &&
            rect.top >= viewport.top &&
            rect.bottom <= viewport.bottom
          );
        }),
      ),
    )
    .toBe(true);
  await page.locator('.react-flow__node[data-id="sample"]').click();
  await expect(
    page.getByRole("heading", { name: "sample", exact: true }),
  ).toBeVisible();
  await page.getByLabel(/^Rate/).fill("20");
  await page.getByLabel(/^Rate/).press("Tab");
  const edited = await exported("yaml");
  assert(edited.includes("rate: 20"), "Schema edit was not exported");
  assert(
    edited.includes("future_setting: kept"),
    "Graph editing discarded unknown settings",
  );
  await noOverflow();
  await page
    .locator(".standalone-designer")
    .screenshot({ path: path.join(captures, "designer-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({
    path: path.join(captures, "designer-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(() => window.__storageWrites),
    0,
    "The designer wrote automatic storage",
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
    { local: 0, session: 0 },
  );
  assert.deepEqual(
    disallowedRequests,
    [],
    "The designer made API or external requests",
  );
  assert.deepEqual(errors, [], "The designer raised page errors");
  await context.close();
  console.log(
    "Designer browser regression passed: import/export, formats, bounded graph, preserved source, privacy, desktop and mobile.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
