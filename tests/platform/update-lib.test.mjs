// The helpers of the agent-update checks against the text and the source they
// depend on. They run before anything is built, so a change to the product's
// source or to what a tool prints fails here, in a second, and not an hour into a
// run on a real service.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BUILDS,
  buildName,
  checksumFile,
  compareVersions,
  editsFor,
  fingerprintOf,
  moveHeartbeat,
  parseKeygen,
  replaceOnce,
  setVersion,
  shortId,
  writeMirror,
  crashAtRun,
  openWindowsGate,
} from "./update-lib.mjs";
import { root } from "./lib.mjs";
import os from "node:os";

const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("an edit that finds its place once is made, and one that doesn't is refused", () => {
  assert.equal(replaceOnce("a b c", "b", "x", "test"), "a x c");
  assert.throws(() => replaceOnce("a b c", "z", "x", "test"), /found none/);
  assert.throws(() => replaceOnce("b b", "b", "x", "test"), /more than one/);
});

test("every build's edits apply to the product's source exactly where they are meant to", () => {
  assert.equal(BUILDS.length, new Set(BUILDS.map((b) => b.version)).size);
  assert.equal(BUILDS[0].version, "0.1.0");
  for (const build of BUILDS) {
    const edits = editsFor(build, read);
    assert.match(
      edits["agent/internal/agent/types.go"],
      new RegExp(
        `^const Version = "${build.version.replaceAll(".", "\\.")}"$`,
        "m",
      ),
    );
    const original = read("agent/internal/agent/types.go");
    assert.equal(
      edits["agent/internal/agent/types.go"]
        .split("\n")
        .filter((l, i) => l !== original.split("\n")[i]).length,
      build.version === "0.1.0" ? 0 : 1,
      "only the version constant differs",
    );
    const reconcile = edits["agent/internal/agent/reconcile.go"];
    if (build.kind === "crash") {
      assert.equal(
        reconcile.split("this build is broken on purpose").length - 1,
        1,
      );
      assert.equal(
        reconcile.split("\n").length,
        read("agent/internal/agent/reconcile.go").split("\n").length + 1,
        "one line added",
      );
    } else if (build.kind === "silent") {
      assert.equal(reconcile.split("/agent/v1/heartbeat-moved").length - 1, 1);
      assert.equal(
        reconcile.split("\n").length,
        read("agent/internal/agent/reconcile.go").split("\n").length,
        "one line changed",
      );
    } else assert.equal(reconcile, undefined);
  }
});

test("the crash is where the service runs and not where the probe does", () => {
  const edited = crashAtRun(read("agent/internal/agent/reconcile.go"));
  // Every way of running the agent goes through runWith: the unit's `vectory run`
  // (agent.Run) and the Windows service (agent.RunWindowsService). `vectory version
  // --json`, which the privileged step's probe runs, never does.
  assert.ok(
    edited.includes(
      'func runWith(ctx context.Context, dir string, options runOptions, report func(string)) error {\n\tpanic("this build is broken on purpose")\n',
    ),
  );
  const reconcile = read("agent/internal/agent/reconcile.go");
  for (const entry of [
    "func Run(ctx context.Context, dir string, once bool, report func(string)) error {\n\treturn runWith(",
    "func RunContinuous(ctx context.Context, dir string, noWake, verbose bool, report func(string)) error {\n\treturn runWith(",
    "func RunWindowsService(ctx context.Context, dir string, report func(string)) error {\n\treturn runWith(",
  ])
    assert.ok(reconcile.includes(entry), `${entry.split("{")[0]} must call runWith`);
  const commands = read("agent/cmd/vectory/commands.go");
  assert.match(commands, /agent\.Run\(ctx, dir, \*once, report\)/);
  const service = read("agent/cmd/vectory/service_windows.go");
  assert.match(service, /agent\.RunWindowsService\(ctx, h\.dir, h\.report\)/);
  const main = read("agent/cmd/vectory/main.go");
  assert.doesNotMatch(
    main.slice(
      main.indexOf("func versionCommand"),
      main.indexOf("func misplacedCommand"),
    ),
    /agent\.Run/,
  );
});

