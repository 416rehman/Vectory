// The device page's Effective configuration section: the real App and device
// page against synthetic replies, so every state is reachable. What it checks:
// the offered text is shown and copied exactly, the viewer loads lazily and
// draws only the lines in view (a 600 KiB artifact at 390 px and 1440 px), one
// read per generation chosen and none per keystroke, the drift sentence for each
// verdict, the changes and variables panels, every failure state, and light,
// dark and phone layouts with Axe. Nothing is written to a server.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { diffLines } from "diff";
import AxeBuilder from "./axe.mjs";
import { fleetReplies, fulfillFleetRead } from "./fleet-replies.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_EFFECTIVE_CONFIGURATION_OUTPUT ||
    ".local/effective-configuration",
);
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:effective-configuration";
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "effective-configuration-fixture",
      resolveId(id) {
        if (id === "virtual:effective-configuration") return virtual;
      },
      load(id) {
        if (id === virtual)
          return "import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));";
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url.split("?")[0] !== "/__effective-configuration")
            return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic effective configuration</title></head><body><div id="root"></div><script type="module">import "virtual:effective-configuration";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();

const sha = (text) => createHash("sha256").update(text).digest("hex");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pipelineId = id(900);
const deviceId = id(1);
const label = (number, name = "Edge syslog") => ({
  id: id(100 + number),
  number,
  configuration_id: pipelineId,
  configuration_name: name,
});
const pretty = (value) => JSON.stringify(value, null, 2) + "\n";
const pipeline = (maxEvents, interval) => ({
  sinks: {
    out: {
      buffer: { max_events: maxEvents, type: "memory" },
      inputs: ["in"],
      type: "blackhole",
    },
  },
  sources: { in: { format: "json", interval, type: "demo_logs" } },
});
const offer = (generation, number, content, at) => ({
  generation,
  version: label(number),
  content,
  sha256: sha(content),
  offered_at: at,
});
// Generations 10 and 11 offer the same bytes: a retry.
const history = () => [
  offer(9, 1, pretty(pipeline(500, 1)), "2026-09-27T10:00:00Z"),
  offer(10, 2, pretty(pipeline(600, 1)), "2026-09-28T10:00:00Z"),
  offer(11, 2, pretty(pipeline(600, 1)), "2026-09-28T10:20:00Z"),
  offer(12, 3, pretty(pipeline(700, 5)), "2026-09-29T10:00:00Z"),
];
const declared = [
  { name: "max_events", path: "/sinks/out/buffer/max_events", type: "integer" },
];

/** Hunks of a line diff as the server shapes them: three lines of context, two changes at most six lines apart share a hunk. */
function sectionOf(lines, index) {
  const open = [];
  for (let at = 0; at < index && at < lines.length; at++) {
    const text = lines[at].trimStart();
    if (text.startsWith("}") || text.startsWith("]")) open.pop();
    else if (text.endsWith("{") || text.endsWith("[")) {
      const key = /^"((?:[^"\\]|\\.)*)": /.exec(text);
      open.push(key ? key[1] : null);
    }
  }
  const path = open.filter(Boolean).join(".");
  return path || null;
}
function makeDiff(from, to) {
  const rows = [];
  let o = 0,
    n = 0;
  for (const part of diffLines(from.content, to.content)) {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const text of lines) {
      if (part.added)
        rows.push({ kind: "added", old_line: null, new_line: ++n, text });
      else if (part.removed)
        rows.push({ kind: "removed", old_line: ++o, new_line: null, text });
      else rows.push({ kind: "context", old_line: ++o, new_line: ++n, text });
    }
  }
  const newLines = to.content.split("\n");
  const oldLines = from.content.split("\n");
  const changes = rows.flatMap((row, i) => (row.kind === "context" ? [] : [i]));
  const counts = { added: 0, removed: 0, changed: 0 };
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind === "context") {
      i++;
      continue;
    }
    let gone = 0,
      came = 0;
    while (i < rows.length && rows[i].kind !== "context")
      rows[i++].kind === "removed" ? gone++ : came++;
    const pairs = Math.min(gone, came);
    counts.changed += pairs;
    counts.removed += gone - pairs;
    counts.added += came - pairs;
  }
  const hunks = [];
  for (let i = 0; i < changes.length;) {
    const start = Math.max(0, changes[i] - 3);
    let last = changes[i++];
    while (i < changes.length && changes[i] - last <= 7) last = changes[i++];
    const end = Math.min(rows.length, last + 4);
    const body = rows.slice(start, end);
    const first = body.find((row) => row.kind !== "context");
    const oldCount = body.filter((row) => row.old_line !== null).length;
    const newCount = body.filter((row) => row.new_line !== null).length;
    const section =
      first.kind === "added"
        ? sectionOf(newLines, first.new_line - 1)
        : sectionOf(oldLines, first.old_line - 1);
    hunks.push({
      old_start: body.find((row) => row.old_line !== null)?.old_line ?? 0,
      old_lines: oldCount,
      new_start: body.find((row) => row.new_line !== null)?.new_line ?? 0,
      new_lines: newCount,
      section,
      lines: body,
    });
  }
  const unified = [
    `--- generation ${from.generation}`,
    `+++ generation ${to.generation}`,
    ...hunks.flatMap((hunk) => [
      `@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@${hunk.section ? " " + hunk.section : ""}`,
      ...hunk.lines.map(
        (row) =>
          `${{ context: " ", removed: "-", added: "+" }[row.kind]}${row.text}`,
      ),
    ]),
  ].join("\n");
  return {
    counts,
    hunks,
    unified: unified + "\n",
    total_lines: unified.split("\n").length,
  };
}
const side = (o) => ({
  generation: o.generation,
  version: o.version,
  sha256: o.sha256,
  size: Buffer.byteLength(o.content),
  offered_at: o.offered_at,
});

