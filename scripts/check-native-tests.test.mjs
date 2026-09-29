// node --test scripts/check-native-tests.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, parseStream, summarize } from "./check-native-tests.mjs";

const PKG = "github.com/vectory/vectory/agent/internal/agent";
const script = path.join(import.meta.dirname, "check-native-tests.mjs");
const lines = (...events) => events.flat(Infinity).map((e) => JSON.stringify({ Time: "2026-09-29T20:13:21Z", Package: PKG, ...e })).join("\n") + "\n";
// One test as go test -json reports it: run, its output, the verdict.
const ran = (name, action, ...output) => [
  { Action: "run", Test: name },
  { Action: "output", Test: name, Output: `=== RUN   ${name}\n` },
  ...output.map((line) => ({ Action: "output", Test: name, Output: `    native_test.go:10: ${line}\n` })),
  { Action: "output", Test: name, Output: `--- ${action.toUpperCase()}: ${name} (0.50s)\n` },
  { Action: action, Test: name, Elapsed: 0.5 },
];
const pkg = (action, ...body) => [{ Action: "start" }, ...body, { Action: action, Elapsed: 1.2 }];
const run = (text, options) => check(summarize(parseStream(text).events), options);
const vector = { nativeBinary: "/opt/vector/bin/vector", platform: "linux" };

test("native tests that passed with the pinned Vector pass the check", () => {
  const stream = lines(pkg("pass", ran("TestNativeVectorTelemetry", "pass"), ran("TestNativeStopDrainsVectorOnce/service_stop", "pass"), ran("TestNativeStopDrainsVectorOnce", "pass"), ran("TestPlain", "pass")));
  const result = run(stream, vector);
  assert.deepEqual(result.problems, []);
  assert.equal(result.native.length, 3);
});

// Captured from `go test -json` with VECTOR_TEST_BINARY unset (Go 1.26.8).
const realSkip = `{"Time":"2026-09-29T20:18:07.931944872Z","Action":"start","Package":"${PKG}"}
{"Time":"2026-09-29T20:18:07.937674952Z","Action":"run","Package":"${PKG}","Test":"TestNativeVectorTelemetry"}
{"Time":"2026-09-29T20:18:07.937718287Z","Action":"output","Package":"${PKG}","Test":"TestNativeVectorTelemetry","Output":"=== RUN   TestNativeVectorTelemetry\\n"}
{"Time":"2026-09-29T20:18:07.937773504Z","Action":"output","Package":"${PKG}","Test":"TestNativeVectorTelemetry","Output":"    telemetry_test.go:57: set VECTOR_TEST_BINARY for actual native exporter integration\\n"}
{"Time":"2026-09-29T20:18:07.937782648Z","Action":"output","Package":"${PKG}","Test":"TestNativeVectorTelemetry","Output":"--- SKIP: TestNativeVectorTelemetry (0.00s)\\n"}
{"Time":"2026-09-29T20:18:07.937787862Z","Action":"skip","Package":"${PKG}","Test":"TestNativeVectorTelemetry","Elapsed":0}
{"Time":"2026-09-29T20:18:07.939113214Z","Action":"output","Package":"${PKG}","Output":"PASS\\n"}
{"Time":"2026-09-29T20:18:07.940779612Z","Action":"pass","Package":"${PKG}","Elapsed":0.009}
`;

test("a native test that skips while VECTOR_TEST_BINARY is set fails, naming the test and its reason", () => {
  const { problems } = run(realSkip, vector);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /no TestNative\* test ran and passed/);
  assert.match(problems[1], /^TestNativeVectorTelemetry skipped .*set VECTOR_TEST_BINARY for actual native exporter integration/);
});

test("skips are only reported, not failed, without VECTOR_TEST_BINARY unless native tests are required", () => {
  assert.deepEqual(run(realSkip, { platform: "linux" }).problems, []);
  assert.match(run(realSkip, { platform: "linux", requireNative: true }).problems.join("\n"), /VECTOR_TEST_BINARY is not set/);
});

test("a stream without any TestNative test fails while VECTOR_TEST_BINARY is set", () => {
  const { problems } = run(lines(pkg("pass", ran("TestPlain", "pass"))), vector);
  assert.deepEqual(problems, ["VECTOR_TEST_BINARY is set but no TestNative* test ran and passed."]);
});

test("a skipped native subtest fails although its parent passed", () => {
  const stream = lines(pkg("pass", ran("TestNativeStopDrainsVectorOnce/ctrl-c", "skip", "no process group here"), ran("TestNativeStopDrainsVectorOnce", "pass")));
  assert.deepEqual(run(stream, vector).problems, ["TestNativeStopDrainsVectorOnce/ctrl-c skipped although VECTOR_TEST_BINARY is set: native_test.go:10: no process group here"]);
});

test("the documented Windows reload skip passes on Windows only, and only with its reason", () => {
  const reload = "TestNativeReloadOfAConfigurationThatFailsToLoadFailsAtOnce";
  const windows = lines(pkg("pass", ran("TestNativeVectorTelemetry", "pass"), ran(reload, "skip", "Vector on Windows has no reload; the agent restarts it")));
  const windowsResult = run(windows, { ...vector, platform: "win32" });
  assert.deepEqual(windowsResult.problems, []);
  assert.ok(windowsResult.expected(windowsResult.native[1]));
  assert.match(run(windows, vector).problems.join("\n"), new RegExp(`${reload} skipped`));
  const otherReason = lines(pkg("pass", ran("TestNativeVectorTelemetry", "pass"), ran(reload, "skip", "set VECTOR_TEST_BINARY for native Vector runtime tests")));
  assert.match(run(otherReason, { ...vector, platform: "win32" }).problems.join("\n"), new RegExp(`${reload} skipped`));
});

