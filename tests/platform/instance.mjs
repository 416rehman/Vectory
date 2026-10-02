// A signed-in client for the loopback instance that scripts/preview.sh or
// packaging/Start-LocalPreview.ps1 starts, and the agent download that
// tests/native-workflow.mjs and the platform checks share. A fresh instance
// gets its first administrator from the preview's one-time bootstrap secret,
// as an operator's first visit does.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root, windows } from "./lib.mjs";

export const previewDir =
  process.env.VECTORY_PREVIEW_DIR || path.join(root, ".local/preview");
export const webPort = process.env.VECTORY_PREVIEW_WEB_PORT || "8080";
export const agentPort = process.env.VECTORY_PREVIEW_AGENT_PORT || "8443";

const readJson = (file) =>
  fs
    .readFile(file, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });

/**
 * Creates the first administrator when the instance is fresh, signs in, and
 * returns the API client: { api, base, cookie, session, credentials,
 * bootstrapped }. `api(endpoint, body?, method?)` returns the parsed JSON and
 * throws on any non-2xx answer.
 */
export async function connect() {
  const base = `http://127.0.0.1:${webPort}/api/v1`;
  const credentialsPath = path.join(previewDir, "credentials.json");
  let credentials = await readJson(credentialsPath);
  const bootstrapped = !(await fetch(`${base}/status`).then((r) => r.json()))
    .initialized;
  if (bootstrapped) {
    credentials ??= {
      name: "Native workflow operator",
      email: "native-workflow@vectory.local",
      password: crypto.randomBytes(24).toString("base64url"),
    };
    await fs.mkdir(previewDir, { recursive: true });
    await fs.writeFile(credentialsPath, JSON.stringify(credentials, null, 2), {
      mode: 0o600,
    });
    const bootstrap_secret = (
      await fs.readFile(path.join(previewDir, "bootstrap.secret"), "utf8")
    ).trim();
    const setup = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...credentials, bootstrap_secret }),
    });
    if (!setup.ok)
      throw Error(`First administrator setup failed: HTTP ${setup.status}`);
    console.log(
      "PASS first administrator created with the one-time bootstrap secret.",
    );
  } else if (!credentials)
    throw Error(
      `This preview is set up but ${credentialsPath} is missing. Use a fresh VECTORY_PREVIEW_DIR.`,
    );
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  });
  if (!login.ok) throw Error(`Login failed ${login.status}`);
  const session = await login.json(),
    cookie = login.headers.get("set-cookie").split(";")[0];
  async function api(endpoint, body, method = body ? "POST" : "GET") {
    const result = await fetch(base + endpoint, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf_token,
        Cookie: cookie,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await result.json();
    if (!result.ok)
      throw Error(`${endpoint}: ${result.status} ${JSON.stringify(value)}`);
    return value;
  }
  return { api, base, cookie, session, credentials, bootstrapped };
}

/**
 * The agent this host would install: its build from the server's release
 * listing, downloaded as a signed-in user and checked against the listed
 * SHA-256 and size before it is run. Saved as <directory>/vectory[.exe].
 */
export async function downloadAgent({ api, cookie, directory }) {
  const os = { linux: "linux", darwin: "darwin", win32: "windows" }[
      process.platform
    ],
    arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  const release = (await api("/releases")).find(
    (r) => r.os === os && r.arch === arch,
  );
  if (!release)
    throw Error(
      `The server lists no agent build for ${os}/${arch}. Build one with python3 packaging/build-release.py, or set VECTORY_AGENT_BIN.`,
    );
  const response = await fetch(`http://127.0.0.1:${webPort}${release.url}`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw Error(`Agent download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()),
    digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256 || bytes.length !== release.size)
    throw Error(
      `${release.name} does not match the release listing: got SHA-256 ${digest} and ${bytes.length} bytes, listed ${release.sha256} and ${release.size} bytes.`,
    );
  const file = path.join(directory, windows ? "vectory.exe" : "vectory");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { mode: 0o755 });
  console.log(
    `PASS downloaded ${release.name} (${release.source} build, version ${release.version}) from the release listing; SHA-256 ${digest} matches.`,
  );
  return {
    file,
    source: {
      kind: "release listing",
      name: release.name,
      version: release.version,
      sha256: digest,
      size: bytes.length,
      origin: release.source,
    },
  };
}

/** Device statuses that say the server hears nothing from the agent. */
const silent = new Set(["offline", "awaiting_first_check_in", "revoked"]);

/**
 * Whether a device row (GET /devices) shows an agent that checked in at or
 * after `sinceMs` (epoch milliseconds; 0 for any check-in) and is not offline.
 */
export function checkedIn(device, sinceMs = 0) {
  return (
    Boolean(device?.last_seen) &&
    !silent.has(device.status) &&
    Date.parse(device.last_seen) >= sinceMs
  );
}
