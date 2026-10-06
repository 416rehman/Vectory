import { test, expect } from "@playwright/test";

test("deployment history loads bounded metadata and device pages, with usable filters and mobile details", async ({
  page,
}) => {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes("/api/v1/"))
      reads.push(new URL(request.url()).pathname);
  });
  const firstPage = page.waitForResponse(
    (response) =>
      response.url().includes("/deployments/history?") &&
      response.status() === 200,
  );
  await page.goto("/#/deployments");
  const history = await (await firstPage).json();
  expect(history.items.length).toBeGreaterThan(0);
  expect(history.items.length).toBeLessThanOrEqual(12);
  expect(history.page_size).toBe(12);
  expect(history.items[0]).not.toHaveProperty("targets");
  expect(history.items[0]).not.toHaveProperty("selector");
  await expect(page.locator(".deployment-table tbody tr")).toHaveCount(
    history.items.length,
  );
  if (history.total > 12) {
    const nextPage = page.waitForResponse(
      (response) =>
        response.url().includes("/deployments/history?") &&
        new URL(response.url()).searchParams.get("page") === "2",
    );
    await page.getByRole("button", { name: "Next", exact: true }).click();
    const second = await (await nextPage).json();
    expect(second.page).toBe(2);
    expect(
      second.items.every(
        (item: { id: string }) =>
          !history.items.some((prior: { id: string }) => prior.id === item.id),
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Previous", exact: true }).click();
  }
  const status = history.items[0].status;
  const filtered = page.waitForResponse(
    (response) =>
      response.url().includes("/deployments/history?") &&
      new URL(response.url()).searchParams.get("status") === status,
  );
  await page
    .getByRole("button", { name: "Filter Status", exact: true })
    .click();
  await page
    .locator(`.data-table-filter-options button[data-value="${status}"]`)
    .click();
  const matching = await (await filtered).json();
  expect(
    matching.items.every((item: { status: string }) => item.status === status),
  ).toBe(true);
  await expect(page.locator(".deployment-table tbody tr")).toHaveCount(
    matching.items.length,
  );
  const selected = matching.items[0];
  const summaryResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/deployments/${selected.id}/summary`),
  );
  const targetsResponse = page.waitForResponse((response) =>
    response.url().includes(`/deployments/${selected.id}/targets?`),
  );
  await page
    .locator(".deployment-table tbody tr")
    .first()
    .getByRole("button")
    .first()
    .click();
  const summary = await (await summaryResponse).json();
  const targets = await (await targetsResponse).json();
  const dialog = page.getByRole("dialog", {
    name: "Deployment details",
    exact: true,
  });
  await expect(
    dialog.getByText(
      `${summary.verified_count} of ${summary.target_count} devices verified`,
      { exact: true },
    ),
  ).toBeVisible();
  expect(targets.items.length).toBeLessThanOrEqual(12);
  await expect(dialog.locator(".deployment-targets tbody tr")).toHaveCount(
    targets.items.length,
  );
  if (targets.items.length) {
    await expect(
      dialog.locator(".deployment-targets tbody tr").first().getByRole("link"),
    ).toHaveAttribute("href", `#/devices/${targets.items[0].device_id}`);
  }
  expect(
    reads.filter(
      (path) =>
        [
          "/api/v1/deployments",
          "/api/v1/configurations",
          "/api/v1/devices",
        ].includes(path) || /^\/api\/v1\/versions\//.test(path),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: "../docs/screenshots/deployment-devices.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "../docs/screenshots/deployment-devices-mobile.png",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "../docs/screenshots/deployment-history-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "../docs/screenshots/deployment-history.png",
    fullPage: true,
  });
  await page
    .getByRole("textbox", { name: "Search deployments", exact: true })
    .fill("no-such-deployment-browser-probe");
  await expect(
    page.getByRole("heading", { name: "No matching deployments", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Filter Status", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".deployment-table tbody tr").first(),
  ).toBeVisible();
});

test("deployment permalinks survive refresh and new tabs without triggering rollout actions", async ({
  page,
  context,
}) => {
  const response = await page.request.get(
    "/api/v1/deployments/history?page=1&page_size=12",
  );
  expect(response.ok()).toBe(true);
  const { items } = await response.json();
  expect(items.length).toBeGreaterThan(0);
  const selected = items[0],
    origin = selected.scheduled_at ? "schedules" : "deployments";
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/api/v1/"))
      mutations.push(new URL(request.url()).pathname);
  });
  await page.goto("/#/" + origin + "/" + selected.id + "?page=1&action=cancel");
  const detail = page.getByRole("region", {
    name: "Deployment details",
    exact: true,
  });
  const expectedTitle =
    selected.name ||
    (selected.policy
      ? "Agent settings"
      : selected.configuration_name || "Pipeline deployment");
  await expect(
    detail.getByRole("heading", { name: expectedTitle, exact: true }),
  ).toBeVisible();
  // The page is routed: its address becomes the exact link to share, without
  // the ignored action, so it needs no copy-link row.
  const expectedLink = new URL(
    "/#/" + origin + "/" + selected.id + "?page=1",
    page.url(),
  ).href;
  await expect(page).toHaveURL(expectedLink);
  await expect(
    detail.getByRole("button", { name: "Copy deployment link" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    detail.getByRole("heading", { name: expectedTitle, exact: true }),
  ).toBeVisible();
  const tab = await context.newPage();
  await tab.goto(expectedLink);
  await expect(
    tab
      .getByRole("region", { name: "Deployment details", exact: true })
      .getByRole("heading", { name: expectedTitle, exact: true }),
  ).toBeVisible();
  await tab.close();
  await detail
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: /^(Deployments|Schedules)$/ })
    .click();
  await expect(page).toHaveURL(
    new URL("/#/" + origin + "?page=1", page.url()).href,
  );
  await page.goBack();
  await expect(
    detail.getByRole("heading", { name: expectedTitle, exact: true }),
  ).toBeVisible();
  expect(mutations).toEqual([]);
});