// A device that runs generation 12 and reports the digest of that file.
const baseDevice = (over = {}) => ({
  id: deviceId,
  name: "edge-nyc-01",
  os: "linux",
  arch: "amd64",
  agent_version: "0.1.0",
  vector_version: "0.58.0",
  configuration_mode: "full",
  created_at: "2026-09-20T09:00:00Z",
  last_seen: new Date().toISOString(),
  status: "verified",
  apply_state: "verified_applied",
  actual_sha256: history().at(-1).sha256,
  desired_generation: 12,
  reported_generation: 12,
  desired_version_id: label(3).id,
  desired_version: label(3),
  labels: {},
  sync_paused: false,
  local_paused: false,
  pause_acknowledged: false,
  effective_policy: {
    heartbeat_seconds: 60,
    sync_paused: false,
    telemetry_enabled: true,
  },
  ...over,
});

const results = [],
  requests = [],
  errors = [],
  unexpected = [],
  accessibility = [],
  screenshots = [],
  measurements = [];
let context, page, state;

/** What the server would answer for a read of this device. */
function configurationReply(url) {
  const params = [...url.searchParams];
  if (
    params.some(([key]) => key !== "generation") ||
    params.length > 1 ||
    (params[0] && !/^[1-9]\d*$/.test(params[0][1]))
  )
    return [
      400,
      { error: { code: "INVALID_INPUT", message: "Invalid query parameters" } },
    ];
  const offers = [...state.offers].sort((a, b) => b.generation - a.generation);
  const assigned = !!state.device.desired_version_id;
  const requested = params[0] ? Number(params[0][1]) : null;
  const generation = requested ?? state.device.desired_generation;
  const chosen = offers.find((o) => o.generation === generation);
  if (requested !== null && !chosen)
    return [
      404,
      {
        error: {
          code: "NOT_FOUND",
          message: "This device was never offered that generation",
        },
      },
    ];
  const target = requested === null && !assigned ? null : chosen;
  const items = offers.slice(0, 50).map((o) => ({
    generation: o.generation,
    version: o.version,
    sha256: o.sha256,
    offered_at: o.offered_at,
  }));
  const earlier = offers.find((o) => o.generation < generation);
  const actual = state.device.actual_sha256 ?? null;
  // The newest generation offered with the reported digest, if any was.
  const offeredAs = actual
    ? (offers.find((o) => o.sha256 === actual)?.generation ?? null)
    : null;
  const running = state.running ?? {
    sha256: actual,
    template_sha256: null,
    matches: !actual || !target ? null : actual === target.sha256,
    matches_generation: !target || actual !== target.sha256 ? offeredAs : null,
    reported_at: state.device.last_seen ?? null,
  };
  return [
    200,
    {
      device_id: deviceId,
      generation: target ? target.generation : generation,
      current: generation === state.device.desired_generation,
      offered_at: target?.offered_at ?? null,
      version: target?.version ?? null,
      sha256: target?.sha256 ?? null,
      size: target ? Buffer.byteLength(target.content) : null,
      format: target ? "json" : null,
      content: target?.content ?? null,
      uses_local_secrets: !!state.secrets,
      variables: target ? (state.variables ?? []) : [],
      running,
      previous: earlier
        ? {
            generation: earlier.generation,
            version: earlier.version,
            sha256: earlier.sha256,
          }
        : null,
      generations: { total: offers.length, items },
    },
  ];
}
function diffReply(url) {
  const params = [...url.searchParams];
  const from = state.offers.find(
    (o) => o.generation === Number(url.searchParams.get("from")),
  );
  const to = state.offers.find(
    (o) => o.generation === Number(url.searchParams.get("to")),
  );
  if (params.length !== 2 || !from || !to)
    return [
      404,
      {
        error: {
          code: "NOT_FOUND",
          message: "This device was never offered that generation",
        },
      },
    ];
  if (state.diff) return [200, state.diff(from, to)];
  const identical = from.sha256 === to.sha256;
  const made = identical
    ? {
        counts: { added: 0, removed: 0, changed: 0 },
        hunks: [],
        unified: "",
        total_lines: 0,
      }
    : makeDiff(from, to);
  return [
    200,
    {
      device_id: deviceId,
      from: side(from),
      to: side(to),
      identical,
      ...made,
      truncated: false,
      approximate: false,
    },
  ];
}

async function load({
  device = baseDevice(),
  offers = history(),
  running,
  secrets = false,
  variables,
  role = "viewer",
  width = 1280,
  height = 1000,
  theme = "light",
  blockViewer = false,
} = {}) {
  if (context) await context.close();
  state = {
    device,
    offers,
    running,
    secrets,
    variables,
    hold: new Map(),
    fail: null,
    diff: null,
  };
  requests.length = 0;
  context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
    localStorage.setItem("vectory-sidebar-collapsed", "true");
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__longTasks.push(Math.round(entry.duration));
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* Long task timing is not available everywhere. */
    }
  }, theme);
  const fleet = fleetReplies({ devices: () => [state.device], groups: [] });
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    if (url.origin !== origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort();
    }
    // The code viewer's files are missing: the rest of the card must stay.
    if (blockViewer && url.pathname.includes("EffectiveConfigurationViewer"))
      return route.fulfill({ status: 404, body: "Synthetic missing file" });
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7);
    requests.push({ method, path, query: url.search, at: Date.now() });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (method === "GET") {
      if (path === "/status")
        return reply({ initialized: true, version: "synthetic" });
      if (path === "/session")
        return reply({
          user: {
            id: id(99),
            email: "reviewer@example.test",
            name: "Synthetic reviewer",
            role,
            enabled: true,
            revision: 1,
          },
          csrf_token: "synthetic",
        });
      if (path === "/settings") return reply({ instance_name: "Synthetic" });
      if (await fulfillFleetRead(fleet, route)) return;
      if (path === `/devices/${deviceId}/configuration`) {
        const wait = state.hold.get(url.search);
        if (wait) await wait;
        if (state.fail) {
          const fail = state.fail;
          if (fail.once) state.fail = null;
          return reply(
            {
              error: {
                code: fail.code ?? "INTERNAL",
                message: fail.message ?? "Synthetic failure",
              },
            },
            fail.status,
          );
        }
        const [status, json] = configurationReply(url);
        return reply(json, status);
      }
      if (path === `/devices/${deviceId}/configuration/diff`) {
        if (state.failDiff) {
          const fail = state.failDiff;
          if (fail.once) state.failDiff = null;
          return reply(
            {
              error: {
                code: "INTERNAL",
                message: fail.message ?? "Synthetic diff failure",
              },
            },
            500,
          );
        }
        const [status, json] = diffReply(url);
        return reply(json, status);
      }
      if (path === `/versions/${label(3).id}`)
        return reply({
          id: label(3).id,
          configuration_id: pipelineId,
          number: 3,
          config: {},
          graph: { nodes: [], edges: [] },
          sha256: "a".repeat(64),
          size: 10,
          artifact: "{}",
          created_at: "2026-09-29T09:00:00Z",
          message: "",
        });
      if (path === `/configurations/${pipelineId}`)
        return reply({
          id: pipelineId,
          name: "Edge syslog",
          description: "",
          revision: 1,
          config: {},
          graph: { nodes: [], edges: [] },
          created_at: "2026-09-29T09:00:00Z",
          updated_at: "2026-09-29T09:00:00Z",
          archived: false,
        });
      if (path === "/devices") return reply([state.device]);
      if (path === "/groups") return reply([]);
      if (path === `/devices/${deviceId}/telemetry`)
        return reply({ device_id: deviceId, samples: [] });
      if (path === "/issues/history" || path === "/audit/history")
        return reply({ items: [], total: 0, page: 1, page_size: 12 });
      if (path === "/deployments/history")
        return reply({ items: [], total: 0, page: 1, page_size: 12 });
      if (path === "/agent-install" || path === "/releases")
        return reply(path === "/releases" ? [] : { releases: [] });
    }
    unexpected.push(`${method} ${path}`);
    return reply(
      {
        error: { code: "UNEXPECTED", message: "Unexpected synthetic request" },
      },
      500,
    );
  });
  page = await context.newPage();
  page.setDefaultTimeout(9000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/__effective-configuration#/devices/${deviceId}`);
}

