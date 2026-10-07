import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const output = path.join(root, "site/dist");
const captures = path.join(
  root,
  ".local/site-flow-path",
  `run-${Date.now()}-${process.pid}`,
);
const require = createRequire(path.join(root, "dashboard/package.json"));
const { chromium, firefox, expect } = require("@playwright/test");
const engines = { chromium, firefox };
const requested = process.argv[2];
assert(
  !requested || requested in engines,
  "Choose chromium or firefox, or omit the browser to check both",
);
const browserNames = requested ? [requested] : Object.keys(engines);
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".webp": "image/webp",
};

// A local static build only: no product server, accounts or public services.
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    let file = path.resolve(output, `.${pathname}`);
    if (!file.startsWith(output + path.sep) && file !== output)
      throw Error("Invalid path");
    if ((await fs.stat(file)).isDirectory())
      file = path.join(file, "index.html");
    response.setHeader(
      "Content-Type",
      mime[path.extname(file)] || "application/octet-stream",
    );
    response.end(await fs.readFile(file));
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// Two sources merge, then fan out. A separate pipeline and the other merging
// source must stay dimmed: a downstream path is not an upstream lineage trace.
const fixture = `# Synthetic source-path browser regression, preserved on export.
api:
  enabled: false
sources:
  primary_events:
    type: demo_logs
    format: json
  secondary_events:
    type: demo_logs
    format: json
  other_events:
    type: demo_logs
    format: json
transforms:
  merge:
    type: filter
    inputs: [primary_events, secondary_events]
    condition: 'true'
  sample_branch:
    type: sample
    inputs: [merge]
    rate: 2
sinks:
  direct_out:
    type: blackhole
    inputs: [merge]
  sample_out:
    type: blackhole
    inputs: [sample_branch]
  other_out:
    type: blackhole
    inputs: [other_events]
custom:
  future_setting: preserved
`;
const allNodes = [
  "primary_events",
  "secondary_events",
  "other_events",
  "merge",
  "sample_branch",
  "direct_out",
  "sample_out",
  "other_out",
];
const primaryPath = [
  "primary_events",
  "merge",
  "sample_branch",
  "direct_out",
  "sample_out",
];
const secondaryPath = [
  "secondary_events",
  "merge",
  "sample_branch",
  "direct_out",
  "sample_out",
];
const commonEdges = [
  "Connection from merge to sample_branch",
  "Connection from merge to direct_out",
  "Connection from sample_branch to sample_out",
];
const primaryEdges = [
  "Connection from primary_events to merge",
  ...commonEdges,
];
const secondaryEdges = [
  "Connection from secondary_events to merge",
  ...commonEdges,
];
const sorted = (values) => [...values].sort();

