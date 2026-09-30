// The dashboard against a real server holding a seeded 5,000-device fleet.
// Test data only: the fleet is written straight into a disposable database by
// tests/load/fleet-fixture.mjs (nothing enrolls, no agent or Vector runs, and
// "verified_applied" is fixture input). It checks what a person does with a
// fleet this size (page through Devices, search, use the chip counts, select
// everything a search finds, edit a group of thousands, read the Overview) and
// that no request downloads more than one page of devices.
//
// It needs a built dashboard and a built server, so CI's dashboard job does not
// run it. From the repository root:
//
//   (cd dashboard && npm run build)
//   cargo build --manifest-path server/Cargo.toml
//   node dashboard/tests/fleet-scale-browser.mjs
//
// Options: --server <binary> (default server/target/debug/vectory-server, or
// VECTORY_SERVER), --dist <dashboard build> (default dashboard/dist),
// --devices 5000, --groups 500, --port <free port>, --out <report directory>
// (default .local/fleet-scale), --keep (keep the disposable state).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, expect } from "@playwright/test";
import { heartbeat, seedFleet } from "../../tests/load/fleet-fixture.mjs";

const dashboard = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repository = path.resolve(dashboard, "..");
const { values: options } = parseArgs({
  options: {
    server: { type: "string" },
    dist: { type: "string" },
    devices: { type: "string", default: "5000" },
    groups: { type: "string", default: "500" },
    port: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
const executable = path.resolve(
  options.server ||
    process.env.VECTORY_SERVER ||
    path.join(repository, "server/target/debug/vectory-server"),
);
const dist = path.resolve(options.dist || path.join(dashboard, "dist"));
const output = path.resolve(
  options.out || path.join(repository, ".local/fleet-scale"),
);
const deviceCount = Number(options.devices);
const groupCount = Number(options.groups);
for (const [what, file] of [
  ["server binary", executable],
  ["built dashboard", path.join(dist, "index.html")],
])
  await fs.access(file).catch(() => {
    throw Error(`No ${what} at ${file}. See the header of this file.`);
  });
await fs.mkdir(output, { recursive: true });

// What a page of devices may weigh, and the most any one read may weigh: a
// group of 5,000 members is a few hundred kilobytes, the whole fleet is ~10 MB.
const PAGE_ROWS = 100;
const LARGEST_READ = 600_000;
// Generous, so a slow machine passes and a real stall (a scan of the fleet on
// every click) does not: a click or a key press paints within this many ms.
const INPUT_LATENCY_MS = 1000;

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "vectory-scale-"));
await fs.chmod(temporary, 0o700);
const state = path.join(temporary, "state");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toUpperCase().startsWith("VECTORY_"),
  ),
);
const secret = randomBytes(32).toString("hex");
const password = randomBytes(24).toString("base64url");
const email = "fleet-scale@example.test";
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
const port = options.port ? Number(options.port) : await freePort();
const origin = `http://127.0.0.1:${port}`;

