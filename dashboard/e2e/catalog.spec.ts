import { setAppearance } from "./account-menu";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
async function newPipeline(page: any, name: string) {
  const session = await page.request
    .get("/api/v1/session")
    .then((r: any) => r.json());
  const response = await page.request.post("/api/v1/configurations", {
    headers: { "X-CSRF-Token": session.csrf_token },
    data: {
      name: `${name} ${Date.now()}`,
      description: "Synthetic browser verification. Never deployed.",
      config: { sources: {}, transforms: {}, sinks: {} },
      graph: { nodes: [], edges: [] },
    },
  });
  expect(response.ok()).toBeTruthy();
  const doc = await response.json();
  await page.goto("/#/configurations/" + doc.id);
  await expect(
    page.getByRole("button", { name: "Add component", exact: true }),
  ).toBeVisible();
  return doc;
}
async function done(page: any) {
  const sidebar = await page.locator(".editor-inspector").isVisible();
  const context = sidebar
    ? page.locator(".editor-inspector")
    : page.getByRole("dialog");
  await context
    .getByRole("button", {
      name: sidebar ? "Close component settings" : "Done",
      exact: true,
    })
    .click();
}
async function saved(page: any) {
  await page.getByRole("button", { name: "Save options" }).click();
  const save = page.getByRole("menuitem", { name: "Save draft", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
}

test("full Vector catalog configures Kafka and S3 using generated forms", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const doc = await newPipeline(page, "Kafka to S3");
  await page
    .getByRole("button", { name: "Add component", exact: true })
    .click();
  const menu = page.getByRole("dialog", { name: "Add component", exact: true });
  await menu.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(menu.locator(".canvas-component-result")).toHaveCount(48);
  await menu.getByLabel("Search components").fill("kafka");
  await expect(menu.locator(".canvas-component-result")).toHaveCount(1);
  await menu.locator(".canvas-component-result").click();
  await page
    .getByLabel("Bootstrap Servers", { exact: true })
    .fill("broker.example.test:9092");
  await page.getByLabel("Group ID", { exact: true }).fill("vectory-browser");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Item 1", { exact: true }).fill("application-logs");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Item 2", { exact: true }).fill("audit-events");
  await done(page);
  await page
    .getByRole("button", { name: "Add component", exact: true })
    .click();
  await menu.getByRole("button", { name: "Destinations", exact: true }).click();
  await expect(menu.locator(".canvas-component-result")).toHaveCount(62);
  await menu.getByLabel("Search components").fill("aws_s3");
  await menu.locator(".canvas-component-result").click();
  await page
    .getByLabel("Bucket", { exact: true })
    .fill("vectory-browser-fixture");
  await page
    .getByLabel("Codec", { exact: true })
    .selectOption({ label: "JSON" });
  await page
    .locator(".editor-inspector-field-picker")
    .getByRole("button", { name: "Add field", exact: true })
    .click();
  await page.getByLabel("Find optional fields", { exact: true }).fill("region");
  await page
    .locator(".schema-field-picker-results")
    .getByRole("button")
    .filter({ has: page.getByText("Region", { exact: true }) })
    .click();
  await page.getByLabel("Region", { exact: true }).fill("us-east-1");
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.failureSummary),
    })),
  ).toEqual([]);
  await expect(
    page.getByLabel("Find optional fields", { exact: true }),
  ).toHaveCount(0);
  await saved(page);
  await page.locator(".editor-inspector-body").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: path.join(root, "docs/screenshots/component-settings.png"),
    animations: "disabled",
  });
  await setAppearance(page, "dark");
  const darkAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(darkAccessibility.violations.map((violation) => violation.id)).toEqual(
    [],
  );
  await page.locator(".editor-inspector-body").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: path.join(root, "docs/screenshots/component-settings-dark.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".editor-inspector")).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await expect(page.getByLabel("Region", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setAppearance(page, "light");
  await done(page);
  await page
    .getByRole("button", { name: "Arrange graph", exact: true })
    .click();
  await page.getByRole("button", { name: "kafka output", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "Input for aws_s3", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  const edge = page.getByRole("group", {
    name: "Connection from kafka to aws_s3",
    exact: true,
  });
  // A horizontal SVG group can have zero height while its stroke is rendered.
  await expect(edge).toBeAttached();
  const edgePath = edge.locator("path.react-flow__edge-path");
  await expect(edgePath).toHaveAttribute("d", /\S+/);
  await expect
    .poll(() =>
      edgePath.evaluate((node) => (node as SVGPathElement).getTotalLength()),
    )
    .toBeGreaterThan(0);
  await saved(page);
  const savedDoc = await page.request
    .get(`/api/v1/configurations/${doc.id}`)
    .then((r) => r.json());
  expect(savedDoc.config.sources.kafka).toMatchObject({
    type: "kafka",
    bootstrap_servers: "broker.example.test:9092",
    group_id: "vectory-browser",
    topics: ["application-logs", "audit-events"],
  });
  expect(savedDoc.config.sinks.aws_s3).toMatchObject({
    type: "aws_s3",
    inputs: ["kafka"],
    bucket: "vectory-browser-fixture",
    region: "us-east-1",
    encoding: { codec: "json" },
  });
  await page
    .getByRole("button", { name: "Review & publish", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Publish version", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose devices", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    /restricted|full Vector/i,
  );
  await page
    .getByRole("dialog")
    .getByRole("checkbox", { name: /^Select (?!devices on this page)/ })
    .first()
    .check();
  const review = page.getByRole("button", {
    name: "Review deployment",
    exact: true,
  });
  if (await review.isEnabled()) {
    await review.click();
    const commit = page.getByRole("button", {
      name: "Deploy to devices",
      exact: true,
    });
    await expect(commit).toBeVisible();
    await expect(commit).toBeDisabled();
  } else await expect(review).toBeDisabled();
  await page.getByRole("dialog").getByLabel("Close dialog").click();
  await page.reload();
  await expect(page.locator(".pipeline-node")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("a component outside the catalog can be added and preserved from the picker", async ({
  page,
}) => {
  const doc = await newPipeline(page, "Custom Vector build");
  await page
    .getByRole("button", { name: "Add component", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Add component", exact: true })
    .getByRole("button", { name: "Import a component definition", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Import component definition",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Component category", { exact: true })
    .selectOption("sources");
  const component = {
    type: "custom_receiver",
    endpoint: "https://collector.example.test/ingest",
    tuning: { retry_limit: 17, extension_flag: true },
  };
  await page
    .getByLabel("Component definition (JSON)", { exact: true })
    .fill(JSON.stringify(component, null, 2));
  await page
    .getByRole("button", { name: "Add component from JSON", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "custom_receiver",
      exact: true,
    }),
  ).toBeVisible();
  await done(page);
  await saved(page);
  await page.reload();
  await expect(page.locator(".pipeline-node")).toHaveCount(1);
  const savedDoc = await page.request
    .get(`/api/v1/configurations/${doc.id}`)
    .then((r) => r.json());
  expect(savedDoc.config.sources.custom_receiver).toEqual(component);
  await page.locator(".pipeline-node").click();
  await expect(page.locator(".editor-inspector")).toContainText(
    /full Vector mode|restricted/i,
  );
});

test("global options, enrichment, secret backends and test definitions are editable", async ({
  page,
}) => {
  const session = await page.request
    .get("/api/v1/session")
    .then((r) => r.json());
  const config = JSON.parse(
    fs.readFileSync(
      path.join(root, "vector-catalog/fixtures/remap.json"),
      "utf8",
    ),
  );
  config.tests = [
    {
      name: "Before rename",
      inputs: [
        {
          insert_at: "process",
          type: "log",
          log_fields: { message: "synthetic example" },
        },
      ],
      outputs: [
        {
          extract_from: "process",
          conditions: ['.environment == "development"'],
        },
      ],
    },
  ];
  const response = await page.request.post("/api/v1/configurations", {
    headers: { "X-CSRF-Token": session.csrf_token },
    data: {
      name: `Complete configuration ${Date.now()}`,
      description: "Synthetic full configuration UI regression.",
      config,
      graph: { nodes: [], edges: [] },
    },
  });
  expect(response.ok()).toBeTruthy();
  const doc = await response.json();
  await page.goto("/#/configurations/" + doc.id);
  await page
    .getByRole("button", { name: "Pipeline settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Pipeline settings",
    exact: true,
  });
  const navigation = page.getByRole("navigation", {
    name: "Pipeline settings sections",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Add field", exact: true }).click();
  await page
    .getByLabel("Find optional fields", { exact: true })
    .fill("timezone");
  await page
    .locator(".schema-field-picker-results")
    .getByRole("button")
    .filter({ has: page.getByText("Timezone", { exact: true }) })
    .click();
  for (
    let layer = 0;
    layer < 3 &&
    !(await dialog
      .getByRole("textbox", { name: "Timezone", exact: true })
      .isVisible());
    layer++
  ) {
    const format = dialog.getByLabel(/^Timezone (format|mode)$/).last();
    const options = await format.locator("option").evaluateAll((items) =>
      items.map((item) => ({
        value: (item as HTMLOptionElement).value,
        text: item.textContent || "",
      })),
    );
    const custom = options.find(
      (option) => option.value && !/^(null|local)$/i.test(option.text),
    );
    expect(custom).toBeTruthy();
    await format.selectOption(custom!.value);
  }
  await dialog
    .getByRole("textbox", { name: "Timezone", exact: true })
    .fill("UTC");
  await navigation
    .getByRole("button", { name: "Enrichment tables", exact: true })
    .click();
  await dialog.getByLabel("New table name", { exact: true }).fill("lookup");
  await dialog.getByRole("button", { name: "Add table", exact: true }).click();
  await dialog
    .getByLabel("Type", { exact: true })
    .selectOption({ label: "Memory" });
  await navigation
    .getByRole("button", { name: "Secrets", exact: true })
    .click();
  await dialog
    .getByLabel("New backend name", { exact: true })
    .fill("local_keys");
  await dialog
    .getByRole("button", { name: "Add backend", exact: true })
    .click();
  await dialog
    .getByLabel("Type", { exact: true })
    .selectOption({ label: "File" });
  await dialog
    .getByLabel("Path", { exact: true })
    .fill("C:/ProgramData/Vectory/secrets.json");
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    a11y.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.failureSummary),
    })),
  ).toEqual([]);
  await dialog.screenshot({
    path: path.join(root, "docs/screenshots/pipeline-settings.png"),
    animations: "disabled",
  });
  await navigation.getByRole("button", { name: "Tests", exact: true }).click();
  await dialog
    .getByLabel("Name", { exact: true })
    .fill("Enrichment preserves synthetic fields");
  const testResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/v1/configurations/test"),
  );
  await dialog
    .getByRole("button", { name: "Run pipeline tests", exact: true })
    .click();
  const run = await testResponse;
  expect([200, 503]).toContain(run.status());
  if (run.status() === 200) {
    const result = await run.json();
    expect(result.deferred).toBeTruthy();
    expect(result.tests_run).toBeFalsy();
    await expect(dialog).toContainText(
      "These tests need the device environment",
    );
  } else
    await expect(dialog.getByRole("alert")).toContainText(
      /isolated|unavailable/i,
    );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await done(page);
  await saved(page);
  const stored = await page.request
    .get(`/api/v1/configurations/${doc.id}`)
    .then((r) => r.json());
  expect(stored.config.timezone).toBe("UTC");
  expect(stored.config.enrichment_tables.lookup.type).toBe("memory");
  expect(stored.config.secret.local_keys).toMatchObject({
    type: "file",
    path: "C:/ProgramData/Vectory/secrets.json",
  });
  expect(stored.config.tests[0].name).toBe(
    "Enrichment preserves synthetic fields",
  );
  expect(stored.config.tests[0].inputs).toEqual(config.tests[0].inputs);
  expect(stored.config.tests[0].outputs).toEqual(config.tests[0].outputs);
});
