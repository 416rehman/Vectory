import { test, expect, type Page } from "@playwright/test";
import { readConfigurationCode } from "./code-editor";
import { setAppearance } from "./account-menu";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const screenshot = (name: string) =>
  path.join(root, `docs/screenshots/${name}.png`);
async function tool(page: Page, name: string) {
  if (name === "Configuration code") {
    await page.getByRole("button", { name: "Code", exact: true }).click();
    return;
  }
  await page
    .locator("summary")
    .filter({ hasText: /^Actions/ })
    .click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function appearance(page: Page, value: string) {
  await setAppearance(page, value);
}
async function addStep(page: Page, kind: string, name: string, input?: string) {
  const before = await page
    .locator(".react-flow__node")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")));
  await page
    .getByRole("button", { name: "Add component", exact: true })
    .click();
  const menu = page.getByRole("dialog", { name: "Add component", exact: true });
  await menu
    .getByRole("button", {
      name: (
        {
          source: "Sources",
          transformation: "Transforms",
          destination: "Destinations",
        } as Record<string, string>
      )[kind],
      exact: true,
    })
    .click();
  await menu.getByLabel("Search components").fill(name);
  await menu
    .locator(".canvas-component-result")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(
    before.length + 1,
  );
  const after = await page
    .locator(".react-flow__node")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")));
  const id = after.find((id) => !before.includes(id));
  expect(id).toBeTruthy();
  await done(page);
  await page
    .getByRole("button", { name: "Arrange graph", exact: true })
    .click();
  if (input) await connectSteps(page, input, id!);
  await page
    .locator(`.react-flow__node[data-id="${id}"] .pipeline-node`)
    .click();
  await expect(
    page.getByRole("heading", { name: name, exact: true }),
  ).toBeVisible();
}
async function connectSteps(page: Page, source: string, target: string) {
  const [id, ...port] = source.split(".");
  const name = port.length ? `${id} ${port.join(".")} output` : `${id} output`;
  await page.getByRole("button", { name, exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: `Input for ${target}`, exact: true })
    .focus();
  await page.keyboard.press("Enter");
  const edge = page.getByRole("group", {
    name: `Connection from ${id} to ${target}`,
    exact: true,
  });
  // A horizontal SVG group can have zero height while its stroke is rendered.
  await expect(edge).toBeAttached();
  const path = edge.locator("path.react-flow__edge-path");
  await expect(path).toHaveAttribute("d", /\S+/);
  await expect
    .poll(() =>
      path.evaluate((node) => (node as SVGPathElement).getTotalLength()),
    )
    .toBeGreaterThan(0);
}
async function done(page: Page) {
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
async function saved(page: Page) {
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
test.beforeEach(async ({ page }) => {
  expect((await page.request.get("/api/v1/session")).ok()).toBeTruthy();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Needs attention", exact: true }),
  ).toBeVisible();
});

test("native device metrics and persisted history appear without fabricated values", async ({
  page,
}) => {
  const native = JSON.parse(
    fs.readFileSync(path.join(root, ".local/preview/native-run.json"), "utf8"),
  );
  await page.goto("/#/devices/" + native.device_id);
  await page.getByRole("tab", { name: "Metrics", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Operational metrics", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /^Throughput, events \/ second/ }),
  ).toBeVisible();
  const history = await page.request
    .get(`/api/v1/devices/${native.device_id}/telemetry`)
    .then((r) => r.json());
  expect(history.samples.length).toBeGreaterThan(0);
  expect(
    history.samples.some((s: any) => s.events_per_second > 0),
  ).toBeTruthy();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({
    path: screenshot("device"),
    fullPage: true,
    animations: "disabled",
  });
});

test("focused navigation, account theme and responsive fleet use real data", async ({
  page,
}) => {
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation.getByRole("button")).toHaveText([
    "Overview",
    "Pipelines",
    "Devices",
    "Activity",
  ]);
  await expect(
    page.getByRole("heading", { name: "Recent activity", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: screenshot("overview"),
    fullPage: true,
    animations: "disabled",
  });
  await appearance(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: screenshot("overview-dark"),
    fullPage: true,
    animations: "disabled",
  });
  await appearance(page, "light");
  await navigation
    .getByRole("button", { name: "Devices", exact: true })
    .click();
  await expect(page.locator("table tbody tr")).not.toHaveCount(0);
  await page.getByPlaceholder("Search devices").fill("no-such-device");
  await expect(
    page.getByRole("heading", { name: "No matching devices", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Clear search").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await expect(navigation).not.toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await navigation
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Needs attention", exact: true }),
  ).toBeVisible();
  await expect(navigation).not.toBeVisible();
  await page.screenshot({
    path: screenshot("mobile"),
    fullPage: true,
    animations: "disabled",
  });
});

test("build an empty pipeline, connect steps, preserve raw fields and publish", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Pipelines", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create pipeline", exact: true })
    .first()
    .click();
  const title = `Application logs ${Date.now().toString(36)}`;
  await page.getByLabel("Pipeline name").fill(title);
  await expect(
    page.getByRole("radio", { name: /Build a pipeline/ }),
  ).toBeChecked();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create pipeline", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".pipeline-node")).toHaveCount(0);
  await addStep(page, "source", "Synthetic logs");
  await done(page);
  await addStep(page, "transformation", "Edit fields", "demo_logs");
  const marker = '.environment = "browser-test"\n.managed_by = "vectory"';
  await page.getByLabel("VRL program", { exact: true }).fill(marker);
  await page
    .locator(".editor-inspector")
    .locator("summary")
    .filter({ hasText: "Test with a sample event" })
    .click();
  await page.getByRole("button", { name: "Test with a sample" }).click();
  const sampleResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/v1/vrl/test"),
  );
  await page.getByRole("button", { name: "Run sample", exact: true }).click();
  const sampleStatus = (await sampleResponse).status();
  expect([200, 503]).toContain(sampleStatus);
  const sampleDialog = page.getByRole("dialog", {
    name: "Test transform",
  });
  if (sampleStatus === 503)
    await expect(sampleDialog.getByRole("alert")).toContainText(/isolated/i);
  else
    await expect(
      sampleDialog.getByRole("heading", { name: "Transformed event" }),
    ).toBeVisible();
  await sampleDialog
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await done(page);
  await addStep(page, "destination", "Console output", "remap");
  await done(page);
  await saved(page);
  await expect(page.locator(".pipeline-node")).toHaveCount(3);
  await tool(page, "Configuration code");
  await page.getByLabel("Format", { exact: true }).selectOption("json");
  const model = JSON.parse(await readConfigurationCode(page));
  expect(model.sinks.console.inputs).toEqual(["remap"]);
  expect(model.transforms.remap.inputs).toEqual(["demo_logs"]);
  model.sources.demo_logs.count = 1234;
  await page
    .getByLabel("Vector configuration code")
    .fill(JSON.stringify(model, null, 2));
  await page.getByRole("button", { name: "Apply code changes" }).click();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await saved(page);
  await page.screenshot({
    path: screenshot("editor"),
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Review & publish", exact: true })
    .click();
  await page
    .getByLabel("Version note (optional)")
    .fill("Browser verified first version.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Publish version", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose devices", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: `Deploy ${title} v1`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review deployment" }),
  ).toBeDisabled();
  await page.getByRole("dialog").getByLabel("Close dialog").click();
  await tool(page, "Version history");
  await expect(
    page
      .locator(".history-preview")
      .getByText("Browser verified first version.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Back to editor", exact: true })
    .click();
  const id = page.url().split("/").at(-1)!;
  const document = await page.request
    .get(`/api/v1/configurations/${id}`)
    .then((r) => r.json());
  expect(document.config.sources.demo_logs.count).toBe(1234);
  const versions = await page.request
    .get(`/api/v1/configurations/${id}/versions`)
    .then((r) => r.json());
  expect(versions).toHaveLength(1);
  expect(versions[0].config).toEqual(document.config);
  expect(errors).toEqual([]);
});

