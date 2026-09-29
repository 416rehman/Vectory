// Platform help and the API appendix are verified as separate experiences.
process.env.VECTORY_HELP_URL ||=
  process.env.VECTORY_DOCS_URL || "http://127.0.0.1:8080";
if (!process.argv.includes("--api-only"))
  await import("../../help-center/tests/browser.mjs");
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../.."),
  require = createRequire(path.join(root, "dashboard/package.json")),
  { chromium, expect } = require("@playwright/test"),
  AxeBuilder = require("@axe-core/playwright").default,
  origin = process.env.VECTORY_DOCS_URL || "http://127.0.0.1:8080",
  storageState =
    process.env.VECTORY_DOCS_AUTH ||
    path.join(root, ".local/preview/browser-auth.json"),
  browser = await chromium.launch();
try {
  const context = await browser.newContext({
      storageState,
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage(),
    errors = [],
    external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(origin).origin)
      external.push(request.url());
  });
  await page.goto(origin + "/api-reference.html");
  await page
    .getByRole("heading", { name: "Vectory dashboard API", exact: true })
    .waitFor();
  const scalarAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(scalarAxe.violations).toEqual([]);
  await page
    .getByRole("button", { name: "Test Request (get /api/v1/status)" })
    .click();
  const result = page.waitForResponse(
    (response) => response.url() === origin + "/api/v1/status",
  );
  await page
    .getByRole("button", {
      name: "Send get request to " + origin + "/api/v1/status",
    })
    .click();
  const response = await result;
  expect(response.status()).toBe(200);
  expect((await response.json()).initialized).toBe(true);
  await page.getByRole("button", { name: "Close Client", exact: true }).click();
  await page
    .getByRole("button", { name: "Agent protocol", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Vectory agent protocol", exact: true }),
  ).toBeVisible();
  expect(await page.getByRole("button", { name: /Test Request/ }).count()).toBe(
    0,
  );
  expect(await page.getByText("Generate MCP", { exact: true }).count()).toBe(0);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  const evidence = {
    recorded_at: new Date().toISOString(),
    origin,
    read_only: true,
    platform_help_evidence: "docs/evidence/help-center.json",
    scalar_axe_violations: 0,
    actual_scalar_status_http: response.status(),
    agent_protocol_read_only: true,
    external_requests: 0,
    page_errors: [],
  };
  await fs.writeFile(
    path.join(root, "docs/user/browser-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    "PASS Scalar GET, agent read-only scope, accessibility and no external requests; platform help verified separately",
  );
} finally {
  await browser.close();
}