test("any test skipping for want of VECTOR_TEST_BINARY fails while it is set, whatever its name", () => {
  const stream = lines(pkg("pass", ran("TestNativeVectorTelemetry", "pass"), ran("TestConfigurationAttemptNativeSignedHeartbeat", "skip", "set VECTOR_TEST_BINARY for native signed failure reporting")));
  assert.match(run(stream, vector).problems.join("\n"), /^TestConfigurationAttemptNativeSignedHeartbeat skipped asking for VECTOR_TEST_BINARY/);
  const unrelated = lines(pkg("pass", ran("TestNativeVectorTelemetry", "pass"), ran("TestPurgeMarker", "skip", "filesystem immediately reused the deleted directory identity")));
  assert.deepEqual(run(unrelated, vector).problems, []);
});

test("failures, panics, cut streams and empty streams fail", () => {
  const failed = lines(pkg("fail", ran("TestNativeVectorTelemetry", "fail", "Vector did not reload")));
  assert.match(run(failed, vector).problems.join("\n"), /TestNativeVectorTelemetry failed/);
  const cut = lines({ Action: "start" }, { Action: "run", Test: "TestNativeVectorTelemetry" }, { Action: "output", Test: "TestNativeVectorTelemetry", Output: "=== RUN   TestNativeVectorTelemetry\n" });
  const cutProblems = run(cut, vector).problems.join("\n");
  assert.match(cutProblems, /never finished/);
  assert.match(cutProblems, /never reported a result/);
  assert.match(run("", vector).problems.join("\n"), /no test results/);
  const mainPanic = lines(pkg("fail", ran("TestNativeVectorTelemetry", "pass"), { Action: "output", Output: "panic: TestMain exploded\n" }));
  assert.match(run(mainPanic, vector).problems.join("\n"), /failed outside any single test/);
});

test("a build failure fails with its build output", () => {
  const broken = [
    { ImportPath: `${PKG} [${PKG}.test]`, Action: "build-output", Output: "native_test.go:5:28: undefined: undefined\n" },
    { ImportPath: `${PKG} [${PKG}.test]`, Action: "build-fail" },
  ].map((e) => JSON.stringify(e)).join("\n");
  const failedPackage = lines({ Action: "start" }, { Action: "output", Output: `FAIL\t${PKG} [build failed]\n` }, { Action: "fail", Elapsed: 0, FailedBuild: `${PKG} [${PKG}.test]` });
  const problems = run(`${broken}\n${failedPackage}`, vector).problems;
  assert.ok(problems.includes(`${PKG} [${PKG}.test] did not build.`));
  assert.ok(!problems.some((p) => p.includes("outside any single test")));
});

test("PowerShell-written streams (BOM, CRLF, stray text) parse", () => {
  const text = "﻿" + realSkip.replace(/\n/g, "\r\n") + "go: downloading golang.org/x/sys v0.48.0\r\n\r\n";
  const { events, unparsed } = parseStream(text);
  assert.equal(events.length, 8);
  assert.deepEqual(unparsed, ["go: downloading golang.org/x/sys v0.48.0"]);
});

test("the command exits 1 on problems, 0 on success, prints failure output and writes the step summary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-native-tests-"));
  try {
    const good = path.join(dir, "good.json");
    const bad = path.join(dir, "bad.json");
    const summary = path.join(dir, "summary.md");
    fs.writeFileSync(good, lines(pkg("pass", ran("TestNativeVectorTelemetry", "pass"))));
    fs.writeFileSync(bad, lines(pkg("fail", ran("TestNativeVectorTelemetry", "fail", "Vector did not reload"))));
    const env = { ...process.env, VECTOR_TEST_BINARY: "/opt/vector/bin/vector", GITHUB_STEP_SUMMARY: summary, GITHUB_ACTIONS: "true" };
    const ok = spawnSync(process.execPath, [script, good, "--require-native"], { env, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /OK: 1 native tests and 0 subtests passed/);
    const failed = spawnSync(process.execPath, [script, bad], { env, encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /native_test\.go:10: Vector did not reload/);
    assert.match(failed.stdout, /^::error::TestNativeVectorTelemetry failed/m);
    assert.match(fs.readFileSync(summary, "utf8"), /\| `TestNativeVectorTelemetry` \| pass \| 0\.5s \|[\s\S]*\| `TestNativeVectorTelemetry` \| fail \|/);
    const unset = { ...process.env, VECTOR_TEST_BINARY: "", GITHUB_STEP_SUMMARY: "" };
    assert.equal(spawnSync(process.execPath, [script, good, "--require-native"], { env: unset }).status, 1);
    assert.equal(spawnSync(process.execPath, [script, path.join(dir, "missing.json")], { env: unset }).status, 1);
    assert.equal(spawnSync(process.execPath, [script], { env: unset }).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
