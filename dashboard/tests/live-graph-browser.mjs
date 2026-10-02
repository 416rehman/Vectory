// Actual App/editor, isolated synthetic API. Never contacts preview or devices.
// Covers the live graph: Live on by default for a pipeline a device runs and
// remembered per pipeline, rates readable without zooming, edge labels and
// connections kept clear of the cards, the Fit control and the table
// alternative, and the canvas titles.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_LIVE_GRAPH_OUTPUT || ".local/live-graph",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:live-graph-fixture";
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const vite = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "live-graph-fixture",
      resolveId(id) {
        if (id === "virtual:live-graph-fixture") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__live-graph-fixture") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic live graph verification</title></head><body><div id="root"></div><script type="module">import "virtual:live-graph-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch();
const pipelineId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const userId = "11111111-1111-4111-8111-111111111111";
const created = "2026-09-26T12:00:00Z";
const results = [],
  requests = [],
  unexpected = [],
  errors = [],
  screenshots = [];
let page, fixture;

/** The demo fleet's pipeline: parse, route errors, sample the rest. */
function demoConfig() {
  return {
    sources: {
      app_logs: { type: "demo_logs", format: "syslog", interval: 0.2 },
      vector_metrics: { type: "internal_metrics", scrape_interval_secs: 5 },
    },
    transforms: {
      parse: {
        type: "remap",
        inputs: ["app_logs"],
        source: '. |= parse_syslog!(.message)\n.environment = "demo"',
      },
      by_severity: {
        type: "route",
        inputs: ["parse"],
        route: { errors: '.severity == "err" || .severity == "crit"' },
      },
      sample_rest: {
        type: "sample",
        inputs: ["by_severity._unmatched"],
        rate: 10,
      },
    },
    sinks: {
      errors_out: { type: "blackhole", inputs: ["by_severity.errors"] },
      archive: { type: "blackhole", inputs: ["sample_rest"] },
      metrics_exporter: {
        type: "prometheus_exporter",
        inputs: ["vector_metrics"],
        address: "127.0.0.1:9598",
      },
    },
  };
}
/** A route with four outputs, one of them continuing through another step. */
function fourOutputConfig() {
  return {
    sources: { seed: { type: "demo_logs", format: "json" } },
    transforms: {
      split: {
        type: "route",
        inputs: ["seed"],
        route: {
          a: '.level == "a"',
          b: '.level == "b"',
          c: '.level == "c"',
          d: '.level == "d"',
        },
      },
      enrich: { type: "remap", inputs: ["split.b"], source: ".x = 1" },
    },
    sinks: {
      out_a: { type: "blackhole", inputs: ["split.a"] },
      out_b: { type: "blackhole", inputs: ["enrich"] },
      out_c: { type: "blackhole", inputs: ["split.c"] },
      out_d: { type: "blackhole", inputs: ["split.d"] },
      out_rest: { type: "blackhole", inputs: ["split._unmatched"] },
    },
  };
}
const sortedKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedKeys(value[key])]),
    );
  return value;
};
const totals = {
  events_in_per_second: null,
  events_out_per_second: null,
  bytes_in_per_second: null,
  bytes_out_per_second: null,
  errors_per_minute: null,
  filtered_per_minute: null,
  dropped_per_minute: null,
};
const component = (id, values = {}) => ({
  id,
  kind: null,
  type: null,
  devices_reporting: 3,
  received_events_per_second: null,
  sent_events_per_second: null,
  received_bytes_per_second: null,
  sent_bytes_per_second: null,
  errors_per_minute: null,
  filtered_per_minute: null,
  dropped_per_minute: null,
  buffer_events: null,
  buffer_bytes: null,
  buffer_utilization_max: null,
  utilization_max: null,
  latency_mean_seconds_max: null,
  sent_by_output: null,
  ...values,
});
const telemetryOf = (values = {}) => ({
  generated_at: created,
  devices_running: 0,
  devices_reporting: 0,
  device_ids: [],
  oldest_sample_at: null,
  newest_sample_at: null,
  ...totals,
  coverage: {},
  components: [],
  configuration_id: pipelineId,
  versions: [],
  ...values,
});
const running = (components) =>
  telemetryOf({
    devices_running: 3,
    devices_reporting: 3,
    components,
    versions: [
      {
        version_id: versionId,
        version_number: 1,
        devices_running: 3,
        devices_reporting: 3,
      },
    ],
  });
