// Keystroke-to-paint latency of the production editor on a 144-component
// pipeline. Builds the dashboard, serves it locally and answers the API with
// an isolated synthetic fixture; never contacts a server, preview or device.
import { build } from "vite";
import { chromium, expect } from "@playwright/test";
import http from "node:http";
import { resolve, dirname, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(
  dashboard,
  "..",
  process.env.VECTORY_EDITOR_PERFORMANCE_OUTPUT || ".local/editor-performance",
);
// Budget per keystroke, measured from keydown to the frame after it paints
// (so it includes waiting for that frame). The canvas catches up in a
// deferred render; a keystroke that lands during that commit waits for it,
// which the p95 allowance covers.
const budget = { median: 30, p95: 60 };
const dist = resolve(output, "dist");
await mkdir(output, { recursive: true });
await build({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  logLevel: "warn",
  build: { outDir: dist, emptyOutDir: true },
});

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
};
const server = http.createServer(async (request, response) => {
  const path = new URL(request.url, "http://fixture").pathname;
  const file = resolve(dist, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(dist + sep)) return response.writeHead(403).end();
  try {
    const body = await readFile(file);
    response
      .writeHead(200, {
        "Content-Type": types[extname(file)] || "application/octet-stream",
      })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const pipelineId = "22222222-2222-4222-8222-222222222222";
const created = "2026-09-26T12:00:00Z";

// 24 chains of source → parse → filter → sample → tag → sink.
function largePipeline() {
  const sources = {},
    transforms = {},
    sinks = {};
  for (let index = 1; index <= 24; index++) {
    const n = String(index).padStart(2, "0");
    sources[`app_${n}`] = { type: "demo_logs", format: "json", interval: 1 };
    transforms[`parse_${n}`] = {
      type: "remap",
      inputs: [`app_${n}`],
      source: `. = parse_json!(.message)\n.team = "team_${n}"\n.level = downcase(string(.level) ?? "info")`,
    };
    transforms[`keep_${n}`] = {
      type: "filter",
      inputs: [`parse_${n}`],
      condition: '.level != "debug"',
    };
    transforms[`sample_${n}`] = {
      type: "sample",
      inputs: [`keep_${n}`],
      rate: 10,
    };
    transforms[`tag_${n}`] = {
      type: "remap",
      inputs: [`sample_${n}`],
      source: '.pipeline = "fleet"',
    };
    sinks[`out_${n}`] = { type: "blackhole", inputs: [`tag_${n}`] };
  }
  return { sources, transforms, sinks };
}
const config = largePipeline();
const componentCount = Object.values(config).reduce(
  (count, section) => count + Object.keys(section).length,
  0,
);
const unexpected = [],
  errors = [],
  results = [];
let testerRuns = 0;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addInitScript(() => {
  localStorage.setItem("vectory-sidebar-collapsed", "true");
  localStorage.setItem("vectory-theme", "light");
  localStorage.setItem("vectory.editor.auto-check", "off");
});
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
  const reply = (json, status = 200) => route.fulfill({ status, json });
  if (method === "GET" && path === "/status")
    return reply({ initialized: true, version: "synthetic" });
  if (method === "GET" && path === "/session")
    return reply({
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "perf@example.test",
        name: "Synthetic editor",
        role: "admin",
        enabled: true,
        revision: 1,
      },
      csrf_token: "synthetic-perf-csrf",
    });
  if (method === "GET" && path === "/settings")
    return reply({ instance_name: "Synthetic performance fixture" });
  if (method === "GET" && path === `/configurations/${pipelineId}`)
    return reply({
      id: pipelineId,
      name: "Fleet of 144 components",
      description: "Isolated performance fixture, never deployed.",
      revision: 1,
      archived: false,
      archived_at: null,
      created_at: created,
      updated_at: created,
      variables: [],
      config,
      graph: { nodes: [], edges: [] },
    });
  if (method === "GET" && path === `/configurations/${pipelineId}/history`)
    return reply({ items: [], total: 0, page: 1, page_size: 1 });
  // The inline sample tester runs after typing pauses; it is not measured.
  if (method === "POST" && path === "/vrl/test") {
    testerRuns++;
    return reply(
      { error: { code: "VALIDATOR_UNAVAILABLE", message: "Synthetic" } },
      503,
    );
  }
  unexpected.push(`${method} ${path}`);
  return reply({ error: { code: "UNEXPECTED", message: "Fixture" } }, 500);
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));

// Time from each keydown to the first task after the next frame is painted.
// `rounds` are typed one after another; `between` runs (unmeasured) after
// each round, e.g. to delete what was typed.
async function measure(label, focus, rounds, between = async () => {}) {
  await focus();
  await page.evaluate(() => {
    window.__keystrokes = [];
    window.__onKey = (event) => {
      if (event.key.length !== 1) return;
      const start = performance.now();
      requestAnimationFrame(() =>
        setTimeout(() => window.__keystrokes.push(performance.now() - start)),
      );
    };
    document.addEventListener("keydown", window.__onKey, true);
  });
  for (const text of rounds) {
    await page.keyboard.type(text, { delay: 80 });
    await page.waitForTimeout(400);
    await between(text);
  }
  const samples = await page.evaluate(() => {
    document.removeEventListener("keydown", window.__onKey, true);
    return window.__keystrokes;
  });
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const result = {
    label,
    keystrokes: samples.length,
    median_ms: Math.round(at(0.5) * 10) / 10,
    p95_ms: Math.round(at(0.95) * 10) / 10,
    max_ms: Math.round(sorted.at(-1) * 10) / 10,
  };
  results.push(result);
  console.log(JSON.stringify(result));
  expect(samples).toHaveLength(rounds.join("").length);
  return result;
}

let failure;
try {
  await page.goto(`${origin}/#/configurations/${pipelineId}`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible({
    timeout: 20000,
  });
  const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const vrl = await measure(
    `VRL program in a ${componentCount}-component pipeline`,
    async () => {
      // Select through the node's own click handler; at fit-all zoom the
      // first row can sit under the page header.
      await node("parse_01").dispatchEvent("click");
      const editor = page
        .locator(".editor-inspector")
        .getByRole("textbox", { name: "VRL program", exact: true });
      await editor.click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.press("Enter");
    },
    ['.note = "typed while measuring"'],
  );
  const scalar = await measure(
    `Number option in a ${componentCount}-component pipeline`,
    async () => {
      await page
        .getByRole("button", { name: "Close component settings", exact: true })
        .click();
      await node("sample_01").dispatchEvent("click");
      const rate = page
        .locator(".editor-inspector")
        .getByLabel("One in every", { exact: true });
      await rate.click();
      await rate.press("End");
    },
    ["12345678", "87654321", "13572468"],
    async (typed) => {
      for (let index = 0; index < typed.length; index++)
        await page.keyboard.press("Backspace");
    },
  );
  // The canvas catches up once typing pauses.
  await page.keyboard.type("5");
  await expect(node("sample_01")).toContainText("105");
  for (const result of [vrl, scalar]) {
    expect(result.median_ms, result.label).toBeLessThan(budget.median);
    expect(result.p95_ms, result.label).toBeLessThan(budget.p95);
  }
  expect(componentCount).toBe(144);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  await page.screenshot({ path: resolve(output, "failure.png") });
} finally {
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Production build of the actual editor with a 144-component synthetic pipeline and GET-only fixture API. Latency is keydown to the first task after the next painted frame.",
        passed: !failure,
        budget_ms: budget,
        components: componentCount,
        results,
        tester_runs: testerRuns,
        unexpected,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  server.close();
}
if (failure) throw failure;
