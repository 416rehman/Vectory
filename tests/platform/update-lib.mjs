// What the agent-update checks (agent-update.mjs) need that doesn't depend on the
// operating system: the agents they build from copies of the source, the operator
// mirror the server reads builds from, the checksum file a release is signed
// against, and the text `vectory release keygen` prints. Nothing here talks to a
// service manager; update-hosts.mjs does.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { root, run, sha256File } from "./lib.mjs";

/**
 * The builds the checks need, by version. Every one is the product's source with
 * its version constant changed in a copy; two have one more line changed in the
 * copy, never a hook in the product:
 *
 *   0.1.2  the agent's run panics first (runWith, which every way of running the
 *          agent goes through: the unit's `vectory run`, the Windows service). `version
 *          --json` still answers, so the privileged step's probe passes and the build
 *          is swapped in; the service then dies at every start, which the manager
 *          restarts until the step gives up (START_FAILED). A build whose main exits
 *          first would fail the probe (PROBE_FAILED), before anything is stopped.
 *   0.1.3  the heartbeat goes to a path the server doesn't have: the service starts
 *          and runs, and never checks in (NO_CHECK_IN).
 *
 * On Windows every build, the first included, has one more word changed in its
 * copy: the release gate of the Windows step (windowsUpdatesInRelease, in
 * update_gate.go) is open. The
 * gate is closed in the product until the proof these builds are for is green at the
 * cut, so the proof opens it in the copy and the product opens it in the commit
 * that cites the green run: the step that is proven is the step that ships.
 */
export const BUILDS = [
  { version: "0.1.0", kind: "source", what: "the source as it is" },
  { version: "0.1.1", kind: "good", what: "a good update" },
  { version: "0.1.2", kind: "crash", what: "panics at the start of every run" },
  {
    version: "0.1.3",
    kind: "silent",
    what: "checks in at a path the server doesn't have",
  },
  {
    version: "0.1.4",
    kind: "good",
    what: "a good build whose store file is cut short",
  },
  {
    version: "0.1.5",
    kind: "good",
    what: "a good build the step is killed in while it swaps",
  },
  {
    version: "0.1.6",
    kind: "good",
    what: "a good build the step is killed in during its trial",
  },
  {
    version: "0.1.7",
    kind: "good",
    what: "a good build refused for lack of room",
  },
];

/**
 * Replaces `from` with `to` in `text`, which must hold it exactly once. A copy
 * whose edit finds nothing, or finds it twice, is a change to the product's
 * source that these checks must not guess their way through.
 */
export function replaceOnce(text, from, to, what) {
  const first = text.indexOf(from);
  if (first < 0 || text.indexOf(from, first + from.length) >= 0)
    throw new Error(
      `${what}: expected exactly one ${JSON.stringify(from)} in the source, and found ${first < 0 ? "none" : "more than one"}.`,
    );
  return text.slice(0, first) + to + text.slice(first + from.length);
}

export const SOURCE = {
  version: "agent/internal/agent/types.go",
  reconcile: "agent/internal/agent/reconcile.go",
  updateGate: "agent/internal/agent/update_gate.go",
};

export function setVersion(source, version) {
  return replaceOnce(
    source,
    'const Version = "0.1.0"',
    `const Version = "${version}"`,
    "The agent's version constant",
  );
}

const RUN_WITH =
  "func runWith(ctx context.Context, dir string, options runOptions, report func(string)) error {\n";

/**
 * The agent's run panics before it does anything. runWith is where every way of
 * running the agent goes: Run (the unit's `vectory run`), RunContinuous and
 * RunWindowsService; `vectory version --json`, which the step's probe runs, never
 * reaches it.
 */
export function crashAtRun(source) {
  return replaceOnce(
    source,
    RUN_WITH,
    `${RUN_WITH}\tpanic("this build is broken on purpose")\n`,
    "agent.runWith",
  );
}

/**
 * Opens the release gate of the Windows step in a copy of the source: the line of the
 * table in update_gate.go that says Windows is not shipped. A source whose gate is
 * already open is left as it is, so that the proof still builds after the product
 * opens it.
 */
export function openWindowsGate(source) {
  if (source.includes("\twindowsUpdatesInRelease = true\n")) return source;
  return replaceOnce(
    source,
    "\twindowsUpdatesInRelease = false\n",
    "\twindowsUpdatesInRelease = true\n",
    "The Windows release gate",
  );
}

export function moveHeartbeat(source) {
  return replaceOnce(
    source,
    '"POST", "/agent/v1/heartbeat", h)',
    '"POST", "/agent/v1/heartbeat-moved", h)',
    "The heartbeat's path",
  );
}

const GOOS = { linux: "linux", darwin: "darwin", win32: "windows" }[
  process.platform
];

