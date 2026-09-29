import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."),
  require = createRequire(path.join(root, "dashboard/package.json")),
  { chromium, expect } = require("@playwright/test");
const directory = path.join(root, ".local", "fleet-browser-" + Date.now()),
  state = path.join(directory, "state");
await fs.mkdir(directory, { recursive: true });
async function port() {
  return new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}
const webPort = await port(),
  tlsPort = await port(),
  url = `http://127.0.0.1:${webPort}`,
  secret = crypto.randomBytes(32).toString("hex"),
  password = crypto.randomBytes(24).toString("base64url");
await fs.writeFile(path.join(directory, "bootstrap"), secret, { mode: 0o600 });
const binary =
  process.env.VECTORY_SECURITY_SERVER ||
  path.join(root, "server/target/debug/vectory-server.exe");
const env = {
  ...process.env,
  VECTORY_DATA_DIR: state,
  VECTORY_HTTP_ADDR: `127.0.0.1:${webPort}`,
  VECTORY_AGENT_ADDR: `127.0.0.1:${tlsPort}`,
  VECTORY_TLS_CERT: path.join(root, ".local/pki/server.pem"),
  VECTORY_TLS_KEY: path.join(root, ".local/pki/server-key.pem"),
  VECTORY_BOOTSTRAP_SECRET_FILE: path.join(directory, "bootstrap"),
  VECTORY_DEVELOPMENT: "true",
  VECTORY_COOKIE_SECURE: "false",
  VECTORY_DASHBOARD_DIR: path.join(root, "dashboard/dist"),
  VECTORY_RELEASES_DIR: path.join(directory, "releases"),
};
delete env.VECTORY_VALIDATION_URL;
let server, browser;
async function start() {
  server = spawn(binary, [], { env, windowsHide: true, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url + "/api/v1/status")).ok) return;
    } catch {}
    if (server.exitCode !== null) throw Error("Isolated server exited");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Isolated server did not become ready");
}
async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill();
    await exited;
  }
}
try {
  await start();
  await stop();
  const python = spawnSync("python", ["-", path.join(state, "vectory.db")], {
    input: `import sqlite3,json,uuid,sys,datetime\ndb=sqlite3.connect(sys.argv[1])\nfor i in range(1000):\n identifier=str(uuid.uuid4()); name='synthetic-fleet-%05d'%i; now=datetime.datetime.now(datetime.timezone.utc).isoformat(); d={'id':identifier,'name':name,'os':'simulated','arch':'simulated','agent_version':'browser-scale-fixture','vector_version':'0.58.0','last_seen':None,'status':'offline','labels':{'fixture':'browser-scale'},'reported_generation':0,'actual_sha256':None,'apply_state':'unmanaged','sync_paused':False,'pause_acknowledged':False,'telemetry':None,'created_at':now}; db.execute('INSERT INTO devices(id,name,data) VALUES(?,?,?)',(identifier,name,json.dumps(d)))\ndb.commit()\ndb.close()\n`,
    encoding: "utf8",
    windowsHide: true,
  });
  if (python.status !== 0) throw Error(python.stderr);
  await start();
  const auth = await fetch(url + "/api/v1/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bootstrap_secret: secret,
      name: "Scale verification",
      email: "scale@vectory.local",
      password,
    }),
  });
  if (!auth.ok) throw Error("Fixture bootstrap failed");
  const cookie = auth.headers.get("set-cookie").split(";")[0],
    cookieValue = cookie.slice(cookie.indexOf("=") + 1);
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies([
    {
      name: "vectory_session",
      value: cookieValue,
      url,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const startTime = performance.now();
  await page.goto(url + "/#/devices");
  await page.getByRole("heading", { name: "Devices", exact: true }).waitFor();
  await page
    .getByText("1000 enrolled devices. 0 currently online.", { exact: true })
    .waitFor();
  await expect(page.locator(".fleet-table tbody tr")).toHaveCount(12);
  const render = performance.now() - startTime;
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".fleet-device-name").first()).toContainText(
    "synthetic-fleet-00012",
  );
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.locator(".fleet-device-name").first()).toContainText(
    "synthetic-fleet-00000",
  );
  await page
    .getByRole("button", { name: "Filter Connection", exact: true })
    .click();
  await page.getByRole("radio", { name: "Online", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching devices" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Filter Connection (active)", exact: true })
    .click();
  await page.getByRole("radio", { name: "Offline", exact: true }).click();
  await expect(page.locator(".fleet-table tbody tr")).toHaveCount(12);
  await page
    .getByRole("button", { name: "Sort by Pipeline", exact: true })
    .click();
  await expect(page.locator(".fleet-device-name").first()).toContainText(
    "synthetic-fleet-00000",
  );
  const searchTime = performance.now();
  await page
    .getByPlaceholder("Search devices", { exact: true })
    .fill("synthetic-fleet-00999");
  await page
    .getByRole("button", {
      name: "synthetic-fleet-00999 simulated / simulated",
    })
    .waitFor();
  if ((await page.locator("table tbody tr").count()) !== 1)
    throw Error("Search did not narrow real fleet");
  const search = performance.now() - searchTime;
  await page
    .getByLabel("Select synthetic-fleet-00999", { exact: true })
    .check();
  await page.getByRole("button", { name: "Pause sync…", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page
    .getByRole("dialog")
    .getByLabel("Find targets", { exact: true })
    .fill("synthetic-fleet-00999");
  await page
    .getByRole("dialog")
    .getByLabel("Select synthetic-fleet-00999", { exact: true })
    .waitFor();
  if (
    !(await page
      .getByRole("dialog")
      .getByLabel("Select synthetic-fleet-00999", { exact: true })
      .isChecked())
  )
    throw Error("Bulk selected device missing");
  await page
    .getByRole("button", { name: "Review deployment", exact: true })
    .click();
  await page
    .locator(".target-review-table")
    .getByText("synthetic-fleet-00999", { exact: true })
    .waitFor();
  await expect(page.locator(".target-review-table tbody tr")).toHaveCount(1);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "1 device will be targeted" }),
  ).toBeVisible();
  await page.getByLabel("Close dialog").click();
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await page.getByPlaceholder("Search devices", { exact: true }).fill("");
  await expect(page.locator(".fleet-table tbody tr")).toHaveCount(12);
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(
    page.getByPlaceholder("Search devices", { exact: true }),
  ).toBeVisible();
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  if (mobileOverflow) {
    await page.screenshot({
      path: path.join(directory, "mobile-overflow.png"),
      fullPage: true,
    });
    console.error(
      await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter(
            (element) =>
              element.getBoundingClientRect().right > innerWidth + 1 &&
              getComputedStyle(element).position !== "fixed",
          )
          .slice(0, 15)
          .map((element) => ({
            tag: element.tagName,
            class: element.className,
            right: element.getBoundingClientRect().right,
          })),
      ),
    );
    throw Error(
      `Device page overflows the mobile viewport; screenshot: ${directory}`,
    );
  }
  await page.locator(".fleet-device-name").first().click();
  await expect(
    page.getByRole("tab", { name: "Pipeline", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Metrics", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Operational metrics", exact: true }),
  ).toBeVisible();
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw Error("Device details overflow the mobile viewport");
  if (errors.length) throw Error(errors.join("; "));
  const evidence = {
    timestamp: new Date().toISOString(),
    count: 1000,
    initial_render_ms: Math.round(render),
    search_ms: Math.round(search),
    pagination_rows: 12,
    bulk_selection_verified: true,
    filters_verified: true,
    pagination_verified: true,
    mobile_width: 375,
    mobile_document_overflow: mobileOverflow,
    platform: process.platform,
    fixture:
      "Isolated SQLite synthetic offline inventory served by actual Rust API and built dashboard; no production data, API mocking, enrollment or native fleet capacity claim.",
  };
  await fs.writeFile(
    path.join(root, "docs/evidence/fleet-browser.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (browser) await browser.close();
  await stop();
}