/** What three demo hosts report: synthetic syslog, mostly sampled away. */
const demoTelemetry = () =>
  running([
    component("app_logs", {
      sent_events_per_second: 15.5,
      sent_by_output: { _default: 15.5 },
    }),
    component("vector_metrics", {
      sent_events_per_second: 0.6,
      sent_by_output: { _default: 0.6 },
    }),
    component("parse", {
      received_events_per_second: 15.5,
      sent_events_per_second: 15.5,
      sent_by_output: { _default: 15.5 },
    }),
    component("by_severity", {
      received_events_per_second: 15.5,
      sent_events_per_second: 15.5,
      sent_by_output: { errors: 1.8, _unmatched: 13.7 },
    }),
    component("sample_rest", {
      received_events_per_second: 13.7,
      sent_events_per_second: 1.4,
      sent_by_output: { _default: 1.4 },
    }),
    component("errors_out", { received_events_per_second: 1.8 }),
    component("archive", { received_events_per_second: 1.4 }),
    component("metrics_exporter", { received_events_per_second: 0.6 }),
  ]);

async function load({
  config = demoConfig(),
  published = config,
  telemetry = demoTelemetry(),
  width = 1440,
  height = 900,
  theme = "light",
  scale = 1,
  storage = {},
  name = "Edge syslog processing",
} = {}) {
  if (page) await page.context().close();
  const document = {
    id: pipelineId,
    name,
    description: "Synthetic demo pipeline, never deployed.",
    revision: 1,
    archived: false,
    archived_at: null,
    created_at: created,
    updated_at: created,
    config,
    graph: { nodes: [], edges: [] },
  };
  fixture = { document, telemetryReads: 0 };
  const current = fixture;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ({ theme, storage }) => {
      localStorage.setItem("vectory-sidebar-collapsed", "true");
      localStorage.setItem("vectory-theme", theme);
      localStorage.setItem("vectory.editor.auto-check", "off");
      for (const [key, value] of Object.entries(storage))
        if (!sessionStorage.getItem("seeded")) localStorage.setItem(key, value);
      sessionStorage.setItem("seeded", "1");
    },
    { theme, storage },
  );
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = request.method();
    requests.push({ method, path });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: userId,
            email: "live@example.test",
            name: "Synthetic operator",
            role: "admin",
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic-live-csrf",
        });
      if (path === "/settings")
        return reply({ instance_name: "Synthetic isolated editor" });
      if (path === "/mfa") return reply({ enabled: false });
      if (path === "/devices") return reply([]);
      if (path === `/configurations/${pipelineId}`)
        return reply(current.document);
      if (path === `/configurations/${pipelineId}/history`)
        return reply({
          items: published
            ? [
                {
                  id: versionId,
                  configuration_id: pipelineId,
                  created_at: created,
                },
              ]
            : [],
          total: published ? 1 : 0,
          page: 1,
          page_size: Number(url.searchParams.get("page_size")),
          kind: "versions",
        });
      if (published && path === `/versions/${versionId}`)
        return reply({
          id: versionId,
          configuration_id: pipelineId,
          number: 1,
          graph: { nodes: [], edges: [] },
          config: sortedKeys(published),
          artifact: JSON.stringify(published),
          sha256: "0".repeat(64),
          size: JSON.stringify(published).length,
          created_at: created,
          message: "Synthetic published version",
          validation: { valid: true },
        });
      if (path === `/configurations/${pipelineId}/telemetry`) {
        current.telemetryReads++;
        return reply(telemetry);
      }
    }
    unexpected.push(`${method} ${path}`);
    return reply(
      {
        error: {
          code: "UNEXPECTED_REQUEST",
          message: "Synthetic transport refuses this request",
        },
      },
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${origin}/__live-graph-fixture#/configurations/${pipelineId}`,
  );
  const count = Object.values(config).reduce(
    (total, section) =>
      total +
      (section && typeof section === "object"
        ? Object.keys(section).length
        : 0),
    0,
  );
  await expect(page.locator(".react-flow__node")).toHaveCount(count, {
    timeout: 60000,
  });
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  return current;
}
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const live = () => page.getByRole("button", { name: "Live", exact: true });
async function settled() {
  // Fit view and the zoom variable settle over a few frames.
  await page.waitForTimeout(450);
}
async function shot(name) {
  const file = resolve(output, `${name}.png`);
  await page.screenshot({ path: file });
  screenshots.push(relative(repository, file));
}
async function check(name, run) {
  const started = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  console.log("PASS", name);
}
const rect = (box) => ({
  left: box.left,
  top: box.top,
  right: box.right,
  bottom: box.bottom,
});
const intersect = (a, b, air = 0) =>
  a.left < b.right + air &&
  b.left < a.right + air &&
  a.top < b.bottom + air &&
  b.top < a.bottom + air;
