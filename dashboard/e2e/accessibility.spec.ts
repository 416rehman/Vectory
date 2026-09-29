import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { setAppearance } from "./account-menu";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
test("WCAG AA on sign-in, account controls and dark mobile overview", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.context().clearCookies();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  const results: Record<string, unknown> = {};
  async function check(name: string) {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    results[name] = result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ html: n.html, summary: n.failureSummary })),
    }));
  }
  await check("sign_in");
  await page
    .context()
    .addCookies(
      JSON.parse(
        fs.readFileSync(
          path.join(root, ".local/preview/browser-auth.json"),
          "utf8",
        ),
      ).cookies,
    );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Needs attention", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await check("account");
  await setAppearance(page, "dark");
  await check("dark_overview");
  await page.setViewportSize({ width: 390, height: 844 });
  await check("mobile_dark_overview");
  fs.writeFileSync(
    path.join(root, "docs/evidence/accessibility-additional.json"),
    JSON.stringify(results, null, 2),
  );
  for (const result of Object.values(results)) expect(result).toEqual([]);
});
test("WCAG AA on overview, default graph, component menu, right inspector and code", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const session = await page.request
    .get("/api/v1/session")
    .then((r) => r.json());
  const config = JSON.parse(
    fs.readFileSync(
      path.join(root, "vector-catalog/fixtures/remap.json"),
      "utf8",
    ),
  );
  const response = await page.request.post("/api/v1/configurations", {
    headers: { "X-CSRF-Token": session.csrf_token },
    data: {
      name: `Accessibility ${Date.now()}`,
      description: "Synthetic accessibility regression.",
      config,
      graph: { nodes: [], edges: [] },
    },
  });
  expect(response.ok()).toBeTruthy();
  const doc = await response.json();
  const results: Record<string, unknown> = {};
  async function check(name: string) {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    results[name] = result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ html: n.html, summary: n.failureSummary })),
    }));
  }
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Needs attention", exact: true }),
  ).toBeVisible();
  await check("overview");
  await page.goto("/#/configurations/" + doc.id);
  await expect(page.locator(".pipeline-node")).toHaveCount(3);
  await check("default_graph");
  await page
    .getByRole("button", { name: "Add component", exact: true })
    .click();
  const menu = page.getByRole("dialog", { name: "Add component", exact: true });
  await menu.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(menu.getByLabel("Search components")).toBeVisible();
  await check("source_picker");
  await menu
    .getByRole("button", { name: "Close component menu", exact: true })
    .click();
  await page
    .locator('.react-flow__node[data-id="process"] .pipeline-node')
    .click();
  await check("step_settings");
  await page
    .locator(".editor-inspector")
    .getByRole("button", { name: "Close component settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Steps", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(
    page.getByLabel("Vector configuration code", { exact: true }),
  ).toBeVisible();
  await check("code_view");
  fs.writeFileSync(
    path.join(root, "docs/evidence/accessibility.json"),
    JSON.stringify(results, null, 2),
  );
  for (const result of Object.values(results)) expect(result).toEqual([]);
});
