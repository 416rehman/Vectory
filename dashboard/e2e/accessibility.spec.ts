import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const credentials = JSON.parse(
  fs.readFileSync(path.join(root, ".local/preview/credentials.json"), "utf8"),
);
test("WCAG AA on sign-in, dark overview and narrow mobile", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.context().clearCookies();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
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
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await check("dark_overview");
  await page.setViewportSize({ width: 390, height: 844 });
  await check("mobile_dark_overview");
  fs.writeFileSync(
    path.join(root, "docs/evidence/accessibility-additional.json"),
    JSON.stringify(results, null, 2),
  );
  for (const result of Object.values(results)) expect(result).toEqual([]);
});
test("WCAG AA automated checks on real overview and editor", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  const overview = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Configurations", exact: true })
    .click();
  await page.locator(".config-card").first().click();
  await expect(page.locator(".pipeline-node").first()).toBeVisible();
  const editor = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  fs.writeFileSync(
    path.join(root, "docs/evidence/accessibility.json"),
    JSON.stringify(
      { overview: overview.violations, editor: editor.violations },
      null,
      2,
    ),
  );
  expect(
    overview.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ html: n.html, summary: n.failureSummary })),
    })),
  ).toEqual([]);
  expect(
    editor.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ html: n.html, summary: n.failureSummary })),
    })),
  ).toEqual([]);
});