let child = null;
const cleanup = () => child?.kill("SIGKILL");
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
async function startServer() {
  child = spawn(executable, [], {
    cwd: temporary,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...environment,
      VECTORY_DEVELOPMENT: "true",
      VECTORY_COOKIE_SECURE: "false",
      VECTORY_HTTP_ADDR: `127.0.0.1:${port}`,
      VECTORY_DATA_DIR: state,
      VECTORY_DASHBOARD_DIR: dist,
      VECTORY_BOOTSTRAP_SECRET: secret,
      RUST_LOG: "vectory_server=warn",
      NO_COLOR: "1",
    },
  });
  let log = "";
  const collect = (data) => (log = (log + data).slice(-65536));
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null)
      throw Error(`The server exited during startup:\n${log}`);
    try {
      if (
        (
          await fetch(`${origin}/api/v1/status`, {
            signal: AbortSignal.timeout(2000),
          })
        ).ok
      )
        return;
    } catch {
      /* Not listening yet. */
    }
    if (attempt > 600) throw Error("The server did not start");
    await delay(100);
  }
}
async function stopServer() {
  if (!child) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGINT");
    await Promise.race([closed, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
  child = null;
}

const requests = [];
const scenarios = [];
const latencies = {};
const errors = [];
let browser,
  failure,
  keepAlive,
  fixture,
  seededIn = 0;
try {
  // Initialize a database through the API, seed the fleet with the server
  // stopped, then serve it.
  await startServer();
  const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bootstrap_secret: secret,
      name: "Fleet scale",
      email,
      password,
    }),
  });
  assert.equal(bootstrap.status, 200, "bootstrap");
  const actor = (await bootstrap.json()).user.id;
  await stopServer();
  const seeding = Date.now();
  fixture = seedFleet(path.join(state, "vectory.db"), {
    devices: deviceCount,
    groups: groupCount,
    actor,
  });
  seededIn = Date.now() - seeding;
  console.log("Seeded", fixture, `in ${seededIn} ms`);
  heartbeat(path.join(state, "vectory.db"));
  // The fixture's reporting devices are only fresh for a few minutes.
  keepAlive = setInterval(() => {
    try {
      heartbeat(path.join(state, "vectory.db"));
    } catch {
      /* A busy database skips one stamp. */
    }
  }, 45000);
  await startServer();
  await delay(3000);

  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const login = await context.request.post(`${origin}/api/v1/login`, {
    data: { email, password },
  });
  assert.equal(login.status(), 200, "sign in");
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));

  // Every response the dashboard reads: its size and where it came from.
  const pending = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/v1/")) return;
    const record = {
      method: response.request().method(),
      path: url.pathname.slice("/api/v1".length),
      query: url.search,
      status: response.status(),
      bytes: 0,
      items: null,
    };
    requests.push(record);
    pending.push(
      response
        .body()
        .then((body) => {
          record.bytes = body.length;
          if (record.path === "/devices/inventory") {
            try {
              record.items = JSON.parse(body.toString("utf8")).items.length;
            } catch {
              /* Not a page. */
            }
          }
        })
        .catch(() => {
          record.bytes = Number(response.headers()["content-length"] || 0);
        }),
    );
  });
  const settle = () => Promise.allSettled(pending.splice(0));
  const truth = async (route) =>
    (await context.request.get(`${origin}/api/v1${route}`)).json();
  const table = (name) => page.getByRole("table", { name, exact: true });
  const rows = (name) => table(name).locator("tbody tr");
  const number = (text) => Number(text.replace(/[^\d]/g, ""));

  /**
   * How long a click or key press takes to paint, measured in the page from
   * the input to the frame that shows its result. The page's policy forbids
   * evaluating strings, so the inputs and results are named here.
   */
  const paint = (action, done, text = "") =>
    page.evaluate(
      async ({ action, done, text }) => {
        const dialog = () => document.querySelector('[role="dialog"]');
        const button = (label) =>
          [...dialog().querySelectorAll("button")].find(
            (item) => item.textContent.trim() === label,
          );
        const changes = () => document.querySelector(".group-changes");
        const search = () =>
          dialog().querySelector('input[placeholder="Find a device"]');
        const actions = {
          "toggle the first device": () =>
            dialog().querySelector('tbody input[type="checkbox"]').click(),
          "type a key": () => {
            Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value",
            ).set.call(search(), text);
            search().dispatchEvent(new Event("input", { bubbles: true }));
          },
          "remove all": () => button("Remove all").click(),
          "undo device changes": () => button("Undo device changes").click(),
        };
        const results = {
          "one removed": () => !!changes()?.textContent.includes(" 1 removed"),
          "nothing changed": () => !changes(),
          "the key shows": () => search().value === text,
          "all removed": () => !!changes()?.textContent.includes(text),
        };
        const started = performance.now();
        actions[action]();
        await new Promise((resolve) => {
          const look = () =>
            results[done]() ? resolve() : requestAnimationFrame(look);
          look();
        });
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return performance.now() - started;
      },
      { action, done, text },
    );

  async function scenario(name, run) {
    await settle();
    const from = requests.length;
    const started = Date.now();
    await run();
    await settle();
    const mine = requests.slice(from);
    const entry = {
      name,
      milliseconds: Date.now() - started,
      requests: mine.length,
      bytes: mine.reduce((sum, r) => sum + r.bytes, 0),
      largest: Math.max(0, ...mine.map((r) => r.bytes)),
    };
    scenarios.push(entry);
    console.log(
      "PASS",
      name,
      `(${entry.milliseconds} ms, ${entry.requests} requests, ${entry.bytes.toLocaleString()} B, largest ${entry.largest.toLocaleString()} B)`,
    );
  }

  // ---- Devices: the first page, the chips, search, select all matching ----
  const inventory = await truth("/devices/inventory?page_size=1");
  assert.ok(
    inventory.total >= deviceCount * 0.9,
    "the fleet is seeded (revoked devices are hidden)",
  );
  await scenario(
    "Devices opens on one page and its counts are the server's",
    async () => {
      await page.goto(`${origin}/#/devices`);
      await expect(rows("Devices")).toHaveCount(25);
      await expect(
        page.getByText(`${inventory.total.toLocaleString()} devices`, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText(`1–25 of ${inventory.total.toLocaleString()}`, {
          exact: true,
        }),
      ).toBeVisible();
      // Chip counts come from the server, whatever the page shows.
      const offline = page.getByRole("button", { name: /^Offline\s*[\d,]+$/ });
      expect(number(await offline.innerText())).toBe(
        inventory.counts.views.offline,
      );
      const failing = page.getByRole("button", { name: /^Failing\s*[\d,]+$/ });
      expect(number(await failing.innerText())).toBe(
        inventory.counts.views.failing,
      );
      await offline.click();
      await expect(offline).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByText(
          `${inventory.counts.views.offline.toLocaleString()} matching`,
          { exact: true },
        ),
      ).toBeVisible();
      await offline.click();
      await expect(offline).toHaveAttribute("aria-pressed", "false");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(rows("Devices")).toHaveCount(25);
      await expect(
        page.getByText(`26–50 of ${inventory.total.toLocaleString()}`, {
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(output, "devices-1280.png"),
        animations: "disabled",
      });
    },
  );
  await scenario(
    "Typing a search asks the server once, after the typing settles",
    async () => {
      await page.goto(`${origin}/#/devices`);
      await expect(rows("Devices")).toHaveCount(25);
      const found = await truth("/devices/inventory?q=web-001&page_size=100");
      assert.ok(found.total > 0 && found.total <= 25, "the search is narrow");
      const before = requests.length;
      const box = page.getByRole("textbox", {
        name: "Search devices",
        exact: true,
      });
      await box.click();
      await box.pressSequentially("web-001", { delay: 25 });
      const typed = Date.now();
      await expect(rows("Devices")).toHaveCount(found.total);
      latencies.search_to_rows_ms = Date.now() - typed;
      await expect(
        page.getByText(`${found.total.toLocaleString()} matching`, {
          exact: true,
        }),
      ).toBeVisible();
      await settle();
      const reads = requests
        .slice(before)
        .filter((r) => r.path === "/devices/inventory");
      assert.ok(
        reads.length <= 2,
        `typing seven characters read the inventory ${reads.length} times`,
      );
      assert.ok(
        reads.every((r) => /[?&]q=/.test(r.query) || r.query === ""),
        "a read for a search carries it",
      );
      assert.ok(
        latencies.search_to_rows_ms < 5000,
        `a search took ${latencies.search_to_rows_ms} ms to show`,
      );
    },
  );
  await scenario(
    "Select all matching picks every device a search finds and the deploy dialog opens on it",
    async () => {
      await page.goto(`${origin}/#/devices?q=k8s-node`);
      const found = await truth("/devices/inventory?q=k8s-node&page_size=100");
      assert.ok(found.total > 25 && found.total <= 10000);
      await expect(
        page.getByText(`${found.total.toLocaleString()} matching`, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(rows("Devices")).toHaveCount(25);
      await page.getByLabel("Select visible devices", { exact: true }).check();
      await expect(
        page.getByText("25 selected", { exact: true }),
      ).toBeVisible();
      const selecting = Date.now();
      await page
        .getByRole("button", {
          name: `Select all ${found.total.toLocaleString()} matching`,
          exact: true,
        })
        .click();
      await expect(
        page.getByText(`${found.total.toLocaleString()} selected`, {
          exact: true,
        }),
      ).toBeVisible();
      latencies.select_all_matching_ms = Date.now() - selecting;
      await expect(
        page.getByText(
          `Selected all ${found.total.toLocaleString()} matching devices.`,
          { exact: true },
        ),
      ).toBeVisible();
      const opening = Date.now();
      await page
        .getByRole("button", { name: "Pause sync…", exact: true })
        .click();
      await expect(
        page
          .getByRole("dialog")
          .getByText(`${found.total.toLocaleString()} devices selected`),
      ).toBeVisible();
      latencies.deploy_dialog_open_ms = Date.now() - opening;
      // The dialog lists 25 devices and reads at most 25 by name.
      await expect(page.getByRole("dialog").locator("tbody tr")).toHaveCount(
        25,
      );
      await page.screenshot({
        path: path.join(output, "deploy-dialog-1280.png"),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    },
  );

  // ---- A group of thousands, edited without a stall ----
  const groups = await truth("/groups?slim=1");
  const large = groups.find((group) => group.name === "All servers");
  assert.ok(large && large.member_count >= deviceCount * 0.9);
  await scenario(
    `A group of ${large.member_count.toLocaleString()} devices edits without a stall`,
    async () => {
      await page.goto(`${origin}/#/groups?q=${encodeURIComponent(large.name)}`);
      await page.getByRole("button", { name: large.name, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const opening = Date.now();
      await dialog
        .getByRole("tab", { name: "Edit members", exact: true })
        .click();
      await expect(rows("Group devices")).toHaveCount(25);
      latencies.group_editor_open_ms = Date.now() - opening;
      await expect(
        dialog.getByText(`${large.member_count.toLocaleString()} selected`, {
          exact: true,
        }),
      ).toBeVisible();
      const members = large.member_count.toLocaleString();
      // One click on one device: the change is counted and painted.
      latencies.group_toggle_ms = await paint(
        "toggle the first device",
        "one removed",
      );
      await expect(dialog.locator(".group-changes")).toContainText(
        "0 added · 1 removed since it was saved",
      );
      // And back: nothing differs from the saved group again.
      latencies.group_untoggle_ms = await paint(
        "toggle the first device",
        "nothing changed",
      );
      // A key press in the search box.
      latencies.group_keystroke_ms = await paint(
        "type a key",
        "the key shows",
        "w",
      );
      await dialog.getByPlaceholder("Find a device").fill("");
      // Everything out, counted against the saved group, then undone.
      latencies.group_remove_all_ms = await paint(
        "remove all",
        "all removed",
        `${members} removed`,
      );
      await expect(dialog.locator(".group-changes")).toContainText(
        `0 added · ${members} removed since it was saved`,
      );
      latencies.group_undo_ms = await paint(
        "undo device changes",
        "nothing changed",
      );
      await expect(
        dialog.getByText(`${members} selected`, { exact: true }),
      ).toBeVisible();
      // Search the picker and take everything a search finds.
      await dialog.getByPlaceholder("Find a device").fill("cache-00");
      await expect(rows("Group devices").first()).toContainText("cache-00");
      await dialog
        .getByRole("button", { name: "Remove all", exact: true })
        .click();
      const matching = dialog.getByRole("button", {
        name: /^Select all [\d,]+ matching$/,
      });
      await expect(matching).toBeVisible();
      const count = number(await matching.innerText());
      await matching.click();
      await expect(
        dialog.getByText(`${count.toLocaleString()} selected`, { exact: true }),
      ).toBeVisible();
      await expect(dialog.locator(".group-changes")).toContainText(
        `removed since it was saved`,
      );
      await page.screenshot({
        path: path.join(output, "group-editor-1280.png"),
        animations: "disabled",
      });
      for (const [name, ms] of Object.entries(latencies))
        if (name.startsWith("group_") && name !== "group_editor_open_ms")
          assert.ok(
            ms < INPUT_LATENCY_MS,
            `${name} took ${Math.round(ms)} ms with ${large.member_count.toLocaleString()} members`,
          );
      // Leave without saving: the saved group is untouched.
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    },
  );

  // ---- The Overview reads numbers and says what runs where ----
  const overview = await truth("/overview?slim=1");
  await scenario(
    "The Overview reads the slim response and says what runs where",
    async () => {
      await page.goto(`${origin}/#/overview`);
      await expect(page.locator(".overview-kpi-tile")).toHaveCount(4);
      const tile = page.locator(".overview-kpi-tile").first();
      await expect(tile.locator(".overview-kpi-value")).toContainText(
        `/ ${overview.counts.total.toLocaleString()}`,
      );
      const card = page.locator(".running-now");
      await expect(card).toBeVisible();
      assert.ok(overview.running.length > 0, "the fleet runs pipelines");
      const versions = card.locator(".overview-running-item");
      await expect(versions).not.toHaveCount(0);
      // Each row leads to the devices that run that version.
      const link = versions
        .first()
        .getByRole("link", { name: /^[\d,]+ devices?$/ });
      await expect(link).toHaveAttribute(
        "href",
        /^#\/devices\?running=[0-9a-f-]{36}$/,
      );
      await expect(
        versions.first().locator(".overview-running-rate"),
      ).toHaveText(/→|\/s|No metrics yet/);
      latencies.overview_running_now_rows = await versions.count();
      await expect(page.locator(".needs-you")).toBeVisible();
      await page.screenshot({
        path: path.join(output, "overview-1280.png"),
        fullPage: true,
        animations: "disabled",
      });
    },
  );

  // ---- What crossed the wire ----
  await settle();
  const inventoryReads = requests.filter(
    (r) => r.path === "/devices/inventory",
  );
  assert.ok(inventoryReads.length > 0);
  assert.deepEqual(
    requests.filter(
      (r) =>
        r.method === "GET" &&
        ["/devices", "/groups"].includes(r.path) &&
        !/slim=1/.test(r.query),
    ),
    [],
    "no read lists every device or every group with its members",
  );
  assert.ok(
    requests
      .filter((r) => r.path === "/overview")
      .every((r) => /slim=1/.test(r.query)),
    "the Overview always reads the slim response",
  );
  assert.ok(
    inventoryReads.every((r) => r.items === null || r.items <= PAGE_ROWS),
    "no inventory read returns more than a page",
  );
  const largest = requests.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  assert.ok(
    largest.bytes <= LARGEST_READ,
    `the largest read was ${largest.path}${largest.query} at ${largest.bytes.toLocaleString()} bytes`,
  );
  assert.deepEqual(errors, [], "no page errors");
  console.log(
    "Largest read:",
    `${largest.path}${largest.query}`,
    `${largest.bytes.toLocaleString()} B;`,
    "inventory pages:",
    inventoryReads.length,
    "of at most",
    Math.max(...inventoryReads.map((r) => r.items ?? 0)),
    "rows each",
  );
  console.log("Latencies (ms):", JSON.stringify(latencies));
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  clearInterval(keepAlive);
  await browser?.close().catch(() => {});
  await stopServer().catch(() => {});
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Real server and dashboard build on loopback with a synthetic fleet seeded straight into a disposable database (tests/load/fleet-fixture.mjs). No enrollment, agent or Vector process; verified_applied is fixture input. Debug builds on a shared host: the latencies are a regression bound, not a capacity claim.",
        passed: !failure,
        host: {
          platform: process.platform,
          release: os.release(),
          cpus: os.cpus().length,
          node: process.version,
        },
        fixture: fixture && { ...fixture, seed_ms: seededIn },
        limits: {
          page_rows: PAGE_ROWS,
          largest_read_bytes: LARGEST_READ,
          input_latency_ms: INPUT_LATENCY_MS,
        },
        scenarios,
        latencies,
        requests,
        errors,
        ...(failure ? { failure: failure.message } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  if (!options.keep)
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  else console.log("Kept", temporary);
  console.log(
    "Evidence:",
    path.relative(repository, path.join(output, "report.json")),
  );
}
if (failure) process.exitCode = 1;
