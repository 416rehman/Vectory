import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."),
  require = createRequire(path.join(root, "dashboard/package.json")),
  { chromium } = require("@playwright/test");
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
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const startTime = performance.now();
  await page.goto(url + "/#/devices");
  await page.getByRole("heading", { name: "Devices", exact: true }).waitFor();
  await page.getByText("1000 total devices", { exact: true }).waitFor();
  await page.locator("table tbody tr").nth(11).waitFor();
  const render = performance.now() - startTime;
  const searchTime = performance.now();
  await page
    .getByPlaceholder("Search by name, platform, or label…")
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
  await page.getByRole("button", { name: "Request sync pause" }).click();
  await page.getByRole("dialog").waitFor();
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
  await page.getByRole("button", { name: "Preview assignment" }).click();
  await page
    .locator(".preview-devices")
    .getByText("synthetic-fleet-00999", { exact: true })
    .waitFor();
  await page.getByLabel("Close dialog").click();
  if (errors.length) throw Error(errors.join("; "));
  const evidence = {
    timestamp: new Date().toISOString(),
    count: 1000,
    initial_render_ms: Math.round(render),
    search_ms: Math.round(search),
    pagination_rows: 12,
    bulk_selection_verified: true,
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