/** The canvas zoom, from the viewport's transform. */
const zoomOf = () =>
  page.evaluate(() => {
    const viewport = document.querySelector(".react-flow__viewport");
    return new DOMMatrix(getComputedStyle(viewport).transform).a;
  });
/** Every card and rate chip as a screen rectangle, with the size of its text on screen. */
const drawn = () =>
  page.evaluate(() => {
    const zoom = new DOMMatrix(
      getComputedStyle(document.querySelector(".react-flow__viewport"))
        .transform,
    ).a;
    const box = (element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    return {
      zoom,
      cards: [...document.querySelectorAll(".react-flow__node")].map(
        (element) => ({ id: element.dataset.id, ...box(element) }),
      ),
      chips: [...document.querySelectorAll(".pipeline-edge-rate")].map(
        (element) => ({
          text: element.textContent.trim(),
          // The chip scales itself back up; its on-screen text is the font
          // size times the share of the canvas zoom it keeps.
          px:
            parseFloat(getComputedStyle(element).fontSize) *
            (element.getBoundingClientRect().height / element.offsetHeight),
          ...box(element),
        }),
      ),
      readings: [
        ...document.querySelectorAll(
          ".pipeline-node-live-stat b, .pipeline-node-live-badge",
        ),
      ].map((element) => ({
        text: element.textContent.trim(),
        px: parseFloat(getComputedStyle(element).fontSize) * zoom,
      })),
    };
  });
/**
 * Where every connection is drawn on screen, sampled along its path, with the
 * cards at its two ends named.
 */
const lines = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge")].map((edge) => {
      const path = edge.querySelector(".react-flow__edge-path");
      const [, source, target] =
        /Connection from ([^.,\s]+)(?:\.\S+)? to ([^,\s]+)/.exec(
          edge.getAttribute("aria-label") || "",
        ) || [];
      const matrix = path.getScreenCTM();
      const length = path.getTotalLength();
      const points = [];
      for (let at = 0; at <= length; at += 6) {
        const point = path.getPointAtLength(at).matrixTransform(matrix);
        points.push({ x: point.x, y: point.y });
      }
      return {
        id: edge.dataset.id,
        source,
        target,
        width: parseFloat(path.style.strokeWidth || "0"),
        label: edge.getAttribute("aria-label"),
        points,
      };
    }),
  );
/** Connections drawn over a card that is not one of their two ends. */
function behindCards(connections, cards, air = 4) {
  const found = [];
  for (const connection of connections)
    for (const card of cards) {
      if ([connection.source, connection.target].includes(card.id)) continue;
      if (
        connection.points.some(
          (point) =>
            point.x > card.left - air &&
            point.x < card.right + air &&
            point.y > card.top - air &&
            point.y < card.bottom + air,
        )
      )
        found.push(
          `${connection.source} → ${connection.target} behind ${card.id}`,
        );
    }
  return found;
}
const fourOutputs = () =>
  running([
    component("seed", {
      sent_events_per_second: 200,
      sent_by_output: { _default: 200 },
    }),
    component("split", {
      received_events_per_second: 200,
      sent_events_per_second: 200,
      sent_by_output: { a: 120, b: 50, c: 20, d: 7.5, _unmatched: 2.5 },
    }),
    component("enrich", {
      received_events_per_second: 50,
      sent_events_per_second: 50,
      sent_by_output: { _default: 50 },
    }),
    component("out_a", { received_events_per_second: 120 }),
    component("out_b", { received_events_per_second: 50 }),
    component("out_c", { received_events_per_second: 20 }),
    component("out_d", { received_events_per_second: 7.5 }),
    component("out_rest", { received_events_per_second: 2.5 }),
  ]);

