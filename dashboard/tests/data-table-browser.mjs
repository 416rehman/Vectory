// Shared table interactions against isolated synthetic rows, never a real API.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "../.local/data-table-review");
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "table-fixture",
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__table") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic table verification</title></head><body><div id="root"></div><script type="module" src="/tests/data-table-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 899, height: 884 },
});
const page = await context.newPage();
const errors = [],
  results = [],
  accessibility = [],
  measurements = [];
page.on("pageerror", (error) => errors.push(error.message));
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let failure;
try {
  await page.goto(`${origin}/__table`);
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText("Device 1");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows.first()).toContainText("Device 6");
  await page.getByRole("button", { name: /^Sort by Count/ }).click();
  await expect(rows.first()).toContainText("Device 15");
  await expect(page.getByText("1 / 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Sort by Count/ }).click();
  await expect(rows.first()).toContainText("Device 2");
  results.push(
    "Global numeric sorting before pagination; page resets; missing count stays last",
  );
  await page
    .getByRole("button", { name: "Filter Status", exact: true })
    .click();
  await page.getByRole("radio", { name: "Paused", exact: true }).click();
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(5);
  await expect(
    page.getByRole("button", { name: "Filter Status (active)", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Filter Name", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Filter Name", exact: true })
    .fill("no matching row");
  await expect(
    page.getByText("No matching results.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Name/ })).toBeVisible();
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await expect(rows).toHaveCount(5);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Filter Name", exact: true }),
  ).toBeFocused();
  results.push(
    "Column filters combine across pages; empty results retain controls; Escape restores focus",
  );
  await page
    .getByRole("button", { name: "Filter Status (active)", exact: true })
    .click();
  await page.getByRole("radio", { name: "Paused", exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByRole("radio", { name: "Active", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("heading", { name: "Synthetic table verification" })
    .click();
  await expect(page.getByRole("radiogroup")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Toggle loading", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Loading");
  await expect(
    page.getByRole("columnheader", { name: /Status/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle loading", exact: true })
    .click();
  results.push(
    "Keyboard option selection, outside dismissal, and persistent headers during loading",
  );
  // The field reset must not remove the keyboard focus ring from checkboxes
  // and radios (they draw an outline, not a field ring).
  await page
    .getByRole("button", { name: "Toggle loading", exact: true })
    .focus();
  for (const [role, name] of [
    ["checkbox", "Synthetic checkbox"],
    ["radio", "Synthetic radio"],
  ]) {
    await page.keyboard.press("Tab");
    const control = page.getByRole(role, { name, exact: true });
    await expect(control).toBeFocused();
    const ring = await control.evaluate((node) => {
      const style = getComputedStyle(node);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(ring.style, `${name} focus outline`).not.toBe("none");
    expect(ring.width, `${name} focus outline width`).not.toBe("0px");
  }
  results.push("Checkboxes and radios show a keyboard focus ring");
  for (const theme of ["light", "dark"])
    for (const width of [899, 375]) {
      await page.setViewportSize({ width, height: 884 });
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      const bounds = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
        table: document.querySelector(".data-table-scroll").scrollWidth,
      }));
      expect(bounds.page).toBeLessThanOrEqual(bounds.viewport + 1);
      measurements.push({ width, theme, ...bounds });
      // Only a region that scrolls sideways is a keyboard stop.
      const region = page.getByRole("region", {
        name: "Synthetic devices table",
        exact: true,
      });
      if (
        await region.evaluate((node) => node.scrollWidth > node.clientWidth + 1)
      )
        await expect(region).toHaveAttribute("tabindex", "0");
      else await expect(region).not.toHaveAttribute("tabindex");
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
      accessibility.push({ width, theme, violations: scan.violations.length });
      await page
        .getByRole("button", { name: "Filter Status (active)", exact: true })
        .click();
      await expect(
        page.getByRole("radio", { name: "Active", exact: true }),
      ).toBeVisible();
      const openScan = await new AxeBuilder({ page }).analyze();
      expect(openScan.violations).toEqual([]);
      accessibility.push({
        width,
        theme,
        open: true,
        violations: openScan.violations.length,
      });
      await page.screenshot({
        path: resolve(output, `table-${width}-${theme}.png`),
      });
      await page.keyboard.press("Escape");
    }
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  await page.screenshot({ path: resolve(output, "failure.png") });
} finally {
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        synthetic: true,
        results,
        accessibility,
        measurements,
        errors,
        failure: failure?.stack,
      },
      null,
      2,
    ),
  );
  await browser.close();
  await server.close();
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: results.length,
    accessibilityScans: accessibility.length,
    output,
  }),
);