/** The sources of the copy for one build: the files to write, relative to the repository. */
export function editsFor(build, read, goos = GOOS) {
  const files = {
    [SOURCE.version]: setVersion(read(SOURCE.version), build.version),
  };
  if (build.kind === "crash")
    files[SOURCE.reconcile] = crashAtRun(read(SOURCE.reconcile));
  if (build.kind === "silent")
    files[SOURCE.reconcile] = moveHeartbeat(read(SOURCE.reconcile));
  if (goos === "windows")
    files[SOURCE.updateGate] = openWindowsGate(read(SOURCE.updateGate));
  return files;
}
const GOARCH = { x64: "amd64", arm64: "arm64" }[process.arch];
export const platform = { goos: GOOS, goarch: GOARCH };

/** The file name of a build in the catalog and in a manifest. */
export const buildName = (version, goos = GOOS, goarch = GOARCH) =>
  `vectory-${version}-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`;

/**
 * Builds one agent from a copy of the source with the flags the release build
 * uses, and returns { version, file, sha256, size, name }. The copy leaves out the
 * tests, which no build reads.
 */
export function buildAgent(build, outDir) {
  const work = path.join(outDir, `source-${build.version}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.cpSync(path.join(root, "agent"), path.join(work, "agent"), {
    recursive: true,
    filter: (source) => !source.endsWith("_test.go"),
  });
  const edits = editsFor(build, (file) =>
    fs.readFileSync(path.join(root, file), "utf8"),
  );
  for (const [file, text] of Object.entries(edits))
    fs.writeFileSync(path.join(work, file), text);
  const name = buildName(build.version);
  const file = path.join(outDir, name);
  run(
    "go",
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags=-s -w -buildid=",
      "-o",
      file,
      "./cmd/vectory",
    ],
    {
      cwd: path.join(work, "agent"),
      timeoutMs: 600000,
      env: {
        CGO_ENABLED: "0",
        GOOS,
        GOARCH,
        GOAMD64: "v1",
        GOTOOLCHAIN: "go1.26.8",
      },
    },
  );
  fs.rmSync(work, { recursive: true, force: true });
  return {
    version: build.version,
    kind: build.kind,
    what: build.what,
    name,
    file,
    sha256: sha256File(file),
    size: fs.statSync(file).size,
  };
}

/** The checksum file a release is signed against: what `sha256sum` writes. */
export function checksumFile(builds) {
  return builds.map((b) => `${b.sha256}  ${b.name}\n`).join("");
}

/**
 * The operator mirror the server reads builds from, holding one build: a
 * platform has one build in the catalog, so the mirror is rewritten for each
 * release. Returns the directory.
 */
export function writeMirror(mirrorDir, build) {
  fs.rmSync(mirrorDir, { recursive: true, force: true });
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.copyFileSync(build.file, path.join(mirrorDir, build.name));
  const entry = {
    name: build.name,
    os: GOOS,
    arch: GOARCH,
    version: build.version,
    sha256: build.sha256,
    size: build.size,
    url: `/api/v1/releases/${build.name}`,
    signed: false,
  };
  fs.writeFileSync(
    path.join(mirrorDir, "catalog.json"),
    JSON.stringify([entry], null, 2) + "\n",
  );
  return mirrorDir;
}

/** The public key line and the fingerprint `vectory release keygen` prints. */
export function parseKeygen(text) {
  const line = text
    .split(/\r?\n/)
    .find((l) => l.startsWith("vectory-release-key ed25519 "));
  if (!line) throw new Error(`keygen printed no public key line:\n${text}`);
  const after = text.slice(text.indexOf(line) + line.length);
  const fingerprint = /Fingerprint[^\n]*:\s*\n\s*([0-9a-f ]+)\n/i
    .exec(after)?.[1]
    ?.replace(/\s+/g, "");
  if (!fingerprint || fingerprint.length !== 64)
    throw new Error(`keygen printed no fingerprint:\n${text}`);
  return { line, fingerprint };
}

/** The fingerprint of a public key line, the way hosts compute it. */
export function fingerprintOf(line) {
  const key = Buffer.from(line.split(" ")[2], "base64");
  if (key.length !== 32) throw new Error(`${line} isn't a release key line`);
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** Short ID of a fingerprint, as the dashboard and `vectory update status` print it. */
export const shortId = (fingerprint) => fingerprint.slice(0, 16);

/** A signed-in client's raw requests: bodies that aren't JSON, answers that aren't either. */
export function rawClient({ base, cookie, session }) {
  return async function raw(method, endpoint, { body, type } = {}) {
    const response = await fetch(base + endpoint, {
      method,
      signal: AbortSignal.timeout(30000),
      headers: {
        ...(type ? { "Content-Type": type } : {}),
        "X-CSRF-Token": session.csrf_token,
        Cookie: cookie,
      },
      ...(body === undefined ? {} : { body }),
    });
    return {
      status: response.status,
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  };
}

/** `a.b.c` against `d.e.f`: negative, zero or positive, as a sort wants. */
export function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1)
    if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