try {
  await check(
    "Live is on for a pipeline a device runs, and its numbers read at their own size without zooming",
    async () => {
      const state = await load();
      await expect(live()).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".editor-live-status")).toContainText(
        "Live for v1 · 3 devices",
      );
      // The default is not a saved choice.
      expect(
        await page.evaluate(() =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith("vectory.editor.live"),
          ),
        ),
      ).toEqual([]);
      expect(state.telemetryReads).toBeGreaterThanOrEqual(1);
      await expect(page.locator(".pipeline-edge-rate")).toHaveCount(6);
      await settled();
      const view = await drawn();
      // The whole graph is in view and was not zoomed to be read.
      for (const card of view.cards) {
        expect(card.left).toBeGreaterThanOrEqual(0);
        expect(card.right).toBeLessThanOrEqual(1440);
      }
      expect(view.chips.length).toBe(6);
      for (const chip of view.chips)
        expect(chip.px, `rate label ${chip.text}`).toBeGreaterThanOrEqual(
          10.95,
        );
      expect(view.readings.length).toBeGreaterThan(8);
      for (const reading of view.readings)
        expect(reading.px, `reading ${reading.text}`).toBeGreaterThanOrEqual(
          10.95,
        );
      // A label never sits on a card or on another label.
      for (const chip of view.chips) {
        for (const card of view.cards)
          expect(intersect(chip, card), `${chip.text} on ${card.id}`).toBe(
            false,
          );
        for (const other of view.chips)
          if (other !== chip)
            expect(
              intersect(chip, other),
              `${chip.text} on ${other.text}`,
            ).toBe(false);
      }
      await shot("demo-1440-light");
    },
  );

  await check(
    "no connection runs behind a card, and the destinations stack in the order of the outputs feeding them",
    async () => {
      for (const [config, telemetry, order] of [
        [demoConfig(), demoTelemetry(), ["errors_out", "archive"]],
        [
          fourOutputConfig(),
          fourOutputs(),
          ["out_a", "out_b", "out_c", "out_d", "out_rest"],
        ],
      ]) {
        await load({ config, telemetry });
        await settled();
        const view = await drawn();
        expect(behindCards(await lines(), view.cards)).toEqual([]);
        const tops = order.map(
          (id) => view.cards.find((card) => card.id === id).top,
        );
        expect(tops).toEqual([...tops].sort((a, b) => a - b));
        // Destinations share a column.
        const lefts = order.map(
          (id) => view.cards.find((card) => card.id === id).left,
        );
        expect(new Set(lefts.map(Math.round)).size).toBe(1);
        for (const chip of view.chips)
          for (const card of view.cards)
            expect(intersect(chip, card), `${chip.text} on ${card.id}`).toBe(
              false,
            );
      }
      await shot("four-outputs-1440-light");
    },
  );

  await check(
    "a connection's width follows the logarithm of its rate, between 1.5 and 5 pixels",
    async () => {
      await load({ config: fourOutputConfig(), telemetry: fourOutputs() });
      await settled();
      const widths = new Map(
        (await lines()).map((line) => [line.label, line.width]),
      );
      const width = (match) =>
        [...widths].find(([label]) => label.includes(match))[1];
      const widest = width("seed to split"),
        thinnest = width("split._unmatched");
      expect(widest).toBeLessThanOrEqual(5);
      expect(thinnest).toBeGreaterThanOrEqual(1.5);
      expect(widest).toBeGreaterThan(width("split.c"));
      expect(width("split.c")).toBeGreaterThan(thinnest);
      // 200/s and 120/s are within a fraction of a decade: nearly the same.
      expect(widest - width("split.a")).toBeLessThan(0.4);
    },
  );

  await check(
    "the choice is remembered for this pipeline, and a pipeline nothing runs stays off until turned on",
    async () => {
      const key = `vectory.editor.live:${userId}:${pipelineId}`;
      const state = await load();
      await live().click();
      await expect(live()).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator(".pipeline-edge-rate")).toHaveCount(0);
      await expect(page.locator(".editor-live-status")).toHaveCount(0);
      expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBe(
        "off",
      );
      const reads = state.telemetryReads;
      await page.reload();
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await expect(live()).toHaveAttribute("aria-pressed", "false");
      await settled();
      // Off, so nothing was read to find out whether a device runs it.
      expect(state.telemetryReads).toBe(reads);
      await live().click();
      await expect(live()).toHaveAttribute("aria-pressed", "true");
      expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBe(
        "on",
      );
      await page.reload();
      await expect(live()).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".pipeline-edge-rate").first()).toBeVisible();

      // Nothing runs this pipeline: off, and turning it on says why.
      await load({ telemetry: telemetryOf() });
      await expect(live()).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator(".pipeline-edge-rate")).toHaveCount(0);
      await live().click();
      await expect(page.locator(".editor-live-status")).toContainText(
        "No device runs this pipeline yet. Deploy v1 to see live numbers.",
      );

      // Never published: there is nothing to run, so no Live and no read.
      const unpublished = await load({ published: null });
      await settled();
      await expect(live()).toHaveCount(0);
      expect(unpublished.telemetryReads).toBe(0);
    },
  );

  await check(
    "every number is in a table and in each card's and connection's accessible name",
    async () => {
      await load();
      await expect(node("by_severity")).toHaveAttribute(
        "aria-label",
        /Route by_severity, in 16 events per second, out 16 events per second/,
      );
      await expect(node("errors_out")).toHaveAttribute(
        "aria-label",
        /in 1\.8 events per second/,
      );
      await expect(
        page.locator('.react-flow__edge[aria-label*="by_severity.errors"]'),
      ).toHaveAttribute("aria-label", /1\.8 events per second/);
      await page.getByText("Show as table").click();
      const steps = page.locator(".editor-live-table table").first();
      const connections = page.locator(".editor-live-table table").nth(1);
      await expect(steps.locator("tbody tr")).toHaveCount(8);
      await expect(connections.locator("tbody tr")).toHaveCount(6);
      await expect(
        connections.getByRole("row", { name: /by_severity\.errors/ }),
      ).toContainText("1.8/s");
      await expect(
        connections.getByRole("row", { name: /^sample_rest archive/ }),
      ).toContainText("1.4/s");
      await expect(
        steps.getByRole("row", { name: /sample_rest/ }),
      ).toContainText("14/s");
      await shot("demo-table-1440-light");
      const accessibility = await new AxeBuilder({ page })
        .include(".editor-live-panel")
        .analyze();
      expect(accessibility.violations).toEqual([]);
    },
  );

  await check("Fit brings the whole graph back into view", async () => {
    await load({ config: fourOutputConfig(), telemetry: fourOutputs() });
    await settled();
    const before = await zoomOf();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await settled();
    expect(await zoomOf()).toBeGreaterThan(before);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await settled();
    const canvas = await page.locator(".react-flow").boundingBox();
    const view = await drawn();
    for (const card of view.cards) {
      expect(card.left).toBeGreaterThanOrEqual(canvas.x - 1);
      expect(card.right).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
      expect(card.top).toBeGreaterThanOrEqual(canvas.y - 1);
      expect(card.bottom).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
    }
    // A fitted tall graph is drawn small; the numbers keep their size.
    expect(await zoomOf()).toBeLessThan(0.65);
    for (const chip of view.chips)
      expect(chip.px, `rate label ${chip.text}`).toBeGreaterThanOrEqual(10.9);
  });

  await check("light, dark and phone screenshots", async () => {
    await load({ theme: "dark" });
    await settled();
    await shot("demo-1440-dark");
    await load({ width: 390, height: 844 });
    await settled();
    await shot("demo-390-light");
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await settled();
    await shot("demo-390-fit-light");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
} finally {
  await browser.close();
  await vite.close();
}
await writeFile(
  resolve(output, "result.json"),
  JSON.stringify({ results, screenshots, unexpected, errors }, null, 2),
);
if (errors.length || unexpected.length) {
  console.error({ errors, unexpected });
  process.exit(1);
}
