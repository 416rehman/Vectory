// Read-only acceptance of the built help center through Vectory's real HTTP server.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { topics } from "../pages.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(root, "dashboard/package.json"));
const { chromium, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const origin = new URL(process.env.VECTORY_HELP_URL || "http://127.0.0.1:8080")
  .origin;
const dist = path.join(root, "dashboard/dist/help");
const artifacts = path.resolve(
  root,
  process.env.VECTORY_HELP_ARTIFACTS || ".local/help-acceptance",
);
const evidenceFile = path.resolve(
  root,
  process.env.VECTORY_HELP_EVIDENCE || "docs/evidence/help-center.json",
);
await fs.mkdir(artifacts, { recursive: true });
await fs.mkdir(path.dirname(evidenceFile), { recursive: true });

const evidence = {
  started_at: new Date().toISOString(),
  scope:
    "Unauthenticated, read-only Chromium acceptance of bundled help through the actual Vectory server. No fleet, configuration or deployment writes.",
  origin,
  build: JSON.parse(
    await fs.readFile(path.join(root, "help-center/package.json"), "utf8"),
  ).dependencies,
  index_sha256: createHash("sha256")
    .update(await fs.readFile(path.join(dist, "index.html")))
    .digest("hex"),
  results: [],
  responsive_pages: [],
  accessibility: [],
  search: {},
  network: {
    requests: [],
    external: [],
    failed: [],
    http_errors: [],
    csp_errors: [],
    console_errors: [],
  },
  page_errors: [],
  screenshots: [],
};
const browser = await chromium.launch();
evidence.browser = browser.version();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  colorScheme: "light",
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
page.setDefaultNavigationTimeout(15000);
let currentTest = "";
const expected404 = `${origin}/help/not-a-document-acceptance/`;
context.on("request", (request) => {
  const url = request.url();
  evidence.network.requests.push({ url, type: request.resourceType() });
  if (/^https?:/.test(url) && new URL(url).origin !== origin)
    evidence.network.external.push(url);
});
context.on("requestfailed", (request) => {
  const message = request.failure()?.errorText || "";
  if (!message.includes("ERR_ABORTED"))
    evidence.network.failed.push({ url: request.url(), message });
});
context.on("response", (response) => {
  if (response.status() >= 400)
    evidence.network.http_errors.push({
      url: response.url(),
      status: response.status(),
      expected: response.url() === expected404,
    });
});
page.on("pageerror", (error) =>
  evidence.page_errors.push({ test: currentTest, message: error.message }),
);
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const detail = { test: currentTest, message: message.text() };
  evidence.network.console_errors.push(detail);
  if (
    /content security policy|violates.*directive|refused to.*(?:script|worker|webassembly)/i.test(
      message.text(),
    )
  )
    evidence.network.csp_errors.push(detail);
});

async function visit(slug = "") {
  const response = await page.goto(`${origin}/help/${slug}`, {
    waitUntil: "networkidle",
  });
  await page.evaluate(() => document.fonts.ready);
  return response;
}
async function screenshot(name) {
  const filename = path.join(artifacts, `${name}.png`);
  await page.screenshot({ path: filename, fullPage: true });
  evidence.screenshots.push(
    path.relative(root, filename).replaceAll("\\", "/"),
  );
}
async function test(name, run) {
  currentTest = name;
  try {
    await run();
    evidence.results.push({ name, passed: true });
    console.log("PASS", name);
  } catch (error) {
    evidence.results.push({ name, passed: false, error: error.message });
    console.error("FAIL", name, error.message);
    await screenshot(`failure-${evidence.results.length}`).catch(() => {});
  }
}
async function htmlPages(directory, prefix = "") {
  const pages = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      pages.push(
        ...(await htmlPages(
          path.join(directory, entry.name),
          `${prefix}${entry.name}/`,
        )),
      );
    else if (entry.name.endsWith(".html")) pages.push(`${prefix}${entry.name}`);
  }
  return pages.sort();
}