const section = () =>
  page.getByRole("region", { name: "Effective configuration", exact: true });
const reads = () =>
  requests.filter(
    (r) =>
      r.method === "GET" && r.path === `/devices/${deviceId}/configuration`,
  );
const diffs = () =>
  requests.filter((r) => r.path === `/devices/${deviceId}/configuration/diff`);
const viewer = () => section().locator(".cm-content");
const shown = async () => {
  await expect(section()).toBeVisible();
  await expect(viewer()).toBeVisible();
};
async function pick(text) {
  const select = section().getByRole("combobox", { name: "Generation" });
  const option = select.locator("option").filter({ hasText: text }).first();
  await select.selectOption(await option.getAttribute("value"));
}
const failures = [];
/** Every check runs even when an earlier one fails, so one run shows them all. */
async function check(name, run) {
  const start = Date.now();
  try {
    await run();
    results.push({ name, passed: true, milliseconds: Date.now() - start });
    console.log("PASS", name);
  } catch (error) {
    const message = String(error?.message ?? error)
      .split("\n")
      .slice(0, 16)
      .join("\n");
    results.push({
      name,
      passed: false,
      milliseconds: Date.now() - start,
      message,
    });
    failures.push(name);
    console.log("FAIL", name);
    console.log(message);
  }
}
/** The section as a visitor sees it: a viewport as tall as the page, so nothing sticky is drawn over it. */
async function shot(name) {
  const file = `${name}.png`;
  const { width, height } = page.viewportSize();
  const tall = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width, height: Math.max(height, tall + 40) });
  await section().screenshot({ path: resolve(output, file) });
  await page.setViewportSize({ width, height });
  screenshots.push(file);
}
async function scan(name) {
  const audit = await new AxeBuilder({ page })
    .include(".effective-config")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = audit.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.map((node) => node.target.join(" ")).slice(0, 3),
    why: nodes
      .map((node) => node.any[0]?.message ?? node.failureSummary)
      .slice(0, 3),
  }));
  accessibility.push({ name, violations });
  expect(violations, name).toEqual([]);
}
const noOverflow = async (name) => {
  const metrics = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
    card: document.querySelector(".effective-config")?.scrollWidth ?? 0,
    cardBox: document.querySelector(".effective-config")?.clientWidth ?? 0,
  }));
  expect(
    metrics.page,
    `${name}: the page scrolls sideways`,
  ).toBeLessThanOrEqual(metrics.view);
  expect(metrics.card, `${name}: the card overflows`).toBeLessThanOrEqual(
    metrics.cardBox,
  );
};

/** Pretty JSON of about `bytes` bytes, many components, one setting per line. */
function large(bytes) {
  const transforms = {};
  let text = "";
  for (let n = 0; text.length < bytes; n++) {
    transforms[`parse_${String(n).padStart(5, "0")}`] = {
      inputs: ["in"],
      source: `.field_${n} = parse_json!(.message)`,
      type: "remap",
    };
    if (n % 200 === 199) text = pretty({ transforms });
  }
  return pretty({ transforms });
}

