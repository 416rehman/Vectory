import { test, expect } from "@playwright/test";
import { openAccountMenu } from "./account-menu";

test("contextual help opens at the explanation without disturbing an unfinished field", async ({
  page,
}) => {
  const session = await page.request
    .get("/api/v1/session")
    .then((r) => r.json());
  const config = {
    sources: { example: { type: "demo_logs", format: "json" } },
    transforms: { sample: { type: "sample", inputs: ["example"], rate: 10 } },
    sinks: { discard: { type: "blackhole", inputs: ["sample"] } },
  };
  const response = await page.request.post("/api/v1/configurations", {
    headers: { "X-CSRF-Token": session.csrf_token },
    data: {
      name: `Synthetic help preservation ${Date.now()}`,
      description: "Browser verification; never deployed.",
      config,
      graph: { nodes: [], edges: [] },
    },
  });
  expect(response.ok()).toBeTruthy();
  const doc = await response.json();
  await page.goto(`/#/configurations/${doc.id}`);
  await page.locator('.react-flow__node[data-id="sample"]').click();
  const inspector = page.locator(".editor-inspector");
  const rate = inspector.getByLabel("One in every", { exact: true });
  await rate.fill("-");
  await expect(
    page.locator(".pipeline-save-status[data-save-state='unapplied']:visible"),
  ).toContainText("Unapplied field changes");
  const pageHelpPopup = page.waitForEvent("popup");
  await page
    .getByRole("link", {
      name: "Help for the pipeline editor (opens in a new tab)",
      exact: true,
    })
    .click();
  const pageHelp = await pageHelpPopup;
  await expect(pageHelp).toHaveURL(
    new RegExp(
      `/help/pipelines/\\?pipeline=${doc.id}#add-and-connect-components$`,
    ),
  );
  await expect(
    pageHelp.locator("#add-and-connect-components"),
  ).toBeInViewport();
  await pageHelp.close();
  await expect(rate).toHaveValue("-");
  // The inspector has no input-pattern help link any more; open the same
  // pipeline-scoped help page in another tab, as the page help link does.
  const help = await page.context().newPage();
  await help.goto(`/help/pipelines/?pipeline=${doc.id}#input-patterns`);
  await expect(help.locator("#input-patterns")).toBeInViewport();
  await help
    .getByRole("link", { name: "Secrets, enrichment & tests", exact: true })
    .click();
  await expect(help).toHaveURL(
    new RegExp(`/help/resources/\\?pipeline=${doc.id}$`),
  );
  const writes: string[] = [];
  help.on("request", (request) => {
    if (["POST", "PUT", "DELETE", "PATCH"].includes(request.method()))
      writes.push(request.url());
  });
  await help.locator('a[href*="section=secret"]').first().click();
  await expect(help).toHaveURL(
    new RegExp(`/#/configurations/${doc.id}\\?panel=settings&section=secret$`),
  );
  await expect(
    help.getByRole("dialog", { name: "Pipeline settings" }),
  ).toBeVisible();
  await expect(
    help.getByRole("heading", { name: "Secrets", exact: true }),
  ).toBeVisible();
  await expect(rate).toHaveValue("-");
  expect(writes).toEqual([]);
  await help.close();
  await expect(page).toHaveURL(new RegExp(`/#/configurations/${doc.id}$`));
  await expect(rate).toHaveValue("-");
  const stored = await page.request
    .get(`/api/v1/configurations/${doc.id}`)
    .then((r) => r.json());
  expect(stored.config).toEqual(config);
  await openAccountMenu(page);
  const homePopup = page.waitForEvent("popup");
  await page
    .getByRole("menuitem", {
      name: "Help center (opens in a new tab)",
      exact: true,
    })
    .click();
  const home = await homePopup;
  await expect(
    home.getByRole("heading", { name: "How can we help?", exact: true }),
  ).toBeVisible();
  await home.close();
  await expect(rate).toHaveValue("-");
  await rate.fill("10");
});

test("a guide without pipeline context opens a chooser then the exact requested view", async ({
  page,
}) => {
  const session = await page.request
    .get("/api/v1/session")
    .then((response) => response.json());
  const headers = { "X-CSRF-Token": session.csrf_token };
  const response = await page.request.post("/api/v1/configurations", {
    headers,
    data: {
      name: `Synthetic documentation destination ${Date.now()}`,
      description: "Synthetic navigation test, never deployed.",
      config: { sources: {}, transforms: {}, sinks: {} },
      graph: { nodes: [], edges: [] },
    },
  });
  expect(response.ok()).toBeTruthy();
  const doc = await response.json();
  try {
    await page.goto("/help/resources/#test-transformations");
    await page.locator('a[href*="section=tests"]').first().click();
    await expect(
      page.getByRole("complementary", { name: "Pipeline destination" }),
    ).toContainText("Choose a pipeline to open Pipeline tests.");
    await page.getByLabel("Search pipelines").fill(doc.name);
    // The list filters after a short pause; wait for the filtered result.
    const match = page.locator(".pipeline-list-item");
    await expect(match).toHaveCount(1);
    await match.click();
    const dialog = page.getByRole("dialog", { name: "Pipeline settings" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Tests", exact: true }),
    ).toBeVisible();
    const saved = await page.request
      .get(`/api/v1/configurations/${doc.id}`)
      .then((result) => result.json());
    expect(saved.revision).toBe(1);
    expect(saved.config).toEqual(doc.config);
    await page.goto(`/#/configurations/${doc.id}?panel=history`);
    // Hash-only navigation must not silently close an existing editing dialog.
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Pipeline history" }),
    ).toBeVisible();
    await page.goto(`/#/configurations/${doc.id}?panel=details`);
    await expect(
      page.getByRole("dialog", { name: "Pipeline details" }),
    ).toBeVisible();
    await expect(page.getByLabel("Pipeline name", { exact: true })).toHaveValue(
      doc.name,
    );
    await page
      .getByRole("dialog", { name: "Pipeline details" })
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    // ?panel=tools opens the editor's Actions menu.
    await page.goto(`/#/configurations/${doc.id}?panel=tools`);
    await expect(page.locator(".editor-tools-menu")).toHaveAttribute(
      "open",
      "",
    );
    await expect(
      page.getByRole("button", {
        name: "Import configuration file",
        exact: true,
      }),
    ).toBeVisible();
    const archived = await page.request.post(
      `/api/v1/configurations/${doc.id}/archive`,
      { headers, data: { revision: 1 } },
    );
    expect(archived.ok()).toBeTruthy();
    await page.goto(`/#/configurations/${doc.id}?panel=details`);
    // The archive happened in a different client; fetch that current snapshot.
    await page.reload();
    await expect(
      page.getByRole("dialog", { name: "Pipeline details" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Pipeline name", { exact: true }),
    ).toHaveAttribute("readonly", "");
    await expect(
      page.getByRole("button", { name: "Save details", exact: true }),
    ).toHaveCount(0);
  } finally {
    const saved = await page.request
      .get(`/api/v1/configurations/${doc.id}`)
      .then((result) => result.json());
    if (!saved.archived)
      expect(
        (
          await page.request.post(`/api/v1/configurations/${doc.id}/archive`, {
            headers,
            data: { revision: saved.revision },
          })
        ).ok(),
      ).toBeTruthy();
  }
});

test("old guide bookmarks resolve to the new help center and preserve the section", async ({
  page,
}) => {
  await page.goto("/#/docs/pipelines#event-templates");
  await expect(page).toHaveURL(/\/help\/pipelines\/#event-templates$/);
  await expect(page.locator("#event-templates")).toBeInViewport();
});
