import { test, expect, type Page } from "@playwright/test";
import { readConfigurationCode } from "./code-editor";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import fs from "node:fs";

test.use({ trace: "off" });
const root = path.resolve(import.meta.dirname, "../..");
const fixtures: string[] = [];
let headers: Record<string, string>;
const baseConfig = () => ({
  sources: { sample: { type: "demo_logs", format: "json", interval: 1 } },
  transforms: {},
  sinks: { out: { type: "blackhole", inputs: ["sample"] } },
});
async function read(page: Page, id: string) {
  const r = await page.request.get(`/api/v1/configurations/${id}`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}
async function create(
  page: Page,
  name = "Synthetic lifecycle check",
  config: Record<string, unknown> = baseConfig(),
) {
  const r = await page.request.post("/api/v1/configurations", {
    headers,
    data: {
      name: `${name} ${Date.now()}-${fixtures.length}`,
      description: "Synthetic browser verification. Never deployed.",
      config,
      graph: { nodes: [], edges: [] },
    },
  });
  expect(r.ok()).toBeTruthy();
  const doc = await r.json();
  fixtures.push(doc.id);
  return doc;
}
async function open(page: Page, doc: any, suffix = "") {
  await page.goto(`/#/configurations/${doc.id}${suffix}`);
  await expect(
    page.getByRole("heading", { name: doc.name, exact: true }),
  ).toBeVisible();
}
async function tool(page: Page, name: string) {
  await page.locator(".editor-tools-menu > summary").click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function saveDraft(page: Page) {
  await page.getByRole("button", { name: "Save options" }).click();
  const save = page.getByRole("menuitem", { name: "Save draft", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
}
async function history(page: Page) {
  await tool(page, "Version history");
  await expect(
    page.getByRole("region", { name: "Pipeline history" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Draft revisions", exact: true })
    .click();
}
async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}
test.beforeEach(async ({ page }) => {
  fixtures.length = 0;
  const r = await page.request.get("/api/v1/session");
  expect(r.ok()).toBeTruthy();
  headers = { "X-CSRF-Token": (await r.json()).csrf_token };
});
test.afterEach(async ({ page }) => {
  for (const id of fixtures) {
    const doc = await read(page, id);
    if (!doc.archived) {
      const r = await page.request.post(
        `/api/v1/configurations/${id}/archive`,
        { headers, data: { revision: doc.revision } },
      );
      expect(r.ok()).toBeTruthy();
    }
  }
});

test("history preserves unfinished code and the full-page graph layout", async ({
  page,
}) => {
  const doc = await create(page);
  await open(page, doc);
  const graph = page.locator(".editor-workspace");
  expect((await graph.boundingBox())!.height).toBeGreaterThan(500);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const pending = "sources:\n  incomplete: {";
  await page.getByLabel("Vector configuration code").fill(pending);
  await history(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText(/Some editor fields have unapplied changes/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View revision 1", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restore as draft", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Back to editor", exact: true })
    .click();
  await expect
    .poll(() => page.getByLabel("Vector configuration code").innerText())
    .toBe(pending);
  expect((await read(page, doc.id)).revision).toBe(1);
  await page
    .getByLabel("Vector configuration code")
    .fill(JSON.stringify(doc.config));
  await page
    .getByRole("button", { name: "Apply code changes", exact: true })
    .click();
  await saveDraft(page);
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
});

test("unfinished component field input survives history and prompts before leaving the editor", async ({
  page,
}) => {
  const doc = await create(page, "Synthetic pending field", {
    sources: { input: { type: "demo_logs", format: "json", interval: 1 } },
    transforms: {
      sample: { type: "sample", inputs: ["input"], rate: 10 },
    },
    sinks: { out: { type: "blackhole", inputs: ["sample"] } },
  });
  await open(page, doc);
  await page.locator('.react-flow__node[data-id="sample"]').click();
  const inspector = page.locator(".editor-inspector");
  const rate = inspector.getByLabel("One in every", { exact: true });
  await rate.fill("-");
  await expect(
    page.locator(".pipeline-save-status[data-save-state='unapplied']:visible"),
  ).toContainText("Unapplied field changes");
  await history(page);
  await page
    .getByRole("button", { name: "Back to editor", exact: true })
    .click();
  await expect(rate).toHaveValue("-");
  const dialog = page.waitForEvent("dialog");
  const leave = page
    .getByRole("button", { name: "Pipelines", exact: true })
    .first()
    .click({ noWaitAfter: true });
  const prompt = await dialog;
  expect(prompt.message()).toContain("Unsaved changes");
  await prompt.dismiss();
  await leave;
  await expect(rate).toHaveValue("-");
  await expect(page).toHaveURL(new RegExp(doc.id));
  await rate.fill("10");
  await axe(page);
});

test("restore waits for an in-flight save and keeps both snapshots, metadata and undo", async ({
  page,
}) => {
  const doc = await create(page, "Synthetic restore snapshot");
  await open(page, doc);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    captured = new Promise<void>((resolve) => (entered = resolve));
  let held = false;
  await page.route(
    `**/api/v1/configurations/${doc.id}/draft`,
    async (route) => {
      if (route.request().method() === "PUT" && !held) {
        held = true;
        entered();
        await gate;
      }
      await route.continue();
    },
  );
  const changed = {
    ...doc.config,
    timezone: "UTC",
    opaque_future: { "a.b": [false, null, 0, ""] },
  };
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page
    .getByLabel("Vector configuration code")
    .fill(JSON.stringify(changed));
  await page
    .getByRole("button", { name: "Apply code changes", exact: true })
    .click();
  await saveDraft(page);
  await captured;
  try {
    await history(page);
    await page
      .getByRole("button", { name: "View revision 1", exact: true })
      .click();
    await expect(
      page
        .locator(".history-change-heading")
        .getByText("timezone", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Restore as draft", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Restore draft", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("button", { name: /Restore draft$/ }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Pipeline history" }),
  ).toHaveCount(0);
  const restored = await read(page, doc.id);
  expect(restored.config).toEqual(doc.config);
  expect(restored.name).toBe(doc.name);
  expect(restored.description).toBe(doc.description);
  expect(restored.revision).toBe(3);
  const saved = await page.request
    .get(`/api/v1/configurations/${doc.id}/revisions`)
    .then((r) => r.json());
  expect(saved.find((r: any) => r.revision === 2).config).toEqual(changed);
  expect(saved[0].source.kind).toBe("revision");
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await saveDraft(page);
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
  expect((await read(page, doc.id)).config).toEqual(changed);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  expect(await readConfigurationCode(page)).toMatch(/UTC/);
});

test("library paging, stale-copy review, archive and unarchive are usable on desktop and mobile", async ({
  page,
}) => {
  const prefix = `Synthetic library ${Date.now()}`;
  const docs = [];
  for (let i = 0; i < 13; i++)
    docs.push(await create(page, `${prefix} ${String(i).padStart(2, "0")}`));
  const libraryRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      request.url().includes("/api/v1/configurations")
    )
      libraryRequests.push(request.url());
  });
  await page.goto("/#/configurations");
  await page.getByLabel("Search pipelines").fill(prefix);
  await page
    .getByRole("button", { name: "Sort by Pipeline", exact: true })
    .click();
  await expect(
    page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
  ).toHaveCount(12);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
  ).toHaveCount(1);
  expect(
    libraryRequests.every(
      (url) => new URL(url).pathname === "/api/v1/configurations/library",
    ),
  ).toBe(true);
  expect(
    libraryRequests.some(
      (url) => new URL(url).searchParams.get("page") === "2",
    ),
  ).toBe(true);
  await page.locator(".pipeline-list-item").click();
  await expect(
    page.getByRole("heading", { name: docs[12].name, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pipelines", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("Search pipelines")).toHaveValue(prefix);
  await expect(
    page.getByRole("columnheader", { name: /Sort by Pipeline/ }),
  ).toHaveAttribute("aria-sort", "ascending");
  await expect(
    page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
  ).toHaveCount(1);
  await expect(page.locator(".pagination")).toContainText("2 / 2");
  // Removing the final row on the final page should return to the previous page.
  await page
    .getByLabel(`Actions for ${docs[12].name}`, { exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Archive pipeline", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive pipeline", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
  ).toHaveCount(12);
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  expect((await read(page, docs[12].id)).archived).toBe(true);
  const original = docs[0];
  await page
    .getByLabel(`Actions for ${original.name}`, { exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Duplicate pipeline", exact: true })
    .click();
  const dialog = page.getByRole("dialog"),
    copyName = `${prefix} reviewed copy`;
  await dialog.getByLabel("Pipeline name", { exact: true }).fill(copyName);
  const remoteConfig = { ...original.config, timezone: "UTC" };
  expect(
    (
      await page.request.put(`/api/v1/configurations/${original.id}/draft`, {
        headers,
        data: {
          revision: original.revision,
          config: remoteConfig,
          graph: original.graph,
        },
      })
    ).ok(),
  ).toBeTruthy();
  await dialog
    .getByRole("button", { name: "Duplicate pipeline", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Load latest for review" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Load latest for review" }).click();
  await expect(dialog.getByLabel("Pipeline name", { exact: true })).toHaveValue(
    copyName,
  );
  await dialog
    .locator("summary")
    .filter({ hasText: "Review latest configuration" })
    .click();
  await expect(dialog.locator("pre")).toContainText("UTC");
  await dialog
    .getByRole("button", { name: "Duplicate pipeline", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: copyName, exact: true }),
  ).toBeVisible();
  const copyId = page.url().split("configurations/")[1];
  fixtures.push(copyId);
  expect((await read(page, copyId)).config).toEqual(remoteConfig);
  expect((await read(page, original.id)).revision).toBe(2);
  await tool(page, "Archive pipeline");
  await dialog
    .getByRole("button", { name: "Archive pipeline", exact: true })
    .click();
  await expect(
    page.getByText("Archived pipeline.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Pipelines", exact: true })
    .last()
    .click();
  await page.getByLabel("Search pipelines").fill(copyName);
  await expect(
    page.getByRole("heading", { name: "No matching pipelines" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Filter Status", exact: true })
    .click();
  await page
    .getByRole("radio", { name: "Archived pipelines", exact: true })
    .click();
  await expect(
    page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
  ).toHaveCount(1);
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await axe(page);
  await page.screenshot({
    path: path.join(root, "docs/screenshots/pipeline-library-mobile.png"),
    fullPage: true,
  });
  await page.getByLabel(`Actions for ${copyName}`, { exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Unarchive pipeline", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Unarchive pipeline", exact: true })
    .click();
  await expect(
    page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
  ).toHaveCount(0);
  expect((await read(page, copyId)).archived).toBe(false);
});

test("library search ignores late results, retries failures and loads metadata only", async ({
  page,
}) => {
  const first = await create(page, "Synthetic delayed library search");
  const second = await create(page, "Synthetic newest library search");
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: () => void;
  const requested = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let finished!: () => void;
  const delivered = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let fail = true;
  await page.route("**/api/v1/configurations/library?*", async (route) => {
    const search = new URL(route.request().url()).searchParams.get("search");
    if (search === first.name) {
      const response = await route.fetch();
      captured();
      await delayed;
      await route.fulfill({ response });
      finished();
    } else if (search === "retry-library-query" && fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: {
          error: { code: "UNAVAILABLE", message: "Synthetic library outage" },
        },
      });
    } else await route.continue();
  });
  try {
    await page.goto("/#/configurations");
    await page.getByLabel("Search pipelines").fill(first.name);
    await requested;
    const latestResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/v1/configurations/library" &&
        url.searchParams.get("search") === second.name
      );
    });
    await page.getByLabel("Search pipelines").fill(second.name);
    const body = await (await latestResponse).json();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].component_counts).toEqual({
      sources: 1,
      transforms: 0,
      sinks: 1,
    });
    for (const field of ["config", "graph", "artifact", "validation"])
      expect(body.items[0]).not.toHaveProperty(field);
    await expect(
      page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
    ).toHaveCount(1);
    await expect(
      page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
    ).toContainText(second.name);
    const staleResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).searchParams.get("search") === first.name,
    );
    release();
    await delivered;
    await (await staleResponse).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
    ).toContainText(second.name);
    await expect(
      page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
    ).not.toContainText(first.name);
    await page.getByLabel("Search pipelines").fill("retry-library-query");
    await expect(
      page.getByText("Synthetic library outage", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".pipeline-library-table tbody tr:has(.pipeline-list-item)"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "No matching pipelines" }),
    ).toBeVisible();
    await expect(
      page.getByText("Synthetic library outage", { exact: true }),
    ).toHaveCount(0);
    const overviewRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "GET")
        overviewRequests.push(new URL(request.url()).pathname);
    });
    await page.goto("/#/overview");
    await expect(page.locator(".fleet-activity-list")).toContainText(
      second.name,
    );
    const session = await page.request
      .get("/api/v1/session")
      .then((response) => response.json());
    await expect(page.locator(".fleet-activity-list")).toContainText(
      session.user.name,
    );
    expect(overviewRequests).not.toContain("/api/v1/configurations");
  } finally {
    release();
    await page.unroute("**/api/v1/configurations/library?*");
  }
});

test("device context reaches deployment review and clearing it preserves unfinished code", async ({
  page,
}) => {
  const native = JSON.parse(
    fs.readFileSync(path.join(root, ".local/preview/native-run.json"), "utf8"),
  );
  const device = await page.request
    .get(`/api/v1/devices/${native.device_id}`)
    .then((r) => r.json());
  const doc = await create(page, "Synthetic target context");
  const published = await page.request.post(
    `/api/v1/configurations/${doc.id}/publish`,
    {
      headers,
      data: {
        revision: doc.revision,
        message: "Synthetic target review; never deployed.",
      },
    },
  );
  expect(published.ok()).toBeTruthy();
  await page.goto(`/#/configurations?device=${device.id}`);
  await page.getByLabel("Search pipelines").fill(doc.name);
  await page.locator(".pipeline-list-item").click();
  await expect(
    page.getByRole("complementary", { name: "Selected deployment device" }),
  ).toContainText(device.name);
  await page
    .getByRole("button", { name: "Choose devices", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("checkbox", { name: `Select ${device.name}`, exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const pending = "unapplied: {";
  await page.getByLabel("Vector configuration code").fill(pending);
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect
    .poll(() => page.getByLabel("Vector configuration code").innerText())
    .toBe(pending);
  await expect(page).toHaveURL(new RegExp(`${doc.id}$`));
  await page
    .getByLabel("Vector configuration code")
    .fill(JSON.stringify(doc.config));
  await page.getByRole("button", { name: "Apply code changes" }).click();
  await saveDraft(page);
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
  await tool(page, "Archive pipeline");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive pipeline", exact: true })
    .click();
  await tool(page, "Version history");
  await expect(
    page.getByRole("button", { name: "Deploy this version", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Restore as draft", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: path.join(root, "docs/screenshots/pipeline-history.png"),
    fullPage: true,
  });
  await axe(page);
});

test("format changes reject lossy TOML and restoring null-bearing snapshots falls back to complete JSON", async ({
  page,
}) => {
  const config = { ...baseConfig(), opaque_future: { nullable: null } };
  const doc = await create(page, "Synthetic format preservation", config);
  await open(page, doc);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const code = page.getByLabel("Vector configuration code");
  const before = await readConfigurationCode(page);
  await page.getByLabel("Format", { exact: true }).selectOption("toml");
  await expect(
    page.getByText(/TOML cannot preserve opaque_future.nullable/),
  ).toBeVisible();
  await expect(page.getByLabel("Format", { exact: true })).toHaveValue("yaml");
  expect(await readConfigurationCode(page)).toBe(before);
  expect((await read(page, doc.id)).config).toEqual(config);

  const supported = baseConfig();
  await code.fill(JSON.stringify(supported));
  await page
    .getByRole("button", { name: "Apply code changes", exact: true })
    .click();
  await saveDraft(page);
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
  await page.getByLabel("Format", { exact: true }).selectOption("toml");
  await expect(page.getByLabel("Format", { exact: true })).toHaveValue("toml");
  await history(page);
  await page
    .getByRole("button", { name: "View revision 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Restore as draft", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Restore draft", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Format", { exact: true })).toHaveValue("json");
  expect(JSON.parse(await readConfigurationCode(page))).toEqual(config);
  await expect(
    page.getByText(/Showing the complete configuration as JSON/),
  ).toBeVisible();
  expect((await read(page, doc.id)).config).toEqual(config);
  const downloading = page.waitForEvent("download");
  await tool(page, "Export configuration");
  const exported = await downloading;
  expect(exported.suggestedFilename()).toMatch(/\.json$/);
  expect(JSON.parse(fs.readFileSync((await exported.path())!, "utf8"))).toEqual(
    config,
  );
  await expect(page.getByLabel("Format", { exact: true })).toHaveValue("json");
});