test("the Windows step's release gate is opened in a copy, and only there", () => {
  const host = read("agent/internal/agent/update_host_windows.go");
  assert.equal(host.split("const windowsUpdatesInRelease = ").length - 1, 1);
  const opened = openWindowsGate(host);
  assert.ok(opened.includes("const windowsUpdatesInRelease = true\n"));
  assert.equal(opened.includes("const windowsUpdatesInRelease = false"), false);
  assert.equal(
    opened.split("\n").filter((line, i) => line !== host.split("\n")[i]).length,
    host.includes("const windowsUpdatesInRelease = true\n") ? 0 : 1,
    "one line changed",
  );
  // Opened already, it is left as it is; the proof still builds after the product opens it.
  assert.equal(openWindowsGate(opened), opened);
  assert.throws(() => openWindowsGate("package agent\n"), /found none/);

  for (const build of BUILDS) {
    const onWindows = editsFor(build, read, "windows");
    assert.ok(
      onWindows["agent/internal/agent/update_host_windows.go"].includes(
        "const windowsUpdatesInRelease = true\n",
      ),
      `${build.version} is built with the gate open on Windows`,
    );
    for (const goos of ["linux", "darwin"])
      assert.equal(
        editsFor(build, read, goos)["agent/internal/agent/update_host_windows.go"],
        undefined,
        `${build.version} on ${goos} doesn't touch the Windows host`,
      );
  }
});

test("the heartbeat's path is the one the agent posts to", () => {
  const moved = moveHeartbeat(read("agent/internal/agent/reconcile.go"));
  assert.match(moved, /"POST", "\/agent\/v1\/heartbeat-moved", h\)/);
  assert.equal(
    setVersion('x\nconst Version = "0.1.0"\ny', "0.1.9"),
    'x\nconst Version = "0.1.9"\ny',
  );
});

test("keygen's text gives the key line and the fingerprint hosts pin", () => {
  const printed = `Wrote the private key to team.key, closed to other accounts.
Keep it off the server. Whoever holds it can sign builds that every host pinning this key installs as root.

Public key (give it to the server, and save it in a file such as team.pub):
vectory-release-key ed25519 zlRErijPCXGIwh/42Qs430j941DcjDlakJKmjnxPW+I= team

Fingerprint (hosts pin it; compare it with the one the dashboard shows):
594cfda9 509e999d 5598c9fe 1f5e939d a2bbd928 a9960538 58039bc6 786c8bf3
`;
  const { line, fingerprint } = parseKeygen(printed);
  assert.equal(
    line,
    "vectory-release-key ed25519 zlRErijPCXGIwh/42Qs430j941DcjDlakJKmjnxPW+I= team",
  );
  assert.equal(
    fingerprint,
    "594cfda9509e999d5598c9fe1f5e939da2bbd928a996053858039bc6786c8bf3",
  );
  assert.equal(fingerprintOf(line), fingerprint);
  assert.equal(shortId(fingerprint), "594cfda9509e999d");
  assert.throws(() => parseKeygen("nothing useful"), /no public key line/);
});

test("the operator mirror holds one build the way the server reads it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vectory-mirror-test-"));
  try {
    const file = path.join(dir, "built");
    fs.writeFileSync(file, "an agent build");
    const build = {
      version: "0.1.1",
      name: buildName("0.1.1", "linux", "amd64"),
      file,
      sha256: crypto
        .createHash("sha256")
        .update("an agent build")
        .digest("hex"),
      size: 14,
    };
    const mirror = path.join(dir, "mirror");
    writeMirror(mirror, build);
    const catalog = JSON.parse(
      fs.readFileSync(path.join(mirror, "catalog.json"), "utf8"),
    );
    assert.equal(catalog.length, 1);
    assert.deepEqual(Object.keys(catalog[0]).sort(), [
      "arch",
      "name",
      "os",
      "sha256",
      "signed",
      "size",
      "url",
      "version",
    ]);
    assert.equal(catalog[0].name, build.name);
    assert.match(catalog[0].name, /^vectory-0\.1\.1-[a-z]+-[a-z0-9]+(\.exe)?$/);
    assert.equal(
      fs.readFileSync(path.join(mirror, build.name), "utf8"),
      "an agent build",
    );
    // Written again for another build, it holds that one alone.
    writeMirror(mirror, {
      ...build,
      version: "0.1.2",
      name: buildName("0.1.2", "linux", "amd64"),
    });
    assert.equal(fs.readdirSync(mirror).length, 2);
    assert.equal(checksumFile([build]), `${build.sha256}  ${build.name}\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("versions compare by number and not by text", () => {
  assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
  assert.ok(compareVersions("0.1.1", "0.1.2") < 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});
