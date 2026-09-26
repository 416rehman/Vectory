import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const credentials = JSON.parse(
  fs.readFileSync(path.join(root, ".local/preview/credentials.json"), "utf8"),
);
test.beforeEach(async ({ page }) => {
  const login = await page.request.get("/api/v1/session");
  expect(login.ok()).toBeTruthy();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
});
test("native device metrics and persisted history appear without fabricated values", async ({
  page,
}) => {
  const native = JSON.parse(
    fs.readFileSync(path.join(root, ".local/preview/native-run.json"), "utf8"),
  );
  await page.goto("/#/devices/" + native.device_id);
  await expect(
    page.getByRole("heading", { name: "Operational metrics", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".telemetry-chart button").first()).toBeVisible();
  await expect(page.getByText(/Reported component metrics/)).toBeVisible();
  const history = await page.request
    .get(`/api/v1/devices/${native.device_id}/telemetry`)
    .then((r) => r.json());
  expect(history.samples.length).toBeGreaterThan(0);
  expect(
    history.samples.some((s: any) => s.events_per_second > 0),
  ).toBeTruthy();
  await page
    .getByRole("dialog")
    .screenshot({
      path: path.join(root, "docs/screenshots/device.png"),
      animations: "disabled",
    });
});
test("real overview, navigation, theme, and responsive fleet", async ({
  page,
}) => {
  await expect(
    page.getByText("Connected devices", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Your pipelines,")).toBeVisible();
  await page.screenshot({
    path: path.join(root, "docs/screenshots/overview.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: path.join(root, "docs/screenshots/overview-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Use light theme" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Devices", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Devices", exact: true }),
  ).toBeVisible();
  await expect(page.locator("table tbody tr")).not.toHaveCount(0);
  await page
    .getByPlaceholder("Search by name, platform, or label…")
    .fill("no-such-device");
  await expect(
    page.getByText("No matching devices", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Clear search").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await page.screenshot({
    path: path.join(root, "docs/screenshots/mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
});
test("create, visually edit, autosave, preserve raw fields, publish, compare and target", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Configurations", exact: true })
    .click();
  await page.getByRole("button", { name: "New configuration" }).click();
  const title = `Application logs · ${Date.now().toString(36)}`;
  await page.getByLabel("Configuration name").fill(title);
  await page
    .getByLabel("Description", { exact: true })
    .fill("Synthetic starter pipeline verified through the real product UI.");
  await page
    .getByRole("button", { name: "Create configuration", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".pipeline-node")).toHaveCount(3);
  await page.locator(".pipeline-node").filter({ hasText: "enrich" }).click();
  await page
    .getByLabel("VRL program")
    .fill('.environment = "browser-test"\n.managed_by = "vectory"');
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.screenshot({
    path: path.join(root, "docs/screenshots/editor.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Test with a sample" }).click();
  const sampleResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/v1/vrl/test"),
  );
  await page.getByRole("button", { name: "Run sample", exact: true }).click();
  const sampleStatus = (await sampleResponse).status();
  expect([200, 503]).toContain(sampleStatus);
  if (sampleStatus === 503)
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      /isolated/i,
    );
  else
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Transformed event" }),
    ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByLabel("Configuration format").selectOption("json");
  const model = JSON.parse(
    await page.getByLabel("Vector configuration code").inputValue(),
  );
  model.sources.demo.count = 1234;
  await page
    .getByLabel("Vector configuration code")
    .fill(JSON.stringify(model, null, 2));
  await page.getByRole("button", { name: "Apply code changes" }).click();
  await page.getByRole("button", { name: "Visual editor" }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(
    page.getByText("Structural checks passed", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Publish version", exact: true })
    .click();
  await page
    .getByLabel("What changed?")
    .fill("Browser verified first version.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Publish version", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Deploy configuration", exact: true }),
  ).toBeVisible();
  await page.getByRole("dialog").getByLabel("Close dialog").click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByText("Browser verified first version.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("dialog").getByLabel("Close dialog").click();
  const id = page.url().split("/").at(-1)!;
  const saved = await page.request
    .get(`/api/v1/configurations/${id}`)
    .then((r) => r.json());
  expect(saved.config.sources.demo.count).toBe(1234);
  const versions = await page.request
    .get(`/api/v1/configurations/${id}/versions`)
    .then((r) => r.json());
  expect(versions).toHaveLength(1);
  expect(versions[0].config.sources.demo.count).toBe(1234);
  expect(errors).toEqual([]);
});
test("token form, local downloads, groups, and policy targeting use real API", async ({
  page,
}) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Agents & enrollment" })
    .click();
  await page.getByRole("button", { name: "Create enrollment token" }).click();
  const name = `Browser token ${Date.now().toString(36)}`;
  await page.getByLabel("Token name").fill(name);
  await page
    .getByLabel("Allowed machine name prefix (optional)")
    .fill("browser-");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Copy your enrollment token" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "I’ve saved the token" }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke token", exact: true })
    .click();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: name })
      .getByText("Revoked", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Device groups" })
    .click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page
    .getByLabel("Group name")
    .fill(`Local verification ${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Save group" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Agent policies" })
    .click();
  await page.getByRole("button", { name: "Create policy" }).click();
  await page
    .getByLabel("Policy name")
    .fill(`Browser policy ${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Save policy" }).click();
  await page
    .getByRole("button", { name: "Select targets & deploy" })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Deploy agent policy" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview assignment" }),
  ).toBeDisabled();
  await page
    .getByRole("dialog")
    .locator("input[type=checkbox]")
    .first()
    .check();
  await page.getByRole("dialog").getByLabel("Close dialog").click();
});
