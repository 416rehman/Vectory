#!/usr/bin/env node
// Proves from a `go test -json` stream that the native agent tests ran.
//
//   go test -json ./... > go-test.json
//   node scripts/check-native-tests.mjs go-test.json [--require-native]
//
// Prints a per-package summary, the native tests and the output of every
// failure (the JSON stream keeps it out of the step log). Exits 1 when a test
// or package failed, a test never finished, the stream holds no test results,
// or, while VECTOR_TEST_BINARY is set: no TestNative* test passed, a
// TestNative* test or subtest skipped (apart from EXPECTED_SKIPS), or any test
// skipped asking for VECTOR_TEST_BINARY. --require-native also fails when
// VECTOR_TEST_BINARY is unset, so CI cannot pass with the native tests off.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Native tests that skip by design on one platform, with the reason they print.
export const EXPECTED_SKIPS = [
  {
    platform: "win32",
    test: "TestNativeReloadOfAConfigurationThatFailsToLoadFailsAtOnce",
    reason: "Vector on Windows has no reload",
  },
];

export function parseStream(text) {
  const events = [];
  const unparsed = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event.Action === "string") events.push(event);
      else unparsed.push(line);
    } catch {
      unparsed.push(line);
    }
  }
  return { events, unparsed };
}

const RESULTS = { pass: "passed", fail: "failed", skip: "skipped" };

export function summarize(events) {
  const tests = new Map();
  const packages = new Map();
  const builds = new Map();
  for (const event of events) {
    if (event.Action === "build-output" || event.Action === "build-fail") {
      const name = event.ImportPath || event.Package || "(build)";
      if (!builds.has(name)) builds.set(name, { name, failed: false, output: [] });
      const build = builds.get(name);
      if (event.Action === "build-fail") build.failed = true;
      else build.output.push(event.Output ?? "");
      continue;
    }
    if (!event.Package) continue;
    if (!packages.has(event.Package))
      packages.set(event.Package, { name: event.Package, started: false, result: null, failedBuild: null, elapsed: 0, output: [], passed: 0, failed: 0, skipped: 0 });
    const pkg = packages.get(event.Package);
    if (!event.Test) {
      if (event.Action === "start") pkg.started = true;
      if (event.Action === "output") pkg.output.push(event.Output ?? "");
      if (RESULTS[event.Action]) {
        pkg.result = event.Action;
        pkg.elapsed = event.Elapsed ?? 0;
        pkg.failedBuild = event.FailedBuild ?? null;
      }
      continue;
    }
    const key = `${event.Package}\u0000${event.Test}`;
    if (!tests.has(key)) tests.set(key, { package: event.Package, name: event.Test, result: null, elapsed: 0, output: [] });
    const test = tests.get(key);
    if (event.Action === "output") test.output.push(event.Output ?? "");
    if (RESULTS[event.Action]) {
      test.result = event.Action;
      test.elapsed = event.Elapsed ?? 0;
      pkg[RESULTS[event.Action]]++;
    }
  }
  return { tests: [...tests.values()], packages: [...packages.values()], builds: [...builds.values()] };
}