try {
  await test("public help and bundled favicon load without authentication under strict headers", async () => {
    const response = await visit();
    expect(response.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "How can we help?", exact: true }),
    ).toBeVisible();
    expect(await context.cookies()).toEqual([]);
    const headers = response.headers();
    evidence.security_headers = headers;
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    const csp = headers["content-security-policy"];
    const script = csp
      .split(";")
      .find((part) => part.trim().startsWith("script-src "));
    expect(script).toContain("'wasm-unsafe-eval'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const inline = await page
      .locator("script:not([src])")
      .evaluateAll(
        (scripts) =>
          scripts.filter(
            (node) =>
              (!node.type ||
                [
                  "module",
                  "text/javascript",
                  "application/javascript",
                ].includes(node.type)) &&
              node.textContent.trim(),
          ).length,
      );
    expect(inline).toBe(0);
    const favicon = await page
      .locator('link[rel="shortcut icon"]')
      .getAttribute("href");
    expect(
      (await context.request.get(new URL(favicon, origin).href)).status(),
    ).toBe(200);
    await expect(
      page.getByRole("link", { name: "Open Vectory", exact: true }),
    ).toHaveAttribute("href", "/#/overview");
    const redirect = await context.request.get(`${origin}/help`, {
      maxRedirects: 0,
    });
    expect(redirect.status()).toBe(308);
    expect(redirect.headers().location).toBe("/help/");
  });

  await test("theme switching persists across a real page reload", async () => {
    await page
      .getByRole("combobox", { name: "Select theme", exact: true })
      .selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await screenshot("home-dark");
    await page
      .getByRole("combobox", { name: "Select theme", exact: true })
      .selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await screenshot("home-light");
  });

  await test("real Pagefind search returns highlighted snippets and navigates to a matching section", async () => {
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Search", exact: true });
    await dialog
      .getByRole("textbox", { name: "Search", exact: true })
      .fill("rollback");
    await expect(dialog.getByText(/\d+ results? for rollback/i)).toBeVisible();
    const result = dialog
      .getByRole("listitem")
      .filter({ hasText: "Roll back deliberately" });
    await expect(result.locator("mark")).toContainText(/rollback/i);
    const snippet = await result.locator("p").last().innerText();
    expect(snippet.length).toBeGreaterThan(35);
    evidence.search = {
      term: "rollback",
      summary: await dialog.getByText(/\d+ results? for rollback/i).innerText(),
      snippet,
    };
    await screenshot("search-results");
    await dialog
      .getByRole("link", { name: "Roll back deliberately", exact: true })
      .click();
    await expect(page).toHaveURL(
      `${origin}/help/deployments/#roll-back-deliberately`,
    );
    await expect(
      page.getByRole("heading", {
        name: "Roll back deliberately",
        exact: true,
      }),
    ).toBeInViewport();
    evidence.search.destination = page.url();
    expect(
      evidence.network.requests.some((request) =>
        request.url.endsWith("/pagefind-worker.js"),
      ),
    ).toBe(true);
    expect(
      evidence.network.requests.some((request) =>
        /pagefind.*(?:wasm|\.pf_wasm)/i.test(request.url),
      ),
    ).toBe(true);
  });

  await test("search handles an unknown term with an explicit empty result state", async () => {
    if (
      await page
        .getByRole("dialog", { name: "Search", exact: true })
        .isVisible()
    )
      await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Search", exact: true });
    // Pagefind falls back to the longest indexed prefix of an unknown word, so
    // start with a letter that never stands alone in the guides ("Ctrl Z" and
    // the API's `q` parameter do; e, i, j, l and y do not at the time of
    // writing: if this fails after a docs change, look for a new lone letter).
    await dialog
      .getByRole("textbox", { name: "Search", exact: true })
      .fill("jxqnovectorydocmatch9371");
    await expect(dialog.getByText(/no results/i)).toBeVisible();
    evidence.search.empty_summary = await dialog
      .getByText(/no results/i)
      .innerText();
    await expect(dialog.getByRole("listitem")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  await test("common questions find the page that answers them", async () => {
    // Words people type that the page titles don't always contain.
    for (const [term, title] of [
      ["quickstart", "Quickstart"],
      ["ports", "Ports and network"],
      ["firewall", "Ports and network"],
      ["docs", "How can we help?"],
    ]) {
      await visit();
      await page.getByRole("button", { name: "Search", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Search", exact: true });
      await dialog
        .getByRole("textbox", { name: "Search", exact: true })
        .fill(term);
      await expect(
        dialog.getByText(new RegExp(`\\d+ results? for ${term}`, "i")),
      ).toBeVisible();
      await expect(
        dialog.getByRole("link", { name: title, exact: true }).first(),
      ).toBeVisible();
      evidence.search[term] = title;
      await page.keyboard.press("Escape");
    }
  });

  await test("heading anchors and article table of contents navigate to real sections", async () => {
    await visit("installation/");
    const anchor = page.getByRole("link", {
      name: "Section titled “Trust the server certificate”",
      exact: true,
    });
    await anchor.click();
    await expect(page).toHaveURL(
      `${origin}/help/installation/#trust-the-server-certificate`,
    );
    const navigation = page.getByRole("navigation", {
      name: "On this page",
      exact: true,
    });
    await navigation
      .getByRole("link", { name: "Keep the agent running", exact: true })
      .click();
    await expect(page).toHaveURL(
      `${origin}/help/installation/#keep-the-agent-running`,
    );
    await expect(
      page.getByRole("heading", {
        name: "Keep the agent running",
        exact: true,
      }),
    ).toBeInViewport();
  });

  await test("code copy writes the actual command block to the clipboard", async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
    await visit("installation/");
    const block = page.locator(".expressive-code").first();
    const expected = (await block.locator("pre code").innerText())
      .replaceAll("\r\n", "\n")
      .trim();
    await block
      .getByRole("button", { name: "Copy to clipboard", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await page.evaluate(() => navigator.clipboard.readText()))
          .replaceAll("\r\n", "\n")
          .trim(),
      )
      .toBe(expected);
    evidence.clipboard = {
      verified: true,
      characters: expected.length,
      begins_with: expected.split("\n")[0],
    };
  });

  await test("mobile menu opens the sidebar and navigates to a guide", async () => {
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 812 });
      await visit();
      const title = await page
        .locator(".site-title > span")
        .evaluate((element) => ({
          client: element.clientWidth,
          scroll: element.scrollWidth,
        }));
      expect(title.scroll).toBeLessThanOrEqual(title.client + 1);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await visit();
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await menu.click();
    const main = page.getByRole("navigation", { name: "Main", exact: true });
    await expect(
      main.getByRole("link", { name: "Build a pipeline", exact: true }),
    ).toBeVisible();
    await screenshot("mobile-sidebar");
    await main
      .getByRole("link", { name: "Build a pipeline", exact: true })
      .click();
    await expect(page).toHaveURL(`${origin}/help/pipelines/`);
    await expect(
      main.getByRole("link", { name: "Build a pipeline", exact: true }),
    ).not.toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  await test("every built help page fits a 375px viewport without document overflow", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    const pages = await htmlPages(dist);
    // Every registered page, plus the home page and the 404 page.
    expect(pages.length).toBe(topics.length + 2);
    for (const file of pages) {
      const slug =
        file === "index.html"
          ? ""
          : file.endsWith("/index.html")
            ? file.slice(0, -10)
            : file;
      const response = await visit(slug);
      expect(response.status(), slug).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      evidence.responsive_pages.push({
        file,
        title: await page.title(),
        ...dimensions,
      });
      expect(dimensions.document, slug).toBeLessThanOrEqual(
        dimensions.viewport + 1,
      );
      expect(dimensions.body, slug).toBeLessThanOrEqual(
        dimensions.viewport + 1,
      );
    }
    await visit("pipelines/");
    await screenshot("mobile-pipelines");
  });

  await test("an unknown help URL returns the real documentation 404", async () => {
    const response = await page.goto(expected404, { waitUntil: "networkidle" });
    expect(response.status()).toBe(404);
    const heading = await page.getByRole("heading", { level: 1 }).innerText();
    expect(heading).toMatch(/404|not found/i);
    expect(await page.locator("#root").count()).toBe(0);
    evidence.not_found = {
      url: expected404,
      status: response.status(),
      heading,
    };
  });

  await test("representative light, dark and mobile help views pass automated accessibility checks", async () => {
    for (const sample of [
      { path: "", theme: "light", width: 1440 },
      { path: "installation/", theme: "dark", width: 1440 },
      { path: "pipelines/", theme: "dark", width: 375 },
      { path: "", theme: "light", width: 375, menu: true },
    ]) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await visit(sample.path);
      await page
        .getByRole("combobox", { name: "Select theme", exact: true })
        .selectOption(sample.theme);
      await page.setViewportSize({
        width: sample.width,
        height: sample.width === 375 ? 812 : 1000,
      });
      if (sample.menu)
        await page.getByRole("button", { name: "Menu", exact: true }).click();
      // Expressive Code updates overflow tab stops with a debounced ResizeObserver.
      // Check its settled keyboard behavior instead of scanning mid-resize.
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("pre")].every(
            (block) =>
              block.scrollWidth <= block.clientWidth || block.tabIndex >= 0,
          ),
        null,
        { timeout: 4000 },
      );
      let keyboardCodeBlocks = 0;
      if (!sample.menu)
        for (const block of await page.locator("pre").all()) {
          if (
            !(await block.evaluate(
              (element) => element.scrollWidth > element.clientWidth,
            ))
          )
            continue;
          await block.focus();
          await expect(block).toBeFocused();
          await block.evaluate((element) => {
            element.scrollLeft = 0;
          });
          await block.press("ArrowRight");
          await expect
            .poll(() => block.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(0);
          keyboardCodeBlocks++;
        }
      const analysis = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      const violations = analysis.violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        description: item.description,
        nodes: item.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      }));
      evidence.accessibility.push({
        ...sample,
        keyboard_code_blocks: keyboardCodeBlocks,
        violations,
      });
    }
    expect(
      evidence.accessibility.filter((sample) => sample.violations.length),
    ).toEqual([]);
  });

  await test("help assets and search stay same-origin with no CSP violations or runtime errors", async () => {
    expect(evidence.page_errors).toEqual([]);
    expect(evidence.network.csp_errors).toEqual([]);
    expect(evidence.network.external).toEqual([]);
    expect(evidence.network.failed).toEqual([]);
    expect(
      evidence.network.http_errors.filter((error) => !error.expected),
    ).toEqual([]);
  });
} finally {
  evidence.finished_at = new Date().toISOString();
  evidence.passed = evidence.results.every((result) => result.passed);
  evidence.network.request_count = evidence.network.requests.length;
  evidence.network.requests = [
    ...new Map(
      evidence.network.requests.map((request) => [request.url, request]),
    ).values(),
  ];
  await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  await browser.close();
}
assert(evidence.passed, `Help acceptance failed; inspect ${evidenceFile}`);
