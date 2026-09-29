// Final source-bound private gate. It runs no live-account or fleet request.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dashboard = resolve(root, "dashboard");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const evidence = [
  "docs/evidence/user-creation-lifecycle-before.json",
  "docs/evidence/user-creation-lifecycle-ui.json",
  "docs/evidence/user-create-native.json",
  "docs/evidence/user-create-contract.json",
  "docs/evidence/user-create-help.json",
  "docs/evidence/editor-code-check-before.json",
  "docs/evidence/editor-code-check-after.json",
];
const reports = Object.fromEntries(
  await Promise.all(
    evidence.map(async (path) => {
      const bytes = await readFile(resolve(root, path));
      const data = JSON.parse(bytes);
      if (!data.passed) throw Error(`${path} does not report a passing run`);
      return [path, { sha256: hash(bytes), data }];
    }),
  ),
);
const ui = reports["docs/evidence/user-creation-lifecycle-ui.json"].data;
const native = reports["docs/evidence/user-create-native.json"].data;
const editor = reports["docs/evidence/editor-code-check-after.json"].data;
let sourceCount = 0;
for (const report of [ui, native, editor]) {
  for (const [path, expected] of Object.entries(report.source_sha256)) {
    const actual = hash(await readFile(resolve(root, path)));
    if (actual !== expected)
      throw Error(`Source changed since evidence: ${path}`);
    sourceCount++;
  }
}
const build = resolve(root, ui.build_directory);
for (const [path, expected] of Object.entries(ui.built_files_sha256)) {
  const file = resolve(build, path);
  if (!file.startsWith(build + "\\") && !file.startsWith(build + "/"))
    throw Error(`Build entry outside private build: ${path}`);
  if (hash(await readFile(file)) !== expected)
    throw Error(`Private build changed since browser run: ${path}`);
}
const candidate = resolve(
  root,
  ".local/user-create-candidate/vectory-server.exe",
);
if (hash(await readFile(candidate)) !== native.server_sha256)
  throw Error("Native candidate changed since TCP proof");
if (
  !native.embedded_openapi_matches_current ||
  native.password_in_registry_or_output ||
  native.activation_claimed ||
  !native.process_stopped ||
  !native.private_fixture_removed
)
  throw Error("Private native proof did not leave its fixture clean");
const commands = [
  {
    name: "TypeScript",
    cwd: dashboard,
    args: [
      resolve(dashboard, "node_modules/typescript/bin/tsc"),
      "-b",
      "--pretty",
      "false",
    ],
  },
  {
    name: "Dashboard unit tests",
    cwd: dashboard,
    args: [
      resolve(dashboard, "node_modules/vitest/vitest.mjs"),
      "run",
      "--reporter=dot",
    ],
  },
  {
    name: "Formatting",
    cwd: dashboard,
    args: [
      resolve(dashboard, "node_modules/prettier/bin/prettier.cjs"),
      "--check",
      "src/AddPersonActions.tsx",
      "src/UsersSecurity.tsx",
      "src/Editor.tsx",
      "src/control.css",
      "tests/role-picker-browser.mjs",
      "../tests/security/user-creation-contract-review.mjs",
      "../tests/security/user-create-help-review.mjs",
      "../tests/security/user-creation-integration-review.mjs",
    ],
  },
  {
    name: "Role picker actual-App regression",
    cwd: dashboard,
    args: [resolve(dashboard, "tests/role-picker-browser.mjs")],
  },
  {
    name: "Native body contract bridge",
    cwd: root,
    args: [resolve(root, "tests/security/user-creation-contract-review.mjs")],
  },
  {
    name: "Private help link check",
    cwd: root,
    args: [resolve(root, "tests/security/user-create-help-review.mjs")],
  },
];
const results = [];
for (const check of commands) {
  const result = spawnSync(process.execPath, check.args, {
    cwd: check.cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120000,
  });
  if (result.error || result.status !== 0)
    throw Error(
      `${check.name} failed: ${result.error || result.stderr || result.stdout}`,
    );
  results.push({
    name: check.name,
    passed: true,
    output: (result.stdout + result.stderr).trim().slice(-1600),
  });
  console.log(`PASS ${check.name}`);
}
// The contract and help checks publish their own fresh evidence. Bind the
// files after those commands finish so this report never records old hashes.
const finalEvidenceHashes = Object.fromEntries(
  await Promise.all(
    evidence.map(async (path) => [
      path,
      hash(await readFile(resolve(root, path))),
    ]),
  ),
);
const report = {
  recorded_at: new Date().toISOString(),
  passed: true,
  classification: "private_source_bound_integration_gate",
  scope:
    "Production dashboard bundle and native candidate were verified privately. Browser APIs were synthetic; native TCP used a disposable server. No live account, pipeline, device, or served build was changed.",
  bound_source_entries: sourceCount,
  bound_built_files: Object.keys(ui.built_files_sha256).length,
  evidence_sha256: finalEvidenceHashes,
  native_candidate_sha256: native.server_sha256,
  checks: results,
};
await writeFile(
  resolve(root, "docs/evidence/user-create-integration.json"),
  JSON.stringify(report, null, 2) + "\n",
);
