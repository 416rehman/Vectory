import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Export responses contain workspace history; do not include them in traces.
test.use({ trace: "off" });

test("audit browsing uses bounded summaries, lazy exact details and restorable list context", async ({
  page,
}) => {
  const reads: string[] = [],
    mutations: string[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/v1/")) return;
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") reads.push(path);
    else mutations.push(path);
  });
  const loaded = page.waitForResponse(
    (response) => response.url().includes("/audit/history?") && response.ok(),
  );
  await page.goto("/#/audit");
  const result = await (await loaded).json();
  expect(result.page_size).toBe(12);
  expect(result.items.length).toBeLessThanOrEqual(12);
  expect(result.items.length).toBeGreaterThan(0);
  expect(result.items[0]).not.toHaveProperty("details");
  await expect(page.locator(".audit-table tbody tr")).toHaveCount(
    result.items.length,
  );
  expect(
    reads.some((path) => /^\/api\/v1\/audit\/[0-9a-f-]{36}$/.test(path)),
  ).toBe(false);
  const selected = result.items[0];
  const detailRead = page.waitForResponse((response) =>
    response.url().endsWith(`/audit/${selected.id}`),
  );
  await page
    .locator(".audit-table tbody tr")
    .first()
    .getByRole("button", { name: /^Details:/ })
    .click();
  const detail = await (await detailRead).json();
  expect(detail.id).toBe(selected.id);
  expect(detail).toHaveProperty("details");
  await expect(page).toHaveURL(new RegExp(`#/audit/${selected.id}\\?page=1$`));
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: "Event details" }),
  ).toBeVisible();
  await page.getByText("Technical details", { exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText(selected.id, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Return to audit log" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "Event details" }),
  ).toBeVisible();
  await page.goForward();
  const filter = new URLSearchParams({ outcome: selected.outcome, page: "1" });
  const filtered = page.waitForResponse(
    (response) =>
      response.url().includes("/audit/history?") &&
      new URL(response.url()).searchParams.get("outcome") ===
        selected.outcome &&
      response.ok(),
  );
  await page.goto(`/#/audit?${filter}`);
  const matching = await (await filtered).json();
  expect(
    matching.items.every(
      (item: { outcome: string }) => item.outcome === selected.outcome,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("textbox", { name: "Search activity" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(reads).not.toContain("/api/v1/audit");
  expect(mutations).toEqual([]);
});

test.describe("audit export", () => {
  test("prepares an exact scoped snapshot and downloads the complete verified file", async ({
    page,
  }, testInfo) => {
    const source = await page.request.get(
      "/api/v1/audit/history?page=1&page_size=1",
    );
    expect(source.ok()).toBe(true);
    const first = (await source.json()).items[0];
    expect(first).toBeTruthy();
    const filters = {
      action: first.action,
      actor_id: first.actor_id,
      ...(first.target ? { target_id: first.target } : {}),
    };
    const query = new URLSearchParams({ ...filters, page: "1" });
    await page.goto(`/#/audit?${query}`);
    await expect(page.locator(".audit-table tbody tr").first()).toBeVisible();
    await page.getByRole("button", { name: "Export results" }).click();
    const dialog = page.getByRole("dialog", { name: "Export audit events" });
    await expect(
      dialog.getByText(/All matching pages are included/),
    ).toBeVisible();
    const preparedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/audit/exports") &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Prepare export", exact: true })
      .click();
    const response = await preparedResponse;
    expect(response.ok()).toBe(true);
    const prepared = await response.json();
    expect(prepared.filters).toEqual(filters);
    expect(prepared.row_count).toBeGreaterThan(0);
    try {
      await expect(
        dialog.getByRole("heading", { name: "File ready" }),
      ).toBeVisible();
      const downloadEvent = page.waitForEvent("download");
      await dialog
        .getByRole("link", { name: "Download JSONL", exact: true })
        .click();
      const download = await downloadEvent,
        path = testInfo.outputPath("scoped-audit.jsonl");
      await download.saveAs(path);
      const content = await readFile(path);
      expect(content.length).toBe(prepared.byte_count);
      expect(createHash("sha256").update(content).digest("hex")).toBe(
        prepared.sha256,
      );
      const lines = content.toString("utf8").trimEnd().split("\n"),
        rows = lines.map((line) => JSON.parse(line));
      expect(rows[0].type).toBe("metadata");
      expect(rows[0].filters).toEqual(filters);
      expect(rows[0].row_count).toBe(prepared.row_count);
      const events = rows.slice(1, -1);
      expect(events).toHaveLength(prepared.row_count);
      expect(
        events.every(
          (row) =>
            row.type === "audit" &&
            row.event.action === first.action &&
            row.event.actor_id === first.actor_id,
        ),
      ).toBe(true);
      expect(rows.at(-1)).toMatchObject({
        type: "complete",
        complete: true,
        row_count: prepared.row_count,
      });
      expect(
        createHash("sha256")
          .update(
            lines
              .slice(1, -1)
              .map((line) => line + "\n")
              .join(""),
          )
          .digest("hex"),
      ).toBe(rows.at(-1).events_sha256);
      await expect(dialog.getByRole("status")).toContainText(
        "cannot confirm that the file was saved",
      );
      const discard = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/audit/exports/${prepared.id}`) &&
          response.request().method() === "DELETE",
      );
      await dialog
        .getByRole("button", { name: "Discard file", exact: true })
        .click();
      expect((await discard).ok()).toBe(true);
      await expect(
        dialog.getByRole("heading", { name: "File ready" }),
      ).toHaveCount(0);
    } finally {
      const session = await (await page.request.get("/api/v1/session")).json();
      await page.request.delete(`/api/v1/audit/exports/${prepared.id}`, {
        headers: { "X-CSRF-Token": session.csrf_token },
      });
    }
  });
});
