import { test, expect } from "@playwright/test";

test("issues group by version and reason, keep a bounded exact-identity list, clear dispositions and contextual help", async ({
  page,
}) => {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes("/api/v1/"))
      reads.push(new URL(request.url()).pathname);
  });
  const first = page.waitForResponse(
    (response) =>
      response.url().includes("/issues/groups?") && response.status() === 200,
  );
  await page.goto("/#/issues");
  const groups = await (await first).json();
  expect(groups.page_size).toBe(12);
  expect(groups.items.length).toBeLessThanOrEqual(12);
  expect(
    groups.items.every((group: { devices: { disposition: string }[] }) =>
      group.devices.every((issue) => issue.disposition === "open"),
    ),
  ).toBe(true);
  await expect(page.locator("article.issue-group")).toHaveCount(
    groups.items.length,
  );
  await expect(
    page.getByRole("link", {
      name: "Help for Issues (opens in a new tab)",
      exact: true,
    }),
  ).toHaveAttribute(
    "href",
    "/help/troubleshooting/#a-pipeline-is-rejected-or-rolled-back",
  );
  const status = page.getByRole("group", { name: "Issue status", exact: true });
  const layout = page.getByRole("group", { name: "Issue layout", exact: true });
  const listResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/issues/history?") &&
      new URL(response.url()).searchParams.get("state") === "open",
  );
  await layout.getByRole("button", { name: "All issues", exact: true }).click();
  const history = await (await listResponse).json();
  expect(history.page_size).toBe(12);
  await expect(
    page.locator(".issue-table tbody tr:has(.issue-summary)"),
  ).toHaveCount(history.items.length);
  expect(reads).not.toContain("/api/v1/issues");
  expect(reads).not.toContain("/api/v1/devices");
  const allResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/issues/history?") &&
      new URL(response.url()).searchParams.get("state") === "all",
  );
  await status.getByRole("button", { name: "All", exact: true }).click();
  const all = await (await allResponse).json();
  await expect(
    page.locator(".issue-table tbody tr:has(.issue-summary)"),
  ).toHaveCount(all.items.length);
  if (all.items.length) {
    const issue = all.items[0];
    const row = page
      .locator(".issue-table tbody tr:has(.issue-summary)")
      .first();
    await expect(row.locator(".control-row-title")).toHaveAttribute(
      "href",
      `#/devices/${issue.device_id}`,
    );
    if (issue.disposition === "acknowledged")
      await expect(row.locator(".badge")).toHaveClass(/neutral/);
    // Live and retired devices can be decided on; resolved issues and
    // devices that no longer exist cannot.
    if (issue.resolved || issue.device_revoked === null)
      await expect(
        row.getByRole("button", { name: /^(Acknowledge|Reopen) issue on / }),
      ).toHaveCount(0);
  }
  await page.screenshot({
    path: "../docs/screenshots/issues-history.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "../docs/screenshots/issues-history-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("textbox", {
      name: "Search devices, pipelines, or reasons",
      exact: true,
    })
    .fill("no-such-issue-browser-probe");
  await expect(
    page.getByRole("heading", { name: "No matching issues", exact: true }),
  ).toBeVisible();
  if (all.items.length) {
    const id = all.items[0].device_id;
    const scoped = page.waitForResponse(
      (response) =>
        response.url().includes("/issues/history?") &&
        new URL(response.url()).searchParams.get("device_id") === id,
    );
    await page.goto(`/#/issues?device=${id}`);
    const result = await (await scoped).json();
    expect(
      result.items.every(
        (issue: { device_id: string }) => issue.device_id === id,
      ),
    ).toBe(true);
    await expect(page.locator(".issue-scope a")).toHaveAttribute(
      "href",
      `#/devices/${id}`,
    );
    await page
      .getByRole("button", { name: "Show all devices", exact: true })
      .click();
    await expect(page).toHaveURL(/#\/issues$/);
  }
});
