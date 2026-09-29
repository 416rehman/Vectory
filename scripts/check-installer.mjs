#!/usr/bin/env node
// The Add device install path against a live server, as a person copying the
// command runs it: the installer from the agent listener over verified TLS,
// checked against the SHA-256 the dashboard shows, a dry run, then the real
// run with a one-use token and --service none (no service, no root). The
// installer downloads the agent and checks it itself; this script then checks
// the installed agent against the release listing and that the device checked
// in. Linux and macOS (the installer is a POSIX sh script).
//
//   VECTORY_URL                    dashboard address: http://127.0.0.1:8080, https://vectory.example.com
//   VECTORY_CA_FILE                CA certificate (PEM) the server's certificates chain to
//   VECTORY_CREDENTIALS            JSON file with an administrator's email and password
//   VECTORY_BOOTSTRAP_SECRET_FILE  optional: on an empty instance, create the first
//                                  administrator and save its credentials there
//   VECTORY_VECTOR_BIN             the Vector 0.58 binary the device adopts
//
//   node scripts/check-installer.mjs [--output DIR]
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const output = path.resolve(
  argv.includes("--output")
    ? argv[argv.indexOf("--output") + 1]
    : "artifacts/installer-check",
);
const required = (name) => {
  if (!process.env[name]) throw Error(`Set ${name}.`);
  return process.env[name];
};
const base = new URL("/api/v1/", required("VECTORY_URL"));
const ca = await fs.readFile(required("VECTORY_CA_FILE"));
const credentialsPath = required("VECTORY_CREDENTIALS");
const vector = required("VECTORY_VECTOR_BIN");
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
if (!["linux", "darwin"].includes(process.platform))
  throw Error(
    "The installer is a POSIX sh script: run this check on Linux or macOS.",
  );

