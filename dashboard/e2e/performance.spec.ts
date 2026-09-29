import { test, expect } from "@playwright/test";
import { readConfigurationCode } from "./code-editor";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
test("load and edit a real persisted 201-component pipeline", async ({
  page,
}) => {
  const session = await page.request
    .get("/api/v1/session")
    .then((r) => r.json());
  const config: {
    sources: Record<string, unknown>;
    transforms: Record<string, unknown>;
    sinks: Record<string, unknown>;
  } = {
    sources: {},
    transforms: {},
    sinks: {
      output: {
        type: "console",
        target: "stderr",
        encoding: { codec: "json" },
        inputs: Array.from({ length: 100 }, (_, i) => "transform_" + i),
      },
    },
  };
  for (let i = 0; i < 100; i++) {
    config.sources["source_" + i] = {
      type: "demo_logs",
      format: "json",
      interval: 10,
    };
    config.transforms["transform_" + i] = {
      type: "remap",
      inputs: ["source_" + i],
      source: ".synthetic = true",
    };
  }
  const response = await page.request.post("/api/v1/configurations", {
    headers: { "X-CSRF-Token": session.csrf_token },
    data: {
      name: "Scale verification " + Date.now(),
      description:
        "Explicit synthetic 201-component browser performance fixture; never deployed.",
      config,
      graph: { nodes: [], edges: [] },
    },
  });
  expect(response.ok()).toBeTruthy();
  const document = await response.json();
  const start = performance.now();
  await page.goto("/#/configurations/" + document.id);
  await expect(page.locator(".pipeline-node")).toHaveCount(201);
  const initialRenderMs = performance.now() - start;
  const interaction = performance.now();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByLabel("Format", { exact: true }).selectOption("json");
  await expect(page.getByLabel("Vector configuration code")).toBeVisible();
  const codeViewMs = performance.now() - interaction;
  expect(JSON.parse(await readConfigurationCode(page))).toEqual(config);
  fs.writeFileSync(
    path.join(root, "docs/evidence/browser-performance.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        component_count: 201,
        edge_count: 200,
        initial_render_ms: Math.round(initialRenderMs),
        code_view_ms: Math.round(codeViewMs),
        browser: "Chromium via Playwright",
        platform: process.platform,
        note: "One local cold-navigation sample including API fetch and browser rendering. Not a production capacity guarantee.",
      },
      null,
      2,
    ) + "\n",
  );
  expect(initialRenderMs).toBeLessThan(15000);
  expect(codeViewMs).toBeLessThan(5000);
});