try {
  await fs.mkdir(captures, { recursive: true });
  for (const browserName of browserNames) {
    const browser = await engines[browserName].launch();
    const errors = [];
    const disallowedRequests = [];
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        acceptDownloads: true,
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (
          !request.url().startsWith(origin + "/") ||
          /\/api\//.test(request.url())
        )
          disallowedRequests.push(request.url());
      });
      // An unmodified configuration should never request replace confirmation.
      page.on("dialog", async (dialog) => {
        errors.push(`Unexpected ${dialog.type()}: ${dialog.message()}`);
        await dialog.dismiss();
      });
      await page.goto(origin + "/designer/");
      await page.getByRole("button", { name: "Import", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Import a configuration",
        exact: true,
      });
      await dialog
        .getByRole("textbox", { name: "Configuration code", exact: true })
        .fill(fixture);
      await dialog
        .getByRole("button", { name: "Visualize configuration", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      const graph = page.locator(".editor-graph");
      const node = (id) => graph.locator(`.react-flow__node[data-id="${id}"]`);
      await expect(graph.locator(".react-flow__node")).toHaveCount(
        allNodes.length,
      );
      await expect(graph.locator(".react-flow__edge")).toHaveCount(6);

      async function highlightedNodes() {
        return graph
          .locator('.react-flow__node[data-connection-highlight="endpoint"]')
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-id")).sort(),
          );
      }
      async function highlightedEdges() {
        return graph
          .locator('.react-flow__edge[data-connection-highlight="active"]')
          .evaluateAll((elements) =>
            elements
              .map((element) => element.getAttribute("aria-label"))
              .sort(),
          );
      }
      async function expectPath(source, nodes, edges) {
        await expect(graph).toHaveAttribute("data-flow-source", source);
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: `Showing downstream paths from ${source}` }),
        ).toBeVisible();
        await expect.poll(highlightedNodes).toEqual(sorted(nodes));
        await expect.poll(highlightedEdges).toEqual(sorted(edges));
        await expect(
          graph.locator(
            '.react-flow__node[data-connection-highlight="dimmed"]',
          ),
        ).toHaveCount(allNodes.length - nodes.length);
        await expect(
          graph.locator(
            '.react-flow__edge[data-connection-highlight="dimmed"]',
          ),
        ).toHaveCount(6 - edges.length);
      }
      async function expectCleared() {
        await expect(graph).not.toHaveAttribute("data-flow-source", /.+/);
        await expect(graph.locator("[data-connection-highlight]")).toHaveCount(
          0,
        );
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: "Showing downstream paths from" }),
        ).toHaveCount(0);
      }
      async function clickSource(id = "primary_events") {
        await node(id).locator(".pipeline-node-body").click();
      }
      async function fitGraph() {
        await page
          .getByRole("button", { name: "Fit graph", exact: true })
          .click();
        // Fit and inspector reveal animate the viewport. A point sampled in
        // flight can move away from the pointer and correctly end edge hover.
        let previous;
        let stable = 0;
        await expect
          .poll(
            async () => {
              const transform = await graph
                .locator(".react-flow__viewport")
                .getAttribute("style");
              stable = transform === previous ? stable + 1 : 0;
              previous = transform;
              return stable;
            },
            { intervals: [100] },
          )
          .toBeGreaterThanOrEqual(3);
      }
      async function exportYaml() {
        await page.getByRole("button", { name: "Export", exact: true }).click();
        const pending = page.waitForEvent("download");
        await page
          .getByRole("menuitem", { name: "Download YAML", exact: true })
          .click();
        return fs.readFile(await (await pending).path(), "utf8");
      }
      async function clickEmptyPane() {
        const point = await graph
          .locator(".react-flow__pane")
          .evaluate((pane) => {
            const bounds = pane.getBoundingClientRect();
            for (const vertical of [0.92, 0.08, 0.5, 0.75, 0.25]) {
              for (const horizontal of [0.1, 0.5, 0.9, 0.25, 0.75]) {
                const x = bounds.x + bounds.width * horizontal;
                const y = bounds.y + bounds.height * vertical;
                if (document.elementFromPoint(x, y) === pane) return { x, y };
              }
            }
            return null;
          });
        assert(point, "An unobstructed empty canvas point must be available");
        await page.mouse.click(point.x, point.y);
      }
      async function hoverEdge(label) {
        const edge = graph.getByRole("group", { name: label, exact: true });
        const point = await edge.evaluate((element) => {
          const line = element.querySelector(".react-flow__edge-path");
          for (const fraction of [0.2, 0.1, 0.3, 0.4, 0.6, 0.8, 0.9, 0.5]) {
            const local = line.getPointAtLength(
              line.getTotalLength() * fraction,
            );
            const screen = new DOMPoint(local.x, local.y).matrixTransform(
              line.getScreenCTM(),
            );
            if (
              document
                .elementFromPoint(screen.x, screen.y)
                ?.closest(".react-flow__edge") === element
            )
              return { x: screen.x, y: screen.y };
          }
          return null;
        });
        assert(point, `An unobstructed pointer hit must exist for ${label}`);
        await page.mouse.move(point.x, point.y);
        return edge;
      }

      await expectCleared();
      assert.equal(
        await exportYaml(),
        fixture,
        "Import/export changed the fixture before inspection",
      );
      for (const theme of ["light", "dark"]) {
        // The shared workspace receives its theme from its host. Exercise both
        // host themes without adding a standalone theme implementation.
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
          document.documentElement.style.colorScheme = value;
        }, theme);
        await clickSource();
        await expectPath("primary_events", primaryPath, primaryEdges);
        await fitGraph();
        await expectPath("primary_events", primaryPath, primaryEdges);
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: path.join(captures, `${browserName}-${theme}-source-path.png`),
        });

        // Hovering the other merging source's edge temporarily replaces the
        // source spotlight, then leaving restores the entire downstream path.
        const hovered = await hoverEdge(
          "Connection from secondary_events to merge",
        );
        await expect(hovered).toHaveAttribute(
          "data-connection-highlight",
          "active",
        );
        await expect
          .poll(highlightedNodes)
          .toEqual(sorted(["secondary_events", "merge"]));
        await expect
          .poll(highlightedEdges)
          .toEqual(["Connection from secondary_events to merge"]);
        await expect(graph).toHaveAttribute(
          "data-flow-source",
          "primary_events",
        );
        await page.mouse.move(0, 0);
        await expectPath("primary_events", primaryPath, primaryEdges);

        await clickSource("secondary_events");
        await expectPath("secondary_events", secondaryPath, secondaryEdges);
        await node("merge").locator(".pipeline-node-body").click();
        await expectCleared();
        await clickSource();
        await expectPath("primary_events", primaryPath, primaryEdges);
        await clickEmptyPane();
        await expectCleared();
        await expect(page.locator(".editor-inspector")).toHaveCount(0);

        await fitGraph();
        await node("primary_events").focus();
        await node("primary_events").press("Enter");
        await expectPath("primary_events", primaryPath, primaryEdges);
        await page.keyboard.press("Escape");
        await expectCleared();
        await clickSource();
        await expectPath("primary_events", primaryPath, primaryEdges);
        await page
          .getByRole("button", {
            name: "Close component settings",
            exact: true,
          })
          .click();
        await expectCleared();
        await clickSource();
        await expectPath("primary_events", primaryPath, primaryEdges);
        await page
          .getByRole("button", { name: "Clear flow path", exact: true })
          .click();
        await expectCleared();
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await fitGraph();
      await clickSource();
      await expectPath("primary_events", primaryPath, primaryEdges);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "Source path controls overflow a narrow viewport",
      );
      await page.screenshot({
        path: path.join(captures, `${browserName}-narrow-source-path.png`),
      });
      await page
        .getByRole("button", { name: "Close component settings", exact: true })
        .click();
      await expectCleared();
      await page.setViewportSize({ width: 1440, height: 1000 });
      assert.equal(
        await exportYaml(),
        fixture,
        "Source path inspection changed configuration or its preserved source",
      );
      await expect(
        page.getByRole("button", { name: "Undo", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Redo", exact: true }),
      ).toBeDisabled();
      assert.deepEqual(
        disallowedRequests,
        [],
        "The local flow-path test made API or external requests",
      );
      assert.deepEqual(errors, [], "The flow-path designer raised errors");
      await context.close();
      console.log(
        `${browserName}: source paths passed (merges, branches, hover restore, keyboard, clearing, narrow view, preserved export).`,
      );
    } finally {
      await browser.close();
    }
  }
  console.log(`Source-path browser captures: ${path.relative(root, captures)}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