test("multiple sources and destinations remain editable with independent connections", async ({
  page,
}) => {
  const session = await page.request
    .get("/api/v1/session")
    .then((r) => r.json());
  const response = await page.request.post("/api/v1/configurations", {
    headers: { "X-CSRF-Token": session.csrf_token },
    data: {
      name: `Multiple paths ${Date.now()}`,
      description:
        "Synthetic multi-source and multi-destination UI regression.",
      config: { sources: {}, transforms: {}, sinks: {} },
      graph: { nodes: [], edges: [] },
    },
  });
  expect(response.ok()).toBeTruthy();
  const doc = await response.json();
  await page.goto("/#/configurations/" + doc.id);
  await addStep(page, "source", "Synthetic logs");
  await done(page);
  await addStep(page, "transformation", "Edit fields", "demo_logs");
  await done(page);
  await addStep(page, "destination", "Console output", "remap");
  await done(page);
  await addStep(page, "source", "Synthetic logs");
  await done(page);
  await addStep(page, "destination", "Console output", "remap");
  await done(page);
  const oldEdge = page.getByRole("group", {
    name: "Connection from remap to console_2",
    exact: true,
  });
  await oldEdge.focus();
  await page.keyboard.press("Enter");
  await expect(oldEdge).toHaveClass(/selected/);
  await page.keyboard.press("Delete");
  await expect(oldEdge).toHaveCount(0);
  await connectSteps(page, "demo_logs_2", "console_2");
  await expect(page.locator(".pipeline-node-sources")).toHaveCount(2);
  await expect(page.locator(".pipeline-node-sinks")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Add component", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: /Input connections/ }),
  ).toHaveCount(0);
  await saved(page);
  const document = await page.request
    .get(`/api/v1/configurations/${doc.id}`)
    .then((r) => r.json());
  expect(Object.keys(document.config.sources)).toHaveLength(2);
  expect(Object.keys(document.config.sinks)).toHaveLength(2);
  expect(document.config.sinks.console.inputs).toEqual(["remap"]);
  expect(document.config.sinks.console_2.inputs).toEqual(["demo_logs_2"]);
  await page.reload();
  await expect(page.locator(".pipeline-node")).toHaveCount(5);
  await page.screenshot({
    path: screenshot("editor-multiple-paths"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
});

test("staged enrollment, token management, groups and deployment review use real API", async ({
  page,
}) => {
  await page.goto("/#/enrollment");
  await expect(
    page.getByRole("heading", { name: "Get the agent", exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "Windows", exact: true }).check();
  await expect(
    page.getByRole("link", { name: "Download agent", exact: true }),
  ).toHaveAttribute("href", /\/api\/v1\/releases\//);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Machine name", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Server URL", { exact: true })).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: /^Manage enrollment tokens/ })
    .click();
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const name = `Browser token ${Date.now().toString(36)}`;
  await page.getByRole("dialog").getByLabel("Token name").fill(name);
  await page
    .getByRole("dialog")
    .getByLabel("Allowed machine name prefix (optional)")
    .fill("browser-");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create token", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Save your enrollment token" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "I've saved the token", exact: true })
    .click();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke token", exact: true })
    .click();
  const revoked = page.getByRole("dialog", { name: "Token revoked" });
  await expect(revoked).toBeVisible();
  await revoked.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
  const groupName = `Local verification ${Date.now().toString(36)}`;
  const session = await page.request
    .get("/api/v1/session")
    .then((r) => r.json());
  const existingGroups = await page.request
    .get("/api/v1/groups")
    .then((r) => r.json());
  const preceding = existingGroups.filter(
    (group: { name: string }) => group.name.localeCompare(groupName) < 0,
  ).length;
  // Exercise the page boundary even on a fresh test instance. These empty,
  // explicitly synthetic groups never assign any devices or workloads.
  for (let index = preceding; index < 12; index++) {
    const seed = await page.request.post("/api/v1/groups", {
      headers: { "X-CSRF-Token": session.csrf_token },
      data: {
        name: `A pagination fixture ${Date.now().toString(36)} ${index}`,
        description: "Synthetic browser verification; never assigned.",
        device_ids: [],
      },
    });
    expect(seed.ok()).toBeTruthy();
  }
  await page.goto("/#/groups");
  await page
    .getByRole("textbox", { name: "Search groups", exact: true })
    .fill(`No matching group ${Date.now()}`);
  await expect(
    page.getByRole("heading", { name: "No matching groups" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create group", exact: true })
    .first()
    .click();
  await page.getByLabel("Group name").fill(groupName);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create group", exact: true })
    .click();
  await expect(
    page.getByRole("row").filter({ hasText: groupName }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Search groups", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Previous", exact: true }),
  ).toBeEnabled();
  // A rename can change its page as well; the saved group must remain visible.
  await page
    .getByRole("row")
    .filter({ hasText: groupName })
    .getByRole("button", { name: "Edit group", exact: true })
    .click();
  const renamedGroup = `A renamed verification ${Date.now().toString(36)}`;
  await page.getByLabel("Group name").fill(renamedGroup);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("row").filter({ hasText: renamedGroup }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Device sections" })
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  await page.getByRole("button", { name: "New settings", exact: true }).click();
  const policyName = `Browser settings ${Date.now().toString(36)}`;
  await page.getByLabel("Settings name").fill(policyName);
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  const savedSettings = page.getByRole("dialog", {
    name: "Agent settings saved",
  });
  await expect(
    savedSettings.getByText(policyName, { exact: true }),
  ).toBeVisible();
  await savedSettings
    .getByRole("button", { name: "Apply to devices", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Apply agent settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review deployment", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("dialog")
    .getByRole("checkbox", { name: /^Select (?!devices on this page)/ })
    .first()
    .check();
  const previewResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/deployments/preview") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Review deployment", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Back to selection", exact: true }),
  ).toBeVisible();
  const preview = await (await previewResponse).json();
  const apply = page.getByRole("button", {
    name: "Apply settings",
    exact: true,
  });
  if (preview.conflicts.length) {
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "conflicting assignment",
    );
    await expect(apply).toBeDisabled();
  } else await expect(apply).toBeEnabled();
  await page.getByRole("dialog").getByLabel("Close dialog").click();
});
