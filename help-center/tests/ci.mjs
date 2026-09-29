// Runs real help acceptance against a disposable local server, never a preview instance.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(root, "dashboard/package.json"));
const { request } = require("@playwright/test");
const binary = path.resolve(
  process.env.VECTORY_HELP_SERVER ||
    path.join(
      root,
      "server/target/debug",
      process.platform === "win32" ? "vectory-server.exe" : "vectory-server",
    ),
);
const output = path.resolve(
  process.env.VECTORY_HELP_CI_OUTPUT || path.join(root, "artifacts/help-ci"),
);
const includeAccounts = process.env.VECTORY_HELP_ACCOUNT_TESTS === "true";
await fs.access(binary);
await fs.access(path.join(root, "dashboard/dist/help/help-manifest.json"));
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "vectory-help-ci-"));
await fs.chmod(temporary, 0o700);
const data = path.join(temporary, "data");
const storage = path.join(data, "browser-auth.json");
// VECTORY_HELP_CI_PORT pins the port, for example to stay inside a port range
// shared with other local runs; otherwise the system picks a free one.
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(
    Number(process.env.VECTORY_HELP_CI_PORT) || 0,
    "127.0.0.1",
    resolve,
  );
});
const port = reservation.address().port;
await new Promise((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
const bootstrap = randomBytes(32).toString("hex");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.toUpperCase().startsWith("VECTORY_"),
  ),
);
const server = spawn(binary, [], {
  cwd: temporary,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...environment,
    VECTORY_DEVELOPMENT: "true",
    VECTORY_COOKIE_SECURE: "false",
    VECTORY_HTTP_ADDR: `127.0.0.1:${port}`,
    VECTORY_DATA_DIR: data,
    VECTORY_DASHBOARD_DIR: path.join(root, "dashboard/dist"),
    VECTORY_RELEASES_DIR: path.join(temporary, "releases"),
    VECTORY_BOOTSTRAP_SECRET: bootstrap,
    VECTORY_INSTANCE_NAME: "Isolated help acceptance",
    RUST_LOG: "vectory_server=info,tower_http=warn",
    NO_COLOR: "1",
  },
});
let log = "",
  spawnError;
const capture = (chunk) => {
  log = (log + chunk.toString()).slice(-65536);
};
server.stdout.on("data", capture);
server.stderr.on("data", capture);
server.on("error", (error) => {
  spawnError = error;
});
const closed = new Promise((resolve) => server.once("close", resolve));
let activeCheck;
const interrupt = () => {
  activeCheck?.kill("SIGTERM");
  server.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const childEnvironment = {
  ...environment,
  VECTORY_HELP_URL: origin,
  VECTORY_UI_URL: origin,
  VECTORY_HELP_STORAGE_STATE: storage,
  VECTORY_HELP_TEST_OUTPUT: output,
  VECTORY_HELP_EVIDENCE: path.join(output, "public-help.json"),
  VECTORY_HELP_ARTIFACTS: path.join(output, "public-artifacts"),
  VECTORY_HELP_POLISH_EVIDENCE: path.join(output, "public-polish.json"),
  VECTORY_HELP_POLISH_ARTIFACTS: path.join(output, "polish-artifacts"),
  VECTORY_HELP_ACCOUNT_TESTS: String(includeAccounts),
};
const report = {
  started_at: new Date().toISOString(),
  server: binary,
  server_sha256: createHash("sha256")
    .update(await fs.readFile(binary))
    .digest("hex"),
  dashboard_index_sha256: createHash("sha256")
    .update(await fs.readFile(path.join(root, "dashboard/dist/index.html")))
    .digest("hex"),
  origin,
  scope:
    "Disposable loopback development server, real built help and dashboard, fresh synthetic account; no agent listener or real fleet",
  public_help: false,
  public_polish: false,
  contextual_help: false,
  ...(includeAccounts ? { account_lifecycle: false } : {}),
};
async function run(args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: childEnvironment,
    windowsHide: true,
    stdio: "inherit",
  });
  activeCheck = child;
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  activeCheck = undefined;
  assert.equal(code, 0, `Help check failed: ${path.basename(args[0])}`);
}
try {
  const deadline = Date.now() + 30000;
  while (!log.includes("dashboard listener ready")) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null)
      throw new Error("Isolated help server exited before listening");
    if (Date.now() >= deadline)
      throw new Error("Isolated help server did not start within 30 seconds");
    await delay(100);
  }
  const api = await request.newContext({ baseURL: origin });
  try {
    const status = await api.get("/api/v1/status");
    assert(status.ok());
    assert.equal(
      (await status.json()).initialized,
      false,
      "Fixture must start with an empty private database",
    );
    const response = await api.post("/api/v1/bootstrap", {
      data: {
        bootstrap_secret: bootstrap,
        name: "Synthetic help reviewer",
        email: "help-ci@example.test",
        password: randomBytes(32).toString("hex"),
      },
    });
    assert(
      response.ok(),
      `Fixture bootstrap failed: HTTP ${response.status()}`,
    );
    // The server has already protected its state directory; store only this test's session there.
    await api.storageState({ path: storage });
    await fs.chmod(storage, 0o600);
  } finally {
    await api.dispose();
  }
  await run([path.join(root, "help-center/tests/browser.mjs")]);
  report.public_help = true;
  await run([path.join(root, "help-center/tests/polish.mjs")]);
  report.public_polish = true;
  const cli = path.join(
    path.dirname(require.resolve("@playwright/test/package.json")),
    "cli.js",
  );
  await run([
    cli,
    "test",
    "--config",
    path.join(root, "help-center/playwright.config.ts"),
  ]);
  report.contextual_help = true;
  if (includeAccounts) report.account_lifecycle = true;
} finally {
  if (server.exitCode === null && !spawnError) server.kill("SIGTERM");
  await Promise.race([closed, delay(5000)]);
  if (server.exitCode === null && server.signalCode === null && !spawnError) {
    server.kill("SIGKILL");
    await closed;
  }
  await fs.writeFile(path.join(output, "server.log"), log);
  // Never recursively remove a computed path outside the specific temporary fixture.
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith("vectory-help-ci-"));
  await fs.rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  report.finished_at = new Date().toISOString();
  report.fixture_removed = true;
  await fs.writeFile(
    path.join(output, "summary.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
console.log(
  `Isolated public and contextual help${includeAccounts ? " and account lifecycle" : ""} checks passed; temporary identity/state removed.`,
);
