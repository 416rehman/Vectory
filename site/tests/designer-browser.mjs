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
const captures = path.join(
  root,
  ".local/site-browser",
  `run-${Date.now()}-${process.pid}`,
);
const require = createRequire(path.join(root, "dashboard/package.json"));
const { chromium, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
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
  let dismissNextDialog = false;
  page.on("dialog", async (dialog) => {
    if (dismissNextDialog) {
      dismissNextDialog = false;
      await dialog.dismiss();
    } else {
      await dialog.accept();
    }
  });
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

  async function fillsViewport() {
    assert(
      await page.evaluate(() => {
        const tool = document
          .querySelector(".standalone-designer")
          .getBoundingClientRect();
        return (
          tool.left === 0 &&
          Math.abs(tool.right - innerWidth) <= 1 &&
          Math.abs(tool.bottom - innerHeight) <= 1 &&
          document.documentElement.scrollHeight <= innerHeight
        );
      }),
      "Designer should fill the viewport without a marketing intro or body scrolling",
    );
  }
  async function accessible() {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    assert.deepEqual(
      result.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
      [],
      "Page has accessibility violations",
    );
  }

  await page.goto(origin + "/");
  const toolsMenu = page.locator(".tools-menu");
  await toolsMenu.locator("summary").click();
  await expect(
    toolsMenu.getByRole("link", { name: /Vector configuration designer/ }),
  ).toBeVisible();
  await toolsMenu.locator("summary").press("Escape");
  await expect(toolsMenu).not.toHaveAttribute("open", "");
  await expect(page.locator(".hero .button-dark")).toHaveAttribute(
    "href",
    "#start",
  );
  const heroLayouts = [];
  for (const [width, height] of [
    [1265, 714],
    [1905, 940],
    [768, 720],
    [390, 844],
    [390, 714],
    [320, 568],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async () => {
      scrollTo(0, 0);
      await document.fonts.ready;
      await document.querySelector(".hero-art-sculpture > img").decode();
    });
    const geometry = await page.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          bottom: rect.bottom,
        };
      };
      return {
        viewport: [innerWidth, innerHeight],
        image: box(".hero-art-sculpture > img"),
        copy: box(".hero-copy"),
        footer: box(".hero-ruler"),
        masthead: box(".masthead"),
        pageWidth: document.documentElement.clientWidth,
      };
    });
    assert(
      Math.abs(geometry.image.x) <= 1 &&
        Math.abs(geometry.image.width - geometry.pageWidth) <= 1,
      "Original artwork must span both screen edges",
    );
    assert(
      geometry.image.y >= geometry.masthead.bottom - 1,
      "Artwork must remain below the navigation",
    );
    assert(
      geometry.image.bottom <= geometry.footer.y + 1,
      "The entire original artwork must remain above the hero footer",
    );
    assert(
      geometry.footer.bottom <= height + 1,
      "Artwork and hero footer must fit in the first viewport",
    );
    assert(
      geometry.copy.bottom <= geometry.footer.y,
      "Copy and actions must fit above the hero footer",
    );
    await noOverflow();
    await accessible();
    heroLayouts.push(geometry);
    await page.screenshot({
      path: path.join(captures, `landing-${width}x${height}.png`),
    });
  }
  await fs.writeFile(
    path.join(captures, "hero-layouts.json"),
    JSON.stringify(heroLayouts, null, 2) + "\n",
    { flag: "wx" },
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const heroImage = await page
    .locator(".hero-art-sculpture > img")
    .boundingBox();
  const heroViewportWidth = await page.evaluate(
    () => document.documentElement.clientWidth,
  );
  assert(
    heroImage &&
      Math.abs(heroImage.x) <= 1 &&
      Math.abs(heroImage.width - heroViewportWidth) <= 1,
    "Original artwork must span both screen edges",
  );
  assert(
    heroImage.y > 0 && heroImage.y < 1000,
    "Original artwork must be visible in the desktop hero",
  );
  await noOverflow();
  await accessible();
  await page.screenshot({ path: path.join(captures, "landing-desktop.png") });
  const sculpture = page.locator(".hero-art-sculpture");
  const light = page.locator(".hero-art-light");
  await sculpture.hover({
    position: { x: heroImage.width * 0.922, y: heroImage.height * 0.147 },
  });
  await expect(light).toHaveCSS("opacity", "1");
  await page.locator(".hero h1").hover();
  await expect(light).toHaveCSS("opacity", "0");
  await sculpture.hover({
    position: { x: heroImage.width * 0.153, y: heroImage.height * 0.692 },
  });
  await expect(light).toHaveCSS("opacity", "1");
  await expect(light).toHaveCSS("mask-image", /radial-gradient/);
  await page.screenshot({
    path: path.join(captures, "landing-light-reveal.png"),
  });
  await page.locator(".hero h1").hover();
  await expect(light).toHaveCSS("opacity", "0");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await sculpture.hover({
    position: { x: heroImage.width * 0.406, y: heroImage.height * 0.911 },
  });
  await expect(light).toHaveCSS("opacity", "1");
  await expect(light).toHaveCSS("transition-duration", "0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(".hero h1").hover();
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await accessible();
  await page.screenshot({ path: path.join(captures, "landing-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });

  for (const [name, installer] of [
    ["Linux", "install.sh"],
    ["macOS", "install-desktop.sh"],
    ["Windows", "install.ps1"],
  ]) {
    await page.getByRole("tab", { name, exact: true }).click();
    const panel = page.getByRole("tabpanel", { name, exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.locator("code")).toContainText(installer);
    await expect(page.locator("[data-install-download]")).toHaveAttribute(
      "href",
      "/" + installer,
    );
    await noOverflow();
  }
  await page.getByRole("tab", { name: "Windows", exact: true }).press("Home");
  await expect(
    page.getByRole("tab", { name: "Linux", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("tab", { name: "Linux", exact: true })
    .press("ArrowRight");
  await expect(
    page.getByRole("tabpanel", { name: "macOS", exact: true }),
  ).toBeVisible();
  await accessible();
  await page.locator("#start").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(captures, "install-macos-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Windows", exact: true }).click();
  await noOverflow();
  await accessible();
  await page.screenshot({
    path: path.join(captures, "install-windows-mobile.png"),
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto(origin + "/designer/");
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".editor-page.editor-redesigned")).toBeVisible();
  await expect(page.locator(".pipeline-save-status")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Choose devices", exact: true }),
  ).toHaveCount(0);
  await fillsViewport();
  await accessible();
  const about = page.locator(".designer-guide");
  await about.locator("summary").click();
  await expect(
    page.getByRole("heading", {
      name: "Visualize and generate Vector configurations.",
    }),
  ).toBeVisible();
  await about.locator("summary").press("Escape");
  await expect(about).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Example", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.locator(".designer-status")).toContainText(
    "Synthetic example",
  );
  // This is the actual product workspace, including its port gestures, menus,
  // spotlight controller and inspector. No standalone equivalents are mounted.
  await page
    .getByRole("button", { name: "Add component", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Add component",
    exact: true,
  });
  await expect(picker).toHaveClass(/canvas-component-menu/);
  await picker
    .getByRole("textbox", { name: "Search components" })
    .fill("throttle");
  await expect(picker.locator(".canvas-component-result")).toHaveCount(1);
  await picker.getByRole("button", { name: "Close component menu" }).click();
  await page
    .getByRole("button", { name: "Connection style", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: "Right-angle", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitemradio", { name: "Right-angle", exact: true })
    .click();
  await expect(page.locator(".react-flow__edge-path").first()).toHaveAttribute(
    "data-connection-style",
    "orthogonal",
  );

  await importSource(fixture);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  assert.equal(
    await exported("yaml"),
    fixture,
    "Untouched source lost comments or unknown values",
  );
  await page
    .getByRole("button", { name: "Add component", exact: true })
    .click();
  await picker
    .getByRole("textbox", { name: "Search components" })
    .fill("throttle");
  dismissNextDialog = true;
  await picker.locator(".canvas-component-result").click();
  await expect(picker).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  await picker.getByRole("button", { name: "Close component menu" }).click();
  assert.equal(await exported("yaml"), fixture, "Canceled edit changed source");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.locator(".editor-code-view")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Format", exact: true })
    .selectOption("json");
  const converted = JSON.parse(await exported("json"));
  assert.equal(converted.custom.future_setting, "kept");
  assert.deepEqual(converted.sinks.out.inputs, ["sample"]);
  await page
    .getByRole("combobox", { name: "Format", exact: true })
    .selectOption("toml");
  const convertedToml = await exported("toml");
  assert(convertedToml.includes('future_setting = "kept"'));

  await importSource(fixture.replace("# synthetic browser regression\n", ""));
  const output = page.locator(
    '.react-flow__node[data-id="events"] .react-flow__handle[data-handleid="output"]',
  );
  const outputBox = await output.boundingBox();
  await page.mouse.move(
    outputBox.x + outputBox.width / 2,
    outputBox.y + outputBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(outputBox.x + 50, outputBox.y + 20, { steps: 3 });
  await expect(
    page.locator(
      '.react-flow__node[data-id="out"] .react-flow__handle[data-handleid="input"]',
    ),
  ).toHaveAttribute("data-port-state", "valid");
  await expect(
    page.locator(
      '.react-flow__node[data-id="sample"] .react-flow__handle[data-handleid="input"]',
    ),
  ).toHaveAttribute("data-port-state", "invalid");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(output).toHaveAttribute("data-port-state", "idle");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);

  const edge = page.locator(".react-flow__edge").first();
  const edgePoint = await edge.evaluate((element) => {
    const path = element.querySelector(".react-flow__edge-path");
    for (const fraction of [0.2, 0.1, 0.3, 0.4, 0.6, 0.8]) {
      const point = path.getPointAtLength(path.getTotalLength() * fraction);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(
        path.getScreenCTM(),
      );
      if (
        document
          .elementFromPoint(screen.x, screen.y)
          ?.closest(".react-flow__edge") === element
      )
        return { x: screen.x, y: screen.y };
    }
    return null;
  });
  assert(
    edgePoint,
    "An unobstructed pointer hit must exist for the actual edge",
  );
  await page.mouse.move(edgePoint.x, edgePoint.y);
  await expect(edge).toHaveAttribute("data-connection-highlight", "active");
  await expect(
    page.locator('.react-flow__node[data-connection-highlight="endpoint"]'),
  ).toHaveCount(2);
  await expect(
    page.locator('.react-flow__node[data-connection-highlight="dimmed"]'),
  ).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect(page.locator("[data-connection-highlight]")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Actions for sample", exact: true })
    .click();
  await expect(page.locator(".canvas-action-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('.react-flow__node[data-id="sample"]').click();
  const rate = page
    .locator(".editor-inspector")
    .getByRole("textbox", { name: "One in every", exact: true });
  await expect(rate).toHaveValue("10");
  await rate.fill("20");
  await rate.press("Tab");
  const edited = await exported("yaml");
  assert(
    edited.includes("rate: 20"),
    "Product inspector edit was not exported",
  );
  assert(
    edited.includes("future_setting: kept"),
    "Graph edit discarded unknown settings",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(rate).toHaveValue("10");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(rate).toHaveValue("20");
  await page
    .getByRole("button", { name: "Close component settings", exact: true })
    .click();
  await noOverflow();
  await accessible();
  await page.screenshot({ path: path.join(captures, "designer-desktop.png") });

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
      name: "Configuration preserved.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  assert.equal(
    await exported("json"),
    largeRoute,
    "Graph omission discarded source",
  );
  await page.getByRole("button", { name: "Code", exact: true }).click();
  assert.equal(
    await exported("json"),
    largeRoute,
    "Code discarded large-file source",
  );

  await importSource(fixture);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Format", exact: true })
    .selectOption("json");
  await page
    .getByRole("textbox", { name: "Vector configuration code", exact: true })
    .fill(largeRoute);
  await page
    .getByRole("button", { name: "Apply code changes", exact: true })
    .click();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Configuration preserved.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  assert.equal(
    await exported("json"),
    largeRoute,
    "Code apply discarded bounded source",
  );

  const compact = JSON.stringify({
    sources: { events: { type: "demo_logs" } },
    sinks: { out: { type: "blackhole", inputs: ["events"] } },
    custom: Array.from({ length: 38000 }, () => ({ a: { b: { c: 0 } } })),
  });
  await importSource(compact, "json");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Format", exact: true })
    .selectOption("yaml");
  await expect(page.locator(".error-box")).toContainText(
    "exceeds the 1 MiB limit",
  );
  await expect(
    page.getByRole("combobox", { name: "Format", exact: true }),
  ).toHaveValue("json");
  assert.equal(
    await exported("json"),
    compact,
    "Failed conversion replaced source",
  );

  // Nested product services remain unavailable locally, even though their
  // actual editing forms and keyboard controls are shared.
  await importSource(fixture.replace("# synthetic browser regression\n", ""));
  await page
    .getByRole("button", { name: "Pipeline settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Pipeline settings",
    exact: true,
  });
  await settings.getByRole("button", { name: "Tests", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Run pipeline tests", exact: true }),
  ).toBeDisabled();
  await settings.getByRole("button", { name: /Close/ }).click();
  const pendingShortcutExport = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  await pendingShortcutExport;

  await page.setViewportSize({ width: 390, height: 844 });
  await importSource(convertedToml, "toml");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: "Fit graph", exact: true }).click();
  await noOverflow();
  await fillsViewport();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.locator(".editor-code-view")).toBeVisible();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Pipeline canvas", exact: true }),
  ).toBeVisible();
  await accessible();
  await page.screenshot({
    path: path.join(captures, "designer-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(() => window.__storageWrites),
    0,
    "Local editor wrote automatic storage",
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
    "Local editor made API or external requests",
  );
  assert.deepEqual(errors, [], "The designer raised page errors");
  await context.close();
  console.log(
    "Designer browser regression passed: import/export, formats, bounded graph, preserved source, privacy, desktop and visible mobile graph.",
  );
  console.log(
    `Hero layout and browser captures: ${path.relative(root, captures)}`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