// What a test printed, without go test's own === and --- lines.
export const reasonOf = (test) =>
  test.output
    .filter((line) => !/^\s*(=== |--- )/.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

export function check({ tests, packages, builds }, { nativeBinary = "", platform = process.platform, requireNative = false } = {}) {
  const problems = [];
  if (!tests.some((t) => t.result)) problems.push("The stream holds no test results: go test did not run or its output was lost.");
  for (const t of tests) {
    if (t.result === "fail") problems.push(`${t.name} failed (${t.package}).`);
    if (!t.result) problems.push(`${t.name} started but never finished (${t.package}): a panic, a timeout or a cut stream.`);
  }
  for (const b of builds) if (b.failed) problems.push(`${b.name} did not build.`);
  for (const p of packages) {
    if (p.result === "fail" && !p.failedBuild && !tests.some((t) => t.package === p.name && t.result === "fail"))
      problems.push(`Package ${p.name} failed outside any single test (a panic, TestMain or a timeout).`);
    if (p.started && !p.result) problems.push(`Package ${p.name} started but never reported a result.`);
  }
  const native = tests.filter((t) => t.name.split("/")[0].startsWith("TestNative"));
  const expected = (t) =>
    t.result === "skip" && EXPECTED_SKIPS.some((s) => s.platform === platform && s.test === t.name && reasonOf(t).includes(s.reason));
  if (!nativeBinary) {
    if (requireNative) problems.push("VECTOR_TEST_BINARY is not set, so the native tests could only skip.");
  } else {
    if (!native.some((t) => !t.name.includes("/") && t.result === "pass"))
      problems.push("VECTOR_TEST_BINARY is set but no TestNative* test ran and passed.");
    for (const t of tests) {
      if (t.result !== "skip" || expected(t)) continue;
      if (native.includes(t)) problems.push(`${t.name} skipped although VECTOR_TEST_BINARY is set: ${reasonOf(t) || "no reason printed"}`);
      else if (reasonOf(t).includes("VECTOR_TEST_BINARY")) problems.push(`${t.name} skipped asking for VECTOR_TEST_BINARY, which is set: ${reasonOf(t)}`);
    }
  }
  return { problems, native, expected };
}

const trimmed = (lines, count) => lines.slice(-count).map((line) => line.replace(/\r?\n$/, ""));

export function report(file, summary, result, { nativeBinary, platform }) {
  const lines = [`Go test results in ${file}`];
  for (const p of summary.packages) {
    const state = p.result ?? (p.started ? "unfinished" : "output");
    lines.push(`  ${state.padEnd(10)} ${p.name}: ${p.passed} passed, ${p.failed} failed, ${p.skipped} skipped (${p.elapsed}s)`);
  }
  lines.push(`Native tests on ${platform}, ${nativeBinary ? `VECTOR_TEST_BINARY=${nativeBinary}` : "VECTOR_TEST_BINARY not set"}:`);
  for (const t of result.native) {
    const note = result.expected(t) ? `  expected on ${platform}: ${reasonOf(t)}` : "";
    lines.push(`  ${(t.result ?? "unfinished").padEnd(10)} ${t.name} (${t.elapsed}s)${note}`);
  }
  if (!result.native.length) lines.push("  none in this stream");
  for (const b of summary.builds.filter((b) => b.failed)) lines.push(`--- Build output of ${b.name}:`, ...trimmed(b.output, 100));
  for (const t of summary.tests.filter((t) => t.result === "fail" || !t.result))
    lines.push(`--- Output of ${t.name} (${t.package}):`, ...trimmed(t.output, 200));
  for (const p of summary.packages.filter((p) => (p.result === "fail" && !p.failedBuild) || (p.started && !p.result)))
    lines.push(`--- Package output of ${p.name}:`, ...trimmed(p.output, 100));
  return lines.join("\n");
}

function stepSummary(result, { nativeBinary, platform }) {
  const rows = result.native.map(
    (t) => `| \`${t.name}\` | ${t.result ?? "unfinished"}${result.expected(t) ? " (expected on this platform)" : ""} | ${t.elapsed}s |`,
  );
  return [
    `### Native agent tests on ${platform}`,
    "",
    nativeBinary ? `\`VECTOR_TEST_BINARY\`: \`${nativeBinary}\`` : "`VECTOR_TEST_BINARY` is not set.",
    "",
    "| Test | Result | Time |",
    "| --- | --- | --- |",
    ...(rows.length ? rows : ["| none | | |"]),
    "",
    result.problems.length ? `**${result.problems.length} problem(s)**, listed in the step log.` : "**Passed.**",
    "",
    "",
  ].join("\n");
}

export function main(argv, env = process.env, platform = process.platform) {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: node scripts/check-native-tests.mjs GO_TEST_JSON [--require-native]");
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    console.error(`Cannot read ${file}: ${error.message}`);
    return 1;
  }
  const options = { nativeBinary: env.VECTOR_TEST_BINARY || "", platform, requireNative: argv.includes("--require-native") };
  const { events, unparsed } = parseStream(text);
  const summary = summarize(events);
  const result = check(summary, options);
  console.log(report(file, summary, result, options));
  if (unparsed.length) console.log(`${unparsed.length} line(s) were not go test events, first: ${unparsed.slice(0, 3).join(" | ")}`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, stepSummary(result, options));
  for (const problem of result.problems) console.log(`${env.GITHUB_ACTIONS === "true" ? "::error::" : "FAIL: "}${problem}`);
  if (result.problems.length) return 1;
  const passed = result.native.filter((t) => t.result === "pass");
  const top = passed.filter((t) => !t.name.includes("/")).length;
  console.log(`OK: ${top} native tests and ${passed.length - top} subtests passed on ${platform}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