// One HTTP(S) request that trusts only the given CA; the body is kept as bytes.
function request(url, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(url, base);
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method,
        ca,
        timeout: 60000,
        headers: body
          ? { "Content-Type": "application/json", ...headers }
          : headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("timeout", () =>
      req.destroy(Error(`${method} ${target} timed out`)),
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const json = (response, what) => {
  const text = response.body.toString("utf8");
  if (response.status < 200 || response.status > 299)
    throw Error(`${what}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

const status = json(await request("status"), "Status");
let credentials = await fs
  .readFile(credentialsPath, "utf8")
  .then(JSON.parse)
  .catch(() => null);
if (!status.initialized) {
  const secretFile = required("VECTORY_BOOTSTRAP_SECRET_FILE");
  credentials ??= {
    name: "Installer check",
    email: "installer-check@vectory.local",
    password: crypto.randomBytes(24).toString("base64url"),
  };
  await fs.writeFile(credentialsPath, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
  const bootstrap_secret = (await fs.readFile(secretFile, "utf8")).trim();
  json(
    await request("bootstrap", {
      method: "POST",
      body: { ...credentials, bootstrap_secret },
    }),
    "First administrator",
  );
  console.log(
    "PASS first administrator created with the one-time bootstrap secret.",
  );
}
if (!credentials)
  throw Error(
    `${credentialsPath} is missing and the instance is already set up.`,
  );
const login = await request("login", {
  method: "POST",
  body: { email: credentials.email, password: credentials.password },
});
const session = json(login, "Sign-in");
if (session.mfa_required)
  throw Error(
    "The administrator uses two-factor sign-in; use a fresh instance.",
  );
const cookie = [login.headers["set-cookie"] ?? []]
  .flat()
  .map((c) => c.split(";")[0])
  .join("; ");
const api = async (endpoint, body) =>
  json(
    await request(endpoint, {
      method: body ? "POST" : "GET",
      headers: { Cookie: cookie, "X-CSRF-Token": session.csrf_token },
      body,
    }),
    endpoint,
  );

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, text }));
  });
}

const runId = Date.now().toString(36);
const name = `installer-check-${runId}`;
const work = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-installer-check-"),
);
try {
  const details = await api("agent-install");
  if (!details.downloads_enabled || !details.installer)
    throw Error(
      "The server offers no installer (agent downloads are off or no agent build is listed).",
    );
  const installer = await request(details.installer.url);
  if (installer.status !== 200)
    throw Error(`Installer download: HTTP ${installer.status}`);
  if (sha256(installer.body) !== details.installer.sha256)
    throw Error(
      `The installer's SHA-256 ${sha256(installer.body)} is not the ${details.installer.sha256} the dashboard shows.`,
    );
  console.log(
    `PASS installer from ${details.installer.url} over verified TLS matches the SHA-256 the dashboard shows.`,
  );
  const script = path.join(work, "vectory-install.sh");
  await fs.writeFile(script, installer.body);
  const host = path.join(work, "host");
  const args = [
    script,
    "--install-dir",
    path.join(host, "bin"),
    "--state-dir",
    path.join(host, "state"),
    "--managed-config",
    path.join(host, "managed", "vector.json"),
    "--vector-binary",
    vector,
    "--service",
    "none",
    "--name",
    name,
  ];
  const dry = await run("sh", [...args, "--dry-run"]);
  console.log(dry.text.trimEnd());
  if (dry.code !== 0)
    throw Error(`The installer's dry run exited ${dry.code}.`);
  await fs.access(path.join(host, "state")).then(
    () => {
      throw Error("The dry run created the state directory.");
    },
    () => {},
  );
  console.log("PASS dry run: every check passed and nothing changed.");

  const token = await api("tokens", {
    name: `Installer check ${runId}`,
    expires_hours: 1,
    max_uses: 1,
  });
  const tokenFile = path.join(work, "token");
  await fs.writeFile(tokenFile, token.token + "\n", { mode: 0o600 });
  const real = await run("sh", [...args, "--token-file", tokenFile]);
  console.log(real.text.trimEnd());
  if (real.code !== 0) throw Error(`The installer exited ${real.code}.`);

  const platform = { linux: "linux", darwin: "darwin" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  const release = (await api("releases")).find(
    (r) => r.os === platform && r.arch === arch,
  );
  const agent = path.join(host, "bin", "vectory");
  const bytes = await fs.readFile(agent);
  if (!release || sha256(bytes) !== release.sha256)
    throw Error(
      `The installed agent (SHA-256 ${sha256(bytes)}) is not the listed ${platform}/${arch} build.`,
    );
  if (((await fs.stat(agent)).mode & 0o777) !== 0o755)
    throw Error("The installed agent is not mode 0755.");
  const local = await run(agent, [
    "status",
    "--state-dir",
    path.join(host, "state"),
    "--json",
  ]);
  if (local.code !== 0)
    throw Error(`vectory status exited ${local.code}: ${local.text}`);
  JSON.parse(local.text);
  const device = (await api("devices")).find((d) => d.name === name);
  if (!device?.last_seen)
    throw Error(
      `${name} is not listed with a check-in: ${JSON.stringify(device ?? null)}`,
    );
  console.log(
    `PASS installed ${release.name} (SHA-256 ${release.sha256}), enrolled ${name} and checked in at ${device.last_seen}.`,
  );
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(output, "installer-check.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        result: "passed",
        server: base.origin,
        agent_url: details.agent_url,
        ca_sha256: details.certificate?.ca_sha256 ?? null,
        installer: details.installer,
        agent: {
          name: release.name,
          version: release.version,
          sha256: release.sha256,
          source: release.source,
        },
        device: {
          id: device.id,
          name,
          status: device.status,
          last_seen: device.last_seen,
          service_manager: device.service_manager ?? null,
        },
        checks: [
          "installer fetched from the agent listener over TLS verified against the given CA",
          "installer SHA-256 equals the value the dashboard shows",
          "dry run passes every check and changes nothing",
          "installer downloads the agent and verifies its SHA-256, then vectory setup installs and enrolls with a one-use token (--service none)",
          "installed agent equals the release listing entry, mode 0755",
          "the device is listed with a check-in",
        ],
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  // The work folder holds the device's private key and the token.
  await fs.rm(work, { recursive: true, force: true });
}