try {
  await check(
    "Shows the offered text exactly, with the viewer loaded only once there is something to show",
    async () => {
      await load();
      await shown();
      await expect(
        section().getByRole("heading", {
          name: "Effective configuration",
          exact: true,
        }),
      ).toBeVisible();
      const current = history().at(-1);
      const text = await viewer().innerText();
      expect(text).toContain('"max_events": 700');
      expect(text).toContain('"interval": 5');
      // Line numbers and a labelled, read-only text region.
      await expect(section().locator(".cm-lineNumbers")).toBeVisible();
      const region = section().getByRole("textbox", {
        name: "Configuration offered at generation 12",
      });
      await expect(region).toHaveAttribute("aria-readonly", "true");
      await expect(region).toHaveAttribute("tabindex", "0");
      await expect(section().locator(".cm-content")).toHaveAttribute(
        "contenteditable",
        "false",
      );
      // The summary names the version, generation, size, format and a digest.
      const summary = section().locator(".effective-config-summary");
      await expect(summary).toContainText("Edge syslog v3");
      await expect(summary).toContainText("generation 12");
      await expect(summary).toContainText("JSON");
      await expect(summary).toContainText(
        `${current.sha256.slice(0, 8)}…${current.sha256.slice(-4)}`,
      );
      await expect(
        summary.getByRole("link", { name: "Edge syslog v3" }),
      ).toHaveAttribute("href", `#/configurations/${pipelineId}?panel=history`);
      // One read, and the diff is not read until it is opened.
      expect(reads().length).toBe(1);
      expect(reads()[0].query).toBe("");
      expect(diffs().length).toBe(0);
      // The viewer module is fetched after the read, not with the page.
      const viewerFetch = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((entry) =>
            entry.name.includes("EffectiveConfigurationViewer"),
          )
          .map((entry) => Math.round(entry.startTime)),
      );
      expect(viewerFetch.length).toBeGreaterThan(0);
      const configurationRead = await page.evaluate(
        (path) =>
          performance
            .getEntriesByType("resource")
            .filter((entry) => entry.name.includes(path))
            .map((entry) => Math.round(entry.responseEnd))[0],
        `/devices/${deviceId}/configuration`,
      );
      expect(viewerFetch[0]).toBeGreaterThanOrEqual(configurationRead - 5);
    },
  );

  await check(
    "Says when the generation picker holds only the newest 50 of the generations offered",
    async () => {
      const many = Array.from({ length: 212 }, (_, n) =>
        offer(n + 1, 3, pretty(pipeline(700, 5)), "2026-09-29T10:00:00Z"),
      );
      await load({
        offers: many,
        device: baseDevice({
          desired_generation: 212,
          reported_generation: 212,
        }),
      });
      await shown();
      const note = section().locator(".effective-config-picker-note");
      await expect(note).toHaveText("Showing the newest 50 of 212");
      await expect(
        section().getByLabel("Generation", { exact: true }),
      ).toHaveAccessibleDescription("Showing the newest 50 of 212");
      await load();
      await shown();
      await expect(
        section().locator(".effective-config-picker-note"),
      ).toHaveCount(0);
    },
  );

  await check(
    "Says the running configuration matches, only when the server verified it",
    async () => {
      await load();
      await shown();
      const line = section().getByRole("status").first();
      await expect(line).toContainText("Running matches what Vectory offered.");
      await expect(
        section().getByText("Matches", { exact: true }),
      ).toBeVisible();
      await expect(line).toContainText("Reported");
      await expect(
        section().getByRole("link", { name: /How Vectory compares them/ }),
      ).toHaveAttribute(
        "href",
        /\/help\/deployments\/.*#read-what-a-device-was-offered/,
      );
    },
  );

  await check(
    "Copy and Download give exactly the offered text and claim no activation",
    async () => {
      await load();
      await shown();
      const current = history().at(-1);
      await section()
        .getByRole("button", {
          name: /^Copy the JSON offered at generation 12/,
        })
        .click();
      await expect(
        section().getByText("Copied", { exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        current.content,
      );
      const [file] = await Promise.all([
        page.waitForEvent("download"),
        section()
          .getByRole("button", {
            name: /^Download the JSON offered at generation 12/,
          })
          .click(),
      ]);
      expect(file.suggestedFilename()).toBe("edge-nyc-01-generation-12.json");
      const saved = await readFile(await file.path(), "utf8");
      expect(saved).toBe(current.content);
      expect(createHash("sha256").update(saved).digest("hex")).toBe(
        current.sha256,
      );
      const note = section().getByText(
        /Download started: edge-nyc-01-generation-12\.json/,
      );
      await expect(note).toBeVisible();
      await expect(note).toContainText("doesn't change what the device runs");
      // Reading never writes.
      expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
    },
  );

  await check("Wrap lines is a toggle that keeps the text", async () => {
    await load();
    await shown();
    const toggle = section().getByRole("button", {
      name: "Wrap lines",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(section().locator(".cm-lineWrapping")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(section().locator(".cm-lineWrapping")).toHaveCount(1);
    expect(await viewer().innerText()).toContain('"max_events": 700');
    await toggle.click();
    await expect(section().locator(".cm-lineWrapping")).toHaveCount(0);
    expect(reads().length).toBe(1);
  });

  await check(
    "One read per generation chosen, none per keystroke or hover, and the picker keeps its options",
    async () => {
      await load();
      await shown();
      const select = section().getByRole("combobox", { name: "Generation" });
      await expect(select.locator("option").first()).toHaveText(
        "Current: v3 · generation 12",
      );
      const options = await select.locator("option").allTextContents();
      expect(options).toHaveLength(4);
      expect(options[1]).toMatch(/^v2 · generation 11 · same as 10 · /);
      expect(options[2]).toMatch(/^v2 · generation 10 · /);
      expect(options[3]).toMatch(/^v1 · generation 9 · /);
      // Typing into the viewer's search and moving over the text read nothing.
      await viewer().click();
      await page.keyboard.press("Control+f");
      const find = section().locator(".cm-search input[name=search]");
      await expect(find).toBeVisible();
      await find.pressSequentially("max_events");
      await expect(section().locator(".cm-searchMatch").first()).toBeVisible();
      await viewer().hover();
      await section().locator(".effective-config-summary").hover();
      await page.waitForTimeout(400);
      expect(reads().length).toBe(1);
      // Choosing an earlier generation is one read, with its number.
      await pick("generation 11");
      await expect(viewer()).toContainText('"max_events": 600');
      expect(reads().length).toBe(2);
      expect(reads()[1].query).toBe("?generation=11");
      await expect(select).toHaveValue("11");
      await expect(select.locator("option")).toHaveCount(4);
      const line = section().getByRole("status").first();
      await expect(line).toContainText("The device doesn't run generation 11.");
      await expect(
        section().getByText("Not running", { exact: true }),
      ).toBeVisible();
      // Back to the current one: followed, not pinned.
      await section().getByRole("button", { name: "Show current" }).click();
      await expect(viewer()).toContainText('"max_events": 700');
      expect(reads().length).toBe(3);
      expect(reads()[2].query).toBe("");
      await expect(select).toHaveValue("12");
      await page.waitForTimeout(500);
      expect(reads().length).toBe(3);
    },
  );

  await check(
    "A slow reply for an earlier choice never replaces a later one",
    async () => {
      await load();
      await shown();
      let release;
      state.hold.set("?generation=10", new Promise((done) => (release = done)));
      await pick("generation 10");
      await expect(
        section().locator(".effective-config-loading"),
      ).toBeVisible();
      await pick("generation 9");
      await expect(viewer()).toContainText('"max_events": 500');
      release();
      await page.waitForTimeout(500);
      await expect(viewer()).toContainText('"max_events": 500');
      await expect(
        section().getByRole("combobox", { name: "Generation" }),
      ).toHaveValue("9");
    },
  );

  await check(
    "Reads again only when the device reports a different file or generation",
    async () => {
      await load({
        device: baseDevice({ actual_sha256: history().at(-1).sha256 }),
      });
      await shown();
      expect(reads().length).toBe(1);
      // A refresh that changes nothing about the file: no read.
      state.device = { ...state.device, last_seen: new Date().toISOString() };
      await page.getByRole("button", { name: "Refresh now" }).click();
      await page.waitForTimeout(600);
      expect(reads().length).toBe(1);
      // The agent now reports another digest: one read, and the line follows.
      state.device = {
        ...state.device,
        actual_sha256: history()[2].sha256,
        reported_generation: 11,
        apply_state: "failed",
        status: "failed",
      };
      await page.getByRole("button", { name: "Refresh now" }).click();
      await expect(section().getByRole("status").first()).toContainText(
        "differs from what Vectory offered at generation 12: it matches generation 11.",
      );
      expect(reads().length).toBe(2);
      expect(reads()[1].query).toBe("");
      await page.getByRole("button", { name: "Refresh now" }).click();
      await page.waitForTimeout(500);
      expect(reads().length).toBe(2);
    },
  );

  await check("Every verdict reads honestly", async () => {
    const current = history().at(-1);
    const cases = [
      {
        name: "differs, names the generation it is",
        device: baseDevice({
          actual_sha256: history()[1].sha256,
          apply_state: "desired",
          status: "applying",
        }),
        text: "differs from what Vectory offered at generation 12: it matches generation 11.",
        detail: "The agent hasn't finished applying generation 12.",
        badge: "Differs",
      },
      {
        name: "differs, unknown file",
        device: baseDevice({ actual_sha256: sha("edited by hand") }),
        text: "The running configuration differs from what Vectory offered at generation 12.",
        detail: "Vectory sees only the file's digest, never the file",
        badge: "Differs",
      },
      {
        name: "differs with sync paused",
        device: baseDevice({
          actual_sha256: sha("edited by hand"),
          sync_paused: true,
        }),
        text: "differs from what Vectory offered at generation 12.",
        detail: "Sync is paused, so the agent leaves the file as it is.",
        badge: "Differs",
      },
      {
        name: "not reported",
        device: baseDevice({ actual_sha256: null }),
        text: "Not reported by this agent.",
        detail: "Vectory can't say whether it runs this configuration.",
        badge: "Not reported",
      },
      {
        name: "never checked in",
        device: baseDevice({
          actual_sha256: null,
          last_seen: null,
          status: "awaiting_first_check_in",
          apply_state: "unmanaged",
          reported_generation: 0,
        }),
        text: "This device hasn't checked in yet.",
        detail: "Vectory can't say whether it runs this configuration.",
        badge: "Not reported",
      },
      {
        name: "offline",
        device: baseDevice({
          actual_sha256: current.sha256,
          status: "offline",
        }),
        text: "Running matches what Vectory offered.",
        detail: "The device is offline, so this is its last report.",
        badge: "Matches",
      },
      {
        name: "revoked",
        device: baseDevice({
          actual_sha256: current.sha256,
          status: "revoked",
        }),
        text: "This device can no longer report what it runs.",
        detail: "Its last report is the file digest below.",
        badge: "Revoked",
        running: {
          sha256: current.sha256,
          template_sha256: null,
          matches: null,
          matches_generation: null,
          reported_at: "2026-09-29T11:00:00Z",
        },
      },
    ];
    for (const item of cases) {
      await load({ device: item.device, running: item.running });
      await shown();
      const line = section().getByRole("status").first();
      await expect(line, item.name).toContainText(item.text);
      await expect(line, item.name).toContainText(item.detail);
      await expect(
        section().locator(".device-card-head .status-badge"),
        item.name,
      ).toContainText(item.badge);
      // Never a claim about what a local file contains.
      const said = await line.innerText();
      expect(said).not.toMatch(/someone|was edited by|contains/i);
    }
    // A version that reads device secrets.
    await load({
      secrets: true,
      device: baseDevice({
        actual_sha256: sha("file with the host's own secrets"),
      }),
      running: {
        sha256: sha("file with the host's own secrets"),
        template_sha256: current.sha256,
        matches: true,
        matches_generation: null,
        reported_at: new Date().toISOString(),
      },
    });
    await shown();
    const line = section().getByRole("status").first();
    await expect(line).toContainText("Running matches what Vectory offered.");
    await expect(line).toContainText("the host's own values");
    // The digests disclosure names both, and says how to read the host's.
    await section().getByText("Digests", { exact: true }).click();
    await expect(
      section().getByText("Template the agent applied"),
    ).toBeVisible();
    await expect(section().locator(".effective-config-digests")).toContainText(
      "sudo vectory status --json",
    );
    await expect(section().locator(".effective-config-digests")).toContainText(
      "never equals the offered one",
    );
  });

  await check(
    "The changes since the previous generation: counts, then hunks named by component",
    async () => {
      await load();
      await shown();
      await section()
        .getByRole("radio", { name: "Changes", exact: true })
        .click();
      await expect(
        section().getByRole("heading", {
          name: "What changed since generation 11",
        }),
      ).toBeVisible();
      expect(diffs().length).toBe(1);
      expect(diffs()[0].query).toBe("?from=11&to=12");
      await expect(section().locator(".effective-config-counts")).toContainText(
        "2 changed",
      );
      const hunks = section().locator(".effective-config-hunk");
      await expect(hunks).toHaveCount(2);
      await expect(hunks.nth(0).locator("header code")).toHaveText(
        "sinks.out.buffer",
      );
      await expect(hunks.nth(1).locator("header code")).toHaveText(
        "sources.in",
      );
      await expect(
        hunks.nth(0).locator("li[data-kind=removed] code"),
      ).toContainText('"max_events": 600');
      await expect(
        hunks.nth(0).locator("li[data-kind=added] code"),
      ).toContainText('"max_events": 700');
      // Line numbers on both sides and a marker, not color alone.
      await expect(
        hunks.nth(0).locator("li[data-kind=removed] .effective-config-mark"),
      ).toHaveText("−");
      await expect(
        hunks.nth(0).locator("li[data-kind=added] .effective-config-mark"),
      ).toHaveText("+");
      // Leaving and returning does not read again.
      await section()
        .getByRole("radio", { name: "Configuration", exact: true })
        .click();
      await section()
        .getByRole("radio", { name: "Changes", exact: true })
        .click();
      await expect(hunks).toHaveCount(2);
      expect(diffs().length).toBe(1);
      // Copy diff copies the unified text.
      await section()
        .getByRole("button", {
          name: /^Copy the diff from generation 11 to generation 12/,
        })
        .click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(
        copied.startsWith("--- generation 11\n+++ generation 12\n@@ "),
      ).toBe(true);
      expect(copied).toContain('+        "max_events": 700,');
    },
  );

  await check(
    "Changes of an earlier generation, identical text, and the first offer",
    async () => {
      await load();
      await shown();
      await section()
        .getByRole("radio", { name: "Changes", exact: true })
        .click();
      await expect(section().locator(".effective-config-hunk")).toHaveCount(2);
      // Generation 11 offered the same text as 10: no changes, said plainly.
      await pick("generation 11");
      await expect(
        section().getByText("No changes.", { exact: false }),
      ).toBeVisible();
      await expect(
        section().getByText(/same text as generation 10/),
      ).toBeVisible();
      expect(diffs().map((d) => d.query)).toEqual([
        "?from=11&to=12",
        "?from=10&to=11",
      ]);
      // The first thing the device was offered has nothing before it.
      await pick("generation 9");
      await expect(
        section().getByText(/first configuration offered to this device/),
      ).toBeVisible();
      expect(diffs().length).toBe(2);
    },
  );

  await check(
    "A long diff says it was cut, and an approximate one says so",
    async () => {
      await load();
      state.diff = (from, to) => {
        const lines = Array.from({ length: 1996 }, (_, n) => ({
          kind: "removed",
          old_line: n + 1,
          new_line: null,
          text: `    "key_${n}": "old value ${n}",`,
        }));
        return {
          device_id: deviceId,
          from: side(from),
          to: side(to),
          identical: false,
          counts: { added: 0, removed: 0, changed: 5000 },
          hunks: [
            {
              old_start: 1,
              old_lines: 1996,
              new_start: 0,
              new_lines: 0,
              section: "settings",
              lines,
            },
          ],
          unified: "--- generation 11\n+++ generation 12\n",
          truncated: true,
          total_lines: 10003,
          approximate: true,
        };
      };
      await shown();
      await section()
        .getByRole("radio", { name: "Changes", exact: true })
        .click();
      await expect(
        section().getByText(/too large to match line by line/),
      ).toBeVisible();
      await expect(
        section().getByText(/Only the first 1,996 lines of the diff are shown/),
      ).toBeVisible();
      await expect(section().locator(".effective-config-more")).toContainText(
        "160 of 1,996 lines shown",
      );
      await expect(section().locator(".effective-config-hunk li")).toHaveCount(
        160,
      );
      await section()
        .getByRole("button", { name: "Show 240 more lines" })
        .click();
      await expect(section().locator(".effective-config-hunk li")).toHaveCount(
        400,
      );
    },
  );

  await check(
    "Variables: the values this device was offered and where each came from",
    async () => {
      await load({
        variables: [
          {
            name: "max_events",
            path: "/sinks/out/buffer/max_events",
            type: "integer",
            value: 700,
            source: "device",
          },
          {
            name: "interval",
            path: "/sources/in/interval",
            type: "integer",
            value: 5,
            source: "default",
          },
          {
            name: "token",
            path: "/sinks/out/auth/token",
            type: "string",
            value: null,
            source: null,
          },
        ],
      });
      await shown();
      const tab = section().getByRole("radio", { name: /Variables/ });
      await expect(tab).toContainText("3");
      await tab.click();
      const rows = section().locator(".effective-config-variables li");
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText("max_events");
      await expect(rows.nth(0)).toContainText("sinks.out.buffer.max_events");
      await expect(rows.nth(0).locator("code")).toHaveText("700");
      await expect(rows.nth(0)).toContainText("Set for this device");
      await expect(rows.nth(1)).toContainText("Deployment default");
      await expect(rows.nth(2)).toContainText("Not shown");
      await expect(rows.nth(2)).toContainText("Not recorded");
      // A version without values.
      await load();
      await shown();
      await section()
        .getByRole("radio", { name: /Variables/ })
        .click();
      await expect(
        section().getByText(/no device-specific values/),
      ).toBeVisible();
      // A version that reads device secrets says the values stay on the device.
      await load({
        secrets: true,
        running: {
          sha256: null,
          template_sha256: null,
          matches: null,
          matches_generation: null,
          reported_at: null,
        },
      });
      await shown();
      await section()
        .getByRole("radio", { name: /Variables/ })
        .click();
      await expect(
        section().getByText(/They stay on the device/),
      ).toBeVisible();
    },
  );

  await check(
    "Nothing offered, an assignment removed, and a revoked device",
    async () => {
      await load({
        offers: [],
        device: baseDevice({
          desired_generation: 0,
          reported_generation: 0,
          desired_version_id: null,
          desired_version: null,
          status: "unmanaged",
          apply_state: "unmanaged",
          actual_sha256: null,
        }),
      });
      await expect(section()).toBeVisible();
      await expect(
        section().getByRole("heading", { name: "Nothing offered yet" }),
      ).toBeVisible();
      await expect(
        section().getByText("Deploy a pipeline to this device"),
      ).toBeVisible();
      await expect(section().locator(".cm-content")).toHaveCount(0);
      // Its assignment removed: history is still readable.
      const removed = baseDevice({
        desired_generation: 13,
        desired_version_id: null,
        desired_version: null,
        status: "unmanaged",
        apply_state: "unmanaged",
        actual_sha256: history().at(-1).sha256,
      });
      await load({ device: removed });
      await expect(section().getByRole("status").first()).toContainText(
        "Nothing is offered to this device now.",
      );
      await expect(section().getByRole("status").first()).toContainText(
        "is what Vectory offered at generation 12",
      );
      await expect(section().locator(".cm-content")).toHaveCount(0);
      const select = section().getByRole("combobox", { name: "Generation" });
      await expect(select.locator("option").first()).toHaveText(
        "Nothing offered now",
      );
      await pick("generation 12");
      await expect(viewer()).toContainText('"max_events": 700');
      expect(reads().at(-1).query).toBe("?generation=12");
      // A revoked device that was never offered anything.
      await load({
        offers: [],
        device: baseDevice({
          status: "revoked",
          desired_generation: 0,
          desired_version_id: null,
          desired_version: null,
          actual_sha256: null,
        }),
      });
      await expect(
        section().getByText(/before its access was revoked/),
      ).toBeVisible();
    },
  );

  await check(
    "Failures: a retry, a generation never offered, no access, and a refresh that fails",
    async () => {
      await load();
      state.fail = {
        status: 500,
        message: "Synthetic server failure",
        once: true,
      };
      await page.goto(
        `${origin}/__effective-configuration#/devices/${deviceId}`,
      );
      await page.reload();
      const alert = section()
        .getByRole("alert")
        .filter({ hasText: "couldn't be loaded" });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText("Synthetic server failure");
      await alert.getByRole("button", { name: "Retry" }).click();
      await expect(viewer()).toBeVisible();
      // A generation the device never had.
      await pick("generation 10");
      await expect(viewer()).toContainText('"max_events": 600');
      state.offers = state.offers.filter((o) => o.generation !== 10);
      await section().getByRole("button", { name: "Show current" }).click();
      await expect(viewer()).toContainText('"max_events": 700');
      // No access.
      await load();
      state.fail = {
        status: 403,
        code: "FORBIDDEN",
        message: "Permission denied",
      };
      await page.reload();
      await expect(
        section().getByRole("heading", {
          name: "You can't view this configuration",
        }),
      ).toBeVisible();
      // A refresh that fails keeps what is shown, and says how old it is.
      await load({
        device: baseDevice({ actual_sha256: history().at(-1).sha256 }),
      });
      await shown();
      state.fail = { status: 503, message: "Synthetic outage", once: true };
      state.device = {
        ...state.device,
        actual_sha256: sha("another file"),
        reported_generation: 11,
      };
      await page.getByRole("button", { name: "Refresh now" }).click();
      const stale = section()
        .getByRole("alert")
        .filter({ hasText: "Couldn't refresh this configuration." });
      await expect(stale).toBeVisible();
      await expect(viewer()).toContainText('"max_events": 700');
      await stale.getByRole("button", { name: "Retry" }).click();
      await expect(stale).toHaveCount(0);
      await expect(section().getByRole("status").first()).toContainText(
        "differs from what Vectory offered",
      );
      // The comparison fails on its own.
      await load();
      await shown();
      state.failDiff = { message: "Synthetic comparison failure", once: true };
      await section()
        .getByRole("radio", { name: "Changes", exact: true })
        .click();
      const failed = section()
        .getByRole("alert")
        .filter({ hasText: "The changes couldn't be loaded." });
      await expect(failed).toBeVisible();
      await failed.getByRole("button", { name: "Retry" }).click();
      await expect(section().locator(".effective-config-hunk")).toHaveCount(2);
    },
  );

  await check(
    "A viewer whose files are missing leaves the rest of the card working",
    async () => {
      await load({ blockViewer: true });
      const alert = section()
        .getByRole("alert")
        .filter({ hasText: "The code viewer couldn't load." });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(
        "Copy and Download still give you the exact text.",
      );
      await expect(viewer()).toHaveCount(0);
      // The drift line, the exact text and the comparison are all still there.
      await expect(section().getByRole("status").first()).toContainText(
        "Running matches what Vectory offered.",
      );
      await section()
        .getByRole("button", {
          name: /^Copy the JSON offered at generation 12/,
        })
        .click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        history().at(-1).content,
      );
      await section()
        .getByRole("radio", { name: "Changes", exact: true })
        .click();
      await expect(section().locator(".effective-config-hunk")).toHaveCount(2);
      expect(errors).toEqual([]);
    },
  );

  await check("Every signed-in role reads it", async () => {
    for (const role of ["viewer", "editor", "operator", "admin"]) {
      await load({ role });
      await shown();
      await expect(viewer()).toContainText('"max_events": 700');
    }
  });

  for (const width of [1440, 390]) {
    await check(
      `A 600 KiB artifact at ${width}px: the page stays responsive and only the lines in view are drawn`,
      async () => {
        const content = large(600 * 1024);
        expect(Buffer.byteLength(content)).toBeGreaterThan(600 * 1024);
        const lines = content.split("\n").length;
        const big = offer(12, 3, content, "2026-09-29T10:00:00Z");
        await load({ width, offers: [history()[2], big] });
        const started = Date.now();
        await shown();
        const ready = Date.now() - started;
        // Virtualised: a few dozen lines are in the page, not thousands.
        const drawn = await section().locator(".cm-line").count();
        expect(drawn).toBeLessThan(250);
        expect(
          await section().locator(".effective-config-measure").innerText(),
        ).toContain(lines.toLocaleString());
        // Scroll to the end: the last component appears and the first leaves.
        // The editor only follows scrolling while it is on screen, and heights
        // are estimated until lines are drawn, so it takes a few passes.
        const last = content
          .match(/"parse_\d{5}"/g)
          .at(-1)
          .slice(1, -1);
        await section().locator(".cm-scroller").scrollIntoViewIfNeeded();
        let passes = 0;
        for (; passes < 60; passes++) {
          await section()
            .locator(".cm-scroller")
            .evaluate((el) => (el.scrollTop = el.scrollHeight));
          await page.waitForTimeout(100);
          if ((await viewer().innerText()).includes(last)) break;
        }
        const where = await section()
          .locator(".cm-scroller")
          .evaluate((el) => ({
            scrollTop: Math.round(el.scrollTop),
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            editorHeight: el.closest(".cm-editor").clientHeight,
            pageY: Math.round(window.scrollY),
            drawn: el.querySelectorAll(".cm-line").length,
            firstDrawn: el.querySelector(".cm-line")?.textContent,
            lastDrawn: [...el.querySelectorAll(".cm-line")]
              .slice(-3)
              .map((line) => line.textContent),
            wrapping: !!el.querySelector(".cm-lineWrapping"),
          }));
        expect(
          passes,
          `the last line (${last}) never came into view ${JSON.stringify(where)}`,
        ).toBeLessThan(60);
        expect(await viewer().innerText()).not.toContain("parse_00000");
        expect(await section().locator(".cm-line").count()).toBeLessThan(250);
        // The page still answers input while the artifact is open: Wrap lines
        // switches over, and the text is still there afterwards.
        const wrapButton = section().getByRole("button", {
          name: "Wrap lines",
          exact: true,
        });
        const wrapped = await wrapButton.getAttribute("aria-pressed");
        const toggleStarted = Date.now();
        await wrapButton.click();
        await expect(wrapButton).toHaveAttribute(
          "aria-pressed",
          wrapped === "true" ? "false" : "true",
        );
        const toggle = Date.now() - toggleStarted;
        await expect(viewer()).toContainText('"inputs"');
        const longTasks = await page.evaluate(() => window.__longTasks);
        const worst = Math.max(0, ...longTasks);
        measurements.push({
          width,
          bytes: Buffer.byteLength(content),
          lines,
          readyMilliseconds: ready,
          toggleMilliseconds: toggle,
          drawnLines: drawn,
          longTasks: longTasks.length,
          worstLongTaskMilliseconds: worst,
        });
        expect(worst, `a ${width}px page blocked for ${worst} ms`).toBeLessThan(
          1500,
        );
        expect(reads().length).toBe(1);
        await noOverflow(`large ${width}`);
      },
    );
  }

  await check(
    "A 600 KiB artifact on one line does not freeze the page",
    async () => {
      const line = `{"source":"${"x".repeat(600 * 1024)}"}\n`;
      const big = offer(12, 3, line, "2026-09-29T10:00:00Z");
      await load({ width: 390, offers: [history()[2], big] });
      const started = Date.now();
      await shown();
      const ready = Date.now() - started;
      await section()
        .getByRole("button", { name: "Wrap lines", exact: true })
        .click();
      await page.waitForTimeout(300);
      const longTasks = await page.evaluate(() => window.__longTasks);
      const worst = Math.max(0, ...longTasks);
      measurements.push({
        width: 390,
        shape: "one line",
        bytes: Buffer.byteLength(line),
        readyMilliseconds: ready,
        worstLongTaskMilliseconds: worst,
      });
      expect(worst, `blocked for ${worst} ms`).toBeLessThan(1500);
      await noOverflow("one line");
    },
  );

  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      await check(
        `Layout, accessibility and screenshots: ${theme} at ${width}px`,
        async () => {
          const name = (state) =>
            `effective-configuration-${state}-${width}-${theme}`;
          await load({
            width,
            theme,
            device: baseDevice({ actual_sha256: history().at(-1).sha256 }),
            variables: [
              {
                name: "max_events",
                path: "/sinks/out/buffer/max_events",
                type: "integer",
                value: 700,
                source: "device",
              },
              {
                name: "interval",
                path: "/sources/in/interval",
                type: "integer",
                value: 5,
                source: "default",
              },
            ],
          });
          await shown();
          await noOverflow(name("matches"));
          await shot(name("matches"));
          await scan(name("matches"));
          await section()
            .getByRole("radio", { name: "Changes", exact: true })
            .click();
          await expect(section().locator(".effective-config-hunk")).toHaveCount(
            2,
          );
          await noOverflow(name("changes"));
          await shot(name("changes"));
          await scan(name("changes"));
          await section()
            .getByRole("radio", { name: /Variables/ })
            .click();
          await expect(
            section().locator(".effective-config-variables li"),
          ).toHaveCount(2);
          await noOverflow(name("variables"));
          await shot(name("variables"));
          await scan(name("variables"));
          // Differs, with the picker on an earlier generation.
          await load({
            width,
            theme,
            device: baseDevice({
              actual_sha256: history()[1].sha256,
              apply_state: "failed",
              status: "failed",
            }),
          });
          await shown();
          await section().getByText("Digests", { exact: true }).click();
          await noOverflow(name("differs"));
          await shot(name("differs"));
          await scan(name("differs"));
          // Nothing offered yet.
          await load({
            width,
            theme,
            offers: [],
            device: baseDevice({
              desired_generation: 0,
              desired_version_id: null,
              desired_version: null,
              status: "unmanaged",
              apply_state: "unmanaged",
              actual_sha256: null,
            }),
          });
          await expect(
            section().getByRole("heading", { name: "Nothing offered yet" }),
          ).toBeVisible();
          await noOverflow(name("empty"));
          await shot(name("empty"));
          await scan(name("empty"));
        },
      );
    }
  }

  expect(unexpected, "unexpected requests").toEqual([]);
  expect(errors, "page errors").toEqual([]);
} finally {
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      { results, measurements, accessibility, screenshots, unexpected, errors },
      null,
      2,
    ),
  );
  if (context) await context.close();
  await browser.close();
  await vite.close();
}
if (!results.length || failures.length) {
  process.exitCode = 1;
  console.error(`FAILED ${failures.length} of ${results.length} checks`);
} else console.log(`PASS ${results.length} checks; screenshots in ${output}`);
