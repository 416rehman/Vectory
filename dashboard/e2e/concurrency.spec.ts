import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
test("publishing waits for the in-flight explicit save and uses its exact content", async ({
  page,
}) => {
  const session = await page.request
      .get("/api/v1/session")
      .then((r) => r.json()),
    config = JSON.parse(
      fs.readFileSync(
        path.join(root, "vector-catalog/fixtures/remap.json"),
        "utf8",
      ),
    );
  const doc = await page.request
    .post("/api/v1/configurations", {
      headers: { "X-CSRF-Token": session.csrf_token },
      data: {
        name: "Explicit save race " + Date.now(),
        description: "Real API concurrency regression.",
        config,
        graph: { nodes: [], edges: [] },
      },
    })
    .then((r) => r.json());
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    saving = new Promise<void>((r) => (started = r));
  let intercepted = false,
    publishStarted = false;
  await page.route(
    `**/api/v1/configurations/${doc.id}/draft`,
    async (route) => {
      if (!intercepted) {
        intercepted = true;
        started();
        await hold;
      }
      await route.continue();
    },
  );
  page.on("request", (r) => {
    if (r.url().endsWith(`/configurations/${doc.id}/publish`))
      publishStarted = true;
  });
  try {
    await page.goto("/#/configurations/" + doc.id);
    await page
      .locator('.react-flow__node[data-id="process"] .pipeline-node')
      .click();
    const marker = '.race_marker = "saved-before-publish"';
    await page.getByLabel("VRL program", { exact: true }).fill(marker);
    await page
      .locator(".editor-inspector")
      .getByRole("button", { name: "Close component settings", exact: true })
      .click();
    await page.getByRole("button", { name: "Save options" }).click();
    await page
      .getByRole("menuitem", { name: "Save draft", exact: true })
      .click();
    await saving;
    await page
      .getByRole("button", { name: "Review & publish", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Publish version", exact: true })
      .click();
    expect(
      await page.request
        .get(`/api/v1/configurations/${doc.id}/versions`)
        .then((r) => r.json()),
    ).toEqual([]);
    expect(publishStarted).toBeFalsy();
    release();
    await page
      .getByRole("button", { name: "Choose devices", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Deploy version 1", exact: true }),
    ).toBeVisible();
    const versions = await page.request
      .get(`/api/v1/configurations/${doc.id}/versions`)
      .then((r) => r.json());
    expect(versions).toHaveLength(1);
    expect(versions[0].config.transforms.process.source).toBe(marker);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
